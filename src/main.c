// ============================================================================
//  ESP32-S3 Autoranging Capacitance Meter  —  Multi-Range / Multi-Method Fusion
//
//  The original autoranger picked ONE range and ONE method and reported a
//  single sample.  This firmware instead treats every (range, method) pair as
//  an independent sensor, scores each sample with a physics-based quality
//  metric, and fuses all plausible samples into one high-confidence estimate.
//
//  Pipeline per measurement cycle:
//    1. PROBE   — fast LM393 oscillator reading on the remembered range only
//                 gives a rough capacitance for planning (no full sweep).
//    2. SWEEP   — ADC τ-measurement on EVERY range whose predicted τ lands
//                 inside the clean measurement window, plus an oscillator run
//                 on the range that minimises |predicted f − f_sweet|.
//    3. FUSION  — all samples are weighted by quality; a median-gated,
//                 log-domain weighted average produces the final value.
//                 When the ADC and oscillator methods disagree beyond their
//                 combined uncertainty the reading is flagged for the user.
// ============================================================================

#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "driver/gpio.h"
#include "driver/pulse_cnt.h"
#include "driver/uart.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_err.h"
#include "esp_log.h"
#include "esp_rom_sys.h"
#include "esp_timer.h"
#include "esp_task_wdt.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

// Read a 64-bit value shared with an ISR without tearing (32-bit Xtensa does
// two 32-bit loads).  Spin until two consecutive reads agree.
static inline int64_t atomic_read_i64(volatile int64_t *p)
{
    int64_t a, b;
    do { a = *p; b = *p; } while (a != b);
    return a;
}

// ---------------------------------------------------------------------------
// Pin map
// ---------------------------------------------------------------------------
#define VBIAS_PIN GPIO_NUM_3
#define MUX_A0_PIN GPIO_NUM_4
#define MUX_A1_PIN GPIO_NUM_5
#define VCAP_PIN GPIO_NUM_10
#define SSR_S2_PIN GPIO_NUM_12
#define LM393_OUT_PIN GPIO_NUM_14
#define DRIVE_PIN GPIO_NUM_16
#define SSR_S1_S3_PIN GPIO_NUM_18

// ---------------------------------------------------------------------------
// Measurement constants
// ---------------------------------------------------------------------------
#define ADC_CHANNEL ADC_CHANNEL_9

// RC-step method.  The node does NOT always charge to 3.3 V: a parasitic
// pull-down on V_cap (R_bias to the bias rail, plus any leakage) forms a
// divider with the range resistor, so the node asymptotes to a per-range
// plateau V_inf < 3.3 V.  On the 1 MΩ range that plateau can be BELOW the
// nominal 2085 mV threshold, which used to make the range time out on every
// capacitor.  We therefore measure V_inf per range and place the τ crossing
// threshold at 63.2 % of V_inf, not of an assumed 3.3 V.
#define V_START_MV 330    // nominal 10 % start threshold (scaled per-range)
#define V_TAU_FRAC 0.632  // one time constant = 63.2 % of the asymptote
#define V_NOMINAL_MV 3300 // ideal no-load asymptote
// ADC poll jitter budget.  Below this τ the crossing time is dominated by the
// sample-loop timing noise, not the RC network.  Raised from 25 µs to 250 µs:
// a 10 pF DUT on the 1 MΩ range shifts τ by only ~10 µs, so the old gate let
// the ADC report its own ~136 pF node offset as a "reading" for pF DUTs.
// 250 µs ≈ 10× the poll jitter and pushes the ADC out of the pF regime
// entirely — the oscillator owns sub-nF.
#define ADC_STEP_THRESHOLD_US 250

// Minimum usable asymptote.  Below this the divider droop is so severe that a
// reliable τ crossing cannot be timed on this range.
#define V_INF_MIN_MV 900

// Legacy fallback stray.  Used ONLY when the oscillator has no measured
// open-node tare (T0) for a range.  The real node offset on this board is
// ~136 pF (an open socket read ~124 pF after the old −12 pF correction), so
// calibration and measurement must use a measured T0, not this constant.
// Kept so an un-recalibrated board still behaves as before.
#define STRAY_CAPACITANCE_F 12.0e-12

// Below this the ADC is not trustworthy: its τ resolution cannot resolve the
// signal above its own offset.  Small DUTs are measured by the oscillator only.
#define ADC_SUBNF_GATE_F 1.0e-9
// C_block (1000 uF) sits in series with the DUT on the AC measurement path.
// C_eq = C_b*C_d/(C_b+C_d)  =>  C_d = C_eq*C_b/(C_b-C_eq).  Correcting removes
// the growing underestimate for DUTs approaching C_block (per schematic note).
#define C_BLOCK_F 1000.0e-6
#define C_BLOCK_CORRECT_MIN_F 1.0e-6  // only worth applying above ~1 uF

#define RANGE_COUNT 4
#define PROBE_MIN_VALID_US 200 // probe on a "slow" range trusts τ ≥ this
#define MAX_SAMPLES 12         // 4 ADC + probe + best OSC + alt OSC + headroom

#define PRECHARGE_HOLD_MS 600
#define DISCHARGE_HOLD_MS 600
#define ISOLATION_DELAY_US 2000
#define ADC_TIMEOUT_FAST_US 5000000LL    // 5 s for high-resistance ranges
#define ADC_TIMEOUT_SLOW_US 15000000LL   // 15 s for the 100 Ω / 1 kΩ ranges
#define OSC_TIMEOUT_US 2000000LL         // oscillator must finish within 2 s

// Oscillator constraints
#define OSC_TARGET_PERIODS 50 // full periods averaged per reading
// Ideal (theoretical) geometry constant for a 1.65 V ref + symmetric
// hysteresis relaxation loop.  In practice the *effective* K drifts per range
// because of fixed per-cycle delays (comparator prop + ISR + buffer slew),
// hysteresis asymmetry, and range-resistor tolerance / mux Ron.  So K and the
// residual delay are calibrated PER RANGE (see g_osc_cal below).
#define OSC_K_IDEAL 1
#define OSC_DELAY_IDEAL_US 2.0
#define OSC_F_SWEET_HZ 2000.0 // centre of the low-latency oscillator band

// Minimum acceptable oscillator frequency — below this, ISR latency dominates
#define OSC_MIN_F_HZ 20.0

// Fusion tuning
// Relative (fractional) outlier gate around the median.  This is NOT a
// statistical sigma — it is a fixed relative tolerance that discards samples
// more than FUSION_GATE_REL away from the median before the weighted average.
#define FUSION_GATE_REL 0.875   // keep samples within ±87.5% of the median
#define METHOD_MISMATCH_RATIO 1.5 // ADC-vs-OSC disagreement alert threshold

static const char *TAG = "CAP_METER";

// ── OSC-ONLY DEBUG MODE ─────────────────────────────────────────────────────
// Set to 1 and flash to get an interactive, oscilloscope-friendly oscillator
// bring-up console (bypasses the autoranger entirely).  Serial commands:
//   0/1/2/3 = range (100Ω/1kΩ/100kΩ/1MΩ)   g = start   s = stop
//   r = discharge+restart   p/? = dump live pin/edge/freq state   h = help
// Probe GPIO14 (LM393 out) and GPIO16 (drive) on the scope.  Set back to 0 for
// normal fused measurement.  (Can also be forced with -DOSC_DEBUG_MODE=1.)
#ifndef OSC_DEBUG_MODE
#define OSC_DEBUG_MODE 1
#endif

// Current phase of the autoranging pipeline, stamped onto each reading log.
static const char *g_phase = "init";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
typedef struct {
    uint8_t mux_channel;
    double resistance_ohms;
    const char *label;
} range_config_t;

typedef enum {
    METHOD_ADC_STEP = 0,
    METHOD_OSC = 1,
} method_t;

typedef struct {
    bool valid;
    bool plausible;     // passes hard physics sanity checks
    method_t method;
    uint8_t range_idx;
    double capacitance_f; // reconstructed DUT capacitance (after all corrections)
    double c_eq_f;        // raw series-equivalent seen by the circuit (pre-correction)
    double quality;     // 0..1, physics-based confidence
    double tau_us;      // ADC: measured τ.   OSC: measured full period.
    double fit_r2;      // ADC: R² of the exponential fit (1 = perfect)
    double freq_hz;     // OSC only
    bool suspicious;    // timing/health looks wrong (down-weighted, still usable)
} sample_t;

typedef struct {
    bool valid;
    double capacitance_f;
    double rel_spread;      // weighted RMS spread around the fused value
    double total_weight;
    int n_adc;              // contributing ADC samples
    int n_osc;              // contributing OSC samples
    double adc_estimate;    // fused ADC-only value (NAN if none)
    double osc_estimate;    // fused OSC-only value (NAN if none)
    bool method_mismatch;   // ADC and OSC disagree beyond uncertainty
    int raw_samples;        // total valid samples collected
} fusion_t;

// ---------------------------------------------------------------------------
// Range table — note: on the schematic the 1 MΩ channel shares the mux with
// the 100 nF HF-bypass branch; keep the channel numbering used in production.
// ---------------------------------------------------------------------------
static const range_config_t RANGES[RANGE_COUNT] = {
    {2, 100.0, "100 Ω"},
    {1, 1000.0, "1 kΩ"},
    {0, 100000.0, "100 kΩ"},
    {3, 1000000.0, "1 MΩ"},
};

static adc_oneshot_unit_handle_t adc_handle;
static adc_cali_handle_t adc_cali_handle;
static bool adc_cali_ready;

// ---------------------------------------------------------------------------
// Per-range oscillator calibration
// ---------------------------------------------------------------------------
// The oscillator obeys  C = 1/(K · R · f) − C_stray  (equivalently
// T = K·R·C).  K is *nominally* a static geometry constant, but fixed
// per-cycle delays and per-range resistor tolerances make the effective K
// range-dependent.  We therefore keep an independent {K, delay} per range.
// delay_us is subtracted from the measured period before applying K; it
// absorbs the comparator/ISR/buffer latency on fast (low-R) ranges.
typedef struct {
    double k;        // dimensionless geometry constant for this range
    double delay_us; // per-cycle time offset (us) for this range (legacy fallback)
    double t0_us;    // measured open-node period offset (tare):
                     //   T = K·R·C_dut + T0,  T0 absorbs stray C + latency
    bool   valid;    // true once calibrated against a reference
    bool   has_t0;   // true once the open-node tare T0 has been captured
} osc_cal_t;

static osc_cal_t g_osc_cal[RANGE_COUNT] = {
    {OSC_K_IDEAL, OSC_DELAY_IDEAL_US, 0.0, false, false}, // 100 Ω
    {OSC_K_IDEAL, OSC_DELAY_IDEAL_US, 0.0, false, false}, // 1 kΩ
    {OSC_K_IDEAL, OSC_DELAY_IDEAL_US, 0.0, false, false}, // 100 kΩ
    {OSC_K_IDEAL, OSC_DELAY_IDEAL_US, 0.0, false, false}, // 1 MΩ
};

