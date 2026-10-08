# Project Handoff: ESP32 Autoranging Capacitance Meter

**Architecture Transition:** STM32G431CBU6 to ESP32
**Current State:** Dual-Mode Firmware Integration Complete (ADC + LM393 Oscillator)

## 1. Hardware Architecture Updates

The front-end has been successfully decoupled from the STM32's internal analog peripherals and adapted for the ESP32 using external discrete components.

* **DC Bias Isolation ($C_{block}$):** The 936 µF bulk blocking capacitor (with a 67.8 nF ceramic HF bypass across it) is fully integrated, isolating the 3.3V logic domain from the 0–20V external DC bias domain. The ESP32 ADC and drive pins sit safely at a 0V DC baseline.
* **External Schmitt Trigger:** An LM393 comparator replaces the STM32 COMP1. It is configured with a 1.65V mid-point reference (10 kΩ / 10 kΩ divider), a 100 kΩ positive feedback resistor for hysteresis, and a 10 kΩ pull-up on the open-collector output.
* **Excitation Buffer:** An SN74LVC1G34 push-pull buffer is driven by the ESP32 to provide sharp, low-impedance 3.3V step excitation to the RC network.

## 2. Firmware Control State

The system now supports a hybrid measurement approach, automatically routing based on the transient response of the RC network.

* **ADC RC-Step Mode (Large Capacitors):** Routes via `GPIO10` (ADC1 Channel 9). Measures the exponential charge curve up to the 2085 mV threshold ($1\tau$). Used primarily for µF-range electrolytics.
* **Oscillator Mode (Small Capacitors):** Triggered automatically if the 1 MΩ range charges faster than 200 µs. Relies on an ISR attached to `GPIO14` to mirror the LM393 output state back to the drive pin, establishing a hardware-in-the-loop relaxation oscillator. Measures 50 full periods to calculate capacitance.
* **Bias-preserving measurement sequencing:** The measurement path **never closes SSR2**. Each range setup only resets the MCU-side $V_{cap}$ by driving it low, so a precharged $C_{DUT}$/$C_{block}$ stay at $V_{BIAS}$ through $R_{bias}$ and the DUT is measured *under* the set DC bias. With **auto-precharge** ON the path re-asserts PRE-CHARGE (SSR1+SSR3, SSR2 OFF) → ISOLATE before every reading; with it OFF the operator's manual `precharge` is preserved. The node is only bled by an explicit `discharge`, or automatically at end-of-session when **auto-discharge** is ON.

## 3. ESP32 Pin Mapping

| Sub-Circuit / Function | Component | ESP32 Pin | Direction / Mode |
| --- | --- | --- | --- |
| **LM393 Output Sense** | LM393 Pin 1 / 7 | `GPIO14` | Input (Interrupt ANYEDGE) |
| **Excitation Drive** | SN74LVC1G34 In | `GPIO16` | Output (Push-Pull) |
| **$V_{CAP}$ ADC Node** | BAT54S Clamp Node | `GPIO10` | ADC1_CHANNEL_9 |
| **Precharge Switch** | $SSR1$ & $SSR3$ | `GPIO18` | Output |
| **Discharge / Bypass** | $SSR2$ | `GPIO12` | Output |
| **Range Mux A0** | MAX4619 | `GPIO4` | Output |
| **Range Mux A1** | MAX4619 | `GPIO5` | Output |
| **Ground Return** | $V_{bias}$ Return | `GPIO3` | Output (Strictly LOW) |

## 4. Sub-nF / Parasitic-Capacitance Calibration

The oscillator node carries a fixed parasitic capacitance of ~136 pF on this
board (an open socket previously read ~124 pF after the old hardcoded −12 pF
correction), and the ADC cannot resolve sub-nF DUTs at all. The firmware now
models the oscillator as `T = K·R·C_dut + T0`, where `T0` is a **measured**
per-range open-node offset that absorbs all parasitic capacitance and fixed
latency. The old global `STRAY_CAPACITANCE_F` (12 pF) is only a fallback for
un-tared ranges.

