/* STM32 Dual-Mode Capacitance Analyzer — interactive schematic */
(() => {
  const NS = "http://www.w3.org/2000/svg";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  /* ------------------------------------------------------------------ */
  /* Data                                                                */
  /* ------------------------------------------------------------------ */
  const PARTS = {
    stm32: {
      name: "STM32G431CBU6",
      kind: "Microcontroller",
      loc: "System brain",
      chips: ["mcu", "analog"],
      bom: "1 × STM32G431CBU6 (or G4 Nucleo)",
      why: "The G4 family puts a 12-bit DAC, 12-bit ADC, rail-to-rail COMP1, and advanced timers in one chip. That is the entire analog policy engine.",
      text: "Generates the bias DAC, drives the MUX and PhotoMOS, sources the excitation square wave on PB0, digitizes V_cap on PA0, and closes the oscillator loop with COMP1 on PA1. Nothing analog happens unless this MCU says so.",
      facts: {
        Package: "UFQFPN-48",
        Analog: "DAC PA5 · ADC PA0 · COMP1 PA1",
        Drive: "PB0 → SN74LVC1G34",
        Safety: "PB10 = SSR1+SSR3, PB8 = SSR2",
      },
      note: "Keep analog and digital grounds joined at a single point under the MCU.",
    },
    bat: {
      name: "18650 Li-ion pack",
      kind: "Energy source",
      loc: "VBAT rail",
      chips: ["hv"],
      bom: "1 × 18650 (3.7–4.2 V)",
      why: "Portable high-current cell. The boost converter is happiest with a stiff 3.7 V source.",
      text: "Feeds the MT3608. All 0–20 V bias energy ultimately comes from this cell. The 3.3 V MCU rail is a separate LDO off VBAT (not shown on the analog sheets).",
      facts: { Range: "3.7 – 4.2 V", Role: "Boost input", Note: "Fuse the pack" },
    },
    mt3608: {
      name: "MT3608 boost module",
      kind: "Switching regulator",
      loc: "VBAT → +22 V_RAW",
      chips: ["hv"],
      bom: "1 × MT3608; R1 = 150 kΩ, R2 = 4.7 kΩ",
      why: "The linear pass element needs headroom above 20 V. A cheap inductor boost is the right first stage.",
      text: "Modified feedback sets VOUT = 0.6 × (1 + R1/R2) = 0.6 × (1 + 150k/4.7k) ≈ 19.75 V. Treat it as a ~20–22 V raw rail after diode drop and load. It is NOT the precision bias — the LM358/TIP122 stage is.",
      facts: {
        Formula: "VOUT = 0.6 (1 + 150k/4.7k) ≈ 19.75 V",
        "R1 / R2": "150 kΩ / 4.7 kΩ",
        Role: "Raw high-voltage rail",
      },
      note: "Confirm the module inductor is rated > 1 A peak. 5× boost at 50 mA out is ~300 mA in.",
    },
    c100u: {
      name: "100 µF electrolytic",
      kind: "Bulk filter",
      loc: "+22 V_RAW to GND",
      chips: ["hv"],
      bom: "1 × 100 µF, ≥ 25 V",
      why: "Kills MT3608 switching ripple so the linear regulator does not amplify 1.2 MHz junk onto V_BIAS.",
      text: "Sits directly on the boost output. The linear stage PSRR is modest, so this capacitor is mandatory.",
      facts: { Value: "100 µF", Rating: "≥ 25 V", Node: "+22V_RAW" },
    },
    tip122: {
      name: "TIP122 NPN Darlington",
      kind: "Pass transistor",
      loc: "Linear 0–20 V regulator",
      chips: ["hv"],
      bom: "1 × TIP122",
      why: "A Darlington gives huge current gain, so the LM358 only has to source ~1 mA of base current to deliver tens of milliamps of bias.",
      text: "Collector on +22 V_RAW, emitter through the 10 Ω sense resistor to V_BIAS. It is an emitter-follower power stage: V_E ≈ V_B − 1.2 V (two Vbe). The op-amp closes the loop so the user still gets a precise 0–20 V.",
      facts: {
        Type: "NPN Darlington",
        "Vce(sat)": "~1.4 V, watch headroom",
        Path: "C ← +22V_RAW, E → 10 Ω → V_BIAS",
      },
      note: "Darlington dropout is the reason the boost is set near 20–22 V rather than exactly 20 V.",
    },
    q2222: {
      name: "2N2222 current-limit",
      kind: "NPN clamp transistor",
      loc: "Across 10 Ω sense",
      chips: ["hv"],
      bom: "1 × 2N2222",
      why: "A shorted DUT must not melt the TIP122 or the 10 Ω resistor. Hardware current limit beats firmware.",
      text: "Classic foldback: the 2N2222 Vbe is wired across the 10 Ω emitter sense resistor. When I × 10 Ω ≈ 0.65 V, the 2N2222 steals the TIP122 base current and the source current-limits at ~65 mA.",
      facts: {
        Topology: "Vbe across 10 Ω sense",
        "I_LIM": "≈ 0.65 V / 10 Ω = 65 mA",
        Action: "Collector pulls TIP122 base down",
      },
      note: "If the ASCII wiring ever looks like the base is driven from the op-amp, ignore that — the sense-across-Vbe connection is the intended limiter.",
    },
    r10sense: {
      name: "10 Ω sense",
      kind: "Current-limit shunt",
      loc: "TIP122 emitter → V_BIAS",
      chips: ["hv"],
      bom: "1 × 10 Ω, 1/4 W (pulse-capable better)",
      why: "Sets the 65 mA hardware current limit and gives the loop a tiny amount of ballast.",
      text: "Voltage across this resistor is the current-limit input. At 65 mA it dissipates only 42 mW, so 1/4 W is fine in regulation. Pre-charge inrush is handled elsewhere (the 10 Ω on SSR1).",
      facts: { Value: "10 Ω", "I_LIM": "65 mA", Node: "V_BIAS" },
    },
    lm358: {
      name: "LM358 dual op-amp",
      kind: "Error amplifier",
      loc: "Bias control loop",
      chips: ["analog", "hv"],
      bom: "1 × LM358 (one half used)",
      why: "Turns a 0–3.3 V DAC into a stiff 0–20 V source with 6.6× closed-loop gain.",
      text: "Non-inverting DC amplifier. DAC (PA5) is divided 10 k / 100 k so VIN+ = 0.909 × DAC. Feedback is 56 k / 10 k, gain = 1 + 56/10 = 6.6. Therefore V_BIAS ≈ 6.0 × V_DAC, i.e. 0–19.8 V from a 0–3.3 V DAC. The output drives the TIP122 base through 1 kΩ.",
      facts: {
        Gain: "1 + 56k/10k = 6.6",
        "DAC scale": "VIN+ = DAC × 100k/(10k+100k) = 0.909 DAC",
        Result: "V_BIAS ≈ 6.0 × V_DAC  (0–19.8 V)",
      },
      note: "LM358 input common-mode only goes to Vcc−1.5 V. If the op-amp is powered from 3.3 V, VIN+ must stay ≤ 1.8 V (re-ratio the 10k/100k later, or run the LM358 from a higher rail / RRIO op-amp). The gain math of the finalized BOM is kept here.",
      warn: true,
    },
    r10dac: {
      name: "10 kΩ DAC series",
      kind: "Input filter",
      loc: "PA5 → LM358 IN+",
      chips: ["analog"],
      bom: "1 × 10 kΩ (of 2)",
      why: "With the 100 kΩ shunt it low-pass filters DAC steps and sets the 0.909 scale factor.",
      text: "DAC reconstruction filter. Together with stray capacitance it knocks the edge off 12-bit DAC codes so the bias supply does not chirp.",
      facts: { Value: "10 kΩ", Pair: "100 kΩ to GND", Node: "LM358 IN+" },
    },
    r100dac: {
      name: "100 kΩ DAC pull-down",
      kind: "Scale + fail-safe",
      loc: "LM358 IN+ to GND",
      chips: ["analog"],
      bom: "1 × 100 kΩ (of 2)",
      why: "If the MCU is in reset, IN+ is held at 0 V so V_BIAS collapses instead of floating up.",
      text: "Completes the 10k/100k divider and guarantees a defined zero when PA5 is Hi-Z.",
      facts: { Value: "100 kΩ", Function: "Pull-down + scale" },
    },
    r1base: {
      name: "1 kΩ base drive",
      kind: "Series base resistor",
      loc: "LM358 OUT → TIP122 base",
      chips: ["hv"],
      bom: "1 × 1 kΩ (of 2)",
      why: "Stops the op-amp from seeing the Darlington base as a short, and lets the 2N2222 steal current.",
      text: "Without this resistor the current-limit transistor cannot overpower the op-amp output.",
      facts: { Value: "1 kΩ", Role: "Base ballast" },
    },
    r56k: {
      name: "56 kΩ feedback",
      kind: "Gain setter",
      loc: "V_BIAS → LM358 IN−",
      chips: ["analog"],
      bom: "1 × 56 kΩ",
      why: "Sets the 6.6× multiplier that maps 3 V at IN+ onto ~20 V at V_BIAS.",
      text: "Upper resistor of the feedback divider. Gain = 1 + 56k/10k.",
      facts: { Value: "56 kΩ", Gain: "6.6×" },
    },
    r10fb: {
      name: "10 kΩ feedback shunt",
      kind: "Gain setter",
      loc: "LM358 IN− to GND",
      chips: ["analog"],
      bom: "1 × 10 kΩ (of 2)",
      why: "Bottom of the 6.6× divider. Also referenced in the DAC filter pair.",
      text: "IN− sits at V_BIAS × 10/(56+10) = V_BIAS / 6.6, which the loop matches to IN+.",
      facts: { Value: "10 kΩ", Ratio: "10 / 66 = 1/6.6" },
    },
    rbias: {
      name: "1 MΩ bias injector",
      kind: "DC injection",
      loc: "V_BIAS → N_DUT",
      chips: ["hv", "analog"],
      bom: "1 × 1 MΩ",
      why: "Applies DC bias to the DUT without providing a low-impedance AC path that would kill the measurement.",
      text: "Stiff for DC (sets the DUT operating point), invisible for AC (1 MΩ ≫ range resistors). During a measurement the oscillator/RC drive is AC-coupled through C_block; this resistor is the only DC path that holds the DUT at V_BIAS.",
      facts: { Value: "1 MΩ", "I at 20 V": "20 µA", Job: "DC bias, AC isolation" },
    },
    ssr1: {
      name: "SSR1 — pre-charge",
      kind: "AQY212 PhotoMOS",
      loc: "V_BIAS -- 10 Ω -- N_DUT",
      chips: ["hv"],
      bom: "1 × AQY212 / TLP241A",
      why: "The 1 MΩ would take seconds to charge a large electrolytic. Pre-charge dumps bias through 10 Ω instead.",
      text: "LED driven from PB10 via 330 Ω. Output is a MOSFET pair, so there is no Vce sat — it is an analog switch. Tied in firmware/hardware to SSR3: you never inject 20 V unless V_cap is clamped.",
      facts: {
        Part: "AQY212 PhotoMOS",
        GPIO: "PB10 (shared with SSR3)",
        Series: "10 Ω",
        "Ton typ": "2 ms (sequence SSR3 first if split)",
      },
      note: "PB10 currently fires SSR1 and SSR3 together. That is the safety interlock.",
    },
    r10pre: {
      name: "10 Ω pre-charge",
      kind: "Inrush limiter",
      loc: "SSR1 branch",
      chips: ["hv"],
      bom: "1 × 10 Ω (of 2)",
      why: "A dead-short 20 V into a discharged electrolytic would be tens of amps. 10 Ω caps peak current at 2 A.",
      text: "Pulse-loaded. Use a pulse-rated or ≥ 1 W part if you pre-charge large C often.",
      facts: { Value: "10 Ω", "Ipeak at 20 V": "2 A", Energy: "into C_DUT" },
    },
    ssr2: {
      name: "SSR2 — discharge",
      kind: "AQY212 PhotoMOS",
      loc: "N_DUT -- 100 Ω -- GND",
      chips: ["hv"],
      bom: "1 × AQY212 / TLP241A",
      why: "You must dump DUT energy before unclipping a part, or the next DUT (and the operator) eat 20 V.",
      text: "Driven from PB8 via 330 Ω. 100 Ω sets a 5τ discharge of ~0.5 s on a 1000 µF DUT (τ = 0.1 s).",
      facts: { GPIO: "PB8", Series: "100 Ω", "5τ @ 1000 µF": "0.5 s" },
    },
    r100dis: {
      name: "100 Ω discharge",
      kind: "Bleed resistor",
      loc: "SSR2 branch",
      chips: ["hv"],
      bom: "1 × 100 Ω (of 2)",
      why: "Limits discharge current while still emptying millifarad capacitors in under a second.",
      text: "Peak current 20 V / 100 Ω = 200 mA. Fine for the PhotoMOS.",
      facts: { Value: "100 Ω", "Ipeak": "200 mA" },
    },
    ssr3: {
      name: "SSR3 — V_cap clamp",
      kind: "AQY212 PhotoMOS",
      loc: "V_cap -- 1 Ω -- GND",
      chips: ["analog"],
      bom: "1 × AQY212 / TLP241A",
      why: "Pre-charging N_DUT slams displacement current through C_block. Without a clamp, V_cap would jump to 20 V and destroy PA0/PA1.",
      text: "This is the most important safety part on the analog side. PB10 turns it on with SSR1. The 1 Ω resistor eats the C_block inrush (Q = C·ΔV ≈ 1000 µF × 20 V = 20 mC) while the BAT54S only has to catch residual spikes.",
      facts: {
        GPIO: "PB10 (wired with SSR1)",
        Series: "1 Ω",
        Job: "Hold V_cap at GND during pre-charge",
      },
      note: "Never enable SSR1 unless SSR3 is already on. Shared PB10 is the hardware AND of that rule.",
    },
    r1clamp: {
      name: "1 Ω clamp resistor",
      kind: "Inrush absorber",
      loc: "SSR3 branch",
      chips: ["analog"],
      bom: "1 × 1 Ω",
      why: "Gives C_block somewhere to dump charge besides the Schottky clamps and the STM32 bond wires.",
      text: "Energy ½ C V² = ½ × 0.001 × 400 = 0.2 J. A 1 Ω pulse resistor / thick film is appropriate.",
      facts: { Value: "1 Ω", Energy: "0.2 J from 1000 µF @ 20 V" },
    },
    r330: {
      name: "330 Ω LED current limit",
      kind: "PhotoMOS input",
      loc: "PB10 / PB8 → SSR LEDs",
      chips: ["mcu"],
      bom: "3 × 330 Ω",
      why: "AQY212 LED is ~1.2 V, 5–10 mA. From 3.3 V, 330 Ω gives (3.3−1.2)/330 ≈ 6.4 mA.",
      text: "One per SSR. Keep them next to the MCU, not next to the high-voltage output pins.",
      facts: { Value: "330 Ω × 3", "I_LED": "≈ 6.4 mA" },
    },
    cdut: {
      name: "C_DUT — device under test",
      kind: "Unknown capacitor",
      loc: "N_DUT to GND",
      chips: ["hv", "analog"],
      bom: "Example cal part: 470 nF MLCC",
      why: "This is the thing being measured, optionally with DC bias applied.",
      text: "One terminal at N_DUT, the other at GND. All three SSR branches and the 1 MΩ bias resistor meet at N_DUT. AC measurement current flows through C_block into the V_cap node.",
      facts: { Example: "470 nF cal", Nodes: "N_DUT · GND" },
    },
    cblock: {
      name: "C_block 1000 µF ∥ 100 nF",
      kind: "DC block / AC couple",
      loc: "N_DUT → V_cap",
      chips: ["analog"],
      bom: "1 × 1000 µF electrolytic + 1 × 100 nF ceramic, ≥ 25 V",
      why: "The STM32 must never see the 20 V bias. C_block passes the AC measurement current and blocks the DC operating point.",
      text: "The large electrolytic lets RC-step mode look at big DUTs without the series capacitor dominating. The 100 nF ceramic sits in parallel to bypass electrolytic ESL so oscillator mode still has a short HF path. Effective series capacitance is C_eq = C_block ∥_series C_DUT = (Cb·Cd)/(Cb+Cd).",
      facts: {
        Values: "1000 µF ∥ 100 nF",
        "C_eq @ 470 nF": "≈ 470 nF (Cb ≫ Cd)",
        "C_eq @ 1000 µF": "500 µF (−50 %, firmware-correct)",
      },
      note: "During pre-charge, treat C_block as a 20 mC charge pump into V_cap — that is why SSR3 exists.",
    },
    cnf: {
      name: "100 nF HF bypass",
      kind: "Ceramic",
      loc: "Across C_block",
      chips: ["analog"],
      bom: "1 × 100 nF ceramic, ≥ 25 V",
      why: "Electrolytics look inductive above a few hundred kHz. Oscillator edges need a real capacitor.",
      text: "Parallel with the 1000 µF. Do not omit it in oscillator mode.",
      facts: { Value: "100 nF", Dielectric: "X7R/C0G preferred" },
    },
    buf: {
      name: "SN74LVC1G34 buffer",
      kind: "Push-pull driver",
      loc: "PB0 → MUX drain",
      chips: ["mcu", "analog"],
      bom: "1 × SN74LVC1G34",
      why: "STM32 GPIO is ~8–20 mA. Large-C RC steps and low-R oscillator ranges want up to ~32 mA without the MCU pin sagging or latching up.",
      text: "Non-inverting CMOS buffer, 3.3 V rail, high-current push-pull. It completely isolates PB0 from the analog matrix. Output impedance ~25 Ω — firmware calibration subtracts it from the 100 Ω range.",
      facts: {
        Function: "Non-inverting buffer",
        "Zo": "~25 Ω",
        "Idrive": "up to ~32 mA",
        From: "PB0 TIM2 / GPIO",
      },
    },
    mux: {
      name: "TMUX1104 4:1 multiplexer",
      kind: "Range switch",
      loc: "Buffer → R_range bank",
      chips: ["analog"],
      bom: "1 × TMUX1104",
      why: "Low leakage (pA) analog mux. A cheap 4051 would bleed the pF ranges.",
      text: "Routes the buffered drive to one of three range resistors, or to NC (idle). Ron ≈ 2 Ω, subtracted in calibration. CH1 = 100 kΩ (high), CH2 = 1 kΩ (mid), CH3 = 100 Ω (low), CH4 = open.",
      facts: {
        Channels: "CH1 100k · CH2 1k · CH3 100 · CH4 NC",
        Ron: "~2 Ω",
        Control: "A0, A1, EN GPIOs",
      },
    },
    r100k: {
      name: "100 kΩ high range",
      kind: "Timing resistor",
      loc: "MUX CH1 → V_cap",
      chips: ["analog"],
      bom: "1 × 100 kΩ (of 2)",
      why: "Long RC for small capacitors so the frequency stays inside the timer's comfort zone.",
      text: "Primary oscillator / high-Z RC resistor. With f ≈ 0.721/(RC) and 50 % thresholds, 100 pF → 72 kHz, 10 nF → 721 Hz, 100 nF → 72 Hz (hand off to RC-step around here).",
      facts: { Value: "100 kΩ", "Best C": "pF to ~100 nF", "f @ 470 nF": "≈ 15.3 Hz (use RC-step)" },
    },
    r1k: {
      name: "1 kΩ mid range",
      kind: "Timing resistor",
      loc: "MUX CH2 → V_cap",
      chips: ["analog"],
      bom: "1 × 1 kΩ (of 2)",
      why: "Brings large nF / small µF into a millisecond RC-step window.",
      text: "Mid auto-range. Oscillator at 1 µF → 721 Hz; RC-step τ = 1 ms/µF.",
      facts: { Value: "1 kΩ", "Best C": "100 nF – 50 µF" },
    },
    r100: {
      name: "100 Ω low range",
      kind: "Timing resistor",
      loc: "MUX CH3 → V_cap",
      chips: ["analog"],
      bom: "1 × 100 Ω (of 2)",
      why: "Needed for hundreds of µF so the step settles in tens of milliseconds, not seconds.",
      text: "Buffer Zo (~25 Ω) and mux Ron (~2 Ω) are a 27 % error on this range — calibrate with a known 100 µF. Peak drive 3.3 V/100 Ω = 33 mA, which is why the SN74LVC1G34 exists.",
      facts: { Value: "100 Ω", "Best C": "50 µF – 1000 µF", "Ipeak": "33 mA" },
      note: "Calibrate this range. Do not trust the 100 Ω silk-screen value raw.",
    },
    bat54s: {
      name: "BAT54S Schottky clamp",
      kind: "Dual diode array",
      loc: "GND ─|>─ V_cap ─|>─ 3.3 V",
      chips: ["analog", "mcu"],
      bom: "1 × BAT54S",
      why: "Last line of defense for PA0 and PA1. STM32 abs-max is 4.0 V.",
      text: "Series pair, center tap on V_cap. Negative spikes clamp at −0.3 V, positive at 3.6 V. SSR3 should prevent these diodes from ever conducting hard; they catch residual inductive kicks.",
      facts: { Package: "common-cathode/series BAT54S", Clamp: "−0.3 V to 3.6 V" },
    },
    pa0: {
      name: "PA0 — ADC1",
      kind: "RC-step input",
      loc: "V_cap",
      chips: ["mcu", "analog"],
      bom: "STM32 pin PA0",
      why: "Digitizes the exponential charging curve of large electrolytics that are too slow to oscillate cleanly.",
      text: "ADC samples V_cap continuously (DMA + timer trigger). Firmware fits V(t) = Vdrv (1 − e^(−t/τ)) and returns C = τ / R.",
      facts: { Pin: "PA0", Peripheral: "ADC1", Mode: "RC Step" },
    },
    pa1: {
      name: "PA1 — COMP1_INP",
      kind: "Oscillator sense",
      loc: "V_cap",
      chips: ["mcu", "analog"],
      bom: "STM32 pin PA1",
      why: "Hardware comparator is faster and quieter than sampling an ADC in a pF oscillator loop.",
      text: "COMP1 compares V_cap against an internal DAC/VREF threshold with hysteresis, producing the Schmitt-trigger bounce that turns the RC network into a relaxation oscillator.",
      facts: { Pin: "PA1", Peripheral: "COMP1", Mode: "Relaxation oscillator" },
    },
    vbias: {
      name: "V_BIAS rail",
      kind: "Programmable 0–20 V",
      loc: "Output of linear regulator",
      chips: ["hv"],
      bom: "Net",
      why: "The whole point of the boost + Darlington chain: a quiet, current-limited, DAC-set DC source for C-V / derating tests.",
      text: "Feeds the 1 MΩ injector and the SSR1 pre-charge branch. Never connects to the STM32 except through C_block (AC) and the analog front-end clamps.",
      facts: { Range: "0 – 19.8 V", "I_LIM": "~65 mA", Control: "DAC PA5" },
    },
    ndut: {
      name: "N_DUT node",
      kind: "High-voltage analog",
      loc: "Top of C_DUT",
      chips: ["hv"],
      bom: "Net",
      why: "Meeting point of bias, pre-charge, discharge and the DUT.",
      text: "This node can sit at 20 V. It is isolated from V_cap by C_block. Probe it with a high-voltage scope channel, not with the MCU.",
      facts: { Connections: "R_bias, SSR1, SSR2, C_DUT, C_block" },
    },
    vcap: {
      name: "V_cap node",
      kind: "MCU-side analog",
      loc: "After C_block",
      chips: ["analog", "mcu"],
      bom: "Net",
      why: "The only analog voltage the STM32 is allowed to touch.",
      text: "Held between GND and 3.3 V by BAT54S, forcibly grounded by SSR3 during pre-charge, driven through the range resistors during measure, watched by ADC and COMP1.",
      facts: { Clamps: "BAT54S + SSR3", Senses: "PA0, PA1", Drive: "MUX R bank" },
    },
  };

  const ARCH = [
    { id: "mt3608", tag: "PWR", title: "Boost", text: "18650 → MT3608 → ~20 V raw rail." },
    { id: "lm358", tag: "BIAS", title: "0–20 V linear", text: "DAC × 6.0 through LM358 + TIP122, 65 mA limit." },
    { id: "ssr1", tag: "SAFE", title: "PhotoMOS bank", text: "Pre-charge, clamp and discharge. PB10 is the interlock." },
    { id: "cblock", tag: "ISO", title: "C_block", text: "1000 µF ∥ 100 nF. DC dies here. AC passes." },
    { id: "mux", tag: "RANGE", title: "Buffered MUX", text: "SN74LVC1G34 + TMUX1104 + 100k / 1k / 100." },
    { id: "stm32", tag: "MCU", title: "STM32G431", text: "DAC, ADC, COMP1, TIM2. The closed loop." },
  ];

  const BOM = [
    ["1", "Microcontroller", "STM32G431CBU6", "Main MCU: DAC, ADC, COMP1, MUX + SSR control", "stm32"],
    ["1", "Boost module", "MT3608", "3.7 V → ~20 V raw bias rail (R1=150k, R2=4.7k)", "mt3608"],
    ["1", "Op-amp", "LM358", "Error amp for linear 0–20 V regulator, 6.6×", "lm358"],
    ["1", "Logic buffer", "SN74LVC1G34", "Push-pull driver for MUX common, shields PB0", "buf"],
    ["1", "Analog mux", "TMUX1104", "4:1 low-leakage range select", "mux"],
    ["1", "Schottky array", "BAT54S", "Clamps V_cap to GND / 3.3 V", "bat54s"],
    ["1", "NPN Darlington", "TIP122", "Pass transistor of the bias supply", "tip122"],
    ["1", "NPN transistor", "2N2222", "65 mA current-limit cutoff", "q2222"],
    ["3", "PhotoMOS SSR", "AQY212 / TLP241A", "S1 pre-charge, S2 discharge, S3 clamp", "ssr1"],
    ["1", "Electrolytic", "1000 µF / ≥25 V", "C_block, isolates MCU from bias", "cblock"],
    ["1", "Electrolytic", "100 µF / ≥25 V", "Filter on +22 V_RAW", "c100u"],
    ["1", "Ceramic", "100 nF / ≥25 V", "HF bypass across C_block", "cnf"],
    ["1", "MLCC (example DUT)", "470 nF", "Calibration test capacitor", "cdut"],
    ["1", "Resistor 1%", "1 MΩ", "High-Z DC bias injection", "rbias"],
    ["1", "Resistor 1%", "150 kΩ", "MT3608 R1", "mt3608"],
    ["2", "Resistor 1%", "100 kΩ", "DAC pull-down; MUX CH1 high range", "r100k"],
    ["1", "Resistor 1%", "56 kΩ", "LM358 feedback (6.6×)", "r56k"],
    ["2", "Resistor 1%", "10 kΩ", "DAC series; LM358 divider shunt", "r10dac"],
    ["1", "Resistor 1%", "4.7 kΩ", "MT3608 R2", "mt3608"],
    ["2", "Resistor 1%", "1 kΩ", "TIP122 base; MUX CH2 mid range", "r1k"],
    ["3", "Resistor 1%", "330 Ω", "PhotoMOS LED current limit", "r330"],
    ["2", "Resistor 1%", "100 Ω", "Discharge path; MUX CH3 low range", "r100"],
    ["2", "Resistor 1%", "10 Ω", "Bias sense; fast pre-charge", "r10sense"],
    ["1", "Resistor 1%", "1 Ω", "Active V_cap clamp (SSR3)", "r1clamp"],
  ];

  const PINS = [
    { id: "PA5", side: "left", y: 18, title: "PA5 · DAC2", text: "0–3.3 V DAC that programs V_BIAS through the 10k/100k divider and 6.6× LM358 stage. 0 V → 0 V bias, 3.3 V → ~19.8 V." },
    { id: "PA0", side: "left", y: 38, title: "PA0 · ADC1", text: "RC-step tracker. DMA-sample V_cap, fit the exponential, C = τ/R. Used for large electrolytics." },
    { id: "PA1", side: "left", y: 58, title: "PA1 · COMP1_INP", text: "Relaxation-oscillator sense. Internal COMP1 + hysteresis makes the Schmitt trigger. Small ceramics live here." },
    { id: "PA2", side: "left", y: 78, title: "PA2 · MUX A0", text: "TMUX1104 address LSB. With A1 selects CH1–CH4 (100k / 1k / 100 / NC)." },
    { id: "PB0", side: "right", y: 18, title: "PB0 · TIM / GPIO", text: "Excitation. Goes only into the SN74LVC1G34, never into the analog matrix. Toggle for oscillator, hold high for RC-step." },
    { id: "PB10", side: "right", y: 38, title: "PB10 · PRE / CLAMP", text: "Fires SSR1 and SSR3 together. Pre-charges N_DUT while forcing V_cap to GND through 1 Ω." },
    { id: "PB8", side: "right", y: 58, title: "PB8 · DISCHARGE", text: "SSR2. Connects N_DUT to GND through 100 Ω. Always the last state before handling the DUT." },
    { id: "PA3", side: "right", y: 78, title: "PA3 · MUX A1", text: "TMUX1104 address MSB. EN can be tied high or driven from another GPIO for idle (CH4 / Hi-Z)." },
  ];

  const TOUR = [
    { sheet: "sys", sel: "stm32", text: "This instrument is a capacitance meter that can also DC-bias the part. The STM32 is the only digital device — everything else is analog power, analog switches, or passives." },
    { sheet: "bias", sel: "bat", text: "Power starts at a 3.7–4.2 V 18650 cell. We need up to 20 V for derating tests, so the cell is not used directly on the DUT." },
    { sheet: "bias", sel: "mt3608", text: "The MT3608 boosts VBAT to ~19.8 V. Feedback resistors 150 kΩ and 4.7 kΩ set VOUT = 0.6 × (1 + 150/4.7). This rail is noisy — it is not the bias output." },
    { sheet: "bias", sel: "lm358", text: "DAC PA5 (0–3.3 V) is scaled and amplified ×6.6 by the LM358. Closed loop: V_BIAS ≈ 6.0 × V_DAC, smoothly from 0 to 19.8 V." },
    { sheet: "bias", sel: "tip122", text: "The TIP122 Darlington is the muscle. The op-amp only drives its base through 1 kΩ. Collector sits on the boost rail, emitter is the 0–20 V output." },
    { sheet: "bias", sel: "q2222", text: "The 2N2222 watches the 10 Ω sense resistor. At ~65 mA it turns on and starves the Darlington of base current. A shorted DUT cannot cook the supply." },
    { sheet: "front", sel: "rbias", text: "V_BIAS reaches the DUT through 1 MΩ. That resistor sets the DC operating point but is too large to disturb the AC measurement." },
    { sheet: "front", sel: "ssr1", text: "Large electrolytics would take minutes to charge through 1 MΩ. SSR1 pre-charges them through 10 Ω — but only while the MCU side is clamped." },
    { sheet: "front", sel: "ssr3", text: "SSR3 is the interlock. Same GPIO as SSR1 (PB10). It holds V_cap at GND through 1 Ω so the 1000 µF C_block inrush never hits PA0/PA1." },
    { sheet: "front", sel: "cblock", text: "C_block (1000 µF ∥ 100 nF) is the galvanic wall. DC bias stays on N_DUT. AC measurement current crosses to V_cap, which is a 0–3.3 V world." },
    { sheet: "front", sel: "buf", text: "PB0 is too delicate to charge microfarads. The SN74LVC1G34 is a push-pull sledgehammer: it drives the mux and the range resistors at up to ~32 mA." },
    { sheet: "front", sel: "mux", text: "TMUX1104 picks 100 kΩ, 1 kΩ or 100 Ω. Auto-ranging is just two address bits. CH4 is left open so the analog node can idle." },
    { sheet: "front", sel: "pa1", text: "Oscillator mode: COMP1 on PA1 trips on V_cap, firmware (or a timer) flips PB0, and the RC network sings. Frequency encodes C." },
    { sheet: "front", sel: "pa0", text: "RC-step mode: PB0 is held high, PA0 records the rising exponential. Better for huge electrolytics whose period would be seconds." },
    { sheet: "front", sel: "ssr2", text: "When the test is over, PB8 closes SSR2 and 100 Ω dumps the DUT to ground. Then it is safe to unclip the part." },
  ];

  /* ------------------------------------------------------------------ */
  /* Schematic renderer                                                  */
  /* ------------------------------------------------------------------ */
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
  function nodeClick(g, id) {
    g.addEventListener("click", (ev) => {
      ev.stopPropagation();
      selectPart(id);
    });
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
  function npn(parent, id, x, y, label, darlington = false) {
    const g = group(parent, id);
    g.appendChild(el("circle", { cx: x, cy: y, r: 22, class: "body" }));
    g.appendChild(el("path", { d: `M${x - 10} ${y - 12} v24`, class: "w" }));
    g.appendChild(el("path", { d: `M${x - 22} ${y} h12`, class: "w" }));
    g.appendChild(el("path", { d: `M${x - 10} ${y - 6} L${x + 8} ${y - 18} L${x + 8} ${y - 30}`, class: "w" }));
    g.appendChild(el("path", { d: `M${x - 10} ${y + 6} L${x + 8} ${y + 18} L${x + 8} ${y + 32}`, class: "w" }));
    g.appendChild(el("path", { d: `M${x + 2} ${y + 12} L${x + 8} ${y + 18} L${x} ${y + 18}`, class: "w" }));
    txt(g, x - 8, y - 36, label, "lbl-sm");
    if (darlington) txt(g, x + 16, y + 4, "Darl.", "pin-lbl");
    nodeClick(g, id);
  }
  function opamp(parent, id, x, y, label) {
    const g = group(parent, id);
    g.appendChild(el("path", { d: `M${x} ${y - 36} L${x + 78} ${y} L${x} ${y + 36} Z`, class: "body" }));
    txt(g, x + 10, y - 8, "+", "lbl");
    txt(g, x + 12, y + 18, "−", "lbl");
    txt(g, x + 18, y + 50, label, "lbl-sm");
    nodeClick(g, id);
  }
  function ssr(parent, id, x, y, title, gpio) {
    const g = group(parent, id);
    g.appendChild(el("rect", { x, y, width: 130, height: 72, rx: 5, class: "body" }));
    txt(g, x + 10, y + 20, title, "title");
    txt(g, x + 10, y + 38, "AQY212 PhotoMOS", "box-sub");
    txt(g, x + 10, y + 56, gpio, "lbl-sm");
    txt(g, x + 96, y + 20, "3", "pin-lbl");
    txt(g, x + 96, y + 60, "4", "pin-lbl");
    nodeClick(g, id);
  }
  /* op-amp with explicit ports: IN+ at (x, y-18), IN- at (x, y+18), OUT apex at (x+85, y) */
  function opamp2(parent, id, x, y, label) {
    const g = group(parent, id);
    g.appendChild(el("path", { d: `M${x} ${y - 40} L${x + 85} ${y} L${x} ${y + 40} Z`, class: "body" }));
    txt(g, x + 12, y - 14, "+", "lbl");
    txt(g, x + 14, y + 24, "\u2212", "lbl");
    txt(g, x + 20, y + 56, label, "lbl-sm");
    nodeClick(g, id);
    /* port stubs */
    wire(parent, `M${x - 30} ${y - 18} H${x}`, "");
    wire(parent, `M${x - 30} ${y + 18} H${x}`, "");
    wire(parent, `M${x + 85} ${y} H${x + 100}`, "");
  }
  /* 4-pin SSR body. Signal pins 3 (top-right) and 4 (bottom-right). LED pins 1/2 left. */
  function ssr4(parent, id, x, y, title, gpio) {
    const g = group(parent, id);
    g.appendChild(el("rect", { x, y, width: 150, height: 88, rx: 5, class: "body" }));
    txt(g, x + 10, y + 22, title, "title");
    txt(g, x + 10, y + 40, "AQY212 PhotoMOS", "box-sub");
    txt(g, x + 10, y + 60, gpio + " via 330 \u03a9", "lbl-sm");
    /* pin 4 = LEFT edge (input side), pin 3 = RIGHT edge (output side) */
    txt(g, x - 16, y + 74, "4", "pin-lbl");
    txt(g, x + 156, y + 24, "3", "pin-lbl");
    /* LED pins 1/2 on the bottom edge */
    txt(g, x + 18, y + 104, "1", "pin-lbl");
    txt(g, x + 46, y + 104, "2", "pin-lbl");
    nodeClick(g, id);
    /* stubs: pin4 left (y+70), pin3 right (y+18) */
    wire(parent, `M${x} ${y + 70} H${x - 20}`, "");
    wire(parent, `M${x + 150} ${y + 18} H${x + 170}`, "");
  }
  /* LED input side: pin1 from GPIO via 330, pin2 to GND. Drawn under the SSR body. */
  function ssrLed(S, id, x, y, gpio) {
    /* LED drive: GPIO --(inline 330 ohm)--> pin1 (x+18, bottom). pin2 (x+46) -> GND. */
    const p1x = x + 18, top = y + 88;
    /* inline 330 ohm vertical resistor on pin1 */
    const g = el("g", { class: "part", "data-id": "r330" });
    g.appendChild(el("path", { d: `M${p1x} ${top} v6`, class: "w" }));
    g.appendChild(el("rect", { x: p1x - 6, y: top + 6, width: 12, height: 26, class: "body" }));
    g.appendChild(el("path", { d: `M${p1x} ${top + 32} v6`, class: "w" }));
    g.addEventListener("click", (ev) => { ev.stopPropagation(); selectPart("r330"); });
    S.fg.appendChild(g);
    /* label the GPIO below the resistor */
    txt(S.fg, p1x - 10, top + 52, gpio, "pin-lbl");
    txt(S.fg, p1x + 14, top + 22, "330 Ω", "pin-lbl");
    /* pin2 to ground */
    wire(S.bg, `M${x + 46} ${top} V${top + 32}`, "gnd");
    gnd(S.fg, x + 46, top + 32);
  }
  function diode(parent, x, y, up) {
    const g = el("g");
    if (up) {
      g.appendChild(el("path", { d: `M${x} ${y + 10} L${x - 7} ${y} L${x + 7} ${y} Z`, class: "body" }));
      g.appendChild(el("path", { d: `M${x - 7} ${y} h14`, class: "w" }));
    } else {
      g.appendChild(el("path", { d: `M${x} ${y} L${x - 7} ${y + 10} L${x + 7} ${y + 10} Z`, class: "body" }));
      g.appendChild(el("path", { d: `M${x - 7} ${y + 10} h14`, class: "w" }));
    }
    parent.appendChild(g);
  }

  function svgRoot(vbW, vbH) {
    const svg = el("svg", {
      viewBox: `0 0 ${vbW} ${vbH}`,
      class: "sch",
      preserveAspectRatio: "xMidYMid meet",
    });
    const defs = el("defs");
    defs.appendChild(el("filter", { id: "glow", children: [] }));
    const f = el("filter", { id: "glow" });
    f.appendChild(el("feGaussianBlur", { stdDeviation: "2.2", result: "b" }));
    f.appendChild(el("feMerge", {}, [
      el("feMergeNode", { in: "b" }),
      el("feMergeNode", { in: "SourceGraphic" }),
    ]));
    svg.appendChild(f);
    const bg = el("g", { class: "wires" });
    const fg = el("g", { class: "parts" });
    svg.appendChild(bg);
    svg.appendChild(fg);
    svg.addEventListener("click", () => selectPart(null));
    return { svg, bg, fg, w: vbW, h: vbH };
  }

  /* ---- sheets ---- */

  /* ====================  SYSTEM VIEW  ==================== */
  function drawSys() {
    const S = svgRoot(1500, 860);
    txt(S.fg, 40, 38, "SYSTEM VIEW  ·  dual-mode biased capacitance meter", "sheet-title");
    txt(S.fg, 40, 60, "Orange = high-voltage/power (left of C_block) · blue = analog signal · amber = drive · grey = GPIO control. STM32 only ever sees the 0–3.3 V V_cap node.", "note");

    /* ================= TOP ROW : power & bias ================= */
    box(S.fg, "bat",    40, 130, 140, 78, "18650", "VBAT 3.7–4.2 V");        // 40..180
    box(S.fg, "mt3608", 240, 120, 180, 98, "MT3608 BOOST", "≈ 19.8 V raw");  // 240..420
    box(S.fg, "lm358",  480, 120, 230, 98, "LINEAR 0–20 V", "LM358+TIP122+2N2222"); // 480..710
    box(S.fg, "vbias",  770, 130, 140, 78, "V_BIAS", "65 mA lim");           // 770..910
    wire(S.bg, "M180 169 H240", "hv", "vbat");
    wire(S.bg, "M420 169 H480", "hv", "raw");
    wire(S.bg, "M710 169 H770", "hv", "vbias");

    /* ================= MIDDLE ROW : bias into DUT ================= */
    box(S.fg, "rbias",  960, 130, 150, 78, "1 MΩ R_bias", "DC-in / AC-open"); // 960..1110
    box(S.fg, "ndut",  1160, 130, 150, 78, "N_DUT", "0–20 V node");          // 1160..1310
    box(S.fg, "cdut",  1160, 250, 150, 78, "C_DUT", "unknown");              // 1160..1310
    wire(S.bg, "M910 169 H960", "hv", "vbias");
    wire(S.bg, "M1110 169 H1160", "hv", "ndut");
    wire(S.bg, "M1235 208 V250", "hv", "ndut");

    /* ================= SSR branches (left column) ================= */
    box(S.fg, "ssr1",   480, 250, 210, 84, "SSR1  PRE-CHARGE", "10 Ω · PB10");  // 480..690
    box(S.fg, "ssr2",   960, 250, 180, 84, "SSR2  DISCHARGE", "100 Ω · PB8");   // 960..1140
    /* V_BIAS tap -> SSR1 input */
    wire(S.bg, "M840 169 V292 H690", "hv", "vbias");
    /* SSR1 output -> N_DUT (up to N_DUT box bottom at y=208) */
    wire(S.bg, "M690 292 H1235 V208", "hv", "ndut");
    /* SSR2 output -> N_DUT */
    wire(S.bg, "M1140 292 H1235", "hv", "ndut");
    dot(S.fg, 1235, 292);

    /* ================= C_block fire-wall ================= */
    box(S.fg, "cblock", 1160, 380, 150, 88, "C_block", "1000µF ∥ 100nF");    // 1160..1310
    wire(S.bg, "M1235 328 V380", "analog", "ndut");

    /* ================= V_cap safe node ================= */
    box(S.fg, "vcap",  1160, 520, 170, 88, "V_cap  (safe)", "0–3.3 V");      // 1160..1330
    wire(S.bg, "M1235 468 V520", "analog", "vcap");

    /* SSR3 clamp beside V_cap */
    box(S.fg, "ssr3",   950, 520, 170, 84, "SSR3  CLAMP", "1 Ω · PB10");      // 950..1120
    wire(S.bg, "M1120 562 H1160", "analog", "vcap");

    /* BAT54S on V_cap */
    box(S.fg, "bat54s", 1370, 520, 100, 88, "BAT54S", "clamp");               // 1370..1470
    wire(S.bg, "M1330 562 H1370", "analog", "vcap");

    /* ================= BOTTOM ROW : drive chain ================= */
    box(S.fg, "buf",    40, 660, 170, 84, "SN74LVC1G34", "push-pull buffer"); // 40..210
    box(S.fg, "mux",   270, 660, 210, 84, "TMUX1104 + R", "100k/1k/100");     // 270..480
    wire(S.bg, "M210 702 H270", "drive", "drive");
    /* mux R output -> V_cap (route right, up) */
    wire(S.bg, "M480 702 H1210 V608", "drive", "drive");
    wire(S.bg, "M1210 608 V608", "analog", "vcap");

    /* ================= STM32 (center) ================= */
    box(S.fg, "stm32",  560, 470, 250, 110, "STM32G431CBU6", "DAC·ADC·COMP·TIM"); // 560..810
    /* PB0 -> buffer */
    wire(S.bg, "M560 525 H125 V660", "drive");
    wire(S.bg, "M125 660 V660", "drive");
    wire(S.bg, "M125 660 H40 V702", "drive");   // into buffer? buffer is at 40..210,y660..744; PB0 connects to buffer top
    wire(S.bg, "M560 525 H125", "drive");
    /* PA0/PA1 sense from V_cap */
    wire(S.bg, "M810 505 H1160 V545", "analog", "vcap");
    wire(S.bg, "M810 545 H1160", "analog");
    dot(S.fg, 1160, 545);
    /* DAC PA5 -> linear bias */
    wire(S.bg, "M790 470 V230 H595 V218", "analog");
    /* GPIO control: exit STM32 top in a clear channel right of SSR1 (SSR1 ends x=690) */
    /* PB10 -> SSR1 : go right to x=720, up to y=350, left into SSR1 bottom-right (x=650) */
    wire(S.bg, "M720 470 V350 H650 V334", "", "gpio");
    /* PB10 -> SSR3 : go right to x=760, up to y=430, right to SSR3 left edge (x=950) */
    wire(S.bg, "M750 470 V430 H950 V520", "", "gpio");
    /* PB8 -> SSR2 : go right to x=800, up to y=300, right into SSR2 left (x=960) */
    wire(S.bg, "M830 500 V300 H960 V334", "", "gpio");

    txt(S.fg, 40, 840, "Every box is clickable. The high-voltage path stops at C_block; the measurement path stops at the BAT54S-clamped V_cap node.", "note");
    return S.svg;
  }

  /* ====================  BIAS SUPPLY  ==================== */
  function drawBias() {
    const S = svgRoot(1500, 820);
    txt(S.fg, 40, 34, "SHEET 1  ·  PROGRAMMABLE BIAS SUPPLY  (0 – 20 V)", "sheet-title");
    txt(S.fg, 40, 56, "Loop: VIN+ = 0.909·V_DAC  →  V_BIAS = 6.6·VIN+ ≈ 6.0·V_DAC  (0–19.8 V).   Hardware current limit ≈ 65 mA.", "note");

    wire(S.bg, "M60 100 H1380", "hv", "raw");
    txt(S.fg, 1390, 104, "+22V_RAW", "rail-lbl");

    /* battery */
    const gb = group(S.fg, "bat");
    gb.appendChild(el("rect", { x: 50, y: 200, width: 80, height: 132, rx: 4, class: "body" }));
    gb.appendChild(el("path", { d: "M68 224 h44 M68 312 h44 M84 212 v12 M94 212 v12", class: "w" }));
    txt(gb, 62, 272, "18650", "lbl-sm");
    txt(gb, 56, 350, "3.7–4.2 V", "pin-lbl");
    nodeClick(gb, "bat");
    wire(S.bg, "M130 240 H180 V190", "hv", "vbat");
    wire(S.bg, "M90 332 V770", "gnd");
    gnd(S.fg, 90, 770);

    /* boost */
    box(S.fg, "mt3608", 180, 150, 210, 110, "MT3608  BOOST", "R1=150 kΩ  R2=4.7 kΩ");
    txt(S.fg, 192, 288, "0.6(1+150k/4.7k) = 19.75 V", "pin-lbl");
    wire(S.bg, "M390 200 H470 V100", "hv", "raw");
    dot(S.fg, 470, 100);

    /* bulk filter */
    capV(S.fg, "c100u", 560, 100, "100 µF", true);
    wire(S.bg, "M560 138 V770", "gnd");
    gnd(S.fg, 560, 770);
    dot(S.fg, 560, 100);

    /* ---- DAC source ---- */
    box(S.fg, "stm32", 50, 560, 180, 76, "STM32 DAC PA5", "0 – 3.3 V code");
    wire(S.bg, "M230 598 H300", "analog");
    resHV(S.fg, "r10dac", 300, 598, 150, "10 kΩ");        /* 300→450 */
    wire(S.bg, "M450 598 H700", "analog");
    dot(S.fg, 450, 598);
    resHV(S.fg, "r100dac", 700, 598, 110, "100 kΩ", true); /* 598→708 */
    wire(S.bg, "M700 708 V770", "gnd");
    gnd(S.fg, 700, 770);
    dot(S.fg, 700, 598);
    wire(S.bg, "M700 598 V412 H790", "analog");            /* node A → IN+ port */

    /* op-amp (ports: IN+ (790,412) IN- (790,448) OUT (905,430)) */
    opamp2(S.fg, "lm358", 820, 430, "LM358");
    dot(S.fg, 790, 412);
    wire(S.bg, "M790 412 H820", "analog");          /* node A -> IN+ */
    /* IN- feedback: drop a stub down to y=486 so it runs clearly BELOW the OUT line */
    wire(S.bg, "M790 448 H820", "analog");          /* IN- port stub */
    wire(S.bg, "M820 448 V486 H990", "analog");     /* IN- -> feedback node (y=486) */
    dot(S.fg, 820, 448);

    /* feedback divider: 56k up to V_BIAS, 10k down to GND */
    resHV(S.fg, "r56k", 990, 486, 130, "56 kΩ", true);    /* 486→616 */
    resHV(S.fg, "r10fb", 1060, 486, 130, "10 kΩ", true);
    wire(S.bg, "M990 486 H1060", "analog");
    wire(S.bg, "M1060 616 V770", "gnd");
    gnd(S.fg, 1060, 770);
    wire(S.bg, "M990 616 V700 H1180", "hv", "vbias");
    dot(S.fg, 990, 700);

    /* 1k OUT → base : clean single line at y=430, no IN- nearby */
    resHV(S.fg, "r1base", 920, 430, 155, "1 kΩ");          /* 920→1075 */
    wire(S.bg, "M905 430 H920", "");                       /* OUT apex -> 1k lead */

    /* TIP122 */
    npn(S.fg, "tip122", 1145, 430, "TIP122", true);
    wire(S.bg, "M1075 430 H1123", "", "base");
    wire(S.bg, "M1153 400 V100", "hv", "raw");
    dot(S.fg, 1153, 100);
    wire(S.bg, "M1153 462 V500", "hv");
    dot(S.fg, 1153, 500);
    resHV(S.fg, "r10sense", 1153, 500, 120, "10 Ω sense", true);  /* 500→620 */
    wire(S.bg, "M1153 620 V700", "hv", "vbias");
    dot(S.fg, 1153, 700);
    wire(S.bg, "M990 700 H1330", "hv", "vbias");
    box(S.fg, "vbias", 1250, 730, 160, 60, "to front-end", "1 MΩ + SSR1");
    wire(S.bg, "M1330 700 V730", "hv");

    /* 2N2222 limiter */
    npn(S.fg, "q2222", 1300, 560, "2N2222");
    wire(S.bg, "M1308 530 V508 H1368 V438 H1240 V430 H1123", "", "ilim");
    wire(S.bg, "M1278 560 H1230 V500 H1153", "hv");
    wire(S.bg, "M1308 592 V700 H1153", "hv", "vbias");
    txt(S.fg, 1360, 540, "I_LIM ≈ 0.65/10", "note");
    txt(S.fg, 1360, 555, "= 65 mA", "note");

    txt(S.fg, 50, 800, "The 2N2222 Vbe sits across the 10 Ω sense: base to the TIP122 emitter, emitter to V_BIAS. Above ~65 mA it steals base drive.", "note");
    return S.svg;
  }

  /* ====================  FRONT-END  ==================== */
  function drawFront() {
    const S = svgRoot(1600, 980);
    txt(S.fg, 40, 34, "SHEET 2  ·  MEASUREMENT & SAFETY FRONT-END", "sheet-title");
    txt(S.fg, 40, 56, "PB10 fires SSR1 AND SSR3 together  ·  C_block is the DC fire-wall  ·  V_cap is the only node the MCU touches", "note");

    /* ================= rails ================= */
    wire(S.bg, "M40 90 H1560", "hv", "vbias");
    txt(S.fg, 40, 84, "V_BIAS", "rail-lbl");
    wire(S.bg, "M40 950 H1560", "gnd");

    /* ================= N_DUT column (x=520) ================= */
    wire(S.bg, "M520 150 V500", "hv", "ndut");
    txt(S.fg, 545, 165, "N_DUT", "rail-lbl");

    /* R_bias : V_BIAS -> N_DUT (drawn beside the spine so it reads as a component) */
    resHV(S.fg, "rbias", 470, 90, 120, "1 MΩ", true);      /* body x=470, 90→210 */
    wire(S.bg, "M470 90 H520 V90", "hv");                  /* top tap to V_BIAS rail */
    dot(S.fg, 470, 90);
    wire(S.bg, "M470 210 V150 H520", "hv", "ndut");        /* bottom to N_DUT spine */
    dot(S.fg, 520, 150);
    txt(S.fg, 388, 130, "R_bias 1 MΩ", "pin-lbl");

    /* ================= SSR1 PRE-CHARGE (top-left) ================= */
    ssr4(S.fg, "ssr1", 150, 100, "SSR1 PRE-CHARGE", "PB10");  /* body 150..300 y100..188; p3 R(320,118) p4 L(130,170) LED bottom */
    resHV(S.fg, "r10pre", 60, 90, 110, "10 Ω", true);         /* body 90→200 */
    dot(S.fg, 60, 90);
    wire(S.bg, "M60 200 V170 H130", "hv");                    /* 10Ω bottom -> SSR1 pin4 (130,170) */
    wire(S.bg, "M320 118 H520", "hv", "ndut");                /* pin3 (320,118) -> N_DUT */
    dot(S.fg, 520, 118);
    ssrLed(S, "ssr1", 150, 100, "PB10");

    /* ================= SSR2 DISCHARGE (left) ================= */
    ssr4(S.fg, "ssr2", 40, 300, "SSR2 DISCHARGE", "PB8");     /* p3 R(210,318) p4 L(20,370) LED bottom */
    wire(S.bg, "M210 318 H520", "hv", "ndut");                /* pin3 -> N_DUT */
    dot(S.fg, 520, 318);
    /* pin4 -> 100Ω -> GND, short and direct (drop down, over to resistor column) */
    resHV(S.fg, "r100dis", 130, 470, 130, "100 Ω", true);     /* body x=130, 480→600 */
    wire(S.bg, "M20 370 V470 H130", "gnd");                   /* pin4 down to y480, right into 100Ω top */
    wire(S.bg, "M130 600 V950", "gnd");                       /* 100Ω bottom -> GND rail */
    gnd(S.fg, 130, 950);
    ssrLed(S, "ssr2", 40, 300, "PB8");

    /* ================= DUT ================= */
    capV(S.fg, "cdut", 520, 500, "C_DUT (470 nF)", true);     /* 500→548 */
    wire(S.bg, "M520 548 V950", "gnd");
    gnd(S.fg, 520, 950);
    dot(S.fg, 520, 500);

    /* ================= C_block : N_DUT -> V_cap ================= */
    capH(S.fg, "cblock", 560, 430, "");                       /* plates x=570/578 at y=430 */
    capH(S.fg, "cnf",    560, 350, "");                        /* plates x=570/578 at y=350 */
    txt(S.fg, 610, 356, "100 nF", "lbl-sm");
    txt(S.fg, 610, 452, "1000 µF", "lbl-sm");
    txt(S.fg, 596, 336, "C_block", "box-sub");
    /* left plates -> N_DUT */
    wire(S.bg, "M520 430 H560", "analog", "ndut");
    wire(S.bg, "M520 430 V350 H560", "analog");
    dot(S.fg, 520, 430);
    /* right plates -> V_cap bus */
    wire(S.bg, "M588 430 H620", "analog", "vcap");
    wire(S.bg, "M588 350 H620 V430", "analog");

    /* ================= V_cap bus (y=430, x=620..1180) ================= */
    wire(S.bg, "M620 430 H1180", "analog", "vcap");
    dot(S.fg, 620, 430);
    txt(S.fg, 640, 420, "V_cap", "rail-lbl");

    /* ================= BAT54S clamp (above bus) ================= */
    const gd = group(S.fg, "bat54s");
    gd.appendChild(el("rect", { x: 900, y: 250, width: 170, height: 84, rx: 5, class: "body" }));
    txt(gd, 912, 272, "BAT54S clamp", "title");
    txt(gd, 912, 290, "GND ← V_cap → 3.3 V", "box-sub");
    txt(gd, 912, 308, "protects PA0 / PA1", "lbl-sm");
    nodeClick(gd, "bat54s");
    wire(S.bg, "M985 334 V430", "analog", "vcap");            /* clamp down to bus */
    dot(S.fg, 985, 430);
    wire(S.bg, "M900 270 H840 V90", "vdd");                   /* to +3.3 */
    txt(S.fg, 800, 108, "+3.3 V", "lbl-sm");
    wire(S.bg, "M1070 292 H1120 V950", "gnd");                /* clamp to GND */
    gnd(S.fg, 1120, 950);

    /* ================= SSR3 ACTIVE CLAMP (below bus, x=700) ================= */
    ssr4(S.fg, "ssr3", 700, 500, "SSR3 CLAMP", "PB10");       /* body 700..850; p3 R(870,518) p4 L(680,570) LED bottom */
    wire(S.bg, "M870 518 H920 V430", "analog", "vcap");       /* pin3 -> V_cap bus */
    dot(S.fg, 920, 430);
    resHV(S.fg, "r1clamp", 680, 588, 120, "1 Ω", true);       /* 588→708 */
    wire(S.bg, "M680 570 V588", "gnd");                       /* pin4 (680,570) -> 1Ω top */
    wire(S.bg, "M680 708 V950", "gnd");
    gnd(S.fg, 680, 950);
    ssrLed(S, "ssr3", 700, 500, "PB10");

    /* ================= PA0 / PA1 (far right) ================= */
    box(S.fg, "pa0", 1240, 250, 190, 56, "PA0  ·  ADC1", "RC-step tracking");
    box(S.fg, "pa1", 1240, 330, 190, 56, "PA1  ·  COMP1", "oscillator sense");
    wire(S.bg, "M1180 430 V278 H1240", "analog", "vcap");     /* bus -> PA0 */
    wire(S.bg, "M1180 430 V358 H1240", "analog");             /* bus -> PA1 */
    dot(S.fg, 1180, 430);

    /* ================= drive chain (bottom) ================= */
    box(S.fg, "stm32", 40, 740, 180, 84, "STM32  PB0", "TIM2 / GPIO");
    box(S.fg, "buf",   280, 740, 190, 84, "SN74LVC1G34", "push-pull buffer");
    box(S.fg, "mux",   520, 720, 220, 128, "TMUX1104", "A0 A1 EN · Ron≈2Ω");
    wire(S.bg, "M220 782 H280", "drive", "drive");
    wire(S.bg, "M470 782 H520", "drive", "drive");

    /* range resistors: each on its own column rising to the V_cap bus */
    resHV(S.fg, "r100k", 800, 700, 170, "CH1  100 kΩ");       /* 800→970 */
    resHV(S.fg, "r1k",   800, 750, 170, "CH2  1 kΩ");
    resHV(S.fg, "r100",  800, 800, 170, "CH3  100 Ω");
    txt(S.fg, 800, 848, "CH4  NC  (idle / Hi-Z)", "lbl-sm");
    /* mux D -> resistor left ends */
    wire(S.bg, "M740 782 H800", "drive");
    wire(S.bg, "M740 782 V700 H800", "drive");
    wire(S.bg, "M740 782 V750 H800", "drive");
    wire(S.bg, "M740 782 V800 H800", "drive");
    /* resistor right ends -> distinct columns up to V_cap bus */
    wire(S.bg, "M970 700 H1000 V430", "analog", "vcap");
    wire(S.bg, "M970 750 H1060 V430", "analog");
    wire(S.bg, "M970 800 H1120 V430", "analog");
    dot(S.fg, 1000, 430);
    dot(S.fg, 1060, 430);
    dot(S.fg, 1120, 430);

    /* 330 Ω note: explain the inline LED resistors shown in ssrLed */
    txt(S.fg, 40, 962, "Each SSR LED is driven from its GPIO through an inline 330 Ω resistor (drawn on the pin-1 stub). f ≈ 0.721/(R·C) at 50 % thresholds · τ = R·C in RC-step.", "note");
    return S.svg;
  }


  /* ------------------------------------------------------------------ */
  /* View / select                                                       */
  /* ------------------------------------------------------------------ */
  const frame = $("#sch-frame");
  let svgElRef = null;

  function applyView() {
    if (!svgElRef) return;
    const vb = svgElRef.viewBox.baseVal;
    // we use transform on inner group? simpler: CSS transform on svg
    svgElRef.style.transformOrigin = "0 0";
    svgElRef.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
  }

  function drawSheet() {
    frame.querySelectorAll("svg").forEach((s) => s.remove());
    const svg = sheet === "sys" ? drawSys() : sheet === "bias" ? drawBias() : drawFront();
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
    if (id && PARTS[id]) {
      const map = { mt3608: "bias", lm358: "bias", tip122: "bias", ssr1: "front", cblock: "front", mux: "front", stm32: sheet };
      // don't auto-switch sheets on every click; user is already looking
    }
  }

  function renderInspector(id) {
    const empty = $("#insp-empty");
    const body = $("#insp-body");
    if (!id || !PARTS[id]) {
      empty.hidden = false;
      body.hidden = true;
      return;
    }
    const p = PARTS[id];
    empty.hidden = true;
    body.hidden = false;
    const chips = (p.chips || []).map((c) => `<span class="chip ${c}">${c}</span>`).join("");
    const facts = Object.entries(p.facts || {})
      .map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`)
      .join("");
    body.innerHTML = `
      <div class="kicker">Inspector</div>
      <div class="meta">${p.kind} · ${p.loc}</div>
      <h3>${p.name}</h3>
      <div class="chips">${chips}</div>
      <p>${p.text}</p>
      <table class="kv">${facts}</table>
      <p style="margin-top:10px"><strong>Why it is here.</strong> ${p.why}</p>
      <p class="meta" style="margin-top:8px">${p.bom}</p>
      ${p.note ? `<div class="callout ${p.warn ? "warn" : ""}">${p.note}</div>` : ""}
    `;
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
      <button class="btn ${sheet === "bias" ? "active" : ""}" data-sheet="bias">Bias supply</button>
      <button class="btn ${sheet === "front" ? "active" : ""}" data-sheet="front">Front-end</button>
      <div class="sep"></div>
      ${["idle", "precharge", "osc", "rc", "discharge"].map((m) =>
        `<button class="btn ${mode === m ? "active" : ""}" data-mode="${m}">${m}</button>`
      ).join("")}
      <div class="sep"></div>
      <button class="btn ghost" id="btn-tour">Guided tour</button>
      <button class="btn ghost" id="btn-reset">Reset view</button>
    `;
    $$("#toolbar [data-sheet]").forEach((b) => b.onclick = () => { sheet = b.dataset.sheet; drawSheet(); toolbar(); });
    $$("#toolbar [data-mode]").forEach((b) => b.onclick = () => {
      mode = b.dataset.mode; applyModeStyles(); toolbar();
      $("#mode-btns") && syncLabButtons();
    });
    $("#btn-tour").onclick = () => startTour(0);
    $("#btn-reset").onclick = () => { view = { x: 0, y: 0, k: 1 }; applyView(); };
  }

  function startTour(i) {
    tourIdx = i;
    const step = TOUR[i];
    $("#tourbar").classList.add("show");
    $("#tour-text").textContent = `${i + 1}/${TOUR.length}  —  ${step.text}`;
    sheet = step.sheet;
    drawSheet();
    toolbar();
    selectPart(step.sel);
  }
  $("#tour-next").onclick = () => startTour(Math.min(TOUR.length - 1, tourIdx + 1));
  $("#tour-prev").onclick = () => startTour(Math.max(0, tourIdx - 1));
  $("#tour-end").onclick = () => { $("#tourbar").classList.remove("show"); tourIdx = -1; };

  /* ------------------------------------------------------------------ */
  /* Architecture cards, modes, theory, BOM, pins, FSM                   */
  /* ------------------------------------------------------------------ */
  $("#arch-cards").innerHTML = ARCH.map((a) => `
    <div class="arch-card" data-id="${a.id}">
      <div class="tag">${a.tag}</div>
      <h3>${a.title}</h3>
      <p>${a.text}</p>
    </div>`).join("");
  $$(".arch-card").forEach((c) => c.onclick = () => {
    const jump = { mt3608: "bias", lm358: "bias", ssr1: "front", cblock: "front", mux: "front", stm32: "sys" };
    sheet = jump[c.dataset.id] || "sys";
    drawSheet(); toolbar(); selectPart(c.dataset.id);
    document.getElementById("schematic").scrollIntoView({ behavior: "smooth" });
  });

  $("#mode-cards").innerHTML = `
    <div class="panel card"><span class="br"></span><span class="bl"></span>
      <div class="kicker">Mode A · small C</div>
      <h3>Relaxation oscillator</h3>
      <p>The SN74LVC1G34 drives a square wave through the selected range resistor into V_cap. COMP1 on PA1 compares V_cap with an internal threshold (hysteresis via DAC or built-in). Each crossing flips PB0. The period is counted by a timer.</p>
      <div class="formula">f = 1 / [ 2 R C ln( (Vdrv − V_L) / (Vdrv − V_H) ) ]</div>
      <p>With symmetric 50 % thresholds this collapses to <strong>f ≈ 0.721 / (R C)</strong>. Invert: <strong>C ≈ 0.721 / (R f) − C_stray</strong>.</p>
      <p>Use 100 kΩ for pF–nF ceramics. Frequency stays roughly 70 Hz – 70 kHz, which TIM2 loves. COMP1 is the right sensor — the ADC sampling cap would eat picofarads.</p>
    </div>
    <div class="panel card"><span class="br"></span><span class="bl"></span>
      <div class="kicker">Mode B · large C</div>
      <h3>RC step tracking</h3>
      <p>PB0 is held high. V_cap rises as Vdrv (1 − e<sup>−t/RC</sup>). PA0 is sampled with ADC + DMA. Firmware finds τ from a 63 % point or a curve fit.</p>
      <div class="formula">V(t) = Vdrv (1 − e<sup>−t / RC</sup>) &nbsp;⇒&nbsp; C = −t / [ R ln(1 − V/Vdrv) ]</div>
      <p>Hand-off from oscillator when f drops below ~50 Hz (C ≳ 100 nF on the 100 kΩ range). Drop to 1 kΩ then 100 Ω as C grows. The buffer exists specifically so the 100 Ω range can pull 33 mA.</p>
    </div>`;

  $("#theory-cards").innerHTML = [
    ["Boost math", "VOUT = 0.6 (1 + R1/R2)", "R1 = 150 kΩ, R2 = 4.7 kΩ → 19.75 V. This is the raw rail, later dropped across the Darlington."],
    ["Bias gain", "V_BIAS = 6.6 × 0.909 × V_DAC", "Divider 10k/100k then non-inverting 56k/10k. Maps 0–3.3 V → 0–19.8 V."],
    ["Current limit", "I_LIM = Vbe / 10 Ω ≈ 65 mA", "2N2222 Vbe across the emitter sense resistor. Hardware, not firmware."],
    ["Series C_block", "C_eq = C_b C_d / (C_b + C_d)", "For 470 nF DUT, C_b = 1000 µF → error ~0.05 %. For 1000 µF DUT, C_eq = 500 µF — correct in firmware."],
    ["Oscillator", "C = 0.721 / (R f) − C_stray", "Assumes 50 % thresholds. Include buffer Zo + mux Ron in R. C_stray ~ few pF + ADC/COMP pin."],
    ["Displacement", "Q = C_block ΔV ≈ 20 mC", "Pre-charge of N_DUT by 20 V forces this charge through C_block. SSR3 + 1 Ω must swallow it."],
  ].map(([h, f, t]) => `<div class="panel card"><span class="br"></span><span class="bl"></span><h3>${h}</h3><div class="formula">${f}</div><p>${t}</p></div>`).join("");

  const tb = $("#bom-table");
  tb.innerHTML = `<thead><tr><th>Qty</th><th>Type</th><th>Value / PN</th><th>Circuit location</th></tr></thead><tbody>` +
    BOM.map((r) => `<tr data-id="${r[4]}"><td>${r[0]}</td><td>${r[1]}</td><td><code>${r[2]}</code></td><td>${r[3]}</td></tr>`).join("") +
    `</tbody>`;
  $$("tr", tb).forEach((tr) => {
    if (!tr.dataset.id) return;
    tr.onclick = () => {
      const id = tr.dataset.id;
      const jump = { mt3608: "bias", lm358: "bias", tip122: "bias", q2222: "bias", c100u: "bias", r10dac: "bias", r56k: "bias", stm32: "sys" };
      sheet = jump[id] || "front";
      drawSheet(); toolbar(); selectPart(id);
      document.getElementById("schematic").scrollIntoView({ behavior: "smooth" });
    };
  });

  const mcu = $("#mcu");
  mcu.innerHTML = `<div class="die"><b>STM32G431CBU6</b><div class="pin-lbl" style="margin-top:6px">UFQFPN-48 · analog core</div></div>` +
    PINS.map((p) => `<div class="pin" data-pin="${p.id}" style="${p.side}:-8px; top:${p.y}%">${p.id}</div>`).join("");
  function showPin(id) {
    const p = PINS.find((x) => x.id === id);
    $$(".pin", mcu).forEach((el) => el.classList.toggle("active", el.dataset.pin === id));
    $("#pin-info").innerHTML = `<span class="br"></span><span class="bl"></span><div class="kicker">${p.id}</div><h3>${p.title}</h3><p>${p.text}</p>`;
  }
  $$(".pin", mcu).forEach((el) => el.onclick = () => showPin(el.dataset.pin));

  $("#fsm").innerHTML = [
    "IDLE — all SSRs off, MUX CH4 (NC), PB0 low. DUT may be inserted.",
    "DISCHARGE — PB8 on for ≥ 5τ of the previous C. Confirm V_DUT ~ 0 if you have a spare ADC divider.",
    "PRE-CHARGE — PB10 on (SSR3 clamps V_cap, SSR1 charges N_DUT through 10 Ω). Wait until I_sense dies out. DAC already sits at the requested V_BIAS.",
    "ISOLATE — PB10 off. N_DUT remains at bias through 1 MΩ. V_cap is free. BAT54S still watching.",
    "RANGE — set A0/A1. Start in 100 kΩ. If oscillator < 50 Hz or RC τ too long, drop a range.",
    "MEASURE OSC — enable COMP1 + TIM capture, toggle PB0 (or let COMP steer a timer output). Average N periods, compute C.",
    "MEASURE RC — hold PB0 high, ADC DMA at a known Fs, fit τ, compute C. Discharge V_cap between repeats.",
    "DISCHARGE — PB8 on. Then IDLE. Never unclip a biased DUT.",
  ].map((t) => `<li>${t}</li>`).join("");

  $("#fw-plan").innerHTML = `
    <p><strong>DAC1 CH2 (PA5)</strong> — 12-bit, buffered, slow software updates. 0 code = 0 V bias.</p>
    <p><strong>COMP1 (PA1)</strong> — INP = PA1, INM = DAC1 CH1 or VREFBUF/2, hysteresis on. Output to TIM2 input capture / EXTI that flips PB0.</p>
    <p><strong>TIM2</strong> — period measurement in oscillator mode; timebase for ADC triggers in RC-step mode.</p>
    <p><strong>ADC1 (PA0)</strong> — 12-bit, DMA circular, 1–4 µs sample. Ignore the first sample after a mux change (charge injection).</p>
    <p><strong>GPIOs</strong> — PB10 and PB8 as push-pull with the 330 Ω LED resistors. Never PWM them; PhotoMOS need DC LED current.</p>
    <div class="callout">Ready for the next session: configure COMP1, TIM2 input capture, and the PB10/PB8 safety sequencer exactly in that order.</div>
  `;

  /* ------------------------------------------------------------------ */
  /* Lab simulator                                                       */
  /* ------------------------------------------------------------------ */
  const Rvals = { "100k": 100e3, "1k": 1e3, "100": 100 };
  const C_BLOCK = 1000e-6;
  const C_STRAY = 15e-12;
  const R_PAR = 25 + 2; // buffer + mux
  const VH = 2.2, VL = 1.1, VDRV = 3.3;

  function sliderToC(v) {
    // 0..1000 → 1 pF .. 1 mF log
    return 1e-12 * Math.pow(10, (v / 1000) * 9);
  }
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

  function ceff(cdut) {
    return (C_BLOCK * cdut) / (C_BLOCK + cdut) + C_STRAY;
  }

  function oscFreq(R, C) {
    const k = Math.log((VDRV - VL) / (VDRV - VH)); // rise
    const fll = Math.log(VH / VL); // fall to 0 V drive
    return 1 / ((R + R_PAR) * C * (k + fll));
  }

  let labMode = "osc";
  function syncLabButtons() {
    $$("#range-btns .btn").forEach((b) => b.classList.toggle("active", b.dataset.r === range));
    $$("#mode-btns .btn").forEach((b) => b.classList.toggle("active", b.dataset.m === labMode));
  }

  $("#range-btns").innerHTML = Object.keys(Rvals).map((k) =>
    `<button class="btn" data-r="${k}">${k === "100k" ? "100 kΩ" : k === "1k" ? "1 kΩ" : "100 Ω"}</button>`
  ).join("");
  $("#mode-btns").innerHTML = [
    ["osc", "Oscillator"],
    ["rc", "RC step"],
    ["precharge", "Pre-charge"],
    ["discharge", "Discharge"],
  ].map(([m, l]) => `<button class="btn" data-m="${m}">${l}</button>`).join("");
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
    $("#bias-readout").innerHTML = `<span>${vBias.toFixed(1)} V</span><small>V_BIAS · DAC PA5</small>`;

    const R = Rvals[range] + R_PAR;
    const C = ceff(cDut);
    const f = oscFreq(R, C);
    const tau = R * C;

    let result = "—", sub = "predicted observable";
    if (labMode === "osc") {
      result = fmtF(f);
      sub = `f ≈ 0.72/(RC) · C_eq ${fmtC(C)} · recommend ${f < 40 ? "RC-step" : f > 2e5 ? "higher R" : "oscillator"}`;
    } else if (labMode === "rc") {
      result = fmtT(tau);
      sub = `τ = RC · 63% of 3.3 V at ${fmtT(tau)} · 5τ = ${fmtT(5 * tau)}`;
    } else if (labMode === "precharge") {
      const tp = 10 * cDut;
      result = fmtT(tp);
      sub = `DUT 5τ through 10 Ω ≈ ${fmtT(5 * 10 * cDut)} · V_cap held at 0 by SSR3`;
    } else {
      result = fmtT(100 * cDut);
      sub = `DUT 5τ through 100 Ω ≈ ${fmtT(5 * 100 * cDut)}`;
    }
    $("#result-readout").innerHTML = `<span>${result}</span><small>${sub}</small>`;

    // waveform
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = "#070b10";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#1b2734";
    ctx.lineWidth = 1;
    for (let i = 0; i < 8; i++) {
      ctx.beginPath(); ctx.moveTo(0, (h / 8) * i); ctx.lineTo(w, (h / 8) * i); ctx.stroke();
    }
    for (let i = 0; i < 12; i++) {
      ctx.beginPath(); ctx.moveTo((w / 12) * i, 0); ctx.lineTo((w / 12) * i, h); ctx.stroke();
    }

    const yOf = (v) => h - 24 - (v / 4.0) * (h - 48);
    const T = labMode === "osc" ? (f > 0 ? 4 / f : 0.01) : labMode === "rc" ? 5 * tau : labMode === "precharge" ? 5 * 10 * cDut : 5 * 100 * cDut;
    const N = 1200;
    const dt = T / N;

    ctx.font = "12px IBM Plex Mono";
    ctx.fillStyle = "#8b9aab";
    ctx.fillText("0 V", 8, yOf(0) + 4);
    ctx.fillText("3.3 V", 8, yOf(3.3) + 4);
    if (vBias > 0.2) ctx.fillText("V_DUT", 8, yOf(Math.min(3.8, vBias * 3.3 / Math.max(vBias, 20))) );

    function stroke(color, pts) {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      pts.forEach((p, i) => {
        const x = (p.t / T) * (w - 20) + 10;
        const y = yOf(p.v);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
    }

    if (labMode === "osc") {
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "#9dffb0";
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
        cap.push({ t, v });
        drvPts.push({ t, v: drv });
      }
      stroke("#f3b23a", drvPts);
      stroke("#5ce1ff", cap);
    } else if (labMode === "rc") {
      const cap = [], drvPts = [];
      for (let i = 0; i < N; i++) {
        const t = i * dt;
        drvPts.push({ t, v: VDRV });
        cap.push({ t, v: VDRV * (1 - Math.exp(-t / (R * C))) });
      }
      stroke("#f3b23a", drvPts);
      stroke("#5ce1ff", cap);
      const t63 = tau;
      ctx.fillStyle = "#9dffb0";
      ctx.fillText("63% τ", (t63 / T) * w, yOf(0.632 * VDRV) - 6);
    } else if (labMode === "precharge") {
      const cap = [], dut = [], drvPts = [];
      const rdut = 10, rclamp = 1;
      for (let i = 0; i < N; i++) {
        const t = i * dt;
        dut.push({ t, v: Math.min(3.9, (vBias || 10) * (1 - Math.exp(-t / (rdut * cDut))) * 3.3 / Math.max(vBias || 10, 1)) });
        cap.push({ t, v: 0.02 }); // clamped
        drvPts.push({ t, v: 0 });
      }
      stroke("#ff8a6b", dut);
      stroke("#5ce1ff", cap);
      ctx.fillStyle = "#8b9aab";
      ctx.fillText("V_cap clamped ≈ 0", 80, yOf(0.3));
      ctx.fillText("N_DUT charging through 10 Ω", 80, yOf(3.2));
    } else {
      const dut = [];
      const V0 = Math.min(3.9, (vBias || 10) * 3.3 / 20);
      for (let i = 0; i < N; i++) {
        const t = i * dt;
        dut.push({ t, v: V0 * Math.exp(-t / (100 * cDut)) });
      }
      stroke("#ff8a6b", dut);
    }
  }

  $("#c-slider").addEventListener("input", drawScope);
  $("#bias-slider").addEventListener("input", drawScope);

  /* init */
  toolbar();
  drawSheet();
  syncLabButtons();
  // default DUT 470 nF
  const target = 470e-9;
  const sv = 1000 * Math.log10(target / 1e-12) / 9;
  $("#c-slider").value = String(Math.round(sv));
  drawScope();
  selectPart("stm32");
})();