// Accessors used everywhere a K or delay is needed.  They ENFORCE the valid
// flag: a range whose calibration was never completed (or whose NVS copy is
// partial/corrupt) falls back to the theoretical defaults, so a stale or
// half-written NVS entry can never poison a measurement.
static inline double osc_k(uint8_t range_idx)
{
    return g_osc_cal[range_idx].valid ? g_osc_cal[range_idx].k : OSC_K_IDEAL;
}
static inline double osc_delay(uint8_t range_idx)
{
    return g_osc_cal[range_idx].valid ? g_osc_cal[range_idx].delay_us : OSC_DELAY_IDEAL_US;
}
// Open-node tare offset (period, µs).  Only meaningful when has_t0 is set; the
// accessor returns 0 when unset so callers must gate on osc_has_t0().
static inline double osc_t0(uint8_t range_idx)
{
    return g_osc_cal[range_idx].t0_us;
}
static inline bool osc_has_t0(uint8_t range_idx)
{
    return g_osc_cal[range_idx].has_t0;
}

#define OSC_CAL_NVS_NS "osc_cal"

// Load calibrated {K, delay} per range from NVS; fall back to defaults.
static void osc_cal_load(void)
{
    nvs_handle_t h;
    if (nvs_open(OSC_CAL_NVS_NS, NVS_READONLY, &h) != ESP_OK) return;
    for (int i = 0; i < RANGE_COUNT; ++i) {
        char key[8];
        snprintf(key, sizeof(key), "k%d", i);
        int64_t v = 0;
        if (nvs_get_i64(h, key, &v) == ESP_OK) {
            g_osc_cal[i].k = (double)v / 1e9;        // stored as fixed-point 1e9
        }
        snprintf(key, sizeof(key), "d%d", i);
        if (nvs_get_i64(h, key, &v) == ESP_OK) {
            g_osc_cal[i].delay_us = (double)v / 1e6; // stored as fixed-point 1e6
        }
        snprintf(key, sizeof(key), "v%d", i);
        uint8_t valid = 0;
        if (nvs_get_u8(h, key, &valid) == ESP_OK) {
            g_osc_cal[i].valid = (valid != 0);
        }
        snprintf(key, sizeof(key), "o%d", i);
        if (nvs_get_i64(h, key, &v) == ESP_OK) {
            g_osc_cal[i].t0_us = (double)v / 1e6;   // fixed-point 1e6
        }
        snprintf(key, sizeof(key), "t%d", i);
        uint8_t has_t0 = 0;
        if (nvs_get_u8(h, key, &has_t0) == ESP_OK) {
            g_osc_cal[i].has_t0 = (has_t0 != 0);
        }
    }
    nvs_close(h);
}

// Persist the whole calibration table to NVS.
static esp_err_t osc_cal_save(void)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(OSC_CAL_NVS_NS, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    for (int i = 0; i < RANGE_COUNT; ++i) {
        char key[8];
        snprintf(key, sizeof(key), "k%d", i);
        nvs_set_i64(h, key, (int64_t)(g_osc_cal[i].k * 1e9));
        snprintf(key, sizeof(key), "d%d", i);
        nvs_set_i64(h, key, (int64_t)(g_osc_cal[i].delay_us * 1e6));
        snprintf(key, sizeof(key), "v%d", i);
        nvs_set_u8(h, key, g_osc_cal[i].valid ? 1 : 0);
        snprintf(key, sizeof(key), "o%d", i);
        nvs_set_i64(h, key, (int64_t)(g_osc_cal[i].t0_us * 1e6));
        snprintf(key, sizeof(key), "t%d", i);
        nvs_set_u8(h, key, g_osc_cal[i].has_t0 ? 1 : 0);
    }
    err = nvs_commit(h);
    nvs_close(h);
    return err;
}

// Series-equivalent of a DUT *alone* (no stray).  The oscillator's measured
// open-node tare T0 absorbs the parasitic capacitance, so calibration works in
// DUT deltas above the open baseline and must NOT add STRAY here.  Adding the
// old 12 pF constant was the bug that made a 100 pF reference imply ~236 pF and
// pushed the solved K ~2.1× too large.  This MUST stay consistent with the
// measurement model (cblock_invert).
static double cblock_forward(double c_dut)
{
    if (c_dut >= C_BLOCK_F) return -1.0;            // beyond singularity
    return (C_BLOCK_F * c_dut) / (C_BLOCK_F + c_dut);
}

// One-point calibration: solve K.
//   With tare:    T = K·R·C_dut + T0      => K = (T − T0)/(R·C_dut)
//   Legacy (no tare): T = K·R·(C_dut+Cstray) + delay
//                                          => K = (T − delay)/(R·(C_dut+Cstray))
// Prefer the measured open-node tare so K is independent of the unknown
// parasitic capacitance.  Uses the same C_eq model as measurement.
static double osc_cal_solve_k(uint8_t range_idx, double freq_hz, double ref_c_f)
{
    bool use_t0 = osc_has_t0(range_idx);
    double c_eq = cblock_forward(ref_c_f + (use_t0 ? 0.0 : STRAY_CAPACITANCE_F));
    double period_us = 1e6 / freq_hz;
    double eff = period_us - (use_t0 ? osc_t0(range_idx) : osc_delay(range_idx));
    if (c_eq <= 0.0 || eff <= 0.0) return -1.0;
    return (eff * 1e-6) / (RANGES[range_idx].resistance_ohms * c_eq);
}

// Two-point calibration: with TWO references on the SAME range we solve BOTH
// unknowns of  T = K·R·C_dut + T0  exactly.  This is the clean way to cancel
// the parasitic capacitance: Ceq is the reference's DUT value only (no stray),
// and T0 absorbs the stray + all fixed latency.
//      K  = (T1 − T2) / (R · (Ceq1 − Ceq2))
//      T0 = T1 − K·R·Ceq1
// Returns true on success and writes the solved values into *k / *t0_us.
static bool osc_cal_solve_two_point(uint8_t range_idx,
                                    double f1_hz, double ref1_c_f,
                                    double f2_hz, double ref2_c_f,
                                    double *k, double *t0_us)
{
    double ceq1 = cblock_forward(ref1_c_f);
    double ceq2 = cblock_forward(ref2_c_f);
    double t1 = 1e6 / f1_hz;   // measured full period, us
    double t2 = 1e6 / f2_hz;
    double r = RANGES[range_idx].resistance_ohms;

    if (ceq1 <= 0.0 || ceq2 <= 0.0) return false;
    double dc = ceq1 - ceq2;
    if (fabs(dc) < 1e-18) return false;             // references too similar

    double k_solved = ((t1 - t2) * 1e-6) / (r * dc);
    double t0_solved = t1 - k_solved * r * ceq1 * 1e6;

    // Sanity: K must be a sane positive geometry constant; T0 is a period
    // offset (positive, up to a few hundred µs on the 1 MΩ range).  A large
    // negative T0 means the references were bad/too similar.
    if (k_solved <= 0.01 || k_solved > 2.0) return false;
    if (t0_solved < -100.0 || t0_solved > 200000.0) return false;

    *k = k_solved;
    *t0_us = t0_solved;
    return true;
}

// ---------------------------------------------------------------------------
// Oscillator readout state
// ---------------------------------------------------------------------------
// PCNT hardware edge counter (high-frequency path).
static pcnt_unit_handle_t pcnt_unit = NULL;
static pcnt_channel_handle_t pcnt_channel = NULL;

// The LM393 on this board is a COMPARATOR (Schmitt trigger), not a true
// relaxation oscillator — its 100 kΩ feedback resistor only sets hysteresis,
// it does not feed the RC node.  So the ESP32 closes the loop: this ISR reads
// the comparator output and mirrors it onto the drive buffer on EVERY edge
// (hardware-in-the-loop).  PCNT / reciprocal timing then measures the result.
static volatile uint32_t osc_edge_count = 0;     // rising edges seen (for timing)
static volatile int64_t osc_first_rise_time = 0; // first rising edge
static volatile int64_t osc_last_rise_time = 0;  // most recent rising edge
static volatile bool osc_running = false;

