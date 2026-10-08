/* ESWCap "precision instrument" view — vanilla JS + uPlot.
 *
 * Design contract:
 *   - step charts only (L0/L1 instrument readings are discrete events);
 *   - strictly log capacitance axis (decades);
 *   - the hero number & its provenance are the highest visual hierarchy;
 *   - everything else is progressively disclosed;
 *   - every series is fed only by real @@EVT telemetry.
 */
"use strict";

const RANGE_LABELS = ["100 Ω", "1 kΩ", "100 kΩ", "1 MΩ"];
const RANGE_COLORS = ["#f87171", "#fbbf24", "#60a5fa", "#4ade80"];
const ADC_COLOR = "#60a5fa";
const OSC_COLOR = "#34d399";
const GATE_REL = 0.875;
const MAX_CYCLES = 3000;
const C_BLOCK_F = 936.0678e-6;      // measured C_block: 936 µF ∥ 67.8 nF (1000 µF ∥ 100 nF nominal)
const FAULT_C_F = 0.9 * C_BLOCK_F;  // 0.9·C_block safe limit
const STALE_MS = 3500;              // hero dims past this age
const WARN_COOLDOWN_MS = 10000;     // per-kind warning toast cooldown
const METHOD_MISMATCH_THRESHOLD = 1.5;
const OSC_REFUSE_HZ = 15000;        // LM393 refused threshold (spec)
const ADC_SUBNF_GATE_F = 1e-9;

const S = {
  link: false,
  port: "—",
  ranges: [],
  cycles: [],
  byIdx: new Map(),
  nextIdx: 0,
  pending: null,     // in-flight cycle: sweep / samples / curve
  lastRec: null,
  cvals: [],         // valid fused capacitances (F)
  fe: null,
  stat: null,
  markers: [],
  lastActive: null,
  lastMethod: null,
  lastEventAt: 0,
  pinned: null,
  warnAt: {},        // kind -> ms of last toast
  seenCycle: false,
  lastCurve: null,
  // run state (from @@EVT fe)
  runKnown: false,
  running: false,
  single: false,
  lock: -1,
  // ADC curves bucketed per range (resistance)
  curvesByRange: [[], [], [], []],
  curveBucket: 2,
};
const CURVE_BUCKET_MAX = 6;   // keep the last N runs per resistance

// ------------------------------------------------------------------ helpers
const $ = (id) => document.getElementById(id);
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
const fmt = (v, d = 2) => (v == null || !isFinite(v) ? "—" : Number(v).toFixed(d));

function formatCap(f) {                       // Farads -> human
  if (f == null || !isFinite(f)) return "—";
  if (f < 1e-9) return (f * 1e12).toFixed(2) + " pF";
  if (f < 1e-6) return (f * 1e9).toFixed(3) + " nF";
  if (f < 1e-3) return (f * 1e6).toFixed(3) + " µF";
  return (f * 1e3).toFixed(3) + " mF";
}
function formatPf(pf) {                       // pF -> human (chart axis)
  if (pf == null || !isFinite(pf)) return "";
  const f = pf * 1e-12;
  if (f < 1e-9) return pf.toFixed(0) + " pF";
  if (f < 1e-6) return (pf / 1e3).toFixed(1) + " nF";
  if (f < 1e-3) return (pf / 1e6).toFixed(2) + " µF";
  return (pf / 1e9).toFixed(2) + " mF";
}
// Parse a capacitance string with an optional unit suffix -> pF (the unit the
// firmware's `cal` / `adccal` commands expect; they use atof on a bare number).
// Accepts e.g. "1000p", "10n", "1u", "4.7u", "100" (pF).  Bare numbers = pF.
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
    default: break;   // p or unit-less => pF
  }
  return v;
}
function labelForRange(r) { return RANGE_LABELS[r] || ("range " + r); }
// The oscillator tare (T0) is only meaningful on 100 kΩ / 1 MΩ.  On 100 Ω /
// 1 kΩ an empty socket oscillates too fast to tare and T0 is negligible for the
// large caps those ranges serve, so a missing tare there is expected — not a
// calibration fault.
function tareApplies(r) { return r >= 2; }
function methodName(m) { return m === "adc" ? "ADC RC-step (τ)" : "LM393 oscillator (f)"; }
function methodShort(m) { return m === "adc" ? "ADC" : "OSC"; }

function avgWindow() { return parseInt($("avgWindow").value, 10) || 1; }
function rollingAvg(n) {
  if (!S.cvals.length) return null;
  const s = S.cvals.slice(-n);
  return s.reduce((a, b) => a + b, 0) / s.length;
}
function trend() {
  const w = avgWindow();
  if (S.cvals.length < w + 1) return { label: "—", cls: "stable" };
  const cur = rollingAvg(w);
  const prevSlice = S.cvals.slice(-2 * w, -w);
  if (!prevSlice.length) return { label: "—", cls: "stable" };
  const prev = prevSlice.reduce((a, b) => a + b, 0) / prevSlice.length;
  if (!(prev > 0)) return { label: "—", cls: "stable" };
  const d = (cur - prev) / prev;
  if (Math.abs(d) < 0.005) return { label: "Stable", cls: "stable" };
  return { label: d > 0 ? "Rising" : "Falling", cls: d > 0 ? "rising" : "falling" };
}
function fmtDuration(ms) {
  if (ms == null || !isFinite(ms)) return "—";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + "h " : "") + (h || m ? m + "m " : "") + sec + "s";
}
function timeLabel(unixS) {
  if (!unixS) return "—";
  return new Date(unixS * 1000).toLocaleTimeString();
}

// Active (range, method): highest-weight surviving contribution.
function activeOf(rec) {
  if (!rec) return { range: null, method: null };
  const fu = rec.fuse;
  if (fu && fu.contrib && fu.contrib.length) {
    const kept = fu.contrib.filter((c) => c.kept);
    const pool = kept.length ? kept : fu.contrib;
    const top = pool.reduce((a, b) => (b.w > a.w ? b : a));
    return { range: top.r, method: top.m };
  }
  if (rec.sweep && rec.sweep.osc_best >= 0) return { range: rec.sweep.osc_best, method: "osc" };
  if (rec.n_adc > 0) return { range: null, method: "adc" };
  if (rec.n_osc > 0) return { range: null, method: "osc" };
  return { range: null, method: null };
}
function bestR2(rec) {
  const fu = rec && rec.fuse;
  if (!fu || !fu.contrib) return null;
  const r2s = fu.contrib.filter((c) => c.m === "adc" && isFinite(c.r2)).map((c) => c.r2);
  return r2s.length ? Math.max(...r2s) : null;
}
function maxOscFreq(rec) {
  if (!rec || !rec.samples) return null;
  const fs = rec.samples.filter((s) => s.method === "osc" && isFinite(s.freq) && s.freq > 0).map((s) => s.freq);
  return fs.length ? Math.max(...fs) : null;
}
function subNfAdc(rec) {
  return !!(rec && rec.valid && rec.c > 0 && rec.c < ADC_SUBNF_GATE_F);
}

