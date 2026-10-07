/* ESWCap dashboard frontend — vanilla JS + uPlot.
 * Every series is fed only by real @@EVT telemetry from the firmware; a chart
 * stays empty until its first real point arrives. */
"use strict";

// --------------------------------------------------------------- theming
// Chart colours follow the active theme; series strokes are functions of the
// theme object so a theme switch can rebuild the plots with the right palette.
const THEMES = {
  dark: {
    axis: "#8b949e", grid: "rgba(255,255,255,0.08)",
    font: '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    adc: "#60a5fa", osc: "#34d399", accent: "#4ade80", accent2: "#60a5fa",
    dim: "#8b949e", err: "#f87171",
    range: ["#f87171", "#fbbf24", "#60a5fa", "#4ade80"],
  },
  light: {
    axis: "#64748b", grid: "rgba(15,23,42,0.10)",
    font: '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    adc: "#1f3a5f", osc: "#0e8a78", accent: "#0e8a78", accent2: "#1f3a5f",
    dim: "#64748b", err: "#dc2626",
    range: ["#dc2626", "#b45309", "#2563eb", "#16a34a"],
  },
};
let THEME = THEMES.dark;
const resolveColor = (c) => (typeof c === "function" ? c(THEME) : c);

const RANGE_LABELS = ["100 Ω", "1 kΩ", "100 kΩ", "1 MΩ"];

const state = {
  ranges: [],           // from boot
  cal: [],
  curSamples: [],       // samples for the cycle currently being rendered
  lastCalres: null,
  fe: null,             // latest front-end state
  cvals: [],            // recent valid fused capacitances (for rolling average)
  adcCal: {},           // per-range ADC R_eff / C0 (from boot + adccalres)
  adcPoints: [],        // ADC calibration captures (τ vs C_ref)
  sweep: null,          // latest sweep (autoranging decision)
  fusion: null,         // latest fuse (fusion breakdown)
  stat: null,           // latest device statistic
  urls: [],             // LAN URLs advertised by the host
  dutRefF: null,        // nominal DUT capacitance (F) for the accuracy panel
  errSeries: [],        // recent signed error fractions
  lastCurve: null,      // last ADC charge curve (for theme re-render)
  lastSpread: null,     // last spread (for theme re-render)
  lastValid: false,     // last validity (for theme re-render)
  linkOn: false,        // websocket link state (gates the sample-and-hold tick)
  runKnown: false,      // has the device reported its autoranging run-state?
  running: true,        // @@EVT fe run flag (false => stopped, hold charts)
};

// Parse a capacitance string with an optional unit suffix; plain numbers are pF.
// Accepts e.g. "1000p", "10n", "1u", "4.7u", "100" (pF).
function capToPf(str) {
  const s = String(str || "").trim().toLowerCase();
  const m = s.match(/^([0-9]*\.?[0-9]+)\s*(f|m|u|µ|n|p)?/);
  if (!m) return NaN;
  let v = parseFloat(m[1]);
  if (!isFinite(v)) return NaN;
  switch (m[2]) {
    case "f": v *= 1e15; break;
    case "m": v *= 1e9; break;
    case "u": case "µ": v *= 1e6; break;
    case "n": v *= 1e3; break;
    default: break; // p or unit-less => pF
  }
  return v;
}

// Escape device-provided strings before inserting them into innerHTML.
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ------------------------------------------------- capacitance rolling average
const AVG_HISTORY_MAX = 200;
function avgWindow() {
  return parseInt(document.getElementById("avgWindow").value, 10) || 1;
}
function rollingAvg(n) {
  if (!state.cvals.length) return null;
  const slice = state.cvals.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}
function updateCapReadout(ev) {
  const w = avgWindow();
  const avg = rollingAvg(w);
  const instant = state.cvals.length ? state.cvals[state.cvals.length - 1] : null;
  const shown = (w > 1 && avg != null) ? avg : instant;
  document.getElementById("capValue").textContent = shown != null ? formatCap(shown) : "—";

  let meta = "";
  if (ev) meta = `ADC ${ev.n_adc ?? "—"} / OSC ${ev.n_osc ?? "—"} · raw ${ev.raw ?? "—"}`;
  if (w > 1 && avg != null) {
    const used = Math.min(w, state.cvals.length);
    if (meta) meta += " · ";
    meta += `avg${w} of ${used} · instant ${formatCap(instant)}`;
  } else if (shown == null) {
    meta = "waiting for telemetry…";
  }
  document.getElementById("capMeta").textContent = meta || "waiting for telemetry…";

  const recent = state.cvals.slice(-Math.max(w, 5));
  document.getElementById("capHistory").textContent = recent.length
    ? "history: " + recent.map((v) => formatCap(v)).join("  ")
    : "";
}

// ---------------------------------------------------------------- toasts
function toast(msg, cls = "", ttl = 4500) {
  const box = document.getElementById("toasts");
  const el = document.createElement("div");
  el.className = "toast " + cls;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), ttl);
}

// ---------------------------------------------------------------- formatting
function formatCap(f) {
  if (f == null || !isFinite(f)) return "—";
  if (f < 1e-9) return (f * 1e12).toFixed(2) + " pF";
  if (f < 1e-6) return (f * 1e9).toFixed(3) + " nF";
  return (f * 1e6).toFixed(3) + " µF";
}
function confFromSpread(s) {
  if (s == null || !isFinite(s)) return { label: "—", frac: 0, color: THEME.dim };
  if (s < 0.05) return { label: "HIGH", frac: 1 - s / 0.05 * 0.15, color: THEME.accent };
  if (s < 0.15) return { label: "MED", frac: 0.6, color: "#f59e0b" };
  return { label: "LOW", frac: 0.28, color: THEME.err };
}
const fmt = (v, d = 2) => (v == null || !isFinite(v) ? "—" : Number(v).toFixed(d));