Calibration workflow (OSC debug console, `-DOSC_DEBUG_MODE=1`):

1. `cal1 100` then `cal2 1000` on the 1 MΩ range — two-point solve of `K` and
   `T0` using two 1% C0G/NP0 references. This cancels the parasitic C exactly.
2. `zero` — alternatively, with the socket **EMPTY**, tare `T0` directly (then
   `cal 100` can solve `K` alone). `zeroall` does every usable range.
3. `cal?` to inspect the stored `K`/`T0` per range; both persist to NVS.

The ADC is now hard-gated below ~1 nF (`ADC_SUBNF_GATE_F`): a 10 pF change on
the 1 MΩ range is only ~10 µs of τ, below the sample-loop jitter, so small DUTs
are measured by the tared oscillator only.

**Oscillator frequency guard (not a range ban).** The relaxation oscillator is a
*software* loop (the ESP32 ISR mirrors the LM393 output onto the drive buffer on
every edge). The hazard is running it **too fast** for the ISR (e.g. a bare
~136 pF node on 100 Ω / 1 kΩ runs at MHz and would freeze the device), not the
range itself: a large cap on 100 Ω / 1 kΩ runs slowly and is a perfectly good
oscillator reading. So `measure_osc_range` is allowed on **all** ranges, and the
ISR carries a rate limiter (`OSC_MIN_EDGE_INTERVAL_US = 3`): if edges arrive
faster than ~166 kHz the ISR shuts the loop down itself (`osc_loop_start()` /
`osc_last_edge_us`), so it can never saturate the core. The affected sample is
simply rejected as too fast; a good-quality reading on 100 Ω / 1 kΩ is used
normally by the autoranger and fusion. `zeroall` still skips those two ranges
(an empty socket is too fast to tare; T0 is negligible for the large caps that
use them), and `dbg_tare` disables the loop while reconfiguring the front-end
and restores the previous loop state afterwards, so it is safe while autoranging.

**Longer averaging window (accuracy).** The high-frequency PCNT path now
averages over `OSC_PCNT_GATE_MS = 500 ms`, accumulating counts in 25 ms
sub-gates so the 16-bit counter can never overflow. The reciprocal path (1 MΩ
small caps) now averages over a fixed `OSC_PERIOD_MIN_WINDOW_US = 500 ms`
window (or up to `OSC_PERIOD_MAX_EDGES = 8192` / `OSC_PERIOD_TIMEOUT_US = 3 s`)
instead of only 64 edges (~8.7 ms), so ISR timestamp jitter averages down.

**ADC (RC-step) series-resistance calibration.** The RC-step measures
`τ = R_eff·(C_dut + C0)` with `R_eff = R_nom + R_series` (buffer Zo + mux Ron +
wiring). On the 100 Ω / 1 kΩ ranges `R_series` is a large fraction of `R_nom`
(tens of ohms), so the ADC used to over-read C by `(R_nom+R_series)/R_nom`; the
oscillator absorbed this in its calibrated `K`, but the ADC had no equivalent.
The firmware now stores a measured `R_eff` and offset `C0` per range in NVS
(`adc_cal` namespace) and applies them in `measure_adc_range()`. Calibrate with
known low-ESR film references whose τ lands in the clean window
(`ADC_STEP_THRESHOLD_US = 250 µs` … 20 ms): on 100 Ω use ~10–100 µF, on 1 kΩ use
~1–10 µF. Commands: `adccal <pF>` (one-point `R_eff = τ/C_ref`, `C0` seeded from
the oscillator tare), `adccal1 <pF>` then `adccal2 <pF>` (two-point, solves
`R_eff` and `C0`), `adccal?`, `adccalclear [0-3]`. Calibration captures τ through
the exact runtime path (`measure_adc_range`), and `s.tau_us` now holds the true
effective τ (fallback-corrected) so calibration and measurement stay consistent.

