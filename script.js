(() => {
  "use strict";

  const STORAGE = {
    reports: "roadguard.reports.v2",
    legacyReports: "roadguard.reports.v1",
    settings: "roadguard.settings.v1",
    vehicles: "roadguard.vehicles.v1",
    alerts: "roadguard.alerts.v1",
    activity: "roadguard.activity.v1"
  };
  const SIMULATION_INTERVAL_MS = 3500;
  const WEATHER_REFRESH_MS = 30 * 60 * 1000;
  const ALERT_RADIUS_KM = 2;
  const MAX_HISTORY = 60;
  const DEFAULT_LOCATION = { latitude: 40.7128, longitude: -74.006 };
  const SAMPLE_REPORTS = [
    {
      id: "sample-001",
      title: "Pothole near Main Street",
      location: "Main Street & 2nd Avenue",
      latitude: 40.7128,
      longitude: -74.006,
      severity: "high",
      status: "pending",
      description: "Sample pothole report for demonstration.",
      reportedAt: new Date(Date.now() - 3_600_000).toISOString(),
      simulated: true
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
      verifiedAt: new Date(Date.now() - 80_000_000).toISOString(),
      repairNote: "Crew scheduled for inspection.",
      simulated: true
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
      verifiedAt: new Date(Date.now() - 170_000_000).toISOString(),
      repairNote: "Sample repair completed.",
      simulated: true
    }
  ];
  const DEFAULT_VEHICLES = [
    { id: "vehicle-1", name: "Vehicle 1", latitude: 40.7128, longitude: -74.006, heading: 45, speed: 32, lastReportAt: "" },
    { id: "vehicle-2", name: "Vehicle 2", latitude: 40.718, longitude: -74.012, heading: 220, speed: 27, lastReportAt: "" },
    { id: "vehicle-3", name: "Vehicle 3", latitude: 40.707, longitude: -74.001, heading: 90, speed: 35, lastReportAt: "" }
  ];
  const REPAIR_TEAMS = ["Roads crew A", "Roads crew B", "Roads crew C"];
  const STATUS_LABELS = {
    pending: "Pending",
    verified: "Verified",
    "in-progress": "In Progress",
    repaired: "Repaired",
    rejected: "Rejected"
  };
  const SEVERITY_POINTS = { low: 20, medium: 50, high: 80 };
  const SEVERITY_COLORS = { high: "#ff6d7f", medium: "#ffad5c", low: "#39d6a0" };

  const app = {
    reports: [],
    vehicles: [],
    alerts: [],
    activity: [],
    settings: { ...DEFAULT_LOCATION, location: "New York City", audibleAlerts: false },
    weather: null,
    map: null,
    reportMarkers: null,
    vehicleMarkers: null,
    charts: {},
    trendBuckets: [],
    timer: null,
    simulationState: "stopped",
    weatherTimer: null,
    simulationTicks: 0,
    selectedRange: null,
    selectedReportId: null,
    weatherRequest: 0,
    alertKeys: new Set()
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);

  function readJSON(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch (error) {
      console.warn(`RoadGuard: Could not read ${key} from local storage.`, error);
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      console.error(`RoadGuard: Could not save ${key} to local storage.`, error);
      showMessage("Unable to save changes in this browser. Check available storage.", "error");
      return false;
    }
  }

  function makeId() {
    return window.crypto?.randomUUID
      ? window.crypto.randomUUID()
      : `rg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function normalizeSeverity(value) {
    const severity = String(value || "medium").toLowerCase();
    if (["critical", "severe", "high"].includes(severity)) return "high";
    if (["low", "minor"].includes(severity)) return "low";
    return "medium";
  }

  function normalizeStatus(value) {
    const status = String(value || "pending").toLowerCase().replace(/[\s_]+/g, "-");
    if (["reported", "open", "new", "awaiting-review"].includes(status)) return "pending";
    if (["fixed", "complete", "completed"].includes(status)) return "repaired";
    if (["working", "under-repair", "underway", "inprogress"].includes(status)) return "in-progress";
    if (["verified", "pending", "in-progress", "repaired", "rejected"].includes(status)) return status;
    return "pending";
  }

  function normalizeReport(report, index) {
    if (!report || typeof report !== "object") return null;
    const latitude = Number(report.latitude);
    const longitude = Number(report.longitude);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
        !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
    const status = normalizeStatus(report.status);
    const reportedAt = validDate(report.reportedAt) ? report.reportedAt : new Date().toISOString();
    const history = Array.isArray(report.history) ? report.history.filter(item =>
      item && validDate(item.createdAt) && typeof item.action === "string"
    ).map(item => ({
      action: String(item.action).slice(0, 120),
      status: normalizeStatus(item.status),
      createdAt: item.createdAt,
      note: String(item.note || "").slice(0, 240)
    })) : [{
      action: "Report imported",
      status,
      createdAt: validDate(report.updatedAt) ? report.updatedAt : reportedAt,
      note: ""
    }];
    return {
      ...report,
      id: String(report.id || `saved-${index}-${makeId()}`),
      title: String(report.title || "Pothole report"),
      location: String(report.location || `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`),
      latitude,
      longitude,
      severity: normalizeSeverity(report.severity),
      status,
      description: String(report.description || ""),
      reportedAt,
      repairNote: String(report.repairNote || ""),
      repairAssignedTo: REPAIR_TEAMS.includes(report.repairAssignedTo) ? report.repairAssignedTo : "",
      history,
      simulated: report.simulated === true
    };
  }

  function validDate(value) {
    return Boolean(value && !Number.isNaN(new Date(value).getTime()));
  }

  function loadState() {
    const savedSettings = readJSON(STORAGE.settings, {});
    if (savedSettings && typeof savedSettings === "object" && !Array.isArray(savedSettings)) {
      app.settings = { ...app.settings, ...savedSettings };
    }
    if (!Number.isFinite(Number(app.settings.latitude)) || Math.abs(Number(app.settings.latitude)) > 90) {
      app.settings.latitude = DEFAULT_LOCATION.latitude;
    }
    if (!Number.isFinite(Number(app.settings.longitude)) || Math.abs(Number(app.settings.longitude)) > 180) {
      app.settings.longitude = DEFAULT_LOCATION.longitude;
    }
    app.settings.audibleAlerts = Boolean(app.settings.audibleAlerts);

    const storedReports = readJSON(STORAGE.reports, null) ?? readJSON(STORAGE.legacyReports, null);
    const reports = Array.isArray(storedReports) ? storedReports : SAMPLE_REPORTS;
    app.reports = reports.map(normalizeReport).filter(Boolean);
    if (!Array.isArray(storedReports)) writeJSON(STORAGE.reports, app.reports);

    const storedVehicles = readJSON(STORAGE.vehicles, null);
    app.vehicles = DEFAULT_VEHICLES.map((vehicle, index) => {
      const stored = Array.isArray(storedVehicles) ? storedVehicles.find(item => item?.id === vehicle.id) : null;
      const candidate = stored ? { ...vehicle, ...stored } : vehicle;
      const latitude = Number(candidate.latitude);
      const longitude = Number(candidate.longitude);
      return {
        ...vehicle,
        latitude: Number.isFinite(latitude) && Math.abs(latitude) <= 90 ? latitude : vehicle.latitude,
        longitude: Number.isFinite(longitude) && Math.abs(longitude) <= 180 ? longitude : vehicle.longitude,
        heading: Number.isFinite(Number(candidate.heading)) ? Number(candidate.heading) : vehicle.heading,
        speed: Number.isFinite(Number(candidate.speed)) ? Number(candidate.speed) : vehicle.speed,
        lastReportAt: validDate(candidate.lastReportAt) ? candidate.lastReportAt : ""
      };
    });

    const storedAlerts = readJSON(STORAGE.alerts, []);
    app.alerts = Array.isArray(storedAlerts) ? storedAlerts.filter(alert =>
      alert && alert.id && alert.reportId && alert.vehicleId && validDate(alert.createdAt)
    ).slice(0, MAX_HISTORY) : [];
    app.alertKeys = new Set(app.alerts.map(alert => `${alert.reportId}:${alert.vehicleId}`));
    const storedActivity = readJSON(STORAGE.activity, []);
    app.activity = Array.isArray(storedActivity) ? storedActivity.filter(item =>
      item && item.message && validDate(item.createdAt)
    ).slice(0, MAX_HISTORY) : [];
    if (!app.activity.length && app.reports.length) {
      app.activity = app.reports.slice()
        .sort((a, b) => new Date(b.reportedAt) - new Date(a.reportedAt))
        .slice(0, 6)
        .map(report => ({
          id: makeId(),
          message: `Report available at ${report.location}.`,
          type: "report",
          createdAt: report.reportedAt
        }));
      writeJSON(STORAGE.activity, app.activity);
    }

    const audioToggle = $("#audio-alert-toggle");
    if (audioToggle) audioToggle.checked = app.settings.audibleAlerts;
    const latInput = $("#weather-latitude");
    const lonInput = $("#weather-longitude");
    if (latInput) latInput.value = String(app.settings.latitude);
    if (lonInput) lonInput.value = String(app.settings.longitude);
  }

  function saveSettings() {
    writeJSON(STORAGE.settings, app.settings);
  }

  function saveReports() {
    return writeJSON(STORAGE.reports, app.reports);
  }

  function showMessage(message, type = "info") {
    const region = $("#toast-region");
    if (!region) return;
    const toast = document.createElement("div");
    toast.className = `toast-message toast-${type}`;
    toast.setAttribute("role", type === "error" ? "alert" : "status");
    toast.textContent = message;
    region.appendChild(toast);
    window.setTimeout(() => toast.remove(), 4800);
  }

  function addActivity(message, type = "report") {
    app.activity.unshift({ id: makeId(), message, type, createdAt: new Date().toISOString() });
    app.activity = app.activity.slice(0, MAX_HISTORY);
    writeJSON(STORAGE.activity, app.activity);
    renderActivity();
  }

  function formatDate(value) {
    if (!validDate(value)) return "Unknown";
    return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }

  function formatRelative(value) {
    if (!validDate(value)) return "Time unknown";
    const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
    if (elapsed < 60_000) return "Just now";
    if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} min ago`;
    if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} hr ago`;
    return `${Math.floor(elapsed / 86_400_000)} days ago`;
  }

  function isActiveReport(report) {
    const status = normalizeStatus(report.status);
    return status !== "repaired" && status !== "rejected";
  }

  function isVerifiedReport(report) {
    return ["verified", "in-progress", "repaired"].includes(normalizeStatus(report.status));
  }

  function locationKey(report) {
    const label = String(report.location || "").trim().toLocaleLowerCase();
    return label || `${Number(report.latitude).toFixed(3)},${Number(report.longitude).toFixed(3)}`;
  }

  function calculateLocationRisks(sourceReports = app.reports) {
    const groups = new Map();
    sourceReports.filter(isActiveReport).forEach(report => {
      const key = locationKey(report);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(report);
    });

    return Array.from(groups.entries()).map(([key, reports]) => {
      const latest = reports.reduce((newest, report) =>
        new Date(report.reportedAt) > new Date(newest.reportedAt) ? report : newest
      );
      const severity = reports.reduce((highest, report) => {
        const score = SEVERITY_POINTS[normalizeSeverity(report.severity)];
        return score > highest.score ? { score, severity: normalizeSeverity(report.severity) } : highest;
      }, { score: 0, severity: "low" });
      const repeats = Math.min(10, Math.max(0, reports.length - 1) * 5);
      const age = Math.max(0, Date.now() - new Date(latest.reportedAt).getTime());
      const recency = age <= 86_400_000 ? 10 : age <= 7 * 86_400_000 ? 5 : 0;
      return {
        key,
        location: latest.location || "Unspecified location",
        reports,
        severity: severity.severity,
        severityPoints: severity.score,
        repeatPoints: repeats,
        recencyPoints: recency,
        score: Math.min(100, severity.score + repeats + recency),
        latestAt: latest.reportedAt
      };
    }).sort((a, b) => b.score - a.score || new Date(b.latestAt) - new Date(a.latestAt));
  }

  function riskScoreFor(report, risks = calculateLocationRisks()) {
    if (!isActiveReport(report)) return 0;
    return risks.find(location => location.key === locationKey(report))?.score || 0;
  }

  function reportMatchesFilters(report) {
    const query = String($("#report-search")?.value || "").trim().toLocaleLowerCase();
    const status = $("#report-filter")?.value || "all";
    const reportDate = new Date(report.reportedAt);
    const searchable = [
      report.id, report.title, report.location, report.description, report.severity,
      STATUS_LABELS[normalizeStatus(report.status)], report.repairNote
    ].join(" ").toLocaleLowerCase();
    return (!query || searchable.includes(query)) &&
      (status === "all" || normalizeStatus(report.status) === status) &&
      (!app.selectedRange || (reportDate >= app.selectedRange.start && reportDate < app.selectedRange.end));
  }

  function renderReports() {
    const body = $("#reports-table-body");
    if (!body) return;
    const risks = calculateLocationRisks();
    const visible = app.reports.filter(reportMatchesFilters)
      .sort((a, b) => new Date(b.reportedAt) - new Date(a.reportedAt));
    body.innerHTML = visible.map(report => {
      const severity = normalizeSeverity(report.severity);
      const status = normalizeStatus(report.status);
      const sourceBadge = report.simulated
        ? '<span class="report-source">SIMULATED DATA</span>'
        : '<span class="report-source">MANUAL REPORT</span>';
      const risk = riskScoreFor(report, risks);
      const options = Object.entries(STATUS_LABELS).map(([value, label]) =>
        `<option value="${value}"${status === value ? " selected" : ""}>${label}</option>`
      ).join("");
      const assignmentOptions = [
        `<option value=""${report.repairAssignedTo ? "" : " selected"}>Unassigned</option>`,
        ...REPAIR_TEAMS.map(team =>
          `<option value="${escapeHTML(team)}"${report.repairAssignedTo === team ? " selected" : ""}>${escapeHTML(team)}</option>`
        )
      ].join("");
      const vehicleSource = report.detectedBy
        ? app.vehicles.find(vehicle => vehicle.id === report.detectedBy)?.name || report.detectedBy
        : report.simulated ? "Simulated sample" : "Manual report";
      return `<tr data-report-id="${escapeHTML(report.id)}">
        <td><span class="report-id">${escapeHTML(report.id.slice(0, 12))}</span>${sourceBadge}</td>
        <td><span class="table-location">${escapeHTML(report.location)}</span><span class="table-subtext">${Number(report.latitude).toFixed(4)}, ${Number(report.longitude).toFixed(4)}</span></td>
        <td><span class="risk-badge risk-badge-${severity}">${severity[0].toUpperCase()}${severity.slice(1)}</span></td>
        <td><span class="risk-score">${risk}<small>/100</small></span></td>
        <td><time datetime="${escapeHTML(report.reportedAt)}">${escapeHTML(formatDate(report.reportedAt))}</time></td>
        <td>${escapeHTML(vehicleSource)}</td>
        <td><label class="visually-hidden" for="status-${escapeHTML(report.id)}">Status for ${escapeHTML(report.title)}</label><select class="status-select" id="status-${escapeHTML(report.id)}" data-report-status="${escapeHTML(report.id)}">${options}</select></td>
        <td><label class="visually-hidden" for="assignment-${escapeHTML(report.id)}">Assign repair crew for ${escapeHTML(report.title)}</label><select class="status-select" id="assignment-${escapeHTML(report.id)}" data-repair-assignment="${escapeHTML(report.id)}">${assignmentOptions}</select></td>
        <td><label class="visually-hidden" for="note-${escapeHTML(report.id)}">Repair note for ${escapeHTML(report.title)}</label><input class="repair-note-input" id="note-${escapeHTML(report.id)}" data-repair-note="${escapeHTML(report.id)}" maxlength="240" value="${escapeHTML(report.repairNote)}" placeholder="Add repair note"></td>
        <td><div class="row-actions">
          <button class="table-action" type="button" data-report-action="verify" data-report-id="${escapeHTML(report.id)}">Verify</button>
          <button class="table-action table-action-danger" type="button" data-report-action="reject" data-report-id="${escapeHTML(report.id)}">Reject</button>
          <button class="table-action" type="button" data-report-action="save-note" data-report-id="${escapeHTML(report.id)}">Save note</button>
        </div></td>
      </tr>`;
    }).join("");

    const empty = $("#reports-empty");
    if (empty) empty.hidden = visible.length > 0;
    const count = $("#report-count-label");
    if (count) {
      const dateLabel = app.selectedRange
        ? ` · ${app.selectedRange.label}`
        : "";
      count.textContent = `${visible.length} of ${app.reports.length} report${app.reports.length === 1 ? "" : "s"}${dateLabel}`;
    }
    updateDashboard(risks);
    renderActivity();
    renderRepairHistory();
    renderMap();
    renderAnalytics(risks);
  }

  function updateDashboard(risks) {
    const verified = app.reports.filter(isVerifiedReport).length;
    const unverified = app.reports.filter(report => normalizeStatus(report.status) === "pending").length;
    const repaired = app.reports.filter(report => normalizeStatus(report.status) === "repaired").length;
    const highRisk = risks.filter(location => location.score >= 70).length;
    const now = new Date();
    const currentStart = new Date(now.getTime() - 7 * 86_400_000);
    const previousStart = new Date(now.getTime() - 14 * 86_400_000);
    const currentEnd = new Date(now.getTime() + 1);
    const stats = {
      total: app.reports.length,
      verified,
      unverified,
      vehicles: app.timer ? app.vehicles.length : 0,
      "high-risk": highRisk,
      repaired
    };
    Object.entries(stats).forEach(([name, value]) => {
      const target = $(`[data-stat="${name}"]`);
      if (target) target.textContent = String(value);
    });
    ["total", "verified", "unverified", "high-risk", "repaired"].forEach(name => {
      const current = reportEventsInRange(name, currentStart, currentEnd);
      const previous = reportEventsInRange(name, previousStart, currentStart);
      const target = $(`[data-stat-change="${name}"]`);
      if (!target) return;
      const change = formatChange(current, previous);
      target.textContent = `${change} · ${current} this week vs ${previous} prior`;
      const improved = ["verified", "repaired"].includes(name) ? current > previous : current < previous;
      target.classList.toggle("is-positive", improved);
      target.classList.toggle("is-negative", current !== previous && !improved && name !== "total");
    });
    const fleetChange = $(`[data-stat-change="vehicles"]`);
    if (fleetChange) fleetChange.textContent = `${app.timer ? app.vehicles.length : 0} active · ${app.vehicles.length} registered`;
    const conditions = {
      active: app.reports.filter(isActiveReport).length,
      pending: app.reports.filter(report => normalizeStatus(report.status) === "pending").length,
      repair: app.reports.filter(report => normalizeStatus(report.status) === "in-progress").length,
      repaired
    };
    Object.entries(conditions).forEach(([name, value]) => {
      const target = $(`[data-condition="${name}"]`);
      if (target) target.textContent = String(value);
    });
    const vehicleCount = $("#vehicle-count");
    if (vehicleCount) vehicleCount.textContent = String(app.vehicles.length);
    const networkReports = $("#network-report-count");
    if (networkReports) networkReports.textContent = String(app.reports.length);
    const running = Boolean(app.timer);
    const simStatus = $("#simulation-status");
    const simDot = $("#simulation-status-dot");
    if (simStatus) simStatus.textContent = running ? "Simulation running" : `Simulation ${app.simulationState}`;
    if (simDot) simDot.classList.toggle("is-stopped", !running);
    const start = $("#start-simulation");
    const stop = $("#stop-simulation");
    if (start) start.disabled = running;
    if (stop) stop.disabled = !running;
  }

  function renderActivity() {
    const list = $("#recent-activity");
    if (!list) return;
    list.innerHTML = app.activity.slice(0, 6).map(item => {
      const icon = item.type === "status" ? "✓" : item.type === "alert" ? "⚠" : "●";
      return `<li class="activity-item"><span class="activity-icon" aria-hidden="true">${icon}</span><div><p>${escapeHTML(item.message)}</p><time datetime="${escapeHTML(item.createdAt)}" title="${escapeHTML(formatDate(item.createdAt))}">${escapeHTML(formatRelative(item.createdAt))}</time></div></li>`;
    }).join("");
    const empty = $("#activity-empty");
    if (empty) empty.hidden = app.activity.length > 0;
  }

  function renderRepairHistory() {
    const list = $("#repair-history-list");
    if (!list) return;
    const updates = app.reports.flatMap(report => (report.history || []).map(item => ({
      ...item,
      location: report.location,
      reportId: report.id
    }))).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 10);
    list.innerHTML = updates.map(item =>
      `<li><div><strong>${escapeHTML(item.action)}</strong><span>${escapeHTML(item.location)} · ${escapeHTML(STATUS_LABELS[item.status] || "Report update")}</span></div><time datetime="${escapeHTML(item.createdAt)}">${escapeHTML(formatRelative(item.createdAt))}</time></li>`
    ).join("");
    const empty = $("#repair-history-empty");
    if (empty) empty.hidden = updates.length > 0;
  }

  function reportEventsInRange(metric, start, end) {
    if (metric === "high-risk") {
      const reports = app.reports.filter(report =>
        isActiveReport(report) && new Date(report.reportedAt) >= start && new Date(report.reportedAt) < end
      );
      return calculateLocationRisks(reports).filter(location => location.score >= 70).length;
    }
    return app.reports.reduce((count, report) => {
      if (metric === "total" && new Date(report.reportedAt) >= start && new Date(report.reportedAt) < end) return count + 1;
      if (metric === "unverified" && new Date(report.reportedAt) >= start && new Date(report.reportedAt) < end) {
        count += 1;
      }
      const history = (report.history || []).slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      let previousStatus = null;
      history.forEach(item => {
        if (!item.action.startsWith("Status changed")) {
          previousStatus = item.status;
          return;
        }
        const verifiedStatus = ["verified", "in-progress", "repaired"];
        const enteredVerified = verifiedStatus.includes(item.status) && !verifiedStatus.includes(previousStatus);
        const enteredPending = item.status === "pending" && previousStatus !== "pending";
        const inRange = new Date(item.createdAt) >= start && new Date(item.createdAt) < end;
        if (inRange && ((metric === "verified" && enteredVerified) ||
            (metric === "unverified" && enteredPending) ||
            (metric === "repaired" && item.status === "repaired" && previousStatus !== "repaired"))) count += 1;
        previousStatus = item.status;
      });
      return count;
    }, 0);
  }

  function formatChange(current, previous) {
    if (previous === 0) return current === 0 ? "0%" : "New";
    const change = Math.round(((current - previous) / previous) * 100);
    return `${change > 0 ? "+" : ""}${change}%`;
  }

  function initMap() {
    const mapNode = $("#road-map");
    const fallback = $("#map-fallback");
    if (!mapNode) return;
    if (!window.L) {
      if (fallback) {
        fallback.hidden = false;
        fallback.querySelector("p").textContent = "Map library unavailable.";
        fallback.querySelector("span:last-child").textContent = "Check your internet connection and reload the page.";
      }
      return;
    }
    try {
      app.map = L.map(mapNode, { scrollWheelZoom: false }).setView(
        [Number(app.settings.latitude), Number(app.settings.longitude)], 13
      );
    } catch (error) {
      console.error("RoadGuard: Could not initialize the map.", error);
      if (fallback) {
        fallback.hidden = false;
        fallback.querySelector("p").textContent = "Map could not be initialized.";
        fallback.querySelector("span:last-child").textContent = "Reports remain available in the authority table.";
      }
      return;
    }
    const tileLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors'
    });
    tileLayer.on("load", () => {
      if (fallback) fallback.hidden = true;
    });
    tileLayer.on("tileerror", () => {
      if (!fallback) return;
      fallback.hidden = false;
      fallback.querySelector("p").textContent = "Map tiles could not be loaded.";
      fallback.querySelector("span:last-child").textContent = "Check your internet connection. Saved reports are still available below.";
    });
    tileLayer.addTo(app.map);
    app.reportMarkers = typeof L.markerClusterGroup === "function"
      ? L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 44 }).addTo(app.map)
      : L.layerGroup().addTo(app.map);
    app.vehicleMarkers = L.layerGroup().addTo(app.map);
    window.setTimeout(() => app.map?.invalidateSize(), 100);
  }

  function reportPassesMapFilters(report) {
    const severity = $("#map-severity-filter")?.value || "all";
    const status = $("#map-status-filter")?.value || "all";
    const dateRange = $("#map-date-filter")?.value || "all";
    const query = String($("#map-search")?.value || "").trim().toLocaleLowerCase();
    const locationText = `${report.location} ${report.title} ${report.id}`.toLocaleLowerCase();
    const age = Date.now() - new Date(report.reportedAt).getTime();
    return (severity === "all" || normalizeSeverity(report.severity) === severity) &&
      (status === "all" || normalizeStatus(report.status) === status) &&
      (dateRange === "all" || (dateRange === "24h" && age <= 86_400_000) ||
        (dateRange === "7d" && age <= 7 * 86_400_000) ||
        (dateRange === "30d" && age <= 30 * 86_400_000)) &&
      (!query || locationText.includes(query));
  }

  function showReportDetails(report) {
    const target = $("#map-report-details");
    if (!target) return;
    app.selectedReportId = report.id;
    const status = normalizeStatus(report.status);
    const source = report.simulated ? "Simulated report" : "Manual report";
    const latestHistory = (report.history || []).slice(-3).reverse();
    target.innerHTML = `
      <div class="map-detail-heading"><div><p class="eyebrow">SELECTED HAZARD · ${escapeHTML(source)}</p><h3>${escapeHTML(report.title)}</h3></div><span class="risk-badge risk-badge-${status === "repaired" ? "low" : normalizeSeverity(report.severity)}">${escapeHTML(STATUS_LABELS[status])}</span></div>
      <p class="map-detail-location">${escapeHTML(report.location)}</p>
      <div class="map-detail-meta"><span><small>Coordinates</small>${Number(report.latitude).toFixed(5)}, ${Number(report.longitude).toFixed(5)}</span><span><small>Severity</small>${escapeHTML(normalizeSeverity(report.severity))}</span><span><small>Reported</small>${escapeHTML(formatDate(report.reportedAt))}</span><span><small>Repair assignment</small>${escapeHTML(report.repairAssignedTo || "Unassigned")}</span></div>
      ${report.description ? `<p class="map-detail-description">${escapeHTML(report.description)}</p>` : ""}
      ${report.repairNote ? `<p class="map-detail-note"><strong>Repair note:</strong> ${escapeHTML(report.repairNote)}</p>` : ""}
      <ol class="map-detail-history">${latestHistory.map(item => `<li>${escapeHTML(item.action)} · ${escapeHTML(formatRelative(item.createdAt))}</li>`).join("")}</ol>
      <a class="text-link" href="#authority">Open in authority portal <span aria-hidden="true">→</span></a>`;
  }

  function makeReportIcon(report) {
    const status = normalizeStatus(report.status);
    const severity = status === "repaired" ? "repaired" : normalizeSeverity(report.severity);
    return L.divIcon({
      className: "",
      html: `<span class="map-marker map-marker-${severity}" aria-hidden="true">${status === "repaired" ? "✓" : "!"}</span>`,
      iconSize: [21, 21],
      iconAnchor: [10, 10]
    });
  }

  function renderMap() {
    if (!app.map || !app.reportMarkers || !app.vehicleMarkers) return;
    app.reportMarkers.clearLayers();
    app.vehicleMarkers.clearLayers();
    const matching = app.reports.filter(reportPassesMapFilters);
    matching.forEach(report => {
      if (!Number.isFinite(Number(report.latitude)) || !Number.isFinite(Number(report.longitude))) return;
      const simulated = report.simulated
        ? '<span class="simulated-badge">SIMULATED REPORT</span>'
        : '<span class="simulated-badge">MANUAL REPORT</span>';
      const popup = `<div class="map-popup"><strong>${escapeHTML(report.title)}</strong><span>${escapeHTML(report.location)}</span><span>Coordinates: ${Number(report.latitude).toFixed(5)}, ${Number(report.longitude).toFixed(5)}</span><span>Severity: ${escapeHTML(normalizeSeverity(report.severity))}</span><span>Status: ${escapeHTML(STATUS_LABELS[normalizeStatus(report.status)])}</span><span>Reported: ${escapeHTML(formatDate(report.reportedAt))}</span>${report.repairNote ? `<span>Repair note: ${escapeHTML(report.repairNote)}</span>` : ""}${simulated}</div>`;
      const marker = L.marker([Number(report.latitude), Number(report.longitude)], { icon: makeReportIcon(report) })
        .bindPopup(popup)
        .on("click", () => showReportDetails(report));
      app.reportMarkers.addLayer(marker);
    });
    app.vehicles.forEach(vehicle => {
      const icon = L.divIcon({
        className: "",
        html: `<span class="map-vehicle-marker" aria-label="${escapeHTML(vehicle.name)} simulated vehicle">▣</span>`,
        iconSize: [25, 25],
        iconAnchor: [12, 12]
      });
      L.marker([vehicle.latitude, vehicle.longitude], { icon })
        .bindPopup(`<div class="map-popup"><strong>${escapeHTML(vehicle.name)} · ${escapeHTML(vehicle.id)}</strong><span>Simulated vehicle · ${app.timer ? "moving" : escapeHTML(app.simulationState)}</span><span>Speed: ${Math.round(vehicle.speed)} km/h</span><span>${vehicle.latitude.toFixed(5)}, ${vehicle.longitude.toFixed(5)}</span></div>`)
        .addTo(app.vehicleMarkers);
    });
    const query = String($("#map-search")?.value || "").trim().toLocaleLowerCase();
    if (app.selectedReportId) {
      const selected = matching.find(report => report.id === app.selectedReportId);
      if (selected) showReportDetails(selected);
      else {
        app.selectedReportId = null;
        const details = $("#map-report-details");
        if (details) details.innerHTML = '<div class="map-detail-empty"><strong>No selected report</strong><span>The selected report is hidden by the current map filters.</span></div>';
      }
    }
    if (query) {
      const match = matching[0];
      if (match) app.map.setView([Number(match.latitude), Number(match.longitude)], Math.max(app.map.getZoom(), 15));
    }
  }

  function severityFilterFromChart(severity) {
    const filter = $("#map-severity-filter");
    if (filter) filter.value = severity || "all";
    const mapSection = $("#live-map");
    mapSection?.scrollIntoView({ behavior: "smooth", block: "start" });
    renderMap();
  }

  function renderAnalytics(risks = calculateLocationRisks()) {
    const severityCounts = ["high", "medium", "low"].map(severity =>
      app.reports.filter(report => normalizeSeverity(report.severity) === severity).length
    );
    const severityLabels = ["High", "Medium", "Low"];
    const colors = [SEVERITY_COLORS.high, SEVERITY_COLORS.medium, SEVERITY_COLORS.low];
    const severityCanvas = $("#severity-chart");
    const severityFallback = $("#severity-chart-fallback");
    if (window.Chart && severityCanvas) {
      try {
        if (!app.charts.severity) {
          app.charts.severity = new Chart(severityCanvas, {
            type: "doughnut",
            data: { labels: severityLabels, datasets: [{ data: severityCounts, backgroundColor: colors, borderColor: "#101c2d", borderWidth: 3, hoverOffset: 5 }] },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              cutout: "64%",
              plugins: { legend: { display: false } },
              onClick: (_event, elements) => {
                if (elements.length) severityFilterFromChart(["high", "medium", "low"][elements[0].index]);
              }
            }
          });
        } else {
          app.charts.severity.data.datasets[0].data = severityCounts;
          app.charts.severity.update();
        }
        if (severityFallback) severityFallback.hidden = true;
      } catch (error) {
        console.error("RoadGuard: Could not render the severity chart.", error);
        if (severityFallback) {
          severityFallback.hidden = false;
          severityFallback.textContent = "Severity chart unavailable. Reports are still available in the table.";
        }
      }
    } else if (severityFallback) {
      severityFallback.hidden = false;
      severityFallback.textContent = "Chart library unavailable. Reports are still available in the table.";
    }
    const legend = $("#severity-legend");
    if (legend) {
      legend.innerHTML = severityLabels.map((label, index) =>
        `<button class="chart-filter-button" type="button" data-chart-severity="${["high", "medium", "low"][index]}"><i class="legend-dot" style="background:${colors[index]}"></i>${label} <strong>${severityCounts[index]}</strong></button>`
      ).join("");
    }

    const timelineCanvas = $("#timeline-chart");
    const timelineFallback = $("#timeline-chart-fallback");
    const period = $("#trend-period")?.value || "weekly";
    const now = new Date();
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    if (period === "daily") {
      const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      app.trendBuckets = Array.from({ length: 12 }, (_unused, index) => {
        const bucketStart = new Date(start.getTime() + index * 2 * 60 * 60 * 1000);
        const bucketEnd = new Date(bucketStart.getTime() + 2 * 60 * 60 * 1000);
        return {
          start: bucketStart,
          end: bucketEnd,
          label: bucketStart.toLocaleTimeString(undefined, { hour: "numeric" })
        };
      });
    } else if (period === "monthly") {
      const start = new Date(today);
      start.setDate(start.getDate() - 27);
      app.trendBuckets = Array.from({ length: 4 }, (_unused, index) => {
        const bucketStart = new Date(start);
        bucketStart.setDate(start.getDate() + index * 7);
        const bucketEnd = new Date(bucketStart);
        bucketEnd.setDate(bucketEnd.getDate() + 7);
        const bucketLastDay = new Date(bucketEnd.getTime() - 1);
        const label = `${bucketStart.toLocaleDateString(undefined, { month: "short", day: "numeric" })}–${bucketLastDay.toLocaleDateString(undefined, { day: "numeric" })}`;
        return { start: bucketStart, end: bucketEnd, label };
      });
    } else {
      app.trendBuckets = Array.from({ length: 7 }, (_unused, index) => {
        const bucketStart = new Date(today);
        bucketStart.setDate(today.getDate() - (6 - index));
        const bucketEnd = new Date(bucketStart);
        bucketEnd.setDate(bucketEnd.getDate() + 1);
        return {
          start: bucketStart,
          end: bucketEnd,
          label: bucketStart.toLocaleDateString(undefined, { weekday: "short" })
        };
      });
    }
    const trendCounts = app.trendBuckets.map(bucket => app.reports.filter(report => {
      const reported = new Date(report.reportedAt);
      return reported >= bucket.start && reported < bucket.end;
    }).length);
    const trendLabels = app.trendBuckets.map(bucket => bucket.label);
    if (window.Chart && timelineCanvas) {
      try {
        if (!app.charts.timeline) {
          app.charts.timeline = new Chart(timelineCanvas, {
            type: "bar",
            data: { labels: trendLabels, datasets: [{ data: trendCounts, backgroundColor: "#4b9cff", borderRadius: 4, maxBarThickness: 25 }] },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              plugins: { legend: { display: false } },
              scales: {
                x: { grid: { display: false }, ticks: { color: "#9aacc2", font: { size: 9 } } },
                y: { beginAtZero: true, ticks: { precision: 0, color: "#71849c", font: { size: 9 } }, grid: { color: "rgba(148,173,205,.12)" } }
              },
              onClick: (_event, elements) => {
                if (!elements.length) return;
                const bucket = app.trendBuckets[elements[0].index];
                if (!bucket) return;
                app.selectedRange = { start: bucket.start, end: bucket.end, label: bucket.label };
                const search = $("#report-search");
                const status = $("#report-filter");
                if (search) search.value = "";
                if (status) status.value = "all";
                renderReports();
                $("#authority")?.scrollIntoView({ behavior: "smooth", block: "start" });
              }
            }
          });
        } else {
          app.charts.timeline.data.labels = trendLabels;
          app.charts.timeline.data.datasets[0].data = trendCounts;
          app.charts.timeline.update();
        }
        if (timelineFallback) timelineFallback.hidden = true;
      } catch (error) {
        console.error("RoadGuard: Could not render the report trend chart.", error);
        if (timelineFallback) {
          timelineFallback.hidden = false;
          timelineFallback.textContent = "Trend chart unavailable. Reports are still available in the table.";
        }
      }
    } else if (timelineFallback) {
      timelineFallback.hidden = false;
      timelineFallback.textContent = "Chart library unavailable.";
    }

    const top = risks[0];
    const title = $("#top-risk-location");
    const explanation = $("#top-risk-explanation");
    if (title) title.textContent = top ? top.location : "No high-priority location";
    if (explanation) {
      explanation.textContent = top
        ? `${top.score}/100 · severity ${top.severityPoints} + repeat reports ${top.repeatPoints} + recency ${top.recencyPoints} (${top.reports.length} active report${top.reports.length === 1 ? "" : "s"}).`
        : "Locations are ranked by severity, report count, and report recency.";
    }
    const list = $("#priority-list");
    const empty = $("#priority-empty");
    if (list) {
      const topRisks = risks.filter(location => location.score >= 50).slice(0, 6);
      list.innerHTML = topRisks.map(location =>
        `<li class="priority-row"><span class="priority-location"><strong>${escapeHTML(location.location)}</strong><span>Severity ${escapeHTML(location.severity)} · ${location.reports.length} report${location.reports.length === 1 ? "" : "s"} · severity ${location.severityPoints} + repeats ${location.repeatPoints} + recency ${location.recencyPoints}</span></span><strong class="priority-score">${location.score}</strong></li>`
      ).join("");
      if (empty) empty.hidden = risks.length > 0;
    }
  }

  function renderVehicles() {
    const target = $("#vehicle-list");
    if (!target) return;
    target.innerHTML = app.vehicles.map(vehicle => {
      const detections = app.reports.filter(report => report.detectedBy === vehicle.id)
        .sort((a, b) => new Date(b.reportedAt) - new Date(a.reportedAt));
      const status = app.timer ? "Moving" : app.simulationState === "paused" ? "Paused" : "Standby";
      const lastDetection = detections[0];
      return `
        <article class="vehicle-card" data-vehicle-id="${escapeHTML(vehicle.id)}">
          <div class="vehicle-card-heading"><strong>${escapeHTML(vehicle.name)}</strong><span class="vehicle-badge">SIMULATED</span></div>
          <p class="vehicle-id">ID · ${escapeHTML(vehicle.id)}</p>
          <p>${vehicle.latitude.toFixed(5)}, ${vehicle.longitude.toFixed(5)}</p>
          <div class="vehicle-meta-row"><span>${Math.round(vehicle.speed)} km/h</span><span class="vehicle-status${app.timer ? "" : " is-stopped"}"><i class="status-dot"></i>${status}</span></div>
          <p>Last detection: ${lastDetection ? escapeHTML(formatRelative(lastDetection.reportedAt)) : "No reports yet"}</p>
          <div class="vehicle-detection-history"><strong>${detections.length} detection${detections.length === 1 ? "" : "s"}</strong>${detections.slice(0, 2).map(report =>
            `<button type="button" data-vehicle-report-id="${escapeHTML(report.id)}">${escapeHTML(report.location)} · ${escapeHTML(formatRelative(report.reportedAt))}</button>`
          ).join("") || "<span>No simulated detections</span>"}</div>
        </article>`;
    }).join("");
    updateDashboard(calculateLocationRisks());
  }

  function renderAlerts() {
    const history = $("#alert-history");
    if (!history) return;
    history.innerHTML = app.alerts.slice(0, 12).map(alert => `
      <li class="alert-history-item">
        <span class="alert-history-icon" aria-hidden="true">⚠</span>
        <div><p><strong>${escapeHTML(alert.type)}</strong> · ${escapeHTML(alert.vehicleName)} received a ${escapeHTML(alert.severity)}-severity hazard warning at ${escapeHTML(alert.location)}.</p><time datetime="${escapeHTML(alert.createdAt)}" title="${escapeHTML(formatDate(alert.createdAt))}">${escapeHTML(formatRelative(alert.createdAt))}</time></div>
        <span class="alert-distance">${Number(alert.distanceKm).toFixed(2)} km · simulated</span>
      </li>`).join("");
    const empty = $("#alert-empty");
    if (empty) empty.hidden = app.alerts.length > 0;
    const summary = $("#alerts-summary");
    if (summary) summary.textContent = app.alerts.length
      ? `${app.alerts.length} simulated alert${app.alerts.length === 1 ? "" : "s"} recorded · nearest vehicle alerts are limited to ${ALERT_RADIUS_KM} km.`
      : "No nearby hazard alerts yet.";
  }

  function haversineKm(lat1, lon1, lat2, lon2) {
    const toRad = degrees => degrees * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function playWarningTone() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    try {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = 740;
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.35);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.36);
      oscillator.addEventListener("ended", () => context.close(), { once: true });
    } catch (error) {
      console.warn("RoadGuard: Could not play the optional alert tone.", error);
    }
  }

  function createNearbyAlert(report, vehicle, distanceKm) {
    const key = `${report.id}:${vehicle.id}`;
    if (app.alertKeys.has(key)) return;
    app.alertKeys.add(key);
    const alert = {
      id: makeId(),
      reportId: report.id,
      vehicleId: vehicle.id,
      vehicleName: vehicle.name,
      type: "Pothole",
      severity: normalizeSeverity(report.severity),
      location: report.location,
      distanceKm,
      createdAt: new Date().toISOString(),
      simulated: true
    };
    app.alerts.unshift(alert);
    app.alerts = app.alerts.slice(0, MAX_HISTORY);
    writeJSON(STORAGE.alerts, app.alerts);
    renderAlerts();
    addActivity(`${vehicle.name} received a ${alert.severity}-severity alert near ${alert.location}.`, "alert");
    showMessage(`Simulated hazard alert for ${vehicle.name}: ${alert.location} (${distanceKm.toFixed(2)} km).`, "warning");
    if (app.settings.audibleAlerts) playWarningTone();
  }

  function checkNearbyHazards() {
    if (!app.timer) return;
    app.reports.filter(isActiveReport).forEach(report => {
      app.vehicles.forEach(vehicle => {
        if (report.detectedBy === vehicle.id) return;
        const distance = haversineKm(
          vehicle.latitude, vehicle.longitude,
          Number(report.latitude), Number(report.longitude)
        );
        if (distance <= ALERT_RADIUS_KM) createNearbyAlert(report, vehicle, distance);
      });
    });
  }

  function saveVehicles() {
    writeJSON(STORAGE.vehicles, app.vehicles);
  }

  function moveVehicles() {
    app.vehicles.forEach(vehicle => {
      const radians = vehicle.heading * Math.PI / 180;
      vehicle.latitude += Math.cos(radians) * 0.00028;
      vehicle.longitude += Math.sin(radians) * 0.00038;
      if (Math.random() < 0.14) vehicle.heading = (vehicle.heading + Math.random() * 100 - 50 + 360) % 360;
      vehicle.latitude = Math.max(-89.999, Math.min(89.999, vehicle.latitude));
      vehicle.longitude = Math.max(-179.999, Math.min(179.999, vehicle.longitude));
      vehicle.speed = Math.max(10, Math.min(55, vehicle.speed + Math.round(Math.random() * 6 - 3)));
    });
    app.simulationTicks += 1;
    saveVehicles();
    renderVehicles();
    renderMap();
    checkNearbyHazards();
    if (app.simulationTicks % 5 === 0 && Math.random() < 0.35) generateSimulatedReport();
  }

  function addReport(report) {
    report.history = [{
      action: "Report created",
      status: normalizeStatus(report.status),
      createdAt: report.reportedAt,
      note: ""
    }];
    app.reports.unshift(report);
    if (!saveReports()) {
      app.reports.shift();
      return false;
    }
    addActivity(`${report.simulated ? "Simulated detection" : "New manual report"}: ${report.location}.`, "report");
    renderReports();
    checkNearbyHazards();
    return true;
  }

  function generateSimulatedReport() {
    const vehicle = app.vehicles[Math.floor(Math.random() * app.vehicles.length)];
    const severity = ["low", "medium", "high"][Math.floor(Math.random() * 3)];
    const latitude = vehicle.latitude + (Math.random() - 0.5) * 0.0012;
    const longitude = vehicle.longitude + (Math.random() - 0.5) * 0.0012;
    const reportedAt = new Date().toISOString();
    const report = {
      id: makeId(),
      title: "Simulated pothole detection",
      location: `Simulated road location near ${vehicle.name}`,
      latitude,
      longitude,
      severity,
      status: "pending",
      description: `Generated by ${vehicle.name} for demonstration. This is not a real hardware detection.`,
      reportedAt,
      simulated: true,
      detectedBy: vehicle.id
    };
    if (!addReport(report)) return null;
    vehicle.lastReportAt = reportedAt;
    saveVehicles();
    showMessage(`Simulated ${severity}-severity pothole report generated by ${vehicle.name}.`, severity === "high" ? "warning" : "success");
    renderVehicles();
    return report;
  }

  function startSimulation() {
    if (app.timer) return;
    app.simulationState = "running";
    app.timer = window.setInterval(moveVehicles, SIMULATION_INTERVAL_MS);
    renderVehicles();
    renderMap();
    checkNearbyHazards();
    showMessage("Vehicle simulation started. All vehicle activity and detections are simulated.", "info");
  }

  function pauseSimulation() {
    if (!app.timer) return;
    window.clearInterval(app.timer);
    app.timer = null;
    app.simulationState = "paused";
    renderVehicles();
    renderMap();
    showMessage("Vehicle simulation paused. Positions and reports are retained.", "info");
  }

  function resetSimulation() {
    if (app.timer) window.clearInterval(app.timer);
    app.timer = null;
    app.simulationState = "stopped";
    app.simulationTicks = 0;
    app.vehicles = DEFAULT_VEHICLES.map(vehicle => ({ ...vehicle }));
    saveVehicles();
    renderVehicles();
    renderMap();
    showMessage("Vehicle positions reset. Saved reports and history were retained.", "info");
  }

  function setReportStatus(id, value) {
    const report = app.reports.find(item => item.id === id);
    if (!report) {
      showMessage("That report could not be found. Refresh the report list and try again.", "error");
      return false;
    }
    const status = normalizeStatus(value);
    if (!Object.hasOwn(STATUS_LABELS, status)) {
      showMessage("Choose a valid report status.", "error");
      return false;
    }
    const previous = normalizeStatus(report.status);
    const previousVerifiedAt = report.verifiedAt;
    report.status = status;
    report.updatedAt = new Date().toISOString();
    if (["verified", "in-progress", "repaired"].includes(status) && !report.verifiedAt) {
      report.verifiedAt = report.updatedAt;
    }
    if (status === "pending") delete report.verifiedAt;
    report.history ||= [];
    report.history.push({
      action: `Status changed to ${STATUS_LABELS[status]}`,
      status,
      createdAt: report.updatedAt,
      note: ""
    });
    if (!saveReports()) {
      report.status = previous;
      report.verifiedAt = previousVerifiedAt;
      report.history.pop();
      return false;
    }
    addActivity(`${report.title} status changed from ${STATUS_LABELS[previous]} to ${STATUS_LABELS[status]}.`, "status");
    renderReports();
    showMessage(`Report status updated to ${STATUS_LABELS[status]}.`, "success");
    return true;
  }

  function saveRepairNote(id) {
    const report = app.reports.find(item => item.id === id);
    const input = $$("[data-repair-note]").find(item => item.dataset.repairNote === id);
    if (!report || !input) {
      showMessage("Could not save this repair note. Refresh the report list and try again.", "error");
      return;
    }
    const previousNote = report.repairNote;
    report.repairNote = String(input.value || "").trim().slice(0, 240);
    report.updatedAt = new Date().toISOString();
    report.history ||= [];
    report.history.push({
      action: "Repair note updated",
      status: normalizeStatus(report.status),
      createdAt: report.updatedAt,
      note: report.repairNote
    });
    if (!saveReports()) {
      report.repairNote = previousNote;
      report.history.pop();
      renderReports();
      return;
    }
    addActivity(`Repair note updated for ${report.location}.`, "status");
    renderReports();
    showMessage("Repair note saved.", "success");
  }

  function saveRepairAssignment(id, assignment) {
    const report = app.reports.find(item => item.id === id);
    if (!report || (assignment && !REPAIR_TEAMS.includes(assignment))) {
      showMessage("Choose a valid repair crew for this report.", "error");
      renderReports();
      return;
    }
    const previous = report.repairAssignedTo || "";
    report.repairAssignedTo = assignment;
    report.updatedAt = new Date().toISOString();
    report.history ||= [];
    report.history.push({
      action: assignment ? `Assigned to ${assignment}` : "Repair assignment cleared",
      status: normalizeStatus(report.status),
      createdAt: report.updatedAt,
      note: ""
    });
    if (!saveReports()) {
      report.repairAssignedTo = previous;
      report.history.pop();
      renderReports();
      return;
    }
    addActivity(`${report.location} ${assignment ? `assigned to ${assignment}` : "repair assignment cleared"}.`, "status");
    renderReports();
    showMessage(assignment ? `Assigned to ${assignment}.` : "Repair assignment cleared.", "success");
  }

  function submitReport(form) {
    const locationField = form.elements.namedItem("location");
    const latitudeField = form.elements.namedItem("latitude");
    const longitudeField = form.elements.namedItem("longitude");
    const severityField = form.elements.namedItem("severity");
    const error = $("#report-form-error");
    const fail = message => {
      if (error) {
        error.textContent = message;
        error.hidden = false;
      }
      showMessage(message, "error");
    };
    const location = String(locationField?.value || "").trim();
    const latitude = Number(latitudeField?.value);
    const longitude = Number(longitudeField?.value);
    const severity = String(severityField?.value || "");
    if (!location) return fail("Enter a road or location before submitting.");
    if (!String(latitudeField?.value || "").trim() || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      return fail("Enter a valid latitude between -90 and 90.");
    }
    if (!String(longitudeField?.value || "").trim() || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      return fail("Enter a valid longitude between -180 and 180.");
    }
    if (!["low", "medium", "high"].includes(severity)) return fail("Choose a valid severity.");
    if (error) error.hidden = true;
    const description = String(form.elements.namedItem("description")?.value || "").trim();
    const report = {
      id: makeId(),
      title: `${severity[0].toUpperCase()}${severity.slice(1)} severity pothole`,
      location,
      latitude,
      longitude,
      severity,
      status: "pending",
      description,
      reportedAt: new Date().toISOString(),
      simulated: false
    };
    if (!addReport(report)) return;
    form.reset();
    latitudeField.value = String(app.settings.latitude);
    longitudeField.value = String(app.settings.longitude);
    showMessage("Manual pothole report saved and added to the map.", "success");
  }

  const WEATHER_DESCRIPTIONS = {
    0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Depositing rime fog", 51: "Light drizzle", 53: "Drizzle",
    55: "Dense drizzle", 56: "Freezing drizzle", 57: "Heavy freezing drizzle",
    61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain",
    67: "Heavy freezing rain", 71: "Light snow", 73: "Snow", 75: "Heavy snow",
    77: "Snow grains", 80: "Rain showers", 81: "Showers", 82: "Heavy showers",
    85: "Snow showers", 86: "Heavy snow showers", 95: "Thunderstorm",
    96: "Thunderstorm with hail", 99: "Severe thunderstorm with hail"
  };

  function weatherDescription(code) {
    return WEATHER_DESCRIPTIONS[code] || "Conditions reported by Open-Meteo";
  }

  function weatherIcon(code) {
    if (code === 0 || code === 1) return "☀";
    if ([2, 3].includes(code)) return "☁";
    if ([45, 48].includes(code)) return "≋";
    if (code >= 71 && code <= 86) return "❄";
    if (code >= 95) return "ϟ";
    return "☂";
  }

  function renderWeather(message = "") {
    const target = $("#weather-info");
    if (!target) return;
    if (message) {
      target.innerHTML = `<p class="weather-message">${escapeHTML(message)}</p>`;
      return;
    }
    if (!app.weather) {
      target.innerHTML = '<p class="weather-message">Weather data is not available yet. Try refreshing.</p>';
      return;
    }
    target.innerHTML = `
      <div class="weather-current"><span class="weather-current-icon" aria-hidden="true">${weatherIcon(app.weather.code)}</span><div><strong>${escapeHTML(app.weather.temperature)}°C</strong><p>${escapeHTML(app.weather.description)}</p></div></div>
      <div class="weather-detail-grid">
        <div><span>Rainfall</span><strong>${escapeHTML(app.weather.precipitation)} mm</strong></div>
        <div><span>Wind</span><strong>${escapeHTML(app.weather.wind)} km/h</strong></div>
        <div><span>Updated</span><strong>${escapeHTML(formatRelative(app.weather.updatedAt))}</strong></div>
      </div>`;
  }

  async function loadWeather() {
    const latitudeInput = $("#weather-latitude");
    const longitudeInput = $("#weather-longitude");
    const latitude = Number(latitudeInput?.value);
    const longitude = Number(longitudeInput?.value);
    if (!String(latitudeInput?.value || "").trim() || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      renderWeather("Enter a valid latitude between -90 and 90.");
      return;
    }
    if (!String(longitudeInput?.value || "").trim() || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      renderWeather("Enter a valid longitude between -180 and 180.");
      return;
    }
    app.settings.latitude = latitude;
    app.settings.longitude = longitude;
    saveSettings();
    const requestId = ++app.weatherRequest;
    renderWeather("Loading current weather from Open-Meteo…");
    const button = $("#refresh-weather");
    if (button) button.disabled = true;
    try {
      const url = new URL("https://api.open-meteo.com/v1/forecast");
      url.search = new URLSearchParams({
        latitude: String(latitude),
        longitude: String(longitude),
        current: "temperature_2m,precipitation,weather_code,wind_speed_10m",
        timezone: "auto"
      }).toString();
      const response = await fetch(url.toString(), { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`Open-Meteo returned HTTP ${response.status}.`);
      const result = await response.json();
      const current = result?.current;
      if (!current || !Number.isFinite(Number(current.temperature_2m)) ||
          !Number.isFinite(Number(current.precipitation)) ||
          !Number.isFinite(Number(current.wind_speed_10m)) ||
          !Number.isFinite(Number(current.weather_code))) {
        throw new Error("Open-Meteo returned incomplete current conditions.");
      }
      if (requestId !== app.weatherRequest) return;
      app.weather = {
        temperature: Number(current.temperature_2m).toFixed(1),
        precipitation: Number(current.precipitation).toFixed(1),
        wind: Number(current.wind_speed_10m).toFixed(1),
        code: Number(current.weather_code),
        description: weatherDescription(Number(current.weather_code)),
        updatedAt: new Date().toISOString()
      };
      renderWeather();
    } catch (error) {
      if (requestId !== app.weatherRequest) return;
      console.error("RoadGuard: Weather request failed.", error);
      renderWeather("Weather could not be loaded. Check your connection and try again.");
      showMessage("Weather service is unavailable. Your report data is unaffected.", "error");
    } finally {
      if (requestId === app.weatherRequest && button) button.disabled = false;
    }
  }

  function clearFilters() {
    app.selectedRange = null;
    ["#report-search", "#map-search"].forEach(selector => {
      const input = $(selector);
      if (input) input.value = "";
    });
    ["#report-filter", "#map-severity-filter", "#map-status-filter", "#map-date-filter"].forEach(selector => {
      const select = $(selector);
      if (select) select.value = "all";
    });
    renderReports();
  }

  function wireNavigation() {
    const sidebar = $("#sidebar");
    const menuButton = $("#menu-button");
    menuButton?.addEventListener("click", () => {
      const isOpen = sidebar?.classList.toggle("is-open") || false;
      menuButton.setAttribute("aria-expanded", String(isOpen));
      menuButton.setAttribute("aria-label", isOpen ? "Close navigation" : "Open navigation");
    });
    document.addEventListener("click", event => {
      const link = event.target.closest("a[href^='#']");
      if (!link) return;
      const id = decodeURIComponent(link.getAttribute("href").slice(1));
      const target = document.getElementById(id);
      if (!target) return;
      const activeLink = $$(".nav-link").find(item => item.getAttribute("href") === `#${id}`);
      $$(".nav-link").forEach(item => item.classList.toggle("active", item === activeLink));
      const breadcrumb = $("#breadcrumb-current");
      if (breadcrumb) breadcrumb.textContent = activeLink?.textContent.trim() || link.textContent.trim() || "Dashboard";
      sidebar?.classList.remove("is-open");
      menuButton?.setAttribute("aria-expanded", "false");
      menuButton?.setAttribute("aria-label", "Open navigation");
    });
    if ("IntersectionObserver" in window) {
      const sections = ["dashboard", "live-map", "vehicle-network", "alerts", "weather", "analytics", "authority"]
        .map(id => document.getElementById(id)).filter(Boolean);
      const observer = new IntersectionObserver(entries => {
        const visible = entries.filter(entry => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (!visible) return;
        const activeLink = $(`.nav-link[href="#${visible.target.id}"]`);
        if (activeLink) {
          $$(".nav-link").forEach(item => item.classList.toggle("active", item === activeLink));
          const breadcrumb = $("#breadcrumb-current");
          if (breadcrumb) breadcrumb.textContent = activeLink.textContent.trim();
        }
      }, { rootMargin: "-18% 0px -65% 0px", threshold: [0, 0.1, 0.4] });
      sections.forEach(section => observer.observe(section));
    }
  }

  function wireEvents() {
    $("#report-form")?.addEventListener("submit", event => {
      event.preventDefault();
      submitReport(event.currentTarget);
    });
    $("#weather-form")?.addEventListener("submit", event => {
      event.preventDefault();
      loadWeather();
    });
    $("#start-simulation")?.addEventListener("click", startSimulation);
    $("#stop-simulation")?.addEventListener("click", pauseSimulation);
    $("#reset-simulation")?.addEventListener("click", resetSimulation);
    $("#generate-report")?.addEventListener("click", generateSimulatedReport);

    $("#report-search")?.addEventListener("input", () => {
      app.selectedRange = null;
      renderReports();
    });
    $("#report-filter")?.addEventListener("change", () => {
      app.selectedRange = null;
      renderReports();
    });
    $("#map-search")?.addEventListener("input", renderMap);
    $$("[data-map-filter]").forEach(select => select.addEventListener("change", renderMap));
    $("#clear-report-filters")?.addEventListener("click", clearFilters);
    $("#trend-period")?.addEventListener("change", () => renderAnalytics());
    $("#vehicle-list")?.addEventListener("click", event => {
      const button = event.target.closest("[data-vehicle-report-id]");
      if (!button) return;
      const report = app.reports.find(item => item.id === button.dataset.vehicleReportId);
      if (!report || !app.map) return;
      ["#map-search", "#map-severity-filter", "#map-status-filter", "#map-date-filter"].forEach(selector => {
        const control = $(selector);
        if (control) control.value = selector === "#map-search" ? "" : "all";
      });
      renderMap();
      app.map.setView([report.latitude, report.longitude], Math.max(app.map.getZoom(), 15));
      showReportDetails(report);
      $("#live-map")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    $("#audio-alert-toggle")?.addEventListener("change", event => {
      app.settings.audibleAlerts = event.currentTarget.checked;
      saveSettings();
      showMessage(`Audible warnings ${app.settings.audibleAlerts ? "enabled" : "disabled"}.`, "info");
      if (app.settings.audibleAlerts) playWarningTone();
    });
    $("#reports-table-body")?.addEventListener("change", event => {
      const select = event.target.closest("[data-report-status]");
      if (select) setReportStatus(select.dataset.reportStatus, select.value);
      const assignment = event.target.closest("[data-repair-assignment]");
      if (assignment) saveRepairAssignment(assignment.dataset.repairAssignment, assignment.value);
    });
    $("#reports-table-body")?.addEventListener("click", event => {
      const button = event.target.closest("[data-report-action]");
      if (!button) return;
      const id = button.dataset.reportId;
      if (button.dataset.reportAction === "verify") setReportStatus(id, "verified");
      if (button.dataset.reportAction === "reject") setReportStatus(id, "rejected");
      if (button.dataset.reportAction === "save-note") saveRepairNote(id);
    });
    $("#severity-legend")?.addEventListener("click", event => {
      const button = event.target.closest("[data-chart-severity]");
      if (button) severityFilterFromChart(button.dataset.chartSeverity);
    });
    wireNavigation();
  }

  function exposeActions() {
    window.RoadGuard = Object.freeze({
      getReports: () => app.reports.map(report => ({ ...report })),
      getVehicles: () => app.vehicles.map(vehicle => ({ ...vehicle })),
      getAlerts: () => app.alerts.map(alert => ({ ...alert })),
      submitSimulatedReport: generateSimulatedReport,
      startSimulation,
      pauseSimulation,
      stopSimulation: pauseSimulation,
      resetSimulation,
      refreshWeather: loadWeather,
      calculateRiskPriority: riskScoreFor,
      updateReportStatus: setReportStatus
    });
  }

  function initialize() {
    loadState();
    initMap();
    renderReports();
    renderVehicles();
    renderAlerts();
    wireEvents();
    exposeActions();
    checkNearbyHazards();
    loadWeather();
    app.weatherTimer = window.setInterval(loadWeather, WEATHER_REFRESH_MS);
    showMessage("RoadGuard ready. Vehicle activity and sample detections are labeled as simulated.", "info");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})();