// ---------------------------------------------------------------- time charts
class TimeChart {
  constructor(elId, cfg) {
    this.el = document.getElementById(elId);
    this.seriesDef = cfg.series;
    this.log = !!cfg.log;
    this.height = cfg.height || 220;
    this.yLabel = cfg.yLabel || "";
    this.last = {};
    this.started = false;
    this.xs = [];
    this.data = cfg.series.map(() => []);
    this.mount();
  }
  mount() {
    const T = THEME;
    const yscale = this.log ? { distr: 3, log: 10 } : { distr: 1 };
    const opts = {
      width: this.el.clientWidth || 400,
      height: this.height,
      scales: { x: { time: true }, y: yscale },
      series: [
        { value: (u, v) => (v == null ? "" : new Date(v * 1000).toLocaleTimeString()) },
        ...this.seriesDef.map((s) => ({
          label: s.label, stroke: resolveColor(s.stroke), width: 1.6, spanGaps: true,
          dash: s.dash, points: { show: false },
        })),
      ],
      axes: [
        { stroke: T.axis, grid: { stroke: T.grid }, ticks: { stroke: T.grid } },
        { size: 54, stroke: T.axis, grid: { stroke: T.grid }, ticks: { stroke: T.grid },
          label: this.yLabel, labelSize: 11, labelFont: T.font },
      ],
      legend: { show: true, live: true },
      cursor: { drag: { x: true, y: false } },
    };
    this.u = new uPlot(opts, [this.xs, ...this.data], this.el);
  }
  rebuild() {
    if (this.u) this.u.destroy();
    this.mount();
  }
  set(key, val) {
    // A non-finite value is a real "no reading this cycle" and must become a
    // gap, not a re-plot of the previous value (that would show stale data as
    // if it were the current measurement).
    if (val == null || !isFinite(val) || (this.log && val <= 0)) {
      this.last[key] = null;
    } else {
      this.last[key] = val;
    }
    this.started = true;
  }
  tick(x) {
    if (!this.started) return;
    this.xs.push(x);
    for (let i = 0; i < this.seriesDef.length; i++) {
      const v = this.last[this.seriesDef[i].key];
      this.data[i].push(v === undefined ? null : v);
    }
    const MAX = 1800;
    if (this.xs.length > MAX) {
      const drop = this.xs.length - MAX;
      this.xs.splice(0, drop);
      this.data.forEach((a) => a.splice(0, drop));
    }
    this.u.setData([this.xs, ...this.data]);
  }
  resize() { this.u.setSize({ width: this.el.clientWidth || 400, height: this.height }); }
}

const charts = {
  cap: new TimeChart("capChart", {
    log: true, yLabel: "pF",
    series: [
      { key: "fused", label: "fused", stroke: (T) => T.accent },
      { key: "adc", label: "ADC", stroke: (T) => T.adc },
      { key: "osc", label: "OSC", stroke: (T) => T.osc },
      { key: "avg", label: "rolling avg", stroke: (T) => T.dim, dash: [5, 4] },
    ],
  }),
  spread: new TimeChart("spreadChart", {
    yLabel: "%",
    series: [{ key: "spread", label: "spread %", stroke: (T) => T.range[3] }],
  }),
  freq: new TimeChart("freqChart", {
    log: true, yLabel: "Hz",
    series: RANGE_LABELS.map((l, i) => ({ key: "r" + i, label: l, stroke: (T) => T.range[i] })),
  }),
  tau: new TimeChart("tauChart", {
    log: true, yLabel: "µs",
    series: RANGE_LABELS.map((l, i) => ({ key: "r" + i, label: l, stroke: (T) => T.range[i] })),
  }),
  tare: new TimeChart("tareChart", {
    yLabel: "µs",
    series: RANGE_LABELS.map((l, i) => ({ key: "r" + i, label: l, stroke: (T) => T.range[i] })),
  }),
  err: new TimeChart("errChart", {
    height: 180, yLabel: "%",
    series: [{ key: "err", label: "error %", stroke: (T) => T.accent2 }],
  }),
};

// ---------------------------------------------------------------- curve chart
let curveU = null;
function mountCurve() {
  const T = THEME;
  curveU = new uPlot(
    {
      width: document.getElementById("curveChart").clientWidth || 400,
      height: 220,
      scales: { x: { time: false }, y: {} },
      series: [
        { value: (u, v) => (v == null ? "" : v.toFixed(1) + " µs") },
        { label: "V_cap (mV)", stroke: T.range[2], width: 1.8 },
        { label: "fitted exp", stroke: T.range[0], width: 1.6, dash: [5, 4] },
      ],
      axes: [
        { stroke: T.axis, grid: { stroke: T.grid }, ticks: { stroke: T.grid }, label: "t (µs)", labelSize: 11, labelFont: T.font },
        { stroke: T.axis, grid: { stroke: T.grid }, ticks: { stroke: T.grid }, label: "mV", labelSize: 11, labelFont: T.font },
      ],
      legend: { show: true, live: true },
    },
    [[], [], []],
    document.getElementById("curveChart")
  );
}
mountCurve();

function onCurve(ev) {
  const pts = ev.pts || [];
  if (!pts.length) return;
  state.lastCurve = ev;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  let fit = [];
  if (ev.tau_us > 0 && ev.vinf > 0) {
    fit = xs.map((t) => ev.vinf * (1 - Math.exp(-t / ev.tau_us)));
  } else {
    fit = xs.map(() => null);
  }
  curveU.setData([xs, ys, fit]);
  const meta = document.getElementById("curveMeta");
  meta.textContent = `range ${RANGE_LABELS[ev.range] || ev.range} · ` +
    `V∞ ${ev.vinf} mV · τ ${fmt(ev.tau_us, 1)} µs · R² ${fmt(ev.r2, 4)}` +
    (ev.tau_us > 0 ? "" : " · 2-point fallback (no fit)");
}

