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
#include "driver/rmt_encoder.h"
#include "driver/rmt_tx.h"
#include "driver/uart.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_attr.h"
#include "esp_err.h"
#include "esp_log.h"
#include "esp_rom_sys.h"
#include "esp_system.h"
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

// Per-sample ADC oversampling on the slow (high-R) ranges.  These ranges have a
// long τ, so averaging a few conversions per stored point costs little time but
// materially reduces ADC white noise and improves the τ fit.  Fast ranges use a
// single reading (extra conversions would smear a short τ).
#define ADC_POINT_AVG 4

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
// ---------------------------------------------------------------------------
// Board component values (MEASURED on this unit, not the nominal BOM values)
// ---------------------------------------------------------------------------
// These feed the same calibration/measurement math as the runtime reference
// calibration, so using the measured parts removes a systematic error before
// any reference cap is ever fitted.  A per-unit NVS override (namespace
// "board_cal") can supersede any of them without a reflash; see
// board_cal_load() / board_cal_save() / board_cal_reset() below.
//
// C_block sits in series with the DUT on the AC measurement path.  On this
// board it is a 936 uF electrolytic with a 67.8 nF ceramic HF bypass placed
// ACROSS it (parallel), so the DUT sees the parallel sum in series.  The
// bypass is the part that actually carries the fast oscillator edges, so it is
// kept as its own constant even though it vanishes beside the electrolytic.
// C_eq = C_b*C_d/(C_b+C_d)  =>  C_d = C_eq*C_b/(C_b-C_eq).  Correcting removes
// the growing underestimate for DUTs approaching C_block (per schematic note).
#define C_BLOCK_ELEC_F 936.0e-6   // measured electrolytic (nominal 1000 uF)
#define C_BLOCK_HF_F   67.8e-9    // measured HF bypass     (nominal 100 nF)
#define C_BLOCK_F      (C_BLOCK_ELEC_F + C_BLOCK_HF_F)

// "RES bank" — the four range resistors, in RANGES[] index order (measured).
#define RES_100_OHM   98.9        // nominal 100 Ω
#define RES_1K_OHM    993.6       // nominal 1 kΩ
#define RES_100K_OHM  98.6e3      // nominal 100 kΩ
#define RES_1M_OHM    1.01e6      // nominal 1 MΩ

// "Rblock" — DC bias injection resistor V_BIAS → N_DUT (stiff for DC, open for
// AC, so it holds the bias without loading the measurement).
#define R_BIAS_OHM    4.8e6       // nominal 4.7 MΩ

#define RANGE_COUNT 4
#define PROBE_MIN_VALID_US 200 // probe on a "slow" range trusts τ ≥ this
#define MAX_SAMPLES 12         // 4 ADC + probe + best OSC + alt OSC + headroom

#define PRECHARGE_HOLD_MS 2000
#define DISCHARGE_HOLD_MS 2000
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
#define OSC_MIN_F_HZ 10.0

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
//   r = isolate+restart   p/? = dump live pin/edge/freq state   h = help
// Probe GPIO14 (LM393 out) and GPIO16 (drive) on the scope.  Set back to 0 for
// normal fused measurement.  (Can also be forced with -DOSC_DEBUG_MODE=1.)
#ifndef OSC_DEBUG_MODE
#define OSC_DEBUG_MODE 0
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
    double fit_rmse_mv; // ADC: voltage-domain RMS residual of the fit (mV)
    double tau_unc_us;  // ADC: 1-sigma standard error of τ (us; <0 = unknown)
    double v_inf_mv;    // ADC: asymptote used/fitted for this sample (mV)
    double freq_hz;     // OSC only
    bool suspicious;    // timing/health looks wrong (down-weighted, still usable)
} sample_t;

// One entry of the fusion breakdown, for the dashboard's fusion strip.  Kept
// in file-scope statics (single measurement task) so fusion_t stays small and
// can still be returned by value without bloating the call stack.
typedef struct {
    uint8_t range_idx;
    uint8_t method;          // method_t
    double  c_f;             // reconstructed DUT capacitance (F)
    double  c_eq_f;          // series-equivalent the circuit saw (F)
    double  q;               // physics quality 0..1
    double  w;               // weight actually used in the weighted average
    double  r2;              // ADC only: exponential-fit R² (0 for OSC)
    bool    kept;            // passed the fusion median gate
} fusion_contrib_t;

#define FUSION_CONTRIB_MAX MAX_SAMPLES

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
    double method_mismatch_ratio; // hi/lo of the per-method estimates (NAN if one method)
    double quality;         // fused quality: mean quality of the post-gate population
    int raw_samples;        // total valid samples collected
    // --- fusion-breakdown telemetry (for the dashboard) ---
    double median_f;        // median of the pre-gate population (F), 0 if none
    int n_kept;             // valid+plausible samples entering the gate
    int n_gated;            // of those, rejected by the median gate
    double c_min_f;         // min / max of the KEPT population (F)
    double c_max_f;
} fusion_t;

// Fusion breakdown, filled by fuse_samples() and read by evt_fuse().
static fusion_contrib_t g_fusion_contrib[FUSION_CONTRIB_MAX];
static int g_fusion_n_contrib = 0;

// Per-cycle autoranging decision snapshot, filled by the orchestrator and read
// by evt_sweep() so the dashboard can show WHY each range/method was used.
typedef struct {
    bool   valid;                 // a sweep event is meaningful for this cycle
    bool   locked;                // locked-range mode instead of autoranging
    int    lock_range;            // range index when locked (-1 otherwise)
    bool   have_rough;            // probe produced a usable rough estimate
    double rough_f;               // rough capacitance from the probe (F)
    bool   sub_nf;                // rough C below the ADC sub-nF gate
    bool   saturated;             // fastest range saturated -> 100 kΩ sub used
    bool   adc_sub;               // the 100 kΩ saturation sub-measurement ran
    int    osc_best_range;        // nominated oscillator range (-1 = none)
    bool   adc_tried[RANGE_COUNT];
} sweep_info_t;
static sweep_info_t g_sweep;

// System-health counters for evt_stat().
static uint32_t g_cycle_count = 0;
static uint32_t g_last_cycle_ms = 0;

// ---------------------------------------------------------------------------
// Range table — note: on the schematic the 1 MΩ channel shares the mux with
// the 100 nF HF-bypass branch; keep the channel numbering used in production.
// resistance_ohms is the *measured* range resistor (RES_* defaults above); an
// NVS board_cal override can replace it per unit, so this table is non-const.
// ---------------------------------------------------------------------------
static range_config_t RANGES[RANGE_COUNT] = {
    {2, RES_100_OHM,   "100 Ω"},
    {1, RES_1K_OHM,    "1 kΩ"},
    {0, RES_100K_OHM,  "100 kΩ"},
    {3, RES_1M_OHM,    "1 MΩ"},
};

// Effective board values: start from the compiled defaults and let a per-unit
// NVS copy override them.  RANGES[] is non-const so a stored range-resistor
// override is seen everywhere the resistance is read.
static double g_c_block_f  = C_BLOCK_F;
static double g_r_bias_ohm = R_BIAS_OHM;
static bool   g_board_cal_overridden = false;  // true if NVS supplied any value

static inline double c_block_f(void)  { return g_c_block_f; }
static inline double r_bias_ohm(void) { return g_r_bias_ohm; }

#define BOARD_CAL_NVS_NS "board_cal"

// Load per-unit board constants from NVS (if present).  Absent keys leave the
// compiled #defines in place, so a board that was never re-measured behaves
// exactly as the defaults.
static void board_cal_load(void)
{
    nvs_handle_t h;
    if (nvs_open(BOARD_CAL_NVS_NS, NVS_READONLY, &h) != ESP_OK) return;
    int64_t v = 0;
    if (nvs_get_i64(h, "cblk",  &v) == ESP_OK) { g_c_block_f  = (double)v / 1e15; g_board_cal_overridden = true; } // fF
    if (nvs_get_i64(h, "rbias", &v) == ESP_OK) { g_r_bias_ohm = (double)v / 1e3;  g_board_cal_overridden = true; } // mΩ
    for (int i = 0; i < RANGE_COUNT; ++i) {
        char key[8];
        snprintf(key, sizeof(key), "r%d", i);
        if (nvs_get_i64(h, key, &v) == ESP_OK) {
            RANGES[i].resistance_ohms = (double)v / 1e3;   // mΩ
            g_board_cal_overridden = true;
        }
    }
    nvs_close(h);
}

static esp_err_t board_cal_save(void)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(BOARD_CAL_NVS_NS, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    nvs_set_i64(h, "cblk",  (int64_t)(g_c_block_f * 1e15));
    nvs_set_i64(h, "rbias", (int64_t)(g_r_bias_ohm * 1e3));
    for (int i = 0; i < RANGE_COUNT; ++i) {
        char key[8];
        snprintf(key, sizeof(key), "r%d", i);
        nvs_set_i64(h, key, (int64_t)(RANGES[i].resistance_ohms * 1e3));
    }
    err = nvs_commit(h);
    nvs_close(h);
    return err;
}

// Restore every board constant to its compiled default and drop the NVS copy.
static void board_cal_reset(void)
{
    g_c_block_f  = C_BLOCK_F;
    g_r_bias_ohm = R_BIAS_OHM;
    RANGES[0].resistance_ohms = RES_100_OHM;
    RANGES[1].resistance_ohms = RES_1K_OHM;
    RANGES[2].resistance_ohms = RES_100K_OHM;
    RANGES[3].resistance_ohms = RES_1M_OHM;
    g_board_cal_overridden = false;
    nvs_handle_t h;
    if (nvs_open(BOARD_CAL_NVS_NS, NVS_READWRITE, &h) == ESP_OK) {
        nvs_erase_all(h);
        nvs_commit(h);
        nvs_close(h);
    }
}

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

// ---------------------------------------------------------------------------
// Per-range ADC (RC-step) calibration
// ---------------------------------------------------------------------------
// The RC-step measures τ = R_eff·(C_dut + C0), where R_eff = R_nom + R_series
// (buffer output impedance + mux Ron + wiring).  On the 100 Ω / 1 kΩ ranges
// R_series is a large fraction of R_nom (tens of ohms), so without calibration
// C is over-read by (R_nom+R_series)/R_nom.  We solve and store a measured
// R_eff and offset C0 per range from known reference capacitors, using the
// exact same τ estimator the runtime uses.  (The oscillator absorbs R_series
// in its calibrated K; the ADC previously had no equivalent.)
typedef struct {
    double r_eff_ohm;   // measured R_nom + R_series
    double c0_f;        // node offset capacitance
    bool   valid;
} adc_cal_t;

static adc_cal_t g_adc_cal[RANGE_COUNT] = {
    {0.0, 0.0, false}, {0.0, 0.0, false}, {0.0, 0.0, false}, {0.0, 0.0, false},
};

static inline bool   adc_cal_valid(uint8_t i) { return g_adc_cal[i].valid; }
static inline double adc_r_eff(uint8_t i)     { return g_adc_cal[i].r_eff_ohm; }
static inline double adc_c0(uint8_t i)        { return g_adc_cal[i].c0_f; }

// The oscillator and ADC share the V_cap node, so the oscillator tare T0 gives
// a good estimate of the ADC node stray when no ADC offset has been solved.
static double node_stray_estimate_f(uint8_t i)
{
    double k = osc_k(i);
    double r = RANGES[i].resistance_ohms;
    if (osc_has_t0(i) && k > 0.0 && r > 0.0 && osc_t0(i) > 0.0)
        return (osc_t0(i) * 1e-6) / (k * r);
    return STRAY_CAPACITANCE_F;
}

#define ADC_CAL_NVS_NS "adc_cal"

static void adc_cal_load(void)
{
    nvs_handle_t h;
    if (nvs_open(ADC_CAL_NVS_NS, NVS_READONLY, &h) != ESP_OK) return;
    for (int i = 0; i < RANGE_COUNT; ++i) {
        char key[8];
        int64_t v = 0;
        snprintf(key, sizeof(key), "r%d", i);
        if (nvs_get_i64(h, key, &v) == ESP_OK) g_adc_cal[i].r_eff_ohm = (double)v / 1e3;   // mΩ
        snprintf(key, sizeof(key), "c%d", i);
        if (nvs_get_i64(h, key, &v) == ESP_OK) g_adc_cal[i].c0_f = (double)v / 1e15;       // fF
        snprintf(key, sizeof(key), "v%d", i);
        uint8_t valid = 0;
        if (nvs_get_u8(h, key, &valid) == ESP_OK) g_adc_cal[i].valid = (valid != 0);
    }
    nvs_close(h);
}

static esp_err_t adc_cal_save(void)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(ADC_CAL_NVS_NS, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    for (int i = 0; i < RANGE_COUNT; ++i) {
        char key[8];
        snprintf(key, sizeof(key), "r%d", i);
        nvs_set_i64(h, key, (int64_t)(g_adc_cal[i].r_eff_ohm * 1e3));
        snprintf(key, sizeof(key), "c%d", i);
        nvs_set_i64(h, key, (int64_t)(g_adc_cal[i].c0_f * 1e15));
        snprintf(key, sizeof(key), "v%d", i);
        nvs_set_u8(h, key, g_adc_cal[i].valid ? 1 : 0);
    }
    err = nvs_commit(h);
    nvs_close(h);
    return err;
}

// Solve the two-point model τ = R_eff·C_eq, where C_eq is the SAME
// series-equivalent the runtime measures and inverts:
//      C_eq = cblock_forward(C_ref) = C_block·C_ref/(C_block + C_ref)
//      R_eff = (τ1 − τ2)/(C_eq1 − C_eq2),   C0 = τ1/R_eff − C_eq1
// Applying the C_block transform here is mandatory.  The measurement inverts it
// (cblock_invert), so a solve that used the RAW reference capacitance would be a
// different model: it stores an R_eff scaled by cblock_forward(C)/C (≈0.72 for a
// 360 µF reference) and a bogus µF-scale C0 that then fails the sanity bound.
// The oscillator solvers apply the identical transform; this mirrors them.
// Returns the EFFECTIVE R_eff (chain ∥ leakage); the caller converts it back to
// the stored chain value with adc_chain_from_eff() so the runtime leak fold in
// adc_effective_r() reproduces it exactly.
static double cblock_forward(double c_dut);   // defined below

static bool adc_cal_solve_two(double tau1_us, double c1_f,
                              double tau2_us, double c2_f,
                              double *r_eff, double *c0_f)
{
    if (tau1_us <= 0.0 || tau2_us <= 0.0) return false;
    double ceq1 = cblock_forward(c1_f);
    double ceq2 = cblock_forward(c2_f);
    if (ceq1 <= 0.0 || ceq2 <= 0.0) return false;     // ref at/above C_block
    double dc = ceq1 - ceq2;
    if (fabs(dc) < 1e-18) return false;               // refs too similar
    double r = ((tau1_us - tau2_us) * 1e-6) / dc;
    if (r <= 1.0 || r > 1e7) return false;            // sane ohms
    double off = (tau1_us * 1e-6) / r - ceq1;         // node offset (pF–nF)
    if (off < -1e-7 || off > 1e-6) return false;      // sane −0.1..1 µF
    *r_eff = r;
    *c0_f = off;
    return true;
}

