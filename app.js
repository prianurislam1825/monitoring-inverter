"use strict";

// ============================================================
// DASHBOARD CLIENT — konsumsi SSE /api/stream
// ============================================================

const $ = (id) => document.getElementById(id);

const els = {
  clock:         $("clock"),
  led:           $("led"),
  feedText:      $("feed-text"),
  modeLabel:     $("mode-label"),
  totalPac:      $("total-pac"),
  totalPacUnit:  $("total-pac-unit"),
  totalPacMax:   $("total-pac-max"),
  totalToday:    $("total-today"),
  totalAll:      $("total-all"),
  pollCount:     $("poll-count"),
  capacityMeter: $("capacity-meter"),
  capacityText:  $("capacity-text"),
  heroNote:      $("hero-note"),
  rack:          $("rack"),
  chart:         $("power-chart"),
  sbMode:        $("sb-mode"),
  sbPoll:        $("sb-poll"),
  sbError:       $("sb-error"),
  sbClients:     $("sb-clients"),
  onlineCount:   $("online-count"),
};

// ============================================================
// CONSTANTS
// ============================================================

const INSTALLED_CAPACITY_W = 15000;
const cards = new Map();
let peakPac = 0;
let lastServerTime = 0;

// ============================================================
// FORMATTERS
// ============================================================

function fmtW(w) {
  if (w == null) return "—";
  return Math.round(w).toLocaleString("id-ID");
}

function fmtBigW(w) {
  if (w == null) return { value: "—", unit: "W" };
  if (w >= 1000000) return { value: (w / 1000000).toFixed(2), unit: "MW" };
  if (w >= 10000)   return { value: (w / 1000).toFixed(2), unit: "kW" };
  return { value: Math.round(w).toLocaleString("id-ID"), unit: "W" };
}

function fmtKwh(v) {
  if (v == null) return "—";
  return Number(v).toFixed(1) + " kWh";
}

function fmtVal(v, unit, dec) {
  if (v == null) return "—";
  const n = Number(v);
  const d = dec != null ? dec : (Math.abs(n) >= 100 ? 0 : 1);
  return n.toFixed(d) + (unit ? " " + unit : "");
}

function fmtPct(v) {
  if (v == null) return "—";
  return Number(v).toFixed(0) + "%";
}

function fmtHours(v) {
  if (v == null) return "—";
  const h = Math.round(Number(v));
  if (h >= 1000) return (h / 1000).toFixed(1) + " k jam";
  return h.toLocaleString("id-ID") + " jam";
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ============================================================
// CLOCK
// ============================================================

function tickClock() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  els.clock.textContent = p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}
setInterval(tickClock, 1000);
tickClock();

// ============================================================
// STATUS CLASS
// ============================================================

function statusClass(statusText) {
  const t = String(statusText || "").toLowerCase();
  if (t.includes("normal")) return "st-normal";
  if (t.includes("fault") || t.includes("error")) return "st-fault";
  if (t.includes("standby") || t.includes("lost")) return "st-standby";
  return "st-wait";
}

// ============================================================
// BUILD CARD — wide full layout
// ============================================================

