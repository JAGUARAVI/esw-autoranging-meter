/* ESWCap dashboard frontend — vanilla JS + uPlot.
 * Every series is fed only by real @@EVT telemetry from the firmware; a chart
 * stays empty until its first real point arrives. */
"use strict";

const RANGE_COLORS = ["#f87171", "#fbbf24", "#60a5fa", "#4ade80"];
const RANGE_LABELS = ["100 Ω", "1 kΩ", "100 kΩ", "1 MΩ"];

const state = {
  ranges: [],           // from boot
  cal: [],
  curSamples: [],
  lastCalres: null,
  fe: null,             // latest front-end state
};

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
  if (s == null || !isFinite(s)) return "—";
  if (s < 0.05) return "HIGH";
  if (s < 0.15) return "MED";
  return "LOW";
}
const fmt = (v, d = 2) => (v == null || !isFinite(v) ? "—" : Number(v).toFixed(d));

// ---------------------------------------------------------------- time charts
class TimeChart {
  constructor(elId, { log = false, series, height = 200 }) {
    this.el = document.getElementById(elId);
    this.seriesDef = series;
    this.log = log;
    this.last = {};
    this.started = false;
    this.xs = [];
    this.data = series.map(() => []);
    const yscale = log ? { distr: 3, log: 10 } : { distr: 1 };
    const opts = {
      width: this.el.clientWidth || 400,
      height,
      scales: { x: { time: true }, y: yscale },
      series: [
        { value: (u, v) => (v == null ? "" : new Date(v * 1000).toLocaleTimeString()) },
        ...series.map((s) => ({
          label: s.label, stroke: s.stroke, width: 1.6, spanGaps: true,
          points: { show: false },
        })),
      ],
      axes: [{}, { size: 54 }],
      legend: { show: true, live: true },
      cursor: { drag: { x: true, y: false } },
    };
    this.u = new uPlot(opts, [[], ...series.map(() => [])], this.el);
  }
  set(key, val) {
    if (val == null || !isFinite(val)) return;
    if (this.log && val <= 0) return;
    this.last[key] = val;
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
  resize() { this.u.setSize({ width: this.el.clientWidth || 400, height: this.el.clientHeight || 200 }); }
}

const charts = {
  cap: new TimeChart("capChart", {
    log: true,
    series: [
      { key: "fused", label: "fused", stroke: RANGE_COLORS[0] },
      { key: "adc", label: "ADC", stroke: RANGE_COLORS[1] },
      { key: "osc", label: "OSC", stroke: RANGE_COLORS[2] },
    ],
  }),
  spread: new TimeChart("spreadChart", {
    series: [{ key: "spread", label: "spread %", stroke: RANGE_COLORS[3] }],
  }),
  freq: new TimeChart("freqChart", {
    log: true,
    series: RANGE_LABELS.map((l, i) => ({ key: "r" + i, label: l, stroke: RANGE_COLORS[i] })),
  }),
  tau: new TimeChart("tauChart", {
    log: true,
    series: RANGE_LABELS.map((l, i) => ({ key: "r" + i, label: l, stroke: RANGE_COLORS[i] })),
  }),
  tare: new TimeChart("tareChart", {
    series: RANGE_LABELS.map((l, i) => ({ key: "r" + i, label: l, stroke: RANGE_COLORS[i] })),
  }),
};

// ---------------------------------------------------------------- curve chart
const curveU = new uPlot(
  {
    width: document.getElementById("curveChart").clientWidth || 400,
    height: 200,
    scales: { x: { time: false }, y: {} },
    series: [
      { value: (u, v) => (v == null ? "" : v.toFixed(1) + " µs") },
      { label: "V_cap (mV)", stroke: RANGE_COLORS[2], width: 1.8 },
      { label: "fitted exp", stroke: RANGE_COLORS[0], width: 1.6, dash: [5, 4] },
    ],
    axes: [{ label: "t (µs)" }, { label: "mV" }],
    legend: { show: true, live: true },
  },
  [[], [], []],
  document.getElementById("curveChart")
);

function onCurve(ev) {
  const pts = ev.pts || [];
  if (!pts.length) return;
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
  const W = el.clientWidth || 400, H = 200, pad = 34;
  if (!calPoints.length) { el.innerHTML = ""; return; }
  const xs = calPoints.map((p) => p.x), ys = calPoints.map((p) => p.y);
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const ymin = Math.min(...ys), ymax = Math.max(...ys);
  const sx = (x) => pad + (xmax === xmin ? 0.5 : (x - xmin) / (xmax - xmin)) * (W - pad - 10);
  const sy = (y) => H - pad + 14 - (ymax === ymin ? 0.5 : (y - ymin) / (ymax - ymin)) * (H - pad - 14);
  let svg = `<svg width="${W}" height="${H}">`;
  svg += `<line x1="${pad}" y1="${H - pad + 14}" x2="${W - 10}" y2="${H - pad + 14}" stroke="#2b3442"/>`;
  svg += `<line x1="${pad}" y1="10" x2="${pad}" y2="${H - pad + 14}" stroke="#2b3442"/>`;
  // fitted model line T = K·R·C + T0 (C in pF -> F, T in us)
  const cr = state.lastCalres, rng = state.ranges[cr ? cr.range : calPoints[calPoints.length - 1].range];
  if (cr && cr.ok && cr.k > 0 && rng) {
    const T = (cpf) => cr.k * rng.r * (cpf * 1e-12) * 1e6 + cr.t0_us;
    svg += `<line x1="${sx(xmin)}" y1="${sy(T(xmin))}" x2="${sx(xmax)}" y2="${sy(T(xmax))}" stroke="#f87171" stroke-dasharray="5 4" stroke-width="1.5"/>`;
  }
  for (const p of calPoints) {
    svg += `<circle cx="${sx(p.x)}" cy="${sy(p.y)}" r="4" fill="${RANGE_COLORS[p.range] || '#fff'}"/>`;
  }
  svg += `<text x="${pad}" y="12" fill="#8b949e" font-size="10">T (µs) vs C_ref (pF)</text>`;
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

// ---------------------------------------------------------------- UI updates
function onBoot(ev) {
  state.ranges = ev.ranges || [];
  state.cal = state.ranges;
  renderCalTable();
  const pills = document.getElementById("rangePills");
  pills.innerHTML = state.ranges.map((r) =>
    `<span class="rangepill" id="rp${r.i}">${r.label}</span>`).join("");
}
function renderCalTable() {
  const t = state.ranges.map((r) =>
    `${r.label.padEnd(8)} K=${fmt(r.k, 5)}  T0=${fmt(r.t0_us, 2)} µs ${r.has_t0 ? '(tared)' : '(no tare)'}  ${r.valid ? 'calibrated' : 'default'}`).join("\n");
  document.getElementById("calTable").textContent = t || "no calibration data yet";
}
function renderSampleTable() {
  const tb = document.querySelector("#sampleTable tbody");
  tb.innerHTML = state.curSamples.map((s) => {
    const t = s.method === "adc" ? fmt(s.tau_us, 1) + " µs" : fmt(s.tau_us, 1) + " µs";
    const second = s.method === "adc" ? "R² " + fmt(s.r2, 3) : fmt(s.freq, 1) + " Hz";
    const cls = s.plausible ? "ok" : (s.valid ? "bad" : "no");
    return `<tr><td>${s.label}</td><td>${s.method}</td><td class="${cls}">${s.plausible ? 'ok' : (s.valid ? 'reject' : 'fail')}</td>` +
      `<td>${formatCap(s.c)}</td><td>${fmt(s.q, 3)}</td><td>${t}</td><td>${second}</td></tr>`;
  }).join("") || `<tr><td colspan="7" class="dim">waiting for a cycle…</td></tr>`;
}
function onCycle(ev) {
  document.getElementById("capValue").textContent = ev.valid ? formatCap(ev.c) : "—";
  document.getElementById("capMeta").textContent =
    `${RANGE_LABELS.length} ranges · ADC ${ev.n_adc} / OSC ${ev.n_osc} · raw ${ev.raw}`;
  document.getElementById("conf").textContent = ev.valid ? confFromSpread(ev.spread) : "—";
  document.getElementById("spread").textContent = (ev.spread * 100).toFixed(1) + " %";
  document.getElementById("adcEst").textContent = formatCap(ev.adc);
  document.getElementById("oscEst").textContent = formatCap(ev.osc);
  document.getElementById("nsamp").textContent = `${ev.n_adc} / ${ev.n_osc}`;
  document.getElementById("mismatch").classList.toggle("hidden", !ev.mismatch);
  charts.cap.set("fused", ev.valid ? ev.c * 1e12 : null);
  charts.cap.set("adc", ev.adc != null ? ev.adc * 1e12 : null);
  charts.cap.set("osc", ev.osc != null ? ev.osc * 1e12 : null);
  charts.spread.set("spread", ev.spread * 100);
  renderSampleTable();
  state.curSamples = [];
}
function onSample(ev) {
  state.curSamples.push(ev);
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
    case "fe": updateFe(ev); break;
    case "ack": onAck(ev); break;
  }
}

// ---------------------------------------------------------------- websocket
let ws = null;
function setLink(on, port, err) {
  const el = document.getElementById("link");
  el.textContent = on ? "connected" : (err ? "disconnected" : "connecting…");
  el.className = "pill " + (on ? "on" : "off");
  document.getElementById("port").textContent = port || "—";
}
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => setLink(false, null, null);
  ws.onclose = () => { setLink(false, null, true); setTimeout(connect, 1500); };
  ws.onerror = () => {};
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.type === "status") setLink(msg.connected, msg.port, msg.error);
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
  el.textContent += line + "\n";
  const lines = el.textContent.split("\n");
  if (lines.length > 1000) el.textContent = lines.slice(-1000).join("\n");
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
document.getElementById("mode").onchange = (e) => {
  const v = e.target.value;
  cmd(v === "-1" ? "auto" : "range " + v);
};
document.getElementById("curveChk").onchange = (e) =>
  send({ type: "curve", on: e.target.checked });