// Series-equivalent of a DUT *alone* (no stray).  The oscillator's measured
// open-node tare T0 absorbs the parasitic capacitance, so calibration works in
// DUT deltas above the open baseline and must NOT add STRAY here.  Adding the
// old 12 pF constant was the bug that made a 100 pF reference imply ~236 pF and
// pushed the solved K ~2.1× too large.  This MUST stay consistent with the
// measurement model (cblock_invert).
static double cblock_forward(double c_dut)
{
    double cb = c_block_f();
    if (c_dut >= cb) return -1.0;                   // beyond singularity
    return (cb * c_dut) / (cb + c_dut);
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
    double k = (eff * 1e-6) / (RANGES[range_idx].resistance_ohms * c_eq);
    // Same sane-geometry bound the two-point solver enforces: a K outside this
    // range means a bad reference or a saturated/failed capture, not physics.
    if (k <= 0.01 || k > 2.0) return -1.0;
    return k;
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
static volatile uint32_t osc_last_edge_us = 0;   // ISR rate-limit timestamp

// Software-loop watchdog.  If the LM393 toggles faster than this the ISR is
// saturating the core (e.g. a few pF on the 100 Ω / 1 kΩ ranges).  The ISR then
// shuts the loop down, so the device can never freeze; the affected sample is
// simply rejected as "too fast".  This is a frequency guard, not a range ban —
// a large cap on 100 Ω / 1 kΩ runs slowly and is measured normally.
#define OSC_MIN_EDGE_INTERVAL_US 3

// Start the software-in-the-loop oscillator: reset the rate limiter and prime
// the drive with the comparator's current level.
static void osc_loop_start(void)
{
    osc_last_edge_us = 0;
    // Re-arm the edge interrupt (the ISR disables it whenever the loop is off so
    // a comparator that keeps toggling cannot load the CPU with no-op ISRs).
    gpio_intr_enable(LM393_OUT_PIN);
    osc_running = true;
    gpio_set_level(DRIVE_PIN, (uint32_t)gpio_get_level(LM393_OUT_PIN));
}

static void IRAM_ATTR lm393_isr_handler(void *arg)
{
    (void)arg;
    if (!osc_running) return;   // loop off; cheap early-out

    // Rate limit: too many edges/sec -> stop before the CPU is overwhelmed.
    // Disabling the edge interrupt here (while measuring, cache enabled) stops a
    // self-sustained comparator from flooding this ISR after the DUT is unplugged.
    uint32_t now32 = (uint32_t)esp_timer_get_time();
    if (osc_last_edge_us != 0 &&
        (uint32_t)(now32 - osc_last_edge_us) < OSC_MIN_EDGE_INTERVAL_US) {
        osc_running = false;
        gpio_intr_disable(LM393_OUT_PIN);
        gpio_set_level(DRIVE_PIN, 0);
        return;
    }
    osc_last_edge_us = now32;

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

// ---------------------------------------------------------------------------
// Interactive / telemetry state (shared by the debug console and normal mode)
// ---------------------------------------------------------------------------
// Declared early: the measurement loops below poll these to abort promptly when
// an exclusive command (zero/cal/probe) arrives mid-cycle.
static bool g_stream = false;        // emit @@EVT machine-readable events
static bool g_stream_curve = false;  // include the full ADC charge curve
static bool g_run = false;           // normal mode: idle until 'start' (safe boot)
static int  g_range_lock = -1;       // normal mode: -1 = auto, else range index
static bool g_single_shot = false;   // measure one cycle then stop
static volatile bool g_abort_cycle = false;
static volatile bool g_measuring = false;
static uint8_t g_console_range = 2;  // range used by cal/probe/status
static char g_pending_cmd[64];       // exclusive command queued during a cycle

// Front-end safety state (reference state machine).  Reported to the dashboard
// so the operator always knows whether the DUT is biased, isolated or moving.
typedef enum {
    FE_IDLE = 0,     // all SSRs off, drive low — safe to touch the DUT
    FE_PRECHARGE,    // SSR1+SSR3 on: charging C_block/N_DUT at bias
    FE_PRECHARGED,   // isolated, N_DUT still biased — do NOT remove the DUT
    FE_MEASURING,    // autoranging
    FE_DISCHARGE,    // SSR2 on: DUT/C_block bleeding to GND
} fe_state_t;
static fe_state_t g_fe_state = FE_IDLE;
// Energy-state flags for the dashboard's charged/discharged indicator.  Both
// false means "unknown" (e.g. just booted, never charged or discharged here).
static bool g_fe_charged = false;      // N_DUT/C_block currently at bias
static bool g_fe_discharged = false;   // bled to GND since the last charge

// Automation flags (dashboard-controlled, default OFF => the operator drives the
// front-end explicitly).  auto-precharge makes the measurement path re-establish
// the DC bias before every reading; auto-discharge bleeds the node when a
// measurement session ends.  Neither ever opens SSR2 during a live measurement.
static bool g_auto_precharge = false;
static bool g_auto_discharge = false;
static bool g_fe_finish_pending = false; // deferred finish after a 'stop' aborts

// Wait until V_cap falls below V_START_MV (100 kΩ and 1 MΩ ranges bleed charge
// slowly, so the budget scales with the range resistor).
static bool wait_for_start_threshold(uint8_t range_idx)
{
    // Bleed V_cap below V_START before the timed charge.  The RC here is
    // (R_range+R_series)·C_eq, so a large DUT on the LOW ranges needs far more
    // than the old 100 ms + 2·R µs: a 360 µF DUT (C_eq ≈ 260 µF) takes ~60 ms on
    // 100 Ω but ~0.6 s on 1 kΩ, which the old budget rejected outright.  Give the
    // 100 Ω / 1 kΩ ranges a floor that covers the large electrolytics they exist
    // for; the loop still returns the instant the threshold is crossed, so this
    // costs nothing in the normal case.
    int64_t budget_us = 100000LL + (int64_t)(RANGES[range_idx].resistance_ohms * 2.0);
    if (range_idx <= 1 && budget_us < 3000000LL) budget_us = 3000000LL; // 3 s
    int64_t t0 = esp_timer_get_time();
    while ((esp_timer_get_time() - t0) < budget_us) {
        if (g_abort_cycle) return false;   // service an exclusive command promptly
        int mv = adc_read_avg_mv(2);
        if (mv >= 0 && mv <= V_START_MV) return true;
        esp_rom_delay_us(200);
    }
    return false;
}

// Defined further down but needed by the measurement loops (abort-on-command).
static void service_console(void);
static void safe_delay_ms(uint32_t ms);
static void fe_set(fe_state_t s);

// Prepare the front-end for a measurement WITHOUT disturbing the DC bias.
// SSR2 (the discharge switch) is NEVER closed here: closing it would dump the
// precharged C_block/C_dut and the DUT would no longer be measured at V_BIAS.
// The MCU-side node V_cap is reset to ~0 V purely by driving DRIVE low (the
// caller then waits for the start threshold); that does not discharge the DUT
// because C_block blocks DC.
//
// With auto-precharge armed we (re)assert the bias in the reference order
// (PRE-CHARGE with SSR2 OFF -> ISOLATE).  Otherwise we simply isolate and let
// the operator's manual precharge hold.
static void prepare_measurement(void)
{
    gpio_set_level(DRIVE_PIN, 0);
    gpio_set_level(SSR_S2_PIN, 0);        // hold the bias: never discharge here
    gpio_set_level(VBIAS_PIN, 0);

    if (g_auto_precharge) {
        gpio_set_level(SSR_S1_S3_PIN, 1); // SSR1 precharge + SSR3 V_cap clamp
        safe_delay_ms(PRECHARGE_HOLD_MS);
        gpio_set_level(SSR_S1_S3_PIN, 0); // ISOLATE; R_bias holds the bias
    } else {
        gpio_set_level(SSR_S1_S3_PIN, 0); // isolated: keep the existing bias
    }
    esp_rom_delay_us(ISOLATION_DELAY_US);
}

// ---------------------------------------------------------------------------
// Front-end safety lifecycle (reference state machine:
//   IDLE -> DISCHARGE -> PRE-CHARGE -> ISOLATE -> ... measure ... -> DISCHARGE
//   -> IDLE)
//
// SSR1 (PRE-CHARGE, V_BIAS -> 10 Ω -> N_DUT) and SSR3 (V_cap clamp, V_cap ->
// 1 Ω -> GND) are driven by the SAME pin (SSR_S1_S3_PIN).  Enabling one always
// enables the other: that is the hardware interlock that prevents V_cap from
// rising while N_DUT is charged.  SSR2 (DISCHARGE, N_DUT -> 100 Ω -> GND) is
// the only DUT ground path.  Never energise SSR1 unless SSR3 is on — here that
// is automatic.
// ---------------------------------------------------------------------------

// IDLE: every SSR off, drive low.  Safe to insert/remove a DUT.
static void front_end_idle(void)
{
    gpio_set_level(DRIVE_PIN, 0);
    gpio_set_level(SSR_S2_PIN, 0);
    gpio_set_level(SSR_S1_S3_PIN, 0);
    gpio_set_level(VBIAS_PIN, 0);
}

// PRE-CHARGE -> ISOLATE: SSR1+SSR3 charge N_DUT toward V_BIAS through 10 Ω
// while SSR3 clamps V_cap to GND through 1 Ω.  SSR2 stays OFF so the 100 Ω
// discharge path does not fight the pre-charge.  Releasing SSR1/SSR3 leaves
// N_DUT held at bias through the 1 MΩ R_bias and V_cap free to move.
static void front_end_precharge(void)
{
    gpio_set_level(DRIVE_PIN, 0);
    gpio_set_level(SSR_S2_PIN, 0);        // no discharge during pre-charge
    gpio_set_level(SSR_S1_S3_PIN, 1);     // SSR1 (charge) + SSR3 (V_cap clamp)
    safe_delay_ms(PRECHARGE_HOLD_MS);
    gpio_set_level(SSR_S1_S3_PIN, 0);     // ISOLATE
    esp_rom_delay_us(ISOLATION_DELAY_US);
}

// DISCHARGE: SSR2 pulls N_DUT to GND through 100 Ω; the series C_block is
// drained with it (the V_cap side is caught by the BAT54S clamp).  Then IDLE.
static void front_end_discharge(void)
{
    gpio_set_level(DRIVE_PIN, 0);
    gpio_set_level(SSR_S1_S3_PIN, 0);
    gpio_set_level(SSR_S2_PIN, 1);
    safe_delay_ms(DISCHARGE_HOLD_MS);
    gpio_set_level(SSR_S2_PIN, 0);
    gpio_set_level(VBIAS_PIN, 0);
}

// End-of-session front-end state.  With auto-discharge armed we bleed the node
// for safety; otherwise we isolate and leave N_DUT/C_block at their bias so the
// next measurement starts from the same operating point (manual discharge is
// required before removing the DUT).
static void front_end_finish(void)
{
    if (g_auto_discharge) {
        fe_set(FE_DISCHARGE);
        front_end_discharge();
        g_fe_charged = false;
        g_fe_discharged = true;
        fe_set(FE_IDLE);                 // bled to GND: safe
    } else {
        front_end_idle();                // all SSRs off...
        // ...but with SSR2 off the node is only isolated, NOT bled: the DUT and
        // C_block stay at V_BIAS through R_bias.  Report that persistent charged
        // state (FE_PRECHARGED) instead of a safe-looking IDLE, so the UI keeps
        // warning and the status LED stays red until an explicit discharge.
        fe_set(g_fe_charged ? FE_PRECHARGED : FE_IDLE);
    }
}

// ---------------------------------------------------------------------------
// Onboard status LED
// ---------------------------------------------------------------------------
// The Freenove ESP32-S3 WROOM carries a single addressable WS2812 (GRB) on
// GPIO48.  It is driven from an RMT TX channel using the built-in copy encoder:
// we precompute the 24 bit-slots + reset as rmt_symbol_word_t and let the
// peripheral clock them out, so the CPU never bit-bangs.  A small task owns the
// animation; the measurement/console code only updates the mode.
#ifndef STATUS_LED_GPIO
#define STATUS_LED_GPIO 48
#endif
#ifndef STATUS_LED_ENABLE
#define STATUS_LED_ENABLE 1
#endif

#define LED_RMT_RES_HZ  10000000   // 10 MHz -> 0.1 us per RMT tick
#define LED_T0H 3                  // 0.3 us high
#define LED_T0L 9                  // 0.9 us low
#define LED_T1H 9                  // 0.9 us high
#define LED_T1L 3                  // 0.3 us low
#define LED_RESET_TICKS 600        // 60 us low: latch / reset

typedef enum {
    LED_MODE_OFF = 0,
    LED_MODE_IDLE,       // all off / safe to touch              -> calm blue breathe
    LED_MODE_PRECHARGE,  // charging C_block/N_DUT               -> amber pulse
    LED_MODE_BIASED,     // isolated, N_DUT still biased         -> steady red
    LED_MODE_MEASURING,  // autoranging (colour = active range)  -> range token breathe
    LED_MODE_DISCHARGE,  // bleeding to GND                      -> green pulse
    LED_MODE_FAULT,      // reserved for a hard fault            -> red blink
} led_mode_t;

static rmt_channel_handle_t s_led_chan = NULL;
static rmt_encoder_handle_t s_led_encoder = NULL;
static volatile bool       s_led_ready = false;
static volatile bool       s_led_auto = true;
static volatile led_mode_t s_led_mode = LED_MODE_IDLE;
static volatile int        s_led_range = -1;
static volatile uint8_t    s_led_man_r = 0, s_led_man_g = 0, s_led_man_b = 0;
static volatile int        s_led_flash = -1;          // -1 none, 0 good, 1 warn, 2 bad
static volatile int64_t    s_led_flash_until_us = 0;
static volatile bool       s_led_tx_done = true;      // previous frame finished
// Static (not stack) so a transaction the RMT engine is still clocking out can
// never reference a stale stack frame.
static rmt_symbol_word_t   s_led_sym[25];

// RMT TX-done callback (IRAM).  We deliberately do NOT block on
// rmt_tx_wait_all_done(): during an oscillator measurement the LM393 edge ISR
// runs at up to ~166 kHz and can delay the RMT ISR, which made the blocking wait
// time out and spam the console.  Instead the task only starts a new frame when
// the previous one has completed, and holds the last colour otherwise.
static bool IRAM_ATTR led_tx_done_cb(rmt_channel_handle_t ch,
                                     const rmt_tx_done_event_data_t *edata, void *user_ctx)
{
    (void)ch; (void)edata; (void)user_ctx;
    s_led_tx_done = true;
    return false;
}

static void led_send(uint8_t r, uint8_t g, uint8_t b)
{
    if (!s_led_ready) return;
    // Only ever one frame in flight: if the previous frame has not completed we
    // simply hold the last colour.  Never queue a second transaction (overlapping
    // transactions are what wedged the RMT engine before).
    if (!s_led_tx_done) return;

    uint32_t grb = ((uint32_t)g << 16) | ((uint32_t)r << 8) | (uint32_t)b;  // WS2812 GRB
    for (int i = 0; i < 24; ++i) {
        int bit = (grb >> (23 - i)) & 1;
        s_led_sym[i].level0 = 1;
        s_led_sym[i].duration0 = bit ? LED_T1H : LED_T0H;
        s_led_sym[i].level1 = 0;
        s_led_sym[i].duration1 = bit ? LED_T1L : LED_T0L;
    }
    s_led_sym[24].level0 = 0; s_led_sym[24].duration0 = LED_RESET_TICKS;
    s_led_sym[24].level1 = 0; s_led_sym[24].duration1 = 0;
    rmt_transmit_config_t tx = { .loop_count = 0 };
    if (rmt_transmit(s_led_chan, s_led_encoder, s_led_sym, sizeof(s_led_sym), &tx) == ESP_OK) {
        s_led_tx_done = false;
    }
}

// Range colour tokens, deliberately matching the dashboard palette so the LED
// and the on-screen "active range" agree.
static void led_range_rgb(int r, uint8_t *rgb)
{
    switch (r) {
        case 0: rgb[0] = 200; rgb[1] = 60;  rgb[2] = 60;  break;  // 100 Ω  red
        case 1: rgb[0] = 210; rgb[1] = 150; rgb[2] = 40;  break;  // 1 kΩ  amber
        case 2: rgb[0] = 70;  rgb[1] = 130; rgb[2] = 220; break;  // 100 kΩ blue
        case 3: rgb[0] = 70;  rgb[1] = 200; rgb[2] = 120; break;  // 1 MΩ  green
        default: rgb[0] = 60; rgb[1] = 100; rgb[2] = 170; break;
    }
}

static void led_mode_rgb(led_mode_t m, int range, uint8_t *rgb)
{
    switch (m) {
        case LED_MODE_IDLE:      rgb[0] = 0;   rgb[1] = 40;  rgb[2] = 140; break;
        case LED_MODE_PRECHARGE: rgb[0] = 200; rgb[1] = 120; rgb[2] = 0;   break;
        case LED_MODE_BIASED:    rgb[0] = 180; rgb[1] = 0;   rgb[2] = 0;   break;
        case LED_MODE_MEASURING: led_range_rgb(range, rgb);                 break;
        case LED_MODE_DISCHARGE: rgb[0] = 0;   rgb[1] = 160; rgb[2] = 40;  break;
        case LED_MODE_FAULT:     rgb[0] = 220; rgb[1] = 0;   rgb[2] = 0;   break;
        default:                 rgb[0] = 0;   rgb[1] = 0;   rgb[2] = 0;   break;
    }
}

static bool status_led_rmt_init(void)
{
#if !STATUS_LED_ENABLE
    return false;
#else
    rmt_tx_channel_config_t tx_cfg = {
        .gpio_num = (gpio_num_t)STATUS_LED_GPIO,
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = LED_RMT_RES_HZ,
        // 64 symbols -> 2 HW blocks -> 48-symbol ping-pong halves, so a 25-symbol
        // WS2812 frame fits in a single half and needs no mid-frame threshold
        // interrupt to complete (only the final TX-done event).
        .mem_block_symbols = 64,
        .trans_queue_depth = 1,   // one frame at a time; overlap wedges the engine
        // Leave intr_priority = 0 (auto): forcing a high RMT interrupt preempted
        // the FreeRTOS tick and starved IDLE0 -> task WDT.
    };
    if (rmt_new_tx_channel(&tx_cfg, &s_led_chan) != ESP_OK) return false;
    rmt_tx_event_callbacks_t cbs = { .on_trans_done = led_tx_done_cb };
    rmt_tx_register_event_callbacks(s_led_chan, &cbs, NULL);
    rmt_copy_encoder_config_t enc_cfg;   // empty on this IDF (no config fields)
    if (rmt_new_copy_encoder(&enc_cfg, &s_led_encoder) != ESP_OK) return false;
    if (rmt_enable(s_led_chan) != ESP_OK) return false;
    return true;
#endif
}

static void status_led_task(void *arg)
{
    (void)arg;
    // Bring RMT up from THIS task so its interrupt is allocated on this core
    // (CPU1).  Keeping the LED task and its ISR entirely off CPU0 means the
    // status LED can never starve the measurement task, the FreeRTOS tick or
    // IDLE0 — the cause of the task-watchdog reset on CPU 0.
    if (!status_led_rmt_init()) {
        ESP_LOGW(TAG, "status LED: init failed (LED disabled)");
        vTaskDelete(NULL);
        return;
    }
    s_led_ready = true;
    ESP_LOGI(TAG, "status LED ready (WS2812 on GPIO%d, core %d)",
             STATUS_LED_GPIO, (int)xPortGetCoreID());

    // Boot flourish: R -> G -> B, then hand over to the live state machine.
    led_send(180, 0, 0);   vTaskDelay(pdMS_TO_TICKS(140));
    led_send(0, 180, 0);   vTaskDelay(pdMS_TO_TICKS(140));
    led_send(0, 0, 180);   vTaskDelay(pdMS_TO_TICKS(140));
    led_send(0, 0, 0);     vTaskDelay(pdMS_TO_TICKS(140));

    for (;;) {
        if (!s_led_auto) {                       // manual override (console 'led')
            led_send(s_led_man_r, s_led_man_g, s_led_man_b);
            vTaskDelay(pdMS_TO_TICKS(50));
            continue;
        }
        int64_t now = esp_timer_get_time();

        // A short result flash overrides the background state.
        if (s_led_flash >= 0) {
            if (now < s_led_flash_until_us) {
                if (s_led_flash == 0)      led_send(0, 200, 60);       // good  green
                else if (s_led_flash == 1) led_send(220, 150, 0);      // warn  amber
                else                       led_send(220, 40, 40);      // bad   red
                vTaskDelay(pdMS_TO_TICKS(30));
                continue;
            }
            s_led_flash = -1;
        }

        // Breathing envelope, ~1.6 s period.
        double phase = (double)(now % 1600000) / 1600000.0;
        double breathe = phase < 0.5 ? phase * 2.0 : (1.0 - phase) * 2.0;

        uint8_t rgb[3];
        led_mode_rgb(s_led_mode, s_led_range, rgb);
        double scale;
        if (s_led_mode == LED_MODE_BIASED) {
            scale = 0.85;                                   // steady: "do not touch"
        } else if (s_led_mode == LED_MODE_FAULT) {
            scale = (phase < 0.5) ? 1.0 : 0.0;              // blink
        } else {
            scale = 0.22 + 0.78 * breathe;                  // calm breathing
        }
        led_send((uint8_t)(rgb[0] * scale), (uint8_t)(rgb[1] * scale), (uint8_t)(rgb[2] * scale));
        vTaskDelay(pdMS_TO_TICKS(25));
    }
}

static void status_led_start(void)
{
#if STATUS_LED_ENABLE
    // Pinned to core 1, low priority: the LED (task + RMT ISR) must never
    // compete with the measurement loop on core 0.
    xTaskCreatePinnedToCore(status_led_task, "status_led", 4096, NULL, 1, NULL, 1);
#endif
}

// ---- setters used by the measurement / console code -----------------------
static void status_led_set_fe(fe_state_t s)
{
    switch (s) {
        // Even "idle" is red if the node is still charged: all SSRs off does not
        // mean discharged (R_bias holds the DUT at bias).  This keeps the LED
        // red after a stop when auto-discharge is OFF.
        case FE_IDLE:       s_led_mode = (g_fe_charged && !g_fe_discharged)
                                             ? LED_MODE_BIASED : LED_MODE_IDLE; break;
        case FE_PRECHARGE:  s_led_mode = LED_MODE_PRECHARGE; break;
        case FE_PRECHARGED: s_led_mode = LED_MODE_BIASED;    break;
        case FE_MEASURING:  s_led_mode = LED_MODE_MEASURING; break;
        case FE_DISCHARGE:  s_led_mode = LED_MODE_DISCHARGE; break;
    }
}
// Flash the fusion result: green (clean) / amber (warn) / red (rejected), and
// adopt the dominant contributing range as the next colour token.
static void status_led_report_result(const fusion_t *f)
{
    if (f->valid) {
        int r = -1;
        double best = -1.0;
        for (int i = 0; i < g_fusion_n_contrib; ++i) {
            const fusion_contrib_t *c = &g_fusion_contrib[i];
            if (c->kept && c->w > best) { best = c->w; r = c->range_idx; }
        }
        if (r >= 0) s_led_range = r;
        bool warn = (f->rel_spread > 0.05) || (f->quality < 0.02) || f->method_mismatch;
        s_led_flash = warn ? 1 : 0;
    } else {
        s_led_flash = 2;
    }
    s_led_flash_until_us = esp_timer_get_time() + 300000;  // 300 ms
}
static void status_led_set_auto(void) { s_led_auto = true; }
static void status_led_manual(uint8_t r, uint8_t g, uint8_t b)
{
    s_led_man_r = r; s_led_man_g = g; s_led_man_b = b; s_led_auto = false;
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
        .bitwidth = ADC_BITWIDTH_12,
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

    status_led_start();
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
// Recover (C_dut + C_stray) from the measured series-equivalent C_eq by
// inverting the C_block series combination.  This is the EXACT algebraic inverse
// of cblock_forward() — the transform every calibration solver applies
// UNCONDITIONALLY — so there must be no minimum-capacitance gate here: any gate
// would make calibration and measurement disagree for references/DUTs below it.
// Returns the total node capacitance, or a negative sentinel when C_eq is at/
// above the singularity (C_eq ≥ C_block makes the inversion non-physical).
// The caller must treat that as an out-of-range rejection, not a reading.
static double cblock_invert(double c_eq)
{
    double cb = c_block_f();
    if (c_eq >= 0.9 * cb) return -1.0;                  // at/past singularity
    return (c_eq * cb) / (cb - c_eq);                   // DUT + stray
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

// ---------------------------------------------------------------------------
// Interactive / telemetry state (shared by the debug console and normal mode)
// ---------------------------------------------------------------------------
// Machine-readable telemetry is emitted as single-line JSON after the "@@EVT "
// sentinel.  Emission happens from the single measurement/console task, so it
// never interleaves with ESP_LOG output.  Human log lines are untouched.
// (The interactive/telemetry state globals are declared earlier, before the
// measurement loops that consume them.)

// Print a double as JSON, emitting null for non-finite values (JSON has no NaN).
static void json_num(char *buf, size_t len, double v)
{
    if (isnan(v) || isinf(v)) snprintf(buf, len, "null");
    else snprintf(buf, len, "%.9g", v);
}

static void evt_boot(void)
{
    if (!g_stream) return;
    printf("@@EVT {\"t\":\"boot\",\"fw\":\"ESWCap\",\"ranges\":[");
    for (int i = 0; i < RANGE_COUNT; ++i) {
        if (i) printf(",");
        printf("{\"i\":%d,\"label\":\"%s\",\"r\":%.0f,\"mux\":%d,\"k\":%.6g,"
               "\"t0_us\":%.6g,\"has_t0\":%s,\"valid\":%s,"
               "\"adc_r_eff\":%.6g,\"adc_c0_f\":%.6g,\"adc_valid\":%s}",
               i, RANGES[i].label, RANGES[i].resistance_ohms, RANGES[i].mux_channel,
               g_osc_cal[i].k, g_osc_cal[i].t0_us,
               g_osc_cal[i].has_t0 ? "true" : "false",
               g_osc_cal[i].valid ? "true" : "false",
               g_adc_cal[i].r_eff_ohm, g_adc_cal[i].c0_f,
               g_adc_cal[i].valid ? "true" : "false");
    }
    printf("]}\n");
}

static void evt_cycle(const fusion_t *f)
{
    if (!g_stream) return;
    char adc[32], osc[32], mr[32];
    json_num(adc, sizeof(adc), f->adc_estimate);
    json_num(osc, sizeof(osc), f->osc_estimate);
    json_num(mr, sizeof(mr), f->method_mismatch_ratio);
    printf("@@EVT {\"t\":\"cycle\",\"ts_ms\":%lld,\"valid\":%s,\"c\":%.9g,"
           "\"spread\":%.6g,\"quality\":%.6g,\"weight\":%.6g,\"mismatch_ratio\":%s,"
           "\"n_adc\":%d,\"n_osc\":%d,\"raw\":%d,"
           "\"adc\":%s,\"osc\":%s,\"mismatch\":%s}\n",
           (long long)(esp_timer_get_time() / 1000), f->valid ? "true" : "false",
           f->capacitance_f, f->rel_spread, f->quality, f->total_weight, mr,
           f->n_adc, f->n_osc,
           f->raw_samples, adc, osc, f->method_mismatch ? "true" : "false");
}

static void evt_sample(const sample_t *s)
{
    if (!g_stream) return;
    double vinf = (s->method == METHOD_ADC_STEP)
                      ? (s->v_inf_mv > 0.0 ? s->v_inf_mv
                                           : (double)g_v_inf_cache[s->range_idx]) : -1.0;
    printf("@@EVT {\"t\":\"sample\",\"phase\":\"%s\",\"method\":\"%s\",\"range\":%d,"
           "\"label\":\"%s\",\"valid\":%s,\"plausible\":%s,\"c\":%.9g,\"c_eq\":%.9g,"
           "\"q\":%.6g,\"tau_us\":%.6g,\"freq\":%.6g,\"r2\":%.6g,\"vinf\":%.0f,"
           "\"rmse_mv\":%.6g,\"tau_unc_us\":%.6g}\n",
           g_phase, s->method == METHOD_ADC_STEP ? "adc" : "osc",
           s->range_idx, RANGES[s->range_idx].label,
           s->valid ? "true" : "false", s->plausible ? "true" : "false",
           s->capacitance_f, s->c_eq_f, s->quality, s->tau_us, s->freq_hz,
           s->fit_r2, vinf, s->fit_rmse_mv, s->tau_unc_us);
}

// Fusion breakdown: exactly which (range, method) samples entered the fusion,
// their weight, and whether the median gate kept them.  Reads the file-scope
// contrib array filled by fuse_samples().  Emitted once per cycle, right after
// the cycle event.
static void evt_fuse(const fusion_t *f)
{
    if (!g_stream) return;
    char mr[32];
    json_num(mr, sizeof(mr), f->method_mismatch_ratio);
    printf("@@EVT {\"t\":\"fuse\",\"valid\":%s,\"median\":%.9g,\"c\":%.9g,"
           "\"c_min\":%.9g,\"c_max\":%.9g,\"spread\":%.6g,\"quality\":%.6g,"
           "\"mismatch_ratio\":%s,\"gate_rel\":%.4g,"
           "\"n_kept\":%d,\"n_gated\":%d,\"w_total\":%.6g,\"contrib\":[",
           f->valid ? "true" : "false", f->median_f, f->capacitance_f,
           f->c_min_f, f->c_max_f, f->rel_spread, f->quality, mr,
           (double)FUSION_GATE_REL,
           f->n_kept, f->n_gated, f->total_weight);
    for (int i = 0; i < g_fusion_n_contrib; ++i) {
        const fusion_contrib_t *c = &g_fusion_contrib[i];
        printf("%s{\"r\":%d,\"label\":\"%s\",\"m\":\"%s\",\"c\":%.9g,\"c_eq\":%.9g,"
               "\"q\":%.6g,\"w\":%.6g,\"r2\":%.6g,\"kept\":%s}",
               i ? "," : "", c->range_idx, RANGES[c->range_idx].label,
               c->method == (uint8_t)METHOD_ADC_STEP ? "adc" : "osc",
               c->c_f, c->c_eq_f, c->q, c->w, c->r2, c->kept ? "true" : "false");
    }
    printf("]}\n");
}

// Autoranging decision snapshot: the rough probe value, the sub-nF handoff,
// which ADC ranges were swept, and which oscillator range was nominated.
static void evt_sweep(void)
{
    if (!g_stream || !g_sweep.valid) return;
    printf("@@EVT {\"t\":\"sweep\",\"mode\":\"%s\",\"have_rough\":%s,\"rough\":%.9g,"
           "\"sub_nf\":%s,\"saturated\":%s,\"adc_sub\":%s,\"osc_best\":%d,"
           "\"lock\":%d,\"adc_tried\":[",
           g_sweep.locked ? "locked" : "auto",
           g_sweep.have_rough ? "true" : "false", g_sweep.rough_f,
           g_sweep.sub_nf ? "true" : "false",
           g_sweep.saturated ? "true" : "false",
           g_sweep.adc_sub ? "true" : "false",
           g_sweep.osc_best_range, g_sweep.locked ? g_sweep.lock_range : -1);
    for (int r = 0; r < RANGE_COUNT; ++r)
        printf("%s%s", r ? "," : "", g_sweep.adc_tried[r] ? "true" : "false");
    printf("]}\n");
}

// Device health: uptime, completed cycles, last cycle duration, free heap.
static void evt_stat(void)
{
    if (!g_stream) return;
    printf("@@EVT {\"t\":\"stat\",\"uptime_ms\":%lld,\"cycles\":%u,\"cycle_ms\":%u,"
           "\"heap_free\":%u,\"heap_min\":%u}\n",
           (long long)(esp_timer_get_time() / 1000), (unsigned)g_cycle_count,
           (unsigned)g_last_cycle_ms, (unsigned)esp_get_free_heap_size(),
           (unsigned)esp_get_minimum_free_heap_size());
}

static void evt_curve(uint8_t range_idx, int vinf, int v0, double t0_us,
                      double tau_us, double r2,
                      const int64_t *ts, const int *mv, int n)
{
    if (!g_stream || !g_stream_curve) return;
    printf("@@EVT {\"t\":\"curve\",\"range\":%d,\"vinf\":%d,\"v0\":%d,\"t0_us\":%.6g,"
           "\"tau_us\":%.6g,\"r2\":%.6g,\"pts\":[",
           range_idx, vinf, v0, t0_us, tau_us, r2);
    for (int i = 0; i < n; ++i)
        printf("%s[%lld,%d]", i ? "," : "", (long long)(ts[i] - ts[0]), mv[i]);
    printf("]}\n");
}

static void evt_calpt(int range_idx, const char *op, double ref_pf, double freq)
{
    if (!g_stream) return;
    printf("@@EVT {\"t\":\"calpt\",\"op\":\"%s\",\"range\":%d,\"ref_pf\":%.6g,"
           "\"freq\":%.6g,\"period_us\":%.6g}\n",
           op, range_idx, ref_pf, freq, freq > 0.0 ? 1e6 / freq : 0.0);
}

static void evt_calres(int range_idx, const char *op, double k, double t0, int ok)
{
    if (!g_stream) return;
    printf("@@EVT {\"t\":\"calres\",\"op\":\"%s\",\"range\":%d,\"k\":%.6g,"
           "\"t0_us\":%.6g,\"ok\":%s}\n",
           op, range_idx, k, t0, ok ? "true" : "false");
}

// ADC (RC-step) calibration telemetry: τ vs reference C, and the solved
// effective resistance / offset.
static void evt_adccalpt(int range_idx, const char *op, double ref_pf, double tau_us)
{
    if (!g_stream) return;
    printf("@@EVT {\"t\":\"adccalpt\",\"op\":\"%s\",\"range\":%d,\"ref_pf\":%.6g,"
           "\"tau_us\":%.6g}\n", op, range_idx, ref_pf, tau_us);
}

static void evt_adccalres(int range_idx, const char *op, double r_eff, double c0_f, int ok)
{
    if (!g_stream) return;
    printf("@@EVT {\"t\":\"adccalres\",\"op\":\"%s\",\"range\":%d,\"r_eff\":%.6g,"
           "\"c0_f\":%.6g,\"r_nom\":%.6g,\"ok\":%s}\n",
           op, range_idx, r_eff, c0_f, RANGES[range_idx].resistance_ohms,
           ok ? "true" : "false");
}

static void evt_tare(int range_idx, int idx, int total, double freq,
                     double t0_us, double stray_pf, int done)
{
    if (!g_stream) return;
    printf("@@EVT {\"t\":\"tare\",\"range\":%d,\"idx\":%d,\"total\":%d,"
           "\"freq\":%.6g,\"period_us\":%.6g,\"t0_us\":%.6g,\"stray_pf\":%.6g,"
           "\"done\":%s}\n",
           range_idx, idx, total, freq, freq > 0.0 ? 1e6 / freq : 0.0,
           t0_us, stray_pf, done ? "true" : "false");
}

static void evt_ack(const char *cmd, int ok, const char *msg)
{
    if (!g_stream) return;
    printf("@@EVT {\"t\":\"ack\",\"cmd\":\"%s\",\"ok\":%s,\"msg\":\"%s\"}\n",
           cmd, ok ? "true" : "false", msg);
}

// Front-end state + live SSR pin levels (safety telemetry for the dashboard).
static const char *fe_name(fe_state_t s)
{
    switch (s) {
        case FE_PRECHARGE:  return "precharge";
        case FE_PRECHARGED: return "precharged";
        case FE_MEASURING:  return "measuring";
        case FE_DISCHARGE:  return "discharge";
        default:            return "idle";
    }
}

// Persistent node charge state, independent of the momentary SSR/phase state:
//   "charged"    N_DUT/C_block are held at V_BIAS (through R_bias) — not safe to touch
//   "discharged" bled to GND since the last charge
//   "unknown"    never charged nor discharged since boot
// This is what survives a stop: with auto-discharge OFF the node stays charged.
static const char *fe_charge_state(void)
{
    if (g_fe_charged && !g_fe_discharged) return "charged";
    if (g_fe_discharged && !g_fe_charged) return "discharged";
    return "unknown";
}

static void evt_fe(void)
{
    if (!g_stream) return;
    printf("@@EVT {\"t\":\"fe\",\"state\":\"%s\",\"ssr13\":%d,\"ssr2\":%d,\"drive\":%d,"
           "\"biased\":%s,\"charged\":%s,\"discharged\":%s,\"charge\":\"%s\","
           "\"auto_pre\":%s,\"auto_dis\":%s,"
           "\"run\":%s,\"single\":%s,\"lock\":%d}\n",
           fe_name(g_fe_state),
           gpio_get_level(SSR_S1_S3_PIN), gpio_get_level(SSR_S2_PIN),
           gpio_get_level(DRIVE_PIN),
           g_fe_state == FE_PRECHARGED ? "true" : "false",
           g_fe_charged ? "true" : "false",
           g_fe_discharged ? "true" : "false",
           fe_charge_state(),
           g_auto_precharge ? "true" : "false",
           g_auto_discharge ? "true" : "false",
           g_run ? "true" : "false",
           g_single_shot ? "true" : "false",
           g_range_lock);   // lock is configuration; persists across stop
}

// Change state and announce it (no-op if unchanged).
static void fe_set(fe_state_t s)
{
    if (g_fe_state == s) return;
    g_fe_state = s;
    status_led_set_fe(s);
    evt_fe();
}

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

    // Machine-readable mirror of exactly this reading (valid or not).
    evt_sample(s);
}

// Per-range measured asymptote cache (mV).  0 = not yet measured.
int g_v_inf_cache[RANGE_COUNT] = {0, 0, 0, 0};

// The asymptote is a property of the range + leakage path, which depends on the
// DC bias applied to the DUT.  Any change to the bias state must discard the
// cache, or a reading taken at a new bias would be scaled by the old plateau.
static void invalidate_vinf_cache(void)
{
    for (int i = 0; i < RANGE_COUNT; ++i) g_v_inf_cache[i] = 0;
}

// --- Nonlinear least-squares fit of the RC charge curve -------------------
// The charge follows  V(t) = V_inf − (V_inf − V0)·e^(−(t−t0)/τ).
//
// The previous estimator linearised this to  ln(V_inf − V) = ln(V_inf) − t/τ
// and fitted a straight line by ordinary least squares.  That has two accuracy
// problems:
//   1. It assumes the asymptote V_inf is known exactly, but V_inf comes from a
//      coarse settle measurement.  τ is very sensitive to a V_inf error.
//   2. The log transform re-weights the ADC noise (early points compressed,
//      points near the asymptote blown up), so OLS in log space is not the
//      maximum-likelihood estimator for additive voltage noise.
//
// This version fits the curve in the *voltage* domain and solves V_inf jointly
// with τ (and the effective origin t0) using a damped Gauss–Newton
// (Levenberg–Marquardt) iteration with an analytic Jacobian.  V0 is taken from
// the measured pre-step node voltage.  Working arrays live in static storage
// (single measurement task) to keep them off the limited main-task stack.
#define RC_FIT_MAX_PTS   64   // capture + fit capacity
#define RC_FIT_MIN_PTS   8    // minimum points for a meaningful fit
#define RC_FIT_MAX_ITER  50
#define RC_FIT_GLITCH_MV 40   // reject a sample this far below the running max

typedef struct {
    bool   ok;
    double tau_us;    // fitted time constant (us)
    double v_inf_mv;  // fitted asymptote (mV)
    double t0_us;     // fitted origin, relative to ts[0] (us, normally < 0)
    double r2;        // log-domain R² (quality semantics, as before)
    double rmse_mv;   // voltage-domain RMS residual (mV)
    double tau_se_us; // 1-sigma standard error of τ (us; 0 if not estimated)
    int    n;         // points used
} rc_fit_t;

// Solve the 3x3 system A·x = b by Gauss–Jordan elimination with partial
// pivoting.  Returns false if the matrix is (numerically) singular.
static bool rc_solve3(double A[3][3], const double b[3], double x[3])
{
    double M[3][4];
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) M[i][j] = A[i][j];
        M[i][3] = b[i];
    }
    for (int col = 0; col < 3; ++col) {
        int piv = col;
        for (int rr = col + 1; rr < 3; ++rr)
            if (fabs(M[rr][col]) > fabs(M[piv][col])) piv = rr;
        if (fabs(M[piv][col]) < 1e-12) return false;
        if (piv != col)
            for (int j = col; j < 4; ++j) {
                double t = M[col][j]; M[col][j] = M[piv][j]; M[piv][j] = t;
            }
        double d = M[col][col];
        for (int j = col; j < 4; ++j) M[col][j] /= d;
        for (int rr = 0; rr < 3; ++rr) {
            if (rr == col) continue;
            double f = M[rr][col];
            if (f == 0.0) continue;
            for (int j = col; j < 4; ++j) M[rr][j] -= f * M[col][j];
        }
    }
    for (int i = 0; i < 3; ++i) x[i] = M[i][3];
    return true;
}

// Model value at a point x (us, relative to ts[0]).
static inline double rc_model(double x, double v_inf, double tau, double t0, double v0)
{
    return v_inf - (v_inf - v0) * exp(-(x - t0) / tau);
}

// ts[] = absolute time (us, ts[0] = fit origin), mv[] = calibrated mV,
// n = count, v_inf_hint = measured asymptote (mV; 0 = unknown),
// v0_mv = measured node voltage at the step edge (mV),
// t0_hint_us = drive-edge time relative to ts[0] (us; normally negative).
static rc_fit_t rc_exp_fit(const int64_t *ts, const int *mv, int n,
                           int v_inf_hint, int v0_mv, double t0_hint_us)
{
    rc_fit_t r = {0};
    r.r2 = 0.0;
    if (n < RC_FIT_MIN_PTS || v0_mv < 0) return r;

    // Build the working set with a monotonic glitch filter so one ADC spike
    // cannot bias the fit.
    static double xs[RC_FIT_MAX_PTS], ys[RC_FIT_MAX_PTS];
    int m = 0, run_max = mv[0];
    for (int i = 0; i < n && m < RC_FIT_MAX_PTS; ++i) {
        if (mv[i] > run_max) run_max = mv[i];
        if (mv[i] < run_max - RC_FIT_GLITCH_MV) continue;   // downward glitch
        xs[m] = (double)(ts[i] - ts[0]);
        ys[m] = (double)mv[i];
        m++;
    }
    if (m < RC_FIT_MIN_PTS) return r;

    double y_max = ys[0];
    for (int i = 1; i < m; ++i) if (ys[i] > y_max) y_max = ys[i];

    // ---- Initial parameters -------------------------------------------------
    double v_inf = (v_inf_hint > 0) ? (double)v_inf_hint : (y_max + 200.0);
    if (v_inf < y_max + 2.0) v_inf = y_max + 200.0;   // hint must exceed data
    double t0 = (t0_hint_us < 0.0) ? t0_hint_us : 0.0;
    // Seed τ from the model-free 63.2 % crossing.
    double v63 = (double)v0_mv + 0.632 * (v_inf - (double)v0_mv);
    double tau = 0.0;
    for (int i = 0; i < m; ++i)
        if (ys[i] >= v63) { tau = xs[i] - t0; break; }
    if (tau <= 0.0) tau = (xs[m - 1] - t0) * 0.4;
    if (tau <= 1e-3) tau = 1.0;

    // ---- Damped Gauss–Newton (Levenberg–Marquardt) --------------------------
    // cost(p) = Σ (model(x_i; p) − y_i)²
    double cost = 0.0;
    for (int i = 0; i < m; ++i) {
        double res = rc_model(xs[i], v_inf, tau, t0, (double)v0_mv) - ys[i];
        cost += res * res;
    }

    double lambda = 1e-2;
    bool converged = false;
    for (int it = 0; it < RC_FIT_MAX_ITER && !converged; ++it) {
        double amp = v_inf - (double)v0_mv;
        if (amp <= 0.0) break;

        double A[3][3] = {{0}}, g[3] = {0};
        for (int i = 0; i < m; ++i) {
            double s = (xs[i] - t0) / tau;
            if (s < -20.0) s = -20.0;
            double e = exp(-s);
            double res = (v_inf - amp * e) - ys[i];
            double J[3];
            J[0] = 1.0 - e;                                   // d/dV_inf
            J[1] = -amp * e * (xs[i] - t0) / (tau * tau);      // d/dtau
            J[2] = -amp * e / tau;                             // d/dt0
            for (int a = 0; a < 3; ++a) {
                g[a] += J[a] * res;
                for (int b2 = 0; b2 < 3; ++b2) A[a][b2] += J[a] * J[b2];
            }
        }
        // LM damping on the diagonal.
        double Ad[3][3];
        for (int a = 0; a < 3; ++a)
            for (int b2 = 0; b2 < 3; ++b2) Ad[a][b2] = A[a][b2];
        for (int a = 0; a < 3; ++a)
            Ad[a][a] += lambda * (A[a][a] > 0.0 ? A[a][a] : 1.0);

        double delta[3];
        if (!rc_solve3(Ad, g, delta)) { lambda *= 10.0; if (lambda > 1e12) break; continue; }

        double nv = v_inf - delta[0];
        double nt = tau   - delta[1];
        double n0 = t0    - delta[2];
        // Keep parameters physical.
        if (nt < 1e-3) nt = 1e-3;
        if (nv <= (double)v0_mv) nv = (double)v0_mv + 1.0;
        if (nv > 1.2 * V_NOMINAL_MV) nv = 1.2 * V_NOMINAL_MV;
        if (n0 > 0.0) n0 = 0.0;

        double trial = 0.0;
        for (int i = 0; i < m; ++i) {
            double res = rc_model(xs[i], nv, nt, n0, (double)v0_mv) - ys[i];
            trial += res * res;
        }

        if (trial < cost) {
            double dtau = fabs(nt - tau), dvinf = fabs(nv - v_inf);
            v_inf = nv; tau = nt; t0 = n0;
            cost = trial;
            lambda *= 0.5;
            if (lambda < 1e-9) lambda = 1e-9;
            if (dtau < 1e-6 * tau && dvinf < 1e-6 * v_inf) converged = true;
        } else {
            lambda *= 4.0;
            if (lambda > 1e12) break;
        }
    }

    if (!(tau > 0.0) || !(v_inf > (double)v0_mv)) return r;

    // ---- Goodness of fit ----------------------------------------------------
    double rmse = sqrt(cost / (double)m);

    // Log-domain R² (against the *fitted* asymptote) preserves the quality
    // semantics the fusion scoring was tuned on, while τ itself comes from the
    // superior voltage-domain fit.
    double sx = 0, sy = 0, sxx = 0, sxy = 0;
    int k = 0;
    for (int i = 0; i < m; ++i) {
        double gap = v_inf - ys[i];
        if (gap < 12.0) continue;
        double y = log(gap);
        sx += xs[i]; sy += y; sxx += xs[i] * xs[i]; sxy += xs[i] * y;
        k++;
    }
    double r2 = 0.0;
    if (k >= 4) {
        double denom = (double)k * sxx - sx * sx;
        if (fabs(denom) > 1e-9) {
            double slope = ((double)k * sxy - sx * sy) / denom;
            double intercept = (sy - slope * sx) / (double)k;
            double ybar = sy / (double)k;
            double ss_res = 0, ss_tot = 0;
            for (int i = 0; i < m; ++i) {
                double gap = v_inf - ys[i];
                if (gap < 12.0) continue;
                double y = log(gap);
                double yhat = slope * xs[i] + intercept;
                ss_res += (y - yhat) * (y - yhat);
                ss_tot += (y - ybar) * (y - ybar);
            }
            r2 = (ss_tot > 1e-12) ? (1.0 - ss_res / ss_tot) : 0.0;
        }
    }

    // τ standard error from the covariance σ²·(JᵀJ)⁻¹.
    double tau_se = 0.0;
    if (m > 3) {
        double A[3][3] = {{0}};
        double amp2 = v_inf - (double)v0_mv;
        for (int i = 0; i < m; ++i) {
            double s = (xs[i] - t0) / tau;
            if (s < -20.0) s = -20.0;
            double e = exp(-s);
            double J[3];
            J[0] = 1.0 - e;
            J[1] = -amp2 * e * (xs[i] - t0) / (tau * tau);
            J[2] = -amp2 * e / tau;
            for (int a = 0; a < 3; ++a)
                for (int b2 = 0; b2 < 3; ++b2) A[a][b2] += J[a] * J[b2];
        }
        double sigma2 = cost / (double)(m - 3);
        double e1[3] = {0, 1, 0}, col[3];
        if (rc_solve3(A, e1, col)) {
            double var = sigma2 * col[1];
            if (var > 0.0) tau_se = sqrt(var);
        }
    }

    r.ok = true;
    r.tau_us = tau;
    r.v_inf_mv = v_inf;
    r.t0_us = t0;
    r.r2 = r2;
    r.rmse_mv = rmse;
    r.tau_se_us = tau_se;
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
    // The asymptote needs ~5τ to settle.  A 360 µF DUT on 1 kΩ has τ ≈ 0.26 s,
    // so the old 400 ms budget stopped while the node was still ~0.7 V short of
    // its true plateau and cached a bogus V_inf.  Give the 100 Ω / 1 kΩ ranges a
    // budget that covers the large electrolytics they exist for.
    int64_t settle_budget = (range_idx <= 1) ? 3000000LL : 1500000LL; // us
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
        safe_delay_ms(20);
        if (g_abort_cycle) break;
    }
    gpio_set_level(DRIVE_PIN, 0);

    // Reset V_cap to ~0 V (drive low) without disturbing the DUT bias, then
    // isolate so the caller starts the timed charge from a clean node.
    prepare_measurement();
    if (v_inf > 0) g_v_inf_cache[range_idx] = v_inf;
    return v_inf;
}

