"use strict";

// ============================================================
// REALTIME INVERTER DASHBOARD — server
// ============================================================

const http = require("http");
const fs = require("fs");
const path = require("path");

// ============================================================
// CONFIG
// ============================================================

const CONFIG_PATH = path.join(__dirname, "config.json");

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  const base = JSON.parse(raw);
  const localPath = path.join(__dirname, "config.local.json");
  if (fs.existsSync(localPath)) {
    const local = JSON.parse(fs.readFileSync(localPath, "utf8"));
    for (const [key, value] of Object.entries(local)) {
      if (
        value && typeof value === "object" && !Array.isArray(value) &&
        base[key] && typeof base[key] === "object" && !Array.isArray(base[key])
      ) {
        base[key] = { ...base[key], ...value };
      } else {
        base[key] = value;
      }
    }
  }
  return base;
}

const config = loadConfig();
const PORT = Number(config.server && config.server.port) || 8787;
const MODE =
  process.argv.includes("--live") ? "growatt" :
  process.argv.includes("--simulate") ? "simulate" :
  String(config.mode || "simulate");

const GROWATT = config.growatt || {};
const BASE_URL = String(GROWATT.baseUrl || "http://test.growatt.com/v1").replace(/\/+$/, "");
const TOKEN = String(GROWATT.token || "");
const DEVICES = Array.isArray(GROWATT.devices) && GROWATT.devices.length
  ? GROWATT.devices.map(String)
  : ["2033022963"];
const POLL_INTERVAL_MS = Number(GROWATT.pollIntervalMs) || 5000;
const EFFECTIVE_POLL_MS = MODE === "growatt" ? Math.max(POLL_INTERVAL_MS, 30000) : POLL_INTERVAL_MS;
const REQUEST_TIMEOUT_MS = Number(GROWATT.requestTimeoutMs) || 10000;
const SIM_DEVICE_COUNT = Number((config.simulate || {}).deviceCount) || 3;

// ============================================================
// STATE
// ============================================================

const HISTORY_MAX = 720;

const state = {
  pollCount: 0,
  lastPollAtMs: 0,
  lastPollOk: false,
  lastError: null,
  devices: new Map(),
};

for (const sn of DEVICES) {
  state.devices.set(sn, { data: null, history: [] });
}

if (MODE === "simulate") {
  for (let i = 0; i < SIM_DEVICE_COUNT; i++) {
    const sn = `SIM${String(i + 1).padStart(10, "0")}`;
    if (!state.devices.has(sn)) state.devices.set(sn, { data: null, history: [] });
  }
}

// ============================================================
// SIMULATOR
// ============================================================

function simulateDevice(sn, nowMs) {
  const now = new Date(nowMs);
  const VIRTUAL_DAY_MS = 12 * 60 * 1000;
  const phase = (nowMs % VIRTUAL_DAY_MS) / VIRTUAL_DAY_MS;
  const hour = 6 + phase * 12;
  const t = (hour - 6) / 12;
  const bell = Math.sin(Math.PI * t);
  const noise = 0.92 + Math.random() * 0.16;
  const ratedW = 3000;
  const ppv = Math.max(0, bell * ratedW * noise);
  const pac = ppv * (0.94 + Math.random() * 0.05);
  const fault = Math.random() < 0.025;
  const sunUp = bell > 0.02;
  const vacr = sunUp ? 228 + Math.random() * 6 : 0;
  const ppv1 = ppv * 0.52;
  const ppv2 = ppv * 0.48;
  const vpv1 = sunUp ? round1(200 + bell * 90 + Math.random() * 10) : 0;
  const vpv2 = sunUp ? round1(190 + bell * 85 + Math.random() * 10) : 0;
  const ipv1 = ppv1 > 0 ? round2(ppv1 / Math.max(vpv1, 1)) : 0;
  const ipv2 = ppv2 > 0 ? round2(ppv2 / Math.max(vpv2, 1)) : 0;
  const iacr = pac > 0 ? round2(pac / Math.max(vacr, 1)) : 0;
  const pf = sunUp ? round2(0.96 + Math.random() * 0.03) : 0;
  const temp = round1(28 + bell * 24 + Math.random() * 3);
  const ipmTemp = round1(temp + 8 + Math.random() * 4);

  return {
    device_sn: sn,
    dataloggerSn: "SIM-DL-" + sn.slice(-4),
    data: {
      status: fault ? 3 : sunUp ? 1 : 0,
      statusText: fault ? "Fault" : sunUp ? "Normal" : "Standby",
      // AC output
      pac: round1(pac),
      vacr: round1(vacr),
      iacr,
      pf,
      fac: round2(49.9 + Math.random() * 0.2),
      // PV input
      ppv: round1(ppv),
      ppv1: round1(ppv1),
      ppv2: round1(ppv2),
      vpv1,
      vpv2,
      ipv1,
      ipv2,
      // Temperature
      temperature: temp,
      ipmTemperature: ipmTemp,
      // Energy
      powerToday: round1((pac * (hour - 6)) / 1000 / 2),
      powerTotal: round1(15234.5 + pac / 5000),
      // Operation
      realOPPercent: sunUp ? Math.round((pac / ratedW) * 100) : 0,
      timeTotal: round1(12450 + (nowMs / 3600000)),
      // Fault/warn
      faultCode: fault ? 102 : 0,
      warnCode: 0,
      time: formatLocal(now),
    },
  };
}