static void IRAM_ATTR lm393_isr_handler(void *arg)
{
    (void)arg;
    if (!osc_running) return;

    // 1. Close the loop: mirror the comparator state onto the drive buffer.
    uint32_t state = (uint32_t)gpio_get_level(LM393_OUT_PIN);
    gpio_set_level(DRIVE_PIN, state);

    // 2. Rising-edge bookkeeping for the reciprocal period measurement.
    //    LM393 is LOW while the node charges and HIGH once it crosses the
    //    reference, so a LOW->HIGH edge ends a full cycle.
    if (state == 0) return;  // falling edge: feedback already applied above

    int64_t now = esp_timer_get_time();
    if (osc_edge_count == 0) {
        osc_first_rise_time = now;
        osc_last_rise_time = now;
        osc_edge_count = 1;
        return;
    }
    osc_last_rise_time = now;
    osc_edge_count++;
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------
static void select_mux_channel(uint8_t mux_channel)
{
    gpio_set_level(MUX_A0_PIN, (mux_channel & 0x01) ? 1 : 0);
    gpio_set_level(MUX_A1_PIN, (mux_channel & 0x02) ? 1 : 0);
}

static bool read_vcap_mv(int *voltage_mv)
{
    int raw = 0;
    if (adc_oneshot_read(adc_handle, ADC_CHANNEL, &raw) != ESP_OK) return false;
    if (!adc_cali_ready) return false;
    if (adc_cali_raw_to_voltage(adc_cali_handle, raw, voltage_mv) != ESP_OK) return false;
    return true;
}

static int adc_read_avg_mv(int samples)
{
    int64_t acc = 0;
    int got = 0;
    for (int i = 0; i < samples; ++i) {
        int mv;
        if (read_vcap_mv(&mv)) {
            acc += mv;
            got++;
        }
    }
    if (got == 0) return -1;
    return (int)(acc / got);
}

// Wait until V_cap falls below V_START_MV (100 kΩ and 1 MΩ ranges bleed charge
// slowly, so the budget scales with the range resistor).
static bool wait_for_start_threshold(uint8_t range_idx)
{
    int64_t budget_us = 100000LL + (int64_t)(RANGES[range_idx].resistance_ohms * 2.0);
    int64_t t0 = esp_timer_get_time();
    while ((esp_timer_get_time() - t0) < budget_us) {
        int mv = adc_read_avg_mv(2);
        if (mv >= 0 && mv <= V_START_MV) return true;
        esp_rom_delay_us(200);
    }
    return false;
}

// Full safe state cycle: pre-charge DUT at bias, discharge, isolate.
static void prepare_measurement(void)
{
    gpio_set_level(DRIVE_PIN, 0);
    gpio_set_level(SSR_S1_S3_PIN, 0);
    gpio_set_level(VBIAS_PIN, 0);

    gpio_set_level(SSR_S2_PIN, 1);
    gpio_set_level(SSR_S1_S3_PIN, 1);
    gpio_set_level(DRIVE_PIN, 1);
    vTaskDelay(pdMS_TO_TICKS(PRECHARGE_HOLD_MS));

    gpio_set_level(DRIVE_PIN, 0);
    gpio_set_level(SSR_S1_S3_PIN, 0);
    vTaskDelay(pdMS_TO_TICKS(DISCHARGE_HOLD_MS));

    gpio_set_level(SSR_S2_PIN, 0);
    esp_rom_delay_us(ISOLATION_DELAY_US);
}

static void system_hw_init(void)
{
    gpio_config_t output_config = {
        .pin_bit_mask = (1ULL << VBIAS_PIN) | (1ULL << MUX_A0_PIN) |
                        (1ULL << MUX_A1_PIN) | (1ULL << SSR_S2_PIN) |
                        (1ULL << DRIVE_PIN) | (1ULL << SSR_S1_S3_PIN),
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&output_config));

    gpio_set_level(VBIAS_PIN, 0);
    gpio_set_level(MUX_A0_PIN, 0);
    gpio_set_level(MUX_A1_PIN, 0);
    gpio_set_level(SSR_S2_PIN, 0);
    gpio_set_level(DRIVE_PIN, 0);
    gpio_set_level(SSR_S1_S3_PIN, 0);

    // LM393 output: ANYEDGE interrupt — the ISR mirrors the comparator onto
    // the drive buffer on both rising AND falling edges to close the loop.
    // Internal pull-up is a safety net on top of the external 10 kΩ pull-up.
    gpio_config_t input_config = {
        .pin_bit_mask = (1ULL << LM393_OUT_PIN),
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_ANYEDGE,
    };
    ESP_ERROR_CHECK(gpio_config(&input_config));

    // PCNT hardware pulse counter on the same pin for high-frequency work.
    pcnt_unit_config_t pcnt_unit_cfg = {
        .high_limit = 32767,
        .low_limit = -32768,
    };
    ESP_ERROR_CHECK(pcnt_new_unit(&pcnt_unit_cfg, &pcnt_unit));
    pcnt_chan_config_t pcnt_chan_cfg = {
        .edge_gpio_num = LM393_OUT_PIN,
        .level_gpio_num = -1,
    };
    ESP_ERROR_CHECK(pcnt_new_channel(pcnt_unit, &pcnt_chan_cfg, &pcnt_channel));
    ESP_ERROR_CHECK(pcnt_channel_set_edge_action(pcnt_channel,
                                                 PCNT_CHANNEL_EDGE_ACTION_INCREASE,
                                                 PCNT_CHANNEL_EDGE_ACTION_HOLD));
    ESP_ERROR_CHECK(pcnt_unit_enable(pcnt_unit));

    esp_err_t isr_err = gpio_install_isr_service(ESP_INTR_FLAG_IRAM);
    if (isr_err != ESP_OK && isr_err != ESP_ERR_INVALID_STATE) {
        ESP_ERROR_CHECK(isr_err);
    }
    ESP_ERROR_CHECK(gpio_isr_handler_add(LM393_OUT_PIN, lm393_isr_handler, NULL));

    adc_oneshot_unit_init_cfg_t unit_config = {
        .unit_id = ADC_UNIT_1,
    };
    ESP_ERROR_CHECK(adc_oneshot_new_unit(&unit_config, &adc_handle));

    adc_oneshot_chan_cfg_t channel_config = {
        .bitwidth = ADC_BITWIDTH_DEFAULT,
        .atten = ADC_ATTEN_DB_12,
    };
    ESP_ERROR_CHECK(adc_oneshot_config_channel(adc_handle, ADC_CHANNEL, &channel_config));

#if ADC_CALI_SCHEME_CURVE_FITTING_SUPPORTED
    adc_cali_curve_fitting_config_t cali_config = {
        .unit_id = ADC_UNIT_1,
        .atten = ADC_ATTEN_DB_12,
        .bitwidth = ADC_BITWIDTH_DEFAULT,
    };
    esp_err_t cali_ret = adc_cali_create_scheme_curve_fitting(&cali_config, &adc_cali_handle);
    adc_cali_ready = (cali_ret == ESP_OK);
    if (!adc_cali_ready) {
        ESP_LOGW(TAG, "ADC calibration unavailable: %s", esp_err_to_name(cali_ret));
    }
#else
    adc_cali_ready = false;
    ESP_LOGW(TAG, "ADC calibration scheme not supported by this build");
#endif
}

// Recover the true DUT capacitance from the measured series-equivalent.
//
// The measurement circuit sees C_eq = C_block ∥ (C_dut + C_stray).  The
// correct recovery order is:
//      C_eq  →  invert the C_block series combo  →  subtract C_stray
// (stray is in PARALLEL with the DUT, so it comes off after the series
// inversion, not before).  The previous code subtracted stray first, which is
// wrong and increasingly so as C_eq approaches C_block.
//
// Recover (C_dut + C_stray) from the measured series-equivalent C_eq.
// Returns the total node capacitance, or a negative sentinel when C_eq is at/
// above the singularity (C_eq ≥ C_block makes the inversion non-physical).
// The caller must treat that as an out-of-range rejection, not a reading.
static double cblock_invert(double c_eq)
{
    if (c_eq < C_BLOCK_CORRECT_MIN_F) return c_eq;      // negligible correction
    if (c_eq >= 0.9 * C_BLOCK_F) return -1.0;           // at/past singularity
    return (c_eq * C_BLOCK_F) / (C_BLOCK_F - c_eq);     // DUT + stray
}

// Compact capacitance pretty-printer (two buffers so a caller can pass two).
static void fmt_cap(double c, char *buf, size_t len)
{
    if (c < 1e-9) snprintf(buf, len, "%.2f pF", c * 1e12);
    else if (c < 1e-6) snprintf(buf, len, "%.3f nF", c * 1e9);
    else snprintf(buf, len, "%.3f uF", c * 1e6);
}

// Per-range measured asymptote cache (mV); defined below, used by logging.
extern int g_v_inf_cache[RANGE_COUNT];

// Log a single raw reading (one range / one method) with its verdict.
static void log_sample(const char *phase, const sample_t *s)
{
    const char *range  = RANGES[s->range_idx].label;
    const char *verdict = s->plausible ? "ok" : (s->valid ? "reject" : "fail");
    char cap[20];
    fmt_cap(s->capacitance_f, cap, sizeof(cap));

    if (s->method == METHOD_OSC) {
        if (s->valid) {
            double off = osc_has_t0(s->range_idx) ? osc_t0(s->range_idx)
                                                  : osc_delay(s->range_idx);
            ESP_LOGI(TAG,
                     "  [%s] OSC %6s | T %8.1f us (T0 %7.1f) | f %8.1f Hz | C %10s | q %.3f | %s",
                     phase, range, s->tau_us, off, s->freq_hz, cap, s->quality, verdict);
        } else {
            ESP_LOGW(TAG, "  [%s] OSC %6s | no oscillation / timeout | %s",
                     phase, range, verdict);
        }
    } else {
        if (s->valid) {
            if (s->fit_r2 >= 0.0) {
                ESP_LOGI(TAG,
                         "  [%s] ADC %6s | tau %8.1f us | C %10s | q %.3f | Vinf %4d mV | R2 %.3f | %s",
                         phase, range, s->tau_us, cap, s->quality,
                         g_v_inf_cache[s->range_idx], s->fit_r2, verdict);
            } else {
                ESP_LOGI(TAG,
                         "  [%s] ADC %6s | tau %8.1f us | C %10s | q %.3f | Vinf %4d mV | 2pt | %s",
                         phase, range, s->tau_us, cap, s->quality,
                         g_v_inf_cache[s->range_idx], verdict);
            }
        } else {
            ESP_LOGW(TAG, "  [%s] ADC %6s | no threshold crossing (too slow) | %s",
                     phase, range, verdict);
        }
    }
}

// Per-range measured asymptote cache (mV).  0 = not yet measured.
int g_v_inf_cache[RANGE_COUNT] = {0, 0, 0, 0};

// --- Least-squares exponential fit of the RC charge curve -----------------
// The charge follows V(t) = V_inf·(1 − e^(−t/τ)), so
//      ln(V_inf − V) = ln(V_inf) − t/τ
// is a straight line in t with slope −1/τ.  We fit that line over all sampled
// points; the slope gives τ and R² tells us how exponential the curve really
// is (leakage, ESR, or dielectric absorption bend the curve → lower R²).
#define RC_FIT_MAX_PTS 48

typedef struct {
    bool ok;
    double tau_us;   // fitted time constant
    double r2;       // coefficient of determination (1 = perfect exponential)
    int n;           // points used
} rc_fit_t;

// ts[] = time in us, mv[] = calibrated millivolts, n = count, v_inf = asymptote.
static rc_fit_t rc_exp_fit(const int64_t *ts, const int *mv, int n, int v_inf)
{
    rc_fit_t r = {.ok = false, .tau_us = 0.0, .r2 = 0.0, .n = 0};
    if (n < 6 || v_inf <= 0) return r;

    // Build y = ln(V_inf - V) and drop points too close to the asymptote where
    // (V_inf - V) approaches the ADC noise floor and the log blows up.
    // Working arrays live in static storage (single measurement task => safe)
    // to keep them off the main task's limited stack.
    static double xs[RC_FIT_MAX_PTS], ys[RC_FIT_MAX_PTS];
    double sx = 0, sy = 0, sxx = 0, sxy = 0;
    int m = 0;
    for (int i = 0; i < n; ++i) {
        double gap = (double)v_inf - (double)mv[i];
        if (gap < 12.0) continue;              // too close to asymptote / noise
        double x = (double)(ts[i] - ts[0]);     // us, relative to first sample
        double y = log(gap);
        xs[m] = x; ys[m] = y;
        sx += x; sy += y; sxx += x * x; sxy += x * y;
        m++;
        if (m >= RC_FIT_MAX_PTS) break;
    }
    if (m < 6) return r;

    double denom = (double)m * sxx - sx * sx;
    if (fabs(denom) < 1e-9) return r;
    double slope = ((double)m * sxy - sx * sy) / denom;   // = -1/τ (per us)
    if (slope >= -1e-9) return r;                          // not decaying → bad
    double tau_us = -1.0 / slope;

    // R² of the linear fit in log space.
    double ybar = sy / (double)m;
    double ss_res = 0, ss_tot = 0;
    double intercept = (sy - slope * sx) / (double)m;
    for (int i = 0; i < m; ++i) {
        double yhat = slope * xs[i] + intercept;
        double dres = ys[i] - yhat;
        double dtot = ys[i] - ybar;
        ss_res += dres * dres;
        ss_tot += dtot * dtot;
    }
    double r2 = (ss_tot > 1e-12) ? (1.0 - ss_res / ss_tot) : 0.0;

    r.ok = true;
    r.tau_us = tau_us;
    r.r2 = r2;
    r.n = m;
    return r;
}

// Measure (or recall) the true charge asymptote V_inf for a range.  The node
// asymptotes below 3.3 V when a parasitic pull-down (R_bias / leakage) forms a
// divider with the range resistor; we must reference τ thresholds to V_inf,
// not 3.3 V, or high-R ranges plateau below the old fixed 2085 mV threshold.
static int adc_asymptote_for_range(uint8_t range_idx, int v_start)
{
    if (g_v_inf_cache[range_idx] > 0) return g_v_inf_cache[range_idx];

    gpio_set_level(DRIVE_PIN, 1);
    int64_t t0 = esp_timer_get_time();
    int64_t settle_budget = (range_idx <= 1) ? 400000LL : 1500000LL; // us
    int v_inf = 0;
    int v_prev = v_start;
    while ((esp_timer_get_time() - t0) < settle_budget) {
        int mv;
        if (!read_vcap_mv(&mv)) { gpio_set_level(DRIVE_PIN, 0); return 0; }
        esp_task_wdt_reset();
        if (mv > v_inf) v_inf = mv;
        // settled: slope under ~8 mV per 20 ms and clearly above the start
        if ((mv - v_prev) < 8 && mv > v_start + 200) { v_inf = mv; break; }
        v_prev = mv;
        vTaskDelay(pdMS_TO_TICKS(20));
    }
    gpio_set_level(DRIVE_PIN, 0);

    // Re-discharge so the caller starts from a clean 0 V.
    prepare_measurement();
    if (v_inf > 0) g_v_inf_cache[range_idx] = v_inf;
    return v_inf;
}