// ------------------------------------------------------------------- toasts
function toast(kind, title, msg, ttl) {
  const box = $("toasts");
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.innerHTML = `<div class="tt">${esc(title)}</div>` + (msg ? `<div>${esc(msg)}</div>` : "");
  box.appendChild(el);
  setTimeout(() => el.remove(), ttl || (kind === "warn" || kind === "err" ? 10000 : 5000));
}
function warnToast(kind, title, msg) {
  const now = Date.now();
  if (now - (S.warnAt[kind] || 0) < WARN_COOLDOWN_MS) return;
  S.warnAt[kind] = now;
  toast("warn", title, msg);
}

// ----------------------------------------------------------------- timeline
const TL = { x: [], fused: [], adc: [], osc: [] };
let capU = null;

function stepPaths(u, sIdx, i0, i1) {
  // Step-after: hold the previous value until the next sample index, then jump.
  const data = u.data[sIdx];
  const xd = u.data[0];
  const p = new Path2D();
  let started = false, prevY = 0;
  for (let i = i0; i <= i1; i++) {
    const yv = data[i];
    if (yv == null || !isFinite(yv)) { started = false; continue; }
    const x = u.valToPos(xd[i], "x", true);
    const y = u.valToPos(yv, "y", true);
    if (!started) { p.moveTo(x, y); started = true; }
    else { p.lineTo(x, prevY); p.lineTo(x, y); }
    prevY = y;
  }
  return { stroke: p };
}

function mountTimeline() {
  const el = $("capChart");
  const opts = {
    width: el.clientWidth || 600,
    height: 240,
    scales: { x: { time: false }, y: { distr: 3, log: 10 } },
    series: [
      { value: (u, x) => { const r = S.byIdx.get(x); return r ? "#" + x + "  " + timeLabel(r.rx_unix_s) : "#" + x; } },
      { label: "fused", stroke: "#4ade80", width: 2.0, paths: stepPaths, points: { show: false }, spanGaps: false,
        value: (u, v) => formatPf(v) },
      { label: "ADC", stroke: ADC_COLOR, width: 1.3, paths: stepPaths, points: { show: false }, spanGaps: false,
        value: (u, v) => formatPf(v) },
      { label: "OSC", stroke: OSC_COLOR, width: 1.3, paths: stepPaths, points: { show: false }, spanGaps: false,
        value: (u, v) => formatPf(v) },
    ],
    axes: [
      { stroke: "#8b949e", grid: { stroke: "rgba(255,255,255,0.07)" }, ticks: { stroke: "rgba(255,255,255,0.07)" },
        label: "measurement index", labelSize: 11 },
      { size: 62, stroke: "#8b949e", grid: { stroke: "rgba(255,255,255,0.07)" }, ticks: { stroke: "rgba(255,255,255,0.07)" },
        label: "capacitance", labelSize: 11, values: (u, vals) => vals.map(formatPf) },
    ],
    legend: { show: true, live: true },
    cursor: { drag: { x: true, y: false }, points: { show: false } },
    hooks: {
      drawClear: [
        (u) => {
          const ctx = u.ctx;
          const { left, top, height } = u.bbox;
          ctx.save();
          for (const m of S.markers) {
            const x = u.valToPos(m.idx, "x", true);
            if (x < left || x > left + u.bbox.width) continue;
            ctx.strokeStyle = m.color;
            ctx.globalAlpha = 0.55;
            ctx.setLineDash(m.type === "tare" ? [2, 3] : [4, 3]);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, top);
            ctx.lineTo(x, top + height);
            ctx.stroke();
          }
          ctx.restore();
        },
      ],
    },
  };
  capU = new uPlot(opts, [[], [], [], []], el);
  // Pin-to-explain: click a historical point to load its telemetry.
  capU.over.addEventListener("click", (e) => {
    const rect = capU.over.getBoundingClientRect();
    const i = capU.posToIdx(e.clientX - rect.left);
    const x = TL.x[i];
    if (x == null) return;
    const rec = S.byIdx.get(x);
    if (rec) pin(rec);
  });
}

function pushTimeline(rec) {
  TL.x.push(rec.idx);
  TL.fused.push(rec.valid && rec.c > 0 ? rec.c * 1e12 : null);
  TL.adc.push(rec.adc != null && isFinite(rec.adc) && rec.adc > 0 ? rec.adc * 1e12 : null);
  TL.osc.push(rec.osc != null && isFinite(rec.osc) && rec.osc > 0 ? rec.osc * 1e12 : null);
  if (TL.x.length > MAX_CYCLES) {
    const d = TL.x.length - MAX_CYCLES;
    ["x", "fused", "adc", "osc"].forEach((k) => TL[k].splice(0, d));
  }
}
function applyXScale() {
  if (!TL.x.length) return;
  const last = TL.x[TL.x.length - 1];
  if (!S.pinned && $("autoPan").checked) {
    capU.setScale("x", { min: Math.max(TL.x[0], last - 199), max: last + 1 });
  } else {
    capU.setScale("x", { min: TL.x[0], max: last + 1 });
  }
}
function setTimelineData() {
  capU.setData([TL.x, TL.fused, TL.adc, TL.osc]);
  applyXScale();
}

// ------------------------------------------------------------------ pinning
function pin(rec) {
  S.pinned = rec;
  $("btnLive").classList.remove("hidden");
  $("panelFusion").open = true;
  $("panelCurve").open = true;
  renderTimelineNote();
  renderTrust(rec);
  renderHero(rec);
  renderFusionPanels(rec);
  renderCurve(rec);
  toast("info", "Pinned cycle #" + rec.idx, "Historical telemetry loaded. Live stream view frozen.");
}
function resumeLive() {
  S.pinned = null;
  $("btnLive").classList.add("hidden");
  renderTimelineNote();
  const last = S.lastRec;
  if (last) { renderTrust(last); renderHero(last); renderFusionPanels(last); renderCurve(last); }
  setTimelineData();
}
function renderTimelineNote() {
  const el = $("timelineNote");
  if (S.pinned) {
    el.innerHTML = `Pinned <b class="mono">#${S.pinned.idx}</b> (${esc(timeLabel(S.pinned.rx_unix_s))}) — click another point, or resume live.`;
  } else {
    el.textContent = "X-axis = measurement index (idle time collapses). Hover for the absolute timestamp; click a point to pin its telemetry.";
  }
}

