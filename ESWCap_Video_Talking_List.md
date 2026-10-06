# ESWCap — 10-Minute Video: Talking List & Shot Plan

**Deliverable:** screen recording of the presentation + voice-over + working demo.
**Hard limit:** 10:00. Script targets **9:20–9:40** to leave margin. Over-running = not considered.
**Rules:** no fast-forwarding; one submission per team; check voice-over alignment before submitting.
**Viva:** 8 October — the notes below double as viva prep.

**Mandated structure (must all appear):**
1. Problem Statement
2. Motivation
3. Methodology — Parameters · Sensors · Block Diagram · Circuit Diagram · Calibration · Hardware images / PCB design · Deployment · Data (if available) & Analysis
4. Working Demo
5. Future Plan

> Draft target: **9:35**. Every segment below has an on-screen visual, the voice-over lines, and a hard stop time.

---

## Timing overview

| # | Segment | Start | End | Duration | On-screen |
| --- | --- | --- | --- | --- | --- |
| 0 | Title / hook | 0:00 | 0:20 | 0:20 | Title slide + dashboard live |
| 1 | Problem Statement | 0:20 | 1:15 | 0:55 | Problem slide |
| 2 | Motivation | 1:15 | 1:55 | 0:40 | Motivation slide |
| 3 | Methodology — Parameters | 1:55 | 2:30 | 0:35 | Specs table |
| 4 | Methodology — Sensors | 2:30 | 3:05 | 0:35 | Component/sensor table |
| 5 | Methodology — Block diagram | 3:05 | 3:45 | 0:40 | Block diagram |
| 6 | Methodology — Circuit diagram | 3:45 | 4:25 | 0:40 | Circuit + pin map |
| 7 | Methodology — Calibration | 4:25 | 5:20 | 0:55 | Calibration slide |
| 8 | Methodology — Hardware images / PCB | 5:20 | 5:50 | 0:30 | Hardware photos |
| 9 | Methodology — Deployment | 5:50 | 6:20 | 0:30 | Deployment slide |
| 10 | Data & Analysis | 6:20 | 7:05 | 0:45 | Results table |
| 11 | Working Demo | 7:05 | 9:05 | 2:00 | Live device + dashboard |
| 12 | Future Plan | 9:05 | 9:35 | 0:30 | Roadmap |
| 13 | Close / thanks | 9:35 | 9:45 | 0:10 | Contact slide |

**Buffer:** ~15 s. If you slip, cut Segment 0 to 10 s and trim the demo by 15 s — never cut the Future Plan.

---

## SEGMENT 0 — Title / hook (0:00–0:20)

**Visual:** Title slide ("ESWCap — ESP32-S3 Autoranging Capacitance Meter"; `[Course]`, `[Team]`, `[Institution]`, `[Date]`) beside a live dashboard clip.

**Voice-over:**
- "This is ESWCap — an autoranging capacitance meter built on the ESP32-S3."
- "It measures capacitors from picofarads up to hundreds of microfarads, automatically, using two physics-based methods in one instrument."

**Do NOT:** No STM32 backstory; no cost talk.

---

## SEGMENT 1 — Problem Statement (0:20–1:15, 55 s)

**Visual:** Problem slide — three bullets + a "range vs accuracy" gap graphic.

**Voice-over:**
- "Measuring capacitance accurately is hard because the usable range is enormous."
- "Small capacitors — picofarads — need very high resistance and very fine timing; large capacitors — hundreds of microfarads — need low resistance and long timing."
- "A single range or a single measurement method simply cannot cover both well."
- "Low-resistance ranges time out on big caps, and high-resistance ranges are swamped by the board's own parasitic capacitance — around 136 picofarads on our board."
- "So the challenge: one instrument, one measurement, accurate across the whole range."

**Do NOT:** Don't claim a numeric accuracy spec (not recorded).

---

## SEGMENT 2 — Motivation (1:15–1:55, 40 s)

**Visual:** Motivation slide — why it matters + design goals.

**Voice-over:**
- "Component testers and multimeters either don't measure capacitance, or only measure a narrow band."
- "We wanted a lab-grade, self-calibrating meter that a student can use without setting switches by hand."
- "Our goals: automatic range selection, automatic method selection, self-calibration stored on the device, and a live readout for the operator."
- "That led to a hybrid design: an ADC charge-timing path for larger capacitors, and an oscillator path for small ones."

**Do NOT:** No war stories about bugs (cause→fix only, later).

---

## SEGMENT 3 — Methodology: Parameters (1:55–2:30, 35 s)

**Visual:** Specs table.