**ADC τ estimator (voltage-domain nonlinear fit).** τ is no longer extracted by
linearising `ln(V_inf − V)` and taking the OLS slope. That assumed the asymptote
`V_inf` was known exactly, but `V_inf` comes from a coarse settle loop and τ is
very sensitive to its error (a ~60 mV asymptote bias produced ~−7 % τ error in
the synthetic model). `measure_adc_range()` now fits the curve in the *voltage*
domain, solving `V_inf` jointly with τ and the effective origin `t0` via a damped
Gauss–Newton (Levenberg–Marquardt) fit of
`V(t) = V_inf − (V_inf − V0)·e^(−(t−t0)/τ)`, with `V0` sampled at the step edge.
The fitted `V_inf` is fed back into the per-range asymptote cache (it is a better
estimate than the settle loop), the capture window extends to 90 % of `V_inf`,
and the 100 kΩ / 1 MΩ ranges oversample 4× per stored point to beat down ADC
noise. Goodness of fit is reported in the voltage domain (RMSE) and the τ
standard error from the fit covariance down-weights poorly-constrained samples in
the quality score. `@EVT curve` now also carries `v0`/`t0_us` so the dashboard
ghost line renders the exact fitted model; `@EVT sample` carries `rmse_mv` and
`tau_unc_us`. `host/fit_analysis.py` reproduces both estimators offline: on
synthetic curves with a biased asymptote the new fit is ~0 % biased / ~0.25 %
spread versus ~−7 % / ~4.5 % for the old one, and it can replay saved recordings.

**Tare must use the measurement path.** `dbg_tare` and `dbg_capture_point`
previously measured the period with `dbg_measure_freq()` (a 20 ms PCNT gate),
while `measure_osc_range()` uses `osc_measure_frequency()` (quick PCNT, then a
500 ms reciprocal window on 1 MΩ). The two estimators differed by a fixed few
µs, so the difference survived the T0 subtraction and appeared as a constant
offset — an open 1 MΩ socket read ~3 pF and a 10 pF DUT read ~12.8 pF (the
*delta* was correct). Both now call `osc_read_freq()`, which primes the loop and
uses `osc_measure_frequency()` — the identical path and window as the runtime
measurement — so T0 cancels exactly. `dbg_measure_freq` was removed. Tared
ranges also now allow a ~0 pF reading: small negative excursions around the tare
baseline are clamped to 0 (not rejected), the tared noise floor is 0, and the
tared `q_stray` term is 1.0 so an open socket reports ~0 pF instead of failing.

### Board component constants (measured)

The physical component values are now the **measured** values of this unit, not
the nominal BOM values. They live as `#define` defaults near the top of
`src/main.c` and feed both the C_block series-recovery math and the per-range
`K`/`R_eff` calibration:

| Constant | Measured | Nominal |
| --- | --- | --- |
| `C_BLOCK_ELEC_F` | 936 µF | 1000 µF |
| `C_BLOCK_HF_F` | 67.8 nF | 100 nF |
| `RES_100_OHM` | 98.9 Ω | 100 Ω |
| `RES_1K_OHM` | 993.6 Ω | 1 kΩ |
| `RES_100K_OHM` | 98.6 kΩ | 100 kΩ |
| `RES_1M_OHM` | 1.01 MΩ | 1 MΩ |
| `R_BIAS_OHM` (Rblock) | 4.8 MΩ | 4.7 MΩ |

A per-unit override can be stored in NVS (namespace `board_cal`) without a
reflash:

* `board?` — show the effective values and whether NVS or the compiled defaults
  are active.
* `boardset cblock <µF>` / `boardset rbias <Ω>` / `boardset r0|r1|r2|r3 <Ω>` —
  override one value and persist it.
* `boardclear` — restore the compiled defaults and erase the NVS override.

## 5. Interactive Normal Mode & Web Dashboard

Normal mode (the default build, `OSC_DEBUG_MODE 0`) is now interactive as well
as autoranging. It installs a UART0 driver, runs a cooperative command pump, and
keeps measuring by default. Exclusive commands (`zero`, `cal*`, `probe`) abort
the in-flight cycle at the next safe point and then run.

