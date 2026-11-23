(() => {
  "use strict";

  const STORAGE_KEY = "roadguard.reports.v1";
  const SETTINGS_KEY = "roadguard.settings.v1";
  const SIMULATION_INTERVAL_MS = 5000;
  const WEATHER_REFRESH_MS = 30 * 60 * 1000;

  const SAMPLE_REPORTS = [
    {
      id: "sample-001",
      title: "Pothole near Main Street",
      location: "Main Street & 2nd Avenue",
      latitude: 40.7128,
      longitude: -74.006,
      severity: "high",
      status: "reported",
      description: "Sample pothole report for demonstration.",
      reportedAt: new Date(Date.now() - 3_600_000).toISOString(),
      simulated: true,
      traffic: "medium",
      weatherRisk: 0.4
    },
    {
      id: "sample-002",
      title: "Road damage on Oak Road",
      location: "Oak Road near the town hall",
      latitude: 40.718,
      longitude: -74.012,
      severity: "medium",
      status: "in-progress",
      description: "Sample repair status for demonstration.",
      reportedAt: new Date(Date.now() - 86_400_000).toISOString(),
      simulated: true,
      traffic: "high",
      weatherRisk: 0.2
    },
    {
      id: "sample-003",
      title: "Small pothole on River Avenue",
      location: "River Avenue",
      latitude: 40.707,
      longitude: -74.001,
      severity: "low",
      status: "repaired",
      description: "Sample repaired report for demonstration.",
      reportedAt: new Date(Date.now() - 172_800_000).toISOString(),
      simulated: true,
      traffic: "low",
      weatherRisk: 0.1
    }
  ];

  const VEHICLES = [
    { id: "vehicle-1", name: "Vehicle 1", latitude: 40.7128, longitude: -74.006, heading: 45, speed: 32 },
    { id: "vehicle-2", name: "Vehicle 2", latitude: 40.718, longitude: -74.012, heading: 220, speed: 27 },
    { id: "vehicle-3", name: "Vehicle 3", latitude: 40.707, longitude: -74.001, heading: 90, speed: 35 }
  ];

  const SELECTORS = {
    reportList: [
      "[data-report-list]", "#report-list", "#reports-list", "#pothole-reports",
      "#reports-container", "#reportsTable tbody", "#reports-table tbody",
      ".report-list", ".reports-list", ".reports-container"
    ],
    reportForm: [
      "[data-report-form]", "#report-form", "#pothole-form", "#submit-report-form",
      "form[id*='report' i]", "form[id*='pothole' i]"
    ],
    authorityForm: [
      "[data-authority-form]", "#authority-form", "#repair-form",
      "form[id*='authority' i]", "form[id*='repair' i]"
    ],
    search: [
      "[data-report-search]", "#report-search", "#search-reports",
      "#search-input", "input[type='search']"
    ],
    filter: [
      "[data-report-filter]", "#report-filter", "#status-filter",
      "#filter-status", "select[name='status']"
    ],
    vehicles: [
      "[data-vehicle-list]", "#vehicle-list", "#vehicles-list",
      "#vehicle-status", "#vehicle-container", ".vehicle-list"
    ],
    weather: [
      "[data-weather]", "#weather-info", "#weather-display",
      "#weather-result", "#weather"
    ],
    toast: ["[data-toast]", "#toast", "#notification", ".toast"]
  };

  const app = {
    reports: [],
    vehicles: VEHICLES.map(vehicle => ({ ...vehicle })),
    weather: null,
    timer: null,
    weatherTimer: null,
    lastHazards: new Set(),
    settings: { latitude: 40.7128, longitude: -74.006, location: "Sample location" }
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function firstMatch(selectors, root = document) {
    for (const selector of selectors) {
      const match = $(selector, root);
      if (match) return match;
    }
    return null;
  }

  function allMatches(selectors, root = document) {
    const found = new Set();
    selectors.forEach(selector => $$(selector, root).forEach(element => found.add(element)));
    return Array.from(found);
  }

  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, character => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[character]);
  }

  function readStoredJSON(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch (error) {
      console.warn(`RoadGuard: Could not read ${key} from localStorage.`, error);
      return fallback;
    }
  }

  function saveReports() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(app.reports));
    } catch (error) {
      console.error("RoadGuard: Could not save reports to localStorage.", error);
      showMessage("Unable to save changes in this browser.", "error");
    }
  }

  function loadReports() {
    const saved = readStoredJSON(STORAGE_KEY, null);
    app.reports = Array.isArray(saved) ? saved : SAMPLE_REPORTS.map(report => ({ ...report }));
    if (!Array.isArray(saved)) saveReports();

    const savedSettings = readStoredJSON(SETTINGS_KEY, {});
    if (savedSettings && typeof savedSettings === "object") {
      app.settings = { ...app.settings, ...savedSettings };
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(app.settings));
    } catch (error) {
      console.warn("RoadGuard: Could not save settings.", error);
    }
  }

  function showMessage(message, type = "info") {
    let output = firstMatch(SELECTORS.toast);
    if (!output) {
      output = document.createElement("div");
      output.setAttribute("role", "status");
      output.setAttribute("aria-live", "polite");
      output.dataset.roadguardToast = "true";
      Object.assign(output.style, {
        position: "fixed",
        right: "1rem",
        bottom: "1rem",
        zIndex: "9999",
        maxWidth: "min(90vw, 28rem)",
        padding: "0.8rem 1rem",
        borderRadius: "0.5rem",
        color: "#fff",
        background: "#243447",
        boxShadow: "0 4px 16px rgba(0,0,0,.2)"
      });
      document.body.appendChild(output);
    }

    output.textContent = message;
    output.dataset.type = type;
    output.hidden = false;
    output.style.display = "";
    clearTimeout(output._roadguardTimeout);
    output._roadguardTimeout = setTimeout(() => {
      if (output.dataset.roadguardToast === "true") output.remove();
      else output.hidden = true;
    }, 5000);
  }

  function normalizeSeverity(value) {
    const severity = String(value || "medium").toLowerCase();
    if (["critical", "severe", "high"].includes(severity)) return "high";
    if (["low", "minor"].includes(severity)) return "low";
    return "medium";
  }

  function normalizeStatus(value) {
    const status = String(value || "reported").toLowerCase().replace(/[\s_]+/g, "-");
    if (["fixed", "complete", "completed"].includes(status)) return "repaired";
    if (["working", "under-repair", "underway", "inprogress"].includes(status)) return "in-progress";
    if (["open", "new", "pending"].includes(status)) return "reported";
    return ["reported", "in-progress", "repaired"].includes(status) ? status : "reported";
  }

  function riskScore(report) {
    const severityPoints = { low: 20, medium: 50, high: 80 };
    const statusFactor = report.status === "repaired" ? 0.2 : report.status === "in-progress" ? 0.7 : 1;
    const trafficPoints = { low: 5, medium: 12, high: 20 };
    const severity = severityPoints[normalizeSeverity(report.severity)] || 50;
    const traffic = trafficPoints[String(report.traffic || "medium").toLowerCase()] || 12;
    const weather = Math.max(0, Math.min(20, Number(report.weatherRisk) * 20 || 0));
    return Math.max(0, Math.min(100, Math.round((severity + traffic + weather) * statusFactor)));
  }

  function severityWarning(severity) {
    switch (normalizeSeverity(severity)) {
      case "high": return "High severity — slow down and avoid the hazard if safe.";
      case "low": return "Low severity — use caution when passing.";
      default: return "Moderate severity — drive carefully near this hazard.";
    }
  }

  function formatDate(value) {
    if (!value) return "Unknown";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
  }

  function findReport(id) {
    return app.reports.find(report => String(report.id) === String(id));
  }

  function elementText(element, value) {
    if (!element) return;
    if ("value" in element && /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName)) {
      element.value = value;
    } else {
      element.textContent = value;
    }
  }

  function setStat(stat, value) {
    const aliases = {
      total: ["total", "reports", "total-reports", "totalReports"],
      open: ["open", "active", "open-reports", "active-reports"],
      repaired: ["repaired", "resolved", "fixed", "repaired-reports"],
      highRisk: ["high-risk", "highRisk", "critical", "high-severity"],
      vehicles: ["vehicles", "vehicle-count", "active-vehicles"],
      averageRisk: ["average-risk", "averageRisk", "risk-score"]
    };
    const names = aliases[stat] || [stat];
    const selectors = names.flatMap(name => [
      `[data-stat="${name}"]`,
      `#${name}`,
      `#stat-${name}`,
      `.stat-${name}`
    ]);
    allMatches(selectors).forEach(element => elementText(element, value));
  }

  function updateDashboard() {
    const open = app.reports.filter(report => normalizeStatus(report.status) !== "repaired");
    const highRisk = app.reports.filter(report => normalizeSeverity(report.severity) === "high" && report.status !== "repaired");
    const average = app.reports.length
      ? Math.round(app.reports.reduce((sum, report) => sum + riskScore(report), 0) / app.reports.length)
      : 0;

    setStat("total", app.reports.length);
    setStat("open", open.length);
    setStat("repaired", app.reports.filter(report => normalizeStatus(report.status) === "repaired").length);
    setStat("highRisk", highRisk.length);
    setStat("vehicles", app.vehicles.length);
    setStat("averageRisk", `${average}/100`);

    allMatches(["[data-simulation-label]", "#simulation-label", ".simulation-label"])
      .forEach(element => elementText(element, "SIMULATED DATA"));
  }

  function reportMatchesFilters(report) {
    const search = firstMatch(SELECTORS.search);
    const filter = firstMatch(SELECTORS.filter);
    const query = search ? String(search.value || "").trim().toLowerCase() : "";
    const status = filter ? String(filter.value || "").toLowerCase() : "";

    const text = [
      report.title, report.location, report.description, report.severity,
      report.status, report.id
    ].join(" ").toLowerCase();

    return (!query || text.includes(query)) &&
      (!status || status === "all" || normalizeStatus(report.status) === normalizeStatus(status));
  }

  function reportMarkup(report) {
    const severity = normalizeSeverity(report.severity);
    const status = normalizeStatus(report.status);
    const warning = severityWarning(severity);
    const simulated = report.simulated ? " · SIMULATED" : "";
    const risk = riskScore(report);

    return `
      <article class="roadguard-report" data-report-id="${escapeHTML(report.id)}">
        <div class="roadguard-report-heading">
          <h3>${escapeHTML(report.title || "Pothole report")}</h3>
          <span class="severity severity-${severity}">${escapeHTML(severity.toUpperCase())}</span>
        </div>
        <p><strong>Location:</strong> ${escapeHTML(report.location || "Not specified")}</p>
        <p><strong>Status:</strong> <span class="status status-${status}">${escapeHTML(status.replace("-", " "))}</span></p>
        <p><strong>Risk priority:</strong> ${risk}/100</p>
        <p>${escapeHTML(report.description || warning)}</p>
        <p class="roadguard-report-meta">${escapeHTML(formatDate(report.reportedAt))}${simulated}</p>
        <p class="roadguard-warning">${escapeHTML(warning)}</p>
        <div class="roadguard-report-actions">
          <button type="button" data-report-action="alert" data-report-id="${escapeHTML(report.id)}">Send hazard alert</button>
          <button type="button" data-report-action="status" data-status="in-progress" data-report-id="${escapeHTML(report.id)}">Mark in progress</button>
          <button type="button" data-report-action="status" data-status="repaired" data-report-id="${escapeHTML(report.id)}">Mark repaired</button>
        </div>
      </article>`;
  }

  function renderReports() {
    const target = firstMatch(SELECTORS.reportList);
    const reports = app.reports.filter(reportMatchesFilters);

    if (target) {
      if (target.tagName === "TBODY") {
        target.innerHTML = reports.map(report => `
          <tr data-report-id="${escapeHTML(report.id)}">
            <td>${escapeHTML(report.title || "Pothole report")}${report.simulated ? " (SIMULATED)" : ""}</td>
            <td>${escapeHTML(report.location || "Not specified")}</td>
            <td><span class="severity severity-${normalizeSeverity(report.severity)}">${escapeHTML(normalizeSeverity(report.severity))}</span></td>
            <td>${escapeHTML(normalizeStatus(report.status).replace("-", " "))}</td>
            <td>${riskScore(report)}/100</td>
            <td>${escapeHTML(formatDate(report.reportedAt))}</td>
            <td>
              <button type="button" data-report-action="status" data-status="in-progress" data-report-id="${escapeHTML(report.id)}">In progress</button>
              <button type="button" data-report-action="status" data-status="repaired" data-report-id="${escapeHTML(report.id)}">Repaired</button>
            </td>
          </tr>`).join("");
      } else {
        target.innerHTML = reports.length
          ? reports.map(reportMarkup).join("")
          : `<p class="roadguard-empty">No reports match your search.</p>`;
      }
    }

    renderAuthorityOptions();
    updateDashboard();
  }

  function renderAuthorityOptions() {
    const selectors = [
      "[data-authority-report-select]", "#authority-report", "#repair-report",
      "select[name='reportId']"
    ];
    allMatches(selectors).forEach(select => {
      const current = select.value;
      select.innerHTML = `<option value="">Select a report</option>` + app.reports.map(report =>
        `<option value="${escapeHTML(report.id)}">${escapeHTML(report.title || report.location || report.id)} — ${escapeHTML(normalizeStatus(report.status))}</option>`
      ).join("");
      if (app.reports.some(report => String(report.id) === current)) select.value = current;
    });
  }

  function updateReportStatus(id, status) {
    const report = findReport(id);
    if (!report) {
      showMessage("That report could not be found.", "error");
      return;
    }
    report.status = normalizeStatus(status);
    report.updatedAt = new Date().toISOString();
    saveReports();
    renderReports();
    showMessage(`Report updated: ${report.status.replace("-", " ")}.`, "success");
  }

  function makeId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    return `rg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function formValue(form, names) {
    for (const name of names) {
      const field = form.querySelector(`[name="${name}"], #${name}`);
      if (field && String(field.value || "").trim()) return String(field.value).trim();
    }
    return "";
  }

  function submitReport(form, options = {}) {
    const latitude = Number(formValue(form, ["latitude", "lat"]));
    const longitude = Number(formValue(form, ["longitude", "lng", "lon"]));
    const severity = normalizeSeverity(formValue(form, ["severity", "priority"]));
    const location = formValue(form, ["location", "address", "road"]) ||
      (Number.isFinite(latitude) && Number.isFinite(longitude) ? `${latitude.toFixed(5)}, ${longitude.toFixed(5)}` : app.settings.location);
    const description = formValue(form, ["description", "details", "notes"]);
    const title = formValue(form, ["title", "name"]) || `${severity[0].toUpperCase()}${severity.slice(1)} severity pothole`;

    const report = {
      id: makeId(),
      title,
      location,
      latitude: Number.isFinite(latitude) && latitude !== 0 ? latitude : app.settings.latitude,
      longitude: Number.isFinite(longitude) && longitude !== 0 ? longitude : app.settings.longitude,
      severity,
      status: "reported",
      description: description || severityWarning(severity),
      reportedAt: new Date().toISOString(),
      simulated: Boolean(options.simulated),
      traffic: options.traffic || "medium",
      weatherRisk: app.weather ? Number(app.weather.risk || 0) : 0
    };

    app.reports.unshift(report);
    saveReports();
    renderReports();
    if (form && !options.simulated) form.reset();
    showMessage(`${options.simulated ? "Simulated pothole detected" : "Report submitted"}: ${severityWarning(severity)}`, severity === "high" ? "warning" : "success");
    broadcastHazard(report);
    return report;
  }

  function wireReportForms() {
    allMatches(SELECTORS.reportForm).forEach(form => {
      if (form.dataset.roadguardBound) return;
      form.dataset.roadguardBound = "true";
      form.addEventListener("submit", event => {
        event.preventDefault();
        submitReport(form);
      });
    });

    allMatches(SELECTORS.authorityForm).forEach(form => {
      if (form.dataset.roadguardBound) return;
      form.dataset.roadguardBound = "true";
      form.addEventListener("submit", event => {
        event.preventDefault();
        const reportId = formValue(form, ["reportId", "report", "report_id"]);
        const status = formValue(form, ["status", "repairStatus", "repair_status"]);
        if (!reportId || !status) {
          showMessage("Choose a report and repair status first.", "error");
          return;
        }
        updateReportStatus(reportId, status);
        form.reset();
      });
    });
  }

  function haversineKm(lat1, lon1, lat2, lon2) {
    const toRad = degrees => degrees * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function broadcastHazard(report) {
    if (!Number.isFinite(Number(report.latitude)) || !Number.isFinite(Number(report.longitude))) return;
    const recipients = app.vehicles.filter(vehicle => {
      const distance = haversineKm(vehicle.latitude, vehicle.longitude, report.latitude, report.longitude);
      return distance <= 2 && vehicle.id !== report.detectedBy;
    });

    recipients.forEach(vehicle => {
      const key = `${report.id}:${vehicle.id}`;
      if (app.lastHazards.has(key)) return;
      app.lastHazards.add(key);
      showMessage(`Vehicle-to-vehicle alert for ${vehicle.name}: ${report.title}. ${severityWarning(report.severity)}`, "warning");
    });

    const alerts = allMatches(["[data-hazard-alerts]", "#hazard-alerts", "#vehicle-alerts", ".hazard-alerts"]);
    alerts.forEach(target => {
      const message = document.createElement("p");
      message.textContent = `${report.title}: ${severityWarning(report.severity)} (SIMULATED ALERT)`;
      target.prepend(message);
      while (target.children.length > 10) target.lastElementChild.remove();
    });
  }

  function moveVehicles() {
    app.vehicles.forEach(vehicle => {
      const step = 0.00035;
      const radians = vehicle.heading * Math.PI / 180;
      vehicle.latitude += Math.cos(radians) * step;
      vehicle.longitude += Math.sin(radians) * step;
      if (Math.random() < 0.12) vehicle.heading = (vehicle.heading + (Math.random() * 80 - 40) + 360) % 360;
      vehicle.speed = Math.max(10, Math.min(55, vehicle.speed + Math.round(Math.random() * 6 - 3)));
    });

    renderVehicles();
    app.vehicles.forEach(vehicle => {
      app.reports
        .filter(report => normalizeStatus(report.status) !== "repaired")
        .forEach(report => {
          if (!Number.isFinite(Number(report.latitude)) || !Number.isFinite(Number(report.longitude))) return;
          const distance = haversineKm(vehicle.latitude, vehicle.longitude, Number(report.latitude), Number(report.longitude));
          if (distance <= 0.35) broadcastHazard({ ...report, detectedBy: vehicle.id });
        });
    });
  }

  function renderVehicles() {
    const target = firstMatch(SELECTORS.vehicles);
    if (target) {
      target.innerHTML = app.vehicles.map(vehicle => `
        <article class="roadguard-vehicle" data-vehicle-id="${escapeHTML(vehicle.id)}">
          <strong>${escapeHTML(vehicle.name)}</strong>
          <span>SIMULATED</span>
          <p>Speed: ${Math.round(vehicle.speed)} km/h</p>
          <p>Position: ${vehicle.latitude.toFixed(4)}, ${vehicle.longitude.toFixed(4)}</p>
        </article>`).join("");
    }

    allMatches(["[data-vehicle-count]", "#vehicle-count"])
      .forEach(element => elementText(element, app.vehicles.length));
    updateDashboard();
  }

  function simulateDetection() {
    const availableReports = app.reports.filter(report => normalizeStatus(report.status) !== "repaired");
    const base = availableReports.length
      ? availableReports[Math.floor(Math.random() * availableReports.length)]
      : SAMPLE_REPORTS[0];

    const vehicle = app.vehicles[Math.floor(Math.random() * app.vehicles.length)];
    const severity = ["low", "medium", "high"][Math.floor(Math.random() * 3)];
    const report = {
      id: makeId(),
      title: "Simulated pothole detection",
      location: base.location || "Sample road location",
      latitude: Number.isFinite(Number(base.latitude)) ? Number(base.latitude) : vehicle.latitude,
      longitude: Number.isFinite(Number(base.longitude)) ? Number(base.longitude) : vehicle.longitude,
      severity,
      status: "reported",
      description: `Detected by ${vehicle.name} during the vehicle simulation. SIMULATED DATA.`,
      reportedAt: new Date().toISOString(),
      simulated: true,
      traffic: ["low", "medium", "high"][Math.floor(Math.random() * 3)],
      weatherRisk: app.weather ? Number(app.weather.risk || 0) : 0,
      detectedBy: vehicle.id
    };

    app.reports.unshift(report);
    saveReports();
    renderReports();
    broadcastHazard(report);
    showMessage(`SIMULATED pothole detected: ${severityWarning(severity)}`, severity === "high" ? "warning" : "info");
    return report;
  }

  function startSimulation() {
    if (app.timer) return;
    app.timer = setInterval(() => {
      moveVehicles();
      if (Math.random() < 0.15) simulateDetection();
    }, SIMULATION_INTERVAL_MS);
    renderVehicles();
    showMessage("Vehicle simulation started. All vehicle activity is simulated.", "info");
  }

  function stopSimulation() {
    if (!app.timer) return;
    clearInterval(app.timer);
    app.timer = null;
    showMessage("Vehicle simulation stopped.", "info");
  }

  function updateWeatherDisplay(message) {
    const target = firstMatch(SELECTORS.weather);
    if (!target) return;

    if (message) {
      target.textContent = message;
      return;
    }
    if (!app.weather) {
      target.textContent = "Weather unavailable.";
      return;
    }
    target.innerHTML = `
      <strong>Current weather (Open-Meteo)</strong>
      <p>Temperature: ${escapeHTML(app.weather.temperature)}°C</p>
      <p>Wind: ${escapeHTML(app.weather.wind)} km/h</p>
      <p>Precipitation: ${escapeHTML(app.weather.precipitation)} mm</p>
      <p>Conditions: ${escapeHTML(app.weather.description)}</p>
      <small>Weather data is informational; road risk score is an estimate.</small>`;
  }

  function weatherDescription(code) {
    const descriptions = {
      0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
      45: "Fog", 48: "Depositing rime fog", 51: "Light drizzle", 53: "Drizzle",
      55: "Dense drizzle", 61: "Light rain", 63: "Rain", 65: "Heavy rain",
      71: "Light snow", 73: "Snow", 75: "Heavy snow", 80: "Rain showers",
      81: "Showers", 82: "Heavy showers", 95: "Thunderstorm"
    };
    return descriptions[code] || "Conditions reported by Open-Meteo";
  }

  async function loadWeather() {
    const latitudeInput = firstMatch(["[name='latitude']", "#latitude", "[data-weather-lat]"]);
    const longitudeInput = firstMatch(["[name='longitude']", "#longitude", "[data-weather-lon]"]);
    const lat = Number(latitudeInput?.value || app.settings.latitude);
    const lon = Number(longitudeInput?.value || app.settings.longitude);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      updateWeatherDisplay("Enter valid latitude and longitude to retrieve weather.");
      return;
    }

    app.settings.latitude = lat;
    app.settings.longitude = lon;
    saveSettings();
    updateWeatherDisplay("Loading current weather…");

    try {
      const url = new URL("https://api.open-meteo.com/v1/forecast");
      url.search = new URLSearchParams({
        latitude: String(lat),
        longitude: String(lon),
        current: "temperature_2m,precipitation,weather_code,wind_speed_10m",
        timezone: "auto"
      }).toString();

      const response = await fetch(url.toString(), { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`Weather service returned HTTP ${response.status}.`);
      const result = await response.json();
      if (!result.current) throw new Error("Weather service returned incomplete data.");

      const current = result.current;
      const precipitation = Number(current.precipitation || 0);
      app.weather = {
        temperature: Number(current.temperature_2m).toFixed(1),
        wind: Number(current.wind_speed_10m).toFixed(1),
        precipitation: precipitation.toFixed(1),
        description: weatherDescription(Number(current.weather_code)),
        risk: Math.min(1, precipitation / 10 + (Number(current.wind_speed_10m) > 40 ? 0.2 : 0)),
        updatedAt: new Date().toISOString()
      };

      updateWeatherDisplay();
      renderReports();
    } catch (error) {
      console.error("RoadGuard: Weather request failed.", error);
      updateWeatherDisplay("Weather could not be loaded. Check your connection and try again.");
    }
  }

  function wireNavigation() {
    document.addEventListener("click", event => {
      const link = event.target.closest("a[href^='#']");
      if (!link) return;
      const id = decodeURIComponent(link.getAttribute("href").slice(1));
      const target = document.getElementById(id);
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      target.focus?.({ preventScroll: true });
      $$(".nav-link.active, .navigation a.active, nav a.active").forEach(item => item.classList.remove("active"));
      link.classList.add("active");
    });

    document.addEventListener("click", event => {
      const tab = event.target.closest("[data-target], [data-section], [data-nav-target]");
      if (!tab || tab.matches("a[href^='#']")) return;
      const id = tab.dataset.target || tab.dataset.section || tab.dataset.navTarget;
      const target = id && (document.getElementById(id.replace(/^#/, "")) || $(id));
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function wireSearchAndFilters() {
    allMatches(SELECTORS.search).forEach(input => input.addEventListener("input", renderReports));
    allMatches(SELECTORS.filter).forEach(input => input.addEventListener("change", renderReports));
  }

  function wireButtons() {
    document.addEventListener("click", event => {
      const button = event.target.closest("button, [role='button'], input[type='button'], input[type='submit']");
      if (!button) return;

      const reportAction = button.dataset.reportAction;
      if (reportAction) {
        const id = button.dataset.reportId || button.closest("[data-report-id]")?.dataset.reportId;
        if (reportAction === "status") updateReportStatus(id, button.dataset.status || "in-progress");
        if (reportAction === "alert") {
          const report = findReport(id);
          if (report) {
            broadcastHazard(report);
            showMessage(`Hazard alert sent. ${severityWarning(report.severity)}`, "warning");
          }
        }
        return;
      }

      const action = String(
        button.dataset.action || button.id || button.name || button.textContent || ""
      ).toLowerCase().replace(/[\s_-]+/g, "");

      if (/start.*(simulation|vehicle)|simulation.*start/.test(action)) {
        startSimulation();
      } else if (/stop.*(simulation|vehicle)|simulation.*stop/.test(action)) {
        stopSimulation();
      } else if (/detect|simulate.*(pothole|report)|pothole.*simulate/.test(action)) {
        simulateDetection();
      } else if (/weather|refreshweather/.test(action)) {
        loadWeather();
      } else if (/search|filter/.test(action)) {
        renderReports();
      } else if (/clear.*(filter|search)|reset.*(filter|search)/.test(action)) {
        allMatches(SELECTORS.search).forEach(input => { input.value = ""; });
        allMatches(SELECTORS.filter).forEach(input => { input.value = ""; });
        renderReports();
      } else if (/update.*(status|repair)|submit.*(repair|authority)/.test(action)) {
        const form = button.closest("form") || firstMatch(SELECTORS.authorityForm);
        if (form) {
          const reportId = formValue(form, ["reportId", "report", "report_id"]);
          const status = formValue(form, ["status", "repairStatus", "repair_status"]);
          if (reportId && status) updateReportStatus(reportId, status);
          else showMessage("Choose a report and repair status first.", "error");
        }
      }
    });
  }

  function exposeActions() {
    window.RoadGuard = Object.freeze({
      getReports: () => app.reports.map(report => ({ ...report })),
      getVehicles: () => app.vehicles.map(vehicle => ({ ...vehicle })),
      submitSimulatedReport: simulateDetection,
      startSimulation,
      stopSimulation,
      refreshWeather: loadWeather,
      calculateRiskPriority: riskScore,
      updateReportStatus
    });
  }

  function initialize() {
    loadReports();
    renderReports();
    renderVehicles();
    wireReportForms();
    wireSearchAndFilters();
    wireNavigation();
    wireButtons();
    exposeActions();

    const simulationControlsExist = firstMatch([
      "[data-action*='simulation' i]", "#start-simulation", "#startSimulation",
      "#simulate-vehicles", "#vehicle-simulation"
    ]);
    if (simulationControlsExist) showMessage("RoadGuard ready. Dashboard sample reports are labeled as simulated data.", "info");

    if (firstMatch(SELECTORS.weather)) {
      loadWeather();
      app.weatherTimer = setInterval(loadWeather, WEATHER_REFRESH_MS);
    }

    // Initialize coordinate inputs from the saved/default weather location.
    allMatches(["[data-weather-lat]", "#latitude", "input[name='latitude']"])
      .forEach(input => { if (!input.value) input.value = app.settings.latitude; });
    allMatches(["[data-weather-lon]", "#longitude", "input[name='longitude']"])
      .forEach(input => { if (!input.value) input.value = app.settings.longitude; });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})();