// --------------------------------------------------------------------- hero
function renderHero(rec) {
  const hv = $("heroValue");
  if (!S.link) {
    hv.textContent = "NO LINK";
    hv.className = "hero-value mono nolink";
    $("heroAvg").textContent = "—";
    $("heroTrend").textContent = "—";
    $("heroTrend").className = "trend stable";
    $("heroCycle").textContent = "";
    return;
  }
  hv.classList.remove("nolink");
  const w = avgWindow();
  const avg = rollingAvg(w);
  const instant = rec && rec.valid && rec.c > 0 ? rec.c : null;
  const shown = w > 1 && avg != null ? avg : instant;
  hv.textContent = shown != null ? formatCap(shown) : "—";
  hv.classList.remove("stale", "held");
  if (S.pinned) hv.classList.add("stale");
  else if (S.runKnown && !S.running) hv.classList.add("held");
  $("heroAvg").textContent = avg != null ? formatCap(avg) : "—";
  const tr = trend();
  const te = $("heroTrend");
  te.textContent = tr.label;
  te.className = "trend " + tr.cls;
  $("heroCycle").textContent = rec
    ? `cycle #${rec.idx} · ${timeLabel(rec.rx_unix_s)}${S.pinned ? " · PINNED" : ""}`
    : "";
}

// -------------------------------------------------------------------- trust
function trustLevel(rec) {
  if (!rec) return "none";
  if (!rec.valid) return "err";
  const r2 = bestR2(rec);
  if ((rec.spread != null && rec.spread > 0.05) ||
      (rec.quality != null && rec.quality < 0.02) ||
      (rec.mismatch_ratio != null && rec.mismatch_ratio > METHOD_MISMATCH_THRESHOLD) ||
      (r2 != null && r2 < 0.90)) return "warn";
  return "ok";
}

function renderTrust(rec) {
  const head = $("trustHead"), body = $("trustBody");
  const active = activeOf(rec);
  // range token on the panel borders
  const applyRange = (el) => {
    if (active.range != null) el.setAttribute("data-range", String(active.range));
    else el.removeAttribute("data-range");
  };
  applyRange($("heroCard"));
  applyRange($("trustCard"));
  applyRange($("timelineCard"));

  if (!rec || !rec.valid) {
    head.className = "trust-head err";
    head.textContent = rec ? "✗ No valid fusion this cycle" : "Waiting for a measurement…";
    body.innerHTML = rec
      ? `<span class="ln red">All samples failed validity / the median gate.</span>
         <span class="ln dim">The system rejected the cycle rather than smoothing over it.</span>`
      : `<span class="ln dim">No cycle telemetry yet.</span>`;
    $("activeBadge").innerHTML = `<span class="badge">—</span>`;
    $("gateText").textContent = "—";
    $("mismatchText").textContent = "—";
    return;
  }

  const level = trustLevel(rec);
  head.className = "trust-head " + (level === "ok" ? "ok" : level === "warn" ? "warn" : "err");
  head.textContent = level === "ok" ? "✓ High Confidence" : "⚠ Low confidence";

  const fu = rec.fuse || {};
  const nMethods = (rec.n_adc > 0 ? 1 : 0) + (rec.n_osc > 0 ? 1 : 0);
  const ranges = fu.contrib ? new Set(fu.contrib.filter((c) => c.kept).map((c) => c.r)).size : 0;
  const spreadPct = rec.spread != null && isFinite(rec.spread) ? (rec.spread * 100).toFixed(1) + "%" : "N/A";
  const r2 = bestR2(rec);

  const lines = [];
  lines.push(
    `<span class="ln ${level === "ok" ? "green" : ""}">${ranges || "0"} range${ranges === 1 ? "" : "s"} agree across ${nMethods} method${nMethods === 1 ? "" : "s"}. Spread: ${spreadPct}.</span>`
  );
  lines.push(
    `<span class="ln">Active: <b>${active.range != null ? esc(labelForRange(active.range)) : "—"}</b> | ${esc(methodName(active.method))}</span>`
  );
  const gateTotal = (fu.n_kept || 0) + (fu.n_gated || 0);
  const gatePct = gateTotal > 0 ? (((fu.n_kept || 0) / gateTotal) * 100).toFixed(0) + "%" : "N/A";
  lines.push(
    `<span class="ln">Median gate: ${esc(gatePct)} passed (±${(GATE_REL * 100).toFixed(1)}%) | ` +
    `fused quality ${rec.quality != null ? fmt(rec.quality, 3) : "—"}` +
    (r2 != null ? ` | R² ${fmt(r2, 4)}` : "") + `</span>`
  );
  if (rec.mismatch_ratio != null && rec.mismatch_ratio > METHOD_MISMATCH_THRESHOLD) {
    lines.push(
      `<span class="ln amber">Methods Disagree: ADC (${formatCap(rec.adc)}) / OSC (${formatCap(rec.osc)}) — ratio ${fmt(rec.mismatch_ratio, 2)} &gt; ${METHOD_MISMATCH_THRESHOLD}.</span>`
    );
  }
  if (subNfAdc(rec) && active.method !== "adc") {
    lines.push(`<span class="ln amber">ADC disabled (capacitance &lt; 1 nF gate). Relying on LM393 oscillator.</span>`);
  }
  body.innerHTML = lines.join("");

  // badges
  const rc = active.range != null ? RANGE_COLORS[active.range] : "#8b949e";
  $("activeBadge").innerHTML = active.range != null
    ? `<span class="badge" style="color:${rc};border-color:${rc}">${esc(labelForRange(active.range))} · ${esc(methodShort(active.method || ""))}</span>`
    : `<span class="badge">—</span>`;
  $("gateText").textContent = gateTotal > 0 ? `${fu.n_kept || 0}/${gateTotal} kept` : "—";
  $("mismatchText").textContent = rec.mismatch_ratio != null && isFinite(rec.mismatch_ratio) ? fmt(rec.mismatch_ratio, 2) : "N/A";
}

// -------------------------------------------------------------- fusion panels
function methodColor(m) { return m === "adc" ? ADC_COLOR : OSC_COLOR; }