// ------------------------------------------------------- calibration scatter
const calPoints = [];   // {x: Cref pF, y: period us, range}
function onCalpt(ev) {
  if (!(ev.freq > 0)) return;
  calPoints.push({ x: ev.ref_pf, y: ev.period_us, range: ev.range, op: ev.op });
  renderCal();
}
function onCalres(ev) {
  state.lastCalres = ev;
  renderCal();
}
function renderCal() {
  const el = document.getElementById("calChart");
  const W = el.clientWidth || 400, H = 220, pad = 40, padR = 14, padT = 14, padB = 30;
  if (!calPoints.length) { el.innerHTML = ""; return; }
  const T = THEME;
  const xs = calPoints.map((p) => p.x), ys = calPoints.map((p) => p.y);
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const ymin = Math.min(...ys), ymax = Math.max(...ys);
  const sx = (x) => pad + (xmax === xmin ? 0.5 : (x - xmin) / (xmax - xmin)) * (W - pad - padR);
  const sy = (y) => (H - padB) - (ymax === ymin ? 0.5 : (y - ymin) / (ymax - ymin)) * (H - padB - padT);
  let svg = `<svg width="${W}" height="${H}">`;
  // grid + axes
  for (let i = 0; i <= 4; i++) {
    const gy = padT + (i / 4) * (H - padB - padT);
    const gx = pad + (i / 4) * (W - pad - padR);
    svg += `<line x1="${pad}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="${T.grid}"/>`;
    svg += `<line x1="${gx}" y1="${padT}" x2="${gx}" y2="${H - padB}" stroke="${T.grid}"/>`;
  }
  svg += `<line x1="${pad}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="${T.axis}"/>`;
  svg += `<line x1="${pad}" y1="${padT}" x2="${pad}" y2="${H - padB}" stroke="${T.axis}"/>`;
  svg += `<text x="${pad - 4}" y="${padT + 6}" fill="${T.dim}" font-size="10" text-anchor="end">${ymax.toFixed(0)}</text>`;
  svg += `<text x="${pad - 4}" y="${H - padB}" fill="${T.dim}" font-size="10" text-anchor="end">${ymin.toFixed(0)}</text>`;
  svg += `<text x="${pad}" y="${H - 8}" fill="${T.dim}" font-size="10">${xmin.toFixed(0)}</text>`;
  svg += `<text x="${W - padR}" y="${H - 8}" fill="${T.dim}" font-size="10" text-anchor="end">${xmax.toFixed(0)}</text>`;
  svg += `<text x="${pad}" y="11" fill="${T.dim}" font-size="10">T (µs)</text>`;
  svg += `<text x="${W - padR}" y="11" fill="${T.dim}" font-size="10" text-anchor="end">C_ref (pF)</text>`;
  // fitted model line T = K·R·C + T0 (C in pF -> F, T in us)
  const cr = state.lastCalres, rng = state.ranges[cr ? cr.range : calPoints[calPoints.length - 1].range];
  if (cr && cr.ok && cr.k > 0 && rng) {
    const Tf = (cpf) => cr.k * rng.r * (cpf * 1e-12) * 1e6 + cr.t0_us;
    svg += `<line x1="${sx(xmin)}" y1="${sy(Tf(xmin))}" x2="${sx(xmax)}" y2="${sy(Tf(xmax))}" stroke="${T.err}" stroke-dasharray="5 4" stroke-width="1.5"/>`;
  }
  for (const p of calPoints) {
    svg += `<circle cx="${sx(p.x)}" cy="${sy(p.y)}" r="4" fill="${THEME.range[p.range] || '#fff'}"/>`;
  }
  svg += `</svg>`;
  el.innerHTML = svg;
  const meta = document.getElementById("calMeta");
  if (cr) {
    meta.textContent = `${cr.op === 'two' ? 'two-point' : 'one-point'} · ` +
      `K ${fmt(cr.k, 5)} · T0 ${fmt(cr.t0_us, 2)} µs · ${cr.ok ? 'ok' : 'FAILED'}`;
  } else {
    meta.textContent = `${calPoints.length} captured point(s)`;
  }
}

// ============================================================ fusion panel
function phaseStep(p) {
  if (p === "probe" || p === "hunt") return "pipeProbe";
  if (p === "adc" || p === "adc-sub" || p === "osc" || p === "osc-x") return "pipeSweep";
  if (p === "fuse") return "pipeFuse";
  if (p === "lock-osc" || p === "lock-adc") return "pipeSweep";
  return null;
}
function setPipeline(stepId) {
  const order = ["pipeProbe", "pipeSweep", "pipeFuse"];
  const idx = order.indexOf(stepId);
  order.forEach((id, i) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle("active", idx >= 0 && i === idx);
    el.classList.toggle("done", idx >= 0 && i < idx);
  });
}

// Range-decision matrix: which ranges were swept and what each method returned.
function renderMatrix() {
  const tb = document.querySelector("#rangeMatrix tbody");
  if (!tb) return;
  const sw = state.sweep, fu = state.fusion;
  const contrib = (fu && fu.contrib) || [];
  const byRM = (method, r) => contrib.find((c) => c.m === method && c.r === r);
  const cell = (c, method) => {
    if (!c) return `<td class="cell dim">—</td>`;
    const badge = c.kept ? `<span class="badge kept">kept</span>`
                         : `<span class="badge gated">gated</span>`;
    const w = Math.max(0, Math.min(1, c.w || 0));
    const bar = `<span class="qbar" style="width:${(6 + w * 34).toFixed(0)}px"></span>`;
    return `<td class="cell" title="q ${fmt(c.q, 3)} · w ${fmt(c.w, 3)}">${formatCap(c.c)} ${bar} ${badge}${method === "adc" ? `<div class="dim">R² ${fmt(c.r2, 3)}</div>` : ""}</td>`;
  };
  let rows = "";
  for (let r = 0; r < 4; r++) {
    const adcTried = sw ? !!sw.adc_tried[r] : false;
    const isBest = sw && sw.osc_best === r;
    const adcC = byRM("adc", r);
    const oscC = byRM("osc", r);
    const adcCell = adcC ? cell(adcC, "adc")
                         : (adcTried ? `<td class="cell dim">tried · no sample</td>` : `<td class="cell dim">skip${sw && sw.sub_nf ? " (sub-nF)" : ""}</td>`);
    const oscCell = oscC ? cell(oscC, "osc")
                         : (isBest ? `<td class="cell dim">tried · no sample</td>` : `<td class="cell dim">—</td>`);
    rows += `<tr class="${isBest ? "best" : ""}"><td>${esc(RANGE_LABELS[r])}${isBest ? " ★" : ""}</td>${adcCell}${oscCell}</tr>`;
  }
  tb.innerHTML = rows;

  const sm = document.getElementById("sweepMeta");
  if (!sw) { sm.textContent = "no sweep yet"; return; }
  const bits = [];
  bits.push(sw.mode === "locked" ? `locked ${RANGE_LABELS[sw.lock] || sw.lock}` : "autorange");
  if (sw.have_rough) bits.push(`probe ${formatCap(sw.rough)}`);
  else bits.push("no probe estimate");
  if (sw.sub_nf) bits.push("sub-nF → oscillator only");
  if (sw.saturated) bits.push("100 Ω saturated → 100 kΩ sub");
  sm.textContent = bits.join(" · ");
}

