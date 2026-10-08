# ESWCap — ESP32-S3 Autoranging Capacitance Meter

A low-cost, self-calibrating capacitance meter that replaces a **₹20k+ lab LCR meter**
for **MQ-type gas-sensor calibration** and general component testing. It measures
capacitance from **picofarads up to hundreds of microfarads**, under an external
**DC bias of 0–20 V**, using two physics-based methods that are scored and fused
into one high-confidence reading.

> Built for the ESW course evaluation by team `esw-m26-51`.
> See [`ESWCap_Presentation_Handoff.md`](ESWCap_Presentation_Handoff.md) and
> [`ESWCap_Video_Talking_List.md`](ESWCap_Video_Talking_List.md) for the
> presentation/video material.

---

## Why

Lab-grade LCR meters cost **₹20,000+**, which is out of reach for routine student
work, and they are not scriptable. Calibrating **MQ-type gas sensors** needs a meter
that can measure **capacitance and resistance under a DC bias** — exactly what this
instrument targets:

- **Cheap** — an ESP32-S3 plus a handful of analog parts.
- **Wide range in one instrument** — pF → hundreds of µF.
- **DC bias up to 20 V** — the DUT sits at the bias while the logic stays at 3.3 V,
  isolated by a 936 µF blocking capacitor.
- **Self-calibrating** — parasitic capacitance and fixed latency are tared out per
  range and stored in NVS.
- **Scriptable / live** — an interactive UART console and a local web dashboard.

## How it works

Two independent methods, automatically chosen and combined:

| Method | Best for | Principle |
| --- | --- | --- |
| **ADC RC-step (τ)** | Larger capacitors (µF) | Fit `V(t) = V_inf·(1 − e^(−t/τ))` in the voltage domain; `C = τ / R_eff` |
| **LM393 oscillator** | Small capacitors (pF–nF) | The ESP32 ISR closes a hardware-in-the-loop relaxation loop; `T = K·R·C + T0` |

**Autoranging pipeline:** `PROBE → SWEEP → FUSION`. Every (range, method) reading is
scored with a physics-based quality metric, outliers are median-gated (±87.5 %), and
the survivors are combined with a log-domain weighted average. A method-mismatch
alarm fires when the ADC and oscillator disagree by more than 1.5×.

- **Ranges:** `100 Ω`, `1 kΩ`, `100 kΩ`, `1 MΩ` (selected by a MAX4619 mux).
- **Calibration:** per-range `K` / `T0` (oscillator) and `R_eff` / `C0` (ADC),
  persisted in NVS; tare with an empty socket removes the ~136 pF node parasitic.

## Hardware

| Component | Purpose |
| --- | --- |
| ESP32-S3 (Freenove ESP32-S3 WROOM) | Controller, 12-bit ADC, PCNT |
| LM393 comparator | Threshold detection + hardware-in-the-loop oscillator |
| SN74LVC1G34 buffer | Sharp, low-impedance 3.3 V step excitation |
| MAX4619 analog mux | Range-resistor selection |
| BAT54S | Dual Schottky clamp on the V_cap node |
| 936 µF `C_block` (+ 67.8 nF HF bypass) | DC isolation between logic and 0–20 V bias |
| SSR1 / SSR2 / SSR3 | Pre-charge, discharge, and V_cap clamp (shared-pin interlock) |

Full pin map and front-end state machine: see [`HANDOVER.md`](HANDOVER.md).

## Repository layout

```
src/main.c            ESP-IDF firmware (measurement, autoranging, fusion, console)
host/                 FastAPI + WebSocket dashboard (uPlot charts, CSV export)
references/           Reference circuit page
platformio.ini        PlatformIO project (env: freenove_esp32_s3_wroom, ESP-IDF)
sdkconfig.*           Board SDK configs
HANDOVER.md           Detailed engineering handoff
ESWCap_*.md           Presentation / video material
push-both.sh          One-command sync to both GitHub repositories
```

## Build & flash

Requires [PlatformIO](https://platformio.org/).

```bash
pio run                     # build
pio run -t upload           # flash the ESP32-S3
pio device monitor -b 115200
```

The device boots **IDLE** (nothing charged) and stays safe until you type `start`.
Type `h` in the monitor for the command list.

## Live dashboard

A local FastAPI dashboard owns the serial port and plots live capacitance, spread,
oscillator frequency, ADC τ, the charge curve, and calibration/tare data.

```bash
host/run.sh                 # autodetects /dev/ttyACM*, open http://127.0.0.1:8000
```

See [`host/README.md`](host/README.md) for charts and the calibration workflow.

## Calibration (quick start)

With an empty socket on the 1 MΩ range:

```text
cal1 100      # first 1% C0G/NP0 reference (100 pF)
cal2 1000     # second reference (1 nF)  -> solves K and T0
cal?          # inspect stored K / T0 per range (persisted to NVS)
```

ADC path: `adccal1 <pF>` / `adccal2 <pF>` solve `R_eff` and `C0`.

## Push to both repositories

The whole project is mirrored to two places. Sync everything with one command:

```bash
./push-both.sh "your commit message"
```

This:

1. Commits and pushes the local repo to its **personal origin**
   (`JAGUARAVI/esw-autoranging-meter`).
2. Mirrors the working tree into
   `ESW-M26/esw-m26-51_praise_claude` under **`Code/capacitance`** and pushes.

Build caches (`.pio`, `.venv`, `__pycache__`) and local IDE state are excluded.
Override the classroom target with `ESWCAP_CLASSROOM_REPO`,
`ESWCAP_CLASSROOM_SUBDIR`, or `ESWCAP_CLASSROOM_BRANCH` if needed.

## Status & limitations

- Capacitance is implemented and fused; a **resistance-measurement path** for full
  MQ-sensor calibration is **in development**.
- Two-point calibration with 1% C0G/NP0 references is **planned** (not yet run).
- ADC curve-fit verification near the top of its range and a leakage check are pending.

Pending items are tracked in [`HANDOVER.md`](HANDOVER.md) §6.