const els = {
    voltage: document.getElementById("voltage"),
    current: document.getElementById("current"),
    power: document.getElementById("power"),
    powerFactor: document.getElementById("powerFactor"),
    todayEnergy: document.getElementById("todayEnergy"),
    maxDemand: document.getElementById("maxDemand"),
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
  
  let lastOkAt = 0;
  let inFlight = false;
  let toastTimer = null;
  let metricsChart = null;
  let weekChart = null;
  let chartLabels = [];
  let chartData = [];
  let weekLabels = [];
  let weekData = [];
  
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
    els.voltage.textContent = fmtNumber(data?.voltage, { maxFrac: 2 });
    els.current.textContent = fmtNumber(data?.current, { maxFrac: 2 });
    els.power.textContent = fmtNumber(data?.power, { maxFrac: 1 });
    if (els.powerFactor) els.powerFactor.textContent = fmtNumber(data?.powerFactor, { maxFrac: 3 });
    if (els.todayEnergy) els.todayEnergy.textContent = fmtNumber(data?.todayEnergyKwh, { maxFrac: 3 });
    if (els.maxDemand) els.maxDemand.textContent = fmtNumber(data?.todayMaxDemandKw, { maxFrac: 3 });
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
          tooltip: { mode: "index", intersect: false },
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
      const res = await fetch("/stats/week", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      const days = Array.isArray(payload?.days) ? payload.days : [];

      weekLabels.length = 0;
      weekData.length = 0;
      for (const d of days) {
        weekLabels.push(d?.label ?? d?.dateKey ?? "");
        weekData.push(Number(d?.energyKwh) || 0);
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
      const res = await fetch("/data", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
  
      applyData(data);
  
      lastOkAt = Date.now();
      setStatus("ok", "Connected");
      updateLastUpdated(lastOkAt);
      if (els.metricsHint) els.metricsHint.textContent = "Live readings";
      if (userInitiated) showToast("Updated.");
    } catch (err) {
      // Keep previous values, but reflect state clearly.
      setStatus("bad", "Disconnected");
      if (els.metricsHint) els.metricsHint.textContent = "Unable to fetch latest reading";
      if (userInitiated) showToast("Couldn’t refresh. Is the server running?");
    } finally {
      inFlight = false;
    }
  }
  
  function startStaleWatcher() {
    window.setInterval(() => {
      if (!lastOkAt) return;
      const ageMs = Date.now() - lastOkAt;
      if (ageMs > 7000) setStatus("stale", "Stale data");
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