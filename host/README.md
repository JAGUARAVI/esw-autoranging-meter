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
```

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
| ADC charge curve + fitted exp | `curve` | `pts`, `vinf`, `tau_us`, `r2` |
| Calibration T vs C_ref | `calpt` / `calres` | `ref_pf`, `period_us`, `k`, `t0_us` |
| Tare stability (T0 per range) | `tare` | `period_us`, `t0_us` |
| Current-cycle samples table | `sample` | full `sample_t` |
| Front-end state badge + SSR bits | `fe` | `state`, `ssr13`, `ssr2`, `drive`, `charged`, `discharged` |
| Confirmation toasts | `ack` | `cmd`, `ok`, `msg` |

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

## Calibration workflow

1. Pick the target range in the **Calibration** card.
2. Leave the DUT socket **empty**, press **Tare** (or **Tare all**). This
   removes the ~136 pF parasitic node capacitance.
3. For best slope accuracy, do a two-point calibration instead: insert a known
   reference, enter its value, **Capture 1**; swap to a second reference, enter
   it, **Capture 2**. This solves `K` and `T0` together.
4. `Export CSV` downloads all accumulated cycles, samples, tare runs, and
   calibration points.

## Firmware telemetry protocol

The firmware emits single-line JSON after a `@@EVT ` sentinel when streaming is
enabled (`stream on`). Events: `boot`, `cycle`, `sample`, `curve`, `tare`,
`calpt`, `calres`, `ack`. Human `ESP_LOG` lines are interleaved and shown in the
log pane.