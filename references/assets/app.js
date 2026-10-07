/* ESWCap — ESP32-S3 Autoranging Capacitance Meter · interactive reference */
(() => {
  const NS = "http://www.w3.org/2000/svg";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  /* ------------------------------------------------------------------ */
  /* Data                                                                */
  /* ------------------------------------------------------------------ */
  const PARTS = {
    esp32: {
      name: "ESP32-S3",
      kind: "Microcontroller",
      loc: "Controller / fusion engine",
      chips: ["mcu", "analog"],
      bom: "1 × ESP32-S3 (Freenove ESP32-S3 WROOM), ESP-IDF",
      why: "The whole digital policy engine. It replaces the STM32's DAC, ADC, comparator and timers with one ADC, one interrupt input, and plain GPIO.",
      text: "Drives the excitation buffer on GPIO16, samples V_cap on GPIO10 (ADC1_CH9), watches the LM393 on GPIO14 (ANYEDGE interrupt), and switches the MAX4619 range mux on GPIO4/GPIO5. The safety bank hangs off GPIO12 and GPIO18.",
      facts: {
        ADC: "ADC1_CH9 · GPIO10 · 12-bit, 12 dB atten",
        Oscillator: "GPIO14 interrupt mirrors LM393",
        Drive: "GPIO16 → SN74LVC1G34",
        Safety: "GPIO18 = SSR1+SSR3, GPIO12 = SSR2",
      },
      note: "The ESP32 never sees the bias domain: C_block sits between it and N_DUT.",
    },
    lm393: {
      name: "LM393 comparator",
      kind: "External Schmitt / oscillator",
      loc: "V_cap → GPIO14",
      chips: ["analog", "mcu"],
      bom: "1 × LM393 + 2 × 10 kΩ ref + 100 kΩ hyst + 10 kΩ pull-up",
      why: "Replaces the STM32 COMP1. An open-collector comparator with hysteresis is the fast, quiet threshold sensor a pF oscillator needs.",
      text: "Its inverting input sits at a 1.65 V midpoint (10 kΩ / 10 kΩ divider); 100 kΩ positive feedback adds hysteresis; a 10 kΩ pull-up drives the open-collector output. The ESP32 ISR mirrors that output back onto the drive buffer, closing a hardware-in-the-loop relaxation oscillator.",
      facts: {
        Reference: "1.65 V (10 kΩ / 10 kΩ)",
        Hysteresis: "100 kΩ positive feedback",
        Output: "10 kΩ pull-up → GPIO14",
        Loop: "ISR mirrors level onto GPIO16",
      },
      note: "It is a comparator in a software-closed loop, not a free-running oscillator.",
    },
    buf: {
      name: "SN74LVC1G34 buffer",
      kind: "Push-pull driver",
      loc: "GPIO16 → MAX4619",
      chips: ["mcu", "analog"],
      bom: "1 × SN74LVC1G34",
      why: "An ESP32 GPIO cannot charge microfarads quickly. The buffer gives sharp, low-impedance 3.3 V steps and shields the MCU pin from the analog matrix.",
      text: "Non-inverting CMOS buffer on the 3.3 V rail. It provides the RC-step excitation and the oscillator square wave. Its output impedance (~25 Ω) is part of R_eff and is removed by calibration.",
      facts: { Function: "Non-inverting buffer", Zo: "~25 Ω", Role: "RC step + oscillator drive" },
    },
    mux: {
      name: "MAX4619 4:1 mux",
      kind: "Range switch",
      loc: "Buffer → range resistor bank",
      chips: ["analog"],
      bom: "1 × MAX4619",
      why: "Low-leakage analog mux so the pF ranges are not bled by switch resistance and off-leakage.",
      text: "Routes the buffered drive to one of four range resistors. Channels are numbered from production: 100 Ω → CH2, 1 kΩ → CH1, 100 kΩ → CH0, 1 MΩ → CH3. Address lines A0/A1 come from GPIO4/GPIO5.",
      facts: {
        Channels: "100 Ω → 2 · 1 kΩ → 1 · 100 kΩ → 0 · 1 MΩ → 3",
        Control: "A0 = GPIO4, A1 = GPIO5",
        Ron: "a few Ω (calibrated out)",
      },
    },
    rbank: {
      name: "Range resistor bank",
      kind: "Timing resistors",
      loc: "Mux output → V_cap",
      chips: ["analog"],
      bom: "1 MΩ / 100 kΩ / 1 kΩ / 100 Ω, 1 %",
      why: "Four decades of resistance let the RC product stay inside a clean timing window across pF–µF.",
      text: "1 MΩ and 100 kΩ carry the high-resolution oscillator work for small ceramics; 1 kΩ and 100 Ω bring large electrolytics into a fast ADC RC-step window. Calibration stores a measured R_eff per range.",
      facts: {
        Ranges: "100 Ω · 1 kΩ · 100 kΩ · 1 MΩ",
        "Best OSC": "100 kΩ / 1 MΩ for pF–nF",
        "Best ADC": "1 kΩ / 100 Ω for µF",
      },
    },
    bat54s: {
      name: "BAT54S Schottky clamp",
      kind: "Dual diode array",
      loc: "GND ─|>─ V_cap ─|>─ 3.3 V",
      chips: ["analog", "mcu"],
      bom: "1 × BAT54S",
      why: "Last line of defence for GPIO10 and GPIO14. ESP32 abs-max is ~3.6 V.",
      text: "Series pair with the centre tap on V_cap. Negative spikes clamp near −0.3 V, positive near 3.6 V. SSR3 should stop it conducting hard; it catches residual spikes.",
      facts: { Clamp: "−0.3 V to ~3.6 V", Protects: "GPIO10, GPIO14" },
    },
    cblock: {
      name: "C_block 1000 µF ∥ 100 nF",
      kind: "DC block / AC couple",
      loc: "N_DUT → V_cap",
      chips: ["analog"],
      bom: "1 × 1000 µF + 1 × 100 nF, ≥ 25 V",
      why: "The ESP32 must never see the 0–20 V bias. C_block passes the AC measurement current and blocks the DC operating point.",
      text: "The 1000 µF electrolytic lets the RC-step see large DUTs without the series capacitor dominating; the 100 nF ceramic bypasses its ESL for the fast oscillator edges. Effective series value is C_eq = (C_b·C_d)/(C_b+C_d).",
      facts: {
        Values: "1000 µF ∥ 100 nF",
        "C_eq @ 470 nF": "≈ 470 nF",
        "C_eq @ 1000 µF": "500 µF (firmware-corrected)",
      },
      note: "Above 1 µF the firmware inverts the series combination before subtracting stray C.",
    },
    cnf: {
      name: "100 nF HF bypass",
      kind: "Ceramic",
      loc: "Across C_block",
      chips: ["analog"],
      bom: "1 × 100 nF, ≥ 25 V",
      why: "Electrolytics look inductive above a few hundred kHz; oscillator edges need a real capacitor.",
      text: "Parallel with the 1000 µF. Do not omit it in oscillator mode.",
      facts: { Value: "100 nF", Dielectric: "C0G/X7R preferred" },
    },
    cdut: {
      name: "C_DUT — device under test",
      kind: "Unknown capacitor",
      loc: "N_DUT to GND",
      chips: ["hv", "analog"],
      bom: "Example cal part: 470 nF MLCC",
      why: "The thing being measured, optionally held at DC bias.",
      text: "One terminal at N_DUT, the other at GND. All SSR branches, R_bias and C_block meet at N_DUT. AC measurement current flows through C_block into the V_cap node.",
      facts: { Example: "470 nF cal", Nodes: "N_DUT · GND" },
    },
    rbias: {
      name: "1 MΩ R_bias",
      kind: "DC injection",
      loc: "V_BIAS → N_DUT",
      chips: ["hv", "analog"],
      bom: "1 × 1 MΩ, 1 %",
      why: "Applies DC bias to the DUT without providing a low-impedance AC path that would kill the measurement.",
      text: "Stiff for DC (sets the operating point), invisible for AC (1 MΩ ≫ any range resistor). During measurement it is the only path that holds N_DUT at V_BIAS.",
      facts: { Value: "1 MΩ", "I at 20 V": "20 µA", Job: "DC bias, AC isolation" },
    },
    ssr1: {
      name: "SSR1 — pre-charge",
      kind: "AQY212 PhotoMOS",
      loc: "V_BIAS -- 10 Ω -- N_DUT",
      chips: ["hv"],
      bom: "1 × AQY212 / TLP241A",
      why: "R_bias would take seconds to charge a large electrolytic. Pre-charge dumps bias through 10 Ω instead.",
      text: "LED driven from GPIO18 through 330 Ω. An analog switch, so no Vce sat. Wired with SSR3: you never inject bias unless V_cap is clamped.",
      facts: { GPIO: "GPIO18 (shared with SSR3)", Series: "10 Ω", Role: "Fast DUT/bias pre-charge" },
      note: "GPIO18 fires SSR1 and SSR3 together. That is the hardware interlock.",
    },
    ssr2: {
      name: "SSR2 — discharge",
      kind: "AQY212 PhotoMOS",
      loc: "N_DUT -- 100 Ω -- GND",
      chips: ["hv"],
      bom: "1 × AQY212 / TLP241A",
      why: "You must dump DUT energy before unclipping a part, or the next DUT (and the operator) eat the bias.",
      text: "Driven from GPIO12 through 330 Ω. 100 Ω sets a ~0.5 s 5τ discharge on a 1000 µF DUT. The only DUT ground path.",
      facts: { GPIO: "GPIO12", Series: "100 Ω", "5τ @ 1000 µF": "0.5 s" },
    },
    ssr3: {
      name: "SSR3 — V_cap clamp",
      kind: "AQY212 PhotoMOS",
      loc: "V_cap -- 1 Ω -- GND",
      chips: ["analog"],
      bom: "1 × AQY212 / TLP241A",
      why: "Pre-charging N_DUT slams displacement current through C_block. Without a clamp, V_cap would jump and destroy GPIO10/GPIO14.",
      text: "The most important safety part on the MCU side. GPIO18 turns it on with SSR1. The 1 Ω resistor eats the C_block inrush (Q = C·ΔV ≈ 1000 µF × 20 V = 20 mC); BAT54S only catches residual spikes.",
      facts: { GPIO: "GPIO18 (wired with SSR1)", Series: "1 Ω", Job: "Hold V_cap at GND while pre-charging" },
      note: "Never enable SSR1 unless SSR3 is already on. Shared GPIO18 is the hardware AND of that rule.",
    },
    rpre: {
      name: "10 Ω pre-charge",
      kind: "Inrush limiter",
      loc: "SSR1 branch",
      chips: ["hv"],
      bom: "1 × 10 Ω (pulse-rated preferred)",
      why: "A dead short of 20 V into a discharged electrolytic would be tens of amps; 10 Ω caps the peak near 2 A.",
      text: "Pulse-loaded during pre-charge.",
      facts: { Value: "10 Ω", "Ipeak @ 20 V": "2 A" },
    },
    rdis: {
      name: "100 Ω discharge",
      kind: "Bleed resistor",
      loc: "SSR2 branch",
      chips: ["hv"],
      bom: "1 × 100 Ω",
      why: "Limits discharge current while still emptying millifarad capacitors in under a second.",
      text: "Peak current 20 V / 100 Ω = 200 mA, fine for the PhotoMOS.",
      facts: { Value: "100 Ω", Ipeak: "200 mA" },
    },
    rclamp: {
      name: "1 Ω clamp resistor",
      kind: "Inrush absorber",
      loc: "SSR3 branch",
      chips: ["analog"],
      bom: "1 × 1 Ω",
      why: "Gives C_block somewhere to dump charge besides the Schottky clamp and the ESP32 bond wires.",
      text: "Energy ½CV² = ½ × 0.001 × 400 = 0.2 J from 1000 µF at 20 V. A pulse-rated part is appropriate.",
      facts: { Value: "1 Ω", Energy: "0.2 J from 1000 µF @ 20 V" },
    },
    r100: { name: "100 Ω range", kind: "Timing resistor", loc: "MAX4619 CH2 → V_cap", chips: ["analog"], bom: "1 × 100 Ω, 1 %", why: "Needed for hundreds of µF so the step settles in milliseconds, not seconds.", text: "Buffer Zo plus mux Ron are a large fraction of this range, so R_eff is calibrated. Peak drive 3.3 V / 100 Ω ≈ 33 mA — why the buffer exists.", facts: { Value: "100 Ω", "Mux ch": "CH2", "Best C": "50 µF – 1000 µF" } },
    r1k: { name: "1 kΩ range", kind: "Timing resistor", loc: "MAX4619 CH1 → V_cap", chips: ["analog"], bom: "1 × 1 kΩ, 1 %", why: "Brings large nF / small µF into a millisecond RC-step window.", text: "Mid range. R_eff calibrated because it too is a large fraction of R_nom.", facts: { Value: "1 kΩ", "Mux ch": "CH1", "Best C": "100 nF – 50 µF" } },
    r100k: { name: "100 kΩ range", kind: "Timing resistor", loc: "MAX4619 CH0 → V_cap", chips: ["analog"], bom: "1 × 100 kΩ, 1 %", why: "Long RC for small capacitors so the oscillator frequency stays in the comfort band.", text: "Primary oscillator range for pF–nF. A bare node runs fast; the ISR rate limiter protects the core.", facts: { Value: "100 kΩ", "Mux ch": "CH0", "Best C": "pF – 100 nF" } },
    r1m: { name: "1 MΩ range", kind: "Timing resistor", loc: "MAX4619 CH3 → V_cap", chips: ["analog"], bom: "1 × 1 MΩ, 1 %", why: "Highest sensitivity for the smallest ceramics; the range where the ~136 pF node parasitic matters most.", text: "Tared (T0) so the parasitic capacitance is removed mathematically. ADC is hard-gated off below 1 nF.", facts: { Value: "1 MΩ", "Mux ch": "CH3", "Best C": "sub-nF – 10 nF" } },
    refdiv: { name: "LM393 reference divider", kind: "1.65 V midpoint", loc: "3.3 V → 10 kΩ/10 kΩ → GND", chips: ["analog"], bom: "2 × 10 kΩ", why: "Sets the comparator threshold at half the 3.3 V rail.", text: "The LM393 inverting input sits at 1.65 V, centred for symmetric rising/falling thresholds.", facts: { Value: "10 kΩ / 10 kΩ", Node: "1.65 V" } },
    rhyst: { name: "100 kΩ hysteresis", kind: "Positive feedback", loc: "LM393 output → IN+", chips: ["analog"], bom: "1 × 100 kΩ", why: "Without hysteresis the comparator would chatter on slow edges.", text: "Positive feedback widens the threshold band so the comparator gives one clean transition per RC crossing.", facts: { Value: "100 kΩ", Role: "Schmitt hysteresis" } },
    rpull: { name: "10 kΩ pull-up", kind: "Open-collector load", loc: "LM393 output → 3.3 V", chips: ["analog"], bom: "1 × 10 kΩ", why: "The LM393 output is open-collector and needs a defined high level.", text: "Pulls the output to 3.3 V so GPIO14 sees a clean logic swing.", facts: { Value: "10 kΩ", Role: "Output pull-up" } },
    r330: { name: "330 Ω LED limit", kind: "PhotoMOS input", loc: "GPIO12 / GPIO18 → SSR LEDs", chips: ["mcu"], bom: "3 × 330 Ω", why: "AQY212 LED is ~1.2 V, 5–10 mA. From 3.3 V, 330 Ω gives ≈ 6.4 mA.", text: "One per SSR. Keep them next to the MCU, not next to the high-voltage output pins.", facts: { Value: "330 Ω × 3", "I_LED": "≈ 6.4 mA" } },
    vcap: { name: "V_cap node", kind: "MCU-side analog", loc: "After C_block", chips: ["analog", "mcu"], bom: "Net", why: "The only analog voltage the ESP32 is allowed to touch.", text: "Held between GND and 3.3 V by BAT54S, forcibly grounded by SSR3 during pre-charge, driven through the range resistors during measurement, watched by GPIO10 and the LM393.", facts: { Clamps: "BAT54S + SSR3", Senses: "GPIO10, GPIO14", Drive: "range resistor bank" } },
    ndut: { name: "N_DUT node", kind: "High-voltage analog", loc: "Top of C_DUT", chips: ["hv"], bom: "Net", why: "Meeting point of bias, pre-charge, discharge and the DUT.", text: "This node can sit at up to 20 V. Isolated from V_cap by C_block. Never probe it with the ESP32.", facts: { Connections: "R_bias, SSR1, SSR2, C_DUT, C_block" } },
    vbias: { name: "V_BIAS rail", kind: "External 0–20 V", loc: "Bias input", chips: ["hv"], bom: "Net", why: "A quiet DC source for C-V / derating tests, isolated from logic by C_block.", text: "Feeds R_bias and the SSR1 pre-charge branch. Never connects to the ESP32 except across C_block (AC).", facts: { Range: "0 – 20 V", Isolation: "C_block 1000 µF", Control: "external supply" } },
    probe: { name: "PROBE phase", kind: "Pipeline · phase 1", loc: "Remembered range", chips: ["mcu"], bom: "Firmware (no extra part)", why: "A fast oscillator reading on the previously used range gives a rough capacitance to plan the sweep, without a full sweep first.", text: "One quick LM393 oscillator measurement. Its result decides which ADC ranges are worth trying and which oscillator range is closest to the 2 kHz sweet spot.", facts: { Method: "OSC, single range", Output: "rough C", Cost: "one short measurement" } },
    sweep: { name: "SWEEP phase", kind: "Pipeline · phase 2", loc: "ADC + oscillator ranges", chips: ["mcu", "analog"], bom: "Firmware (no extra part)", why: "Collects many independent samples so fusion has something to trust.", text: "Runs the ADC τ-measurement on every range whose predicted τ lands in 250 µs–4 s, plus an oscillator run on the range whose predicted frequency is closest to 2 kHz.", facts: { ADC: "250 µs ≤ τ ≤ 4 s", OSC: "100 Hz ≤ f ≤ 15 kHz", "OSC sweet spot": "2000 Hz" } },
    fuse: { name: "FUSION phase", kind: "Pipeline · phase 3", loc: "Result", chips: ["mcu"], bom: "Firmware (no extra part)", why: "Turns many noisy samples into one robust estimate.", text: "Weights every sample by its physics-based quality, drops those outside ±87.5 % of the median, takes a log-domain weighted average, and flags ADC-vs-oscillator disagreement beyond a 1.5× ratio.", facts: { Gate: "±87.5 % of median", Mean: "log-domain, weighted", Mismatch: "ratio > 1.5 warns" } },
  };

  const ARCH = [
    { id: "esp32", tag: "MCU", title: "ESP32-S3", text: "ADC, oscillator ISR and GPIO policy. The closed loop." },
    { id: "lm393", tag: "SENSE", title: "LM393", text: "1.65 V midpoint + hysteresis. Hardware-in-the-loop oscillator." },
    { id: "buf", tag: "DRIVE", title: "Buffer", text: "SN74LVC1G34 gives sharp, low-impedance 3.3 V steps." },
    { id: "mux", tag: "RANGE", title: "MAX4619", text: "Buffered 4:1 mux → 100 Ω / 1 kΩ / 100 kΩ / 1 MΩ." },
    { id: "cblock", tag: "ISO", title: "C_block", text: "1000 µF ∥ 100 nF. DC bias dies here. Measurement AC passes." },
    { id: "ssr1", tag: "SAFE", title: "PhotoMOS bank", text: "Pre-charge, discharge and clamp. GPIO18 is the interlock." },
  ];

  const BOM = [
    ["1", "Microcontroller", "ESP32-S3 (Freenove WROOM)", "Main controller: ADC, oscillator ISR, mux + SSR control", "esp32"],
    ["1", "Comparator", "LM393", "External Schmitt trigger / relaxation-oscillator sense", "lm393"],
    ["1", "Logic buffer", "SN74LVC1G34", "Push-pull 3.3 V step excitation driver", "buf"],
    ["1", "Analog mux", "MAX4619", "4:1 low-leakage range select (A0/A1)", "mux"],
    ["1", "Schottky array", "BAT54S", "Clamps V_cap to GND / 3.3 V", "bat54s"],
    ["1", "Electrolytic", "1000 µF / ≥25 V", "C_block, isolates MCU from the 0–20 V bias", "cblock"],
    ["1", "Ceramic", "100 nF / ≥25 V", "HF bypass across C_block", "cnf"],
    ["3", "PhotoMOS SSR", "AQY212 / TLP241A", "S1 pre-charge, S2 discharge, S3 V_cap clamp", "ssr1"],
    ["1", "Resistor 1%", "1 MΩ", "R_bias high-Z DC bias injection", "rbias"],
    ["1", "Resistor 1%", "100 Ω", "Range 0 (MAX4619 CH2)", "r100"],
    ["1", "Resistor 1%", "1 kΩ", "Range 1 (MAX4619 CH1)", "r1k"],
    ["1", "Resistor 1%", "100 kΩ", "Range 2 (MAX4619 CH0)", "r100k"],
    ["1", "Resistor 1%", "1 MΩ", "Range 3 (MAX4619 CH3)", "r1m"],
    ["1", "Resistor", "10 Ω", "SSR1 pre-charge inrush limit", "rpre"],
    ["1", "Resistor", "100 Ω", "SSR2 discharge bleed", "rdis"],
    ["1", "Resistor", "1 Ω", "SSR3 V_cap clamp inrush absorber", "rclamp"],
    ["2", "Resistor", "10 kΩ", "LM393 1.65 V reference divider", "refdiv"],
    ["1", "Resistor", "100 kΩ", "LM393 hysteresis (positive feedback)", "rhyst"],
    ["1", "Resistor", "10 kΩ", "LM393 open-collector pull-up", "rpull"],
    ["3", "Resistor", "330 Ω", "PhotoMOS LED current limit", "r330"],
    ["1", "MLCC (example DUT)", "470 nF", "Calibration test capacitor", "cdut"],
  ];

  const PINS = [
    { id: "GPIO3", side: "left", y: 18, title: "GPIO3 · bias ground return", text: "Held strictly LOW. It is the return reference for the external bias domain, not the ESP32 signal ground." },
    { id: "GPIO4", side: "left", y: 38, title: "GPIO4 · mux A0", text: "MAX4619 address LSB. With A1 it selects 100 kΩ / 1 kΩ / 100 Ω / 1 MΩ (channels 0 · 1 · 2 · 3)." },
    { id: "GPIO5", side: "left", y: 58, title: "GPIO5 · mux A1", text: "MAX4619 address MSB. Together with GPIO4 it picks the range resistor." },
    { id: "GPIO10", side: "left", y: 78, title: "GPIO10 · ADC1_CH9", text: "RC-step tracker. The ADC samples V_cap, firmware fits the exponential and returns C_eq = τ / R_eff. Hard-gated off below 1 nF." },
    { id: "GPIO12", side: "right", y: 18, title: "GPIO12 · discharge", text: "SSR2. Connects N_DUT to GND through 100 Ω. Always the last state before handling the DUT." },
    { id: "GPIO14", side: "right", y: 38, title: "GPIO14 · LM393 output", text: "Input with an ANYEDGE interrupt. The ISR mirrors the comparator level onto GPIO16, closing the relaxation oscillator. Rate-limited to ~166 kHz." },
    { id: "GPIO16", side: "right", y: 58, title: "GPIO16 · excitation drive", text: "Goes only into the SN74LVC1G34. Toggled by the oscillator ISR, or held high for the RC-step." },
    { id: "GPIO18", side: "right", y: 78, title: "GPIO18 · pre-charge / clamp", text: "Fires SSR1 and SSR3 together. Charges N_DUT through 10 Ω while forcing V_cap to GND through 1 Ω. The hardware interlock." },
  ];

  const TOUR = [
    { sheet: "sys", sel: "esp32", text: "ESWCap is an autoranging capacitance meter on an ESP32-S3. It treats every (range, method) pair as an independent sensor and fuses them into one estimate." },
    { sheet: "sys", sel: "buf", text: "The ESP32 GPIO16 only drives the SN74LVC1G34. That buffer provides sharp, low-impedance 3.3 V steps without loading the MCU pin." },
    { sheet: "sys", sel: "mux", text: "A MAX4619 4:1 mux picks one of four range resistors. Auto-ranging is just two address bits: GPIO4 and GPIO5." },
    { sheet: "sys", sel: "vcap", text: "V_cap is the only analog node the ESP32 touches. It is read by GPIO10, watched by the LM393, and clamped by BAT54S and SSR3." },
    { sheet: "sys", sel: "lm393", text: "In oscillator mode the LM393 fires on V_cap; the ESP32 ISR mirrors its output back onto the buffer. That closes a hardware-in-the-loop relaxation oscillator." },
    { sheet: "sys", sel: "cblock", text: "C_block is the galvanic wall: 1000 µF ∥ 100 nF. The 0–20 V bias stays on N_DUT; only the measurement AC crosses to V_cap." },
    { sheet: "sys", sel: "rbias", text: "R_bias (1 MΩ) holds N_DUT at the bias voltage. Stiff for DC, but far too large to disturb the AC measurement." },
    { sheet: "front", sel: "ssr3", text: "SSR3 is the interlock. Same GPIO18 as SSR1. It holds V_cap at GND through 1 Ω so C_block inrush never reaches GPIO10/GPIO14." },
    { sheet: "front", sel: "r1m", text: "The 1 MΩ range is where sensitivity is highest and the ~136 pF board parasitic dominates. A measured tare (T0) removes it mathematically." },
    { sheet: "front", sel: "r100", text: "The 100 Ω range charges microfarads quickly. Buffer Zo plus mux Ron are a big fraction of it, so R_eff is calibrated per range." },
    { sheet: "front", sel: "bat54s", text: "BAT54S is the last line of defence for GPIO10 and GPIO14, clamping V_cap between roughly −0.3 V and 3.6 V." },
    { sheet: "front", sel: "ssr2", text: "When the test is over, GPIO12 closes SSR2 and 100 Ω dumps the DUT to ground. Only then is it safe to unclip the part." },
    { sheet: "auto", sel: "probe", text: "PROBE runs a fast oscillator reading on the remembered range to get a rough capacitance for planning — no full sweep." },
    { sheet: "auto", sel: "sweep", text: "SWEEP runs the ADC on every range whose predicted τ lands in the clean window, plus one oscillator run on the best range." },
    { sheet: "auto", sel: "fuse", text: "FUSION gates outliers against the median, then takes a log-domain weighted average. ADC and oscillator are cross-checked for disagreement." },
  ];

  /* ------------------------------------------------------------------ */
  /* SVG helpers                                                         */
  /* ------------------------------------------------------------------ */
  function el(tag, attrs = {}, kids = []) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "text") e.textContent = v;
      else e.setAttribute(k, v);
    }
    kids.forEach((c) => e.appendChild(c));
    return e;
  }
  function group(parent, id, extra = "") {
    const g = el("g", { class: "part" + (extra ? " " + extra : ""), "data-id": id });
    parent.appendChild(g);
    return g;
  }
  function txt(parent, x, y, s, cls = "lbl") {
    parent.appendChild(el("text", { x, y, class: cls, text: s }));
  }
  function dot(parent, x, y) {
    parent.appendChild(el("circle", { cx: x, cy: y, r: 2.4, class: "dot" }));
  }
  function wire(parent, d, cls = "", net = "") {
    const p = el("path", { d, class: "w " + cls, "data-net": net, fill: "none" });
    parent.appendChild(p);
    return p;
  }
  function gnd(parent, x, y) {
    const g = el("g", { class: "gnd-sym" });
    g.appendChild(el("path", { d: `M${x} ${y} v12 M${x - 12} ${y + 12} h24 M${x - 8} ${y + 17} h16 M${x - 4} ${y + 22} h8` }));
    parent.appendChild(g);
  }
  function arrow(parent, x1, y1, x2, y2, cls = "") {
    const p = el("path", { d: `M${x1} ${y1} L${x2} ${y2}`, class: "w " + cls, fill: "none" });
    parent.appendChild(p);
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const s = 9, a = 0.5;
    const hx = x2 - s * Math.cos(ang - a), hy = y2 - s * Math.sin(ang - a);
    const gx = x2 - s * Math.cos(ang + a), gy = y2 - s * Math.sin(ang + a);
    parent.appendChild(el("path", { d: `M${hx} ${hy} L${x2} ${y2} L${gx} ${gy}`, class: "w " + cls, fill: "none" }));
    return p;
  }
  function nodeClick(g, id) {
    g.addEventListener("click", (ev) => { ev.stopPropagation(); selectPart(id); });
  }
  function box(parent, id, x, y, w, h, title, sub) {
    const g = group(parent, id);
    g.appendChild(el("rect", { x, y, width: w, height: h, rx: 6, class: "body" }));
    txt(g, x + 12, y + 22, title, "title");
    if (sub) txt(g, x + 12, y + 40, sub, "box-sub");
    nodeClick(g, id);
    return g;
  }
  function resHV(parent, id, x, y, len, label, vertical = false) {
    const g = group(parent, id);
    if (!vertical) {
      g.appendChild(el("path", { d: `M${x} ${y} h10`, class: "w" }));
      g.appendChild(el("rect", { x: x + 10, y: y - 8, width: len - 20, height: 16, class: "body" }));
      g.appendChild(el("path", { d: `M${x + len - 10} ${y} h10`, class: "w" }));
      txt(g, x + len / 2, y - 14, label, "lbl-sm");
    } else {
      g.appendChild(el("path", { d: `M${x} ${y} v10`, class: "w" }));
      g.appendChild(el("rect", { x: x - 8, y: y + 10, width: 16, height: len - 20, class: "body" }));
      g.appendChild(el("path", { d: `M${x} ${y + len - 10} v10`, class: "w" }));
      txt(g, x + 14, y + len / 2, label, "lbl-sm");
    }
    nodeClick(g, id);
    return g;
  }
  function capV(parent, id, x, y, label, polar = false) {
    const g = group(parent, id);
    g.appendChild(el("path", { d: `M${x} ${y} v10`, class: "w" }));
    g.appendChild(el("path", { d: `M${x - 12} ${y + 10} h24`, class: "w", "stroke-width": 2.2 }));
    g.appendChild(el("path", { d: `M${x - 12} ${y + 18} h24`, class: "w", "stroke-width": 2.2 }));
    g.appendChild(el("path", { d: `M${x} ${y + 18} v10`, class: "w" }));
    if (polar) txt(g, x - 22, y + 16, "+", "lbl-sm");
    txt(g, x + 16, y + 18, label, "lbl-sm");
    nodeClick(g, id);
  }
  function capH(parent, id, x, y, label) {
    const g = group(parent, id);
    g.appendChild(el("path", { d: `M${x} ${y} h10`, class: "w" }));
    g.appendChild(el("path", { d: `M${x + 10} ${y - 12} v24`, class: "w", "stroke-width": 2.2 }));
    g.appendChild(el("path", { d: `M${x + 18} ${y - 12} v24`, class: "w", "stroke-width": 2.2 }));
    g.appendChild(el("path", { d: `M${x + 18} ${y} h10`, class: "w" }));
    txt(g, x + 14, y - 18, label, "lbl-sm");
    nodeClick(g, id);
  }
  /* 4-pin SSR body. pin 4 = left signal, pin 3 = right signal, LED pins 1/2 bottom. */
  function ssr4(parent, id, x, y, title, gpio) {
    const g = group(parent, id);
    g.appendChild(el("rect", { x, y, width: 150, height: 88, rx: 5, class: "body" }));
    txt(g, x + 10, y + 22, title, "title");
    txt(g, x + 10, y + 40, "AQY212 PhotoMOS", "box-sub");
    txt(g, x + 10, y + 60, gpio + " via 330 \u03a9", "lbl-sm");
    txt(g, x - 16, y + 74, "4", "pin-lbl");
    txt(g, x + 156, y + 24, "3", "pin-lbl");
    txt(g, x + 18, y + 104, "1", "pin-lbl");
    txt(g, x + 46, y + 104, "2", "pin-lbl");
    nodeClick(g, id);
    wire(parent, `M${x} ${y + 70} H${x - 20}`, "");
    wire(parent, `M${x + 150} ${y + 18} H${x + 170}`, "");
  }
  function ssrLed(S, id, x, y, gpio) {
    const p1x = x + 18, top = y + 88;
    const g = el("g", { class: "part", "data-id": "r330" });
    g.appendChild(el("path", { d: `M${p1x} ${top} v6`, class: "w" }));
    g.appendChild(el("rect", { x: p1x - 6, y: top + 6, width: 12, height: 26, class: "body" }));
    g.appendChild(el("path", { d: `M${p1x} ${top + 32} v6`, class: "w" }));
    g.addEventListener("click", (ev) => { ev.stopPropagation(); selectPart("r330"); });
    S.fg.appendChild(g);
    txt(S.fg, p1x - 10, top + 52, gpio, "pin-lbl");
    txt(S.fg, p1x + 14, top + 22, "330 \u03a9", "pin-lbl");
    wire(S.bg, `M${x + 46} ${top} V${top + 32}`, "gnd");
    gnd(S.fg, x + 46, top + 32);
  }
  function comparator(parent, id, x, y, label) {
    const g = group(parent, id);
    g.appendChild(el("path", { d: `M${x} ${y - 38} L${x + 84} ${y} L${x} ${y + 38} Z`, class: "body" }));
    txt(g, x + 12, y - 10, "+", "lbl");
    txt(g, x + 14, y + 24, "\u2212", "lbl");
    txt(g, x + 20, y + 56, label, "lbl-sm");
    nodeClick(g, id);
    wire(parent, `M${x - 24} ${y - 18} H${x}`, "");
    wire(parent, `M${x - 24} ${y + 18} H${x}`, "");
    wire(parent, `M${x + 84} ${y} H${x + 104}`, "");
  }
  function svgRoot(vbW, vbH) {
    const svg = el("svg", { viewBox: `0 0 ${vbW} ${vbH}`, class: "sch", preserveAspectRatio: "xMidYMid meet" });
    const f = el("filter", { id: "glow" });
    f.appendChild(el("feGaussianBlur", { stdDeviation: "2.2", result: "b" }));
    f.appendChild(el("feMerge", {}, [el("feMergeNode", { in: "b" }), el("feMergeNode", { in: "SourceGraphic" })]));
    svg.appendChild(f);
    const bg = el("g", { class: "wires" });
    const fg = el("g", { class: "parts" });
    svg.appendChild(bg); svg.appendChild(fg);
    svg.addEventListener("click", () => selectPart(null));
    return { svg, bg, fg, w: vbW, h: vbH };
  }

  /* ------------------------------------------------------------------ */
  /* Sheets                                                              */
  /* ------------------------------------------------------------------ */

  /* ====================  SYSTEM VIEW  ==================== */
  function drawSystem() {
    const S = svgRoot(1600, 880);
    txt(S.fg, 40, 38, "SYSTEM VIEW  ·  ESP32-S3 autoranging capacitor analyzer", "sheet-title");
    txt(S.fg, 40, 60, "Orange = high-voltage / bias domain  ·  blue = MCU-side analog  ·  amber = drive  ·  grey = GPIO control.  The ESP32 only ever sees the 0–3.3 V V_cap node.", "note");

    /* rails */
    wire(S.bg, "M40 100 H1560", "hv", "vbias");
    txt(S.fg, 40, 94, "V_BIAS 0–20 V", "rail-lbl");
    wire(S.bg, "M40 840 H1560", "gnd");
    txt(S.fg, 1520, 834, "GND", "rail-lbl");

    /* chain */
    const g1 = box(S.fg, "esp32", 40, 380, 190, 110, "ESP32-S3", "Freenove WROOM · ESP-IDF");
    txt(g1, 52, 448, "GPIO16 drive · GPIO10 ADC", "pin-lbl");
    txt(g1, 52, 462, "GPIO14 LM393 · GPIO4/5 mux", "pin-lbl");
    txt(g1, 52, 476, "GPIO18 SSR1+3 · GPIO12 SSR2", "pin-lbl");
    box(S.fg, "buf", 260, 380, 150, 110, "SN74LVC1G34", "3.3 V push-pull");
    box(S.fg, "mux", 440, 380, 150, 110, "MAX4619", "4:1 range mux");
    const g4 = box(S.fg, "rbank", 620, 380, 170, 110, "Range bank", "R_range");
    txt(g4, 632, 470, "100 Ω · 1 kΩ · 100 kΩ · 1 MΩ", "pin-lbl");
    box(S.fg, "vcap", 820, 380, 180, 110, "V_cap", "0–3.3 V · safe");
    box(S.fg, "cblock", 1030, 380, 160, 110, "C_block", "1000 µF ∥ 100 nF");
    box(S.fg, "ndut", 1220, 380, 140, 110, "N_DUT", "0–20 V");
    box(S.fg, "cdut", 1390, 380, 140, 110, "C_DUT", "unknown");

    arrow(S.bg, 232, 435, 258, 435, "drive");
    arrow(S.bg, 412, 435, 438, 435, "drive");
    arrow(S.bg, 592, 435, 618, 435, "drive");
    arrow(S.bg, 792, 435, 818, 435, "analog");
    arrow(S.bg, 1002, 435, 1028, 435, "analog");
    arrow(S.bg, 1192, 435, 1218, 435, "hv");
    arrow(S.bg, 1362, 435, 1388, 435, "hv");
    txt(S.bg, 630, 366, "drive →", "note");
    txt(S.bg, 1058, 366, "AC only →", "note");

    /* V_cap attachments */
    box(S.fg, "vcap", 690, 170, 220, 66, "GPIO10 · ADC1_CH9", "RC-step tracking");
    wire(S.bg, "M860 380 V236", "analog", "vcap");
    dot(S.fg, 860, 380);

    const lm = box(S.fg, "lm393", 940, 150, 300, 110, "LM393 comparator", "1.65 V ref · 100 kΩ hyst · 10 kΩ pull-up");
    txt(lm, 952, 210, "out → GPIO14 (ANYEDGE ISR)", "pin-lbl");
    wire(S.bg, "M940 205 H905 V380", "analog", "vcap");
    dot(S.fg, 905, 380);

    const bs = box(S.fg, "bat54s", 1280, 160, 210, 70, "BAT54S clamp", "GND ← V_cap → 3.3 V");
    wire(S.bg, "M1385 230 V310 H1000 V380", "analog", "vcap");
    dot(S.fg, 1000, 380);

    /* R_bias */
    const rb = box(S.fg, "rbias", 1130, 275, 200, 64, "1 MΩ R_bias", "DC in · AC open");
    wire(S.bg, "M1230 100 V275", "hv", "vbias");
    wire(S.bg, "M1230 339 V380", "hv", "ndut");
    dot(S.fg, 1230, 100);
    dot(S.fg, 1230, 380);

    /* safety bank below */
    const s3 = box(S.fg, "ssr3", 740, 570, 210, 84, "SSR3 — CLAMP", "1 Ω · GPIO18");
    wire(S.bg, "M845 490 V570", "analog", "vcap");
    dot(S.fg, 845, 490);
    const s1 = box(S.fg, "ssr1", 1010, 570, 210, 84, "SSR1 — PRE-CHARGE", "10 Ω · GPIO18");
    wire(S.bg, "M1200 490 V535 H1115 V570", "hv", "ndut");
    dot(S.fg, 1200, 490);
    const s2 = box(S.fg, "ssr2", 1250, 570, 210, 84, "SSR2 — DISCHARGE", "100 Ω · GPIO12");
    wire(S.bg, "M1290 490 V535 H1355 V570", "hv", "ndut");
    dot(S.fg, 1290, 490);

    txt(S.fg, 40, 820, "Every box is clickable. The high-voltage path stops at C_block; the measurement path stops at the BAT54S-clamped V_cap node.", "note");
    return S.svg;
  }

  /* ====================  FRONT-END  ==================== */
  function drawFront() {
    const S = svgRoot(1620, 980);
    txt(S.fg, 40, 34, "SHEET 1  ·  MEASUREMENT & SAFETY FRONT-END", "sheet-title");
    txt(S.fg, 40, 56, "GPIO18 fires SSR1 AND SSR3 together  ·  C_block is the DC fire-wall  ·  V_cap is the only node the ESP32 touches", "note");

    /* rails */
    wire(S.bg, "M40 90 H1580", "hv", "vbias");
    txt(S.fg, 40, 84, "V_BIAS 0–20 V", "rail-lbl");
    wire(S.bg, "M40 950 H1580", "gnd");

    /* N_DUT spine */
    wire(S.bg, "M520 150 V500", "hv", "ndut");
    txt(S.fg, 545, 165, "N_DUT", "rail-lbl");

    /* R_bias */
    resHV(S.fg, "rbias", 470, 90, 120, "1 MΩ", true);
    wire(S.bg, "M470 90 H520 V90", "hv");
    dot(S.fg, 470, 90);
    wire(S.bg, "M470 210 V150 H520", "hv", "ndut");
    dot(S.fg, 520, 150);
    txt(S.fg, 388, 130, "R_bias 1 MΩ", "pin-lbl");

    /* SSR1 pre-charge */
    ssr4(S.fg, "ssr1", 150, 100, "SSR1 PRE-CHARGE", "GPIO18");
    resHV(S.fg, "rpre", 60, 90, 110, "10 Ω", true);
    dot(S.fg, 60, 90);
    wire(S.bg, "M60 200 V170 H130", "hv");
    wire(S.bg, "M320 118 H520", "hv", "ndut");
    dot(S.fg, 520, 118);
    ssrLed(S, "ssr1", 150, 100, "GPIO18");

    /* SSR2 discharge */
    ssr4(S.fg, "ssr2", 40, 300, "SSR2 DISCHARGE", "GPIO12");
    wire(S.bg, "M210 318 H520", "hv", "ndut");
    dot(S.fg, 520, 318);
    resHV(S.fg, "rdis", 130, 470, 130, "100 Ω", true);
    wire(S.bg, "M20 370 V470 H130", "gnd");
    wire(S.bg, "M130 600 V950", "gnd");
    gnd(S.fg, 130, 950);
    ssrLed(S, "ssr2", 40, 300, "GPIO12");

    /* C_DUT */
    capV(S.fg, "cdut", 520, 500, "C_DUT", true);
    wire(S.bg, "M520 548 V950", "gnd");
    gnd(S.fg, 520, 950);
    dot(S.fg, 520, 500);

    /* C_block + HF bypass */
    capH(S.fg, "cblock", 560, 430, "");
    capH(S.fg, "cnf", 560, 350, "");
    txt(S.fg, 610, 356, "100 nF", "lbl-sm");
    txt(S.fg, 610, 452, "1000 µF", "lbl-sm");
    txt(S.fg, 596, 336, "C_block", "box-sub");
    wire(S.bg, "M520 430 H560", "analog", "ndut");
    wire(S.bg, "M520 430 V350 H560", "analog");
    dot(S.fg, 520, 430);
    wire(S.bg, "M588 430 H620", "analog", "vcap");
    wire(S.bg, "M588 350 H620 V430", "analog");

    /* V_cap bus */
    wire(S.bg, "M620 430 H1260", "analog", "vcap");
    dot(S.fg, 620, 430);
    txt(S.fg, 640, 420, "V_cap", "rail-lbl");

    /* BAT54S */
    const gd = group(S.fg, "bat54s");
    gd.appendChild(el("rect", { x: 900, y: 250, width: 180, height: 84, rx: 5, class: "body" }));
    txt(gd, 912, 272, "BAT54S clamp", "title");
    txt(gd, 912, 290, "GND ← V_cap → 3.3 V", "box-sub");
    txt(gd, 912, 308, "protects GPIO10/14", "lbl-sm");
    nodeClick(gd, "bat54s");
    wire(S.bg, "M990 334 V430", "analog", "vcap");
    dot(S.fg, 990, 430);
    wire(S.bg, "M900 270 H840 V120", "vdd");
    txt(S.fg, 790, 128, "+3.3 V", "lbl-sm");
    wire(S.bg, "M1080 292 H1120 V950", "gnd");
    gnd(S.fg, 1120, 950);

    /* SSR3 clamp */
    ssr4(S.fg, "ssr3", 700, 500, "SSR3 CLAMP", "GPIO18");
    wire(S.bg, "M870 518 H920 V430", "analog", "vcap");
    dot(S.fg, 920, 430);
    resHV(S.fg, "rclamp", 680, 588, 120, "1 Ω", true);
    wire(S.bg, "M680 570 V588", "gnd");
    wire(S.bg, "M680 708 V950", "gnd");
    gnd(S.fg, 680, 950);
    ssrLed(S, "ssr3", 700, 500, "GPIO18");

    /* LM393 network (right) */
    comparator(S.fg, "lm393", 1300, 300, "LM393");
    /* reference divider: +3.3 → 10 kΩ → 1.65 V → 10 kΩ → GND */
    txt(S.fg, 1198, 146, "+3.3 V", "lbl-sm");
    resHV(S.fg, "refdiv", 1230, 150, 120, "10 kΩ", true);      /* 150..270 */
    resHV(S.fg, "refdiv", 1230, 270, 120, "10 kΩ", true);      /* 270..390 */
    wire(S.bg, "M1230 150 V130 H1300", "vdd");
    wire(S.bg, "M1230 270 H1270 V318 H1300", "analog", "vref");
    dot(S.fg, 1230, 270);
    wire(S.bg, "M1230 390 V420", "gnd");
    gnd(S.fg, 1230, 420);
    /* IN+ from V_cap bus, with 100 kΩ hysteresis from the output */
    wire(S.bg, "M1300 282 H1260 V430", "analog", "vcap");
    dot(S.fg, 1260, 430);
    resHV(S.fg, "rhyst", 1050, 200, 130, "100 kΩ", false);     /* 1050..1180 */
    wire(S.bg, "M1384 300 V200 H1180", "analog", "hyst");
    wire(S.bg, "M1050 200 V282 H1300", "analog", "hyst");
    txt(S.fg, 1050, 190, "hyst → IN+", "pin-lbl");
    /* open-collector pull-up annotation */
    txt(S.fg, 1352, 348, "10 kΩ pull-up on out", "lbl-sm");
    /* output → GPIO14, and the ADC taps the same node */
    box(S.fg, "oscout", 1440, 270, 170, 62, "GPIO14 · LM393 out", "interrupt ANYEDGE");
    wire(S.bg, "M1384 300 H1440", "analog");
    box(S.fg, "vcap", 1440, 400, 170, 62, "GPIO10 · ADC1_CH9", "RC-step tracking");
    wire(S.bg, "M1260 430 H1440", "analog", "vcap");

    /* drive chain */
    box(S.fg, "esp32", 40, 740, 180, 84, "ESP32 GPIO16", "drive output");
    box(S.fg, "buf", 280, 740, 190, 84, "SN74LVC1G34", "push-pull buffer");
    box(S.fg, "mux", 520, 720, 220, 128, "MAX4619", "A0=GPIO4 A1=GPIO5");
    wire(S.bg, "M220 782 H280", "drive", "drive");
    wire(S.bg, "M470 782 H520", "drive", "drive");
    txt(S.fg, 522, 712, "Ron ≈ few Ω · low leakage", "pin-lbl");

    /* range resistors */
    resHV(S.fg, "r100k", 800, 680, 170, "CH0  100 kΩ");
    resHV(S.fg, "r1k", 800, 715, 170, "CH1  1 kΩ");
    resHV(S.fg, "r100", 800, 750, 170, "CH2  100 Ω");
    resHV(S.fg, "r1m", 800, 785, 170, "CH3  1 MΩ");
    wire(S.bg, "M740 782 V680 H800", "drive");
    wire(S.bg, "M740 782 V715 H800", "drive");
    wire(S.bg, "M740 782 V750 H800", "drive");
    wire(S.bg, "M740 782 V785 H800", "drive");
    wire(S.bg, "M970 680 H1010 V430", "analog", "vcap");
    wire(S.bg, "M970 715 H1050 V430", "analog");
    wire(S.bg, "M970 750 H1090 V430", "analog");
    wire(S.bg, "M970 785 H1130 V430", "analog");
    dot(S.fg, 1010, 430); dot(S.fg, 1050, 430); dot(S.fg, 1090, 430); dot(S.fg, 1130, 430);
    txt(S.fg, 40, 962, "Each SSR LED is driven from its GPIO through an inline 330 Ω resistor.  Oscillator: T = K·R·C + T0.  RC-step: τ = R_eff·C_eq.", "note");
    return S.svg;
  }

  /* ====================  AUTORANGING / FUSION  ==================== */
  function drawAuto() {
    const S = svgRoot(1500, 820);
    txt(S.fg, 40, 38, "SHEET 2  ·  AUTORANGING PIPELINE  (PROBE → SWEEP → FUSION)", "sheet-title");
    txt(S.fg, 40, 60, "Every (range, method) pair is an independent sensor. Each sample gets a physics-based quality weight; a median gate removes outliers; the survivors fuse in the log domain.", "note");

    box(S.fg, "cycle", 40, 350, 190, 96, "MEASUREMENT CYCLE", "one cycle · 1000 ms gap");
    box(S.fg, "probe", 300, 340, 220, 116, "PROBE", "fast OSC, remembered range");
    txt(S.fg, 312, 398, "→ rough C for planning", "pin-lbl");
    txt(S.fg, 312, 414, "no full sweep yet", "pin-lbl");

    box(S.fg, "probe", 590, 340, 180, 116, "SUB-nF GATE", "rough C < 1 nF ?");
    txt(S.fg, 602, 398, "yes → oscillator only", "pin-lbl");
    txt(S.fg, 602, 414, "ADC hard-gated", "pin-lbl");

    box(S.fg, "sweep", 840, 210, 280, 150, "SWEEP — ADC", "");
    txt(S.fg, 852, 254, "every range with", "lbl-sm");
    txt(S.fg, 852, 274, "250 µs ≤ predicted τ ≤ 4 s", "lbl-sm");
    txt(S.fg, 852, 300, "fit V(t)=V_inf(1−e^(−t/τ))", "lbl-sm");
    txt(S.fg, 852, 320, "R_eff, C0 from NVS per range", "lbl-sm");

    box(S.fg, "sweep", 840, 410, 280, 130, "SWEEP — OSC", "");
    txt(S.fg, 852, 454, "range minimising |ln(f/2000 Hz)|", "lbl-sm");
    txt(S.fg, 852, 474, "accept 100 Hz – 15 kHz", "lbl-sm");
    txt(S.fg, 852, 494, "T = K·R·C + T0 (tared)", "lbl-sm");

    box(S.fg, "fuse", 1180, 250, 290, 300, "FUSION", "");
    txt(S.fg, 1192, 294, "1 · weight by quality", "lbl-sm");
    txt(S.fg, 1192, 316, "   q = q_time·q_stray·q_range·q_fit", "lbl-sm");
    txt(S.fg, 1192, 338, "   q = q_freq·q_count·q_stray (OSC)", "lbl-sm");
    txt(S.fg, 1192, 368, "2 · median gate ±87.5 %", "lbl-sm");
    txt(S.fg, 1192, 390, "   drop q < 0.02 samples", "lbl-sm");
    txt(S.fg, 1192, 420, "3 · log-domain weighted mean", "lbl-sm");
    txt(S.fg, 1192, 450, "4 · ADC vs OSC mismatch > 1.5×", "lbl-sm");
    txt(S.fg, 1192, 470, "   → flag, still report fused value", "lbl-sm");
    txt(S.fg, 1192, 500, "5 · C_block series inversion > 1 µF", "lbl-sm");

    arrow(S.bg, 232, 398, 298, 398, "analog");
    arrow(S.bg, 522, 398, 588, 398, "analog");
    arrow(S.bg, 772, 380, 838, 285, "drive");
    arrow(S.bg, 772, 420, 838, 475, "drive");
    txt(S.bg, 774, 350, "no", "note");
    txt(S.bg, 774, 452, "yes", "note");
    arrow(S.bg, 1122, 300, 1178, 360, "analog");
    arrow(S.bg, 1122, 470, 1178, 430, "analog");

    txt(S.fg, 40, 620, "Selection rules", "title");
    txt(S.fg, 40, 648, "• ADC tried only when predicted τ ≥ 250 µs and ≤ 4 s; skipped entirely below 1 nF (oscillator owns sub-nF).", "note");
    txt(S.fg, 40, 670, "• Oscillator accepted for 100 Hz ≤ f ≤ 15 kHz; the ISR rate-limits edges faster than ~166 kHz so a fast range can never saturate the core.", "note");
    txt(S.fg, 40, 692, "• If the fastest range saturates, retry on 100 kΩ; a linear hunt falls back from 1 MΩ downward when the probe fails.", "note");
    txt(S.fg, 40, 714, "• Larger DUTs: C_eq is the series combination with C_block (1000 µF) — invert first, then subtract parallel stray.", "note");
    txt(S.fg, 40, 748, "Firmware owns all of this; the dashboard just displays the fused value, spread and per-sample breakdown.", "note");
    return S.svg;
  }

  /* ------------------------------------------------------------------ */
  /* View / select                                                       */
  /* ------------------------------------------------------------------ */
  const frame = $("#sch-frame");
  let svgElRef = null;
  let sheet = "sys";
  let selected = null;
  let mode = "idle";
  let range = "100k";
  let tourIdx = -1;
  let view = { x: 0, y: 0, k: 1 };

  const MODE_NETS = {
    idle: [],
    precharge: ["hv", "ndut"],
    osc: ["drive", "analog"],
    rc: ["drive", "analog"],
    discharge: ["gnd", "ndut"],
  };

  function applyView() {
    if (!svgElRef) return;
    svgElRef.style.transformOrigin = "0 0";
    svgElRef.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
  }
  function drawSheet() {
    frame.querySelectorAll("svg").forEach((s) => s.remove());
    const svg = sheet === "sys" ? drawSystem() : sheet === "front" ? drawFront() : drawAuto();
    svgElRef = svg;
    frame.appendChild(svg);
    view = { x: 0, y: 0, k: 1 };
    applyView();
    applyModeStyles();
    if (selected) markSelected(selected);
  }
  function markSelected(id) {
    $$(".part", frame).forEach((p) => p.classList.toggle("selected", p.getAttribute("data-id") === id));
  }
  function selectPart(id) {
    selected = id;
    markSelected(id);
    renderInspector(id);
    $$("#bom-table tr").forEach((tr) => tr.classList.toggle("active", tr.dataset.id === id));
  }
  function renderInspector(id) {
    const empty = $("#insp-empty");
    const body = $("#insp-body");
    if (!id || !PARTS[id]) { empty.hidden = false; body.hidden = true; return; }
    const p = PARTS[id];
    empty.hidden = true; body.hidden = false;
    const chips = (p.chips || []).map((c) => `<span class="chip ${c}">${c}</span>`).join("");
    const facts = Object.entries(p.facts || {}).map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("");
    body.innerHTML = `
      <div class="kicker">Inspector</div>
      <div class="meta">${p.kind} · ${p.loc}</div>
      <h3>${p.name}</h3>
      <div class="chips">${chips}</div>
      <p>${p.text}</p>
      <table class="kv">${facts}</table>
      <p style="margin-top:10px"><strong>Why it is here.</strong> ${p.why}</p>
      <p class="meta" style="margin-top:8px">${p.bom}</p>
      ${p.note ? `<div class="callout">${p.note}</div>` : ""}`;
  }
  function applyModeStyles() {
    const hot = MODE_NETS[mode] || [];
    $$(".w", frame).forEach((w) => {
      const cls = [...w.classList];
      const match = hot.some((h) => cls.includes(h) || w.dataset.net === h);
      w.classList.toggle("flow", match);
    });
  }

  /* pan / zoom */
  (function panzoom() {
    let dragging = false, lx = 0, ly = 0;
    frame.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".part")) return;
      dragging = true; lx = e.clientX; ly = e.clientY; frame.setPointerCapture(e.pointerId);
    });
    frame.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      view.x += e.clientX - lx; view.y += e.clientY - ly; lx = e.clientX; ly = e.clientY; applyView();
    });
    frame.addEventListener("pointerup", () => dragging = false);
    frame.addEventListener("wheel", (e) => {
      e.preventDefault();
      const f = e.deltaY < 0 ? 1.08 : 0.92;
      view.k = Math.min(3, Math.max(0.4, view.k * f));
      applyView();
    }, { passive: false });
  })();

  /* ------------------------------------------------------------------ */
  /* Toolbar + tour                                                      */
  /* ------------------------------------------------------------------ */
  function toolbar() {
    $("#toolbar").innerHTML = `
      <button class="btn ${sheet === "sys" ? "active" : ""}" data-sheet="sys">System</button>
      <button class="btn ${sheet === "front" ? "active" : ""}" data-sheet="front">Front-end</button>
      <button class="btn ${sheet === "auto" ? "active" : ""}" data-sheet="auto">Autoranging</button>
      <div class="sep"></div>
      ${["idle", "precharge", "osc", "rc", "discharge"].map((m) =>
        `<button class="btn ${mode === m ? "active" : ""}" data-mode="${m}">${m}</button>`).join("")}
      <div class="sep"></div>
      <button class="btn ghost" id="btn-tour">Guided tour</button>
      <button class="btn ghost" id="btn-reset">Reset view</button>`;
    $$("#toolbar [data-sheet]").forEach((b) => b.onclick = () => { sheet = b.dataset.sheet; drawSheet(); toolbar(); });
    $$("#toolbar [data-mode]").forEach((b) => b.onclick = () => {
      mode = b.dataset.mode; applyModeStyles(); toolbar();
      const mb = $(`#mode-btns .btn[data-m="${mode === "osc" ? "osc" : mode === "rc" ? "rc" : mode}"]`);
      if (mb) { labMode = mode; syncLabButtons(); drawScope(); }
    });
    $("#btn-tour").onclick = () => startTour(0);
    $("#btn-reset").onclick = () => { view = { x: 0, y: 0, k: 1 }; applyView(); };
  }
  function startTour(i) {
    tourIdx = i;
    const step = TOUR[i];
    $("#tourbar").classList.add("show");
    $("#tour-text").textContent = `${i + 1}/${TOUR.length}  —  ${step.text}`;
    sheet = step.sheet; drawSheet(); toolbar(); selectPart(step.sel);
  }
  $("#tour-next").onclick = () => startTour(Math.min(TOUR.length - 1, tourIdx + 1));
  $("#tour-prev").onclick = () => startTour(Math.max(0, tourIdx - 1));
  $("#tour-end").onclick = () => { $("#tourbar").classList.remove("show"); tourIdx = -1; };

  /* ------------------------------------------------------------------ */
  /* Sections                                                            */
  /* ------------------------------------------------------------------ */
  $("#arch-cards").innerHTML = ARCH.map((a) => `
    <div class="arch-card" data-id="${a.id}">
      <div class="tag">${a.tag}</div>
      <h3>${a.title}</h3>
      <p>${a.text}</p>
    </div>`).join("");
  $$(".arch-card").forEach((c) => c.onclick = () => {
    const jump = { esp32: "sys", lm393: "front", buf: "sys", mux: "sys", cblock: "front", ssr1: "front" };
    sheet = jump[c.dataset.id] || "sys";
    drawSheet(); toolbar(); selectPart(c.dataset.id);
    document.getElementById("schematic").scrollIntoView({ behavior: "smooth" });
  });

  $("#mode-cards").innerHTML = `
    <div class="panel card"><span class="br"></span><span class="bl"></span>
      <div class="kicker">Mode A · small C</div>
      <h3>LM393 relaxation oscillator</h3>
      <p>The buffer drives a square wave through the selected range resistor into V_cap. The LM393
      compares V_cap against its 1.65 V midpoint with hysteresis. Each crossing raises GPIO14, and the
      ESP32 ISR mirrors that level back onto GPIO16 — closing a hardware-in-the-loop oscillator.</p>
      <div class="formula">T = K · R · C_dut + T0 &nbsp;⇒&nbsp; C_eq = (T − T0) / (K · R)</div>
      <p><code>T0</code> is a <strong>measured per-range</strong> open-node offset that absorbs the
      ~136 pF board parasitic and the fixed ISR/comparator latency. <code>K</code> is a dimensionless
      geometry constant, calibrated per range.</p>
      <p>Small ceramics live here. The ISR rate-limits edges faster than ~166 kHz, so even a bare node
      can never saturate the core.</p>
    </div>
    <div class="panel card"><span class="br"></span><span class="bl"></span>
      <div class="kicker">Mode B · large C</div>
      <h3>ADC RC-step tracking</h3>
      <p>The drive is held high and V_cap rises as an exponential. GPIO10 (ADC1_CH9) samples the curve;
      firmware fits it and reads τ. Preferred for electrolytics whose period would be seconds.</p>
      <div class="formula">V(t) = V_inf · (1 − e<sup>−t/τ</sup>) &nbsp;⇒&nbsp; C_eq = τ / R_eff</div>
      <p>The node does not always reach 3.3 V: R_bias/leakage forms a divider with the range resistor,
      so <code>V_inf</code> is measured per range and the τ crossing sits at 63.2 % of it. The ADC is
      hard-gated off below 1 nF, where the oscillator owns the measurement.</p>
    </div>`;

  $("#pipe").innerHTML = `
    <div class="panel stage"><span class="br"></span><span class="bl"></span>
      <div class="phase">Phase 1</div><h3>PROBE</h3>
      <p>A fast oscillator reading on the remembered range gives a rough capacitance for planning.</p>
      <ul><li>No full sweep first</li><li>One short measurement</li></ul>
      <span class="arrow">→</span>
    </div>
    <div class="panel stage"><span class="br"></span><span class="bl"></span>
      <div class="phase">Phase 2</div><h3>SWEEP</h3>
      <p>ADC τ-measurement on every range whose predicted τ is in-window, plus one oscillator run.</p>
      <ul><li>ADC: 250 µs ≤ τ ≤ 4 s</li><li>OSC: 100 Hz – 15 kHz, target 2 kHz</li></ul>
      <span class="arrow">→</span>
    </div>
    <div class="panel stage"><span class="br"></span><span class="bl"></span>
      <div class="phase">Phase 3</div><h3>FUSION</h3>
      <p>All samples weighted by quality, median-gated, then fused in the log domain.</p>
      <ul><li>Gate ±87.5 % of median</li><li>Disagreement flagged at 1.5×</li></ul>
    </div>`;

  $("#fusion").innerHTML = `
    <div class="panel card"><span class="br"></span><span class="bl"></span>
      <h3>Physics-based quality</h3>
      <p class="mini">ADC sample</p>
      <div class="formula">q = q_time · q_stray · q_range · q_fit</div>
      <p>Time quality is full from 200 µs to 20 ms with a Gaussian roll-off; fit quality rewards a clean
      R² ≥ 0.99; low-resistance ranges carry a 0.85 factor.</p>
      <p class="mini">OSC sample</p>
      <div class="formula">q = q_freq · q_count · q_stray</div>
      <p>Frequency quality is full from 500 Hz to 10 kHz; count quality rewards ≥ 50 averaged periods;
      tared ranges have no stray penalty.</p>
    </div>
    <div class="panel card"><span class="br"></span><span class="bl"></span>
      <h3>Gate, fuse and cross-check</h3>
      <p>Samples with <code>q &lt; 0.02</code> are discarded. The survivors must lie within
      <strong>±87.5 % of the median</strong>; the rest are gated out.</p>
      <div class="formula">C_fused = exp( Σ wᵢ ln Cᵢ / Σ wᵢ )</div>
      <p>The weighted mean is taken in the log domain, which suits a multiplicative quantity and lets
      the ADC and oscillator methods combine naturally.</p>
      <p>If the ADC-only and oscillator-only estimates differ by more than <strong>1.5×</strong>, the
      reading is flagged — but still reported so the operator can judge it.</p>
    </div>`;

  $("#theory-cards").innerHTML = [
    ["RC step", "V(t) = V_inf (1 − e^(−t/τ))", "Fit the rising exponential; the slope of ln(V_inf − V) is −1/τ. Then τ = R_eff·C_eq."],
    ["Per-range asymptote", "R_leak = V_inf·R / (V_nom − V_inf)", "R_bias and leakage pull V_inf below 3.3 V; it is measured per range and R_leak is folded into R_eff."],
    ["Oscillator model", "T = K·R·C_dut + T0", "K is a dimensionless geometry constant, T0 a measured per-range offset. Both are solved by calibration and stored in NVS."],
    ["C_block series", "C_eq = C_b·C_d / (C_b + C_d)", "Above 1 µF, invert the 1000 µF series combination first, then subtract parallel stray C."],
    ["ADC quality", "q = q_time·q_stray·q_range·q_fit", "Each sample is scored by how well the physics assumptions hold, not by a single confidence flag."],
    ["Fusion", "C = exp( Σ w ln C / Σ w )", "Median-gate outliers, then a quality-weighted geometric mean across every surviving (range, method) sample."],
  ].map(([h, f, t]) => `<div class="panel card"><span class="br"></span><span class="bl"></span><h3>${h}</h3><div class="formula">${f}</div><p>${t}</p></div>`).join("");

  const tb = $("#bom-table");
  tb.innerHTML = `<thead><tr><th>Qty</th><th>Type</th><th>Value / PN</th><th>Circuit location</th></tr></thead><tbody>` +
    BOM.map((r) => `<tr data-id="${r[4]}"><td>${r[0]}</td><td>${r[1]}</td><td><code>${r[2]}</code></td><td>${r[3]}</td></tr>`).join("") +
    `</tbody>`;
  $$("tr", tb).forEach((tr) => {
    if (!tr.dataset.id) return;
    tr.onclick = () => {
      const id = tr.dataset.id;
      const sysIds = ["esp32", "buf", "mux", "rbank"];
      sheet = sysIds.includes(id) ? "sys" : (id === "probe" ? "auto" : "front");
      drawSheet(); toolbar(); selectPart(id);
      document.getElementById("schematic").scrollIntoView({ behavior: "smooth" });
    };
  });

  const mcu = $("#mcu");
  mcu.innerHTML = `<div class="die"><b>ESP32-S3</b><div class="pin-lbl" style="margin-top:6px">Freenove WROOM · ESP-IDF</div></div>` +
    PINS.map((p) => `<div class="pin" data-pin="${p.id}" style="${p.side}:-8px; top:${p.y}%">${p.id}</div>`).join("");
  function showPin(id) {
    const p = PINS.find((x) => x.id === id);
    $$(".pin", mcu).forEach((el) => el.classList.toggle("active", el.dataset.pin === id));
    $("#pin-info").innerHTML = `<span class="br"></span><span class="bl"></span><div class="kicker">${p.id}</div><h3>${p.title}</h3><p>${p.text}</p>`;
  }
  $$(".pin", mcu).forEach((el) => el.onclick = () => showPin(el.dataset.pin));

  $("#fsm").innerHTML = [
    "IDLE — all SSRs off, range mux idle, drive low. DUT may be inserted. The device boots here.",
    "PRE-CHARGE — GPIO18 on: SSR3 clamps V_cap through 1 Ω while SSR1 charges N_DUT through 10 Ω. Hold 1000 ms. Bias already set.",
    "ISOLATE — GPIO18 off. N_DUT stays at bias through R_bias (1 MΩ). V_cap is free; BAT54S still watching.",
    "RANGE — set A0/A1 (GPIO4/5). PROBE on the remembered range, then SWEEP the in-window ADC ranges + the best oscillator range.",
    "MEASURE OSC — GPIO14 ISR mirrors the LM393 onto GPIO16; average 50 periods, then C_eq = (T − T0)/(K·R).",
    "MEASURE ADC — hold GPIO16 high; sample V_cap on GPIO10, fit the exponential, τ = R_eff·C_eq.",
    "FUSE — quality weights, ±87.5 % median gate, log-domain weighted mean, mismatch check.",
    "DISCHARGE — GPIO12 on: SSR2 bleeds N_DUT through 100 Ω. Then IDLE. Never unclip a biased DUT.",
  ].map((t) => `<li>${t}</li>`).join("");

  $("#fw-plan").innerHTML = `
    <p>The measurement path <strong>never closes SSR2</strong>. Each range setup only resets the MCU-side
    V_cap by driving it low, so a pre-charged C_DUT / C_block stay at V_BIAS through R_bias and the DUT is
    measured <em>under</em> the set DC bias.</p>
    <p><strong>auto-precharge ON</strong> — every reading re-asserts PRE-CHARGE (SSR1+SSR3, SSR2 off) then
    ISOLATE. <strong>OFF</strong> — the operator's manual <code>precharge</code> is preserved.</p>
    <p><strong>auto-discharge ON</strong> — a session end (<code>single</code>/<code>stop</code>/<code>idle</code>)
    bleeds the node. <strong>OFF</strong> — the bias is held until an explicit <code>discharge</code>.</p>
    <p>Calibration also keeps the bias: <code>zero</code>, <code>cal*</code>, <code>probe</code> all use the same
    bias-preserving <em>prepare_measurement()</em>. Per-range <code>K</code>/<code>T0</code> (oscillator) and
    <code>R_eff</code>/<code>C0</code> (ADC) persist to NVS across reboot.</p>
    <div class="callout">The device boots IDLE — nothing charged, nothing measured until instructed.</div>`;

  /* ------------------------------------------------------------------ */
  /* Lab simulator                                                       */
  /* ------------------------------------------------------------------ */
  const Rvals = { "100": 100, "1k": 1e3, "100k": 1e5, "1m": 1e6 };
  const RLABEL = { "100": "100 Ω", "1k": "1 kΩ", "100k": "100 kΩ", "1m": "1 MΩ" };
  const C_BLOCK = 1000e-6;
  const C_STRAY = 136e-12;          // board parasitic, absorbed by tare in firmware
  const R_PAR = 25 + 4;             // buffer Zo + MAX4619 Ron
  const VH = 2.05, VL = 1.25, VDRV = 3.3;  // LM393 1.65 V midpoint ± hysteresis

  function sliderToC(v) { return 1e-12 * Math.pow(10, (v / 1000) * 9); }
  function fmtC(c) {
    if (c < 900e-12) return (c * 1e12).toPrecision(3) + " pF";
    if (c < 900e-9) return (c * 1e9).toPrecision(3) + " nF";
    if (c < 900e-6) return (c * 1e6).toPrecision(3) + " µF";
    return (c * 1e3).toPrecision(3) + " mF";
  }
  function fmtF(f) {
    if (!isFinite(f) || f <= 0) return "—";
    if (f < 1e3) return f.toFixed(1) + " Hz";
    if (f < 1e6) return (f / 1e3).toFixed(2) + " kHz";
    return (f / 1e6).toFixed(2) + " MHz";
  }
  function fmtT(t) {
    if (t < 1e-6) return (t * 1e9).toFixed(1) + " ns";
    if (t < 1e-3) return (t * 1e6).toFixed(1) + " µs";
    if (t < 1) return (t * 1e3).toFixed(2) + " ms";
    return t.toFixed(2) + " s";
  }
  function ceff(cdut) { return (C_BLOCK * cdut) / (C_BLOCK + cdut) + C_STRAY; }
  function oscFreq(R, C) {
    const k = Math.log((VDRV - VL) / (VDRV - VH));   // rising to VH
    const fll = Math.log(VH / VL);                    // falling to VL
    return 1 / ((R + R_PAR) * C * (k + fll));
  }

  let labMode = "osc";
  function syncLabButtons() {
    $$("#range-btns .btn").forEach((b) => b.classList.toggle("active", b.dataset.r === range));
    $$("#mode-btns .btn").forEach((b) => b.classList.toggle("active", b.dataset.m === labMode));
  }
  $("#range-btns").innerHTML = Object.keys(Rvals).map((k) => `<button class="btn" data-r="${k}">${RLABEL[k]}</button>`).join("");
  $("#mode-btns").innerHTML = [["osc", "Oscillator"], ["rc", "RC step"], ["precharge", "Pre-charge"], ["discharge", "Discharge"]]
    .map(([m, l]) => `<button class="btn" data-m="${m}">${l}</button>`).join("");
  $$("#range-btns .btn").forEach((b) => b.onclick = () => { range = b.dataset.r; syncLabButtons(); drawScope(); });
  $$("#mode-btns .btn").forEach((b) => b.onclick = () => {
    labMode = b.dataset.m; mode = labMode; applyModeStyles(); toolbar(); syncLabButtons(); drawScope();
  });

  const canvas = $("#scope");
  const ctx = canvas.getContext("2d");

  function drawScope() {
    const cDut = sliderToC(+$("#c-slider").value);
    const vBias = (+$("#bias-slider").value) / 10;
    $("#c-readout").innerHTML = `<span>${fmtC(cDut)}</span><small>C_DUT</small>`;
    $("#bias-readout").innerHTML = `<span>${vBias.toFixed(1)} V</span><small>V_BIAS · external 0–20 V</small>`;

    const R = Rvals[range] + R_PAR;
    const C = ceff(cDut);
    const f = oscFreq(R, C);
    const tau = R * C;

    let result = "—", sub = "predicted observable";
    if (labMode === "osc") {
      result = fmtF(f);
      sub = `C_eq ${fmtC(C)} · ${f < 500 ? "below OSC plateau — prefer RC-step" : f > 15000 ? "above OSC window — higher R" : "in oscillator band"}`;
    } else if (labMode === "rc") {
      result = fmtT(tau);
      sub = `τ = R_eff·C_eq · 63.2 % at ${fmtT(tau)} · 5τ = ${fmtT(5 * tau)}`;
    } else if (labMode === "precharge") {
      result = fmtT(10 * cDut);
      sub = `DUT 5τ through 10 Ω ≈ ${fmtT(5 * 10 * cDut)} · V_cap held at 0 by SSR3`;
    } else {
      result = fmtT(100 * cDut);
      sub = `DUT 5τ through 100 Ω ≈ ${fmtT(5 * 100 * cDut)}`;
    }
    $("#result-readout").innerHTML = `<span>${result}</span><small>${sub}</small>`;

    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = "#070b10"; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#1b2734"; ctx.lineWidth = 1;
    for (let i = 0; i < 8; i++) { ctx.beginPath(); ctx.moveTo(0, (h / 8) * i); ctx.lineTo(w, (h / 8) * i); ctx.stroke(); }
    for (let i = 0; i < 12; i++) { ctx.beginPath(); ctx.moveTo((w / 12) * i, 0); ctx.lineTo((w / 12) * i, h); ctx.stroke(); }

    const yOf = (v) => h - 24 - (v / 4.0) * (h - 48);
    const T = labMode === "osc" ? (f > 0 ? 4 / f : 0.01)
      : labMode === "rc" ? 5 * tau
      : labMode === "precharge" ? 5 * 10 * cDut : 5 * 100 * cDut;
    const N = 1200, dt = T / N;

    ctx.font = "12px IBM Plex Mono"; ctx.fillStyle = "#8b9aab";
    ctx.fillText("0 V", 8, yOf(0) + 4);
    ctx.fillText("3.3 V", 8, yOf(3.3) + 4);

    function stroke(color, pts) {
      ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 2;
      pts.forEach((p, i) => {
        const x = (p.t / T) * (w - 20) + 10, y = yOf(p.v);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
    }

    if (labMode === "osc") {
      ctx.setLineDash([4, 4]); ctx.strokeStyle = "#9dffb0";
      ctx.beginPath(); ctx.moveTo(0, yOf(VH)); ctx.lineTo(w, yOf(VH)); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, yOf(VL)); ctx.lineTo(w, yOf(VL)); ctx.stroke();
      ctx.setLineDash([]);
      let v = VL, drv = VDRV;
      const cap = [], drvPts = [];
      for (let i = 0; i < N; i++) {
        const t = i * dt;
        v = drv + (v - drv) * Math.exp(-dt / (R * C));
        if (drv > 1 && v >= VH) drv = 0;
        if (drv < 1 && v <= VL) drv = VDRV;
        cap.push({ t, v }); drvPts.push({ t, v: drv });
      }
      stroke("#f3b23a", drvPts); stroke("#5ce1ff", cap);
    } else if (labMode === "rc") {
      const cap = [], drvPts = [];
      for (let i = 0; i < N; i++) {
        const t = i * dt;
        drvPts.push({ t, v: VDRV });
        cap.push({ t, v: VDRV * (1 - Math.exp(-t / (R * C))) });
      }
      stroke("#f3b23a", drvPts); stroke("#5ce1ff", cap);
      ctx.fillStyle = "#9dffb0";
      ctx.fillText("63.2% τ", (tau / T) * w, yOf(0.632 * VDRV) - 6);
    } else if (labMode === "precharge") {
      const cap = [], dut = [];
      const rdut = 10;
      for (let i = 0; i < N; i++) {
        const t = i * dt;
        const ramp = 1 - Math.exp(-t / (rdut * cDut));
        dut.push({ t, v: Math.min(3.9, (vBias / 20) * 3.9 * ramp) });
        cap.push({ t, v: 0.02 });
      }
      stroke("#ff8a6b", dut); stroke("#5ce1ff", cap);
      ctx.fillStyle = "#8b9aab";
      ctx.fillText("V_cap clamped ≈ 0", 80, yOf(0.3));
      ctx.fillText("N_DUT charging through 10 Ω", 80, yOf(3.2));
    } else {
      const dut = [];
      const V0 = Math.min(3.9, (vBias / 20) * 3.9);
      for (let i = 0; i < N; i++) { const t = i * dt; dut.push({ t, v: V0 * Math.exp(-t / (100 * cDut)) }); }
      stroke("#ff8a6b", dut);
    }
  }

  $("#c-slider").addEventListener("input", drawScope);
  $("#bias-slider").addEventListener("input", drawScope);

  /* init */
  toolbar();
  drawSheet();
  syncLabButtons();
  const target = 470e-9;
  const sv = 1000 * Math.log10(target / 1e-12) / 9;
  $("#c-slider").value = String(Math.round(sv));
  drawScope();
  selectPart("esp32");
})();
