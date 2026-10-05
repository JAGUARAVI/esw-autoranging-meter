# Project Handoff: ESP32 Autoranging Capacitance Meter

**Architecture Transition:** STM32G431CBU6 to ESP32
**Current State:** Dual-Mode Firmware Integration Complete (ADC + LM393 Oscillator)

## 1. Hardware Architecture Updates

The front-end has been successfully decoupled from the STM32's internal analog peripherals and adapted for the ESP32 using external discrete components.

* **DC Bias Isolation ($C_{block}$):** The 1000 µF bulk blocking capacitor is fully integrated, isolating the 3.3V logic domain from the 0–20V external DC bias domain. The ESP32 ADC and drive pins sit safely at a 0V DC baseline.
* **External Schmitt Trigger:** An LM393 comparator replaces the STM32 COMP1. It is configured with a 1.65V mid-point reference (10 kΩ / 10 kΩ divider), a 100 kΩ positive feedback resistor for hysteresis, and a 10 kΩ pull-up on the open-collector output.
* **Excitation Buffer:** An SN74LVC1G34 push-pull buffer is driven by the ESP32 to provide sharp, low-impedance 3.3V step excitation to the RC network.

## 2. Firmware Control State

The system now supports a hybrid measurement approach, automatically routing based on the transient response of the RC network.

* **ADC RC-Step Mode (Large Capacitors):** Routes via `GPIO10` (ADC1 Channel 9). Measures the exponential charge curve up to the 2085 mV threshold ($1\tau$). Used primarily for µF-range electrolytics.
* **Oscillator Mode (Small Capacitors):** Triggered automatically if the 1 MΩ range charges faster than 200 µs. Relies on an ISR attached to `GPIO14` to mirror the LM393 output state back to the drive pin, establishing a hardware-in-the-loop relaxation oscillator. Measures 50 full periods to calculate capacitance.
* **Safety Sequencing:** Precharge and discharge phases strictly hold the system in a 0V differential state for 600 ms, discharging $C_{DUT}$ completely and allowing the dielectric to soak at the external $V_{bias}$ level before measurement.

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

## 5. Pending Action Items & Validation Required

* **Tune Oscillator K-Factor:** Still needs the two-point `cal1`/`cal2` run
  described in §4 with 1% C0G/NP0 references (e.g. 100 pF, 1 nF) to set the
  real geometry constant `K` and offset `T0`.
* **ISR Latency Profiling:** The ESP32 FreeRTOS ISR has higher latency than a bare-metal STM32 interrupt. If the loop delay introduces significant non-linearity at sub-100 pF ranges, the feedback loop may need to be offloaded entirely to a hardware gate (e.g., routing the LM393 output directly into the SN74LVC1G34 buffer via a digital switch).
* **ADC Curve Fitting Verification:** The code utilizes `esp_adc_cali_scheme_curve_fitting`. Verify that the ESP32-eFuse calibration values correctly map the non-linear high end of the ADC curve near the 2085 mV threshold.
* **Leakage Current Check:** Validate that the 10 kΩ pull-up on the LM393 and the BAT54S leakage do not bleed charge into the RC node during the 600 ms dielectric soak phase.