// ---------------------------------------------------------------------------
// Method 1 — ADC RC-step τ measurement on a single range
// ---------------------------------------------------------------------------
static sample_t measure_adc_range(uint8_t range_idx)
{
    sample_t s = {
        .valid = false, .plausible = false, .method = METHOD_ADC_STEP,
        .range_idx = range_idx, .capacitance_f = 0.0, .quality = 0.0,
        .tau_us = 0.0, .c_eq_f = 0.0, .freq_hz = 0.0, .suspicious = false,
    };

    select_mux_channel(RANGES[range_idx].mux_channel);
    esp_rom_delay_us(5);
    prepare_measurement();

    // The discharge switch leaves a residual charge on high-resistance ranges;
    // actively wait until the node is safely below the start threshold.  If it
    // cannot bleed down in time the node starts charged and the tau is bogus.
    if (!wait_for_start_threshold(range_idx)) {
        log_sample(g_phase, &s);
        return s;
    }

    int v_start = adc_read_avg_mv(5);
    if (v_start < 0) {
        ESP_LOGW(TAG, "ADC start read failed on %s", RANGES[range_idx].label);
        return s;
    }

    int64_t timeout_us = (range_idx <= 1) ? ADC_TIMEOUT_SLOW_US : ADC_TIMEOUT_FAST_US;

    // ---- Phase A: measure the true asymptote V_inf for this range ----
    // Drive HIGH and watch the node settle.  The plateau reveals the divider
    // droop from any parasitic pull-down (R_bias / leakage).  The asymptote is
    // a property of the RANGE + leakage path, not the DUT, so we cache it per
    // range and only re-measure when it is stale (saves the settle time on
    // repeat visits to the same range).
    int v_inf = adc_asymptote_for_range(range_idx, v_start);
    if (v_inf < V_INF_MIN_MV) {
        ESP_LOGW(TAG, "  [%s] ADC %6s | asymptote %d mV too low (heavy pull-down) | reject",
                 g_phase, RANGES[range_idx].label, v_inf);
        log_sample(g_phase, &s);
        return s;
    }

    // Re-discharge to a clean 0 V before the actual timed charge.
    prepare_measurement();
    if (!wait_for_start_threshold(range_idx)) {
        log_sample(g_phase, &s);
        return s;
    }

    // ---- Phase B: capture the charge curve, then least-squares fit τ ----
    // We sample the node from just above the start floor up to ~70 % of V_inf
    // (past the 63.2 % τ point), then fit ln(V_inf - V) vs t.  The slope is
    // -1/τ; the R² of the fit is a direct quality/leakage metric.  If the fit
    // is unusable we fall back to the classic two-threshold crossing time.
    int v_low = v_start + (int)(0.10 * (double)(v_inf - v_start));
    if (v_low < v_start + 40) v_low = v_start + 40;
    int v_tau = v_start + (int)(V_TAU_FRAC * (double)(v_inf - v_start));
    int v_stop = v_start + (int)(0.72 * (double)(v_inf - v_start)); // capture past τ

    // Sample buffers in static storage (single measurement task => safe) to
    // avoid overflowing the main task stack (the default is only ~3.5 KB).
    static int64_t ts[RC_FIT_MAX_PTS];
    static int     mvs[RC_FIT_MAX_PTS];
    int     npts = 0;

    int64_t t_begin = esp_timer_get_time();
    gpio_set_level(DRIVE_PIN, 1);

    int64_t t_start = -1, t_tau = -1;
    int64_t t_last_feed = t_begin;
    while (true) {
        int mv;
        int64_t t_before = esp_timer_get_time();
        if (!read_vcap_mv(&mv)) {
            gpio_set_level(DRIVE_PIN, 0);
            return s;
        }
        int64_t now = (t_before + esp_timer_get_time()) / 2;

        if ((now - t_last_feed) > 500000LL) {
            esp_task_wdt_reset();
            t_last_feed = now;
        }

        if (t_start < 0 && mv >= v_low) t_start = now;
        if (t_tau < 0 && mv >= v_tau) t_tau = now;

        // record points once we are past the start floor
        if (t_start >= 0 && mv >= v_low && npts < RC_FIT_MAX_PTS) {
            ts[npts] = now;
            mvs[npts] = mv;
            npts++;
        }

        if (mv >= v_stop) break;                 // captured past τ
        if ((now - t_begin) > timeout_us) break; // too large for this range
    }
    gpio_set_level(DRIVE_PIN, 0);

    // Effective parallel resistance from the measured asymptote (divider droop).
    double r_range = RANGES[range_idx].resistance_ohms;
    double r_leak = ((double)v_inf * r_range) / ((double)V_NOMINAL_MV - (double)v_inf + 1e-9);
    double r_eff = r_range;
    if (v_inf < V_NOMINAL_MV - 50 && r_leak > 0.0) {
        r_eff = (r_range * r_leak) / (r_range + r_leak); // parallel
    }

    double tau_us = -1.0;
    double fit_r2 = 0.0;
    bool used_fit = false;
    double fallback_k_corr = 1.0;   // log factor for the 2-point fallback

    // Primary: least-squares exponential fit over the captured curve.
    rc_fit_t fit = rc_exp_fit(ts, mvs, npts, v_inf);
    if (fit.ok && fit.r2 > 0.90 && fit.tau_us > 0.0) {
        tau_us = fit.tau_us;
        fit_r2 = fit.r2;
        used_fit = true;
    } else if (t_start >= 0 && t_tau > t_start) {
        // Fallback: two-threshold crossing time with the exact log correction.
        double denom = (double)(v_inf - v_tau);
        if (denom < 1.0) denom = 1.0;
        fallback_k_corr = log(((double)(v_inf - v_low)) / denom);
        if (fallback_k_corr < 0.05) fallback_k_corr = 0.05;
        tau_us = (double)(t_tau - t_start);   // raw crossing interval
        fit_r2 = -1.0;                        // marks "fallback" in the log
    } else {
        log_sample(g_phase, &s);
        return s; // never crossed: too large for this range
    }

    s.valid = true;
    s.tau_us = tau_us;
    s.fit_r2 = fit_r2;

    // Recover C_eq.  Fitted path: τ_eff = r_eff · C_eq.  Fallback path: the
    // crossing interval must be divided by the log factor to recover τ_eff.
    double c_eq;
    if (used_fit) {
        c_eq = (tau_us * 1e-6) / r_eff;
    } else {
        c_eq = (tau_us * 1e-6) / (r_eff * fallback_k_corr);
    }
    s.c_eq_f = c_eq;

    // Correct order: invert the C_block series combination FIRST, THEN subtract
    // the parallel stray capacitance.  c_eq ≥ C_block is non-physical → reject.
    double c_total = cblock_invert(c_eq);
    if (c_total < 0.0) {                                  // at/past C_block singularity
        s.capacitance_f = 0.0;
        log_sample(g_phase, &s);
        return s;                                         // not plausible, not valid data
    }
    double c = c_total - STRAY_CAPACITANCE_F;
    if (c < 0.0) c = 0.0;
    s.capacitance_f = c;

    // ---- Physics-based plausibility ----
    if (tau_us < ADC_STEP_THRESHOLD_US) { log_sample(g_phase, &s); return s; } // poll jitter
    if (tau_us > 15e6)                  { log_sample(g_phase, &s); return s; } // beyond timeout
    if (c < 3.0 * STRAY_CAPACITANCE_F)  { log_sample(g_phase, &s); return s; } // stray-dominated
    if (c > 1.0)                        { log_sample(g_phase, &s); return s; } // > 1 F here
    s.plausible = true;

    // ---- Quality scoring ----
    // Plateau of full confidence for 200 µs ≤ τ ≤ 20 ms; Gaussian roll-off
    // outside.  Fast τ is penalised hard (ADC poll jitter), slow τ gently
    // (still a clean measurement, just slower).
    double log_tau = log(tau_us);
    double q_time;
    if (log_tau >= log(200.0) && log_tau <= log(20000.0)) {
        q_time = 1.0;
    } else if (log_tau < log(200.0)) {
        q_time = exp(-pow((log_tau - log(200.0)) / 0.8, 2.0));
    } else {
        q_time = exp(-pow((log_tau - log(20000.0)) / 2.0, 2.0));
    }
    double q_stray = c / (c + 3.0 * STRAY_CAPACITANCE_F);
    double q_range = (range_idx <= 1) ? 0.85 : 1.0; // low-R ranges: leakage hurts

    // Goodness-of-fit: a high R² means the curve is a clean exponential (low
    // leakage / low ESR).  A fitted sample with R² >= 0.99 gets full credit;
    // the 2-point fallback (fit_r2 == -1) is inherently less trustworthy, and a
    // fitted-but-poor curve (leaky / non-exponential) is down-weighted hard.
    double q_fit;
    if (s.fit_r2 < 0.0)      q_fit = 0.6;                        // 2-point fallback
    else if (s.fit_r2 >= 0.99) q_fit = 1.0;                      // clean exponential
    else                       q_fit = 0.4 + 0.6 * s.fit_r2;     // scale by R²

    double q = q_time * q_stray * q_range * q_fit;
    // No artificial quality floor: with the ADC hard-gated at
    // ADC_STEP_THRESHOLD_US, sub-floor/noisy samples never reach scoring, so a
    // low q here is genuine (leaky/non-exponential) and must be allowed to sink.
    s.quality = q;

    log_sample(g_phase, &s);
    return s;
}

// ---------------------------------------------------------------------------
// Method 2 — LM393 self-oscillating relaxation oscillator, frequency readout
//
// The LM393 hysteresis network makes the RC node free-run in hardware; the
// ESP32 only OBSERVES the edges.  High frequencies are counted with the PCNT
// peripheral over a fixed gate; low frequencies use a reciprocal period
// measurement (N rising edges / elapsed time) via the GPIO ISR.  A quick PCNT
// gate first decides which regime we are in.
// ---------------------------------------------------------------------------
#define OSC_PCNT_QUICK_GATE_MS 20
#define OSC_PCNT_GATE_MS 200
#define OSC_HIGH_FREQ_HZ 10000.0
#define OSC_PERIOD_MAX_EDGES 64
#define OSC_PERIOD_TIMEOUT_US 2000000LL

