"use strict";

const fs = require("fs");
const path = require("path");

// In-memory cache across warm serverless function invocations
let cachedSnapshot = null;
let lastCacheTime = 0;
let pollCounter = 0;

function getConfig() {
  let base = {
    mode: "simulate",
    growatt: {
      baseUrl: "http://openapi.growatt.com/v1",
      token: "",
      devices: ["NUEICLS03V"],
      requestTimeoutMs: 12000
    },
    simulate: {
      deviceCount: 4
    }
  };

  const configPath = path.join(process.cwd(), "config.json");
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
      base = { ...base, ...parsed };
      if (parsed.growatt) base.growatt = { ...base.growatt, ...parsed.growatt };
    } catch {}
  }

  const localPath = path.join(process.cwd(), "config.local.json");
  if (fs.existsSync(localPath)) {
    try {
      const local = JSON.parse(fs.readFileSync(localPath, "utf8"));
      base = { ...base, ...local };
      if (local.growatt) base.growatt = { ...base.growatt, ...local.growatt };
    } catch {}
  }

  // Environment variables override (for Vercel dashboard settings)
  if (process.env.MODE) base.mode = process.env.MODE;
  if (process.env.GROWATT_TOKEN) {
    base.growatt.token = process.env.GROWATT_TOKEN;
  }
  if (process.env.GROWATT_BASE_URL) {
    base.growatt.baseUrl = process.env.GROWATT_BASE_URL;
  }
  if (process.env.GROWATT_DEVICES) {
    base.growatt.devices = process.env.GROWATT_DEVICES.split(",").map((s) => s.trim());
  }

  return base;
}

function round1(v) { return Math.round(v * 10) / 10; }
function round2(v) { return Math.round(v * 100) / 100; }

function formatLocal(d) {
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
    " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

function generateSimHistory(nowMs, pointsCount = 30) {
  const history = [];
  const stepMs = 30000;
  const VIRTUAL_DAY_MS = 12 * 60 * 1000;
  const ratedW = 3000;

  for (let i = pointsCount - 1; i >= 0; i--) {
    const ptTime = nowMs - (i * stepMs);
    const phase = (ptTime % VIRTUAL_DAY_MS) / VIRTUAL_DAY_MS;
    const hour = 6 + phase * 12;
    const t = (hour - 6) / 12;
    const bell = Math.sin(Math.PI * t);
    const ppv = Math.max(0, bell * ratedW);
    const pac = ppv * 0.95;
    history.push({
      t: ptTime,
      pac: round1(pac),
      ppv: round1(ppv)
    });
  }
  return history;
}

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
    sn,
    dataloggerSn: "SIM-DL-" + sn.slice(-4),
    online: true,
    status: sunUp ? 1 : 0,
    statusText: sunUp ? "Normal" : "Standby",
    faultCode: 0,
    warnCode: 0,
    pac: round1(pac),
    vacr: round1(vacr),
    iacr,
    pf,
    fac: round2(49.9 + Math.random() * 0.2),
    ppv: round1(ppv),
    ppv1: round1(ppv1),
    ppv2: round1(ppv2),
    vpv1,
    vpv2,
    ipv1,
    ipv2,
    temperature: temp,
    ipmTemperature: ipmTemp,
    powerToday: round1((pac * (hour - 6)) / 1000 / 2),
    powerTotal: round1(15234.5 + pac / 5000),
    realOPPercent: sunUp ? Math.round((pac / ratedW) * 100) : 0,
    timeTotal: round1(12450 + (nowMs / 3600000)),
    time: formatLocal(now),
    history: generateSimHistory(nowMs, 30)
  };
}