function renderFusionStrip() {
  const el = document.getElementById("fusionStrip");
  const legend = document.getElementById("fusionLegend");
  if (!el) return;
  const fu = state.fusion;
  const contrib = (fu && fu.contrib) || [];
  if (!contrib.length) {
    el.innerHTML = `<div class="dim" style="padding:18px 0">no fusion data yet — start a measurement.</div>`;
    if (legend) legend.textContent = "no samples yet";
    return;
  }
  const T = THEME;
  const W = el.clientWidth || 620, H = 128;
  const padL = 52, padR = 16, padT = 16, laneADC = 40, laneOSC = 92;
  const vals = contrib.map((c) => c.c).filter((v) => v > 0);
  const med = fu.median > 0 ? fu.median : (vals.length ? vals[0] : 1e-12);
  vals.push(med);
  if (fu.c > 0) vals.push(fu.c);
  let xmin = Math.min(...vals), xmax = Math.max(...vals);
  if (!(xmin > 0)) xmin = 1e-15;
  if (xmax <= xmin) { xmin *= 0.5; xmax *= 2; }
  const xminL = Math.log10(xmin), xmaxL = Math.log10(xmax);
  const sx = (v) => {
    const l = Math.log10(Math.max(v, 1e-18));
    return padL + (xmaxL === xminL ? 0.5 : (l - xminL) / (xmaxL - xminL)) * (W - padL - padR);
  };
  let svg = `<svg width="${W}" height="${H}">`;
  // ticks (log)
  const nticks = 5;
  for (let i = 0; i <= nticks; i++) {
    const l = xminL + (i / nticks) * (xmaxL - xminL);
    const x = sx(Math.pow(10, l));
    svg += `<line x1="${x}" y1="${padT}" x2="${x}" y2="${H - 12}" stroke="${T.grid}"/>`;
    svg += `<text x="${x}" y="${H - 1}" fill="${T.dim}" font-size="9" text-anchor="middle">${formatCap(Math.pow(10, l))}</text>`;
  }
  // median gate band
  const lo = med * (1 - (fu.gate_rel || 0.875)), hi = med * (1 + (fu.gate_rel || 0.875));
  svg += `<rect x="${sx(lo)}" y="${padT}" width="${Math.max(1, sx(hi) - sx(lo))}" height="${H - 12 - padT}" fill="${T.grid}"/>`;
  // lanes
  svg += `<line x1="${padL}" y1="${laneADC}" x2="${W - padR}" y2="${laneADC}" stroke="${T.grid}"/>`;
  svg += `<line x1="${padL}" y1="${laneOSC}" x2="${W - padR}" y2="${laneOSC}" stroke="${T.grid}"/>`;
  svg += `<text x="${padL - 6}" y="${laneADC + 4}" fill="${T.adc}" font-size="10" text-anchor="end">ADC</text>`;
  svg += `<text x="${padL - 6}" y="${laneOSC + 4}" fill="${T.osc}" font-size="10" text-anchor="end">OSC</text>`;
  // median + fused markers
  svg += `<line x1="${sx(med)}" y1="${padT}" x2="${sx(med)}" y2="${H - 12}" stroke="${T.dim}" stroke-dasharray="4 3"/>`;
  svg += `<line x1="${sx(fu.c)}" y1="${padT - 6}" x2="${sx(fu.c)}" y2="${H - 12}" stroke="${T.accent}" stroke-width="2.5"/>`;
  svg += `<text x="${sx(fu.c)}" y="${padT - 8}" fill="${T.accent}" font-size="10" text-anchor="middle">fused ${formatCap(fu.c)}</text>`;
  // contributions
  for (const c of contrib) {
    const x = sx(c.c);
    const y = c.m === "adc" ? laneADC : laneOSC;
    const color = c.m === "adc" ? T.adc : T.osc;
    const r = 4 + 8 * Math.max(0, Math.min(1, c.w || 0));
    if (c.kept) {
      svg += `<circle cx="${x}" cy="${y}" r="${r.toFixed(1)}" fill="${color}" fill-opacity="0.85" stroke="${color}"/>`;
      svg += `<text x="${x}" y="${y + r + 11}" fill="${T.dim}" font-size="9" text-anchor="middle">${formatCap(c.c)}</text>`;
    } else {
      svg += `<circle cx="${x}" cy="${y}" r="${r.toFixed(1)}" fill="none" stroke="${T.err}" stroke-dasharray="3 2"/>`;
      svg += `<line x1="${x - r}" y1="${y + r}" x2="${x + r}" y2="${y - r}" stroke="${T.err}"/>`;
    }
  }
  svg += `</svg>`;
  el.innerHTML = svg;

  if (legend) {
    const kept = contrib.filter((c) => c.kept).length;
    legend.innerHTML = `<span class="legend-dot" style="background:${T.adc}"></span>ADC ` +
      `<span class="legend-dot" style="background:${T.osc};margin-left:10px"></span>OSC ` +
      `<span style="margin-left:10px">·</span> ${kept}/${contrib.length} kept · ` +
      `median ${formatCap(fu.median)} · gate ±${((fu.gate_rel || 0.875) * 100).toFixed(1)}% · ` +
      `gated ${fu.n_gated ?? 0}`;
  }
}

function updateFusionMeta() {
  const el = document.getElementById("fusionMeta");
  const fu = state.fusion;
  if (!el) return;
  if (!fu) { el.textContent = "waiting for a cycle…"; return; }
  el.textContent = `fused ${formatCap(fu.c)} · kept ${fu.n_kept ?? 0} (gated ${fu.n_gated ?? 0}) · ` +
    `spread ${(fu.spread * 100).toFixed(1)}% · Σw ${fmt(fu.w_total, 2)}`;
}

// ---------------------------------------------------------------- UI updates
function clearChart(c) {
  c.xs = [];
  c.data = c.seriesDef.map(() => []);
  c.last = {};
  c.started = false;
  c.u.setData([[], ...c.seriesDef.map(() => [])]);
}
function resetCharts() {
  for (const c of Object.values(charts)) clearChart(c);
  curveU.setData([[], [], []]);
}
function resetClientState() {
  state.cvals = [];
  state.curSamples = [];
  state.lastCalres = null;
  state.sweep = null;
  state.fusion = null;
  state.errSeries = [];
  calPoints.length = 0;
  state.adcPoints = [];
  resetCharts();
  renderCal();
  renderAdcCal();
  renderSampleTable();
  renderMatrix();
  renderFusionStrip();
  updateFusionMeta();
  updateAccuracy(null);
  updateCapReadout(null);
}
function onBoot(ev) {
  // Device (re)boot: start clean so stale history from a prior session stays out.
  resetClientState();
  state.ranges = ev.ranges || [];
  state.cal = state.ranges;
  state.adcCal = {};
  for (const r of state.ranges) {
    if (r.adc_valid) state.adcCal[r.i] = { r_eff: r.adc_r_eff, c0_f: r.adc_c0_f, r_nom: r.r };
  }
  renderCalTable();
  renderAdcCalTable();
  const pills = document.getElementById("rangePills");
  pills.innerHTML = state.ranges.map((r) =>
    `<span class="rangepill" id="rp${r.i}">${esc(r.label)}</span>`).join("");
}

