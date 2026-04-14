const els = {
  voltage: document.getElementById("voltage"),
  current: document.getElementById("current"),
  power: document.getElementById("power"),
  powerFactor: document.getElementById("powerFactor"),
  todayEnergy: document.getElementById("todayEnergy"),
  maxDemand: document.getElementById("maxDemand"),
  todayCost: document.getElementById("todayCost"),
  carbonFootprint: document.getElementById("carbonFootprint"),
  lastOutage: document.getElementById("lastOutage"),
  outageDuration: document.getElementById("outageDuration"),
  statusText: document.getElementById("statusText"),
  statusDot: document.getElementById("statusDot"),
  status: document.querySelector(".status"),
  lastUpdated: document.getElementById("lastUpdated"),
  refreshBtn: document.getElementById("refreshBtn"),
  metricsHint: document.getElementById("metricsHint"),
  todayHint: document.getElementById("todayHint"),
  toast: document.getElementById("toast"),
  chartCanvas: document.getElementById("metricsChart"),
  weekChartCanvas: document.getElementById("weekChart"),
};

const apiBaseMeta = document.querySelector('meta[name="api-base"]');
const configuredApiBase = apiBaseMeta?.content?.trim() || "";
const DEFAULT_API_BASE = "https://smart-meter-website.onrender.com";
const normalizedConfiguredApiBase =
  configuredApiBase && !configuredApiBase.includes("YOUR-RENDER-SERVICE")
    ? configuredApiBase.replace(/\/+$/, "")
    : "";