function buildCard(dev) {
  const root = document.createElement("article");
  root.className = "inv-card st-wait";

  root.innerHTML = `
    <!-- HEADER -->
    <div class="inv-head">
      <div class="inv-head-left">
        <div class="inv-icon">⚡</div>
        <div>
          <span class="inv-sn">${esc(dev.sn)}</span>
          <span class="inv-dl" data-k="dl">Datalogger: —</span>
        </div>
      </div>
      <div class="inv-head-right">
        <span class="inv-badge"><span class="dot"></span><span class="st-text">MENUNGGU</span></span>
      </div>
    </div>

    <!-- PAC HERO + SPARKLINE -->
    <div class="inv-pac-hero">
      <div class="inv-pac-main">
        <div class="inv-pac-label">OUTPUT DAYA AC SAAT INI</div>
        <div class="inv-pac-value-row">
          <span class="inv-pac-val">0</span>
          <span class="inv-pac-unit">W</span>
        </div>
        <div class="inv-pac-sub">
          PPV Input: <b data-k="ppv-sub">—</b>
          &nbsp;·&nbsp; Power Factor: <b data-k="pf-sub">—</b>
          &nbsp;·&nbsp; Beban: <b data-k="op-sub">—</b>
        </div>
      </div>
      <div class="inv-spark-wrap">
        <div class="inv-spark-label">TREN PAC · 15 MENIT</div>
        <div class="inv-spark"><canvas></canvas></div>
      </div>
    </div>

    <!-- 5 DATA SECTIONS -->
    <div class="inv-sections">

      <div class="inv-section">
        <div class="inv-section-head">
          <span class="inv-section-icon">🔌</span>
          <span class="inv-section-name">AC OUTPUT</span>
        </div>
        <div class="inv-metric">
          <span class="inv-metric-label">Tegangan (VAC)</span>
          <span class="inv-metric-value v-green" data-k="vacr">—</span>
        </div>
        <div class="inv-metric">
          <span class="inv-metric-label">Arus (IAC)</span>
          <span class="inv-metric-value v-green" data-k="iacr">—</span>
        </div>
        <div class="inv-metric">
          <span class="inv-metric-label">Frekuensi Grid</span>
          <span class="inv-metric-value" data-k="fac">—</span>
        </div>
        <div class="inv-metric">
          <span class="inv-metric-label">Power Factor</span>
          <span class="inv-metric-value v-blue" data-k="pf">—</span>
        </div>
      </div>

      <div class="inv-section">
        <div class="inv-section-head">
          <span class="inv-section-icon">☀️</span>
          <span class="inv-section-name">PV INPUT (DC)</span>
        </div>
        <div class="inv-metric">
          <span class="inv-metric-label">PPV Total</span>
          <span class="inv-metric-value v-amber" data-k="ppv">—</span>
        </div>
        <div class="inv-metric">
          <span class="inv-metric-label">PPV1 / PPV2</span>
          <span class="inv-metric-value v-dim" data-k="ppv12">—</span>
        </div>
        <div class="inv-metric">
          <span class="inv-metric-label">VPV1 / VPV2</span>
          <span class="inv-metric-value" data-k="vpv">—</span>
        </div>
        <div class="inv-metric">
          <span class="inv-metric-label">IPV1 / IPV2</span>
          <span class="inv-metric-value" data-k="ipv">—</span>
        </div>
      </div>

      <div class="inv-section">
        <div class="inv-section-head">
          <span class="inv-section-icon">🌡️</span>
          <span class="inv-section-name">THERMAL</span>
        </div>
        <div class="inv-metric">
          <span class="inv-metric-label">Suhu Inverter</span>
          <span class="inv-metric-value v-amber" data-k="temp">—</span>
        </div>
        <div class="inv-metric">
          <span class="inv-metric-label">Suhu Modul IPM</span>
          <span class="inv-metric-value" data-k="itemp">—</span>
        </div>
      </div>

      <div class="inv-section">
        <div class="inv-section-head">
          <span class="inv-section-icon">📈</span>
          <span class="inv-section-name">ENERGI</span>
        </div>
        <div class="inv-metric">
          <span class="inv-metric-label">Produksi Hari Ini</span>
          <span class="inv-metric-value v-green" data-k="etoday">—</span>
        </div>
        <div class="inv-metric">
          <span class="inv-metric-label">Total Lifetime</span>
          <span class="inv-metric-value v-blue" data-k="etotal">—</span>
        </div>
      </div>

      <div class="inv-section">
        <div class="inv-section-head">
          <span class="inv-section-icon">⚙️</span>
          <span class="inv-section-name">OPERASI</span>
        </div>
        <div class="inv-metric">
          <span class="inv-metric-label">Beban Kapasitas</span>
          <span class="inv-metric-value v-purple" data-k="opPct">—</span>
        </div>
        <div class="inv-metric">
          <span class="inv-metric-label">Total Jam Operasi</span>
          <span class="inv-metric-value" data-k="hours">—</span>
        </div>
        <div class="inv-metric">
          <span class="inv-metric-label">Fault Code</span>
          <span class="inv-metric-value v-dim" data-k="faultCode">—</span>
        </div>
        <div class="inv-metric">
          <span class="inv-metric-label">Warn Code</span>
          <span class="inv-metric-value v-dim" data-k="warnCode">—</span>
        </div>
      </div>

    </div>

    <!-- FOOTER -->
    <div class="inv-foot">
      <span class="foot-tag"><span class="foot-tag-icon">📡</span><span data-k="dl-foot">DL —</span></span>
      <span class="foot-tag" data-k="status-tag">— STATUS</span>
      <span class="foot-time" data-k="time">—</span>
    </div>
  `;

  const canvas = root.querySelector("canvas");
  const q = (sel) => root.querySelector(sel);

  const refs = {
    root,
    stText:    q(".st-text"),
    pacVal:    q(".inv-pac-val"),
    ppvSub:    q('[data-k="ppv-sub"]'),
    pfSub:     q('[data-k="pf-sub"]'),
    opSub:     q('[data-k="op-sub"]'),
    vacr:      q('[data-k="vacr"]'),
    iacr:      q('[data-k="iacr"]'),
    fac:       q('[data-k="fac"]'),
    pf:        q('[data-k="pf"]'),
    ppv:       q('[data-k="ppv"]'),
    ppv12:     q('[data-k="ppv12"]'),
    vpv:       q('[data-k="vpv"]'),
    ipv:       q('[data-k="ipv"]'),
    temp:      q('[data-k="temp"]'),
    itemp:     q('[data-k="itemp"]'),
    etoday:    q('[data-k="etoday"]'),
    etotal:    q('[data-k="etotal"]'),
    opPct:     q('[data-k="opPct"]'),
    hours:     q('[data-k="hours"]'),
    faultCode: q('[data-k="faultCode"]'),
    warnCode:  q('[data-k="warnCode"]'),
    dl:        q('[data-k="dl"]'),
    dlFoot:    q('[data-k="dl-foot"]'),
    statusTag: q('[data-k="status-tag"]'),
    time:      q('[data-k="time"]'),
    canvas,
    ctx: canvas.getContext("2d"),
  };

  els.rack.appendChild(root);
  return refs;
}