function round1(v) { return Math.round(v * 10) / 10; }
function round2(v) { return Math.round(v * 100) / 100; }

function formatLocal(d) {
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
    " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

// ============================================================
// GROWATT CLIENT
// ============================================================

function fetchWithTimeout(url, options, timeoutMs) {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timeout " + timeoutMs + "ms: " + url)), timeoutMs)
    ),
  ]);
}

async function fetchGrowattLastData(deviceSn) {
  const url = BASE_URL + "/device/inverter/last_new_data?device_sn=" + encodeURIComponent(deviceSn);
  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers: { token: TOKEN, "Accept": "application/json" },
  }, REQUEST_TIMEOUT_MS);
  if (!response.ok) throw new Error("HTTP " + response.status + " dari Growatt");
  const body = await response.json();
  if (Number(body.error_code) !== 0) {
    throw new Error("Growatt error_code " + body.error_code + ": " + (body.error_msg || "?"));
  }
  return {
    device_sn: body.device_sn || deviceSn,
    dataloggerSn: body.dataloggerSn || "",
    data: body.data || {},
  };
}

// ============================================================
// POLL CYCLE
// ============================================================

async function pollCycle() {
  state.pollCount++;
  state.lastPollAtMs = Date.now();
  const sns = Array.from(state.devices.keys());
  const results = await Promise.allSettled(
    sns.map(async (sn) => {
      if (MODE === "growatt") return fetchGrowattLastData(sn);
      await new Promise((r) => setTimeout(r, 5));
      return simulateDevice(sn, Date.now());
    })
  );
  let okCount = 0;
  for (let i = 0; i < sns.length; i++) {
    const sn = sns[i];
    const result = results[i];
    if (result.status === "fulfilled") {
      const entry = state.devices.get(sn);
      entry.data = result.value;
      const pac = Number(result.value.data.pac != null ? result.value.data.pac : result.value.data.power) || 0;
      const ppv = Number(result.value.data.ppv) || 0;
      entry.history.push({ t: Date.now(), pac, ppv });
      if (entry.history.length > HISTORY_MAX) entry.history.shift();
      okCount++;
    } else {
      console.log("⚠️ Poll gagal [" + sn + "]:", String(result.reason && result.reason.message || result.reason));
    }
  }
  state.lastPollOk = okCount > 0;
  state.lastError = okCount === 0 ? "semua device gagal pada poll #" + state.pollCount : null;
  if (state.pollCount % 12 === 0) {
    console.log("📊 Poll #" + state.pollCount + " — " + okCount + "/" + sns.length + " device OK");
  }
  broadcast();
}

// ============================================================
// SSE
// ============================================================

const sseClients = new Set();

function broadcast() {
  if (sseClients.size === 0) return;
  const payload = buildSnapshot();
  const chunk = "data: " + JSON.stringify(payload) + "\n\n";
  for (const res of sseClients) {
    try { res.write(chunk); } catch { sseClients.delete(res); }
  }
}