const localHostApiBase =
  (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") &&
  window.location.port !== "3000"
    ? `${window.location.protocol}//${window.location.hostname}:3000`
    : "";
const API_BASE = normalizedConfiguredApiBase
  ? normalizedConfiguredApiBase
  : localHostApiBase
    ? localHostApiBase
  : window.location.protocol === "file:"
    ? DEFAULT_API_BASE
  : window.location.hostname.endsWith("github.io")
    ? DEFAULT_API_BASE
    : window.location.origin;

// India grid emission factor — Central Electricity Authority 2023-24 report
const CO2_GRAMS_PER_KWH = 0.8;

// Cost per kWh in rupees (must match server.js)
const COST_PER_KWH = 7;

function apiUrl(path) {
  return `${API_BASE}${path}`;
}

function formatDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseOptionalNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function shiftDateKey(dateKey, daysDelta) {
  const [y, m, d] = String(dateKey).split("-").map(Number);
  if (!y || !m || !d) return formatDateKey(new Date());
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + daysDelta);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(
    dt.getUTCDate()
  ).padStart(2, "0")}`;
}

console.log("dashboard script loaded");
let lastOkAt = 0;
let lastReadingTs = 0;
let inFlight = false;
let toastTimer = null;
let metricsChart = null;
let weekChart = null;
let chartLabels = [];
let chartData = [];
let weekLabels = [];
let weekData = [];
let firstErrorShown = false;
let debugTick = 0;
let isStaleReading = false;
const STALE_MS = 7000;
const STALE_ZERO_DELAY_MS = 5000;
let staleSinceMs = null;

// In-memory cache of the last known good Today values.
// Populated from /stats/today on load and kept current by applyData.
// Used to re-render the Today section whenever live data fields are null.
let cachedToday = {
  energyKwh: null,
  maxDemandKw: null,
  cost: null,
  carbonFootprintG: null,
};
let cachedTodayDateKey = null;

function showToast(message) {
  if (!els.toast) return;
  els.toast.hidden = false;
  els.toast.textContent = message;
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    els.toast.hidden = true;
    els.toast.textContent = "";
  }, 3500);
}

function bumpDebug() {
  debugTick += 1;
  if (els.metricsHint) {
    const base = els.metricsHint.textContent || "";
    if (!base.includes("• tick")) els.metricsHint.textContent = `${base} • tick ${debugTick}`.trim();
    else els.metricsHint.textContent = base.replace(/• tick \d+/, `• tick ${debugTick}`);
  }
}

function setStatus(kind, text) {
  els.status?.classList.remove("is-ok", "is-stale", "is-bad");
  if (kind === "ok") els.status?.classList.add("is-ok");
  else if (kind === "stale") els.status?.classList.add("is-stale");
  else if (kind === "bad") els.status?.classList.add("is-bad");
  if (els.statusText) els.statusText.textContent = text;
}

function fmtNumber(value, { maxFrac = 2 } = {}) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: maxFrac }).format(n);
}

function fmtDuration(seconds) {
  const s = typeof seconds === "number" ? seconds : Number(seconds);
  const MAX_OUTAGE_SECONDS = 6 * 60 * 60;
  if (!Number.isFinite(s) || s <= 0 || s > MAX_OUTAGE_SECONDS) return "—";
  if (s < 60) return `${fmtNumber(Math.round(s), { maxFrac: 0 })} sec`;
  if (s < 3600) return `${fmtNumber(s / 60, { maxFrac: 1 })} min`;
  return `${fmtNumber(s / 3600, { maxFrac: 1 })} hr`;
}

function setText(el, text) {
  if (!el) return;
  el.textContent = text;
}

function setLiveMetricsToZero() {
  setText(els.voltage, "0");
  setText(els.current, "0");
  setText(els.power, "0");
  setText(els.powerFactor, "0");
}

function updateLastUpdated(ts) {
  if (!els.lastUpdated) return;
  if (!ts) {
    els.lastUpdated.textContent = "—";
    els.lastUpdated.dateTime = "";
    return;
  }
  const d = new Date(ts);
  els.lastUpdated.textContent = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  els.lastUpdated.dateTime = d.toISOString();
}

// Render the Today section using whichever values are available.
// Priority: live data fields from the polling response > cachedToday from /stats/today.
// This ensures the section is never blank even when the MCU is offline.
function applyTodayMetrics(energyKwh, maxDemandKw, cost, carbonFootprintG) {
  // Resolve: use provided value if valid, else fall back to cache
  const resolvedEnergy   = Number.isFinite(Number(energyKwh))   ? Number(energyKwh)   : cachedToday.energyKwh;
  const resolvedDemand   = Number.isFinite(Number(maxDemandKw))  ? Number(maxDemandKw) : cachedToday.maxDemandKw;

  // Cost: derive from energy if not directly provided (matches server logic)
  let resolvedCost = Number.isFinite(Number(cost)) ? Number(cost) : null;
  if (resolvedCost === null && resolvedEnergy !== null) {
    resolvedCost = resolvedEnergy * COST_PER_KWH;
  }
  if (resolvedCost === null) {
    resolvedCost = cachedToday.cost;
  }

  let resolvedCarbon = Number.isFinite(Number(carbonFootprintG)) ? Number(carbonFootprintG) : null;
  if (resolvedCarbon === null && resolvedEnergy !== null) {
    resolvedCarbon = resolvedEnergy * CO2_GRAMS_PER_KWH;
  }
  if (resolvedCarbon === null) {
    resolvedCarbon = cachedToday.carbonFootprintG;
  }

  // Update cache with whatever we resolved (only overwrite with real values)
  if (Number.isFinite(resolvedEnergy))  cachedToday.energyKwh   = resolvedEnergy;
  if (Number.isFinite(resolvedDemand))  cachedToday.maxDemandKw = resolvedDemand;
  if (Number.isFinite(resolvedCost))    cachedToday.cost        = resolvedCost;
  if (Number.isFinite(resolvedCarbon))  cachedToday.carbonFootprintG = resolvedCarbon;

  setText(els.todayEnergy, fmtNumber(cachedToday.energyKwh,   { maxFrac: 3 }));
  setText(els.maxDemand,   fmtNumber(cachedToday.maxDemandKw, { maxFrac: 3 }));
  setText(els.todayCost,   fmtNumber(cachedToday.cost,        { maxFrac: 2 }));

  // Carbon footprint from DB/cache (fallback derives from energy if missing)
  if (els.carbonFootprint) {
    els.carbonFootprint.textContent =
      cachedToday.carbonFootprintG !== null
        ? fmtNumber(cachedToday.carbonFootprintG, { maxFrac: 3 })
        : "—";
  }
}

function applyData(data, isStale) {
  // Keep Today section cumulative and DB-backed so it survives restart/disconnection.
  applyTodayMetrics(null, null, null, null);

  // Update the Today section hint to indicate data source
  if (els.todayHint) {
    els.todayHint.textContent = isStale
      ? "Showing last known values (MCU offline)"
      : "Energy used and peak demand (today)";
  }

  if (els.lastOutage) {
    els.lastOutage.textContent = data?.lastOutage
      ? new Date(data.lastOutage).toLocaleString()
      : "—";
  }

  if (els.outageDuration) {
    els.outageDuration.textContent = fmtDuration(data?.lastOutageDuration);
  }

  // Live instantaneous fields:
  // - fresh => show real values immediately
  // - stale => wait 5s, then zero out
  if (isStale) {
    if (staleSinceMs === null) staleSinceMs = Date.now();
    const staleForMs = Date.now() - staleSinceMs;
    if (staleForMs >= STALE_ZERO_DELAY_MS) {
      setLiveMetricsToZero();
    }
  } else {
    staleSinceMs = null;
    setText(els.voltage,     fmtNumber(data?.voltage,     { maxFrac: 2 }));
    setText(els.current,     fmtNumber(data?.current,     { maxFrac: 2 }));
    setText(els.power,       fmtNumber(data?.power,       { maxFrac: 1 }));
    setText(els.powerFactor, fmtNumber(data?.powerFactor, { maxFrac: 3 }));
    updateChart(data);
  }
}

function initChart() {
  if (!els.chartCanvas || !window.Chart || metricsChart) return;

  const ctx = els.chartCanvas.getContext("2d");
  metricsChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: chartLabels,
      datasets: [
        {
          label: "Power (W)",
          data: chartData,
          borderColor: "#111111",
          backgroundColor: "rgba(0,0,0,0.04)",
          borderWidth: 1.6,
          tension: 0.2,
          pointRadius: 2,
          pointBackgroundColor: "#111111",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: {
            color: "#111111",
            font: { size: 11 },
          },
        },
        tooltip: {
          mode: "index",
          intersect: false,
          callbacks: {
            title(items) {
              const item = items?.[0];
              return item?.label ?? "";
            },
            label(item) {
              const v = item.parsed.y;
              const value = Number.isFinite(v) ? fmtNumber(v, { maxFrac: 1 }) : "—";
              return `Power: ${value} W`;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: { color: "#555555", maxRotation: 0 },
          grid: { color: "rgba(0,0,0,0.04)" },
        },
        y: {
          ticks: { color: "#555555" },
          grid: { color: "rgba(0,0,0,0.06)" },
        },
      },
    },
  });
}

function initWeekChart() {
  if (!els.weekChartCanvas || !window.Chart || weekChart) return;
  const ctx = els.weekChartCanvas.getContext("2d");
  weekChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: weekLabels,
      datasets: [
        {
          label: "Energy (kWh)",
          data: weekData,
          backgroundColor: "rgba(37, 99, 235, 0.18)",
          borderColor: "rgba(37, 99, 235, 0.9)",
          borderWidth: 1.2,
          borderRadius: 8,
          barPercentage: 0.6,
          categoryPercentage: 0.72,
          maxBarThickness: 34,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: { color: "#111111", font: { size: 11 } },
        },
        tooltip: {
          mode: "index",
          intersect: false,
          callbacks: {
            title(items) {
              const item = items?.[0];
              const label = item?.label ?? "";
              return label ? `Day: ${label}` : "";
            },
            label(item) {
              const v = item.parsed.y;
              const value = Number.isFinite(v) ? fmtNumber(v, { maxFrac: 2 }) : "—";
              return `Energy: ${value} kWh`;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: { color: "#555555", maxRotation: 0 },
          grid: { color: "rgba(0,0,0,0.04)" },
        },
        y: {
          ticks: { color: "#555555" },
          grid: { color: "rgba(0,0,0,0.06)" },
        },
      },
    },
  });
}

function updateChart(data) {
  if (!metricsChart) return;
  const powerValue = Number(data?.power);
  if (!Number.isFinite(powerValue)) return;

  const now = new Date();
  const label = now.toLocaleTimeString([], { minute: "2-digit", second: "2-digit" });

  chartLabels.push(label);
  chartData.push(powerValue);

  const maxPoints = 30;
  if (chartLabels.length > maxPoints) chartLabels.shift();
  if (chartData.length > maxPoints) chartData.shift();

  metricsChart.update("none");
}

async function fetchWeek() {
  try {
    const res = await fetch(apiUrl("/stats/week"), { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    const days = Array.isArray(payload?.days) ? payload.days : [];
    const byKey = new Map();
    for (const d of days) {
      if (!d || typeof d.dateKey !== "string") continue;
      byKey.set(d.dateKey, Number(d?.energyKwh) || 0);
    }

    const todayKey = formatDateKey(new Date());
    let anchorKey = todayKey;
    for (const d of days) {
      if (d?.dateKey && d.dateKey > anchorKey) anchorKey = d.dateKey;
    }

    weekLabels.length = 0;
    weekData.length = 0;
    for (let i = 6; i >= 0; i -= 1) {
      const dateKey = shiftDateKey(anchorKey, -i);
      weekLabels.push(dateKey.slice(5));
      weekData.push(byKey.get(dateKey) ?? 0);
    }
    weekChart?.update("none");
  } catch {
    // silent; weekly view is non-critical
  }
}

// Fetch /stats/today from the server once on page load.
// This primes cachedToday so the Today section shows persisted data
// immediately, even before the MCU sends its first live reading.
async function fetchTodayStats() {
  try {
    const res = await fetch(apiUrl("/stats/today"), { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    const dateKey = typeof data?.dateKey === "string" ? data.dateKey : null;
    const energyKwh = parseOptionalNumber(data?.energyKwh);
    const maxDemandKw = parseOptionalNumber(data?.maxDemandKw);
    const cost = parseOptionalNumber(data?.todayCost);
    const carbonFootprintG = parseOptionalNumber(data?.carbonFootprintG);

    // Keep Today metrics sticky for the current day only.
    // Reset exactly when server day changes.
    if (dateKey && cachedTodayDateKey && dateKey !== cachedTodayDateKey) {
      cachedToday = {
        energyKwh: null,
        maxDemandKw: null,
        cost: null,
        carbonFootprintG: null,
      };
    }
    if (dateKey) cachedTodayDateKey = dateKey;

    const serverLooksAllZero =
      Number.isFinite(energyKwh) &&
      Number.isFinite(maxDemandKw) &&
      Number.isFinite(cost) &&
      Number.isFinite(carbonFootprintG) &&
      energyKwh === 0 &&
      maxDemandKw === 0 &&
      cost === 0 &&
      carbonFootprintG === 0;
    const cacheHasNonZeroForSameDay =
      (Number.isFinite(cachedToday.energyKwh) && cachedToday.energyKwh > 0) ||
      (Number.isFinite(cachedToday.maxDemandKw) && cachedToday.maxDemandKw > 0) ||
      (Number.isFinite(cachedToday.cost) && cachedToday.cost > 0) ||
      (Number.isFinite(cachedToday.carbonFootprintG) && cachedToday.carbonFootprintG > 0);

    // Prevent same-day flicker/reset when backend temporarily serves a zero row.
    if (serverLooksAllZero && cacheHasNonZeroForSameDay) {
      applyTodayMetrics(null, null, null, null);
      return;
    }

    // Keep cache synced with DB-backed /stats/today values
    if (Number.isFinite(energyKwh)) cachedToday.energyKwh = energyKwh;
    if (Number.isFinite(maxDemandKw)) cachedToday.maxDemandKw = maxDemandKw;
    if (Number.isFinite(cost)) {
      cachedToday.cost = cost;
    } else if (Number.isFinite(energyKwh)) {
      cachedToday.cost = energyKwh * COST_PER_KWH;
    }
    if (Number.isFinite(carbonFootprintG)) {
      cachedToday.carbonFootprintG = carbonFootprintG;
    } else if (Number.isFinite(energyKwh)) {
      cachedToday.carbonFootprintG = energyKwh * CO2_GRAMS_PER_KWH;
    }

    // Render immediately with whatever we seeded
    applyTodayMetrics(null, null, null, null);
  } catch {
    // silent; non-critical bootstrap fetch
  }
}

async function fetchOnce({ userInitiated = false } = {}) {
  if (inFlight) return;
  inFlight = true;

  try {
    await fetchTodayStats();

    let res = await fetch(apiUrl("/api/data"), { cache: "no-store" });
    if (!res.ok) {
      res = await fetch(apiUrl("/data"), { cache: "no-store" });
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    bumpDebug();

    let readingTs = Number(data?.ts);
    if (!Number.isFinite(readingTs)) readingTs = 0;

    const ageMs = readingTs > 0 ? Date.now() - readingTs : Number.POSITIVE_INFINITY;

    isStaleReading = Boolean(data?.stale) || ageMs > STALE_MS;
    lastReadingTs = readingTs;

    applyData(data, isStaleReading);

    lastOkAt = Date.now();
    setStatus(isStaleReading ? "stale" : "ok", isStaleReading ? "Stale data" : "Connected");
    updateLastUpdated(readingTs);

    if (els.metricsHint) {
      els.metricsHint.textContent = isStaleReading
        ? "MCU offline — showing stale status"
        : "Live readings";
    }
    if (userInitiated) showToast("Updated.");
  } catch (err) {
    // Fetch failed entirely — zero live metrics but keep Today section intact
    isStaleReading = true;
    setLiveMetricsToZero();

    // Re-render Today from cache so it stays visible even on total fetch failure
    applyTodayMetrics(null, null, null);
    if (els.todayHint) {
      els.todayHint.textContent = "Showing last known values (MCU offline)";
    }

    setStatus("stale", "Stale data");
    const msg = err instanceof Error ? err.message : "Unable to fetch latest reading";
    if (els.metricsHint) {
      els.metricsHint.textContent = msg || "Unable to fetch latest reading";
    }
    if (userInitiated) showToast("Couldn't refresh. Check the server and network.");
    else if (!firstErrorShown) {
      firstErrorShown = true;
      showToast("Disconnected. Check server/network.");
    }
  } finally {
    inFlight = false;
  }
}

function startStaleWatcher() {
  window.setInterval(() => {
    if (!lastReadingTs) return;
    const ageMs = Date.now() - lastReadingTs;
    if (ageMs > STALE_MS && !isStaleReading) {
      isStaleReading = true;
      if (staleSinceMs === null) staleSinceMs = Date.now();
      setStatus("stale", "Stale data");
      // Today section keeps its last rendered values — no action needed
      if (els.todayHint) {
        els.todayHint.textContent = "Showing last known values (MCU offline)";
      }
    }
    if (isStaleReading && staleSinceMs !== null) {
      const staleForMs = Date.now() - staleSinceMs;
      if (staleForMs >= STALE_ZERO_DELAY_MS) {
        setLiveMetricsToZero();
      }
    }
  }, 500);
}

els.refreshBtn?.addEventListener("click", () => fetchOnce({ userInitiated: true }));

// Boot sequence:
// 1. Init charts
// 2. Prime Today cache from /stats/today so values show instantly
// 3. Start live polling
initChart();
initWeekChart();
fetchTodayStats();   // primes cachedToday before first fetchOnce resolves
fetchWeek();
fetchOnce();
window.setInterval(fetchOnce, 2000);
window.setInterval(fetchWeek, 15000);
startStaleWatcher();