// Count edges in hardware over a gate; returns frequency via *freq_hz.
static bool osc_pcnt_frequency(uint32_t gate_ms, double *freq_hz, uint32_t *count_out)
{
    if (pcnt_unit_stop(pcnt_unit) != ESP_OK) return false;
    if (pcnt_unit_clear_count(pcnt_unit) != ESP_OK) return false;
    if (pcnt_unit_start(pcnt_unit) != ESP_OK) return false;

    int64_t t0 = esp_timer_get_time();
    vTaskDelay(pdMS_TO_TICKS(gate_ms));
    int64_t t1 = esp_timer_get_time();

    pcnt_unit_stop(pcnt_unit);
    int count = 0;
    if (pcnt_unit_get_count(pcnt_unit, &count) != ESP_OK) return false;

    // Overflow guard: the unit wraps at the configured high_limit (32767).  A
    // count within 5% of that is untrustworthy (the gate is not accumulative).
    if (count >= 31100) return false;

    double elapsed_us = (double)(t1 - t0);
    if (elapsed_us <= 0.0 || count <= 0) return false;

    *freq_hz = ((double)count * 1e6) / elapsed_us;
    if (count_out) *count_out = (uint32_t)count;
    return true;
}

// Reciprocal period measurement: average N rising-edge intervals.
static bool osc_period_frequency(double *freq_hz, uint32_t *periods_out)
{
    osc_edge_count = 0;
    osc_first_rise_time = 0;
    osc_last_rise_time = 0;
    osc_running = true;

    int64_t t0 = esp_timer_get_time();
    while (true) {
        int64_t now = esp_timer_get_time();
        if (osc_edge_count >= OSC_PERIOD_MAX_EDGES) break;
        if ((now - t0) >= OSC_PERIOD_TIMEOUT_US) break;
        esp_task_wdt_reset();
        vTaskDelay(pdMS_TO_TICKS(1));
    }
    osc_running = false;

    // Snapshot the ISR-written state atomically (64-bit reads can tear).
    uint32_t edges = osc_edge_count;
    int64_t first = atomic_read_i64(&osc_first_rise_time);
    int64_t last  = atomic_read_i64(&osc_last_rise_time);

    if (edges < 2 || last <= first) return false;

    uint32_t periods = edges - 1;
    double elapsed_us = (double)(last - first);
    if (elapsed_us <= 0.0) return false;

    *freq_hz = ((double)periods * 1e6) / elapsed_us;
    if (periods_out) *periods_out = periods;
    return true;
}

// Auto-select PCNT (high f) vs reciprocal period (low f), exactly like the
// proven frequency_meter design.
static bool osc_measure_frequency(double *freq_hz, uint32_t *periods_out)
{
    double quick_f = 0.0;
    uint32_t quick_count = 0;
    if (osc_pcnt_frequency(OSC_PCNT_QUICK_GATE_MS, &quick_f, &quick_count)) {
        if (quick_f >= OSC_HIGH_FREQ_HZ) {
            return osc_pcnt_frequency(OSC_PCNT_GATE_MS, freq_hz, periods_out);
        }
    }
    return osc_period_frequency(freq_hz, periods_out);
}

static sample_t measure_osc_range(uint8_t range_idx)
{
    sample_t s = {
        .valid = false, .plausible = false, .method = METHOD_OSC,
        .range_idx = range_idx, .capacitance_f = 0.0, .quality = 0.0,
        .tau_us = 0.0, .c_eq_f = 0.0, .freq_hz = 0.0, .suspicious = false,
    };

    select_mux_channel(RANGES[range_idx].mux_channel);
    esp_rom_delay_us(5);
    prepare_measurement();

    // Kick-start the software-in-the-loop oscillator.  After
    // prepare_measurement() the node is discharged (V_cap ≈ 0).  We prime the
    // drive with the comparator's CURRENT output level; the ISR then mirrors
    // the comparator onto the buffer on every edge and the loop self-sustains.
    // (This board's LM393 is a comparator, not a free-running oscillator —
    // the ESP32 feedback is what makes it oscillate.)
    osc_running = true;
    uint32_t comp_state = (uint32_t)gpio_get_level(LM393_OUT_PIN);
    gpio_set_level(DRIVE_PIN, comp_state);

    double freq_hz = 0.0;
    uint32_t n_periods = 0;
    bool ok = osc_measure_frequency(&freq_hz, &n_periods);

    osc_running = false;
    gpio_set_level(DRIVE_PIN, 0);

    if (!ok || freq_hz <= 0.0) {
        ESP_LOGW(TAG, "  [%s] OSC %6s | no oscillation / timeout (edges=%lu) | fail",
                 g_phase, RANGES[range_idx].label, (unsigned long)osc_edge_count);
        return s;
    }

    // Convert period to capacitance.  Preferred model uses the measured
    // open-node tare:
    //      T = K·R·(C_stray + C_dut) + latency  ⇒  T = K·R·C_dut + T0
    //      C_eq = (T − T0)/(K·R)   (T0 absorbs ALL parasitic C + fixed delays)
    // Legacy fallback (no tare): subtract the fixed delay, keep the nominal
    // stray removal below so an un-calibrated board behaves as before.
    double period_us = 1e6 / freq_hz;
    bool use_t0 = osc_has_t0(range_idx);
    double eff_period_us = period_us - (use_t0 ? osc_t0(range_idx)
                                               : osc_delay(range_idx));

    // T_meas ≤ offset is non-physical (would imply a negative/zero RC time).
    // Reject outright instead of clamping to a fake positive capacitance.
    if (eff_period_us <= 0.0) {
        s.freq_hz = freq_hz;
        s.tau_us = period_us;
        log_sample(g_phase, &s);
        return s;                                             // invalid
    }

    s.valid = true;
    s.tau_us = period_us;       // report the raw measured full period T
    s.freq_hz = freq_hz;
    s.suspicious = false;

    // C_eq = (T − T0)/(K·R) is the DUT series-equivalent (stray already tared);
    // invert the C_block series combo for large DUTs.
    double c_eq = (eff_period_us * 1e-6) /
                  (osc_k(range_idx) * RANGES[range_idx].resistance_ohms);
    s.c_eq_f = c_eq;
    double c_total = cblock_invert(c_eq);
    if (c_total < 0.0) {                              // at/past C_block singularity
        s.capacitance_f = 0.0;
        log_sample(g_phase, &s);
        return s;                                     // invalid
    }
    // With a tare, c_total IS the DUT (stray already removed).  Legacy path
    // still needs the nominal stray subtracted.
    double c = use_t0 ? c_total : (c_total - STRAY_CAPACITANCE_F);
    if (c < 0.0) c = 0.0;
    s.capacitance_f = c;

    // ---- Physics-based plausibility ----
    if (freq_hz < OSC_MIN_F_HZ)          { log_sample(g_phase, &s); return s; } // too slow / leaky
    if (freq_hz > 1000000.0)             { log_sample(g_phase, &s); return s; } // too fast for comparator
    if (n_periods < 4)                   { log_sample(g_phase, &s); return s; } // too few edges to trust
    // Noise floor: with a tare the parasitic C is removed, so the limit is the
    // timing-noise resolution (sub-pF), NOT the old 6 pF stray fraction.  An
    // un-tared range still uses the legacy floor.
    double c_floor = use_t0 ? 0.5e-12 : 0.5 * STRAY_CAPACITANCE_F;
    if (c < c_floor)                     { log_sample(g_phase, &s); return s; }
    s.plausible = true;

    // ---- Quality scoring ----
    // Plateau of full confidence for 500 Hz ≤ f ≤ 10 kHz; Gaussian roll-off
    // outside (ISR latency dominates high f, leakage/offset dominates low f).
    double log_f = log(freq_hz);
    double q_freq;
    if (freq_hz >= 500.0 && freq_hz <= 10000.0) {
        q_freq = 1.0;
    } else if (freq_hz < 500.0) {
        q_freq = exp(-pow((log_f - log(500.0)) / 1.2, 2.0));
    } else {
        q_freq = exp(-pow((log_f - log(10000.0)) / 0.9, 2.0));
    }
    // More averaged periods -> more confidence (replaces the old CV term, which
    // is not available from a hardware-counted average).
    double q_count = (n_periods >= OSC_TARGET_PERIODS) ? 1.0
                     : 0.6 + 0.4 * ((double)n_periods / (double)OSC_TARGET_PERIODS);
    // With a tare, small DUTs are credible: use a sub-pF noise reference rather
    // than penalising every reading below ~36 pF as "stray-dominated".
    double q_stray = use_t0 ? (c / (c + 0.5e-12))
                            : (c / (c + 3.0 * STRAY_CAPACITANCE_F));
    s.quality = q_freq * q_count * q_stray;

    log_sample(g_phase, &s);
    return s;
}

// ---------------------------------------------------------------------------
// Small statistics helpers
// ---------------------------------------------------------------------------
static int cmp_double(const void *a, const void *b)
{
    double da = *(const double *)a, db = *(const double *)b;
    return (da > db) - (da < db);
}

static double median_of(const double *v, int n)
{
    if (n <= 0) return NAN;
    static double buf[MAX_SAMPLES];   // static: single measurement task
    for (int i = 0; i < n; ++i) buf[i] = v[i];
    qsort(buf, (size_t)n, sizeof(double), cmp_double);
    if (n & 1) return buf[n / 2];
    return 0.5 * (buf[n / 2 - 1] + buf[n / 2]);
}

// ---------------------------------------------------------------------------
// Fusion engine — median gate + log-domain weighted average
// ---------------------------------------------------------------------------
static fusion_t fuse_samples(const sample_t *samples, int n)
{
    fusion_t f = {
        .valid = false, .capacitance_f = 0.0, .rel_spread = 0.0,
        .total_weight = 0.0, .n_adc = 0, .n_osc = 0,
        .adc_estimate = NAN, .osc_estimate = NAN, .method_mismatch = false,
        .raw_samples = n,
    };

    static double cvals[MAX_SAMPLES];   // static: keep off the main stack
    static double weights[MAX_SAMPLES];
    static int kept_method[MAX_SAMPLES];
    int n_kept = 0;

    for (int i = 0; i < n; ++i) {
        if (!samples[i].valid || !samples[i].plausible) continue;
        if (samples[i].quality < 0.02) continue; // noise floor
        cvals[n_kept] = samples[i].capacitance_f;
        weights[n_kept] = samples[i].quality;
        kept_method[n_kept] = (int)samples[i].method;
        n_kept++;
    }
    if (n_kept == 0) return f;

    // Per-method estimates are computed on the RAW (pre-gate) populations so a
    // genuine ADC-vs-OSC disagreement is reported even if one method is later
    // discarded as an outlier.  Hiding a 2× method split behind the gate would
    // defeat the purpose of the cross-check.
    double adc_raw_sum = 0.0, adc_raw_w = 0.0;
    double osc_raw_sum = 0.0, osc_raw_w = 0.0;
    for (int i = 0; i < n_kept; ++i) {
        double logc = log(cvals[i] > 0.0 ? cvals[i] : 1e-15);
        if (kept_method[i] == (int)METHOD_ADC_STEP) {
            adc_raw_sum += weights[i] * logc; adc_raw_w += weights[i];
        } else {
            osc_raw_sum += weights[i] * logc; osc_raw_w += weights[i];
        }
    }
    if (adc_raw_w > 0.0) f.adc_estimate = exp(adc_raw_sum / adc_raw_w);
    if (osc_raw_w > 0.0) f.osc_estimate = exp(osc_raw_sum / osc_raw_w);
    if (!isnan(f.adc_estimate) && !isnan(f.osc_estimate)) {
        double lo = fmin(f.adc_estimate, f.osc_estimate);
        double hi = fmax(f.adc_estimate, f.osc_estimate);
        if (lo > 0.0 && hi / lo > METHOD_MISMATCH_RATIO) f.method_mismatch = true;
    }

    double med = median_of(cvals, n_kept);

    // Median gate: discard anything more than FUSION_GATE_REL (relative) away
    // from the median — kills one-off ADC glitches / ISR hiccups.
    double lw_sum = 0.0, lw = 0.0;
    int n_adc_kept = 0, n_osc_kept = 0;

    for (int i = 0; i < n_kept; ++i) {
        if (med > 0.0 && fabs(cvals[i] - med) / med > FUSION_GATE_REL) {
            continue;
        }
        double logc = log(cvals[i] > 0.0 ? cvals[i] : 1e-15);
        double w = weights[i];
        lw_sum += w * logc;
        lw += w;
        if (kept_method[i] == (int)METHOD_ADC_STEP) n_adc_kept++; else n_osc_kept++;
    }
    f.n_adc = n_adc_kept;
    f.n_osc = n_osc_kept;
    if (lw <= 0.0) return f;

    double fused_log = lw_sum / lw;
    f.capacitance_f = exp(fused_log);
    f.total_weight = lw;
    f.valid = true;

    // Weighted relative spread (RMS log deviation → fractional).
    double var = 0.0;
    for (int i = 0; i < n_kept; ++i) {
        if (med > 0.0 && fabs(cvals[i] - med) / med > FUSION_GATE_REL) continue;
        double d = log((cvals[i] > 0.0 ? cvals[i] : 1e-15) / f.capacitance_f);
        var += weights[i] * d * d;
    }
    f.rel_spread = sqrt(var / lw);
    return f;
}