Commands (type `h`): `start/stop/single`, `precharge`, `discharge`, `idle`,
`autoprecharge on|off`, `autodischarge on|off`, `auto?`, `auto`, `range <0-3>`,
`zero`, `zeroall`, `cal <pF>`, `cal1/cal2 <pF>`, `cal?`, `calclear`,
`probe <0-3>`, `status`, `stream on|off`, `curve on|off`,
`led <r> <g> <b> | auto | off`.

Front-end power is deliberately **not** tied to `start`/`stop`. `start`/`stop`
only gate autoranging; `precharge`/`discharge`/`idle` drive the SSRs. Toggling
either automation flag from the dashboard is likewise non-exclusive. The device
**boots IDLE** (`g_run = false`, both automation flags OFF) — it does not
measure, charge, or discharge until instructed. SSR1 (pre-charge) and SSR3
(V_cap clamp) share one GPIO, so charging always clamps V_cap.

Automation flags (runtime, default **OFF**, not persisted):
* `autoprecharge` / `autocharge` — when ON, every measurement re-biases the DUT
  (`prepare_measurement()` runs PRE-CHARGE with SSR2 off, then ISOLATE). When
  OFF, measurements never touch the bias and the operator must run `precharge`.
* `autodischarge` — when ON, a session end (`single`, `stop`, `idle`) bleeds the
  node; when OFF, those leave the bias held and require an explicit `discharge`.

`cal*`/`adccal*`/`probe`/`zero` all keep the bias too (they call the same
bias-preserving `prepare_measurement()`). The firmware emits
`@@EVT {"t":"fe",...}` with the state, SSR pin levels, `charged`/`discharged`
and `auto_pre`/`auto_dis` flags for the dashboard.

Telemetry: with `stream on` the firmware prints single-line JSON after a
`@@EVT ` sentinel (`boot`, `cycle`, `sample`, `curve`, `tare`, `calpt`,
`calres`, `adccalpt`, `adccalres`, `fe`, `ack`). `sweep` reports the autoranging
range/method decision, `fuse` reports the per-sample fusion breakdown (weights,
median gate and fused value), and `stat` reports device health (uptime, completed
cycles, last cycle time, free heap). `cycle` and `fuse` also carry a fused
`quality` (mean quality of the post-gate population) and a `mismatch_ratio`
(hi/lo of the ADC vs OSC estimates, `null` if only one method ran) — the trust
view consumes these directly. `fe` also reports the autoranging run-state
(`run`/`single`/`lock`, re-emitted on `start`/`stop`/`single`/`auto`/`range`),
so the precision view can hold — rather than fade as "stale" — when the device is
intentionally stopped. `curve on` adds the full ADC
charge curve (the host stores the latest and replays it to reconnecting
clients). Human `ESP_LOG`
lines are emitted alongside and are unaffected.

A local web dashboard lives in `host/` (FastAPI + WebSocket + vendored uPlot):

```bash
host/run.sh          # autodetects /dev/ttyACM*; open http://127.0.0.1:8000
```

It owns the serial port, renders live capacitance/spread/frequency/τ/curve/
calibration/tare charts (fed only by real telemetry), and exposes the
calibration commands plus a raw command console and CSV export. A second,
radical-transparency bench view (hero + trust translation + step timeline, with
progressively disclosed diagnostics) is served at `/precision`. See
`host/README.md`.

### Onboard status LED (WS2812)

The Freenove ESP32-S3 WROOM carries a single addressable WS2812 (GRB) on
**GPIO48**. It is driven from an RMT TX channel using the built-in copy encoder
(the firmware precomputes the 24 bit-slots + reset as `rmt_symbol_word_t`, so the
CPU never bit-bangs), and animated by a dedicated low-priority task. The LED is a
live front-panel indicator for the bench and the demo:

| State | LED |
| --- | --- |
| boot | R → G → B flourish, then live |
| IDLE, discharged (safe to touch) | calm blue breathe |
| PRE-CHARGE | amber pulse |
| ISOLATE / biased (`FE_PRECHARGED`, incl. after a stop) | **steady red** — do not touch the DUT |
| MEASURING | breathes the **active range colour** (100 Ω red, 1 kΩ amber, 100 kΩ blue, 1 MΩ green — same tokens as the dashboard) |
| DISCHARGE | green pulse |
| after each cycle | 300 ms flash: green (clean) / amber (low confidence or ADC–OSC mismatch) / red (cycle rejected) |
| FAULT (reserved) | red blink |