// ============================================================
// UPDATE CARD
// ============================================================

function updateCard(dev) {
  let refs = cards.get(dev.sn);
  if (!refs) { refs = buildCard(dev); cards.set(dev.sn, refs); }

  refs.root.className = "inv-card " + statusClass(dev.statusText) + (dev.online ? "" : " st-wait");
  refs.stText.textContent = dev.online ? String(dev.statusText || "—").toUpperCase() : "OFFLINE";
  refs.pacVal.textContent = fmtW(dev.pac);

  // PAC subline
  refs.ppvSub.textContent = fmtVal(dev.ppv, "W");
  refs.pfSub.textContent  = dev.pf != null ? fmtVal(dev.pf, "", 3) : "—";
  refs.opSub.textContent  = fmtPct(dev.realOPPercent);

  // AC Output
  refs.vacr.textContent = fmtVal(dev.vacr, "V");
  refs.iacr.textContent = fmtVal(dev.iacr, "A");
  refs.fac.textContent  = fmtVal(dev.fac, "Hz");
  refs.pf.textContent   = dev.pf != null ? fmtVal(dev.pf, "", 3) : "—";

  // PV Input
  refs.ppv.textContent   = fmtVal(dev.ppv, "W");
  refs.ppv12.textContent = dev.ppv1 != null
    ? fmtVal(dev.ppv1, "W") + " / " + fmtVal(dev.ppv2, "W") : "—";
  refs.vpv.textContent   = dev.vpv1 != null
    ? fmtVal(dev.vpv1, "V") + " / " + fmtVal(dev.vpv2, "V") : "—";
  refs.ipv.textContent   = dev.ipv1 != null
    ? fmtVal(dev.ipv1, "A") + " / " + fmtVal(dev.ipv2, "A") : "—";

  // Thermal
  refs.temp.textContent  = fmtVal(dev.temperature, "°C");
  refs.itemp.textContent = fmtVal(dev.ipmTemperature, "°C");

  // Energy
  refs.etoday.textContent = fmtKwh(dev.powerToday);
  refs.etotal.textContent = fmtKwh(dev.powerTotal);

  // Operation
  refs.opPct.textContent = fmtPct(dev.realOPPercent);
  refs.hours.textContent = fmtHours(dev.timeTotal);

  const hasFault = dev.faultCode && dev.faultCode !== 0;
  refs.faultCode.textContent = hasFault ? "⚠️ #" + dev.faultCode : "OK";
  refs.faultCode.className   = "inv-metric-value" + (hasFault ? " v-red" : " v-dim");

  const hasWarn = dev.warnCode && dev.warnCode !== 0;
  refs.warnCode.textContent = hasWarn ? "⚠️ #" + dev.warnCode : "OK";
  refs.warnCode.className   = "inv-metric-value" + (hasWarn ? " v-amber" : " v-dim");

  // Footer & header DL
  const dlTxt = "Datalogger: " + (dev.dataloggerSn || "—");
  refs.dl.textContent       = dlTxt;
  refs.dlFoot.textContent   = "DL: " + (dev.dataloggerSn || "—");
  refs.statusTag.textContent = dev.online ? "🟢 ONLINE" : "🔴 OFFLINE";
  refs.time.textContent     = dev.time ? "⏱ " + dev.time : "—";

  drawSpark(refs, dev.history || []);
}

