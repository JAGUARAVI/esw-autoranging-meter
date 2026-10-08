# ESWCap web dashboard

Local FastAPI + WebSocket dashboard for the ESP32 capacitance meter. It owns
the serial port, parses the firmware's `@@EVT {json}` telemetry, and forwards
calibration commands (`zero`, `cal`, `cal1/cal2`, `range`, `stream`, `curve`)
back to the device.

## Setup

```bash
# from the repo root
uv venv host/.venv --python 3.13
uv pip install --python host/.venv -r host/requirements.txt
```

`uPlot` is vendored under `host/static/vendor/` (v1.6.32), so the UI works
offline.

## Run

```bash
host/run.sh                      # autodetect /dev/ttyACM* or /dev/ttyUSB*
host/run.sh --port /dev/ttyACM0  # explicit port
host/run.sh --host 0.0.0.0       # also serve on the LAN (phone / tablet demo)
```

Deep-link a theme / presentation view, e.g. `http://127.0.0.1:8000/?theme=light&present=1`.

Then open <http://127.0.0.1:8000>.

> The backend owns the serial port, so `pio device monitor` cannot read the
> same device at the same time. Use the dashboard's **Command console & log**
> pane (or `host/run.sh` stdout) instead.

## What the UI shows

Every chart is fed only by real firmware telemetry — nothing is synthesised.

| Chart | Source event | Fields |
| --- | --- | --- |
| Capacitance vs time (log) | `cycle` | fused / ADC-only / OSC-only estimate |
| Sample spread | `cycle` | `spread` |
| Oscillator frequency per range | `sample` (osc) | `freq` |
| ADC τ per range | `sample` (adc) | `tau_us` |
| ADC charge curve + fitted exp | `curve` | `pts`, `vinf`, `v0`, `t0_us`, `tau_us`, `r2` (backend stores the latest; a reconnecting client is handed it). The ghost line renders the exact firmware model `V(t)=Vinf−(Vinf−V0)·exp(−(t−t0)/τ)`. |
| Calibration T vs C_ref | `calpt` / `calres` | `ref_pf`, `period_us`, `k`, `t0_us` |
| Tare stability (T0 per range) | `tare` | `period_us`, `t0_us` |
| Current-cycle samples table | `sample` | full `sample_t` |
| Rolling average (client-side) | `cycle` | last N fused values (instant / 3 / 5 / 10 / 20) |
| Front-end state badge + SSR bits | `fe` | `state`, `ssr13`, `ssr2`, `drive`, `charged`, `discharged`, `auto_pre`, `auto_dis`, `run`, `single`, `lock` |
| Autoranging decision matrix + pipeline | `sweep` | `mode`, `have_rough`, `rough`, `sub_nf`, `saturated`, `adc_sub`, `osc_best`, `lock`, `adc_tried[]` |
| Fusion strip + pipeline | `fuse` | `median`, `c`, `c_min`, `c_max`, `spread`, `quality`, `mismatch_ratio`, `gate_rel`, `n_kept`, `n_gated`, `w_total`, `contrib[]` (`r`,`m`,`c`,`q`,`w`,`r2`,`kept`) |
| Device health (uptime / heap / cycle) | `stat` | `uptime_ms`, `cycles`, `cycle_ms`, `heap_free`, `heap_min` |
| Confirmation toasts | `ack` | `cmd`, `ok`, `msg` |

## Precision instrument view (`/precision`)

`/` is the full debug / presentation dashboard. `/precision` is an alternate,
radical-transparency view for bench work: it answers *"What is the capacitance?"*
and *"Can I trust this number?"* at a glance.

- **Hero readout** — the fused capacitance in a large monospace face, with the
  instant / avg 3 / avg 5 / avg 10 / avg 20 selector (default avg 5).
- **Trust & provenance** — plain-text translation of the fusion state (agreement,
  spread, active range/method, median-gate pass, fused quality, R², method
  mismatch) instead of a confidence ring gauge. The panel's border-top carries
  the active range colour.
- **Front-end strip** — state, SSR1+SSR3 / SSR2 / DRIVE, auto-pre / auto-dis.
- **Capacitance vs measurement cycle** — step interpolation, strictly log axis,
  X = measurement index (idle time collapses), range-switch and tare markers.
- **Controls** — a full control bar: **Start / Stop / Single** plus range lock
  (`auto` / 100 Ω / 1 kΩ / 100 kΩ / 1 MΩ), front-end power (Pre-charge /
  Discharge / Idle, with confirmations), the automation toggles, and the ADC
  curve streaming switch. The firmware reports `run` / `single` / `lock` in
  `@@EVT fe`, so the run-state chip and buttons follow the device.