function renderFusionPanels(rec) {
  const el = $("fusionWeights");
  const fu = rec && rec.fuse;
  const contrib = (fu && fu.contrib) || [];
  if (!contrib.length) {
    el.className = "dim";
    el.textContent = "no fusion data yet — start a measurement.";
    $("spreadPlot").innerHTML = '<span class="dim">no samples yet</span>';
    renderSampleTable(rec);
    return;
  }
  el.className = "";
  // Stacked weight bar: width ∝ quality weight, colour by method.
  const kept = contrib.filter((c) => c.kept);
  const total = kept.reduce((a, c) => a + (c.w || 0), 0);
  let segs = "";
  if (total > 0) {
    for (const c of kept) {
      const pct = (c.w / total) * 100;
      const col = methodColor(c.m);
      const txt = pct > 8 ? `${esc(methodShort(c.m))} ${esc(labelForRange(c.r))}` : "";
      segs += `<div class="seg" style="width:${pct.toFixed(2)}%;background:${col}" title="${esc(methodShort(c.m))} ${esc(labelForRange(c.r))} · q ${fmt(c.q, 3)} · w ${fmt(c.w, 3)} · ${formatCap(c.c)}${c.m === "adc" ? " · R² " + fmt(c.r2, 3) : ""}">${txt}</div>`;
    }
  }
  const gated = contrib.filter((c) => !c.kept);
  el.innerHTML =
    `<div class="wbar">${segs || '<div class="seg" style="width:100%;background:var(--panel2)"></div>'}</div>` +
    `<div class="wlegend">` +
    `<span><span class="dot" style="background:${ADC_COLOR}"></span>ADC weight ${fmt(kept.filter((c) => c.m === "adc").reduce((a, c) => a + c.w, 0), 2)}</span>` +
    `<span><span class="dot" style="background:${OSC_COLOR}"></span>OSC weight ${fmt(kept.filter((c) => c.m === "osc").reduce((a, c) => a + c.w, 0), 2)}</span>` +
    `<span class="dim">Σw ${fmt(total, 3)}</span>` +
    (gated.length ? `<span style="color:var(--err)">${gated.length} gated: ${gated.map((c) => esc(formatCap(c.c))).join(", ")}</span>` : "") +
    `</div>`;

  renderSpread(rec);
  renderSampleTable(rec);
}

function renderSpread(rec) {
  const el = $("spreadPlot");
  const fu = rec && rec.fuse;
  const contrib = (fu && fu.contrib) || [];
  const W = el.clientWidth || 600;
  if (!contrib.length || W < 40) { el.innerHTML = '<span class="dim">no samples yet</span>'; return; }
  const med = fu.median > 0 ? fu.median : contrib[0].c;
  if (!(med > 0)) { el.innerHTML = '<span class="dim">no median</span>'; return; }
  const H = 160, padL = 54, padR = 16, padT = 14, padB = 22;
  const rel = (c) => (c - med) / med;
  const maxAbs = Math.max(0.1, ...contrib.map((c) => Math.abs(rel(c.c))), GATE_REL * 1.3);
  const yOf = (r) => padT + (1 - (r + maxAbs) / (2 * maxAbs)) * (H - padT - padB);
  const T = "#8b949e", grid = "rgba(255,255,255,0.07)";
  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  // gate band
  const yHi = yOf(GATE_REL), yLo = yOf(-GATE_REL);
  svg += `<rect x="${padL}" y="${yHi}" width="${W - padL - padR}" height="${Math.max(1, yLo - yHi)}" fill="rgba(255,255,255,0.05)"/>`;
  for (const r of [maxAbs, GATE_REL, 0, -GATE_REL, -maxAbs]) {
    const y = yOf(r);
    svg += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${grid}"/>`;
    svg += `<text x="${padL - 6}" y="${y + 4}" fill="${T}" font-size="10" text-anchor="end" font-family="monospace">${(r * 100).toFixed(0)}%</text>`;
  }
  svg += `<line x1="${padL}" y1="${yOf(0)}" x2="${W - padR}" y2="${yOf(0)}" stroke="${T}" stroke-dasharray="4 3"/>`;
  // jitter x so coincident samples remain visible
  const seen = {};
  for (const c of contrib) {
    const r = rel(c.c);
    const y = yOf(r);
    const key = Math.round(y);
    seen[key] = (seen[key] || 0) + 1;
    const x = padL + ((W - padL - padR) / 2) + (seen[key] - 1) * 16 + 12;
    if (c.kept) {
      svg += `<circle cx="${x}" cy="${y}" r="5" fill="${methodColor(c.m)}" fill-opacity="0.9"><title>${esc(methodShort(c.m))} ${esc(labelForRange(c.r))} ${formatCap(c.c)} · ${(r * 100).toFixed(1)}%</title></circle>`;
    } else {
      svg += `<circle cx="${x}" cy="${y}" r="5" fill="none" stroke="#f87171" stroke-dasharray="2 2"><title>REJECTED ${esc(labelForRange(c.r))} ${formatCap(c.c)} · ${(r * 100).toFixed(1)}%</title></circle>`;
      svg += `<line x1="${x - 5}" y1="${y - 5}" x2="${x + 5}" y2="${y + 5}" stroke="#f87171"/>`;
      svg += `<line x1="${x - 5}" y1="${y + 5}" x2="${x + 5}" y2="${y - 5}" stroke="#f87171"/>`;
    }
  }
  svg += `<text x="${padL - 6}" y="${padT - 2}" fill="${T}" font-size="10" text-anchor="end" font-family="monospace">dev</text>`;
  svg += `</svg>`;
  el.innerHTML = svg;
}

function renderSampleTable(rec) {
  const tb = document.querySelector("#sampleTable tbody");
  const fu = rec && rec.fuse;
  const contrib = (fu && fu.contrib) || [];
  if (!contrib.length) {
    tb.innerHTML = `<tr><td colspan="8" class="dim">waiting for a cycle…</td></tr>`;
    return;
  }
  tb.innerHTML = contrib.map((c) => {
    const status = c.kept
      ? `<span style="color:var(--accent)">kept</span>`
      : `<span style="color:var(--err)">gated</span>`;
    const second = c.m === "adc"
      ? "R² " + fmt(c.r2, 3)
      : fmt(rec && rec.samples ? (rec.samples.find((s) => s.range === c.r && s.method === "osc") || {}).freq : null, 0) + " Hz";
    const tOrTau = c.m === "adc"
      ? fmt((rec.samples.find((s) => s.range === c.r && s.method === "adc") || {}).tau_us, 1) + " µs"
      : fmt((rec.samples.find((s) => s.range === c.r && s.method === "osc") || {}).period, 1);
    return `<tr>
      <td>${esc(labelForRange(c.r))}</td>
      <td>${esc(methodShort(c.m))}</td>
      <td>${status}</td>
      <td>${formatCap(c.c)}</td>
      <td>${fmt(c.q, 3)}</td>
      <td>${fmt(c.w, 3)}</td>
      <td>${tOrTau}</td>
      <td>${second}</td></tr>`;
  }).join("");
}