async function fetchGrowatt(baseUrl, token, deviceSn, timeoutMs = 12000) {
  const url = baseUrl.replace(/\/+$/, "") + "/device/inverter/last_new_data?device_sn=" + encodeURIComponent(deviceSn);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { token, Accept: "application/json" },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const body = await res.json();
    if (Number(body.error_code) !== 0) {
      throw new Error("Growatt code " + body.error_code + ": " + (body.error_msg || "?"));
    }
    return {
      device_sn: body.device_sn || deviceSn,
      dataloggerSn: body.dataloggerSn || "",
      data: body.data || {}
    };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

async function buildSnapshot() {
  const config = getConfig();
  const mode = config.mode || "simulate";
  const now = Date.now();
  pollCounter++;

  // Caching: prevent frequent polling from hitting rate limits
  const cacheTtlMs = mode === "growatt" ? 25000 : 2000;
  if (cachedSnapshot && (now - lastCacheTime < cacheTtlMs)) {
    return {
      ...cachedSnapshot,
      pollCount: pollCounter,
      serverTime: now
    };
  }

  let devices = [];
  let lastError = null;

  if (mode === "growatt" && config.growatt && config.growatt.token) {
    const sns = config.growatt.devices || ["NUEICLS03V"];
    const results = await Promise.allSettled(
      sns.map((sn) => fetchGrowatt(config.growatt.baseUrl, config.growatt.token, sn, config.growatt.requestTimeoutMs))
    );

    devices = sns.map((sn, idx) => {
      const res = results[idx];
      if (res.status === "fulfilled") {
        const raw = res.value.data || {};
        return {
          sn,
          dataloggerSn: res.value.dataloggerSn || "",
          online: true,
          status: raw.status != null ? raw.status : 1,
          statusText: raw.statusText || "Normal",
          faultCode: num(raw.faultCode),
          warnCode: num(raw.warnCode ?? raw.warningcode),
          pac: num(raw.pac ?? raw.power),
          vacr: num(raw.vacr),
          iacr: num(raw.iacr),
          pf: num(raw.pf),
          fac: num(raw.fac),
          ppv: num(raw.ppv),
          ppv1: num(raw.ppv1),
          ppv2: num(raw.ppv2),
          vpv1: num(raw.vpv1),
          vpv2: num(raw.vpv2),
          ipv1: num(raw.ipv1),
          ipv2: num(raw.ipv2),
          temperature: num(raw.temperature),
          ipmTemperature: num(raw.ipmTemperature),
          powerToday: num(raw.powerToday ?? raw.epv1Today),
          powerTotal: num(raw.powerTotal ?? raw.epv1Total),
          realOPPercent: num(raw.realOPPercent),
          timeTotal: num(raw.timeTotal),
          time: raw.time || "",
          history: generateSimHistory(now, 30)
        };
      } else {
        lastError = res.reason ? res.reason.message : "Fetch gagal";
        // fallback to simulation on error so dashboard doesn't break
        const sim = simulateDevice(sn, now);
        sim.online = false;
        sim.statusText = "OFFLINE";
        return sim;
      }
    });
  } else {
    // Mode simulate
    const count = (config.simulate && config.simulate.deviceCount) || 4;
    const simSns = ["NUEICLS03V"];
    for (let i = 1; i < count; i++) {
      simSns.push(`SIM${String(i).padStart(10, "0")}`);
    }
    devices = simSns.map((sn) => simulateDevice(sn, now));
  }

  const totalPac = devices.reduce((s, d) => s + (d.pac || 0), 0);
  const totalToday = devices.reduce((s, d) => s + (d.powerToday || 0), 0);
  const totalAll = devices.reduce((s, d) => s + (d.powerTotal || 0), 0);

  const snapshot = {
    mode,
    pollCount: pollCounter,
    lastPollAtMs: now,
    lastPollOk: !lastError,
    lastError,
    serverTime: now,
    totalPac: Math.round(totalPac * 10) / 10,
    totalToday: Math.round(totalToday * 10) / 10,
    totalAll: Math.round(totalAll * 10) / 10,
    devices
  };

  cachedSnapshot = snapshot;
  lastCacheTime = now;
  return snapshot;
}

module.exports = async function handler(req, res) {
  try {
    const snapshot = await buildSnapshot();
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json(snapshot);
  } catch (err) {
    res.status(500).json({ error: err.message || "Internal server error" });
  }
};

module.exports.buildSnapshot = buildSnapshot;
