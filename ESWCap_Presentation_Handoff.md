# ESWCap Presentation Handoff & Deck Blueprint

**How to use this handoff.** You are the model that will build a slide deck about this project. This document is your **single source of truth**. It contains (1) the presenter's confirmed preferences, (2) an exhaustive extraction of every fact, number, pin, part, and formula in the project, and (3) a slide-by-slide blueprint plus style guide. Do **not** invent facts. If a value is marked `[UNKNOWN — confirm with user]`, surface it to the user rather than guessing. Follow the slide plan and style rules exactly unless the user overrides them. This deck covers the **ESP32-based** system; the earlier STM32 design is intentionally out of scope.

> Extraction basis: repository HEAD `96aa563` plus uncommitted working-tree versions of `src/main.c`, `HANDOVER.md`, `host/README.md`, `host/static/*`, and `references/`. If facts were discussed in chat but never written to these files, they are absent here and should be added manually.

---

## PART 1 — CONFIRMED PRESENTER PREFERENCES (Phase 1)

| # | Preference | Choice |
| --- | --- | --- |
| 1 | Audience | University examiners / lecturer |
| 2 | Goal | Grade / evaluation |
| 3 | Technical depth | Moderate — concepts + key specs, not deep math |
| 4 | Length | 12–15 slides, ~10–12 minutes |
| 5 | Speaker notes | Yes — brief bullet cues |
| 6 | Structure | No mandated template; deck model proposes flow |
| 7 | Must-include topics | Hardware & circuit design; Autoranging logic; Firmware & software; UI / display; Design decisions & problems; Measurement theory & formulas |
| 8 | Kept brief / omitted | Skip the STM32→ESP32 migration history; no debugging "war stories" |
| 9 | Code | Pseudocode only (no real code on slides) |
| 10 | Supporting sections | Future work; Failures & debugging as short factual cause→fix |
| 11 | Not selected (exclude) | Cost/BOM; References; Team credits; a standalone "Problem & motivation" slide |
| 12 | Section order | Deck model proposes |
| 13 | Demo placement | A teaser/hero near the start **and** a closing demo slide |
| 14 | Tone | Conversational |
| 15 | Density | Short bullets, ≤6 per slide |
| 16 | Units/notation | Engineering style: `10 kΩ`, `1 µF`, `136 pF` (symbols, space before unit) |
| 17 | Language | US English |
| 18 | Palette | Light academic: white background, dark slate text, navy `#1F3A5F` primary, teal `#0E8A78` accent, amber `#C77700` warning |
| 19 | Required visuals | RC charge curve; circuit/block diagram; autoranging flowchart; dashboard screenshot |
| 20 | Exclusions | Hide incomplete features — anything unvalidated appears only under Future work |
| A | Debugging rule | Include design problems/fixes as a **short factual cause→fix presentation**, no narrative |
| B | Extra slides | Add a **Results / validation** slide (no separate Problem & motivation slide) |
| D | Metadata | Course, author/team, institution, date → use placeholders |

---

## PART 2 — EXHAUSTIVE PROJECT EXTRACTION

### 2.1 Project overview

