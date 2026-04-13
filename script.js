const els = {
  voltage: document.getElementById("voltage"),
  current: document.getElementById("current"),
  power: document.getElementById("power"),
  powerFactor: document.getElementById("powerFactor"),
  todayEnergy: document.getElementById("todayEnergy"),
  maxDemand: document.getElementById("maxDemand"),
  todayCost: document.getElementById("todayCost"),
  lastOutage: document.getElementById("lastOutage"),
  outageDuration: document.getElementById("outageDuration"),
  statusText: document.getElementById("statusText"),
  statusDot: document.getElementById("statusDot"),
  status: document.querySelector(".status"),
  lastUpdated: document.getElementById("lastUpdated"),
  refreshBtn: document.getElementById("refreshBtn"),
  metricsHint: document.getElementById("metricsHint"),
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

function apiUrl(path) {
  return `${API_BASE}${path}`;
}

function formatDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
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

  // Visible proof that JS is running (updates every fetch)
  function bumpDebug() {
    debugTick += 1;
    if (els.metricsHint) {
      const base = els.metricsHint.textContent || "";
      // Keep it short; just shows activity count.
      if (!base.includes("• tick")) els.metricsHint.textContent = `${base} • tick ${debugTick}`.trim();
      else els.metricsHint.textContent = base.replace(/• tick \d+/, `• tick ${debugTick}`);
    }
  }
  
  function setStatus(kind, text) {
    // kind: ok | stale | bad
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
    const MAX_OUTAGE_SECONDS = 6 * 60 * 60; // keep in sync with server
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
    setText(els.todayEnergy, "0");
    setText(els.maxDemand, "0");
    setText(els.todayCost, "0");
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
  
  function applyData(data) {
    setText(els.voltage, fmtNumber(data?.voltage, { maxFrac: 2 }));
    setText(els.current, fmtNumber(data?.current, { maxFrac: 2 }));
    setText(els.power, fmtNumber(data?.power, { maxFrac: 1 }));
    setText(els.powerFactor, fmtNumber(data?.powerFactor, { maxFrac: 3 }));
    setText(els.todayEnergy, fmtNumber(data?.todayEnergyKwh, { maxFrac: 3 }));
    setText(els.maxDemand, fmtNumber(data?.todayMaxDemandKw, { maxFrac: 3 }));

    if (els.todayCost && data?.todayCost != null) {
      els.todayCost.textContent = fmtNumber(data.todayCost, { maxFrac: 2 });
    }

    if (els.lastOutage) {
      if (data?.lastOutage) {
        const d = new Date(data.lastOutage);
        els.lastOutage.textContent = d.toLocaleString();
      } else {
        els.lastOutage.textContent = "—";
      }
    }

    if (els.outageDuration) {
      const dur = data?.lastOutageDuration;
      els.outageDuration.textContent = fmtDuration(dur);
    }

    updateChart(data);
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

  async function fetchOnce({ userInitiated = false } = {}) {
    if (inFlight) return;
    inFlight = true;
  
    try {
      // Prefer /api/data to avoid collisions with static /data directories.
      let res = await fetch(apiUrl("/api/data"), { cache: "no-store" });
      if (!res.ok) {
        // Backward compatibility for older deployments that only expose /data.
        res = await fetch(apiUrl("/data"), { cache: "no-store" });
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      bumpDebug();

      let readingTs = Number(data?.ts);
      if (!Number.isFinite(readingTs)) {
        // Fallback to "now" if backend didn't send a proper timestamp
        readingTs = Date.now();
      }

      lastReadingTs = readingTs;
      applyData(data);

      lastOkAt = Date.now();
      setStatus("ok", "Connected");
      updateLastUpdated(readingTs);
      if (els.metricsHint) els.metricsHint.textContent = "Live readings";
      if (userInitiated) showToast("Updated.");
    } catch (err) {
      // Keep previous values, but reflect state clearly.
      setStatus("bad", "Disconnected");
      setLiveMetricsToZero();
      const msg = err instanceof Error ? err.message : "Unable to fetch latest reading";
      if (els.metricsHint) {
        const needsApiBase =
          window.location.hostname.endsWith("github.io") && API_BASE === window.location.origin;
        els.metricsHint.textContent = needsApiBase
          ? "Set your Render API URL in the api-base meta tag."
          : msg || "Unable to fetch latest reading";
      }
      if (userInitiated) showToast("Couldn’t refresh. Check the server and network.");
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
      if (ageMs > 7000) {
        setStatus("stale", "Stale data");
        setLiveMetricsToZero();
      }
      else setStatus("ok", "Connected");
    }, 1000);
  }
  
  els.refreshBtn?.addEventListener("click", () => fetchOnce({ userInitiated: true }));
  
  // Initial load + polling
  initChart();
  initWeekChart();
  fetchWeek();
  fetchOnce();
  window.setInterval(fetchOnce, 2000);
  window.setInterval(fetchWeek, 15000);
  startStaleWatcher();