function buildSnapshot() {
  const devices = [];
  for (const [sn, entry] of state.devices) {
    const raw = entry.data ? entry.data.data : null;
    devices.push({
      sn,
      dataloggerSn: entry.data ? entry.data.dataloggerSn : "",
      online: !!(raw && Date.now() - state.lastPollAtMs < EFFECTIVE_POLL_MS * 4),
      // Status
      status: raw ? raw.status : -1,
      statusText: raw ? raw.statusText || "—" : "MENUNGGU DATA",
      faultCode: num(raw && raw.faultCode),
      warnCode: num(raw && (raw.warnCode ?? raw.warningcode)),
      // AC output
      pac: num(raw && raw.pac),
      vacr: num(raw && raw.vacr),
      iacr: num(raw && raw.iacr),
      pf: num(raw && raw.pf),
      fac: num(raw && raw.fac),
      // PV input
      ppv: num(raw && raw.ppv),
      ppv1: num(raw && raw.ppv1),
      ppv2: num(raw && raw.ppv2),
      vpv1: num(raw && raw.vpv1),
      vpv2: num(raw && raw.vpv2),
      ipv1: num(raw && raw.ipv1),
      ipv2: num(raw && raw.ipv2),
      // Temperature
      temperature: num(raw && raw.temperature),
      ipmTemperature: num(raw && raw.ipmTemperature),
      // Energy
      powerToday: num(raw && (raw.powerToday != null ? raw.powerToday : raw.epv1Today)),
      powerTotal: num(raw && (raw.powerTotal != null ? raw.powerTotal : raw.epv1Total)),
      // Operation
      realOPPercent: num(raw && raw.realOPPercent),
      timeTotal: num(raw && raw.timeTotal),
      time: raw ? raw.time || "" : "",
      history: entry.history.slice(-180),
    });
  }
  const totalPac = devices.reduce((s, d) => s + (d.pac || 0), 0);
  const totalToday = devices.reduce((s, d) => s + (d.powerToday || 0), 0);
  const totalAll = devices.reduce((s, d) => s + (d.powerTotal || 0), 0);
  return {
    mode: MODE,
    pollCount: state.pollCount,
    lastPollAtMs: state.lastPollAtMs,
    lastPollOk: state.lastPollOk,
    lastError: state.lastError,
    serverTime: Date.now(),
    totalPac: Math.round(totalPac * 10) / 10,
    totalToday: Math.round(totalToday * 10) / 10,
    totalAll: Math.round(totalAll * 10) / 10,
    devices,
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

// ============================================================
// HTTP SERVER
// ============================================================

const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write("data: " + JSON.stringify(buildSnapshot()) + "\n\n");
    sseClients.add(res);
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 15000);
    req.on("close", () => { clearInterval(ping); sseClients.delete(res); });
    return;
  }
  if (url.pathname === "/api/snapshot") {
    sendJson(res, 200, buildSnapshot());
    return;
  }
  let filePath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  filePath = path.normalize(path.join(PUBLIC_DIR, filePath));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("404 Not Found"); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(buf);
  });
});

// ============================================================
// START
// ============================================================

server.listen(PORT, () => {
  console.log("");
  console.log("======================================");
  console.log("⚡ REALTIME INVERTER DASHBOARD");
  console.log("======================================");
  console.log("🌐 Dashboard : http://localhost:" + PORT);
  console.log("📡 Mode      : " + MODE + (MODE === "growatt" ? "" : " (tanpa token asli)"));
  console.log("🔌 Device    : " + Array.from(state.devices.keys()).join(", "));
  console.log("⏱️ Poll      : " + EFFECTIVE_POLL_MS + " ms");
  console.log("======================================");
  console.log("");
});

pollCycle().catch((e) => {
  state.lastError = String(e.message || e);
  console.error("❌ Poll pertama gagal:", state.lastError);
});

setInterval(() => {
  pollCycle().catch((e) => {
    state.lastError = String(e.message || e);
    state.lastPollOk = false;
    console.error("❌ Poll gagal:", state.lastError);
  });
}, EFFECTIVE_POLL_MS);

process.on("uncaughtException", (e) => console.error("⚠️ uncaughtException:", e.message));
process.on("unhandledRejection", (e) => console.error("⚠️ unhandledRejection:", e));