// ------------------------------------------------- ADC calibration display
function renderAdcCalTable() {
  const el = document.getElementById("adcCalTable");
  if (!el) return;
  if (!state.ranges.length) { el.textContent = "waiting for device boot…"; return; }
  const lines = state.ranges.map((r) => {
    const c = state.adcCal[r.i];
    if (!c) return `${String(r.label).padEnd(8)} R_eff=${r.r} Ω (nominal)   default`;
    const series = (c.r_eff - (c.r_nom || r.r));
    const sign = series >= 0 ? "+" : "-";
    return `${String(r.label).padEnd(8)} R_eff=${c.r_eff.toFixed(2)} Ω (nom ${(c.r_nom || r.r)}, ${sign}${Math.abs(series).toFixed(2)} series)  C0=${(c.c0_f * 1e12).toFixed(1)} pF`;
  });
  el.textContent = lines.join("\n");
}
function onAdccalpt(ev) {
  state.adcPoints.push({ x: ev.ref_pf, y: ev.tau_us, range: ev.range, op: ev.op });
  renderAdcCal();
}
function onAdccalres(ev) {
  if (ev.ok) {
    state.adcCal[ev.range] = { r_eff: ev.r_eff, c0_f: ev.c0_f, r_nom: ev.r_nom };
    renderAdcCalTable();
    toast(`✓ ADC cal range ${RANGE_LABELS[ev.range] || ev.range}: R_eff ${ev.r_eff.toFixed(1)} Ω` +
      (ev.r_nom ? ` (+${(ev.r_eff - ev.r_nom).toFixed(1)} series)` : ""), "ok");
  } else {
    toast("✗ ADC calibration failed", "warn");
  }
  renderAdcCal();
}
function renderAdcCal() {
  const el = document.getElementById("adcCalChart");
  if (!el) return;
  const pts = state.adcPoints;
  if (!pts.length) { el.innerHTML = ""; return; }
  const T = THEME;
  const W = el.clientWidth || 360, H = 180, pad = 44, padR = 12, padT = 14, padB = 26;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const ymin = Math.min(...ys), ymax = Math.max(...ys);
  const sx = (x) => pad + (xmax === xmin ? 0.5 : (x - xmin) / (xmax - xmin)) * (W - pad - padR);
  const sy = (y) => (H - padB) - (ymax === ymin ? 0.5 : (y - ymin) / (ymax - ymin)) * (H - padB - padT);
  let svg = `<svg width="${W}" height="${H}">`;
  svg += `<line x1="${pad}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="${T.axis}"/>`;
  svg += `<line x1="${pad}" y1="${padT}" x2="${pad}" y2="${H - padB}" stroke="${T.axis}"/>`;
  svg += `<text x="${pad}" y="11" fill="${T.dim}" font-size="10">τ (µs)</text>`;
  svg += `<text x="${W - padR}" y="11" fill="${T.dim}" font-size="10" text-anchor="end">C_ref (pF)</text>`;
  for (const p of pts) {
    svg += `<circle cx="${sx(p.x)}" cy="${sy(p.y)}" r="4" fill="${T.range[p.range] || "#fff"}"/>`;
  }
  svg += `</svg>`;
  el.innerHTML = svg;
}
function renderCalTable() {
  const t = state.ranges.map((r) =>
    `${String(r.label || "").padEnd(8)} K=${fmt(r.k, 5)}  T0=${fmt(r.t0_us, 2)} µs ${r.has_t0 ? '(tared)' : '(no tare)'}  ${r.valid ? 'calibrated' : 'default'}`).join("\n");
  document.getElementById("calTable").textContent = t || "no calibration data yet";
}
function renderSampleTable() {
  const tb = document.querySelector("#sampleTable tbody");
  tb.innerHTML = state.curSamples.map((s) => {
    const t = fmt(s.tau_us, 1) + " µs";
    const second = s.method === "adc" ? "R² " + fmt(s.r2, 3) : fmt(s.freq, 1) + " Hz";
    const cls = s.plausible ? "ok" : (s.valid ? "bad" : "no");
    return `<tr><td>${esc(s.label || RANGE_LABELS[s.range])}</td><td>${esc(s.method)}</td><td class="${cls}">${s.plausible ? 'ok' : (s.valid ? 'reject' : 'fail')}</td>` +
      `<td>${formatCap(s.c)}</td><td>${fmt(s.q, 3)}</td><td>${t}</td><td>${second}</td></tr>`;
  }).join("") || `<tr><td colspan="7" class="dim">waiting for a cycle…</td></tr>`;
}

function updateConfidence(spread, valid) {
  state.lastSpread = spread;
  state.lastValid = valid;
  const g = confFromSpread(valid ? spread : null);
  const arc = document.getElementById("gaugeArc");
  const circ = 2 * Math.PI * 52;
  arc.style.strokeDashoffset = String(circ * (1 - g.frac));
  arc.style.stroke = g.color;
  document.getElementById("conf").textContent = g.label;
  document.getElementById("confSub").textContent =
    (spread != null && isFinite(spread)) ? `${(spread * 100).toFixed(1)}% spread` : "no reading";
}

function onCycle(ev) {
  if (ev.valid && ev.c > 0) {
    state.cvals.push(ev.c);
    if (state.cvals.length > AVG_HISTORY_MAX) state.cvals.shift();
  }
  updateCapReadout(ev);
  updateConfidence(ev.spread, ev.valid);
  document.getElementById("spread").textContent =
    (ev.spread != null && isFinite(ev.spread)) ? (ev.spread * 100).toFixed(1) + " %" : "—";
  document.getElementById("adcEst").textContent = formatCap(ev.adc);
  document.getElementById("oscEst").textContent = formatCap(ev.osc);
  document.getElementById("nsamp").textContent = `${ev.n_adc ?? "—"} / ${ev.n_osc ?? "—"}`;
  updateActiveRange();
  document.getElementById("mismatch").classList.toggle("hidden", !ev.mismatch);
  charts.cap.set("fused", ev.valid ? ev.c * 1e12 : null);
  charts.cap.set("adc", ev.adc != null ? ev.adc * 1e12 : null);
  charts.cap.set("osc", ev.osc != null ? ev.osc * 1e12 : null);
  const avg = rollingAvg(avgWindow());
  charts.cap.set("avg", avg != null ? avg * 1e12 : null);
  charts.spread.set("spread", ev.spread * 100);
  renderSampleTable();
  updateAccuracy(ev);
  state.curSamples = [];
}
function updateActiveRange() {
  // Prefer the oscillator-nominated range, else the highest-quality sample range.
  let r = state.sweep && state.sweep.osc_best >= 0 ? state.sweep.osc_best : null;
  if (r == null && state.fusion && state.fusion.contrib) {
    const kept = state.fusion.contrib.filter((c) => c.kept);
    if (kept.length) r = kept[kept.length - 1].r;
  }
  document.getElementById("activeRange").textContent =
    r != null ? (RANGE_LABELS[r] || r) : "—";
}
function onSample(ev) {
  state.curSamples.push(ev);
  const step = phaseStep(ev.phase);
  if (step) setPipeline(step);
  if (ev.plausible) {
    if (ev.method === "osc" && ev.freq > 0) charts.freq.set("r" + ev.range, ev.freq);
    if (ev.method === "adc" && ev.tau_us > 0) charts.tau.set("r" + ev.range, ev.tau_us);
  }
}
function onTare(ev) {
  if (ev.done) {
    const r = state.ranges[ev.range];
    if (r) { r.t0_us = ev.t0_us; r.has_t0 = true; renderCalTable(); }
    return;
  }
  charts.tare.set("r" + ev.range, ev.period_us);
}