| Field | Value | Status |
| --- | --- | --- |
| Name | ESWCap — ESP32-S3 Autoranging Capacitance Meter (Multi-Range / Multi-Method Fusion) | CONFIRMED |
| One-line description | A capacitance meter that treats every (range, method) pair as an independent sensor, scores each sample with a physics-based quality metric, and fuses all plausible samples into one high-confidence estimate. | CONFIRMED |
| Problem it solves | Accurately measuring capacitance over a very wide range (pF to hundreds of µF) where no single range or method is accurate everywhere. | CONFIRMED |
| Core idea | Hybrid measurement: ADC RC-charge-timing (τ) for larger capacitors + LM393 hardware-in-the-loop relaxation oscillator for small capacitors; automatic range/method selection; weighted fusion. | CONFIRMED |
| Original platform | STM32G431CBU6 (replaced by ESP32) | CONFIRMED (excluded from deck by user choice #8) |
| Current platform | ESP32-S3 (Freenove ESP32-S3 WROOM), ESP-IDF framework | CONFIRMED |
| Scope | Firmware (`src/main.c`), autoranging/fusion engine, calibration/NVS persistence, interactive UART console, local web dashboard (`host/`) | CONFIRMED |
| Outside scope | Enclosure design, manufacturing, cost analysis | [UNKNOWN — confirm with user] |

### 2.2 Requirements & specifications

| Spec | Value | Status |
| --- | --- | --- |
| Range resistors | `100 Ω`, `1 kΩ`, `100 kΩ`, `1 MΩ` | CONFIRMED |
| Number of ranges | 4 (`RANGE_COUNT = 4`) | CONFIRMED |
| ADC channel | ADC1 `ADC_CHANNEL_9`, on `GPIO10` | CONFIRMED |
| ADC attenuation | `ADC_ATTEN_DB_12` (≈ 0–3.3 V input span) | CONFIRMED |
| ADC bit width | `ADC_BITWIDTH_DEFAULT` (12-bit) | CONFIRMED |
| ADC calibration scheme | `esp_adc_cali_scheme_curve_fitting` (eFuse-based) | CONFIRMED (verification pending) |
| External DC bias domain | 0–20 V | CONFIRMED |
| Logic domain | 3.3 V, 0 V DC baseline on ESP32 side | CONFIRMED |
| Blocking cap `C_block` | `936 µF` measured (`1000 µF` nominal) `∥ 67.8 nF` HF bypass | CONFIRMED |
| Parasitic node capacitance | ~`136 pF` (open socket) | CONFIRMED (measured on this board) |
| ADC τ clean window | `250 µs` ≤ τ ≤ `4 s` for ADC range selection; quality plateau `200 µs`–`20 ms` | CONFIRMED |
| Oscillator confirmation window | predicted `100 Hz`–`15000 Hz`; sweet spot `2000 Hz` | CONFIRMED |
| Oscillator minimum frequency | `20 Hz` | CONFIRMED |
| Target periods per oscillator reading | `50` | CONFIRMED |
| ADC timeouts | `5 s` (fast/high-R ranges) and `15 s` (100 Ω / 1 kΩ) | CONFIRMED |
| Oscillator timeout (legacy constant) | `2 s` | CONFIRMED |
| Measurement update cadence | one cycle then `1000 ms` delay between cycles (normal mode) | CONFIRMED |
| Overall accuracy target | [UNKNOWN — confirm with user] | UNKNOWN |
| Resolution target | Sub-pF claimed on oscillator ranges with tare; otherwise [UNKNOWN — confirm with user] | PARTIAL |
| Power supply / power consumption | Not discussed | Not discussed |
| Physical size / enclosure | Not discussed | Not discussed |

### 2.3 Hardware

| Component | Value / part | Purpose | Status |
| --- | --- | --- | --- |
| MCU / dev board | ESP32-S3, Freenove ESP32-S3 WROOM | Main controller | CONFIRMED |
| Alt board config present | `sdkconfig.4d_systems_esp32s3_gen4_r8n16` (4D Systems ESP32-S3 gen4 R8N16) | Alternative board support file | CONFIRMED (not the production env) |
| Comparator | LM393 | External Schmitt trigger / oscillator comparator | CONFIRMED |
| Buffer | SN74LVC1G34 | Push-pull 3.3 V step excitation driver | CONFIRMED |
| Analog mux | MAX4619 | Range-resistor selection (channels 0–3) | CONFIRMED |
| Clamp | BAT54S | Dual Schottky clamp on V_cap node | CONFIRMED |
| Blocking cap | `936 µF` measured (`1000 µF` nominal) (`C_block`) | DC isolation between 3.3 V logic domain and 0–20 V bias domain | CONFIRMED |
| Range resistors | `100 Ω`, `1 kΩ`, `100 kΩ`, `1 MΩ` | RC range selection | CONFIRMED |
| Bias hold resistor | `4.8 MΩ` measured (`4.7 MΩ` nominal) (`R_bias`) | Holds N_DUT at external bias | CONFIRMED |
| Comparator reference divider | `10 kΩ` / `10 kΩ` to `1.65 V` midpoint | LM393 reference | CONFIRMED |
| Comparator hysteresis | `100 kΩ` positive feedback | Hysteresis | CONFIRMED |
| Comparator pull-up | `10 kΩ` on open-collector output | Output pull-up | CONFIRMED |
| Precharge switch | `SSR1` (V_BIAS → `10 Ω` → N_DUT) | Charging DUT/C_block at bias | CONFIRMED |
| Discharge switch | `SSR2` (N_DUT → `100 Ω` → GND) | Bleed DUT/C_block | CONFIRMED |
| V_cap clamp switch | `SSR3` (V_cap → `1 Ω` → GND) | Clamp V_cap while precharging | CONFIRMED |
| Display model | No physical display. User interface is the UART console + local web dashboard | CONFIRMED |
| Enclosure | Not discussed | Not discussed |

### 2.4 Circuit design

**Pin map (verbatim from `src/main.c`):**

| Sub-circuit / function | Component | ESP32 pin | Direction / mode |
| --- | --- | --- | --- |
| Ground return (`V_bias` return) | V_bias return | `GPIO3` | Output (strictly LOW) |
| Range mux A0 | MAX4619 | `GPIO4` | Output |
| Range mux A1 | MAX4619 | `GPIO5` | Output |
| V_cap ADC node | BAT54S clamp node | `GPIO10` | ADC1_CHANNEL_9 |
| Discharge / bypass | SSR2 | `GPIO12` | Output |
| LM393 output sense | LM393 Pin 1 / 7 | `GPIO14` | Input (interrupt ANYEDGE, internal pull-up enabled) |
| Excitation drive | SN74LVC1G34 in | `GPIO16` | Output (push-pull) |
| Precharge switch | SSR1 & SSR3 | `GPIO18` | Output |
| (V_cap pin constant) | `VCAP_PIN` | `GPIO10` | — |

**Range/mux table:**

| Range index | Label | Resistance | Mux channel (A1:A0) |
| --- | --- | --- | --- |
| 0 | 100 Ω | `98.9` (measured) | 2 |
| 1 | 1 kΩ | `993.6` (measured) | 1 |
| 2 | 100 kΩ | `98600.0` (measured) | 0 |
| 3 | 1 MΩ | `1010000.0` (measured) | 3 |

(Note: schematic shares the 1 MΩ channel with a 100 nF HF-bypass branch; channel numbering preserved from production.)

**Signal paths (explicit):**
- ESP32 `GPIO16` drives SN74LVC1G34 → sharp low-impedance 3.3 V step into the selected range resistor → RC node (V_cap across DUT + stray).
- V_cap node is read by ADC1_CH9 (`GPIO10`), monitored by LM393 (`GPIO14`), and protected by BAT54S.
- `C_block` (`936 µF` measured, `1000 µF` nominal; with a `67.8 nF` HF bypass across it) sits in series with the DUT on the measurement path, isolating the 3.3 V logic from the 0–20 V external bias domain.
- LM393 output feeds back in software: the ESP32 ISR mirrors the comparator level onto `GPIO16`, closing a hardware-in-the-loop relaxation oscillator.
- SSR1 and SSR3 share `GPIO18` (hardware interlock: enabling precharge always clamps V_cap). SSR2 (`GPIO12`) is the only DUT ground path.

**Protection / safety:**
- BAT54S clamps V_cap transients.
- SSR3 clamps V_cap to GND (through `1 Ω`) whenever SSR1 energizes.
- SSR1 and SSR3 share one GPIO as an interlock.
- Front-end state machine: `IDLE → (PRE-CHARGE → ISOLATE) → MEASURING → DISCHARGE → IDLE`. Boots IDLE (nothing charged) — CONFIRMED.

### 2.5 Measurement principles

**Method 1 — ADC RC-step (τ) measurement:**
- Charge follows `V(t) = V_inf · (1 − e^(−t/τ))`.
- Rearranged: `ln(V_inf − V) = ln(V_inf) − t/τ` → straight line, slope `−1/τ`.
- `τ = R_eff · C_eq`, so `C_eq = τ / R_eff`.
- The node asymptotes to a **measured per-range** plateau `V_inf` (not always 3.3 V) because a parasitic pull-down (`R_bias`/leakage) forms a divider with the range resistor.
- `R_leak = V_inf · R_range / (V_NOMINAL_MV − V_inf)`; if `V_inf < 3300 − 50 mV`, then `R_eff = R_range ∥ R_leak`.
- τ crossing referenced to `63.2 %` of `V_inf`.
- Thresholds: start ≈ 10 % (`V_START_MV = 330 mV` nominal), capture past τ up to ~72 % of swing.
- Fallback (if the exponential fit fails): two-threshold crossing time divided by the log factor `ln((V_inf − V_low)/(V_inf − V_tau))`.
- Quality uses fit `R²`; a clean fit needs `R² > 0.90` for the fit path.

**Method 2 — LM393 relaxation oscillator:**
- LM393 is a **comparator with hysteresis**, not a true free-running oscillator; the ESP32 ISR closes the loop (hardware-in-the-loop).
- Model: `T = K · R · C_dut + T0`, where `T0` is a measured per-range open-node offset absorbing parasitic C + fixed latency.
- Inversion: `C_eq = (T − T0) / (K · R)`.
- Ideal constant `OSC_K_IDEAL = 1`; ideal delay `OSC_DELAY_IDEAL_US = 2.0 µs` (fallback only).
- Calibration solves `K` (one-point) or `K` and `T0` (two-point).

**Blocking-capacitor correction (series combination):**
- Forward: `C_eq = (C_block · C_dut) / (C_block + C_dut)`.
- Inversion: `C_dut = (C_eq · C_block) / (C_block − C_eq)`.
- Applied unconditionally (no minimum-capacitance gate): the forward transform is used by every calibration solver, so the inversion must be its exact algebraic inverse; rejected at/above `0.9 · C_block`.
- Correct recovery order: invert the `C_block` series combo **first**, then subtract parallel stray C.

### 2.6 Autoranging logic

**Pipeline (3 phases):**
1. **PROBE** — fast LM393 oscillator reading on the remembered range → rough capacitance for planning (no full sweep).
2. **SWEEP** — ADC τ-measurement on every range whose predicted τ lands inside the clean window, plus an oscillator run on the range minimizing `|predicted f − f_sweet|`.
3. **FUSION** — all samples weighted by quality; median-gated, log-domain weighted average.

**Selection rules:**
- ADC range tried if `tau_us ≥ 250 µs` and `tau_us ≤ 4.0e6 µs` (4 s).
- If rough C < `1 nF` (`ADC_SUBNF_GATE_F`), skip ADC entirely (oscillator owns sub-nF).
- Oscillator "best" range chosen when predicted `100 Hz ≤ f ≤ 15000 Hz`, minimizing cost `|ln(f_pred / 2000 Hz)|`.
- Oscillator is only allowed on ranges ≥ `100 kΩ` (`osc_range_usable`); 100 Ω / 1 kΩ would saturate the ISR.
- If the fastest range (100 Ω) saturates, retry on 100 kΩ.
- Linear hunt fallback if the probe fails (open DUT/huge cap): sweep ranges from 1 MΩ downward.

**Hysteresis / de-glitching:**
- Fusion median gate keeps samples within `±87.5 %` of the median (`FUSION_GATE_REL = 0.875`).
- Method mismatch alert if ADC vs OSC ratio > `1.5` (`METHOD_MISMATCH_RATIO`).
- Samples with quality `< 0.02` discarded.

**Settling / timing:**
- Precharge hold `600 ms`; discharge hold `600 ms`; isolation delay `2000 µs`.
- Wait-for-start budget: `100,000 µs + (R_range · 2.0)`.
- Cycle-to-cycle delay `1000 ms`.

### 2.7 Firmware

| Item | Value | Status |
| --- | --- | --- |
| Framework | ESP-IDF (`framework = espidf`) | CONFIRMED |
| Entry file | `src/main.c` (2605 lines) | CONFIRMED |
| Build modes | `OSC_DEBUG_MODE 0` (normal default), `1` (osc debug console) | CONFIRMED |
| Main-task stack flag | `-DCONFIG_ESP_MAIN_TASK_STACK_SIZE=8192` | CONFIRMED |
| Watchdog | Task WDT reconfigured to `60000 ms`, `trigger_panic=false` | CONFIRMED |
| NVS namespace | `"osc_cal"`; keys `k%d`, `d%d`, `v%d`, `o%d`, `t%d` (K, delay, valid, T0, has_T0) | CONFIRMED |
| NVS fixed-point | K × `1e9`; delay × `1e6`; T0 × `1e6` | CONFIRMED |
| Architecture | Single measurement/console task; cooperative UART command pump; static buffers kept off the small main stack | CONFIRMED |
| ADC config | One-shot unit ADC1, `ADC_ATTEN_DB_12`, default bitwidth, curve-fitting calibration | CONFIRMED |
| Oscillator high-f path | PCNT hardware counter, gate `500 ms`, sub-gate `25 ms`, quick gate `20 ms`, high-f threshold `10000 Hz` | CONFIRMED |
| Oscillator low-f path | Reciprocal period: min window `500000 µs` (0.5 s), max `8192` edges, timeout `3000000 µs` (3 s) | CONFIRMED |
| Curve fit | Least-squares log fit, max `48` points, drop points within `12 mV` of asymptote | CONFIRMED |
| Libraries | driver/gpio, driver/pulse_cnt, driver/uart, nvs_flash, nvs, esp_adc/adc_cali, adc_cali_scheme, adc_oneshot, esp_timer, esp_task_wdt, FreeRTOS | CONFIRMED |
| `platformio.ini` monitor | speed `115200`, `monitor_rts = 0`, `monitor_dtr = 0` | CONFIRMED |

**Quality-scoring formulas:**
- ADC time quality: full credit for `200 µs ≤ τ ≤ 20 ms`; Gaussian roll-off with σ `0.8` (fast) / `2.0` (slow) in log space.
- ADC stray quality: `q_stray = c / (c + 3·C_stray)`.
- ADC range quality: `0.85` for 100 Ω/1 kΩ, else `1.0`.
- ADC fit quality: 2-point fallback `0.6`; `R² ≥ 0.99` → `1.0`; else `0.4 + 0.6·R²`.
- OSC frequency quality: full credit `500 Hz ≤ f ≤ 10 kHz`; roll-off σ `1.2` (low) / `0.9` (high).
- OSC count quality: `1.0` if ≥ `50` periods, else `0.6 + 0.4·(n/50)`.
- OSC stray quality: tared `c/(c+0.5 pF)`; legacy `c/(c+3·C_stray)`.
- Fusion: weighted average in log domain; `rel_spread` = weighted RMS log deviation.

**Calibration:**
- One-point: `K = (T − T0) / (R · C_dut)` (uses T0 if tared).
- Two-point: `K = (T1 − T2) / (R · (C_eq1 − C_eq2))`, `T0 = T1 − K·R·C_eq1`.
- Two-point sanity: reject unless `0.01 < K ≤ 2.0` and `−100 µs ≤ T0 ≤ 200000 µs`.
- Tare: with socket empty, average 8 oscillator periods → `T0`; persisted to NVS.
- Calibration table (`cal?`) reports K, T0, tared status, delay, calibrated/default per range.

**Commands (normal mode, `h` for help):** `start`, `stop`, `single`, `auto`, `range <0-3>`, `precharge`, `discharge`, `idle`, `zero`, `zeroall`, `cal <pF>`, `cal1 <pF>`, `cal2 <pF>`, `cal?`, `calclear [0-3]`, `probe <0-3>`, `status`/`p`/`?`, `stream on|off`, `curve on|off`, `0`–`3` (select cal/probe range), `help`/`h`.

**Telemetry:** single-line JSON after the `@@EVT ` sentinel; event types `boot`, `cycle`, `sample`, `curve`, `tare`, `calpt`, `calres`, `ack`, plus `fe` (front-end state). Human `ESP_LOG` lines interleave and are unaffected.

**Pseudocode-level logic to depict (for slides):**
```text
loop:
  service_console()
  if not running: idle
  rough  = OSC probe on remembered range            # Phase 1
  ranges = [r in RANGES if tau_pred(r) in window]    # Phase 2
  samples = [ADC(r) for r in ranges] + [OSC(best_range)]
  result = fuse(samples)                             # Phase 3
```

### 2.8 User interface

- **Physical display:** none; UI = UART console + local web dashboard. (No font/color UI is defined for a native display.)
- **Dashboard stack:** FastAPI + WebSocket backend (`host/server.py`) and vanilla JS + vendored **uPlot v1.6.32** frontend (`host/static/`). Runs at `http://127.0.0.1:8000`, auto-detects `/dev/ttyACM*` or `/dev/ttyUSB*`, baud `115200`.
- **Charts:** Capacitance vs time (log); Sample spread; Oscillator frequency per range; ADC τ per range; ADC charge curve + fitted exponential; Calibration curve T vs C_ref; Tare stability T0 per range; current-cycle samples table; rolling average (instant / 3 / 5 / 10 / 20, default avg 5); front-end state badge + SSR bits; confirmation toasts.
- **Console commands** mirrored from firmware command list.
- **Dashboard dark palette (verbatim from `style.css`):**

| Token | Hex | Role |
| --- | --- | --- |
| `--bg` | `#0d1117` | page background |
| `--panel` | `#161b22` | card background |
| `--panel2` | `#1c2230` | inputs/buttons |
| `--line` | `#2b3442` | borders |
| `--text` | `#e6edf3` | primary text |
| `--dim` | `#8b949e` | secondary text |
| `--accent` | `#4ade80` | success / value |
| `--accent2` | `#60a5fa` | accent / active range |
| `--warn` | `#f59e0b` | warning |
| `--err` | `#f87171` | error |

- **Range colors (dashboard):** 100 Ω `#f87171`, 1 kΩ `#fbbf24`, 100 kΩ `#60a5fa`, 1 MΩ `#4ade80`. Rolling average series `#e6edf3`.
- **Front-end state badges:** IDLE (dim), MEASURING (blue), PRE-CHARGING (amber), CHARGED/BIASED (red), DISCHARGING (green).
- **Fonts (dashboard):** system sans (`-apple-system`, `Segoe UI`, Roboto) and monospace (`SFMono-Regular`, Consolas, Liberation Mono).
- **RGB565 values:** Not applicable — there is no RGB565 display in this project. [UNKNOWN — confirm with user if a display is planned.]

### 2.9 Testing & results

| Item | Value | Status |
| --- | --- | --- |
| Parasitic node capacitance | ~`136 pF` open-socket | CONFIRMED (measured on this board) |
| Effect of legacy −12 pF correction | open socket read ~`124 pF` | CONFIRMED |
| 10 pF DUT (before estimator fix) | read ~`12.8 pF` (~3 pF error) | CONFIRMED |
| 100 pF reference with stray added during calibration | implied ~`236 pF`; solved K ~`2.1×` too large | CONFIRMED |
| 100 kΩ small-cap oscillator frequency | ~`73 kHz` | CONFIRMED (example) |
| 1 MΩ small-cap oscillator frequency | ~`7 kHz` | CONFIRMED (example) |
| 1 MΩ + 10 pF real loop | ~`5.4 kHz` (`T ≈ 184 µs`) | CONFIRMED |
| Two-point calibration run with 1% C0G/NP0 (100 pF, 1 nF) | Not yet performed | PLANNED |
| Formal measured-vs-expected table with error % | [UNKNOWN — no recorded test table] | UNKNOWN |
| ADC curve-fit verification at 2085 mV | Pending | PLANNED |
| Leakage-check on BAT54S / 10 kΩ pull-up | Pending | PLANNED |

PASS/FAIL test methodology, reference component list used for validation, and error percentages were **not recorded** — the receiving model must not fabricate them.

### 2.10 Problems & solutions (factual cause→fix; allowed in brief per Phase 1 item A)

| # | Problem | Cause | Fix |
| --- | --- | --- | --- |
| 1 | 1 MΩ range timed out on every cap | Node asymptotes below the fixed `2085 mV` threshold due to divider droop | Measure per-range `V_inf`, set τ threshold at `63.2 %` of `V_inf` |
| 2 | ADC reported its own ~`136 pF` offset for pF DUTs | τ below poll jitter | Raised `ADC_STEP_THRESHOLD_US` `25 → 250 µs`; hard-gate ADC below `1 nF` |
| 3 | Sub-nF DUTs unmeasurable | ADC resolution limit | Oscillator owns sub-nF; `ADC_SUBNF_GATE_F = 1 nF` |
| 4 | `100 pF` ref implied ~`236 pF`; K ~`2.1×` too large | Old `12 pF` stray added before solving K | Removed stray from calibration; use measured per-range `T0` |
| 5 | Growing underestimate near `C_block` | Stray subtracted before series inversion | Invert `C_block` series first, then subtract stray |
| 6 | ~`3 pF` residual (10 pF read 12.8 pF) | Tare and measurement used different frequency estimators (20 ms PCNT vs 500 ms reciprocal) | Unified to `osc_read_freq` / `osc_measure_frequency` |
| 7 | Device freezes on fast ranges | Software oscillator at MHz floods the ISR | Restrict oscillator to ≥ `100 kΩ` |
| 8 | `zeroall` appeared to hang ~`30 s` | Loop stopped but not restarted | Save/restore `osc_running` around tare |
| 9 | Fusion outliers / ADC glitches | Single-range anomalies | Median gate `±87.5 %`; method-mismatch alert at ratio `1.5` |
| 10 | Predicted oscillator range never qualified for small DUTs | Prediction ignored `T0` | Include per-range `T0` in the period prediction |

### 2.11 Design decisions & trade-offs

| Decision | Chosen | Alternative considered | Reason |
| --- | --- | --- | --- |
| Measurement method | Hybrid ADC τ + oscillator | Single method | No single method accurate across pF–µF |
| Small-cap measurement | Tared oscillator | ADC | ADC jitter too high below ~1 nF |
| Oscillator implementation | ESP32 ISR closes the loop | True free-running hardware | LM393 here is a comparator; loop needed |
| Calibration model | Per-range `{K, T0}` | Global constants | K drifts per range (latency, hysteresis, resistor tolerance) |
| Sample combination | Median gate + log-domain weighted average | Simple mean | Robust to glitches, appropriate for multiplicative quantities |
| Large-cap correction | Series `C_block` inversion (applied unconditionally) | Ignore | Prevents underestimate approaching `C_block` |
| Calibration persistence | NVS | RAM-only | Survives reboot |
| Front-end safety | SSR state machine + shared SSR1/SSR3 pin | Software-only sequencing | Hardware interlock |
| Oscillator range restriction | ≥ 100 kΩ only | All ranges | ISR saturation on fast ranges |

### 2.12 Limitations & known issues

- Sub-nF accuracy depends on a completed tare/two-point calibration per range.
- ADC cannot resolve sub-nF DUTs; oscillator only valid on 100 kΩ / 1 MΩ.
- ESP32 FreeRTOS ISR latency is higher than bare-metal; may cause non-linearity at very high oscillator frequencies.
- ADC eFuse curve-fit mapping near the high end is unverified.
- Possible charge leakage via the 10 kΩ pull-up / BAT54S during the 600 ms soak — unverified.
- No formal accuracy/error validation recorded.

### 2.13 Cost / BOM

Not available. Component list (see §2.3) exists, but no prices, quantities, or sources were recorded. **[UNKNOWN — confirm with user]**. Per preference #11, cost/BOM is excluded from the deck anyway.

### 2.14 Future improvements

- Run two-point `cal1`/`cal2` with 1% C0G/NP0 references (e.g., `100 pF`, `1 nF`) to set real K and T0 — PLANNED.
- ISR latency profiling; possibly offload the oscillator feedback to a hardware gate — PLANNED.
- Verify ADC curve-fitting near the 2085 mV threshold — PLANNED.
- Leakage-current check on the pull-up and BAT54S — PLANNED.
- Enclosure, display, and cost analysis — Not discussed.

### 2.15 Assets (files that exist)

| Path | What it is |
| --- | --- |
| `src/main.c` | Full ESP-IDF firmware (2605 lines) |
| `src/CMakeLists.txt` | ESP-IDF component registration |
| `platformio.ini` | PlatformIO env `freenove_esp32_s3_wroom`, ESP-IDF, 115200 monitor |
| `sdkconfig.freenove_esp32_s3_wroom` | Board SDK config (ESP32-S3, 2 MB flash, 80 MHz) |
| `sdkconfig.freenove_esp32_s3_wroom.old` | Previous SDK config |
| `sdkconfig.4d_systems_esp32s3_gen4_r8n16` | Alternative-board SDK config |
| `HANDOVER.md` | Project handoff notes |
| `host/server.py` | FastAPI + WebSocket serial bridge backend |
| `host/static/index.html` | Dashboard page markup |
| `host/static/app.js` | Dashboard logic + uPlot charts (468 lines) |
| `host/static/style.css` | Dashboard dark theme |
| `host/static/vendor/uPlot.iife.min.js`, `uPlot.min.css` | Vendored uPlot v1.6.32 |
| `host/README.md` | Dashboard setup, charts, calibration workflow |
| `host/run.sh`, `host/requirements.txt` | Launcher; FastAPI/uvicorn/pyserial-asyncio deps |
| `references/index.html` | "STM32 Dual-Mode Capacitance Analyzer — Interactive Circuit" (reference schematic, external) |
| `references/…_files/{app.js,css2.css,styles.css}` | Reference page assets |
| Screenshots, board photos, or generated graphs | Not present in the repo — must be captured/produced by the deck author |

### 2.16 Glossary

| Term | Meaning |
| --- | --- |
| τ (tau) | RC time constant; time to reach 63.2 % of final value |
| V_inf | Measured per-range charge asymptote (mV) |
| C_eq | Series-equivalent capacitance the circuit actually sees (before C_block inversion) |
| C_block | `936 µF` measured (`1000 µF` nominal) series blocking/DC-isolation capacitor |
| C_stray | Parasitic node capacitance (~136 pF here) |
| T0 | Measured per-range open-node oscillator period offset (tare) |
| K | Dimensionless oscillator geometry constant; `T = K·R·C + T0` |
| Autoranging | Automatic selection of range resistor(s) and method |
| Fusion | Combining multiple (range, method) samples into one estimate |
| R² | Coefficient of determination of the exponential fit |
| ISR | Interrupt service routine |
| PCNT | ESP32 pulse-counter peripheral |
| NVS | ESP32 non-volatile storage |
| SSR | Solid-state relay (switches SSR1/SSR2/SSR3) |
| R_bias | `4.8 MΩ` measured (`4.7 MΩ` nominal) resistor holding N_DUT at bias |
| ESP-IDF | Espressif IoT Development Framework |
| uPlot | Lightweight charting library (v1.6.32, vendored) |

---

## PART 3 — DECK BLUEPRINT & STYLE GUIDE

### A) Slide-by-slide plan

Each slide lists Purpose, Content (referencing Part 2 sections), Visual, Speaker notes (brief cues, per preference #5), and What NOT to include.

---

**Slide 1 — Title**
- **Purpose:** Identify the project and presenter.
- **Content:** "ESWCap — ESP32-S3 Autoranging Capacitance Meter"; subtitle "Multi-Range / Multi-Method Fusion" (§2.1). Metadata placeholders: `[Course/Module]`, `[Author/Team]`, `[Institution]`, `[Date]` (§1-D).
- **Visual:** Clean title layout; optional small block diagram silhouette.
- **Speaker notes:** Welcome; one sentence on what it measures.
- **What NOT:** No STM32 history; no cost.

**Slide 2 — Teaser / what it does (hero)**
- **Purpose:** Hook the examiners with the end result in one glance.
- **Content:** A wide capacitance range (pF → hundreds of µF), hybrid ADC+oscillator approach, live dashboard (§2.1, §2.6, §2.8).
- **Visual:** Dashboard screenshot (asset: `host/static/index.html` render — must be captured) or a large live readout.
- **Speaker notes:** "One meter, two physics-based methods, automatically fused."
- **What NOT:** Don't claim unverified precision; don't show code.

**Slide 3 — System overview / block diagram**
- **Purpose:** Show the full signal chain at a conceptual level.
- **Content:** ESP32-S3 → SN74LVC1G34 buffer → range resistor (MAX4619) → RC node (DUT + stray) → ADC1_CH9 + LM393; C_block isolation; SSR front-end (§2.3, §2.4).
- **Visual:** Block diagram (draw; no asset exists).
- **Speaker notes:** Follow the signal left→right; note C_block isolates the 0–20 V bias domain.
- **What NOT:** No pin numbers yet (defer to Slide 6); no STM32.

**Slide 4 — Measurement theory: ADC RC-step**
- **Purpose:** Explain how τ gives capacitance.
- **Content:** `V(t)=V_inf(1−e^(−t/τ))`, fit slope `−1/τ`, `C_eq = τ/R_eff`, measured `V_inf`, 63.2 % threshold, R² quality (§2.5).
- **Visual:** RC charge curve graph with fitted exponential and τ marker (asset: dashboard "ADC charge curve" — capture, or redraw).
- **Speaker notes:** Emphasize why per-range `V_inf` matters.
- **What NOT:** Don't dive into register-level ADC calibration.

**Slide 5 — Measurement theory: LM393 oscillator**
- **Purpose:** Explain the small-capacitor method.
- **Content:** Comparator + ISR closes the loop; `T = K·R·C_dut + T0`; `C_eq = (T − T0)/(K·R)`; oscillator used only ≥ 100 kΩ (§2.5, §2.6).
- **Visual:** Loop diagram (LM393 → ESP32 ISR → buffer → RC → LM393).
- **Speaker notes:** Stress "hardware-in-the-loop," not a true free-running oscillator.
- **What NOT:** No raw C code; no war stories.

**Slide 6 — Hardware & circuit design**
- **Purpose:** Show the physical build and pin map.
- **Content:** Component table (ESP32-S3, LM393, SN74LVC1G34, MAX4619, BAT54S, `1000 µF`, range resistors, SSRs) + full pin map (§2.3, §2.4).
- **Visual:** Pin-map table + annotated circuit/block diagram.
- **Speaker notes:** Call out the shared SSR1/SSR3 interlock and BAT54S clamp.
- **What NOT:** Don't list the alternative 4D Systems board; no BOM costs.

**Slide 7 — Analog front-end & safety state machine**
- **Purpose:** Show safe biasing/discharge sequencing.
- **Content:** `IDLE → PRE-CHARGE → ISOLATE → MEASURING → DISCHARGE → IDLE`; `600 ms` precharge, `600 ms` discharge, `2000 µs` isolation; SSR roles; boots IDLE (§2.4, §2.6).
- **Visual:** State-machine diagram.
- **Speaker notes:** Highlight that boots IDLE and that precharging applies up to 20 V.
- **What NOT:** No debugging anecdotes.

**Slide 8 — Autoranging logic**
- **Purpose:** Explain how range and method are chosen.
- **Content:** 3-phase PROBE → SWEEP → FUSION; ADC window `250 µs–4 s`; sub-nF gate `1 nF`; oscillator window `100 Hz–15 kHz`, sweet spot `2000 Hz`; median gate `±87.5 %`; mismatch ratio `1.5` (§2.6).
- **Visual:** Autoranging flowchart (must be drawn).
- **Speaker notes:** Walk the flow once; note the sub-nF handoff.
- **What NOT:** Don't over-explain Gaussian quality math.

**Slide 9 — Firmware architecture**
- **Purpose:** Show how the firmware is organized.
- **Content:** Single measurement/console task, cooperative UART pump, ADC one-shot + curve-fitting cal, PCNT/reciprocal frequency paths, NVS persistence, telemetry `@@EVT` JSON (§2.7).
- **Visual:** Pseudocode block (allowed) + module/architecture diagram.
- **Speaker notes:** Mention NVS keeps calibration across reboot.
- **What NOT:** No real C code; no full function listing.

**Slide 10 — Calibration & parasitic-capacitance handling**
- **Purpose:** Show how accuracy at low capacitance is achieved.
- **Content:** ~`136 pF` parasitic; tare `T0`; one-point K; two-point K+T0; per-range NVS; rejects non-physical K/T0 (§2.7, §2.9).
- **Visual:** Calibration workflow diagram or the dashboard "Calibration curve (T vs C_ref)" chart.
- **Speaker notes:** Explain that tare with an empty socket removes the offset.
- **What NOT:** Don't claim the two-point run is complete (it is PLANNED).

**Slide 11 — User interface / dashboard**
- **Purpose:** Demonstrate the operator experience.
- **Content:** FastAPI + WebSocket + uPlot v1.6.32; live capacitance, spread, frequency, τ, charge curve, calibration/tare charts, console, CSV export; rolling average; safety badges (§2.8).
- **Visual:** Dashboard screenshot (capture from `host/`).
- **Speaker notes:** Note the UI is fed only by real telemetry.
- **What NOT:** Don't present a physical display (there is none).

**Slide 12 — Results / validation**
- **Purpose:** Present what has actually been measured (per preference B).
- **Content:** Table of confirmed diagnostic results: ~`136 pF` parasitic; 10 pF read 12.8 pF before fix; 100 pF implied 236 pF before fix; ~73 kHz (100 kΩ), ~7 kHz (1 MΩ), ~5.4 kHz with 10 pF on 1 MΩ (§2.9).
- **Visual:** Results table; optionally the capture of the ADC charge curve.
- **Speaker notes:** Be candid: two-point validation is pending, so these are diagnostic, not final accuracy figures.
- **What NOT:** Do **not** invent error % or accuracy specs; mark pending items as future work.

**Slide 13 — Design decisions, problems & limitations**
- **Purpose:** Show engineering judgment and honesty (per preference A).
- **Content:** Trade-off table (§2.11) + compact cause→fix table (§2.10) + limitations (§2.12).
- **Visual:** Two-column table or a "decision / why" chart.
- **Speaker notes:** Pick 2–3 strongest trade-offs; keep it factual.
- **What NOT:** No long debugging narratives; don't present pending work as done.

**Slide 14 — Future work**
- **Purpose:** Show the roadmap.
- **Content:** Two-point calibration with 1% C0G/NP0 (`100 pF`, `1 nF`); ISR latency profiling / hardware-gate offload; ADC curve-fit verification; leakage check; enclosure/display (§2.14).
- **Visual:** Simple roadmap or checklist.
- **Speaker notes:** Emphasize these are the honest next steps.
- **What NOT:** Don't imply any are already complete.

**Slide 15 — Closing demo & questions**
- **Purpose:** Close with a live/concluding demo (per preference #13).
- **Content:** Recap one-line value proposition; closing demo of the meter + dashboard; contact/metadata placeholders.
- **Visual:** Hero image/dashboard or a short demo clip placeholder.
- **Speaker notes:** "Measure a known cap live and watch the fusion update."
- **What NOT:** No new facts; no unverified accuracy claims.

### B) Style guide for the deck model

**Tone & density**
- Conversational but technically credible; addressed to university examiners.
- Short bullets only; **≤6 bullets per slide**; **≤10 words per bullet** (visuals and tables may be denser).
- Titles ≤8 words. One idea per slide.
- Pseudocode is allowed; **no real programming code** on slides.
- Speaker notes: brief bullet cues (3–5 short points), not paragraphs.

**Notation & units (preference #16)**
- Use symbols and a space before the unit: `10 kΩ`, `1 µF`, `136 pF`, `1000 µF`, `2.0 µs`, `500 ms`, `5.4 kHz`, `1 nF`.
- Keep SI prefixes as used in the project (kΩ, MΩ, pF, nF, µF, mV, µs, ms, kHz).
- Use `τ` and `R²` directly; define on first use.
- Significant figures: match the project (e.g., `136 pF`, `2.1×`, `12.8 pF`, `63.2 %`). Do not add precision the project never claimed.

**Palette (light academic, confirmed by user)**

| Role | Hex | Use |
| --- | --- | --- |
| Background | `#FFFFFF` | Slide background |
| Surface | `#F1F5F9` | Cards, table zebra |
| Border | `#CBD5E1` | Table/box borders |
| Text | `#1E293B` | Body text |
| Secondary text | `#64748B` | Captions, units |
| Primary | `#1F3A5F` (navy) | Titles, headers, ADC method |
| Accent | `#0E8A78` (teal) | Highlights, OSC method, success |
| Warning | `#C77700` (amber) | Warnings, pending items |
| Error | `#DC2626` (red) | Errors, overrange |
| Range 100 Ω | `#DC2626` | Chart series |
| Range 1 kΩ | `#B45309` | Chart series |
| Range 100 kΩ | `#2563EB` | Chart series |
| Range 1 MΩ | `#16A34A` | Chart series |

(Method convention: ADC = navy `#1F3A5F`; oscillator = teal `#0E8A78`. This is a **deck-only** palette; the dashboard's own dark palette — §2.8 — should only appear inside dashboard screenshots and must not be used as the slide theme.)

**Fonts & visual rules**
- Headings/body: clean sans-serif (e.g., Inter, Segoe UI, Roboto).
- Code/values: monospace (e.g., JetBrains Mono, Consolas) at a readable size.
- Keep a generous margin; left-align text; avoid full-bleed text.
- Use one accent color per slide; use amber/red only for warnings/limits.
- Table headers in navy with white text; body rows on white/`#F1F5F9`.

**Terminology — do**
- Say "ESP32-S3", "LM393 comparator oscillator", "ADC RC-step (τ) measurement", "fusion", "autoranging", "tare (T0)", "geometry constant K".
- Define acronyms on first use (NVS, ISR, PCNT, SSR, C_eq).

**Terminology — don't**
- Don't call the LM393 a "free-running oscillator" — call it a comparator in a hardware-in-the-loop loop.
- Don't call `T0` a "stray capacitance" — it is a measured period offset that absorbs stray C and latency.
- Don't present the two-point calibration or accuracy figures as completed.
- Don't use the STM32 nomenclature as the current design.

**Must be excluded (preferences #8, #9, #11, #20, A)**
- No STM32→ESP32 migration history.
- No debugging "war story" narratives (cause→fix only).
- No real code, only pseudocode.
- No cost/BOM, no references slide, no team-credits slide.
- No standalone "Problem & motivation" slide.
- Hide incomplete features; unvalidated items belong only on the Future work slide.
- No RGB565 values (no RGB565 display exists).

### C) Instructions to the deck model

1. Treat this document as the single source of truth. Do not add facts from outside it.
2. If a value is `[UNKNOWN — confirm with user]` or marked "Not discussed," ask the user or flag it — never guess or fabricate.
3. Preserve exact numbers, units, and spelling (`136 pF`, `250 µs`, `2000 Hz`, etc.).
4. Use US English.
5. Follow the 15-slide plan and the style guide exactly unless the user says otherwise. If you must adjust slide count, stay within 12–15 and keep all required-topic coverage (preference #7) plus the results and future-work slides.
6. Keep ≤6 bullets per slide, ≤10 words per bullet, conversational tone.
7. Present pending work (two-point calibration, curve-fit verification, leakage check, ISR profiling) only on the Future work slide, explicitly labeled as not yet done.
8. Do not reproduce source code; show pseudocode, tables, or diagrams instead.
9. Use the light academic palette for all slides; use the dashboard dark palette only inside screenshots.

---

## Remaining `[UNKNOWN — confirm with user]` items

1. Overall measurement **accuracy target** and resolution specification.
2. **Reference components** used for validation and any formal measured-vs-expected table with error %.
3. **Power supply** details and power consumption.
4. **Enclosure / physical size** details.
5. Deck **metadata**: course/module, author/team name(s), institution, date.
6. Whether an **RGB565 physical display** is planned (none exists today).
7. Whether the uncommitted working-tree changes (`src/main.c`, `HANDOVER.md`, dashboard files) are the intended final state for the presentation.