// ============================================================
// SPARKLINE
// ============================================================

function drawSpark(refs, history) {
  const { canvas, ctx } = refs;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(rect.width, 10);
  const h = Math.max(rect.height, 10);
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!history || history.length < 2) return;

  const pts = history.slice(-90);
  const max = Math.max(...pts.map((p) => p.pac || 0), 100);
  const isFault = refs.root.classList.contains("st-fault");
  const color = isFault ? "#f87171" : "#22d3a0";

  // Grid lines
  ctx.strokeStyle = "rgba(30,37,53,0.6)";
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = (i / 4) * h;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  // Line
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const x = (i / (pts.length - 1)) * w;
    const y = h - ((pts[i].pac || 0) / max) * (h - 4) - 2;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Area
  ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, isFault ? "rgba(248,113,113,0.2)" : "rgba(34,211,160,0.2)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grad;
  ctx.fill();

  // Last dot
  const last = pts[pts.length - 1];
  const lx = w;
  const ly = h - ((last.pac || 0) / max) * (h - 4) - 2;
  ctx.beginPath();
  ctx.arc(lx - 2, ly, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

// ============================================================
// MAIN CHART
// ============================================================

function drawMainChart(devices) {
  const canvas = els.chart;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(rect.width, 10);
  const h = Math.max(rect.height, 10);
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // Grid
  ctx.strokeStyle = "rgba(30,37,53,0.8)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = (i / 4) * h;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  const maps = devices.map((d) => ({ hist: d.history || [] }));
  const maxLen = Math.max(1, ...maps.map((m) => m.hist.length));
  if (maxLen < 2) {
    ctx.fillStyle = "rgba(107,127,160,0.5)";
    ctx.font = "12px 'JetBrains Mono', monospace";
    ctx.fillText("menunggu data kurva…", 12, h / 2);
    return;
  }

  const base = maps.reduce((a, b) => b.hist.length > a.hist.length ? b : a).hist;
  const series = [];
  for (let i = 0; i < base.length; i++) {
    const t = base[i].t;
    let pac = 0, ppv = 0;
    for (const m of maps) {
      const p = m.hist.find((q) => Math.abs(q.t - t) < 4000);
      if (p) { pac += p.pac || 0; ppv += p.ppv || 0; }
    }
    series.push({ t, pac, ppv });
  }

  const max = Math.max(...series.map((s) => Math.max(s.pac, s.ppv)), 500);
  const t0 = series[0].t;
  const t1 = series[series.length - 1].t || t0 + 1;
  const X = (t) => ((t - t0) / Math.max(t1 - t0, 1)) * (w - 8) + 4;
  const Y = (v) => h - (v / max) * (h - 16) - 6;

  ctx.fillStyle = "rgba(107,127,160,0.6)";
  ctx.font = "10px 'JetBrains Mono', monospace";
  ctx.fillText(Math.round(max) + " W", 6, 13);

  // PPV dashed
  ctx.beginPath();
  series.forEach((s, i) => {
    if (i === 0) ctx.moveTo(X(s.t), Y(s.ppv)); else ctx.lineTo(X(s.t), Y(s.ppv));
  });
  ctx.strokeStyle = "#f59e0b"; ctx.lineWidth = 1.4;
  ctx.setLineDash([5, 4]); ctx.stroke(); ctx.setLineDash([]);

  // PAC + area
  ctx.beginPath();
  series.forEach((s, i) => {
    if (i === 0) ctx.moveTo(X(s.t), Y(s.pac)); else ctx.lineTo(X(s.t), Y(s.pac));
  });
  ctx.strokeStyle = "#22d3a0"; ctx.lineWidth = 2; ctx.stroke();

  ctx.lineTo(X(t1), h); ctx.lineTo(X(t0), h); ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "rgba(34,211,160,0.2)");
  grad.addColorStop(1, "rgba(34,211,160,0)");
  ctx.fillStyle = grad; ctx.fill();

  // Last dot
  const last = series[series.length - 1];
  ctx.beginPath();
  ctx.arc(X(last.t), Y(last.pac), 3.5, 0, Math.PI * 2);
  ctx.fillStyle = "#22d3a0"; ctx.fill();
  ctx.strokeStyle = "#080a0f"; ctx.lineWidth = 1.5; ctx.stroke();
}