- **Pause on stop** — when measurement is stopped the timeline stops advancing
  and the hero switches to a blue **HOLD** state ("Measurement stopped — last
  value held") instead of the grey *staleness* fade. The grey "Data is Ns old"
  dimming is reserved for *unexpected* telemetry loss while running.
- **Recordings** — **Save CSV** (host `HIST` export), **Save JSON** (the exact
  client-side cycles incl. fusion, samples and charge curves), and **Clear**
  (POST `/api/clear` empties the host history and resets every client).
- **Progressive disclosure** — fusion breakdown (weighted bar + 1-D spread
  waterfall + sample table), ADC charge curve, calibration/tare and console all
  start collapsed.
- **ADC curve buckets** — charge curves are stored per resistance (range), up to
  6 runs each. The panel has 100 Ω / 1 kΩ / 100 kΩ / 1 MΩ tabs with run counts;
  the selected bucket shows its newest run as dots + the `fitted_exp` "ghost"
  line, with older runs of the same resistance drawn faintly behind.
- **Pin-to-explain** — clicking a historical timeline point freezes the live
  view and loads that cycle's fusion and charge-curve telemetry.
- **Alerts** — a persistent FAULT banner (offline, over-limit, missing cal),
  rate-limited WARNING toasts, and INFO toasts for autorange / method handoff /
  tare. A gate-rejected single outlier never raises a warning.
- **Data-staleness fade** — the hero dims and shows *"Data is Ns old"* when
  telemetry stops, or `NO LINK` when the device is gone.

The view is laptop-first and touchscreen-safe (`@media (pointer: coarse)` bumps
hit areas to 44 px). All charts are step/lie-free: no radial gauges, no splines.

**Tare is not required on 100 Ω / 1 kΩ.** The oscillator tare `T0` only matters
on 100 kΩ / 1 MΩ (an empty socket on the low ranges oscillates too fast to tare,
and `T0` is negligible for the large capacitors those ranges serve). The
precision view therefore labels those ranges **"tare n/a"** and never raises the
"calibration missing" fault for an untared 100 Ω / 1 kΩ range.

## Presentation features

The dashboard is also built to be projected.

- **Fusion panel** — the three-phase pipeline (PROBE → SWEEP → FUSE) lights up
  live from the firmware's `phase`, the **range decision matrix** shows which
  (range, method) cells were swept and how each sample scored, and the **fusion
  strip** plots every contributing sample on a log axis with a bar whose width
  is its quality *weight*, the median, the ±87.5 % gate band and the fused
  result. Gated outliers are struck through. This makes the quality-scored
  fusion — the project's core idea — visible.
- **Accuracy vs reference** — type a nominal DUT value (unit suffixes `p`/`n`/`u`
  accepted, e.g. `100p`, `10n`, `4.7u`) and the panel shows measured vs nominal,
  **error %**, **ppm**, a running error trend chart and the session standard
  deviation. Pending two-point calibration will obviously affect absolute error;
  the numbers are real telemetry, not targets.
- **Presentation mode** (`Present`) hides the calibration, console and diagnostic
  charts and enlarges the headline view.
- **Light / dark theme** (`Light`) switches between the dark console and a light
  academic palette that matches the slide deck. Both can be deep-linked, e.g.
  `/?theme=light&present=1`.
- **Snapshot** — use the uPlot legend or the browser's screenshot; charts can
  also be read from the CSV export.

## LAN / mobile access (IoT demo)

Start the host with `--host 0.0.0.0`; on startup it prints every LAN URL this
dashboard is reachable at, and the header's **Share** button shows those URLs
plus a **QR code** to open the live instrument on a phone or tablet. The
WebSocket fan-out already supports several clients at once, so a laptop can run
the console while a phone drives Start/Stop and watches the fusion strip.

## Front-end safety controls

The device **boots IDLE** — nothing is started or charged until you ask. The
dashboard's front-end panel shows the live state and has separate power
controls (these are independent of Start/Stop):

- **Pre-charge** — SSR1 (V_BIAS→10 Ω→N_DUT) + SSR3 (V_cap→1 Ω→GND, shared GPIO)
  charge C_block/N_DUT. It asks for confirmation because up to 20 V bias is
  applied, and the DUT stays biased after charging. Do not touch/remove the DUT.
- **Discharge** — SSR2 (N_DUT→100 Ω→GND) bleeds DUT/C_block, then all SSRs off.
- **Idle** — turn all SSRs off without discharging (asks for confirmation).

Every front-end command **first stops any in-flight measurement cycle** so the
SSR state machine can never be driven concurrently with a measurement. The UI
shows a red warning whenever the DUT is charged or idle-but-possibly-biased.

### Measuring under DC bias

A measurement **never** closes SSR2, so the DUT is measured *at the set DC bias*:
precharging N_DUT/C_block charges C_dut, and R_bias (1 MΩ) holds it there while
the range resistor only resets the MCU-side V_cap. The **Automation** column in
the front-end panel has two toggles (both default **OFF**):

- **Auto pre-charge** — when ON, the firmware re-runs PRE-CHARGE (SSR1+SSR3,
  SSR2 off → ISOLATE) before each cycle, so the DUT is always biased without a
  manual step. When OFF you must press **Pre-charge** first (manual mode).
- **Auto discharge** — when ON, a session end (`single`, `stop`, `idle`) bleeds
  the node for safety. When OFF those states hold the bias and require an
  explicit **Discharge** before touching the DUT.

The equivalent firmware commands are `autoprecharge on|off`,
`autodischarge on|off` and `auto?`; the live flags are shown on the two buttons.

## Rolling average

The big capacitance readout has an **instant / avg 3 / avg 5 / avg 10 / avg 20**
selector. It averages the last N *valid* fused readings (client-side, from the
`cycle` stream), shows the instantaneous value alongside, lists the recent
readings, and overlays the rolling average as a dashed series on the
capacitance chart. Default is `avg 5`; pick `instant` for the raw per-cycle
value.

## Oscillator frequency guard

The relaxation oscillator is a software loop (the ESP32 ISR mirrors the LM393
output on every edge). The hazard is running it **too fast** for the ISR, not a
particular range: a small capacitance on 100 Ω / 1 kΩ would toggle at MHz and
starve the CPU. The ISR therefore self-limits — if edges arrive faster than
~166 kHz it shuts the loop down, so the device can never freeze. Because of
this, the oscillator is usable on **all** ranges: a large cap on 100 Ω / 1 kΩ
runs slowly and its reading is accepted like any other when its quality is
fine. `Tare all` still only tares the 100 kΩ and 1 MΩ ranges, because an *empty*
socket on 100 Ω / 1 kΩ is far too fast to oscillate and T0 is negligible for
the large caps that use those ranges. This is expected, not an error.

## Calibration workflow

1. Pick the target range in the **Calibration** card.
2. Leave the DUT socket **empty**, press **Tare** (or **Tare all**). This
   removes the ~136 pF parasitic node capacitance.
3. For best slope accuracy, do a two-point calibration instead: insert a known
   reference, enter its value, **Capture 1**; swap to a second reference, enter
   it, **Capture 2**. This solves `K` and `T0` together.

All reference fields (OSC `cal`/`cal1`/`cal2` **and** ADC `adccal*`, on both the
settings and precision views) accept unit suffixes — `p`, `n`, `u`, `m`, `f` —
e.g. `100p`, `1n`, `4.7u`; a bare number is pF. They are converted to pF in the
browser because the firmware's calibration commands take a plain pF value.
4. `Export CSV` downloads all accumulated cycles, samples, tare runs,
   calibration points, **fusion breakdowns, autoranging decisions and device
   stats** — the full dataset behind the live view.

### ADC (RC-step) series-resistance calibration

The ADC path divides τ by the nominal range resistor, but the real charging path
includes the buffer output impedance + mux Ron + wiring (`R_series`). On the
100 Ω / 1 kΩ ranges that is tens of ohms, so those ranges over-read without a
correction. The panel's **ADC (RC-step) series resistance** section solves and
stores a per-range effective resistance:

- **One-point** — insert a known cap, enter its value, press **Cal R_eff**.
  `R_eff = τ / C_ref` (offset seeded from the oscillator tare).
- **Two-point** — enter ref 1, **Capture 1**; enter ref 2, **Capture 2**; solves
  `R_eff` and `C0 = τ/R_eff − C_ref` together.

Acceptance accepts unit suffixes (`10u`, `1u`, `100n`, `1000p`). References must
put τ in the clean window (`250 µs`…`20 ms`): use **10–100 µF on 100 Ω** and
**1–10 µF on 1 kΩ**, ideally low-ESR film. `Show ADC table` / `Clear ADC cal`
manage what is stored; the calibration persists in NVS.

### Offline fit analysis (`host/fit_analysis.py`)

The ADC τ estimator is a voltage-domain nonlinear least-squares fit that solves
`V_inf` jointly with τ (see `src/main.c: rc_exp_fit` and `HANDOVER.md` §4). This
script mirrors both the old log-linear fit and the new one in pure Python so the
math can be checked without hardware:

```bash
python3 host/fit_analysis.py                 # synthetic self-test (bias vs. V_inf error)
python3 host/fit_analysis.py --noise 3       # with 3 mV RMS ADC noise
python3 host/fit_analysis.py --rec eswcap_recording.json --csv fit.csv
```

`--rec` reads a recording saved by the precision view's **Save JSON** button and
prints, per stored curve, the old vs. new τ, the fitted `V_inf`, R², voltage RMSE
and τ uncertainty.

## Firmware telemetry protocol

The firmware emits single-line JSON after a `@@EVT ` sentinel when streaming is
enabled (`stream on`). Events: `boot`, `cycle`, `sample`, `curve`, `tare`,
`calpt`, `calres`, `adccalpt`, `adccalres`, `fe`, `ack`, plus `sweep`, `fuse`
and `stat` (see the table above). Human `ESP_LOG` lines are interleaved and shown
in the log pane.

`cycle` and `fuse` now also carry the **fused `quality`** (the mean quality of
the post-gate population) and the **`mismatch_ratio`** (`hi/lo` of the per-method
estimates, `null` when only one method contributed). These are the fields the
precision view uses for its trust translation and warning thresholds.

`fe` also carries the autoranging run-state (`run`, `single`, `lock`), re-emitted
on every `start` / `stop` / `single` / `auto` / `range` command and at the end of
a single-shot, so the UI knows whether to expect data (live) or hold the last
value.