**Voice-over:**
- "There are four range resistors: 100 ohms, 1 kilo-ohm, 100 kilo-ohm, and 1 mega-ohm, selected by a MAX4619 analog multiplexer."
- "The controller is an ESP32-S3 with a 12-bit ADC, on a 3.3 volt logic domain."
- "The DUT can sit at an external DC bias of up to 20 volts, isolated from logic by a 1000 microfarad blocking capacitor."
- "Timing: precharge and discharge are held for 600 milliseconds each, with a 2000 microsecond isolation delay."

**Viva hook:** Be ready to explain why each range exists and why 600 ms is used.

---

## SEGMENT 4 — Methodology: Sensors (2:30–3:05, 35 s)

**Visual:** Component/sensor table with small icons.

**Voice-over:**
- "Our sensing chain has three parts."
- "First, the comparator: an LM393 with a 1.65-volt midpoint reference from a 10 kilo-ohm divider, 100 kilo-ohm hysteresis, and a 10 kilo-ohm pull-up. It detects the RC node crossing a threshold."
- "Second, the ADC: ADC1 channel 9 on GPIO 10 reads the charge curve directly."
- "Third, the excitation: an SN74LVC1G34 push-pull buffer gives a sharp 3.3-volt step."
- "A BAT54S clamps the node for protection."

**Do NOT:** Don't call the LM393 a free-running oscillator — it is a comparator closed by software feedback.

---

## SEGMENT 5 — Methodology: Block diagram (3:05–3:45, 40 s)

**Visual:** Block diagram — ESP32-S3 → buffer → mux/range resistor → RC node (DUT + stray) → ADC + LM393; C_block isolation; SSR front-end.

**Voice-over:**
- "Here is the full signal chain."
- "The ESP32 drives the buffer, which steps the selected range resistor."
- "The resulting RC node — the DUT in series with the blocking capacitor — is read by the ADC and watched by the comparator."
- "The comparator output feeds back into the ESP32's interrupt, which mirrors it back onto the buffer. That closes a hardware-in-the-loop relaxation oscillator."
- "The SSR front-end pre-charges, isolates, and discharges the DUT safely."

**Do NOT:** No pin numbers yet — those are next.

---

## SEGMENT 6 — Methodology: Circuit diagram (3:45–4:25, 40 s)

**Visual:** Circuit diagram + pin-map table.

**Voice-over:**
- "On the pins: GPIO 3 is the bias ground return."
- "GPIOs 4 and 5 select the mux channel — 100 ohm on channel 2, 1 kilo-ohm on 1, 100 kilo-ohm on 0, and 1 mega-ohm on 3."
- "GPIO 10 is the ADC node; GPIO 14 is the comparator input with an any-edge interrupt."
- "GPIO 16 drives the buffer; GPIO 12 is the discharge switch; and GPIO 18 drives both the precharge switch and the V-cap clamp."
- "Those two share one pin on purpose — that's a hardware interlock, so you can never charge the DUT without clamping the node."

**Viva hook:** Explain the interlock and the BAT54S protection.

---

## SEGMENT 7 — Methodology: Calibration (4:25–5:20, 55 s)

**Visual:** Calibration slide + dashboard calibration curve (T vs C_ref).

**Voice-over:**
- "Calibration is where the accuracy comes from, especially for small capacitors."
- "The node has about 136 picofarads of parasitic capacitance we can't remove physically, so we remove it mathematically."
- "With an empty socket, we 'tare' the oscillator and store T-zero — the measured period offset that absorbs the parasitic capacitance and fixed latency. It's saved to non-volatile storage per range."
- "The oscillator follows T equals K times R times C plus T-zero."
- "We can solve K with a single known reference, or solve K and T-zero together with two known references — for example 100 picofarads and 1 nanofarad."
- "The same calibration is used for both measurement and calibration math, so there's no offset between them."

**Do NOT:** Don't claim the two-point run is finished — it is planned. Say "we can" / "is designed to," not "we have."

---

## SEGMENT 8 — Methodology: Hardware images / PCB (5:20–5:50, 30 s)

**Visual:** Photo of the board/rig; PCB layout or breadboard photo; close-up of comparator + mux.

**Voice-over:**
- "This is the physical build."
- "Front-end components are grouped around the RC node: the comparator and its hysteresis network, the buffer, the mux, and the protection diodes."
- "The blocking capacitor and the solid-state switches sit on the bias side, keeping the 20-volt domain away from the ESP32."

**Note:** The repo contains no board photos or PCB files — **capture/produce these images before recording.** `[UNKNOWN — confirm with user]`

---

## SEGMENT 9 — Methodology: Deployment (5:50–6:20, 30 s)

**Visual:** Deployment slide — firmware flash + host dashboard block.