// ---------------------------------------------------------------------------
// Effective series resistance of the RC-step — the ONE place this is defined.
// ---------------------------------------------------------------------------
// The node asymptotes to V_inf because R_bias/leakage forms a divider with the
// range chain, so the resistance that actually sets τ is the parallel
// combination of the stored chain resistance and that leakage path:
//      R_leak = V_inf·R_chain / (V_nom − V_inf)
//      R_eff  = R_chain ∥ R_leak
// Both the runtime measurement and the ADC calibration MUST use this exact
// function (and its inverse below), or a solved R_eff would not reproduce the
// reference and the two paths would silently disagree.
static double adc_effective_r(double r_chain, double v_inf_mv)
{
    if (r_chain <= 0.0) return r_chain;
    if (v_inf_mv >= (double)V_NOMINAL_MV - 50.0) return r_chain;   // no droop: no leak fold
    double r_leak = (v_inf_mv * r_chain) / ((double)V_NOMINAL_MV - v_inf_mv + 1e-9);
    if (r_leak <= 0.0) return r_chain;
    return (r_chain * r_leak) / (r_chain + r_leak);                // parallel
}

// Exact inverse of adc_effective_r(): recover the chain resistance that maps
// back to a solved effective resistance under the same asymptote.  Since
// R_leak ∝ R_chain (R_leak = a·R_chain with a = V_inf/(V_nom−V_inf)),
// R_eff = R_chain·a/(1+a)  ⇒  R_chain = R_eff·(1+a)/a.
static double adc_chain_from_eff(double r_eff, double v_inf_mv)
{
    if (r_eff <= 0.0) return r_eff;
    if (v_inf_mv >= (double)V_NOMINAL_MV - 50.0) return r_eff;     // no fold was applied
    double a = v_inf_mv / ((double)V_NOMINAL_MV - v_inf_mv + 1e-9);
    if (a <= 0.0) return r_eff;
    return r_eff * (1.0 + a) / a;
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

    // prepare_measurement() leaves V_cap driven low (the DUT bias is untouched);
    // actively confirm the node is below the start threshold before the timed
    // charge.  If it will not settle in time the tau would be bogus.
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

    // ---- Phase B: capture the charge curve, then fit τ ----
    // We sample from just above the start floor up to ~90 % of V_inf (well past
    // the 63.2 % τ point) and fit V(t) = V_inf − (V_inf − V0)·e^(−(t−t0)/τ) in
    // the voltage domain, solving V_inf and τ *jointly* (see rc_exp_fit).  If
    // the fit is unusable we fall back to the classic two-threshold crossing.
    int v_low = v_start + (int)(0.10 * (double)(v_inf - v_start));
    if (v_low < v_start + 40) v_low = v_start + 40;
    int v_tau = v_start + (int)(V_TAU_FRAC * (double)(v_inf - v_start));
    int v_stop = v_start + (int)(0.90 * (double)(v_inf - v_start)); // deep into tail

    // Sample buffers in static storage (single measurement task => safe) to
    // avoid overflowing the main task stack (the default is only ~3.5 KB).
    static int64_t ts[RC_FIT_MAX_PTS];
    static int     mvs[RC_FIT_MAX_PTS];
    int     npts = 0;

    // Adaptive decimation.  A fixed 64-point buffer fills during the early,
    // near-linear part of a LONG-τ charge (a 360 µF DUT on 100 Ω has τ ≈ 28 ms;
    // at ~100 µs/poll, 64 points span only ~6 ms), so the joint V_inf/τ fit is
    // ill-conditioned and converges on a bogus low asymptote (V_inf ≈ 1.6 V
    // instead of 3.3 V) — which then also poisons any calibration using it.
    // When the buffer fills we keep every other point and double the store
    // interval, so the 64 points always span the whole curve (logarithmic-in-
    // time coverage).  Short-τ captures never fill the buffer, so they are
    // unchanged.
    int64_t store_interval_us = 0;   // 0 = store every eligible poll
    int64_t t_last_store = 0;
    int     v_peak = 0;              // highest mV seen (any point, stored or not)

    // Capture the node voltage at the step edge as the fit's V0.  The node is
    // held low and stable here, so this is the best estimate of the start level.
    int v0_step = adc_read_avg_mv(5);
    if (v0_step < 0) v0_step = v_start;

    int64_t t_begin = esp_timer_get_time();
    gpio_set_level(DRIVE_PIN, 1);

    int64_t t_start = -1, t_tau = -1;
    int64_t t_last_feed = t_begin;
    while (true) {
        // Service the console so an exclusive command (zero/cal/probe) can abort
        // this cycle promptly; a queued command also sets g_abort_cycle.
        service_console();
        if (g_abort_cycle) {
            gpio_set_level(DRIVE_PIN, 0);
            return s;
        }
        int mv;
        int64_t t_before = esp_timer_get_time();
        // Oversample on the slow (high-R) ranges where the time budget is
        // ample: averaging converts ADC white noise into a cleaner curve, which
        // sharpens the τ fit.  The fast ranges keep single reads so the extra
        // conversions cannot smear a short τ.
        int navg = (range_idx >= 2) ? ADC_POINT_AVG : 1;
        long acc = 0;
        int  got = 0;
        for (int a = 0; a < navg; ++a) {
            int v;
            if (read_vcap_mv(&v)) { acc += v; got++; }
        }
        if (got == 0) {
            gpio_set_level(DRIVE_PIN, 0);
            return s;
        }
        mv = (int)(acc / got);
        int64_t now = (t_before + esp_timer_get_time()) / 2;
        if (mv > v_peak) v_peak = mv;

        if ((now - t_last_feed) > 500000LL) {
            esp_task_wdt_reset();
            t_last_feed = now;
        }

        if (t_start < 0 && mv >= v_low) { t_start = now; t_last_store = now; }
        if (t_tau < 0 && mv >= v_tau) t_tau = now;

        // Record points once past the start floor, at the current decimation
        // interval.  When the buffer is full, halve it (keep even indices) and
        // double the interval so the remaining points cover the tail.
        if (t_start >= 0 && mv >= v_low &&
            (npts == 0 || (now - t_last_store) >= store_interval_us)) {
            if (npts >= RC_FIT_MAX_PTS) {
                int k2 = 0;
                for (int j = 0; j < npts; j += 2, ++k2) {
                    ts[k2] = ts[j];
                    mvs[k2] = mvs[j];
                }
                npts = k2;
                int64_t span = (npts > 1) ? (ts[npts - 1] - ts[0]) : 0;
                store_interval_us = (npts > 1) ? (span / (npts - 1)) : 1;
                if (store_interval_us < 1) store_interval_us = 1;
            }
            ts[npts] = now;
            mvs[npts] = mv;
            npts++;
            t_last_store = now;
        }

        if (mv >= v_stop) break;                 // captured past τ
        if ((now - t_begin) > timeout_us) break; // too large for this range
    }
    gpio_set_level(DRIVE_PIN, 0);

    // ---- Effective series resistance ----
    // R_series (buffer Zo + mux Ron + wiring) is a large fraction of R_nom on
    // the 100 Ω / 1 kΩ ranges.  When calibrated, use the measured effective
    // resistance; otherwise fall back to nominal.  Fold in the parallel leakage
    // path implied by the measured asymptote droop.
    double tau_us = -1.0;
    double fit_r2 = 0.0;
    double fit_rmse = -1.0;
    double tau_unc = -1.0;
    bool used_fit = false;
    double fallback_k_corr = 1.0;   // log factor for the 2-point fallback

    // Primary: nonlinear least-squares fit of the captured curve.  t0 is the
    // drive-edge time relative to the first stored sample (normally negative);
    // V0 is the node voltage measured just before the step.
    double t0_hint = (npts > 0) ? (double)(t_begin - ts[0]) : 0.0;
    rc_fit_t fit = rc_exp_fit(ts, mvs, npts, v_inf, v0_step, t0_hint);
    // The fitted asymptote can never be below the highest voltage actually
    // observed (the model cannot exceed V_inf).  If it is, the capture did not
    // see enough curvature and the fit locked onto a spurious low asymptote —
    // distrust it and let the two-threshold fallback (which uses the measured
    // settle V_inf) produce τ instead.
    bool fit_ok = fit.ok && fit.r2 > 0.90 && fit.tau_us > 0.0 &&
                  (double)fit.v_inf_mv >= (double)v_peak - 20.0;
    if (fit_ok) {
        tau_us = fit.tau_us;
        fit_r2 = fit.r2;
        fit_rmse = fit.rmse_mv;
        tau_unc = fit.tau_se_us;
        used_fit = true;
        // Feed the fitted asymptote back into the per-range cache: it is a
        // better estimate than the coarse settle loop and sharpens the capture
        // window (and the leakage-derived R_eff) on subsequent visits.
        if (fit.v_inf_mv > V_INF_MIN_MV && fit.v_inf_mv <= V_NOMINAL_MV)
            g_v_inf_cache[range_idx] = (int)(fit.v_inf_mv + 0.5);
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

    // True effective τ: the fallback crossing interval must be divided by the
    // log factor.  Storing the effective τ (not the raw interval) lets ADC
    // calibration reuse this exact estimator.
    double tau_eff_us = used_fit ? tau_us : (tau_us / fallback_k_corr);

    // Asymptote for the leakage/series-resistance model: prefer the fitted value
    // (derived from the whole curve, not a settle snapshot).
    double v_inf_eff = used_fit ? fit.v_inf_mv : (double)v_inf;

    double r_range = RANGES[range_idx].resistance_ohms;
    double r_chain = adc_cal_valid(range_idx) ? adc_r_eff(range_idx) : r_range;
    if (r_chain <= 0.0) r_chain = r_range;
    // Fold in the leakage path implied by the measured asymptote droop — via the
    // shared helper so the calibration's inverse uses the identical formula.
    double r_eff = adc_effective_r(r_chain, v_inf_eff);

    // Stream the captured charge curve + fitted exponential for the UI graph.
    // Emit the *fitted* asymptote/origin (when available) so the host ghost
    // line reproduces the same model.
    evt_curve(range_idx,
              used_fit ? (int)(fit.v_inf_mv + 0.5) : v_inf,
              v0_step,
              used_fit ? fit.t0_us : t0_hint,
              used_fit ? tau_us : -1.0,
              used_fit ? fit_r2 : -1.0,
              ts, mvs, npts);

    s.valid = true;
    s.tau_us = tau_eff_us;
    s.fit_r2 = fit_r2;
    s.fit_rmse_mv = fit_rmse;
    s.tau_unc_us = tau_unc;
    s.v_inf_mv = v_inf_eff;

    // Recover C_eq = τ_eff / R_eff.
    double c_eq = (tau_eff_us * 1e-6) / r_eff;
    s.c_eq_f = c_eq;

    // Correct order: invert the C_block series combination FIRST, THEN subtract
    // the node offset.  c_eq ≥ C_block is non-physical → reject.
    double c_total = cblock_invert(c_eq);
    if (c_total < 0.0) {                                  // at/past C_block singularity
        s.capacitance_f = 0.0;
        log_sample(g_phase, &s);
        return s;                                         // not plausible, not valid data
    }
    double c_off = adc_cal_valid(range_idx) ? adc_c0(range_idx) : STRAY_CAPACITANCE_F;
    double c = c_total - c_off;
    if (c < 0.0) c = 0.0;
    s.capacitance_f = c;

    // ---- Physics-based plausibility ----
    if (tau_eff_us < ADC_STEP_THRESHOLD_US) { log_sample(g_phase, &s); return s; } // poll jitter
    if (tau_eff_us > 15e6)                  { log_sample(g_phase, &s); return s; } // beyond timeout
    if (c < 3.0 * STRAY_CAPACITANCE_F)  { log_sample(g_phase, &s); return s; } // stray-dominated
    if (c > 1.0)                        { log_sample(g_phase, &s); return s; } // > 1 F here
    s.plausible = true;

    // ---- Quality scoring ----
    // Plateau of full confidence for 200 µs ≤ τ ≤ 20 ms; Gaussian roll-off
    // outside.  Fast τ is penalised hard (ADC poll jitter), slow τ gently
    // (still a clean measurement, just slower).
    double log_tau = log(tau_eff_us);
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

    // Fit uncertainty: τ standard error relative to τ.  A large relative error
    // means the curve poorly constrains τ (noisy / too few points / leaky), so
    // down-weight it.  1 % is the full-credit target; 5 % costs ~1/e.
    double q_unc = 1.0;
    if (used_fit && tau_unc > 0.0 && tau_eff_us > 0.0) {
        double relu = tau_unc / tau_eff_us;
        q_unc = exp(-pow(relu / 0.05, 2.0));
    }

    double q = q_time * q_stray * q_range * q_fit * q_unc;
    // No artificial quality floor: with the ADC hard-gated at
    // ADC_STEP_THRESHOLD_US, sub-floor/noisy samples never reach scoring, so a
    // low q here is genuine (leaky/non-exponential) and must be allowed to sink.
    s.quality = q;

    log_sample(g_phase, &s);
    return s;
}

// ---------------------------------------------------------------------------
// Method 2 — LM393 + ESP32 GPIO-feedback relaxation oscillator, frequency readout
//
// The ESP32 mirrors the comparator output back onto the drive via the ISR, so
// the RC node self-oscillates in a software-in-the-loop arrangement (this
// board's LM393 is a plain comparator, not a free-running oscillator).  High
// frequencies are counted with the PCNT peripheral over a fixed gate; low
// frequencies use a reciprocal period measurement (N rising edges / elapsed
// time) via the GPIO ISR.  A quick PCNT gate first decides which regime.
// ---------------------------------------------------------------------------
#define OSC_PCNT_QUICK_GATE_MS 20
// High-frequency path (100 kΩ small caps ~73 kHz): a long averaging window.
// Counts are accumulated in short sub-gates so the 16-bit hardware counter can
// never overflow, which lets the window be far longer than 32767/f would allow.
#define OSC_PCNT_GATE_MS 500
#define OSC_PCNT_SUBGATE_MS 25
#define OSC_HIGH_FREQ_HZ 10000.0
// Reciprocal path (1 MΩ small caps ~7 kHz): average over a fixed long window
// (0.5 s) instead of a fixed tiny edge count (was 64 edges ≈ 8.7 ms).
#define OSC_PERIOD_MAX_EDGES 8192
#define OSC_PERIOD_MIN_WINDOW_US 500000LL    // 0.5 s minimum averaging window
#define OSC_PERIOD_TIMEOUT_US 3000000LL      // ...but never longer than 3 s

// Count edges in hardware over a gate; returns frequency via *freq_hz.
// The count is accumulated across sub-gates so the 16-bit PCNT (high_limit
// 32767) can never overflow, enabling an arbitrarily long averaging window.
static bool osc_pcnt_frequency(uint32_t gate_ms, double *freq_hz, uint32_t *count_out)
{
    if (pcnt_unit_stop(pcnt_unit) != ESP_OK) return false;
    if (pcnt_unit_clear_count(pcnt_unit) != ESP_OK) return false;
    if (pcnt_unit_start(pcnt_unit) != ESP_OK) return false;

    int64_t t0 = esp_timer_get_time();
    int64_t deadline = t0 + (int64_t)gate_ms * 1000;
    uint32_t sub_ms = (gate_ms < OSC_PCNT_SUBGATE_MS) ? gate_ms : OSC_PCNT_SUBGATE_MS;
    if (sub_ms == 0) sub_ms = 1;
    int64_t total = 0;

    while (true) {
        service_console();                       // honour stop/abort promptly
        if (g_abort_cycle) { pcnt_unit_stop(pcnt_unit); return false; }
        if (!osc_running) { pcnt_unit_stop(pcnt_unit); return false; } // self-limited
        int64_t now = esp_timer_get_time();
        if (now >= deadline) break;

        int64_t remain_ms = (deadline - now) / 1000;
        uint32_t chunk = sub_ms;
        if ((int64_t)chunk > remain_ms) chunk = (uint32_t)(remain_ms > 0 ? remain_ms : 1);
        vTaskDelay(pdMS_TO_TICKS(chunk));

        // Sample-and-reset: one edge lost per sub-gate boundary is negligible
        // (≈0.05 % at 500 ms / 73 kHz) and keeps the counter from overflowing.
        int c = 0;
        if (pcnt_unit_get_count(pcnt_unit, &c) != ESP_OK) { pcnt_unit_stop(pcnt_unit); return false; }
        if (c < 0 || c >= 31100) { pcnt_unit_stop(pcnt_unit); return false; }  // overflow
        total += c;
        pcnt_unit_clear_count(pcnt_unit);
        esp_task_wdt_reset();
    }
    pcnt_unit_stop(pcnt_unit);
    int64_t t1 = esp_timer_get_time();

    double elapsed_us = (double)(t1 - t0);
    if (elapsed_us <= 0.0 || total <= 0) return false;

    *freq_hz = ((double)total * 1e6) / elapsed_us;
    if (count_out) *count_out = (uint32_t)total;
    return true;
}

// Reciprocal period measurement: average over a long, fixed time window (with
// an edge ceiling) so ISR timestamp jitter averages down.
static bool osc_period_frequency(double *freq_hz, uint32_t *periods_out)
{
    // The caller owns the loop lifetime (osc_loop_start() already primed and
    // enabled it); we only reset the edge bookkeeping for this window.
    osc_edge_count = 0;
    osc_first_rise_time = 0;
    osc_last_rise_time = 0;

    int64_t t0 = esp_timer_get_time();
    while (true) {
        int64_t now = esp_timer_get_time();
        if (!osc_running) break;   // ISR self-limited: loop was too fast
        if (osc_edge_count >= OSC_PERIOD_MAX_EDGES) break;
        if ((now - t0) >= OSC_PERIOD_TIMEOUT_US) break;
        // Enough edges AND a full averaging window -> stop.
        if (osc_edge_count >= 4 && (now - t0) >= OSC_PERIOD_MIN_WINDOW_US) break;
        if (g_abort_cycle) break;
        esp_task_wdt_reset();
        service_console();
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

// Frequency read used by tare and calibration.  It MUST use the identical
// path/window as measure_osc_range() (i.e. osc_measure_frequency): the old tare
// used dbg_measure_freq()'s 20 ms PCNT gate while the measurement uses the
// 500 ms reciprocal window on 1 MΩ, and the two estimators differ by a fixed
// few µs.  That constant period difference survived the "tare" subtraction and
// showed up as ~3 pF on an open socket (a 10 pF DUT read ~12.8 pF).  Primes the
// software loop first and stops it afterwards.
static bool osc_read_freq(double *freq_hz, uint32_t *periods_out)
{
    osc_loop_start();
    bool ok = osc_measure_frequency(freq_hz, periods_out);
    osc_running = false;
    return ok;
}

// A range is "tareable" only where an EMPTY socket still oscillates at a sane
// rate.  On 100 Ω / 1 kΩ the bare node runs far too fast, so the software loop
// self-limits and there is nothing to tare — but those ranges are still valid
// for MEASUREMENT when a large DUT slows the loop down (that is why there is no
// blanket range ban in measure_osc_range).
static bool osc_range_tareable(uint8_t range_idx)
{
    return RANGES[range_idx].resistance_ohms >= 100000.0;
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

    // Kick-start the software-in-the-loop oscillator.  prepare_measurement()
    // leaves V_cap reset to ~0 V (DUT bias untouched).  We prime the
    // drive with the comparator's CURRENT output level; the ISR then mirrors
    // the comparator onto the buffer on every edge and the loop self-sustains.
    // (This board's LM393 is a comparator, not a free-running oscillator —
    // the ESP32 feedback is what makes it oscillate.)  If the loop is too fast
    // for this range the ISR self-limits and osc_measure_frequency() fails,
    // which simply rejects the sample.
    osc_loop_start();

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
    double off_us = use_t0 ? osc_t0(range_idx) : osc_delay(range_idx);
    double eff_period_us = period_us - off_us;

    // T_meas ≤ offset is non-physical (would imply a negative/zero RC time).
    // Around a tare baseline, though, small negative excursions are just
    // measurement noise: clamp them to 0 so an open socket reads ~0 pF instead
    // of intermittently failing.  Only a large negative is truly non-physical.
    if (eff_period_us <= 0.0) {
        if (use_t0 && off_us > 0.0 && eff_period_us > -0.05 * off_us) {
            eff_period_us = 0.0;
        } else {
            s.freq_hz = freq_hz;
            s.tau_us = period_us;
            log_sample(g_phase, &s);
            return s;                                         // invalid
        }
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
    // Tared ranges can legitimately read down to ~0 pF (open socket), so there is
    // no positive floor there; an un-tared range still uses the legacy floor.
    double c_floor = use_t0 ? 0.0 : 0.5 * STRAY_CAPACITANCE_F;
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
    // Tared ranges have the parasitic offset removed, so there is no
    // stray-domination penalty — a ~0 pF open-socket reading is legitimate and
    // must not be crushed to zero quality.  Un-tared ranges keep the legacy term.
    double q_stray = use_t0 ? 1.0 : (c / (c + 3.0 * STRAY_CAPACITANCE_F));
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
        .method_mismatch_ratio = NAN, .quality = 0.0,
        .raw_samples = n,
        .median_f = 0.0, .n_kept = 0, .n_gated = 0,
        .c_min_f = 0.0, .c_max_f = 0.0,
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
        // Mirror the population into the breakdown telemetry (provisional
        // "kept" until the median gate below confirms it).
        fusion_contrib_t *gc = &g_fusion_contrib[n_kept];
        gc->range_idx = samples[i].range_idx;
        gc->method    = (uint8_t)samples[i].method;
        gc->c_f       = samples[i].capacitance_f;
        gc->c_eq_f    = samples[i].c_eq_f;
        gc->q         = samples[i].quality;
        gc->w         = samples[i].quality;
        gc->r2        = (samples[i].method == METHOD_ADC_STEP) ? samples[i].fit_r2 : 0.0;
        gc->kept      = false;
        n_kept++;
    }
    g_fusion_n_contrib = n_kept;
    f.n_kept = n_kept;
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
        if (lo > 0.0) {
            f.method_mismatch_ratio = hi / lo;
            if (f.method_mismatch_ratio > METHOD_MISMATCH_RATIO) f.method_mismatch = true;
        }
    }

    double med = median_of(cvals, n_kept);
    f.median_f = med;

    // Median gate: discard anything more than FUSION_GATE_REL (relative) away
    // from the median — kills one-off ADC glitches / ISR hiccups.
    double lw_sum = 0.0, lw = 0.0;
    int n_adc_kept = 0, n_osc_kept = 0;
    double cmin = 0.0, cmax = 0.0;
    bool have_kept = false;

    for (int i = 0; i < n_kept; ++i) {
        if (med > 0.0 && fabs(cvals[i] - med) / med > FUSION_GATE_REL) {
            g_fusion_contrib[i].kept = false;
            f.n_gated++;
            continue;
        }
        g_fusion_contrib[i].kept = true;
        if (!have_kept) { cmin = cmax = cvals[i]; have_kept = true; }
        else {
            if (cvals[i] < cmin) cmin = cvals[i];
            if (cvals[i] > cmax) cmax = cvals[i];
        }
        double logc = log(cvals[i] > 0.0 ? cvals[i] : 1e-15);
        double w = weights[i];
        lw_sum += w * logc;
        lw += w;
        if (kept_method[i] == (int)METHOD_ADC_STEP) n_adc_kept++; else n_osc_kept++;
    }
    f.n_adc = n_adc_kept;
    f.n_osc = n_osc_kept;
    f.c_min_f = have_kept ? cmin : 0.0;
    f.c_max_f = have_kept ? cmax : 0.0;
    if (lw <= 0.0) return f;

    double fused_log = lw_sum / lw;
    f.capacitance_f = exp(fused_log);
    f.total_weight = lw;
    // Fused quality: weight-weighted mean quality of the post-gate population.
    // lw is Σ quality_i over the kept samples, so lw / n_kept is their mean.
    int n_kept_gate = n_adc_kept + n_osc_kept;
    if (n_kept_gate > 0) f.quality = lw / (double)n_kept_gate;
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

    memset(&g_sweep, 0, sizeof(g_sweep));
    g_sweep.valid = true;
    g_sweep.locked = false;
    g_sweep.lock_range = -1;
    g_sweep.osc_best_range = -1;

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

            // Predict the *measured* period, including the per-range open-node
            // tare T0.  Without T0 a small DUT is wildly over-predicted: 10 pF
            // on 1 MΩ looks like 100 kHz (τ=10 µs) when the real loop runs at
            // ~5.4 kHz (T=K·R·C + T0 ≈ 184 µs), so no range ever qualified and
            // the successful probe was thrown away.
            double t_pred_us = osc_k((uint8_t)r) * RANGES[r].resistance_ohms * rough_c * 1e6;
            if (osc_has_t0((uint8_t)r)) t_pred_us += osc_t0((uint8_t)r);
            double f_pred = (t_pred_us > 0.0) ? 1e6 / t_pred_us : 0.0;
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

    // Snapshot the decision for the dashboard's range-decision matrix.
    g_sweep.have_rough = have_rough;
    g_sweep.rough_f = rough_c;
    g_sweep.sub_nf = sub_nf;
    g_sweep.osc_best_range = osc_best_range;
    for (int r = 0; r < RANGE_COUNT; ++r) g_sweep.adc_tried[r] = adc_tried[r];

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
        g_sweep.adc_sub = true;
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

    // Safety net: a valid, plausible probe is a real measurement — never
    // discard it just because predictive range selection failed to nominate
    // its range (e.g. an un-tared range or a DUT at the edge of the OSC band).
    if (!osc_added && probe.valid && probe.plausible &&
        probe.capacitance_f > 0.0 && n < MAX_SAMPLES) {
        samples[n++] = probe;
        osc_added = true;
        osc_best_range = (int)probe.range_idx;
    }

    // Neighbouring-range oscillator run for cross-validation when time permits.
    if (osc_added && osc_best_range >= 0 && n < MAX_SAMPLES) {
        int alt = (osc_best_range > 0) ? osc_best_range - 1 : osc_best_range + 1;
        if (alt >= 0 && alt < RANGE_COUNT) {
            double f_alt = 0.0;
            if (have_rough && rough_c > 0.0) {
                double t_alt_us = osc_k((uint8_t)alt) * RANGES[alt].resistance_ohms * rough_c * 1e6;
                if (osc_has_t0((uint8_t)alt)) t_alt_us += osc_t0((uint8_t)alt);
                if (t_alt_us > 0.0) f_alt = 1e6 / t_alt_us;
            }
            if (f_alt >= 100.0 && f_alt <= 15000.0) {
                g_phase = "osc-x";
                sample_t o2 = measure_osc_range((uint8_t)alt);
                if (o2.valid) samples[n++] = o2;
            }
        }
    }

    g_phase = "fuse";
    g_sweep.saturated = fastest_range_saturated;
    evt_sweep();
    fusion_t result = fuse_samples(samples, n);
    return result;
}

// ---------------------------------------------------------------------------
// Locked-range measurement (normal mode 'range <n>')
// ---------------------------------------------------------------------------
// Measures only the selected range with both available methods and fuses the
// result.  The ADC's own τ gate still rejects sub-nF DUTs, so a locked pF range
// naturally ends up oscillator-only.
static fusion_t measure_locked_range(uint8_t range_idx)
{
    static sample_t samples[MAX_SAMPLES];
    int n = 0;

    memset(&g_sweep, 0, sizeof(g_sweep));
    g_sweep.valid = true;
    g_sweep.locked = true;
    g_sweep.lock_range = (int)range_idx;
    g_sweep.have_rough = false;
    g_sweep.osc_best_range = (int)range_idx;
    g_sweep.adc_tried[range_idx] = true;

    g_phase = "lock-osc";
    sample_t o = measure_osc_range(range_idx);
    if (o.valid) samples[n++] = o;

    g_phase = "lock-adc";
    sample_t a = measure_adc_range(range_idx);
    if (a.valid) samples[n++] = a;

    g_phase = "fuse";
    evt_sweep();
    return fuse_samples(samples, n);
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
// Shared oscillator bring-up / calibration helpers.
//
// These compile in BOTH builds: the OSC debug console drives them directly,
// while the normal autoranging firmware services them from its UART command
// pump (console_handle_hw below), so the user can tare/calibrate while
// measuring.  Only the two app_main() entry points remain mode-specific.
// ---------------------------------------------------------------------------
static volatile uint32_t dbg_edges = 0;
static volatile uint32_t dbg_isr_calls = 0;

static void IRAM_ATTR dbg_isr(void *arg)
{
    (void)arg;
    dbg_isr_calls++;
    if (!osc_running) return;
    // Same rate limit as the production ISR: never let the loop starve the CPU.
    uint32_t now32 = (uint32_t)esp_timer_get_time();
    if (osc_last_edge_us != 0 &&
        (uint32_t)(now32 - osc_last_edge_us) < OSC_MIN_EDGE_INTERVAL_US) {
        osc_running = false;
        gpio_set_level(DRIVE_PIN, 0);
        return;
    }
    osc_last_edge_us = now32;
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
        // Same reconstruction as measure_osc_range(): invert the C_block series
        // combo, then (un-tared only) subtract the nominal stray.  NOTE: f above
        // is a raw 100 ms PCNT snapshot for hardware bring-up, NOT the reciprocal
        // estimator the measurement uses, so this figure is indicative only.
        double c_total = cblock_invert(c_eq);
        double c = (c_total < 0.0) ? c_total
                                   : (use_t0 ? c_total : (c_total - STRAY_CAPACITANCE_F));
        if (c < 0.0)
            printf("  -> implied C = out of range (C_eq ≥ C_block)\n");
        else
            printf("  -> implied C = %.3f nF  (K=%.4f %s=%.2fus R=%s%s)\n",
                   c * 1e9, osc_k((uint8_t)range_idx), use_t0 ? "T0" : "delay",
                   off_us, RANGES[range_idx].label,
                   g_osc_cal[range_idx].valid ? " cal" : " default");
    }
    printf("-----------------\n\n");
}

static void dbg_start(void)
{
    dbg_edges = 0;
    osc_loop_start();
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
    prepare_measurement();          // isolate only; the DUT stays at its bias

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
// current range.  Returns the measured frequency, or -1 on failure.  Uses the
// same frequency path as the measurement (osc_read_freq) so the calibrated K
// and the runtime measurement stay consistent.
static double dbg_capture_point(int range_idx, double ref_pf, double *ref_c_out)
{
    *ref_c_out = ref_pf * 1e-12;
    // Identical front-end setup to measure_osc_range(): select the range's mux
    // channel, then isolate/prepare the node.  Skipping this let the capture run
    // on whatever mux channel the previous measurement left selected (the
    // console range and the physical mux can differ in normal autoranging mode),
    // so the solved K would not match the runtime measurement path.
    select_mux_channel(RANGES[range_idx].mux_channel);
    esp_rom_delay_us(5);
    prepare_measurement();
    double f = 0.0;
    uint32_t nper = 0;
    if (!osc_read_freq(&f, &nper) || f <= 0.0) {
        printf(">> no oscillation / unsafe count on %s (check loop on scope)\n",
               RANGES[range_idx].label);
        return -1.0;
    }
    // Apply the SAME acceptance gates measure_osc_range() applies, so we never
    // calibrate against a frequency the runtime would reject as too slow/fast or
    // too few edges.
    if (f < OSC_MIN_F_HZ || f > 1000000.0) {
        printf(">> CAL FAILED: %s f=%.1f Hz outside the measurement window "
               "(%.0f Hz – 1 MHz).\n", RANGES[range_idx].label, f, OSC_MIN_F_HZ);
        return -1.0;
    }
    if (nper < 4) {
        printf(">> CAL FAILED: %s only %u edges averaged (< 4).\n",
               RANGES[range_idx].label, (unsigned)nper);
        return -1.0;
    }
    printf(">> point: %s ref=%.1f pF  f=%.1f Hz  (%u periods)\n",
           RANGES[range_idx].label, ref_pf, f, (unsigned)nper);
    return f;
}

#define TARE_SAMPLES 5   // each sample is already a ~500 ms averaged period

// Tare the open-node offset T0.  With the DUT socket EMPTY, average several
// oscillator periods and store T0 ≈ K·R·C_stray + latency.  Subtracting T0 in
// the measurement removes the parasitic capacitance, which is the whole point
// of sub-nF operation.  range_or_all < 0 => every tareable range.
//
// Safety: the ISR self-limits if the loop is too fast, and the loop is disabled
// while the front-end is reconfigured and its prior state restored afterwards,
// so this is safe to run while autoranging or from the debug console.  'zeroall'
// skips the 100 Ω / 1 kΩ ranges because an EMPTY socket there self-limits (the
// bare node is far too fast); an explicit single-range tare still tries.
static void dbg_tare(int range_or_all)
{
    int first = (range_or_all < 0) ? 0 : range_or_all;
    int last  = (range_or_all < 0) ? RANGE_COUNT - 1 : range_or_all;
    bool restore_run = osc_running;   // free-run state to restore afterwards

    for (int r = first; r <= last; ++r) {
        if (range_or_all < 0 && !osc_range_tareable((uint8_t)r)) {
            printf(">> %s: skipped for tare (empty socket runs too fast here; "
                   "tare only the 100 kΩ / 1 MΩ ranges)\n", RANGES[r].label);
            continue;   // no telemetry: this range was not tared
        }

        osc_running = false;            // stop any prior loop unconditionally
        select_mux_channel(RANGES[r].mux_channel);
        esp_rom_delay_us(5);
        prepare_measurement();          // isolate only; keep the DUT bias
        vTaskDelay(pdMS_TO_TICKS(60));  // let the node settle

        double acc = 0.0;
        int got = 0;
        double k = osc_k((uint8_t)r);
        double r_ohm = RANGES[r].resistance_ohms;
        for (int kk = 0; kk < TARE_SAMPLES; ++kk) {
            // Same frequency path as the runtime measurement (500 ms reciprocal
            // on 1 MΩ) so T0 subtracts the exact estimator the measurement uses,
            // AND the same acceptance gates, so T0 is never derived from a
            // reading the runtime would reject.
            double f = 0.0;
            uint32_t nper = 0;
            if (osc_read_freq(&f, &nper) && f > 0.0 &&
                f >= OSC_MIN_F_HZ && f <= 1000000.0 && nper >= 4) {
                acc += 1e6 / f;
                got++;
                // Live tare sample for the UI strip chart (running mean).  The
                // implied stray is reconstructed exactly like a measurement:
                // run the open-node series-equivalent through cblock_invert.
                double mean = acc / (double)got;
                double ceq0 = (k * r_ohm > 0.0)
                                  ? (mean * 1e-6) / (k * r_ohm) : 0.0;
                double stray = (ceq0 > 0.0) ? cblock_invert(ceq0) * 1e12 : 0.0;
                evt_tare(r, kk, TARE_SAMPLES, f, mean, stray, 0);
            }
            esp_task_wdt_reset();
            vTaskDelay(pdMS_TO_TICKS(10));
        }
        osc_running = false;

        if (got == 0) {
            printf(">> %s: no oscillation with socket empty (check the loop)\n",
                   RANGES[r].label);
            evt_tare(r, TARE_SAMPLES, TARE_SAMPLES, 0.0, 0.0, 0.0, 1);
            continue;
        }
        double period = acc / (double)got;
        g_osc_cal[r].t0_us = period;
        g_osc_cal[r].has_t0 = true;
        esp_err_t e = osc_cal_save();
        // Implied node parasitic C, reconstructed the same way a measurement
        // does (series-equivalent → cblock_invert), not the raw T0/(K·R).
        double ceq0 = (k * r_ohm > 0.0) ? (period * 1e-6) / (k * r_ohm) : 0.0;
        double stray_pf = (ceq0 > 0.0) ? cblock_invert(ceq0) * 1e12 : 0.0;
        printf(">> %s TARE: T0 = %.2f us  (implied parasitic C = %.1f pF)  %s\n",
               RANGES[r].label, period, stray_pf,
               (e == ESP_OK) ? "saved to NVS" : "NVS SAVE FAILED");
        evt_tare(r, TARE_SAMPLES, TARE_SAMPLES,
                 period > 0.0 ? 1e6 / period : 0.0, period, stray_pf, 1);
    }

    // Restore the loop state the caller had (debug 'g' leaves it free-running).
    if (restore_run) dbg_start();
    else dbg_stop();
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
        evt_calpt(range_idx, "cal1", ref_pf, f);
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
        evt_calpt(range_idx, "cal2", ref_pf, f2);

        double k, t0;
        if (!osc_cal_solve_two_point((uint8_t)range_idx,
                                     g_cal_f1, g_cal_ref1, f2, ref_c2, &k, &t0)) {
            printf(">> CAL FAILED: two-point solve rejected (refs too similar / non-physical).\n");
            evt_calres(range_idx, "two", 0.0, 0.0, 0);
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
        evt_calres(range_idx, "two", k, t0, 1);
        g_cal_pending = false;
        return;
    }

    // One-point: solve K only, using the C_eq model (consistent with measurement).
    double ref_c;
    double f = dbg_capture_point(range_idx, ref_pf, &ref_c);
    if (f <= 0.0) return;
    evt_calpt(range_idx, "cal", ref_pf, f);
    double k = osc_cal_solve_k((uint8_t)range_idx, f, ref_c);
    if (k <= 0.0) {
        printf(">> CAL FAILED: could not solve K (f=%.1f Hz).\n", f);
        evt_calres(range_idx, "one", 0.0, 0.0, 0);
        return;
    }
    g_osc_cal[range_idx].k = k;
    g_osc_cal[range_idx].valid = true;
    esp_err_t e = osc_cal_save();
    double held = osc_has_t0((uint8_t)range_idx) ? osc_t0((uint8_t)range_idx)
                                                 : g_osc_cal[range_idx].delay_us;
    printf(">> %s ONE-POINT: K=%.5f (%s %.2f us)  ref=%.1f pF  %s\n",
           RANGES[range_idx].label, k,
           osc_has_t0((uint8_t)range_idx) ? "T0 held at" : "delay held at (no tare!)",
           held, ref_pf, (e == ESP_OK) ? "saved to NVS" : "NVS SAVE FAILED");
    evt_calres(range_idx, "one", k, held, 1);
}

// ---------------------------------------------------------------------------
// ADC (RC-step) calibration commands
// ---------------------------------------------------------------------------
// Capture the effective τ (and the asymptote V_inf used) on a range using the
// exact runtime path, so the solved R_eff matches what measure_adc_range() will
// later apply.  V_inf is returned because the chain↔effective resistance
// conversion depends on the same leakage ratio the measurement will use.
static double adc_capture_point(int range_idx, double ref_pf,
                                double *ref_c_out, double *v_inf_mv_out)
{
    *ref_c_out = ref_pf * 1e-12;
    if (v_inf_mv_out) *v_inf_mv_out = (double)g_v_inf_cache[range_idx];
    sample_t s = measure_adc_range((uint8_t)range_idx);
    // Require the SAME acceptance the runtime fusion applies (`plausible`), not
    // merely `valid`: a τ below the clean-window floor (or a stray-dominated
    // reading) is marked valid-but-not-plausible and would otherwise be used to
    // solve a calibration that the measurement itself would reject.
    if (!s.valid || !s.plausible || s.tau_us <= 0.0) {
        printf(">> ADC: no PLAUSIBLE τ on %s (ref %.4g pF out of the clean "
               "window? τ=%.1f us).\n",
               RANGES[range_idx].label, ref_pf, s.tau_us);
        return -1.0;
    }
    if (v_inf_mv_out) *v_inf_mv_out = s.v_inf_mv;   // exact asymptote this τ used
    printf(">> ADC point: %s ref=%.4g pF  tau=%.1f us  Vinf=%.0f mV  R2=%.3f\n",
           RANGES[range_idx].label, ref_pf, s.tau_us, s.v_inf_mv, s.fit_r2);
    return s.tau_us;
}

static bool   g_adccal_pending = false;
static int    g_adccal_range = -1;
static double g_adccal_tau1 = 0.0;
static double g_adccal_ref1 = 0.0;
static double g_adccal_v_inf1 = 0.0;

// 'adccal <ref_pF>'                      — one-point: solve R_chain (C0 estimated)
// 'adccal1 <ref_pF>' then 'adccal2 <ref_pF>' — two-point: solve R_chain AND C0
static void dbg_adccal(int range_idx, const char *cmd, double ref_pf)
{
    bool two_first  = (strncmp(cmd, "adccal1", 7) == 0);
    bool two_second = (strncmp(cmd, "adccal2", 7) == 0);

    if (two_first) {
        double ref_c, v_inf = 0.0;
        double tau = adc_capture_point(range_idx, ref_pf, &ref_c, &v_inf);
        if (tau <= 0.0) { g_adccal_pending = false; return; }
        g_adccal_pending = true;
        g_adccal_range = range_idx;
        g_adccal_tau1 = tau;
        g_adccal_ref1 = ref_c;
        g_adccal_v_inf1 = v_inf;
        evt_adccalpt(range_idx, "adccal1", ref_pf, tau);
        printf(">> ADC point 1 captured on %s (Vinf=%.0f mV). Fit a DIFFERENT reference "
               "and run 'adccal2 <ref_pF>'.\n", RANGES[range_idx].label, v_inf);
        return;
    }

    if (two_second) {
        if (!g_adccal_pending || g_adccal_range != range_idx) {
            printf(">> no pending ADC point-1 for %s. Run 'adccal1 <ref_pF>' first.\n",
                   RANGES[range_idx].label);
            return;
        }
        double ref_c2, v_inf2 = 0.0;
        double tau2 = adc_capture_point(range_idx, ref_pf, &ref_c2, &v_inf2);
        if (tau2 <= 0.0) { g_adccal_pending = false; return; }
        evt_adccalpt(range_idx, "adccal2", ref_pf, tau2);

        // Solve the EFFECTIVE R_eff, then invert the leakage fold with the exact
        // same asymptote the measurement will use, so the stored *chain* R maps
        // back through adc_effective_r() to the solved effective value.
        double r_eff, c0;
        if (!adc_cal_solve_two(g_adccal_tau1, g_adccal_ref1, tau2, ref_c2, &r_eff, &c0)) {
            printf(">> ADC CAL FAILED: two-point solve rejected (refs too similar / non-physical).\n");
            evt_adccalres(range_idx, "two", 0.0, 0.0, 0);
            g_adccal_pending = false;
            return;
        }
        double v_inf = (v_inf2 > 0.0) ? v_inf2 : g_adccal_v_inf1;
        double r_chain = adc_chain_from_eff(r_eff, v_inf);
        if (r_chain <= 1.0 || r_chain > 1e7) {
            printf(">> ADC CAL FAILED: bad chain R_eff (%.2f Ω).\n", r_chain);
            evt_adccalres(range_idx, "two", 0.0, 0.0, 0);
            g_adccal_pending = false;
            return;
        }
        g_adc_cal[range_idx].r_eff_ohm = r_chain;
        g_adc_cal[range_idx].c0_f = c0;
        g_adc_cal[range_idx].valid = true;
        esp_err_t e = adc_cal_save();
        printf(">> %s ADC TWO-POINT: R_eff=%.2f Ω (nom %.0f, +%.2f series)  C0=%.1f pF  "
               "[Vinf=%.0f mV, leak-fold]  %s\n",
               RANGES[range_idx].label, r_chain, RANGES[range_idx].resistance_ohms,
               r_chain - RANGES[range_idx].resistance_ohms, c0 * 1e12, v_inf,
               (e == ESP_OK) ? "saved to NVS" : "NVS SAVE FAILED");
        evt_adccalres(range_idx, "two", r_chain, c0, 1);
        g_adccal_pending = false;
        return;
    }

    // One-point: solve the EFFECTIVE R_eff = τ / cblock_forward(C_ref), then
    // invert the leakage fold to the chain resistance.  The reference MUST pass
    // through the same C_block series transform the measurement inverts, or
    // R_eff comes out scaled by cblock_forward(C_ref)/C_ref (≈0.72 at 360 µF).
    double ref_c, v_inf = 0.0;
    double tau = adc_capture_point(range_idx, ref_pf, &ref_c, &v_inf);
    if (tau <= 0.0) return;
    evt_adccalpt(range_idx, "adccal", ref_pf, tau);
    double ceq = cblock_forward(ref_c);
    double r_eff = (ceq > 0.0) ? (tau * 1e-6) / ceq : -1.0;
    double r_chain = adc_chain_from_eff(r_eff, v_inf);
    if (r_chain <= 1.0 || r_chain > 1e7) {
        printf(">> ADC CAL FAILED: bad R_eff (%.2f Ω), ref at/above C_block?\n", r_chain);
        evt_adccalres(range_idx, "one", 0.0, 0.0, 0);
        return;
    }
    double c0 = node_stray_estimate_f((uint8_t)range_idx);
    g_adc_cal[range_idx].r_eff_ohm = r_chain;
    g_adc_cal[range_idx].c0_f = c0;
    g_adc_cal[range_idx].valid = true;
    esp_err_t e = adc_cal_save();
    printf(">> %s ADC ONE-POINT: R_eff=%.2f Ω (nom %.0f, +%.2f series)  C0=%.1f pF (est)  "
           "[Vinf=%.0f mV, leak-fold]  %s\n",
           RANGES[range_idx].label, r_chain, RANGES[range_idx].resistance_ohms,
           r_chain - RANGES[range_idx].resistance_ohms, c0 * 1e12, v_inf,
           (e == ESP_OK) ? "saved to NVS" : "NVS SAVE FAILED");
    evt_adccalres(range_idx, "one", r_chain, c0, 1);
}

// ---------------------------------------------------------------------------
// Shared interactive console
// ---------------------------------------------------------------------------
static volatile bool g_in_hw_cmd = false;   // guards re-entrant exclusive cmds

static void console_help(void)
{
    printf("Commands:\n"
           "  help                 this list\n"
           "  status | p           live oscillator / pin / frequency state\n"
           "  0-3                  select range for cal/probe/status\n"
           "  start | stop         autoranging on / off (safe boot = stopped)\n"
           "  single               measure one cycle then stop\n"
           "  precharge            SSR1+SSR3: charge C_block/N_DUT at V_BIAS (isolates after)\n"
           "  discharge            SSR2: bleed DUT/C_block to GND, then all SSRs off\n"
           "  idle                 all SSRs off; discharges only if autodischarge is on\n"
           "  autoprecharge on|off  measurement re-biases the DUT each cycle (default off)\n"
           "  autodischarge on|off  bleed the node when a session ends (default off)\n"
           "  auto?                show the auto-precharge / auto-discharge flags\n"
           "  auto                 normal mode: autorange (undo 'range')\n"
           "  range <0-3>          normal mode: lock a single range\n"
           "  zero                 tare T0 with socket EMPTY (removes parasitic C)\n"
           "  zeroall              tare 100 kΩ / 1 MΩ (oscillator ranges only)\n"
           "  cal <pF>             one-point K (uses T0 if tared)\n"
           "  cal1 <pF> | cal2 <pF> two-point K+T0 (2 different refs)\n"
           "  cal?                 show oscillator calibration table\n"
           "  calclear [0-3]       reset oscillator calibration (current range or given)\n"
           "  adccal <pF>          one-point ADC R_eff from a known cap (100 Ω/1 kΩ)\n"
           "  adccal1 <pF>|adccal2 <pF>  two-point ADC R_eff+C0\n"
           "  adccal?              show ADC calibration table\n"
           "  adccalclear [0-3]    reset ADC calibration (current range or given)\n"
           "  board?               show measured board constants (C_block/R_bias/RES bank)\n"
           "  boardset <f> <val>   override one (cblock uF | rbias ohm | r0|r1|r2|r3 ohm) + store NVS\n"
           "  boardclear           restore compiled board defaults (erase NVS override)\n"
           "  probe <0-3>          connectivity/charge probe of a range\n"
           "  stream on|off        emit @@EVT JSON telemetry\n"
           "  curve on|off         include full ADC charge curves in telemetry\n"
           "  led auto|off|<r> <g> <b>  onboard WS2812 status LED\n");
}

// Parse an on/off/1/0 argument.  Returns 1, 0, or -1 if unrecognised.
static int parse_onoff(const char *s)
{
    while (*s == ' ' || *s == '\t') ++s;
    if (!strncmp(s, "off", 3)) return 0;
    if (!strncmp(s, "on", 2))  return 1;
    if (s[0] == '1') return 1;
    if (s[0] == '0') return 0;
    return -1;
}

// Handle a hardware/calibration/telemetry command.  Returns true if recognised.
static bool console_handle_hw(const char *line)
{
    int range_idx = g_console_range;

    if (!strcmp(line, "help") || !strcmp(line, "h")) { console_help(); return true; }

    if (!strcmp(line, "g") || !strcmp(line, "r")) {
        // Allowed on any range: the ISR self-limits if the loop is too fast.
        if (!strcmp(line, "g")) { dbg_start(); printf(">> oscillator started\n"); }
        else { dbg_stop(); prepare_measurement(); dbg_start();
               printf(">> isolated+restarted\n"); }
        return true;
    }
    if (!strcmp(line, "s")) { dbg_stop(); printf(">> oscillator stopped\n"); return true; }

    // ---- Front-end safety commands (exclusive; halt measurement first) ----
    if (!strcmp(line, "precharge")) {
        g_run = false;                       // never drive SSRs under a cycle
        g_fe_charged = true; g_fe_discharged = false;
        fe_set(FE_PRECHARGE);
        front_end_idle();                    // start from a known-off state
        front_end_precharge();               // SSR1+SSR3 hold, then ISOLATE
        invalidate_vinf_cache();             // bias changed: re-measure V_inf
        fe_set(FE_PRECHARGED);
        printf(">> PRE-CHARGE: N_DUT/C_block charged; SSR1+SSR3 released (isolated).\n"
               ">> WARNING: DUT may sit at up to 20 V bias. Run 'discharge' before removing it.\n");
        evt_ack("precharge", 1, "N_DUT biased up to 20 V; discharge before removing DUT");
        return true;
    }
    if (!strcmp(line, "discharge")) {
        g_run = false;
        fe_set(FE_DISCHARGE);
        front_end_discharge();               // SSR2 to GND for >= 5 tau
        front_end_idle();
        invalidate_vinf_cache();             // bias changed: re-measure V_inf
        g_fe_charged = false; g_fe_discharged = true;
        fe_set(FE_IDLE);
        printf(">> DISCHARGE: DUT and C_block bled to GND; all SSRs off (IDLE).\n"
               ">> Safe to remove the DUT.\n");
        evt_ack("discharge", 1, "DUT discharged; safe to remove");
        return true;
    }
    if (!strcmp(line, "idle")) {
        g_run = false;
        front_end_finish();                  // auto-discharge if armed, else isolate
        printf(">> IDLE: all SSRs off, drive low.%s\n",
               g_auto_discharge ? " Node discharged." : " Bias held (run 'discharge').");
        evt_ack("idle", 1, g_auto_discharge ? "discharged + idle" : "isolated (bias held)");
        return true;
    }

    // ---- Automation flags (default OFF => manual front-end control) ----
    if (!strncmp(line, "autoprecharge", 13) || !strncmp(line, "autocharge", 10)) {
        const char *arg = line + (line[4] == 'p' ? 13 : 10);
        int v = parse_onoff(arg);
        if (v < 0) { printf(">> usage: autoprecharge on|off\n"); }
        else { g_auto_precharge = v;
               invalidate_vinf_cache();
               printf(">> auto-precharge %s\n", v ? "ON" : "OFF");
               evt_fe(); evt_ack("autoprecharge", 1, v ? "on" : "off"); }
        return true;
    }
    // NOTE: "autodischarge" is 13 chars — the argument starts at offset 13, not 12
    // (offset 12 lands on the trailing 'e', which parse_onoff then rejects).
    if (!strncmp(line, "autodischarge", 13)) {
        int v = parse_onoff(line + 13);
        if (v < 0) { printf(">> usage: autodischarge on|off\n"); }
        else { g_auto_discharge = v;
               printf(">> auto-discharge %s\n", v ? "ON" : "OFF");
               evt_fe(); evt_ack("autodischarge", 1, v ? "on" : "off"); }
        return true;
    }
    // Onboard status LED: 'led auto' returns to state animation, 'led off' blanks
// it, 'led r g b' drives a fixed colour (handy for a bench demo).
    if (!strncmp(line, "led", 3)) {
        const char *arg = line + 3;
        while (*arg == ' ') ++arg;
        if (!strncmp(arg, "auto", 4)) {
            status_led_set_auto();
            printf(">> LED auto (status indicator)\n");
            evt_ack("led", 1, "auto");
        } else if (!strncmp(arg, "off", 3)) {
            status_led_manual(0, 0, 0);
            printf(">> LED off\n");
            evt_ack("led", 1, "off");
        } else {
            int r, g, b;
            if (sscanf(arg, "%d %d %d", &r, &g, &b) == 3 &&
                r >= 0 && r <= 255 && g >= 0 && g <= 255 && b >= 0 && b <= 255) {
                status_led_manual((uint8_t)r, (uint8_t)g, (uint8_t)b);
                printf(">> LED manual r=%d g=%d b=%d\n", r, g, b);
                evt_ack("led", 1, "manual");
            } else {
                printf(">> usage: led <r> <g> <b> | led auto | led off\n");
            }
        }
        return true;
    }
    if (!strcmp(line, "auto?")) {
        printf(">> auto-precharge=%s  auto-discharge=%s\n",
               g_auto_precharge ? "on" : "off", g_auto_discharge ? "on" : "off");
        return true;
    }

    if (!strcmp(line, "zero"))    { dbg_tare(range_idx); return true; }
    if (!strcmp(line, "zeroall")) { dbg_tare(-1); return true; }

    if (!strncmp(line, "cal?", 4)) {
        printf("\n--- OSC calibration ---\n");
        for (int i = 0; i < RANGE_COUNT; ++i) {
            printf("  %-7s K=%.5f  T0=%.2f us %-9s delay=%.2f us  %s\n",
                   RANGES[i].label, g_osc_cal[i].k, g_osc_cal[i].t0_us,
                   g_osc_cal[i].has_t0 ? "(tared)" : "(no tare)",
                   g_osc_cal[i].delay_us,
                   g_osc_cal[i].valid ? "calibrated" : "default");
        }
        printf("-----------------------\n\n");
        return true;
    }

    if (!strncmp(line, "calclear", 8)) {
        int rr = range_idx;
        for (int i = 8; line[i]; ++i)
            if (line[i] >= '0' && line[i] <= '3') { rr = line[i] - '0'; break; }
        if (rr >= 0 && rr < RANGE_COUNT) {
            g_osc_cal[rr] = (osc_cal_t){OSC_K_IDEAL, OSC_DELAY_IDEAL_US, 0.0, false, false};
            osc_cal_save();
            printf(">> %s calibration cleared to defaults\n", RANGES[rr].label);
        }
        return true;
    }

    if (!strncmp(line, "cal1", 4) || !strncmp(line, "cal2", 4)) {
        double ref_pf = atof(line + 4);
        if (ref_pf <= 0.0) printf(">> usage: %s <ref_pF>\n", line);
        else dbg_calibrate(range_idx, line, ref_pf);
        return true;
    }
    if (!strncmp(line, "cal", 3)) {
        double ref_pf = atof(line + 3);
        if (ref_pf <= 0.0) printf(">> usage: cal <ref_pF>\n");
        else dbg_calibrate(range_idx, line, ref_pf);
        return true;
    }

    // ---- ADC (RC-step) series-resistance calibration ----
    if (!strncmp(line, "adccal?", 7)) {
        printf("\n--- ADC (RC-step) calibration ---\n");
        for (int i = 0; i < RANGE_COUNT; ++i) {
            if (g_adc_cal[i].valid) {
                printf("  %-7s R_eff=%.2f Ω (nom %.0f, +%.2f series)  C0=%.1f pF  calibrated\n",
                       RANGES[i].label, g_adc_cal[i].r_eff_ohm,
                       RANGES[i].resistance_ohms,
                       g_adc_cal[i].r_eff_ohm - RANGES[i].resistance_ohms,
                       g_adc_cal[i].c0_f * 1e12);
            } else {
                printf("  %-7s R_eff=%.0f Ω (nominal)  default\n",
                       RANGES[i].label, RANGES[i].resistance_ohms);
            }
        }
        printf("---------------------------------\n\n");
        return true;
    }
    if (!strncmp(line, "adccalclear", 11)) {
        int rr = range_idx;
        for (int i = 11; line[i]; ++i)
            if (line[i] >= '0' && line[i] <= '3') { rr = line[i] - '0'; break; }
        if (rr >= 0 && rr < RANGE_COUNT) {
            g_adc_cal[rr] = (adc_cal_t){0.0, 0.0, false};
            adc_cal_save();
            printf(">> %s ADC calibration cleared to nominal\n", RANGES[rr].label);
        }
        return true;
    }
    if (!strncmp(line, "adccal1", 7) || !strncmp(line, "adccal2", 7)) {
        double ref_pf = atof(line + 7);
        if (ref_pf <= 0.0) printf(">> usage: %s <ref_pF>\n", line);
        else dbg_adccal(range_idx, line, ref_pf);
        return true;
    }
    if (!strncmp(line, "adccal", 6)) {
        double ref_pf = atof(line + 6);
        if (ref_pf <= 0.0) printf(">> usage: adccal <ref_pF>\n");
        else dbg_adccal(range_idx, line, ref_pf);
        return true;
    }

    // ---- Board component constants (measured; NVS-overridable) ----
    if (!strcmp(line, "board?") || !strcmp(line, "board")) {
        printf("\n--- Board constants (%s) ---\n",
               g_board_cal_overridden ? "NVS override" : "compiled defaults");
        printf("  C_block = %.4f uF  (elec %.1f uF + HF %.1f nF)\n",
               c_block_f() * 1e6, C_BLOCK_ELEC_F * 1e6, C_BLOCK_HF_F * 1e9);
        printf("  R_bias  = %.1f kΩ\n", r_bias_ohm() / 1e3);
        for (int i = 0; i < RANGE_COUNT; ++i)
            printf("  %-7s R = %.5g Ω\n", RANGES[i].label, RANGES[i].resistance_ohms);
        printf("-----------------------------\n\n");
        return true;
    }
    if (!strncmp(line, "boardclear", 10)) {
        board_cal_reset();
        invalidate_vinf_cache();   // range resistances reverted: V_inf divider moved
        printf(">> board constants reset to compiled defaults (NVS cleared)\n");
        return true;
    }
    if (!strncmp(line, "boardset", 8)) {
        char field[16];
        double value = 0.0;
        if (sscanf(line + 8, "%15s %lf", field, &value) != 2 || value <= 0.0) {
            printf(">> usage: boardset cblock <uF> | rbias <ohm> | r0|r1|r2|r3 <ohm>\n");
            return true;
        }
        bool ok = true;
        if (!strcmp(field, "cblock"))
            g_c_block_f = value * 1e-6;                       // uF
        else if (!strcmp(field, "rbias"))
            g_r_bias_ohm = value;                             // ohm
        else if (field[0] == 'r' && field[1] >= '0' && field[1] <= '3' && field[2] == '\0')
            RANGES[field[1] - '0'].resistance_ohms = value;   // ohm
        else { ok = false; printf(">> unknown field '%s'\n", field); }
        if (ok) {
            board_cal_save();
            g_board_cal_overridden = true;
            invalidate_vinf_cache();   // R_chain/C_block changed: V_inf divider moved
            printf(">> board %s = %g (stored to NVS)\n", field, value);
            evt_ack("boardset", 1, field);
        }
        return true;
    }

    if (!strncmp(line, "probe", 5)) {
        int rr = range_idx;
        for (int i = 5; line[i]; ++i)
            if (line[i] >= '0' && line[i] <= '3') { rr = line[i] - '0'; break; }
        dbg_probe_range(rr);
        return true;
    }

    if (!strcmp(line, "status") || !strcmp(line, "p") || !strcmp(line, "?")) {
        dbg_print_state(range_idx);
        return true;
    }

    if (!strncmp(line, "stream", 6)) {
        g_stream = (strstr(line, "on") != NULL);
        printf(">> telemetry stream %s\n", g_stream ? "ON" : "OFF");
        if (g_stream) { evt_boot(); evt_fe(); }  // snapshot for the new client
        return true;
    }
    if (!strncmp(line, "curve", 5)) {
        g_stream_curve = (strstr(line, "on") != NULL);
        printf(">> curve telemetry %s\n", g_stream_curve ? "ON" : "OFF");
        return true;
    }

    if (line[0] >= '0' && line[0] <= '3' && line[1] == '\0') {
        g_console_range = (uint8_t)(line[0] - '0');
        select_mux_channel(RANGES[g_console_range].mux_channel);
        printf(">> cal/probe range = %s\n", RANGES[g_console_range].label);
        return true;
    }

    return false;
}

// True for commands that need exclusive access to the analog front-end and
// must therefore abort an in-flight measurement before running.
static bool is_exclusive_cmd(const char *line)
{
    // Front-end power commands must never run concurrently with a measurement
    // cycle: they abort the cycle first, then own the SSRs exclusively.
    if (!strcmp(line, "precharge") || !strcmp(line, "discharge") ||
        !strcmp(line, "idle")) return true;
    if (!strcmp(line, "zero") || !strcmp(line, "zeroall")) return true;
    if (!strncmp(line, "calclear", 8)) return true;
    if (!strncmp(line, "adccalclear", 11)) return true;
    if (!strncmp(line, "probe", 5)) return true;
    if (!strncmp(line, "cal", 3) && strncmp(line, "cal?", 4) != 0) return true;
    if (!strncmp(line, "adccal", 6) && strncmp(line, "adccal?", 7) != 0) return true;
    if (!strncmp(line, "boardset", 8) || !strncmp(line, "boardclear", 10)) return true;
    return false;
}

// Decide immediate vs deferred execution for one parsed line.
static void console_dispatch(const char *line)
{
    if (g_in_hw_cmd) return;   // busy running an exclusive command

    // start/stop/single only gate the autoranging loop.  Front-end power is a
// separate concern ('precharge'/'discharge'/'idle').  Stopping aborts any
// in-flight cycle so the transition is prompt.
    if (!strcmp(line, "start")) { g_run = true; g_single_shot = false;
                                  invalidate_vinf_cache();   // fresh session
                                  evt_fe();                  // run-state for the UI
                                  evt_ack("start", 1, "autoranging"); return; }
    if (!strcmp(line, "stop"))  { g_run = false;
                                  if (g_measuring) {
                                      // Defer the front-end finish until the
                                      // aborted cycle has fully unwound (the
                                      // main loop drains this flag).
                                      g_abort_cycle = true;
                                      g_fe_finish_pending = true;
                                  } else {
                                      front_end_finish();
                                  }
                                  evt_fe();                  // run-state for the UI
                                  evt_ack("stop", 1, g_auto_discharge
                                          ? "stopped; auto-discharged"
                                          : "stopped; isolated (bias held)"); return; }
    if (!strcmp(line, "single")){ g_single_shot = true; g_run = true;
                                  invalidate_vinf_cache();   // fresh session
                                  evt_fe();                  // run-state for the UI
                                  evt_ack("single", 1, "one cycle"); return; }
    if (!strcmp(line, "auto"))  { g_range_lock = -1; evt_fe();
                                  evt_ack("auto", 1, "autorange"); return; }
    if (!strncmp(line, "range", 5)) {
        int rr = g_console_range;
        for (int i = 5; line[i]; ++i)
            if (line[i] >= '0' && line[i] <= '3') { rr = line[i] - '0'; break; }
        g_range_lock = rr;
        g_console_range = (uint8_t)rr;
        select_mux_channel(RANGES[rr].mux_channel);
        printf(">> range locked to %s\n", RANGES[rr].label);
        evt_fe();
        evt_ack("range", 1, RANGES[rr].label);
        return;
    }

    if (is_exclusive_cmd(line)) {
        if (g_measuring) {
            strncpy(g_pending_cmd, line, sizeof(g_pending_cmd) - 1);
            g_pending_cmd[sizeof(g_pending_cmd) - 1] = '\0';
            g_abort_cycle = true;          // stop the cycle at its next safe point
        } else {
            g_in_hw_cmd = true;
            console_handle_hw(line);
            g_in_hw_cmd = false;
        }
        return;
    }

    if (!console_handle_hw(line)) {
        printf(">> unknown '%s' (h for help)\n", line);
    }
}

// Non-blocking UART poll: accumulate a line, dispatch on '\n'.
static void service_console(void)
{
    static char line[64];
    static int li = 0;
    uint8_t b[1];
    while (uart_read_bytes(UART_NUM_0, b, 1, 0) > 0) {
        char c = (char)b[0];
        if (c == '\r') continue;
        if (c != '\n') {
            if (li < (int)sizeof(line) - 1) line[li++] = c;
            continue;
        }
        line[li] = '\0';
        li = 0;
        if (line[0]) console_dispatch(line);
    }
}

// Delay that stays console-aware: services UART and returns early on abort.
static void safe_delay_ms(uint32_t ms)
{
    int64_t end = esp_timer_get_time() + (int64_t)ms * 1000;
    while (esp_timer_get_time() < end) {
        service_console();
        if (g_abort_cycle) return;
        esp_task_wdt_reset();
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}

// ---------------------------------------------------------------------------
#if OSC_DEBUG_MODE
// ============================================================================
//  OSC-ONLY DEBUG CONSOLE  (see OSC_DEBUG_MODE note above)
// ============================================================================
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
    board_cal_load();
    osc_cal_load();
    adc_cal_load();
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
            g_console_range = (uint8_t)(line[0] - '0');
            bool was = osc_running;
            dbg_stop();
            select_mux_channel(RANGES[g_console_range].mux_channel);
            printf(">> range=%s (K=%.5f %s=%.2fus %s%s)\n", RANGES[g_console_range].label,
                   osc_k(g_console_range),
                   osc_has_t0(g_console_range) ? "T0" : "delay",
                   osc_has_t0(g_console_range) ? osc_t0(g_console_range)
                                               : osc_delay(g_console_range),
                   g_osc_cal[g_console_range].valid ? "cal" : "default",
                   osc_has_t0(g_console_range) ? " tared" : "");
            // Resume a previously free-running oscillator on the new range; the ISR
            // self-limits if the loop is too fast.
            if (was) dbg_start();
        } else if (!strcmp(line, "g") || !strcmp(line, "r")) {
            if (!strcmp(line, "g")) {
                dbg_start(); printf(">> STARTED (drive=%d)\n", gpio_get_level(DRIVE_PIN));
            } else {
                dbg_stop(); prepare_measurement(); dbg_start();
                printf(">> isolated+restarted\n");
            }
        } else if (!strcmp(line, "s")) {
            dbg_stop(); printf(">> STOPPED\n");
        } else {
            console_dispatch(line);
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
    board_cal_load();
    osc_cal_load();
    adc_cal_load();

    // Interactive command pump on UART0 — the same console the debug build uses,
    // so normal mode can tare/calibrate while autoranging.
    uart_driver_install(UART_NUM_0, 1024, 0, 0, NULL, 0);

    ESP_LOGI(TAG, "ESP32 fusion capacitance meter ready (interactive autoranging)");
    for (int i = 0; i < RANGE_COUNT; ++i) {
        if (g_osc_cal[i].valid || g_osc_cal[i].has_t0) {
            ESP_LOGI(TAG, "  %s: K=%.5f %s=%.2f us (%s%s)",
                     RANGES[i].label, g_osc_cal[i].k,
                     g_osc_cal[i].has_t0 ? "T0" : "delay",
                     g_osc_cal[i].has_t0 ? g_osc_cal[i].t0_us : g_osc_cal[i].delay_us,
                     g_osc_cal[i].valid ? "calibrated" : "default K",
                     g_osc_cal[i].has_t0 ? ", tared" : "");
        }
        if (g_adc_cal[i].valid) {
            ESP_LOGI(TAG, "  %s: ADC R_eff=%.2f Ω (nom %.0f, +%.2f series) C0=%.1f pF",
                     RANGES[i].label, g_adc_cal[i].r_eff_ohm,
                     RANGES[i].resistance_ohms,
                     g_adc_cal[i].r_eff_ohm - RANGES[i].resistance_ohms,
                     g_adc_cal[i].c0_f * 1e12);
        }
    }
    printf("\n=== CAP METER (normal mode) ===\n"
           "Boots IDLE. Type 'h' for commands: start/stop/single, "
           "precharge/discharge/idle, range/auto, zero/zeroall, cal/cal1/cal2, "
           "adccal/adccal1/adccal2, probe, stream/curve, led <r> <g> <b>|auto|off.\n"
           "Enable machine telemetry with 'stream on' (append 'curve on' for ADC curves).\n\n");

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

    // Boots IDLE: g_run is false, so no measurement or SSR activity starts
    // until the operator (or dashboard) issues 'start'.  Front-end power is
    // controlled separately by precharge/discharge/idle, which always halt
    // measurement first (see console_dispatch / is_exclusive_cmd).

    while (true) {
        service_console();

        // Run a deferred exclusive command that was queued mid-cycle.
        if (g_pending_cmd[0] != '\0') {
            char line[64];
            strncpy(line, g_pending_cmd, sizeof(line) - 1);
            line[sizeof(line) - 1] = '\0';
            g_pending_cmd[0] = '\0';
            g_abort_cycle = false;
            g_in_hw_cmd = true;
            console_handle_hw(line);
            g_in_hw_cmd = false;
            continue;
        }

        if (!g_run) {
            if (g_fe_finish_pending) {       // deferred finish after a 'stop'
                g_fe_finish_pending = false;
                front_end_finish();
            }
            safe_delay_ms(100);
            continue;
        }

        if (g_fe_state != FE_MEASURING) {
            // Only claim the DUT is "charged" if a bias is actually applied.
            // With auto-precharge OFF and no manual precharge, the measurement
            // runs unbiased and this must stay false or the dashboard safety
            // warning lies about the front-end state.
            if (g_auto_precharge) { g_fe_charged = true; g_fe_discharged = false; }
            fe_set(FE_MEASURING);
        }

        g_phase = "auto";
        g_measuring = true;
        int64_t t_cycle = esp_timer_get_time();
        fusion_t result = (g_range_lock >= 0)
                              ? measure_locked_range((uint8_t)g_range_lock)
                              : measure_capacitance_autoranged();
        g_measuring = false;
        g_last_cycle_ms = (uint32_t)((esp_timer_get_time() - t_cycle) / 1000);
        g_cycle_count++;

        if (g_abort_cycle) {   // an exclusive command cut this cycle short
            g_abort_cycle = false;
            continue;
        }

        log_result(&result);
        status_led_report_result(&result);   // green/amber/red result flash
        evt_cycle(&result);
        evt_fuse(&result);
        evt_stat();

        if (g_single_shot) { g_single_shot = false; g_run = false;
                             front_end_finish(); evt_fe(); }

        safe_delay_ms(1000);
    }
}
#endif // OSC_DEBUG_MODE