// ---------------------------------------------------------------- sweep/fuse
function onSweep(ev) {
  state.sweep = ev;
  state.fusion = null;   // a new cycle is starting; drop last cycle's breakdown
  setPipeline(ev.have_rough ? "pipeSweep" : "pipeProbe");
  renderMatrix();
  updateFusionMeta();
}
function onFuse(ev) {
  state.fusion = ev;
  setPipeline("pipeFuse");
  renderMatrix();
  renderFusionStrip();
  updateFusionMeta();
  updateActiveRange();
}
function onStat(ev) {
  state.stat = ev;
  document.getElementById("stUptime").textContent = fmtDuration(ev.uptime_ms);
  document.getElementById("stCycles").textContent = ev.cycles ?? "—";
  document.getElementById("stCycleMs").textContent =
    ev.cycle_ms != null ? ev.cycle_ms + " ms" : "—";
  document.getElementById("stHeap").textContent =
    ev.heap_free != null ? (ev.heap_free / 1024).toFixed(1) + " KB" : "—";
}
function fmtDuration(ms) {
  if (ms == null || !isFinite(ms)) return "—";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + "h " : "") + (h || m ? m + "m " : "") + sec + "s";
}

// ------------------------------------------------------------- accuracy panel
function dutRefF() { return state.dutRefF; }
function updateAccuracy(ev) {
  const nom = dutRefF();
  const pill = document.getElementById("dutRefPill");
  if (nom == null || !(nom > 0)) {
    if (pill) pill.classList.add("hidden");
    document.getElementById("accMeas").textContent = "—";
    document.getElementById("accErr").textContent = "—";
    document.getElementById("accPpm").textContent = "—";
    document.getElementById("accStdev").textContent = "—";
    document.getElementById("accN").textContent = state.errSeries.length || "—";
    return;
  }
  if (pill) {
    pill.classList.remove("hidden");
    pill.textContent = formatCap(nom) + " nominal";
  }
  let measured = null;
  if (ev && ev.valid && ev.c > 0) measured = ev.c;
  else if (state.cvals.length) measured = rollingAvg(avgWindow()) || state.cvals[state.cvals.length - 1];
  if (measured != null) {
    const err = (measured - nom) / nom;
    state.errSeries.push(err);
    if (state.errSeries.length > AVG_HISTORY_MAX) state.errSeries.shift();
    document.getElementById("accMeas").textContent = formatCap(measured);
    document.getElementById("accErr").textContent = (err * 100).toFixed(3) + " %";
    document.getElementById("accPpm").textContent = Math.round(err * 1e6).toLocaleString();
    charts.err.set("err", err * 100);
  }
  if (state.errSeries.length > 1) {
    const n = state.errSeries.length;
    const mean = state.errSeries.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(state.errSeries.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
    document.getElementById("accStdev").textContent = (sd * 100).toFixed(3) + " %";
  }
  document.getElementById("accN").textContent = state.errSeries.length;
}

// ------------------------------------------------- front-end / safety state
function updateFe(ev) {
  state.fe = ev;
  const badge = document.getElementById("feState");
  const names = {
    idle: "IDLE", precharge: "PRE-CHARGING", precharged: "CHARGED / BIASED",
    measuring: "MEASURING", discharge: "DISCHARGING",
  };
  badge.textContent = names[ev.state] || String(ev.state).toUpperCase();
  badge.className = "fe-badge " + ev.state;

  const detail = document.getElementById("feDetail");
  let d;
  if (ev.state === "precharged") d = "N_DUT held at V_BIAS through R_bias — do NOT remove the DUT";
  else if (ev.state === "precharge") d = "SSR1+SSR3 on: charging DUT/C_block, clamping V_cap";
  else if (ev.state === "measuring") d = "autoranging through C_block";
  else if (ev.state === "discharge") d = "SSR2 on: bleeding DUT/C_block to GND";
  else d = ev.charged
    ? "isolated, but N_DUT may still be biased via R_bias"
    : (ev.discharged ? "discharged — safe to remove the DUT" : "all SSRs off · safe to touch the DUT");
  detail.textContent = d;

  document.getElementById("bitSSR13").classList.toggle("on", !!ev.ssr13);
  document.getElementById("bitSSR2").classList.toggle("on", !!ev.ssr2);
  document.getElementById("bitDrive").classList.toggle("on", !!ev.drive);

  const warn = document.getElementById("feWarn");
  if (ev.state === "precharged" || (ev.state === "idle" && ev.charged)) {
    warn.classList.remove("hidden");
    warn.textContent = ev.state === "precharged"
      ? "⚠ DUT is CHARGED (biased). Press Discharge before touching or removing the DUT."
      : "⚠ Front-end idle, but N_DUT may still hold bias through R_bias. Press Discharge to bleed it.";
  } else {
    warn.classList.add("hidden");
  }

  const bp = document.getElementById("btnAutoPre");
  if (bp) {
    bp.textContent = "Auto pre-charge: " + (ev.auto_pre ? "ON" : "OFF");
    bp.classList.toggle("on", !!ev.auto_pre);
  }
  const bd = document.getElementById("btnAutoDis");
  if (bd) {
    bd.textContent = "Auto discharge: " + (ev.auto_dis ? "ON" : "OFF");
    bd.classList.toggle("on", !!ev.auto_dis);
  }
  // Autoranging run-state: when the device is stopped, hold the charts instead
  // of letting the sample-and-hold tick fake a live flat line.
  if (ev.run !== undefined) {
    state.runKnown = true;
    state.running = !!ev.run;
    updateRunState();
  }
}

// Reflect the run/stop state on the hero so a held chart is never mistaken for
// a live reading.
function updateRunState() {
  const held = state.linkOn && state.runKnown && !state.running;
  document.body.classList.toggle("held", held);
  const note = document.getElementById("runNote");
  if (!note) return;
  if (held) {
    note.classList.remove("hidden");
    note.textContent = "Measurement stopped — charts held at last values";
  } else {
    note.classList.add("hidden");
  }
}
// The sample-and-hold flush must only run while data is actually expected.
function liveTicking() {
  if (!state.linkOn) return false;                 // disconnected: no live data
  if (state.runKnown && !state.running) return false; // stopped by the operator
  return true;
}
// No telemetry: the front-end state is unknown, not "safe".
function markFeStale() {
  const badge = document.getElementById("feState");
  badge.textContent = "UNKNOWN";
  badge.className = "fe-badge idle";
  document.getElementById("feDetail").textContent = "no telemetry — front-end state unknown";
  const warn = document.getElementById("feWarn");
  warn.classList.remove("hidden");
  warn.textContent = "⚠ Telemetry lost — front-end state unknown. Do not assume the DUT is discharged.";
}
function onAck(ev) {
  if (ev.ok) toast("✓ " + ev.cmd + " — " + ev.msg, "ok");
  else toast("✗ " + ev.cmd + " — " + ev.msg, "warn", 6000);
}

function onEvent(ev) {
  switch (ev.t) {
    case "boot": onBoot(ev); break;
    case "cycle": onCycle(ev); break;
    case "sample": onSample(ev); break;
    case "curve": onCurve(ev); break;
    case "tare": onTare(ev); break;
    case "calpt": onCalpt(ev); break;
    case "calres": onCalres(ev); break;
    case "adccalpt": onAdccalpt(ev); break;
    case "adccalres": onAdccalres(ev); break;
    case "sweep": onSweep(ev); break;
    case "fuse": onFuse(ev); break;
    case "stat": onStat(ev); break;
    case "fe": updateFe(ev); break;
    case "ack": onAck(ev); break;
  }
}

// ---------------------------------------------------------------- theming UI
function applyTheme(name) {
  THEME = THEMES[name] || THEMES.dark;
  document.documentElement.setAttribute("data-theme", name);
  try { localStorage.setItem("eswcap-theme", name); } catch (e) {}
  document.getElementById("btnTheme").textContent = name === "dark" ? "Light" : "Dark";
  for (const c of Object.values(charts)) c.rebuild();
  if (curveU) { curveU.destroy(); }
  mountCurve();
  if (state.lastCurve) onCurve(state.lastCurve);
  renderCal();
  renderAdcCal();
  renderFusionStrip();
  updateConfidence(state.lastSpread, state.lastValid);
  renderMatrix();
}
function togglePresent() {
  const on = document.body.classList.toggle("present");
  document.getElementById("btnPresent").classList.toggle("on", on);
  try { localStorage.setItem("eswcap-present", on ? "1" : "0"); } catch (e) {}
  setTimeout(resizeAll, 60);
}

// -------------------------------------------------------------------- share
function renderShare() {
  const urls = state.urls && state.urls.length ? state.urls : [location.origin];
  const listEl = document.getElementById("shareUrls");
  listEl.innerHTML = urls.map((u) =>
    `<div><a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a></div>`).join("");
  const qrEl = document.getElementById("shareQr");
  try {
    const qr = qrcode(0, "M");
    qr.addData(urls[0]);
    qr.make();
    qrEl.innerHTML = qr.createSvgTag({ cellSize: 3, margin: 0 });
  } catch (e) {
    qrEl.textContent = "";
  }
}

// ---------------------------------------------------------------- websocket
let ws = null;
function setLink(on, port, err, urls) {
  const el = document.getElementById("link");
  el.textContent = on ? "connected" : (err ? "disconnected" : "connecting…");
  el.className = "pill " + (on ? "on" : "off");
  document.getElementById("port").textContent = port || "—";
  if (urls && urls.length) state.urls = urls;
  state.linkOn = on;
  updateRunState();
}
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => setLink(false, null, null);
  ws.onclose = () => { setLink(false, null, true); markFeStale(); setTimeout(connect, 1500); };
  ws.onerror = () => {};
  ws.onmessage = (m) => {
    msgCount++;
    let msg;
    try { msg = JSON.parse(m.data); } catch { return; }
    if (msg.type === "status") setLink(msg.connected, msg.port, msg.error, msg.urls);
    else if (msg.type === "reset") resetClientState();
    else if (msg.type === "event") onEvent(msg.event);
    else if (msg.type === "log") appendLog(msg.line);
  };
}
function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function cmd(c) { send({ type: "cmd", cmd: c }); appendLog("> " + c); }
function calCmd(c) {
  const r = document.getElementById("calRange").value;
  cmd(r);           // select the firmware's cal/probe range
  cmd(c);
}
const logEl = () => document.getElementById("log");
function appendLog(line) {
  const el = logEl();
  // Colour ESP_LOG severities so the console reads at a glance.
  let cls = "";
  if (/\bE \(/.test(line) || /error/i.test(line)) cls = "lv-err";
  else if (/\bW \(/.test(line) || /warn/i.test(line)) cls = "lv-warn";
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = line + "\n";
  el.appendChild(span);
  const lines = el.childNodes;
  if (lines.length > 1000) el.removeChild(lines[0]);
  el.scrollTop = el.scrollHeight;
}

// ---------------------------------------------------------------- wiring
document.getElementById("btnStart").onclick = () => cmd("start");
document.getElementById("btnStop").onclick = () => cmd("stop");
document.getElementById("btnSingle").onclick = () => cmd("single");

document.getElementById("btnPrecharge").onclick = () => {
  const msg =
    "PRE-CHARGE will apply the external DC bias (up to 20 V) across the DUT " +
    "through SSR1, and clamp V_cap to GND through SSR3.\n\n" +
    "Confirm before continuing:\n" +
    "• the DUT is correctly seated and rated for the applied bias\n" +
    "• the DUT stays biased after charging until you press Discharge\n" +
    "• you will not touch or remove the DUT while it is charged\n\n" +
    "Pre-charge now?";
  if (confirm(msg)) {
    cmd("precharge");
    toast("Pre-charge requested — watch the front-end state.", "warn", 4000);
  }
};
document.getElementById("btnDischarge").onclick = () => {
  cmd("discharge");
  toast("Discharge requested — wait for the confirmation.", "warn", 4000);
};
document.getElementById("btnIdle").onclick = () => {
  if (confirm("Go IDLE (turn all SSRs off) WITHOUT discharging?\n\n" +
              "If the DUT is charged it may remain biased through R_bias. " +
              "Prefer Discharge for safety."))
    cmd("idle");
};
document.getElementById("btnAutoPre").onclick = () => {
  const on = !(state.fe && state.fe.auto_pre);
  cmd("autoprecharge " + (on ? "on" : "off"));
};
document.getElementById("btnAutoDis").onclick = () => {
  const on = !(state.fe && state.fe.auto_dis);
  cmd("autodischarge " + (on ? "on" : "off"));
};
document.getElementById("mode").onchange = (e) => {
  const v = e.target.value;
  cmd(v === "-1" ? "auto" : "range " + v);
};
document.getElementById("curveChk").onchange = (e) =>
  send({ type: "curve", on: e.target.checked });
document.getElementById("avgWindow").onchange = () => updateCapReadout(null);
document.getElementById("btnTare").onclick = () => calCmd("zero");
document.getElementById("btnTareAll").onclick = () => cmd("zeroall");
document.getElementById("btnCalTable").onclick = () => cmd("cal?");
document.getElementById("btnCalClear").onclick = () => calCmd("calclear");
// OSC references accept unit suffixes (p / n / u / m / f), converted to pF
// client-side because the firmware's `cal*` commands take a bare pF number.
document.getElementById("btnCal1p").onclick = () => {
  const pf = capToPf(document.getElementById("ref1").value);
  if (isFinite(pf) && pf > 0) calCmd("cal " + pf);
  else toast("Enter a reference capacitance (e.g. 100p, 1n, 4.7u)", "warn");
};
document.getElementById("btnCalA").onclick = () => {
  const pf = capToPf(document.getElementById("refA").value);
  if (isFinite(pf) && pf > 0) calCmd("cal1 " + pf);
  else toast("Enter reference 1 capacitance (e.g. 100p, 1n)", "warn");
};
document.getElementById("btnCalB").onclick = () => {
  const pf = capToPf(document.getElementById("refB").value);
  if (isFinite(pf) && pf > 0) calCmd("cal2 " + pf);
  else toast("Enter reference 2 capacitance (e.g. 10n, 1u)", "warn");
};

// ADC (RC-step) series-resistance calibration
document.getElementById("btnAdcCal1p").onclick = () => {
  const pf = capToPf(document.getElementById("adcRef1").value);
  if (isFinite(pf) && pf > 0) calCmd("adccal " + pf);
  else toast("Enter a reference capacitance (e.g. 10u, 1u, 1000000)", "warn");
};
document.getElementById("btnAdcCalA").onclick = () => {
  const pf = capToPf(document.getElementById("adcRefA").value);
  if (isFinite(pf) && pf > 0) calCmd("adccal1 " + pf);
  else toast("Enter reference 1 capacitance (e.g. 1u)", "warn");
};
document.getElementById("btnAdcCalB").onclick = () => {
  const pf = capToPf(document.getElementById("adcRefB").value);
  if (isFinite(pf) && pf > 0) calCmd("adccal2 " + pf);
  else toast("Enter reference 2 capacitance (e.g. 10u)", "warn");
};
document.getElementById("btnAdcCalTable").onclick = () => cmd("adccal?");
document.getElementById("btnAdcCalClear").onclick = () => calCmd("adccalclear");
document.getElementById("btnSend").onclick = () => {
  const el = document.getElementById("cmdInput");
  if (el.value.trim()) { cmd(el.value.trim()); el.value = ""; }
};
document.getElementById("cmdInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("btnSend").click();
});

// theme / presentation / share
document.getElementById("btnTheme").onclick = () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  applyTheme(next);
};
document.getElementById("btnPresent").onclick = togglePresent;
document.getElementById("btnShare").onclick = () => {
  const box = document.getElementById("shareBox");
  box.classList.toggle("hidden");
  if (!box.classList.contains("hidden")) renderShare();
};
document.getElementById("btnShareClose").onclick = () =>
  document.getElementById("shareBox").classList.add("hidden");