**Voice-over:**
- "Deployment is two parts: the firmware and the host dashboard."
- "The firmware is built with PlatformIO using ESP-IDF and flashed to the ESP32-S3."
- "It exposes an interactive serial console and streams machine-readable JSON telemetry."
- "A local FastAPI dashboard owns the serial port, plots live capacitance, frequency, time constant, and calibration data, and can send calibration commands. It runs at localhost on port 8000."

**Viva hook:** Know the command set and the telemetry event names.

---

## SEGMENT 10 — Data & Analysis (6:20–7:05, 45 s)

**Visual:** Results table (diagnostic measurements) + ADC charge-curve graph.

**Voice-over:**
- "Here's what we've measured so far."
- "The board's parasitic node capacitance is about 136 picofarads."
- "Before calibration fixes, a 10 picofarad capacitor read about 12.8 picofarads, and a 100 picofarad reference implied 236 picofarads — showing exactly why per-range taring is necessary."
- "Oscillator frequencies are in a healthy band: about 73 kilohertz on the 100 kilo-ohm range and about 7 kilohertz on the 1 mega-ohm range; with a 10 picofarad DUT on 1 mega-ohm, the loop runs around 5.4 kilohertz."
- "Analysis: these confirm the physics model and the calibration approach. Full two-point accuracy validation is pending and is on our future plan."

**IMPORTANT:** No formal error-% table exists. Do **not** invent numbers. Present these as diagnostics, clearly labeled.

---

## SEGMENT 11 — Working Demo (7:05–9:05, 2:00)

**Visual:** Screen recording of the live dashboard + camera/insert of the device; cursor movements only, no fast-forward.

**Demo script (follow in order):**
1. **(0:00–0:20)** Dashboard connected; show the "connected" pill and the port.
2. **(0:20–0:45)** Press **Start**; point out the fused capacitance readout, confidence, spread, and sample counts updating live.
3. **(0:45–1:10)** Show the **Capacitance vs time** chart and the per-range sample table (range, method, validity, quality).
4. **(1:10–1:35)** Enable **ADC curves** and show the charge curve with the fitted exponential and its R-squared.
5. **(1:35–1:55)** Insert/select a known capacitor and show the value change; mention autoranging picks the range automatically.
6. **(1:55–2:00)** Press **Stop**; note the front-end returns to a safe idle state.

**Voice-over beats:**
- "The meter is now measuring continuously."
- "Every sample is scored for quality and fused into one estimate."
- "You can see both methods reported side by side, with a mismatch warning if they disagree."
- "The front-end always boots idle and returns to a safe state."

**Do NOT:** Don't speed up footage; don't leave long silent stretches; if a step fails, narrate and move on rather than editing.

---

## SEGMENT 12 — Future Plan (9:05–9:35, 30 s)

**Visual:** Roadmap checklist.

**Voice-over:**
- "Next, we'll complete two-point calibration with one-percent C0G and NP0 references to lock in K and T-zero for every range."
- "We'll profile interrupt latency and consider offloading the oscillator feedback to hardware for the smallest capacitors."
- "We'll verify the ADC curve-fit calibration near the top of its range."
- "And we'll check for leakage through the pull-up and protection diodes during the soak phase."
- "Longer term: an enclosure and an on-board display."

**Do NOT:** Don't imply any of these are done.

---

## SEGMENT 13 — Close / thanks (9:35–9:45, 10 s)

**Visual:** Thank-you slide with `[Team]` and `[Institution]`.

**Voice-over:**
- "That's ESWCap — one instrument, two methods, calibrated and fused. Thank you."

---

## Pre-submission checklist

- [ ] Total runtime **under 10:00** (hard fail if over).
- [ ] All five mandated sections present: Problem Statement, Motivation, Methodology (all 8 sub-topics), Working Demo, Future Plan.
- [ ] Screen recording + audible voice-over throughout; **no misalignment** between slides and narration.
- [ ] **No fast-forwarding** anywhere in the video.
- [ ] Demo actually shows a measurement changing — not just a static dashboard.
- [ ] No fabricated accuracy figures; pending items framed as future work.
- [ ] Hardware/PCB images captured (missing from repo).
- [ ] One team submission only.
- [ ] Save viva date: **8 October**.

## Viva prep quick answers

- **Why two methods?** Neither covers pF–µF alone: ADC τ is accurate for large caps, the tared oscillator for small ones.
- **Why is the LM393 a "comparator oscillator"?** It has hysteresis only; the ESP32 ISR mirrors its output back to the drive buffer, closing the loop in software.
- **Why tare?** To remove the ~136 pF board parasitic and fixed latency via a measured T-zero.
- **Why restrict the oscillator to 100 kΩ and 1 MΩ?** On faster ranges it runs at MHz and saturates the ESP32 ISR.
- **What does fusion do?** Scores each (range, method) sample, gates outliers against the median, and computes a log-domain weighted average.