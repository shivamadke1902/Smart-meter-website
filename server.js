
require("dotenv").config();
const express = require("express");
const SerialPort = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const app = express();
app.use(express.static("public")); // folder with index.html, script.js, style.css

const DATA_DIR = path.join(__dirname, "data");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");

const DATABASE_URL = process.env.DATABASE_URL;
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
    const demandKw = Math.max(0, powerW / 1000);
    if (demandKw > todayMaxDemandKw) todayMaxDemandKw = demandKw;
  }

  const todayEnergyKwh =
    energyKwh != null && dayStartEnergyKwh != null ? Math.max(0, energyKwh - dayStartEnergyKwh) : null;

  sensorData = {
    voltage,
    current,
    power: powerW,
    energy: energyKwh, // cumulative (as received from MCU)
    powerFactor,
    todayEnergyKwh,
    todayMaxDemandKw,
    ts: Date.now(),
  };

  lastSampleAtMs = Date.now();
}

// Serial setup (MCU provides readings)
const SERIAL_PATH = process.env.SERIAL_PORT || "COM18";
const SERIAL_BAUD = Number(process.env.SERIAL_BAUD || 9600);

let port = null;
let parser = null;
try {
  port = new SerialPort.SerialPort({ path: SERIAL_PATH, baudRate: SERIAL_BAUD });
  port.on("open", () => {
    console.log(`Serial port opened on ${SERIAL_PATH} at ${SERIAL_BAUD} baud`);
  });
  port.on("error", (err) => {
    console.error("Serial port error:", err.message);
  });
  parser = port.pipe(new ReadlineParser({ delimiter: "\r\n" }));
  parser.on("data", (line) => {
    console.log("RAW from MCU:", JSON.stringify(line));
    try {
      const obj = JSON.parse(line);
      applyIncomingReading(obj);
    } catch (e) {
      console.error("Failed to parse JSON from MCU:", e.message);
    }
  });
} catch (e) {
  console.error("Serial init failed:", e.message);
}

app.get("/data", (req, res) => {
  res.json(sensorData); // frontend expects keys: voltage, current, power, energy
});

app.get("/stats/today", (req, res) => {
  res.json({
    dateKey: activeDayKey,
    energyKwh: sensorData?.todayEnergyKwh ?? null,
    maxDemandKw: sensorData?.todayMaxDemandKw ?? 0,
    ts: sensorData?.ts ?? null,
  });
});

app.get("/stats/week", (req, res) => {
  rolloverIfNeeded(new Date());

  const merged = history.slice();
  // include today so the weekly chart always has current-day data
  merged.push({
    dateKey: activeDayKey,
    energyKwh: sensorData?.todayEnergyKwh ?? null,
    maxDemandKw: sensorData?.todayMaxDemandKw ?? 0,
  });

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
});

app.listen(3000, () => console.log("Server running on http://localhost:3000"));

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
  } catch (e) {
    console.error("Neon init failed, using file history:", e.message);
  }
})();