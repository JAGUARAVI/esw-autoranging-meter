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
| ADC charge curve + fitted exp | `curve` | `pts`, `vinf`, `tau_us`, `r2` (backend stores the latest; a reconnecting client is handed it) |
| Calibration T vs C_ref | `calpt` / `calres` | `ref_pf`, `period_us`, `k`, `t0_us` |
| Tare stability (T0 per range) | `tare` | `period_us`, `t0_us` |
| Current-cycle samples table | `sample` | full `sample_t` |
| Rolling average (client-side) | `cycle` | last N fused values (instant / 3 / 5 / 10 / 20) |
| Front-end state badge + SSR bits | `fe` | `state`, `ssr13`, `ssr2`, `drive`, `charged`, `discharged`, `auto_pre`, `auto_dis` |
| Autoranging decision matrix + pipeline | `sweep` | `mode`, `have_rough`, `rough`, `sub_nf`, `saturated`, `adc_sub`, `osc_best`, `lock`, `adc_tried[]` |
| Fusion strip + pipeline | `fuse` | `median`, `c`, `c_min`, `c_max`, `gate_rel`, `n_kept`, `n_gated`, `w_total`, `contrib[]` (`r`,`m`,`c`,`q`,`w`,`r2`,`kept`) |
| Device health (uptime / heap / cycle) | `stat` | `uptime_ms`, `cycles`, `cycle_ms`, `heap_free`, `heap_min` |
| Confirmation toasts | `ack` | `cmd`, `ok`, `msg` |

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

## Firmware telemetry protocol

The firmware emits single-line JSON after a `@@EVT ` sentinel when streaming is
enabled (`stream on`). Events: `boot`, `cycle`, `sample`, `curve`, `tare`,
`calpt`, `calres`, `adccalpt`, `adccalres`, `fe`, `ack`, plus `sweep`, `fuse`
and `stat` (see the table above). Human `ESP_LOG` lines are interleaved and shown
in the log pane.