// ------------------------------------------------------------------ curve
// ADC charge curves are bucketed per resistance (range).  Each bucket keeps the
// last CURVE_BUCKET_MAX runs; the selected bucket shows its newest run as dots
// + the ghost fit, with older runs of the same resistance drawn faintly behind.
let curveU = null;
function drawCurveHistory(u) {
  const hist = u._hist || [];
  if (!hist.length) return;
  const ctx = u.ctx;
  ctx.save();
  ctx.lineWidth = 1;
  for (let h = 0; h < hist.length; h++) {
    const pts = hist[h].pts || [];
    if (!pts.length) continue;
    ctx.globalAlpha = hist.length === 1 ? 0.22 : 0.10 + 0.18 * (h / (hist.length - 1));
    ctx.strokeStyle = RANGE_COLORS[hist[h].range] || "#8b949e";
    ctx.beginPath();
    let started = false;
    for (const p of pts) {
      const x = u.valToPos(p[0], "x", true);
      const y = u.valToPos(p[1], "y", true);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();
}
function mountCurve() {
  const el = $("curveChart");
  curveU = new uPlot({
    width: el.clientWidth || 600,
    height: 260,
    scales: { x: { time: false }, y: {} },
    series: [
      { value: (u, v) => (v == null ? "" : v.toFixed(0) + " µs") },
      { label: "V_cap (mV)", stroke: "#60a5fa", width: 2.0,
        // scatter only: suppress the connecting line, show the raw samples as dots
        paths: () => ({}),
        points: { show: true, size: 6, fill: "#60a5fa", stroke: "#60a5fa" } },
      { label: "fitted_exp (ghost)", stroke: "#f87171", width: 2.0, dash: [6, 4] },
    ],
    axes: [
      { stroke: "#8b949e", grid: { stroke: "rgba(255,255,255,0.07)" }, ticks: { stroke: "rgba(255,255,255,0.07)" }, label: "t (µs)", labelSize: 11 },
      { stroke: "#8b949e", grid: { stroke: "rgba(255,255,255,0.07)" }, ticks: { stroke: "rgba(255,255,255,0.07)" }, label: "mV", labelSize: 11 },
    ],
    legend: { show: true, live: true },
    cursor: { points: { show: false } },
    hooks: { drawClear: [drawCurveHistory] },
  }, [[], [], []], el);
}
function latestCurve(r) {
  const b = S.curvesByRange[r];
  return b && b.length ? b[b.length - 1] : null;
}
function renderCurveTabs() {
  const el = $("curveTabs");
  if (!el) return;
  el.innerHTML = RANGE_LABELS.map((l, i) => {
    const n = S.curvesByRange[i].length;
    return `<button class="tab ${i === S.curveBucket ? "active" : ""} ${n ? "" : "empty"}" data-range="${i}" ` +
      `title="${esc(l)} — ${n} stored curve${n === 1 ? "" : "s"}">${esc(l)} <span class="cnt">${n}</span></button>`;
  }).join("");
  el.querySelectorAll(".tab").forEach((t) => {
    t.onclick = () => { S.curveBucket = parseInt(t.dataset.range, 10); renderCurveTabs(); renderCurve(S.pinned || S.lastRec); };
  });
}
function renderCurve(rec) {
  const meta = $("curveMeta");
  let ev = null, range = S.curveBucket;
  if (S.pinned && rec && rec.curve) { ev = rec.curve; range = ev.range; S.curveBucket = range; }
  else ev = latestCurve(range);
  const bucket = S.curvesByRange[range] || [];
  // faint history = the other stored runs in this bucket (shadowing the shown one)
  let hist = bucket.filter((c) => c !== ev).slice(-3);
  curveU._hist = hist;
  if (!ev || !(ev.pts || []).length) {
    curveU.setData([[], [], []]);
    meta.textContent = `no ADC curve stored for ${labelForRange(range)} yet.`;
    renderCurveTabs();
    return;
  }
  const pts = ev.pts;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  // Ghost fit mirrors the firmware model: V(t) = Vinf − (Vinf − V0)·exp(−(t−t0)/τ).
  const v0 = (typeof ev.v0 === "number" && ev.v0 > 0) ? ev.v0 : 0;
  const t0 = (typeof ev.t0_us === "number") ? ev.t0_us : 0;
  const fit = (ev.tau_us > 0 && ev.vinf > 0)
    ? xs.map((t) => Math.max(0, ev.vinf - (ev.vinf - v0) * Math.exp(-(t - t0) / ev.tau_us)))
    : xs.map(() => null);
  curveU.setData([xs, ys, fit]);
  // include the faint history in the domains so nothing clips
  let xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
  for (const h of hist) for (const p of (h.pts || [])) {
    if (p[0] < xmin) xmin = p[0]; if (p[0] > xmax) xmax = p[0];
    if (p[1] < ymin) ymin = p[1]; if (p[1] > ymax) ymax = p[1];
  }
  if (xmax > xmin) curveU.setScale("x", { min: xmin, max: xmax });
  curveU.setScale("y", { min: Math.min(0, ymin), max: ymax * 1.05 });
  meta.textContent = `${labelForRange(ev.range)} · V∞ ${ev.vinf} mV · τ ${fmt(ev.tau_us, 1)} µs · R² ${fmt(ev.r2, 4)}` +
    (ev.tau_us > 0 ? "" : " · 2-point fallback (no fit)") +
    (bucket.length > 1 ? ` · ${bucket.length} runs in bucket` : "");
  renderCurveTabs();
}

// -------------------------------------------------------------- calibration
function renderCalGrid() {
  const el = $("calGrid");
  if (!S.ranges.length) { el.innerHTML = `<div class="dim">waiting for device boot…</div>`; return; }
  el.innerHTML = S.ranges.map((r) => {
    const needsTare = tareApplies(r.i);
    const tared = r.has_t0;
    const tareTxt = needsTare ? (tared ? "tared" : "no tare") : "tare n/a";
    return `<div class="cal-box" data-range="${r.i}" style="border-top:2px solid ${RANGE_COLORS[r.i] || "#8b949e"}">
      <div class="k">${esc(r.label)}</div>
      <div class="v">K ${fmt(r.k, 5)} · T0 ${fmt(r.t0_us, 2)} µs</div>
      <div class="v ${(needsTare && !tared) ? "dim" : ""}">${tareTxt} · ${r.valid ? "calibrated" : "default"}</div>
      <div class="v ${r.adc_valid ? "" : "dim"}">ADC R_eff ${fmt(r.adc_r_eff, 1)} Ω · C0 ${r.adc_c0_f != null ? (r.adc_c0_f * 1e12).toFixed(1) + " pF" : "—"}</div>
    </div>`;
  }).join("");
}
function renderCalTableText() {
  const t = S.ranges.map((r) => {
    const tareTxt = tareApplies(r.i) ? (r.has_t0 ? "(tared)" : "(no tare)") : "(tare n/a)";
    return `${String(r.label || "").padEnd(8)} K=${fmt(r.k, 5)}  T0=${fmt(r.t0_us, 2)} µs ${tareTxt}  ${r.valid ? "calibrated" : "default"}`;
  }).join("\n");
  $("calTable").textContent = t || "no calibration data yet";
}

// --------------------------------------------------------------------- alerts
function calProblem(active) {
  if (!active || active.range == null || !S.ranges.length) return null;
  const r = S.ranges[active.range];
  if (!r) return null;
  // 100 Ω / 1 kΩ are intentionally untared (T0 negligible; see tareApplies).
  if (active.method === "osc" && tareApplies(active.range) && !r.has_t0)
    return `calibration missing for active range ${labelForRange(active.range)} (oscillator not tared)`;
  if (active.method === "adc" && !r.adc_valid) return `ADC calibration missing for active range ${labelForRange(active.range)}`;
  return null;
}
function setFault(text, sub, showReconnect) {
  const b = $("faultBanner");
  if (!text) {
    b.classList.add("hidden");
    document.body.classList.remove("faulted");
    $("faultAction").classList.add("hidden");
    return;
  }
  b.classList.remove("hidden");
  document.body.classList.add("faulted");
  $("faultText").textContent = text;
  $("faultSub").textContent = sub || "";
  $("faultAction").classList.toggle("hidden", !showReconnect);
}
function checkAlerts() {
  const rec = S.lastRec;
  const active = activeOf(rec);
  if (!S.link) {
    setFault("FAULT: Device offline.", "Serial link lost — no measurement is running.", true);
  } else if (rec && rec.valid && rec.c > FAULT_C_F) {
    setFault("FAULT: Measurement halted.", `Capacitor exceeds the safe 0.9·C_block limit (${formatCap(FAULT_C_F)}).`, false);
  } else {
    const cp = calProblem(active);
    if (cp) setFault("FAULT: Calibration missing.", cp, false);
    else setFault(null);
  }

  // WARNINGS (fused-state, never a single gate-rejected outlier)
  if (S.link && rec && rec.valid) {
    if (rec.quality != null && rec.quality < 0.02)
      warnToast("quality", "WARNING: Low confidence.", `Fused quality ${fmt(rec.quality, 3)} is below the 0.02 floor.`);
    if (rec.spread > 0.05)
      warnToast("spread", "WARNING: Low confidence.", `Relative spread ${(rec.spread * 100).toFixed(1)}% exceeds the 5% threshold.`);
    const r2 = bestR2(rec);
    if (r2 != null && r2 < 0.90)
      warnToast("r2", "WARNING: Poor exponential fit.", `ADC fit R² ${fmt(r2, 3)} is below 0.90.`);
    if (rec.mismatch_ratio != null && rec.mismatch_ratio > METHOD_MISMATCH_THRESHOLD)
      warnToast("mismatch", "WARNING: Methods disagree.", `ADC and OSC mismatch ratio (${fmt(rec.mismatch_ratio, 2)}) exceeds 1.5.`);
    const fr = maxOscFreq(rec);
    if (fr != null && fr > OSC_REFUSE_HZ)
      warnToast("osc", "WARNING: Oscillator refused.", `LM393 oscillator ran at ${Math.round(fr)} Hz (> 15 kHz).`);
  }
}

// ------------------------------------------------------------- transitions
function detectTransitions(rec) {
  if (!rec || !rec.valid) return;
  const active = activeOf(rec);
  if (S.seenCycle) {
    if (active.range != null && S.lastActive != null && active.range !== S.lastActive) {
      toast("info", "Autorange switch", `${labelForRange(S.lastActive)} → ${labelForRange(active.range)}`);
    }
    if (active.method && S.lastMethod && active.method !== S.lastMethod) {
      toast("info", "Method handoff", `${methodShort(S.lastMethod)} → ${methodShort(active.method)}`);
    }
  }
  if (active.range != null && S.lastActive != null && active.range !== S.lastActive) {
    S.markers.push({ idx: rec.idx, type: "range", color: RANGE_COLORS[active.range] });
    if (S.markers.length > 200) S.markers.shift();
  }
  S.lastActive = active.range;
  S.lastMethod = active.method;
  S.seenCycle = true;
}

// -------------------------------------------------------------- telemetry in
function finalizeCycle(ev) {
  const p = S.pending || {};
  const rec = {
    idx: S.nextIdx++,
    ts_ms: ev.ts_ms,
    rx_unix_s: ev.rx_unix_s || Date.now() / 1000,
    valid: !!ev.valid, c: ev.c, spread: ev.spread, quality: ev.quality,
    weight: ev.weight, mismatch_ratio: ev.mismatch_ratio,
    adc: ev.adc, osc: ev.osc, n_adc: ev.n_adc, n_osc: ev.n_osc,
    raw: ev.raw, mismatch: ev.mismatch,
    fuse: p.fuse || null, sweep: p.sweep || null,
    samples: p.samples || [], curve: p.curve || null,
  };
  S.pending = null;
  return rec;
}
function trimCycles() {
  while (S.cycles.length > MAX_CYCLES) {
    const old = S.cycles.shift();
    S.byIdx.delete(old.idx);
  }
}
function onCycle(ev) {
  const rec = finalizeCycle(ev);
  S.cycles.push(rec);
  S.byIdx.set(rec.idx, rec);
  trimCycles();
  S.lastRec = rec;
  if (ev.valid && ev.c > 0) {
    S.cvals.push(ev.c);
    if (S.cvals.length > 200) S.cvals.shift();
  }
  pushTimeline(rec);
  if (!S.pinned) { setTimelineData(); renderHero(rec); renderTrust(rec); renderFusionPanels(rec); renderCurve(rec); }
  detectTransitions(rec);
  checkAlerts();
  S.lastEventAt = Date.now();
}
function onSweep(ev) {
  (S.pending = S.pending || {}).sweep = ev;
}
function onSample(ev) {
  (S.pending = S.pending || {}).samples = (S.pending.samples || []);
  S.pending.samples.push(ev);
}
function onFuse(ev) {
  if (S.lastRec && !S.lastRec.fuse) {
    S.lastRec.fuse = ev;
    if (!S.pinned) { renderTrust(S.lastRec); renderFusionPanels(S.lastRec); }
  } else {
    (S.pending = S.pending || {}).fuse = ev;
  }
}
function onCurve(ev) {
  S.lastCurve = ev;
  (S.pending = S.pending || {}).curve = ev;
  // bucket the curve by resistance (range)
  const b = S.curvesByRange[ev.range];
  if (b) {
    b.push(ev);
    while (b.length > CURVE_BUCKET_MAX) b.shift();
  }
  if (!S.pinned && $("panelCurve").open) renderCurve(S.lastRec);
  else renderCurveTabs();
}
function onTare(ev) {
  if (ev.done) {
    const r = S.ranges[ev.range];
    if (r) { r.t0_us = ev.t0_us; r.has_t0 = true; renderCalGrid(); renderCalTableText(); }
    const idx = S.lastRec ? S.lastRec.idx : 0;
    S.markers.push({ idx, type: "tare", color: "#8b949e" });
    if (S.markers.length > 200) S.markers.shift();
    toast("info", "Tare applied", `${labelForRange(ev.range)} T0 = ${fmt(ev.t0_us, 2)} µs`);
  }
}
function onCalres(ev) {
  const r = S.ranges[ev.range];
  if (r) { r.k = ev.k; r.t0_us = ev.t0_us; if (ev.ok) r.valid = true; renderCalGrid(); renderCalTableText(); }
  toast(ev.ok ? "ok" : "warn", ev.ok ? "Calibration solved" : "Calibration failed",
    `${labelForRange(ev.range)} K ${fmt(ev.k, 5)} T0 ${fmt(ev.t0_us, 2)} µs`);
}
function onAdccalres(ev) {
  const r = S.ranges[ev.range];
  if (r) { r.adc_r_eff = ev.r_eff; r.adc_c0_f = ev.c0_f; if (ev.ok) r.adc_valid = true; renderCalGrid(); }
  toast(ev.ok ? "ok" : "warn", ev.ok ? "ADC cal solved" : "ADC cal failed",
    `${labelForRange(ev.range)} R_eff ${fmt(ev.r_eff, 1)} Ω`);
}
function onBoot(ev) {
  S.ranges = ev.ranges || [];
  renderCalGrid();
  renderCalTableText();
}
function onStat(ev) {
  S.stat = ev;
  $("uptime").textContent = fmtDuration(ev.uptime_ms);
  // Health: heap headroom + freshness.
  const el = $("health");
  const heapK = ev.heap_free != null ? ev.heap_free / 1024 : null;
  const good = heapK == null || heapK > 20;
  el.textContent = "HEALTH: " + (good ? "GOOD" : "LOW HEAP");
  el.className = "chip " + (good ? "good" : "bad");
}
function onFe(ev) {
  S.fe = ev;
  const names = {
    idle: "IDLE", precharge: "PRE-CHARGE", precharged: "ISOLATE",
    measuring: "MEASURING", discharge: "DISCHARGE",
  };
  const st = $("feState");
  st.textContent = names[ev.state] || String(ev.state).toUpperCase();
  st.className = "fe-state " + ev.state;
  $("chipSSR13").classList.toggle("on", !!ev.ssr13);
  $("chipSSR2").classList.toggle("on", !!ev.ssr2);
  $("chipDrive").classList.toggle("on", !!ev.drive);
  $("chipDrive").classList.toggle("drive", true);
  const ap = $("chipAutoPre"), ad = $("chipAutoDis");
  ap.textContent = "Auto-Pre: " + (ev.auto_pre ? "ON" : "OFF");
  ad.textContent = "Auto-Dis: " + (ev.auto_dis ? "ON" : "OFF");
  ap.classList.toggle("on", !!ev.auto_pre);
  ad.classList.toggle("on", !!ev.auto_dis);
  // Automation buttons mirror the live flags.
  const bp = $("btnAutoPre"), bd = $("btnAutoDis");
  if (bp) { bp.textContent = "Auto-Pre: " + (ev.auto_pre ? "ON" : "OFF"); bp.classList.toggle("on", !!ev.auto_pre); }
  if (bd) { bd.textContent = "Auto-Dis: " + (ev.auto_dis ? "ON" : "OFF"); bd.classList.toggle("on", !!ev.auto_dis); }

  // Run state: drives the live/hold behaviour and the control buttons.
  S.runKnown = true;
  S.running = !!ev.run;
  S.single = !!ev.single;
  S.lock = (ev.lock == null ? -1 : ev.lock);
  const rs = $("runState");
  rs.textContent = S.single ? "SINGLE" : (S.running ? "RUN" : "HOLD");
  rs.className = "chip run " + (S.running ? "on" : "hold");

  // Persistent charge state (survives a stop).
  const ch = $("chipCharge");
  const charge = ev.charge || (ev.charged && !ev.discharged ? "charged"
                : (ev.discharged && !ev.charged ? "discharged" : "unknown"));
  ch.textContent = "CHARGE: " + charge.toUpperCase();
  ch.className = "chip " + (charge === "charged" ? "bad" : charge === "discharged" ? "good" : "");
  const sel = $("mode");
  if (sel) sel.value = String(S.lock >= 0 ? S.lock : -1);
  const hd = $("btnSingle");
  if (hd) hd.classList.toggle("on", S.single);
  // Entering hold immediately refreshes the hero note/state.
  if (!S.pinned) renderHero(S.lastRec);
}
function onAck(ev) { toast(ev.ok ? "ok" : "warn", ev.ok ? "✓ " + ev.cmd : "✗ " + ev.cmd, ev.msg); }
function onEvent(ev) {
  switch (ev.t) {
    case "boot": onBoot(ev); break;
    case "cycle": onCycle(ev); break;
    case "sample": onSample(ev); break;
    case "curve": onCurve(ev); break;
    case "tare": onTare(ev); break;
    case "calres": onCalres(ev); break;
    case "adccalres": onAdccalres(ev); break;
    case "sweep": onSweep(ev); break;
    case "fuse": onFuse(ev); break;
    case "stat": onStat(ev); break;
    case "fe": onFe(ev); break;
    case "ack": onAck(ev); break;
  }
}

// ------------------------------------------------------------------ reset
function resetClient() {
  S.cycles = []; S.byIdx.clear(); S.nextIdx = 0; S.pending = null; S.lastRec = null;
  S.cvals = []; S.markers = []; S.lastActive = null; S.lastMethod = null;
  S.pinned = null; S.seenCycle = false; S.lastCurve = null;
  S.curvesByRange = [[], [], [], []]; S.curveBucket = 2;
  TL.x = []; TL.fused = []; TL.adc = []; TL.osc = [];
  if (capU) capU.setData([[], [], [], []]);
  if (curveU) curveU.setData([[], [], []]);
  $("btnLive").classList.add("hidden");
  renderTimelineNote();
  renderHero(null);
  renderTrust(null);
  renderFusionPanels(null);
  renderCurve(null);
}

// --------------------------------------------------------------- websocket
let ws = null;
function setLink(on, port) {
  S.link = on;
  if (port) S.port = port;
  $("linkDot").classList.toggle("on", on);
  $("linkName").textContent = on ? "connected" : "connecting…";
  $("portName").textContent = S.port || "—";
  $("reconnectBar").classList.toggle("hidden", on);
  checkAlerts();
  renderHero(S.lastRec);
}
function connect() {
  if (ws) { try { ws.close(); } catch (e) {} }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => setLink(false, null);
  ws.onclose = () => { setLink(false, null); checkAlerts(); setTimeout(connect, 1500); };
  ws.onerror = () => {};
  ws.onmessage = (m) => {
    let msg;
    try { msg = JSON.parse(m.data); } catch (e) { return; }
    if (msg.type === "status") setLink(msg.connected, msg.port);
    else if (msg.type === "reset") resetClient();
    else if (msg.type === "event") onEvent(msg.event);
    else if (msg.type === "log") appendLog(msg.line);
  };
}
function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function cmd(c) { send({ type: "cmd", cmd: c }); appendLog("> " + c); }
function calCmd(c) { cmd($("calRange").value); cmd(c); }

// ------------------------------------------------------------------- console
function appendLog(line) {
  const el = $("log");
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

// ---------------------------------------------------------------- recordings
function saveRecordingJson() {
  if (!S.cycles.length) { toast("warn", "Nothing to save", "No cycles recorded yet."); return; }
  const data = {
    app: "ESWCap", view: "precision", generated: new Date().toISOString(),
    port: S.port, running: S.running, ranges: S.ranges, fe: S.fe, stat: S.stat,
    markers: S.markers,
    cycles: S.cycles.map((r) => ({
      idx: r.idx, ts_ms: r.ts_ms, rx_unix_s: r.rx_unix_s, valid: r.valid, c_F: r.c,
      spread: r.spread, quality: r.quality, mismatch_ratio: r.mismatch_ratio,
      adc_F: r.adc, osc_F: r.osc, n_adc: r.n_adc, n_osc: r.n_osc, raw: r.raw,
      sweep: r.sweep, fuse: r.fuse, curve: r.curve,
      samples: (r.samples || []).map((s) => ({
        method: s.method, range: s.range, valid: s.valid, plausible: s.plausible,
        c_F: s.c, q: s.quality, tau_us: s.tau_us, freq: s.freq, period: s.period, r2: s.r2,
      })),
    })),
  };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `eswcap_recording_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast("ok", "Recording saved", `${S.cycles.length} cycles written to JSON.`);
}
function clearRecording() {
  if (!confirm("Clear all recorded telemetry?\n\nThis empties the charts and exports on the host for every connected client. The device is NOT stopped or changed.")) return;
  fetch("/api/clear", { method: "POST" })
    .then(() => { resetClient(); toast("info", "Recording cleared", "Charts and host history reset."); })
    .catch(() => { resetClient(); toast("warn", "Clear partial", "Host clear failed; local view was reset."); });
}

// -------------------------------------------------------------------- wiring
$("btnLive").onclick = resumeLive;
$("avgWindow").onchange = () => { renderHero(S.pinned || S.lastRec); };
$("autoPan").onchange = () => applyXScale();
$("btnReconnect").onclick = () => connect();
$("faultAction").onclick = () => connect();
$("btnSend").onclick = () => { const el = $("cmdInput"); if (el.value.trim()) { cmd(el.value.trim()); el.value = ""; } };
$("cmdInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btnSend").click(); });

// measurement
$("btnStart").onclick = () => cmd("start");
$("btnStop").onclick = () => cmd("stop");
$("btnSingle").onclick = () => cmd("single");
$("mode").onchange = (e) => cmd(e.target.value === "-1" ? "auto" : "range " + e.target.value);

// front-end power (SSR state can apply up to 20 V bias — confirm first)
$("btnPrecharge").onclick = () => {
  const msg = "PRE-CHARGE will apply the external DC bias (up to 20 V) across the DUT " +
    "through SSR1, and clamp V_cap to GND through SSR3.\n\n" +
    "• the DUT stays biased after charging until you press Discharge\n" +
    "• you will not touch or remove the DUT while it is charged\n\nPre-charge now?";
  if (confirm(msg)) { cmd("precharge"); toast("info", "Pre-charge requested", "Watch the front-end state."); }
};
$("btnDischarge").onclick = () => { cmd("discharge"); toast("info", "Discharge requested", "Wait for the front-end confirmation."); };
$("btnIdle").onclick = () => {
  if (confirm("Go IDLE (all SSRs off) WITHOUT discharging?\n\nIf the DUT is charged it may remain biased through R_bias. Prefer Discharge for safety."))
    cmd("idle");
};
$("btnAutoPre").onclick = () => cmd("autoprecharge " + ((S.fe && S.fe.auto_pre) ? "off" : "on"));
$("btnAutoDis").onclick = () => cmd("autodischarge " + ((S.fe && S.fe.auto_dis) ? "off" : "on"));
$("curveChk").onchange = (e) => send({ type: "curve", on: e.target.checked });

// session: save / clear recordings
$("btnSaveCsv").onclick = () => { window.location.href = "/api/export.csv"; };
$("btnSaveJson").onclick = saveRecordingJson;
$("btnClear").onclick = clearRecording;

$("btnTare").onclick = () => calCmd("zero");
$("btnTareAll").onclick = () => cmd("zeroall");
// Both calibration references accept unit suffixes (p / n / u / m / f); they are
// converted to pF before reaching the firmware.
$("btnCalK").onclick = () => {
  const pf = capToPf($("refK").value);
  if (isFinite(pf) && pf > 0) calCmd("cal " + pf);
  else toast("warn", "OSC calibration", "Enter a reference capacitance (e.g. 100p, 1n, 4.7u).");
};
$("btnAdcCal").onclick = () => {
  const pf = capToPf($("adcRef").value);
  if (isFinite(pf) && pf > 0) calCmd("adccal " + pf);
  else toast("warn", "ADC calibration", "Enter a reference capacitance (e.g. 10u, 1u, 1000000).");
};
$("btnCalRefresh").onclick = () => cmd("cal?");

$("panelFusion").addEventListener("toggle", (e) => { if (e.target.open) renderFusionPanels(S.pinned || S.lastRec); });
$("panelCurve").addEventListener("toggle", (e) => {
  if (!e.target.open) return;
  curveU.setSize({ width: $("curveChart").clientWidth || 600, height: 260 });
  renderCurve(S.pinned || S.lastRec);
});

function resizeAll() {
  if (capU) capU.setSize({ width: $("capChart").clientWidth || 600, height: 240 });
  if (curveU && $("panelCurve").open)
    curveU.setSize({ width: $("curveChart").clientWidth || 600, height: 260 });
  renderFusionPanels(S.pinned || S.lastRec);
}
window.addEventListener("resize", resizeAll);

// ---------------------------------------------------------------- stale / init
function stalenessTick() {
  if (S.pinned) return;
  const hv = $("heroValue"), note = $("staleNote");
  if (!S.link) { note.classList.add("hidden"); return; }
  const now = Date.now();
  const age = S.lastEventAt ? (now - S.lastEventAt) / 1000 : null;
  const stopped = S.runKnown && !S.running;
  const stale = !stopped && age != null && (now - S.lastEventAt) > STALE_MS;
  hv.classList.toggle("held", stopped);
  hv.classList.toggle("stale", stale);
  if (stopped) {
    note.classList.remove("hidden");
    note.textContent = "Measurement stopped — last value held";
  } else if (stale) {
    note.classList.remove("hidden");
    note.textContent = `Data is ${Math.round(age)}s old`;
  } else {
    note.classList.add("hidden");
  }
}
setInterval(stalenessTick, 1000);

// -------------------------------------------------------------------- boot
(function init() {
  mountTimeline();
  mountCurve();
  renderTimelineNote();
  renderHero(null);
  renderTrust(null);
  renderFusionPanels(null);
  renderCurve(null);
  renderCurveTabs();
  renderCalGrid();
  renderCalTableText();
  connect();
})();