**Persistent node charge state.** "All SSRs off" does *not* mean discharged: with
SSR2 off the DUT/C_block stay at `V_BIAS` through `R_bias`. So the charge state is
tracked independently of the momentary phase (`g_fe_charged` / `g_fe_discharged`)
and reported in `@@EVT fe` both as booleans and as a single `"charge"` string
(`"charged"` / `"discharged"` / `"unknown"`). `front_end_finish()` now ends in
`FE_PRECHARGED` (not `FE_IDLE`) when the node is still charged and auto-discharge
is OFF, so **a stop keeps reporting "charged"** and the LED stays **red** until an
explicit `discharge`. An explicit `discharge` (or auto-discharge) sets
`charge=discharged` and returns the LED to blue.

`led auto` restores state animation, `led off` blanks it, and `led <r> <g> <b>`
holds a fixed colour for a demo. Build-time overrides:
`-DSTATUS_LED_GPIO=<n>` and `-DSTATUS_LED_ENABLE=0`.

Driver notes (do not regress):
- The WS2812 frame is 25 RMT symbols; `mem_block_symbols = 64` gives 48-symbol
  ping-pong halves, so the frame completes with only the final TX-done event and
  no mid-frame threshold interrupt.
- The animation task is **non-blocking**: it starts a frame only when the
  previous frame's `on_trans_done` callback has fired, otherwise it holds the
  last colour. It never calls `rmt_tx_wait_all_done()` (that produced
  `rmt: ... flush timeout` spam) and never queues a second frame while one is in
  flight (`trans_queue_depth = 1`).
- The transmit buffer is a static `rmt_symbol_word_t[25]`, **not** a stack
  buffer, so a queued transaction can never read a stale stack frame.
- Leave `intr_priority = 0` (auto). Forcing RMT to level 3 preempted the
  FreeRTOS tick and starved IDLE0, tripping the task watchdog
  (`task_wdt: IDLE0 did not reset ... CPU 0: status_led`).
- **The LED task is pinned to core 1** (`xTaskCreatePinnedToCore(..., 1)`), and
  `rmt_new_tx_channel()` is called from *inside* that task so the RMT interrupt
  is also allocated on core 1.  The whole LED subsystem is therefore off CPU 0
  and cannot starve the measurement task, the FreeRTOS tick or IDLE0.

## 6. Pending Action Items & Validation Required

* **Tune Oscillator K-Factor:** Still needs the two-point `cal1`/`cal2` run
  described in §4 with 1% C0G/NP0 references (e.g. 100 pF, 1 nF) to set the
  real geometry constant `K` and offset `T0`.
* **ISR Latency Profiling:** The ESP32 FreeRTOS ISR has higher latency than a bare-metal STM32 interrupt. If the loop delay introduces significant non-linearity at sub-100 pF ranges, the feedback loop may need to be offloaded entirely to a hardware gate (e.g., routing the LM393 output directly into the SN74LVC1G34 buffer via a digital switch).
* **ADC Curve Fitting Verification:** The τ fit is now a voltage-domain nonlinear
  least-squares (see §4), which removes the old sensitivity to the eFuse/asymptote
  estimate. The remaining item is the `esp_adc_cali_scheme_curve_fitting` raw→mV
  mapping itself: confirm the eFuse curve is accurate near the top of the window
  (the ESP32 ADC is nonlinear above ~2.45 V) and, if not, add a per-board
  gain/offset correction on top of it. Continuous-DMA ADC acquisition (fixed
  sample rate, hardware timestamps) is the next timing-accuracy step and is still
  to be implemented.
* **Leakage Current Check:** Validate that the 10 kΩ pull-up on the LM393 and the BAT54S leakage do not bleed charge into the RC node during the 600 ms dielectric soak phase.