// ---------------------------------------------------------------------------
// Autoranging orchestrator — probe, sweep, fuse
// ---------------------------------------------------------------------------
static fusion_t measure_capacitance_autoranged(void)
{
    static uint8_t preferred_range = 2; // remembered between cycles (100 kΩ)

    static sample_t samples[MAX_SAMPLES];   // static: keep off the main stack
    int n = 0;

    // ---- Phase 1: probe with the oscillator for a rough estimate ----
    g_phase = "probe";
    sample_t probe = measure_osc_range(preferred_range);
    double rough_c = 0.0;
    bool have_rough = false;
    if (probe.valid && probe.plausible && probe.capacitance_f > 0.0) {
        // Use the series-equivalent C the circuit actually sees for planning,
        // NOT the reconstructed DUT value (they diverge near C_block).
        rough_c = (probe.c_eq_f > 0.0) ? probe.c_eq_f : probe.capacitance_f;
        have_rough = true;
    }

    // Fall back to a linear hunt if the probe failed (open DUT, huge cap…).
    if (!have_rough) {
        for (int r = RANGE_COUNT - 1; r >= 0 && !have_rough; --r) {
            g_phase = "hunt";
            sample_t p = measure_osc_range((uint8_t)r);
            if (p.valid && p.plausible && p.capacitance_f > 0.0) {
                rough_c = (p.c_eq_f > 0.0) ? p.c_eq_f : p.capacitance_f;
                have_rough = true;
                preferred_range = (uint8_t)r;
                probe = p;
            }
        }
    }

    // ---- Phase 2: choose ADC sweep ranges from the rough estimate ----
    bool adc_tried[RANGE_COUNT] = {false, false, false, false};
    int osc_best_range = -1;
    double osc_best_cost = 1e30;

    // The ADC cannot resolve sub-nF DUTs (a 10 pF signal on 1 MΩ is ~10 µs of
    // τ, below the sample-loop jitter).  When the oscillator already tells us
    // the DUT is small, skip the ADC entirely and let the tared oscillator own
    // the measurement — otherwise the ADC's ~136 pF node offset leaks in as a
    // bogus ~170 pF reading.
    bool sub_nf = have_rough && rough_c > 0.0 && rough_c < ADC_SUBNF_GATE_F;

    if (have_rough && rough_c > 0.0) {
        for (int r = 0; r < RANGE_COUNT; ++r) {
            double tau_us = rough_c * RANGES[r].resistance_ohms * 1e6;
            if (!sub_nf && tau_us >= (double)ADC_STEP_THRESHOLD_US && tau_us <= 4.0e6)
                adc_tried[r] = true;

            double f_pred = 1.0 / (osc_k((uint8_t)r) * RANGES[r].resistance_ohms * rough_c);
            // OSC confirmation where the loop is genuinely informative: above
            // the ISR-latency floor yet below the point where the fixed per-edge
            // delay erases the capacitive signal (upper bound), and not so low
            // that leakage/offset dominates (lower bound).  Low frequencies are
            // NOT delay-limited, so large caps get an accurate OSC cross-check.
            if (f_pred >= 100.0 && f_pred <= 15000.0) {
                double cost = fabs(log(f_pred / OSC_F_SWEET_HZ));
                if (cost < osc_best_cost) {
                    osc_best_cost = cost;
                    osc_best_range = r;
                }
            }
        }
    } else {
        // No estimate at all: sweep everything ADC-side and try OSC on 100 kΩ.
        for (int r = 0; r < RANGE_COUNT; ++r) adc_tried[r] = true;
        osc_best_range = 2;
    }

    // ---- Phase 3: gather samples across ranges and methods ----
    bool fastest_range_saturated = false;
    double best_adc_q = -1.0;
    g_phase = "adc";
    for (int r = 0; r < RANGE_COUNT && n < MAX_SAMPLES; ++r) {
        if (!adc_tried[r]) continue;
        sample_t s = measure_adc_range((uint8_t)r);
        if (s.valid) samples[n++] = s;

        // Track the HIGHEST-quality range for next cycle's probe (not merely
        // the last acceptable one visited).
        if (s.valid && s.plausible && s.quality > best_adc_q) {
            best_adc_q = s.quality;
            preferred_range = (uint8_t)r;
        }
        if (r == 0 && s.valid && !s.plausible) fastest_range_saturated = true;
    }

    // Even 100 Ohm was too fast to time cleanly -> confirm on the 100 kOhm
    // sub-range, which slows the edge ~1000x into the accurate ADC window.
    if (fastest_range_saturated && !adc_tried[2] && n < MAX_SAMPLES) {
        g_phase = "adc-sub";
        sample_t s = measure_adc_range(2);
        if (s.valid) samples[n++] = s;
        if (s.valid && s.plausible) preferred_range = 2;
    }

    // Primary oscillator run (reuses the probe if it was on the best range).
    bool osc_added = false;
    if (osc_best_range >= 0 && n < MAX_SAMPLES) {
        if (probe.valid && (int)probe.range_idx == osc_best_range && probe.plausible) {
            samples[n++] = probe;
            osc_added = true;
        } else {
            g_phase = "osc";
            sample_t o = measure_osc_range((uint8_t)osc_best_range);
            if (o.valid) {
                samples[n++] = o;
                osc_added = true;
                // A clean OSC sample also tells us the best range to probe on
                // next cycle (fixes probe getting stuck on a slow range).
                if (o.plausible && o.quality > best_adc_q) {
                    best_adc_q = o.quality;
                    preferred_range = (uint8_t)osc_best_range;
                }
            }
        }
    }

    // Neighbouring-range oscillator run for cross-validation when time permits.
    if (osc_added && osc_best_range >= 0 && n < MAX_SAMPLES) {
        int alt = (osc_best_range > 0) ? osc_best_range - 1 : osc_best_range + 1;
        if (alt >= 0 && alt < RANGE_COUNT) {
            double f_alt = have_rough && rough_c > 0.0
                               ? 1.0 / (osc_k((uint8_t)alt) * RANGES[alt].resistance_ohms * rough_c)
                               : 0.0;
            if (f_alt >= 100.0 && f_alt <= 15000.0) {
                g_phase = "osc-x";
                sample_t o2 = measure_osc_range((uint8_t)alt);
                if (o2.valid) samples[n++] = o2;
            }
        }
    }

    g_phase = "fuse";
    fusion_t result = fuse_samples(samples, n);
    return result;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
static void format_cap(double c, char *buf, size_t len)
{
    if (c < 1e-9) snprintf(buf, len, "%7.2f pF", c * 1e12);
    else if (c < 1e-6) snprintf(buf, len, "%7.2f nF", c * 1e9);
    else snprintf(buf, len, "%7.2f uF", c * 1e6);
}

static void log_result(const fusion_t *f)
{
    if (!f->valid) {
        ESP_LOGE(TAG, "Measurement failed — no plausible sample on any range/method");
        return;
    }

    char cap_buf[24];
    format_cap(f->capacitance_f, cap_buf, sizeof(cap_buf));

    const char *conf = (f->rel_spread < 0.05) ? "HIGH"
                       : (f->rel_spread < 0.15) ? "MED" : "LOW";

    ESP_LOGI(TAG,
             "C = %s | spread %5.1f%% | conf %s | w %.2f | samples %d (ADC %d / OSC %d)",
             cap_buf, f->rel_spread * 100.0, conf, f->total_weight, f->raw_samples,
             f->n_adc, f->n_osc);

    if (!isnan(f->adc_estimate) && !isnan(f->osc_estimate)) {
        char a[24], o[24];
        format_cap(f->adc_estimate, a, sizeof(a));
        format_cap(f->osc_estimate, o, sizeof(o));
        ESP_LOGI(TAG, "   cross-check: ADC %s vs OSC %s", a, o);
    }

    if (f->method_mismatch) {
        ESP_LOGW(TAG,
                 "   ADC and oscillator methods disagree > %.0f%% — inspect DUT "
                 "(leakage/ESR) or re-run OSC calibration (§4)",
                 (METHOD_MISMATCH_RATIO - 1.0) * 100.0);
    }
    if (f->rel_spread > 0.20) {
        ESP_LOGW(TAG, "   high sample dispersion — possible DUT leakage, ESR or poor contact");
    }
}

// ---------------------------------------------------------------------------
#if OSC_DEBUG_MODE
// ============================================================================
//  OSC-ONLY DEBUG CONSOLE  (see OSC_DEBUG_MODE note above)
// ============================================================================
static volatile uint32_t dbg_edges = 0;
static volatile uint32_t dbg_isr_calls = 0;

static void IRAM_ATTR dbg_isr(void *arg)
{
    (void)arg;
    dbg_isr_calls++;
    if (!osc_running) return;
    uint32_t state = (uint32_t)gpio_get_level(LM393_OUT_PIN);
    gpio_set_level(DRIVE_PIN, state);   // close the loop
    dbg_edges++;
}

static void dbg_print_state(int range_idx)
{
    pcnt_unit_stop(pcnt_unit);
    pcnt_unit_clear_count(pcnt_unit);
    pcnt_unit_start(pcnt_unit);
    int64_t t0 = esp_timer_get_time();
    vTaskDelay(pdMS_TO_TICKS(100));
    int64_t t1 = esp_timer_get_time();
    pcnt_unit_stop(pcnt_unit);
    int cnt = 0;
    pcnt_unit_get_count(pcnt_unit, &cnt);
    double f = (t1 > t0 && cnt > 0) ? ((double)cnt * 1e6 / (double)(t1 - t0)) : 0.0;
    printf("\n--- OSC DEBUG ---\n"
           "  range=%s  running=%d\n"
           "  GPIO14(LM393)=%d  GPIO16(DRIVE)=%d\n"
           "  ISR calls=%lu  edges=%lu  PCNT cnt=%d over %lld us  f=%.1f Hz\n",
           RANGES[range_idx].label, (int)osc_running,
           gpio_get_level(LM393_OUT_PIN), gpio_get_level(DRIVE_PIN),
           (unsigned long)dbg_isr_calls, (unsigned long)dbg_edges,
           cnt, (long long)(t1 - t0), f);
    if (f > 0.0) {
        bool use_t0 = osc_has_t0((uint8_t)range_idx);
        double off_us = use_t0 ? osc_t0((uint8_t)range_idx)
                               : osc_delay((uint8_t)range_idx);
        double eff_us = 1e6 / f - off_us;
        double c_eq = (eff_us * 1e-6) / (osc_k((uint8_t)range_idx) *
                                         RANGES[range_idx].resistance_ohms);
        double c = use_t0 ? c_eq : (c_eq - STRAY_CAPACITANCE_F);
        printf("  -> implied C = %.3f nF  (K=%.4f %s=%.2fus R=%s%s)\n",
               c * 1e9, osc_k((uint8_t)range_idx), use_t0 ? "T0" : "delay",
               off_us, RANGES[range_idx].label,
               g_osc_cal[range_idx].valid ? " cal" : " default");
    }
    printf("-----------------\n\n");
}

// Measure the current oscillation frequency on the selected range.
// Uses an adaptive gate: start short so high frequencies never overflow the
// 32767-count PCNT limit, and lengthen only if the count is too low to be
// accurate.  Returns Hz, or -1 on no-signal/overflow-unsafe.
static double dbg_measure_freq(void)
{
    static const uint32_t gates_ms[] = {20, 50, 200, 500};
    for (size_t gi = 0; gi < sizeof(gates_ms) / sizeof(gates_ms[0]); ++gi) {
        pcnt_unit_stop(pcnt_unit);
        pcnt_unit_clear_count(pcnt_unit);
        pcnt_unit_start(pcnt_unit);
        int64_t t0 = esp_timer_get_time();
        vTaskDelay(pdMS_TO_TICKS(gates_ms[gi]));
        int64_t t1 = esp_timer_get_time();
        pcnt_unit_stop(pcnt_unit);
        int cnt = 0;
        pcnt_unit_get_count(pcnt_unit, &cnt);
        if (t1 <= t0) return -1.0;
        if (cnt >= 31100) return -1.0;          // overflow-unsafe: refuse to trust
        if (cnt <= 2) {
            if (gi + 1 < sizeof(gates_ms) / sizeof(gates_ms[0])) continue; // too few edges, lengthen
            return -1.0;                        // no oscillation even at longest gate
        }
        double f = (double)cnt * 1e6 / (double)(t1 - t0);
        // If the shortest gate already overflowed-safe but count is healthy, accept.
        // If count is small, prefer a longer gate for resolution.
        if (cnt >= 20 || gi + 1 == sizeof(gates_ms) / sizeof(gates_ms[0])) return f;
    }
    return -1.0;
}

static void dbg_start(void)
{
    dbg_edges = 0;
    osc_running = true;
    gpio_set_level(DRIVE_PIN, (uint32_t)gpio_get_level(LM393_OUT_PIN));
}

static void dbg_stop(void)
{
    osc_running = false;
    gpio_set_level(DRIVE_PIN, 0);
}

// Direct connectivity probe for one range: drive the node HIGH and watch V_cap
// over time.  This answers "is the resistor actually in the circuit?" without
// any oscillator/timeout logic in the way.
//   - node rises toward 3.3 V        -> resistor present, RC charging works
//   - node pinned near 0 V           -> short / discharge clamp stuck closed
//   - node stuck mid-rail / no move  -> mux channel NC, broken R, or open node
static void dbg_probe_range(int range_idx)
{
    select_mux_channel(RANGES[range_idx].mux_channel);
    esp_rom_delay_us(5);
    prepare_measurement();          // discharge node via SSR2 clamp

    // Scale the sampling to the range: a 1 MΩ range needs a long window to see
    // any movement on a modest cap, while a 100 Ω range moves in µs.
    double r = RANGES[range_idx].resistance_ohms;
    uint32_t interval_ms = (r >= 1e6) ? 500 : (r >= 100e3) ? 200 : (r >= 1e3) ? 50 : 5;
    int n_samples = 10;

    printf("\n--- CONNECTIVITY PROBE: %s (mux ch %d) ---\n",
           RANGES[range_idx].label, RANGES[range_idx].mux_channel);

    // ---- Phase 0: actively drive LOW and confirm the node actually reaches ~0 V ----
    // prepare_measurement()'s clamp can be too weak/slow on the high-R ranges,
    // so we explicitly pull the node down through the range resistor and verify
    // it settles near 0 V before we start the charge test.  A node that will
    // NOT pull down is itself a strong diagnostic (short to a rail / clamp
    // stuck / floating).
    gpio_set_level(DRIVE_PIN, 0);
    int64_t t_low0 = esp_timer_get_time();
    int64_t low_budget_us = 200000LL + (int64_t)(r * 3.0); // ~3 tau of settling room
    int v_low_read = -1;
    bool pulled_down = false;
    while ((esp_timer_get_time() - t_low0) < low_budget_us) {
        v_low_read = adc_read_avg_mv(3);
        if (v_low_read >= 0 && v_low_read <= V_START_MV) { pulled_down = true; break; }
        esp_task_wdt_reset();
        esp_rom_delay_us(200);
    }
    printf("  pull-down: V_cap=%4d mV after %.0f ms  %s\n",
           v_low_read, (double)(esp_timer_get_time() - t_low0) / 1000.0,
           pulled_down ? "(OK, near 0 V)" : "(STUCK HIGH - node won't pull to 0 V!)");

    // ---- Phase 1: drive HIGH and watch the charge curve ----
    printf("  driving node HIGH, sampling V_cap every %lu ms x %d...\n",
           (unsigned long)interval_ms, n_samples);

    gpio_set_level(DRIVE_PIN, 1);
    int64_t t0 = esp_timer_get_time();
    int v_first = -1, v_last = -1, v_peak = -1;
    for (int i = 0; i < n_samples; ++i) {
        int mv = adc_read_avg_mv(3);
        int64_t dt = esp_timer_get_time() - t0;
        if (i == 0) v_first = mv;
        if (mv > v_peak) v_peak = mv;
        v_last = mv;
        printf("    t=%8.1f ms   V_cap=%4d mV\n", (double)dt / 1000.0, mv);
        esp_task_wdt_reset();
        vTaskDelay(pdMS_TO_TICKS(interval_ms));
    }
    gpio_set_level(DRIVE_PIN, 0);

    // Verdict based on whether the node MOVED, not an absolute threshold (a
    // 1 MΩ range on a big cap may legitimately still be climbing slowly).
    int delta = v_last - v_first;
    printf("  verdict: ");
    if (!pulled_down) {
        // The node would not even pull to 0 V: it is held up by something
        // (short to a rail, clamp stuck, or a genuinely open/floating path
        // that drifted high).  This is the primary failure, report it first.
        printf("NODE STUCK HIGH (would not pull to 0 V) - short to rail / clamp stuck / open\n");
    } else if (v_peak >= 1500 || delta >= 300) {
        printf("NODE CHARGES (resistor present, RC path OK)\n");
    } else if (v_peak <= 100) {
        printf("PINNED LOW (short to GND, or discharge clamp stuck on)\n");
    } else if (delta < 50) {
        printf("NOT CHARGING (mux channel open / resistor missing / node floating)\n");
    } else {
        printf("WEAK / SLOW (moved only %d mV; check R value or leakage)\n", delta);
    }
    printf("  (first=%d mV  last=%d mV  peak=%d mV  interval=%lu ms)\n",
           v_first, v_last, v_peak, (unsigned long)interval_ms);
    printf("--------------------------------------------\n\n");
}

// Two-point calibration session state (per range).  Point 1 is held here
// until point 2 is captured, then both K and delay are solved together.
static bool   g_cal_pending = false;
static int    g_cal_range = -1;
static double g_cal_f1 = 0.0;
static double g_cal_ref1 = 0.0;

// Capture one calibration point (frequency at a known reference) on the
// current range.  Returns the measured frequency, or -1 on failure.
static double dbg_capture_point(int range_idx, double ref_pf, double *ref_c_out)
{
    *ref_c_out = ref_pf * 1e-12;
    bool was = osc_running;
    if (!was) dbg_start();
    vTaskDelay(pdMS_TO_TICKS(60));      // let the loop settle
    double f = dbg_measure_freq();
    if (!was) dbg_stop();
    if (f <= 0.0) {
        printf(">> no oscillation / unsafe count on %s (check loop on scope)\n",
               RANGES[range_idx].label);
        return -1.0;
    }
    printf(">> point: %s ref=%.1f pF  f=%.1f Hz\n", RANGES[range_idx].label, ref_pf, f);
    return f;
}

// Tare the open-node offset T0.  With the DUT socket EMPTY, average several
// oscillator periods and store T0 ≈ K·R·C_stray + latency.  Subtracting T0 in
// the measurement removes the parasitic capacitance, which is the whole point
// of sub-nF operation.  range_or_all < 0 => every range (low-R ranges usually
// oscillate too fast to tare and are skipped with a message).
static void dbg_tare(int range_or_all)
{
    int first = (range_or_all < 0) ? 0 : range_or_all;
    int last  = (range_or_all < 0) ? RANGE_COUNT - 1 : range_or_all;

    for (int r = first; r <= last; ++r) {
        bool was = osc_running;
        dbg_stop();
        select_mux_channel(RANGES[r].mux_channel);
        esp_rom_delay_us(5);
        prepare_measurement();          // discharge the node first
        if (!was) dbg_start();
        vTaskDelay(pdMS_TO_TICKS(60));  // let the loop settle

        double acc = 0.0;
        int got = 0;
        for (int k = 0; k < 8; ++k) {
            double f = dbg_measure_freq();
            if (f > 0.0) { acc += 1e6 / f; got++; }
            esp_task_wdt_reset();
            vTaskDelay(pdMS_TO_TICKS(10));
        }
        if (!was) dbg_stop();

        if (got == 0) {
            printf(">> %s: no oscillation with socket empty "
                   "(range too fast / unusable for tare)\n", RANGES[r].label);
            continue;
        }
        double period = acc / (double)got;
        g_osc_cal[r].t0_us = period;
        g_osc_cal[r].has_t0 = true;
        esp_err_t e = osc_cal_save();
        double k = osc_k((uint8_t)r);
        double r_ohm = RANGES[r].resistance_ohms;
        double stray_pf = (k * r_ohm > 0.0)
                              ? (period * 1e-6) / (k * r_ohm) * 1e12 : 0.0;
        printf(">> %s TARE: T0 = %.2f us  (implied parasitic C = %.1f pF)  %s\n",
               RANGES[r].label, period, stray_pf,
               (e == ESP_OK) ? "saved to NVS" : "NVS SAVE FAILED");
    }
}

// 'cal <ref_pF>'        — one-point: solve K (uses T0 if tared), C_eq-consistent.
// 'cal1 <ref_pF>' then 'cal2 <ref_pF>' — two-point: solve K AND T0 exactly.
static void dbg_calibrate(int range_idx, const char *cmd, double ref_pf)
{
    bool two_first  = (strncmp(cmd, "cal1", 4) == 0);
    bool two_second = (strncmp(cmd, "cal2", 4) == 0);

    if (two_first) {
        double ref_c;
        double f = dbg_capture_point(range_idx, ref_pf, &ref_c);
        if (f <= 0.0) { g_cal_pending = false; return; }
        g_cal_pending = true;
        g_cal_range = range_idx;
        g_cal_f1 = f;
        g_cal_ref1 = ref_c;
        printf(">> point 1 captured on %s.  Now fit a DIFFERENT reference and run 'cal2 <ref_pF>'.\n",
               RANGES[range_idx].label);
        return;
    }

    if (two_second) {
        if (!g_cal_pending || g_cal_range != range_idx) {
            printf(">> no pending point-1 for %s.  Run 'cal1 <ref_pF>' first.\n",
                   RANGES[range_idx].label);
            return;
        }
        double ref_c2;
        double f2 = dbg_capture_point(range_idx, ref_pf, &ref_c2);
        if (f2 <= 0.0) { g_cal_pending = false; return; }

        double k, t0;
        if (!osc_cal_solve_two_point((uint8_t)range_idx,
                                     g_cal_f1, g_cal_ref1, f2, ref_c2, &k, &t0)) {
            printf(">> CAL FAILED: two-point solve rejected (refs too similar / non-physical).\n");
            g_cal_pending = false;
            return;
        }
        g_osc_cal[range_idx].k = k;
        g_osc_cal[range_idx].t0_us = t0;
        g_osc_cal[range_idx].has_t0 = true;
        g_osc_cal[range_idx].valid = true;
        esp_err_t e = osc_cal_save();
        printf(">> %s TWO-POINT: K=%.5f T0=%.3f us  (refs %.4g pF + %.4g pF)  %s\n",
               RANGES[range_idx].label, k, t0,
               g_cal_ref1 * 1e12, ref_c2 * 1e12,
               (e == ESP_OK) ? "saved to NVS" : "NVS SAVE FAILED");
        g_cal_pending = false;
        return;
    }

    // One-point: solve K only, using the C_eq model (consistent with measurement).
    double ref_c;
    double f = dbg_capture_point(range_idx, ref_pf, &ref_c);
    if (f <= 0.0) return;
    double k = osc_cal_solve_k((uint8_t)range_idx, f, ref_c);
    if (k <= 0.0) {
        printf(">> CAL FAILED: could not solve K (f=%.1f Hz).\n", f);
        return;
    }
    g_osc_cal[range_idx].k = k;
    g_osc_cal[range_idx].valid = true;
    esp_err_t e = osc_cal_save();
    printf(">> %s ONE-POINT: K=%.5f (%s %.2f us)  ref=%.1f pF  %s\n",
           RANGES[range_idx].label, k,
           osc_has_t0((uint8_t)range_idx) ? "T0 held at" : "delay held at (no tare!)",
           osc_has_t0((uint8_t)range_idx) ? osc_t0((uint8_t)range_idx)
                                          : g_osc_cal[range_idx].delay_us,
           ref_pf, (e == ESP_OK) ? "saved to NVS" : "NVS SAVE FAILED");
}

void app_main(void)
{
    // NVS is required to persist the per-range oscillator calibration.
    esp_err_t nvs_err = nvs_flash_init();
    if (nvs_err == ESP_ERR_NVS_NO_FREE_PAGES || nvs_err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        nvs_flash_erase();
        nvs_err = nvs_flash_init();
    }
    if (nvs_err != ESP_OK) ESP_LOGW(TAG, "NVS init failed: %s", esp_err_to_name(nvs_err));

    // Reuse the standard bring-up (outputs, mux, PCNT) but install our own ISR.
    system_hw_init();
    osc_cal_load();
    gpio_isr_handler_remove(LM393_OUT_PIN);
    gpio_isr_handler_add(LM393_OUT_PIN, dbg_isr, NULL);

    uart_driver_install(UART_NUM_0, 512, 0, 0, NULL, 0);

    esp_task_wdt_config_t wdt = {.timeout_ms = 60000,
                                 .idle_core_mask = (1 << portNUM_PROCESSORS) - 1,
                                 .trigger_panic = false};
    esp_task_wdt_reconfigure(&wdt);
    esp_task_wdt_add(NULL);

    int range_idx = 2;
    select_mux_channel(RANGES[range_idx].mux_channel);
    printf("\n=== OSC DEBUG CONSOLE ===\n"
           "range=%s\n"
           "  0-3 range | g start | s stop | r restart | p state\n"
           "  zero      tare T0 with the socket EMPTY (removes parasitic C)\n"
           "  zeroall   tare every range\n"
           "  cal <ref_pF>   calibrate current range vs known cap (e.g. 'cal 1000')\n"
           "  cal1/cal2 <ref_pF>  two-point K+T0 | cal? table | h help\n\n",
           RANGES[range_idx].label);

    char line[64];
    int li = 0;
    uint8_t b[1];
    while (true) {
        esp_task_wdt_reset();
        if (uart_read_bytes(UART_NUM_0, b, 1, pdMS_TO_TICKS(100)) <= 0) continue;
        char c = (char)b[0];
        if (c == '\r') continue;
        if (c != '\n') { if (li < (int)sizeof(line) - 1) line[li++] = c; continue; }
        line[li] = '\0';
        li = 0;
        if (line[0] == '\0') continue;

        if (line[0] >= '0' && line[0] <= '3' && line[1] == '\0') {
            range_idx = line[0] - '0';
            bool was = osc_running;
            dbg_stop();
            select_mux_channel(RANGES[range_idx].mux_channel);
            printf(">> range=%s (K=%.5f %s=%.2fus %s%s)\n", RANGES[range_idx].label,
                   osc_k((uint8_t)range_idx),
                   osc_has_t0((uint8_t)range_idx) ? "T0" : "delay",
                   osc_has_t0((uint8_t)range_idx) ? osc_t0((uint8_t)range_idx)
                                                  : osc_delay((uint8_t)range_idx),
                   g_osc_cal[range_idx].valid ? "cal" : "default",
                   osc_has_t0((uint8_t)range_idx) ? " tared" : "");
            if (was) dbg_start();
        } else if (!strcmp(line, "g")) {
            dbg_start(); printf(">> STARTED (drive=%d)\n", gpio_get_level(DRIVE_PIN));
        } else if (!strcmp(line, "s")) {
            dbg_stop(); printf(">> STOPPED\n");
        } else if (!strcmp(line, "r")) {
            dbg_stop(); prepare_measurement(); dbg_start();
            printf(">> discharged+restarted\n");
        } else if (!strcmp(line, "p") || !strcmp(line, "?")) {
            dbg_print_state(range_idx);
        } else if (!strncmp(line, "probe", 5)) {
            // Accept "probe3", "probe 3", "probe  3" etc.: scan for the first
            // digit anywhere after the "probe" keyword.
            int rr = range_idx;
            for (int i = 5; line[i] != '\0'; ++i) {
                if (line[i] >= '0' && line[i] <= '3') { rr = line[i] - '0'; break; }
            }
            dbg_probe_range(rr);
        } else if (!strcmp(line, "zero")) {
            dbg_tare(range_idx);
        } else if (!strcmp(line, "zeroall")) {
            dbg_tare(-1);
        } else if (!strncmp(line, "cal?", 4)) {
            printf("\n--- OSC calibration ---\n");
            for (int i = 0; i < RANGE_COUNT; ++i) {
                printf("  %-7s K=%.5f  T0=%.2f us %-9s delay=%.2f us  %s\n",
                       RANGES[i].label, g_osc_cal[i].k, g_osc_cal[i].t0_us,
                       g_osc_cal[i].has_t0 ? "(tared)" : "(no tare)",
                       g_osc_cal[i].delay_us,
                       g_osc_cal[i].valid ? "calibrated" : "default");
            }
            printf("-----------------------\n\n");
        } else if (!strncmp(line, "cal1", 4) || !strncmp(line, "cal2", 4)) {
            double ref_pf = atof(line + 4);
            if (ref_pf <= 0.0) {
                printf(">> usage: %s <ref_pF>\n", line);
            } else {
                dbg_calibrate(range_idx, line, ref_pf);
            }
        } else if (!strncmp(line, "cal", 3)) {
            double ref_pf = atof(line + 3);
            if (ref_pf <= 0.0) {
                printf(">> usage: cal <ref_pF>   (one-point K; or cal1/cal2 for two-point K+delay)\n");
            } else {
                dbg_calibrate(range_idx, line, ref_pf);
            }
        } else if (!strcmp(line, "h")) {
            printf("0-3 range | g start | s stop | r restart | p state\n"
                   "probe <0-3>  connectivity test: drive node + watch V_cap charge\n"
                   "zero  tare T0 with socket EMPTY (removes parasitic C) | zeroall all ranges\n"
                   "cal <pF>  one-point K (uses T0 if tared)\n"
                   "cal1 <pF> then cal2 <pF>  two-point K+T0 (use 2 different refs)\n"
                   "cal? show table | h help\n");
        } else {
            printf(">> unknown '%s' (h for help)\n", line);
        }
    }
}

#else  // !OSC_DEBUG_MODE —— normal fused measurement

void app_main(void)
{
    // NVS for persisted oscillator calibration.
    esp_err_t nvs_err = nvs_flash_init();
    if (nvs_err == ESP_ERR_NVS_NO_FREE_PAGES || nvs_err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        nvs_flash_erase();
        nvs_err = nvs_flash_init();
    }
    if (nvs_err != ESP_OK) ESP_LOGW(TAG, "NVS init failed: %s", esp_err_to_name(nvs_err));

    system_hw_init();
    osc_cal_load();
    ESP_LOGI(TAG, "ESP32 fusion capacitance meter ready (multi-range ADC + OSC)");
    for (int i = 0; i < RANGE_COUNT; ++i) {
        if (g_osc_cal[i].valid || g_osc_cal[i].has_t0) {
            ESP_LOGI(TAG, "  %s: K=%.5f %s=%.2f us (%s%s)",
                     RANGES[i].label, g_osc_cal[i].k,
                     g_osc_cal[i].has_t0 ? "T0" : "delay",
                     g_osc_cal[i].has_t0 ? g_osc_cal[i].t0_us : g_osc_cal[i].delay_us,
                     g_osc_cal[i].valid ? "calibrated" : "default K",
                     g_osc_cal[i].has_t0 ? ", tared" : "");
        }
    }

    // A full measurement cycle can take tens of seconds (large DUTs on the
    // high-resistance ranges), so add the main task to the task watchdog with
    // a generous timeout and reset it inside the long measurement loops.
    esp_task_wdt_config_t wdt_cfg = {
        .timeout_ms = 60000,
        .idle_core_mask = (1 << portNUM_PROCESSORS) - 1,
        .trigger_panic = false,
    };
    esp_task_wdt_reconfigure(&wdt_cfg);
    esp_task_wdt_add(NULL); // subscribe the current (main) task

    while (true) {
        fusion_t result = measure_capacitance_autoranged();
        log_result(&result);
        esp_task_wdt_reset();
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}
#endif // OSC_DEBUG_MODE