// accuracy nominal
document.getElementById("dutRef").addEventListener("input", (e) => {
  const pf = capToPf(e.target.value);
  state.dutRefF = isFinite(pf) && pf > 0 ? pf * 1e-12 : null;
  state.errSeries = [];
  clearChart(charts.err);
  updateAccuracy(null);
});
document.getElementById("btnDutClear").onclick = () => {
  document.getElementById("dutRef").value = "";
  state.dutRefF = null;
  state.errSeries = [];
  clearChart(charts.err);
  updateAccuracy(null);
};

function resizeAll() {
  Object.values(charts).forEach((c) => c.resize());
  curveU.setSize({ width: document.getElementById("curveChart").clientWidth || 400, height: 220 });
  renderCal();
  renderAdcCal();
  renderFusionStrip();
}
window.addEventListener("resize", resizeAll);

// Flush sample-and-hold once per tick so multi-range lines stay continuous —
// but only while telemetry is actually expected.  When the device is stopped or
// the link is down the charts freeze at their last real values instead of
// crawling forward at a held level (which would imply live data).
setInterval(() => {
  if (!liveTicking()) return;
  const x = Date.now() / 1000;
  Object.values(charts).forEach((c) => c.tick(x));
}, 300);

// Highlight which ranges produced samples in the last cycle.
setInterval(() => {
  state.ranges.forEach((r) => {
    const el = document.getElementById("rp" + r.i);
    if (el) el.classList.toggle("active", !!charts.freq.last["r" + r.i] || !!charts.tau.last["r" + r.i]);
  });
}, 500);