// ============================================================
// APPLY SNAPSHOT
// ============================================================

function applySnapshot(snap) {
  lastServerTime = snap.serverTime;

  setFeed(true, "LIVE · " + snap.mode.toUpperCase());
  els.modeLabel.textContent = snap.mode === "growatt" ? "GROWATT API" : "MODE SIMULASI";
  els.sbMode.textContent    = "MODE " + snap.mode.toUpperCase();
  els.sbPoll.textContent    = "POLL #" + snap.pollCount + " · " + new Date(snap.lastPollAtMs).toLocaleTimeString();
  els.sbError.textContent   = snap.lastError ? "ERR: " + snap.lastError : "";
  els.pollCount.textContent = "#" + snap.pollCount;

  // Total PAC
  const total = snap.totalPac || 0;
  const big = fmtBigW(total);
  peakPac = Math.max(peakPac, total);
  els.totalPac.textContent     = big.value;
  els.totalPacUnit.textContent = big.unit;
  els.totalPac.classList.toggle("night", total < 5);
  els.totalPacMax.textContent  = Math.round(peakPac) + " W";

  els.totalToday.textContent = fmtKwh(snap.totalToday);
  els.totalAll.textContent   = fmtKwh(snap.totalAll);

  const pct = Math.min(100, (total / INSTALLED_CAPACITY_W) * 100);
  els.capacityMeter.style.width = pct.toFixed(1) + "%";
  els.capacityText.textContent  = pct.toFixed(0) + "%";

  const onlineDevs = snap.devices.filter((d) => d.online);
  if (els.onlineCount) {
    els.onlineCount.textContent = onlineDevs.length + " / " + snap.devices.length + " online";
  }

  if (snap.lastError) {
    els.heroNote.textContent = "⚠️ " + snap.lastError;
  } else if (total < 5) {
    els.heroNote.textContent = "Output nol — inverter standby atau belum ada data telemetry.";
  } else {
    els.heroNote.textContent =
      "Sistem aktif memproduksi " + big.value + " " + big.unit +
      " dari " + onlineDevs.length + " inverter online." +
      (snap.totalToday ? " Produksi hari ini: " + fmtKwh(snap.totalToday) + "." : "");
  }

  for (const dev of snap.devices) updateCard(dev);
  drawMainChart(snap.devices);
}

// ============================================================
// SSE + FALLBACK POLLING (VERCEL SERVERLESS COMPATIBLE)
// ============================================================

let sse = null;
let fallbackTimer = null;
let consecutiveErrors = 0;

function setFeed(ok, text) {
  els.led.className = "led " + (ok ? "ok" : "err");
  els.feedText.textContent = text;
}

async function fetchSnapshot() {
  try {
    const res = await fetch("/api/snapshot");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    consecutiveErrors = 0;
    applySnapshot(data);
    return true;
  } catch (err) {
    consecutiveErrors++;
    if (consecutiveErrors >= 2) {
      setFeed(false, "KONEKSI TERPUTUS");
    }
    return false;
  }
}

function startFallbackPolling() {
  if (fallbackTimer) return;
  fetchSnapshot();
  fallbackTimer = setInterval(fetchSnapshot, 3500);
}

function stopFallbackPolling() {
  if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
}

function connectSSE() {
  try { sse = new EventSource("/api/stream"); }
  catch { startFallbackPolling(); return; }

  sse.onopen = () => {
    consecutiveErrors = 0;
    setFeed(true, "LIVE");
  };

  sse.onmessage = (ev) => {
    try {
      const snap = JSON.parse(ev.data);
      consecutiveErrors = 0;
      applySnapshot(snap);
    } catch {}
  };

  sse.onerror = () => {
    // On Vercel, serverless streams end after a few seconds.
    // Gracefully fallback to polling immediately without showing scary error.
    if (sse) {
      sse.close();
      sse = null;
    }
    startFallbackPolling();
    setTimeout(connectSSE, 6000);
  };
}

// 1. Ambil data instan pertama kali (0ms delay)
fetchSnapshot();

// 2. Aktifkan koneksi realtime
connectSSE();

els.sbClients.textContent = "VERCEL · REALTIME AKTIF";