document.getElementById("btnTare").onclick = () => calCmd("zero");
document.getElementById("btnTareAll").onclick = () => cmd("zeroall");
document.getElementById("btnCalTable").onclick = () => cmd("cal?");
document.getElementById("btnCalClear").onclick = () => calCmd("calclear");
document.getElementById("btnCal1p").onclick = () => {
  const v = document.getElementById("ref1").value;
  if (v) calCmd("cal " + v);
};
document.getElementById("btnCalA").onclick = () => {
  const v = document.getElementById("refA").value;
  if (v) calCmd("cal1 " + v);
};
document.getElementById("btnCalB").onclick = () => {
  const v = document.getElementById("refB").value;
  if (v) calCmd("cal2 " + v);
};
document.getElementById("btnSend").onclick = () => {
  const el = document.getElementById("cmdInput");
  if (el.value.trim()) { cmd(el.value.trim()); el.value = ""; }
};
document.getElementById("cmdInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("btnSend").click();
});
window.addEventListener("resize", () => {
  Object.values(charts).forEach((c) => c.resize());
  curveU.setSize({ width: document.getElementById("curveChart").clientWidth || 400, height: 200 });
  renderCal();
});

// Flush sample-and-hold once per tick so multi-range lines stay continuous.
setInterval(() => {
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

connect();
renderSampleTable();