// Telemetry throughput (IoT link health).
let msgCount = 0, lastMsgCount = 0, lastMsgT = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = (now - lastMsgT) / 1000;
  const rate = dt > 0 ? (msgCount - lastMsgCount) / dt : 0;
  lastMsgCount = msgCount; lastMsgT = now;
  const el = document.getElementById("stMsgRate");
  if (el) el.textContent = rate.toFixed(1) + " msg/s";
}, 1000);

// ---------------------------------------------------------------- init
(function init() {
  const params = new URLSearchParams(location.search);
  const savedTheme = (() => { try { return localStorage.getItem("eswcap-theme"); } catch (e) { return null; } })();
  const theme = params.get("theme") || savedTheme || "dark";
  THEME = THEMES[theme] || THEMES.dark;
  document.documentElement.setAttribute("data-theme", THEME === THEMES.light ? "light" : "dark");
  document.getElementById("btnTheme").textContent = THEME === THEMES.light ? "Dark" : "Light";
  const present = params.has("present")
    ? params.get("present") !== "0"
    : (() => { try { return localStorage.getItem("eswcap-present") === "1"; } catch (e) { return false; } })();
  if (present) { document.body.classList.add("present"); document.getElementById("btnPresent").classList.add("on"); }
  // Widgets that were created before init with the dark theme are rebuilt now
  // so the saved theme is reflected on first paint.
  for (const c of Object.values(charts)) c.rebuild();
  if (curveU) curveU.destroy();
  mountCurve();
})();

connect();
renderSampleTable();
renderMatrix();
renderFusionStrip();
updateFusionMeta();
updateAccuracy(null);
updateCapReadout(null);
renderAdcCalTable();