
require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const app = express();
const STATIC_DIR = __dirname;
const INDEX_FILE = path.join(STATIC_DIR, "index.html");

app.use(express.static(STATIC_DIR, { index: false }));
const DATA_DIR = path.join(__dirname, "data");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");

const DATABASE_URL = process.env.DATABASE_URL;
const PORT = Number(process.env.PORT) || 3000;
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS ||
    [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "https://shivamadke1902.github.io",
    ].join(","))
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // Neon requires TLS; this is the common Node setting
    })
  : null;

async function ensureDbSchema() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS energy_daily (
      date_key text PRIMARY KEY,
      energy_kwh double precision NOT NULL DEFAULT 0,
      max_demand_kw double precision NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS energy_samples (
      id bigserial PRIMARY KEY,
      ts timestamptz NOT NULL DEFAULT now(),
      voltage double precision,
      current double precision,
      power_w double precision,
      energy_kwh double precision,
      power_factor double precision
    );
  `);
}

async function dbUpsertDay({ dateKey, energyKwh, maxDemandKw }) {
  if (!pool) return;
  await pool.query(
    `
    INSERT INTO energy_daily (date_key, energy_kwh, max_demand_kw, updated_at)
    VALUES ($1, $2, $3, now())
    ON CONFLICT (date_key)
    DO UPDATE SET
      energy_kwh = EXCLUDED.energy_kwh,
      max_demand_kw = GREATEST(energy_daily.max_demand_kw, EXCLUDED.max_demand_kw),
      updated_at = now();
  `,
    [dateKey, energyKwh, maxDemandKw]
  );
}

async function dbInsertSampleFromSensor() {
  if (!pool) return;
  if (!sensorData || Object.keys(sensorData).length === 0) return;

  const { voltage, current, power, energy, powerFactor } = sensorData;

  await pool.query(
    `
    INSERT INTO energy_samples (ts, voltage, current, power_w, energy_kwh, power_factor)
    VALUES (to_timestamp($1 / 1000.0), $2, $3, $4, $5, $6);
  `,
    [
      sensorData.ts ?? Date.now(),
      clampNumber(voltage),
      clampNumber(current),
      clampNumber(power),
      clampNumber(energy),
      clampNumber(powerFactor),
    ]
  );
}

async function dbReadLast7Days() {
  if (!pool) return null;
  const { rows } = await pool.query(
    `
    SELECT date_key as "dateKey",
           energy_kwh as "energyKwh",
           max_demand_kw as "maxDemandKw"
    FROM energy_daily
    ORDER BY date_key DESC
    LIMIT 7;
  `
  );
  return rows.slice().sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1));
}

// Aggregate last 7 days from the high‑frequency samples table
async function dbReadLast7DaysFromSamples() {
  if (!pool) return null;
  const { rows } = await pool.query(
    `
    SELECT
      to_char(day, 'YYYY-MM-DD') AS "dateKey",
      energy_kwh AS "energyKwh",
      max_demand_kw AS "maxDemandKw"
    FROM (
      SELECT
        date_trunc('day', ts) AS day,
        -- daily energy = max cumulative - min cumulative (safeguarded)
        GREATEST(
          COALESCE(MAX(energy_kwh), 0) - COALESCE(MIN(energy_kwh), 0),
          0
        ) AS energy_kwh,
        -- daily max demand = max power seen that day (kW)
        COALESCE(MAX(power_w), 0) / 1000.0 AS max_demand_kw
      FROM energy_samples
      GROUP BY date_trunc('day', ts)
    ) d
    ORDER BY day DESC
    LIMIT 7;
  `
  );
  return rows.slice().sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1));
}

function dayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function clampNumber(n) {
  const x = typeof n === "number" ? n : Number(n);
  return Number.isFinite(x) ? x : null;
}

function readHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    const raw = fs.readFileSync(HISTORY_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeHistory(history) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), "utf8");
  } catch (e) {
    console.error("Failed to write history:", e.message);
  }
}

let sensorData = {};
let history = readHistory(); // [{ dateKey, energyKwh, maxDemandKw }]
let activeDayKey = dayKey();
let dayStartEnergyKwh = null; // from meter cumulative energy reading at start-of-day
let todayMaxDemandKw = 0;
let lastSampleAtMs = 0;
let lastOutage = null;
let lastOutageDuration = 0;

app.use((req, res, next) => {
  const origin = req.get("origin");
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json());

app.get("/", (req, res) => {
  res.sendFile(INDEX_FILE);
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/data", (req, res) => {
  const data = req.body;

  // Only accept reasonable outage durations (e.g. ignore obviously bad values)
  const rawOutage = Number(data.outageDuration);
  const MAX_OUTAGE_SECONDS = 6 * 60 * 60; // 6 hours
  if (Number.isFinite(rawOutage) && rawOutage > 0 && rawOutage <= MAX_OUTAGE_SECONDS) {
    lastOutage = new Date();
    lastOutageDuration = rawOutage;
  } else if (!rawOutage || rawOutage <= 0) {
    // Reset if device reports no outage
    lastOutage = null;
    lastOutageDuration = 0;
  }

  // helpful when debugging API pushes
  console.log("DATA RECEIVED:", data);

  applyIncomingReading(data);

  res.json({ ok: true });
});

// Reset today's in-memory stats and outage info (does not touch DB history)
app.post("/admin/reset-today", (req, res) => {
  // clear in-memory aggregates
  dayStartEnergyKwh = null;
  todayMaxDemandKw = 0;
  lastOutage = null;
  lastOutageDuration = 0;
  lastSampleAtMs = 0;
  activeDayKey = dayKey(); // reset to today's date

  // also clear the fields that the frontend reads from /data
  sensorData = {
    voltage: null,
    current: null,
    power: null,
    energy: null,
    powerFactor: null,
    todayEnergyKwh: null,
    todayMaxDemandKw: 0,
    todayCost: null,
    ts: null,
  };

  console.log("Admin reset: cleared today's in-memory metrics");
  res.json({ ok: true });
});

// Optional debug endpoint so you can GET the latest reading at /api/data
app.get("/api/data", (req, res) => {
  res.json(sensorData);
});

const COST_PER_KWH = 7;

function rolloverIfNeeded(now = new Date()) {
  const k = dayKey(now);
  if (k === activeDayKey) return;

  // finalize previous day using what we know now
  const prevKey = activeDayKey;
  const energyNow = clampNumber(sensorData?.energy);
  let prevEnergyKwh = null;
  if (dayStartEnergyKwh != null && energyNow != null) {
    prevEnergyKwh = Math.max(0, energyNow - dayStartEnergyKwh);
  }

  if (prevEnergyKwh != null) {
    const existingIdx = history.findIndex((d) => d?.dateKey === prevKey);
    const entry = {
      dateKey: prevKey,
      energyKwh: prevEnergyKwh,
      maxDemandKw: todayMaxDemandKw,
    };
    if (existingIdx >= 0) history[existingIdx] = entry;
    else history.push(entry);

    // keep only last 7 by dateKey
    history = history
      .filter((d) => d && typeof d.dateKey === "string")
      .sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1))
      .slice(-7);
    writeHistory(history);

    // also persist into Neon if configured (best-effort)
    dbUpsertDay(entry).catch((e) => console.error("DB upsert failed:", e.message));
  }

  // reset for new day
  activeDayKey = k;
  dayStartEnergyKwh = clampNumber(sensorData?.energy);
  todayMaxDemandKw = 0;
}

function applyIncomingReading(obj) {
  rolloverIfNeeded(new Date());

  const voltage = clampNumber(obj?.voltage);
  const current = clampNumber(obj?.current);
  const powerW = clampNumber(obj?.power);
  const energyKwh = clampNumber(obj?.energy);
  const powerFactor =
    clampNumber(obj?.powerFactor) ?? clampNumber(obj?.pf) ?? clampNumber(obj?.power_factor);

  if (energyKwh != null && dayStartEnergyKwh == null) {
    dayStartEnergyKwh = energyKwh;
  }

  if (powerW != null) {
    const MAX_REASONABLE_KW = 50; // clamp obviously bogus spikes
    let demandKw = Math.max(0, powerW / 1000);
    if (demandKw > MAX_REASONABLE_KW) demandKw = MAX_REASONABLE_KW;
    if (demandKw > todayMaxDemandKw) todayMaxDemandKw = demandKw;
  }

  const todayEnergyKwh =
    energyKwh != null && dayStartEnergyKwh != null ? Math.max(0, energyKwh - dayStartEnergyKwh) : null;
  const todayCost =
    todayEnergyKwh != null ? todayEnergyKwh * COST_PER_KWH : null;

  sensorData = {
    voltage,
    current,
    power: powerW,
    energy: energyKwh, // cumulative (as received from MCU)
    powerFactor,
    todayEnergyKwh,
    todayMaxDemandKw,
    todayCost,
    ts: Date.now(),
  };

  lastSampleAtMs = Date.now();
}

app.get("/data", (req, res) => {
  res.json({
    ...sensorData,
    lastOutage,
    lastOutageDuration,
  });
});

app.get("/stats/today", (req, res) => {
  res.json({
    dateKey: activeDayKey,
    energyKwh: sensorData?.todayEnergyKwh ?? null,
    maxDemandKw: sensorData?.todayMaxDemandKw ?? 0,
    todayCost: sensorData?.todayCost ?? null,
    ts: sensorData?.ts ?? null,
  });
});

app.get("/stats/week", (req, res) => {
  rolloverIfNeeded(new Date());

  // If Neon is configured, prefer aggregating from high‑frequency samples.
  // Otherwise, fall back to the local history file / daily table.
  (async () => {
    try {
      let src = null;
      if (pool) {
        src = await dbReadLast7DaysFromSamples();
        if (!src || !src.length) {
          src = await dbReadLast7Days();
        }
      } else {
        src = history;
      }

      const merged = Array.isArray(src) ? src.slice() : [];
      // include today's in-memory data only if that date isn't already present
      if (!merged.some((d) => d && d.dateKey === activeDayKey)) {
        merged.push({
          dateKey: activeDayKey,
          energyKwh: sensorData?.todayEnergyKwh ?? null,
          maxDemandKw: sensorData?.todayMaxDemandKw ?? 0,
        });
      }

      const byKey = new Map();
      for (const d of merged) {
        if (!d || typeof d.dateKey !== "string") continue;
        byKey.set(d.dateKey, d);
      }

      const days = Array.from(byKey.values())
        .sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1))
        .slice(-7)
        .map((d) => ({
          dateKey: d.dateKey,
          label: d.dateKey.slice(5),
          energyKwh: clampNumber(d.energyKwh) ?? 0,
          maxDemandKw: clampNumber(d.maxDemandKw) ?? 0,
        }));

      res.json({ days });
    } catch (e) {
      console.error("Failed to build /stats/week from DB:", e.message);
      res.json({ days: [] });
    }
  })();
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});

// Initialize DB (optional) and hydrate in-memory history
(async () => {
  if (!pool) return;
  try {
    await ensureDbSchema();
    const dbHistory = await dbReadLast7Days();
    if (Array.isArray(dbHistory) && dbHistory.length) {
      history = dbHistory.map((d) => ({
        dateKey: d.dateKey,
        energyKwh: clampNumber(d.energyKwh) ?? 0,
        maxDemandKw: clampNumber(d.maxDemandKw) ?? 0,
      }));
      console.log(`Loaded ${history.length} days from Neon.`);
    } else {
      console.log("Neon connected (no history rows yet).");
    }

    // Start periodic sample logging every 2 minutes
    setInterval(() => {
      dbInsertSampleFromSensor().catch((e) => console.error("Failed to insert energy sample:", e.message));
    }, 2 * 60 * 1000);
  } catch (e) {
    console.error("Neon init failed, using file history:", e.message);
  }
})();
