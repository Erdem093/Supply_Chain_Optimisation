function parseCsvLine(line) {
  const values = [];
  let token = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        token += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      values.push(token);
      token = "";
    } else {
      token += ch;
    }
  }

  values.push(token);
  return values.map((v) => v.trim());
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = values[idx] || "";
    });
    return row;
  });
}

const aliases = {
  origin: ["origin", "manufacturing_site", "source", "from", "origin_country", "site"],
  destination: ["destination", "country", "destination_country", "to", "geography", "region"],
  freight_cost: ["freight_cost_usd", "freight_cost", "freight cost usd", "cost", "transport_cost"],
  carrier: ["carrier", "fulfill_via", "vendor", "shipment_mode"],
  shipment_id: ["shipment_id", "id", "asn_dn", "po_so", "pq"]
};

function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .trim()
    .replace(/[()#]/g, "")
    .replace(/[\s/-]+/g, "_");
}

function mapUploadColumns(rows) {
  if (!rows.length) return null;

  const headers = Object.keys(rows[0]);
  const map = {};
  for (const [key, keys] of Object.entries(aliases)) {
    for (const h of headers) {
      if (keys.includes(normalizeName(h))) {
        map[key] = h;
        break;
      }
    }
  }

  return map;
}

async function loadCsv(path, required = true) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) {
    if (required) throw new Error(`Missing required CSV: ${path}`);
    return null;
  }
  return parseCsv(await res.text());
}

async function loadJson(path, required = true) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) {
    if (required) throw new Error(`Missing required JSON: ${path}`);
    return null;
  }
  return res.json();
}

function n(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value) {
  return n(value).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2
  });
}

function pct(value) {
  return `${n(value).toFixed(2)}%`;
}

function webglSupported() {
  try {
    const canvas = document.createElement("canvas");
    return !!(window.WebGLRenderingContext && canvas.getContext("webgl"));
  } catch (_err) {
    return false;
  }
}

function normalizeText(value) {
  return String(value || "").trim();
}

function hashCode(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function pseudoCoord(name) {
  const h = hashCode(name);
  const lat = ((h % 14000) / 100) - 70;
  const lon = (((h / 14000) % 36000) / 100) - 180;
  return { lat, lon, pseudo: true };
}

const state = {
  baselineRows: [],
  scenarioRows: [],
  driverRows: [],
  routeRows: [],
  metadata: null,
  coords: {},
  selectedScenario: "baseline",
  selectedCarrier: "all",
  topN: 12,
  globe: null,
  map: null,
  mapLayers: [],
  rotating: true,
  uploadMode: false
};

function getBaselineCost() {
  const row = state.baselineRows.find((r) => r.metric === "total_logistics_cost");
  return row ? n(row.value) : 0;
}

function getScenario(name) {
  return state.scenarioRows.find((r) => r.scenario === name) || null;
}

function adjustedFactor() {
  if (state.uploadMode || state.selectedScenario === "baseline") return 1;
  const s = getScenario(state.selectedScenario);
  return s ? Math.max(0, 1 - n(s.savings_pct) / 100) : 1;
}

function withAdjustedCost() {
  const factor = adjustedFactor();
  return state.routeRows.map((r) => ({
    ...r,
    adjusted_cost: n(r.total_cost) * factor,
    carrier_norm: normalizeText(r.carrier)
  }));
}

function filteredRoutes() {
  return withAdjustedCost()
    .filter((r) => (state.selectedCarrier === "all" ? true : normalizeText(r.carrier_norm) === state.selectedCarrier))
    .sort((a, b) => b.adjusted_cost - a.adjusted_cost)
    .slice(0, state.topN);
}

function coordFor(name) {
  const key = normalizeText(name);
  const known = state.coords[key];
  if (known) return { lat: n(known.lat), lon: n(known.lon), pseudo: false };
  return pseudoCoord(key);
}

function wrapLon(lon) {
  let v = lon;
  while (v > 180) v -= 360;
  while (v < -180) v += 360;
  return v;
}

function buildSweepPath(origin, destination) {
  const o = coordFor(origin);
  const d = coordFor(destination);

  const midLat = (o.lat + d.lat) / 2;
  const midLon = wrapLon((o.lon + d.lon) / 2);
  const lonDiff = Math.abs(o.lon - d.lon);
  const useSweep = lonDiff < 70;

  if (!useSweep) {
    return [
      { lat: o.lat, lng: o.lon, altitude: 0.02 },
      { lat: d.lat, lng: d.lon, altitude: 0.02 }
    ];
  }

  const sweepLon = wrapLon(midLon + 170);
  const sweepLat = Math.max(-70, Math.min(70, -midLat * 0.4));

  return [
    { lat: o.lat, lng: o.lon, altitude: 0.02 },
    { lat: sweepLat, lng: sweepLon, altitude: 0.45 },
    { lat: d.lat, lng: d.lon, altitude: 0.02 }
  ];
}

function toPathData(rows) {
  return rows.map((r) => ({
    points: buildSweepPath(r.origin, r.destination),
    color: n(r.adjusted_cost) > 5000 ? "#f97316" : n(r.adjusted_cost) > 2000 ? "#fb7185" : "#60a5fa",
    width: n(r.adjusted_cost) > 5000 ? 1.1 : n(r.adjusted_cost) > 2000 ? 0.8 : 0.55,
    label: `${r.origin} -> ${r.destination} (${r.carrier})\n${money(r.adjusted_cost)} | ${r.shipment_count} shipments`
  }));
}

function setModeBadge() {
  const badge = document.getElementById("mode-badge");
  badge.textContent = state.uploadMode ? "UPLOADED MODE" : "DEMO MODE";
  badge.classList.toggle("mode-badge--upload", state.uploadMode);
}

function updateImpactHeader() {
  const baseline = getBaselineCost();
  const top = [...state.routeRows].sort((a, b) => n(b.total_cost) - n(a.total_cost))[0];
  const best = [...state.scenarioRows].sort((a, b) => n(b.absolute_savings) - n(a.absolute_savings))[0];
  const freshness = state.metadata?.generated_at
    ? new Date(state.metadata.generated_at).toLocaleString()
    : state.uploadMode
      ? "Uploaded session"
      : "Unknown";

  document.getElementById("impact-baseline").textContent = baseline ? money(baseline) : "--";
  document.getElementById("impact-savings").textContent = state.uploadMode
    ? "Run Python model"
    : best
      ? `${money(best.absolute_savings)} (${pct(best.savings_pct)})`
      : "--";
  document.getElementById("impact-top-lane").textContent = top ? `${top.origin} -> ${top.destination}` : "--";
  document.getElementById("impact-freshness").textContent = freshness;

  const confidence = document.getElementById("impact-confidence");
  confidence.textContent = state.uploadMode
    ? "Confidence: uploaded CSV processed locally in browser. No data leaves your device."
    : "Confidence: pipeline outputs reconciled with route-level network.";
}

function buildFilters() {
  const scenario = document.getElementById("scenario-filter");
  const carrier = document.getElementById("carrier-filter");

  scenario.innerHTML = "";
  const base = document.createElement("option");
  base.value = "baseline";
  base.textContent = "Baseline";
  scenario.appendChild(base);

  if (!state.uploadMode) {
    state.scenarioRows.forEach((r) => {
      const opt = document.createElement("option");
      opt.value = r.scenario;
      opt.textContent = r.scenario.replaceAll("_", " ");
      scenario.appendChild(opt);
    });
  }

  carrier.innerHTML = "";
  const all = document.createElement("option");
  all.value = "all";
  all.textContent = "All carriers";
  carrier.appendChild(all);

  [...new Set(state.routeRows.map((r) => normalizeText(r.carrier)).filter(Boolean))]
    .sort()
    .forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c;
      opt.textContent = c;
      carrier.appendChild(opt);
    });

  scenario.value = state.selectedScenario;
  carrier.value = state.selectedCarrier;
  scenario.disabled = state.uploadMode;
}

function renderScenarioList() {
  const el = document.getElementById("scenario-list");
  if (state.uploadMode) {
    el.innerHTML = '<p class="empty">Scenario modeling is not run in browser upload mode. Use Python pipeline for full simulations.</p>';
    return;
  }
  if (!state.scenarioRows.length) {
    el.innerHTML = '<p class="empty">Scenario outputs missing: outputs/tables/scenario_results.csv</p>';
    return;
  }

  el.innerHTML = state.scenarioRows
    .slice()
    .sort((a, b) => n(b.absolute_savings) - n(a.absolute_savings))
    .map(
      (r, i) => `
      <article class="scenario-item ${state.selectedScenario === r.scenario ? "scenario-item--active" : ""}">
        <div class="scenario-item__head"><strong>#${i + 1} ${r.scenario.replaceAll("_", " ")}</strong><span>${money(r.absolute_savings)}</span></div>
        <p>Savings ${pct(r.savings_pct)} | Risk ${String(r.risk_level).toUpperCase()}</p>
      </article>
    `
    )
    .join("");
}

function renderDriverList() {
  const box = document.getElementById("driver-list");
  if (!state.driverRows.length) {
    box.innerHTML = '<p class="empty">Driver outputs unavailable for current mode.</p>';
    return;
  }

  box.innerHTML = state.driverRows
    .slice(0, 8)
    .map(
      (r) => `
      <article class="driver-item">
        <strong>${String(r.source_table || "driver").replace("by_", "").replaceAll("_", " ")}: ${r.driver_value}</strong>
        <p>${money(r.total_cost)} | ${pct(r.cost_share_pct)} share</p>
      </article>
    `
    )
    .join("");
}

function renderComparisonPanel() {
  const baseline = getBaselineCost();
  const s = state.uploadMode || state.selectedScenario === "baseline" ? null : getScenario(state.selectedScenario);
  const scenarioCost = s ? n(s.scenario_cost) : baseline;
  const savings = baseline - scenarioCost;
  const savingsPct = baseline ? (savings / baseline) * 100 : 0;

  document.getElementById("compare-baseline").textContent = money(baseline);
  document.getElementById("compare-scenario").textContent = money(scenarioCost);
  document.getElementById("compare-savings").textContent = money(savings);
  document.getElementById("compare-savings-pct").textContent = pct(savingsPct);
  document.getElementById("compare-note").textContent = state.uploadMode
    ? "Uploaded mode: scenario simulation is not executed in-browser."
    : "";
}

function renderExecutiveBrief() {
  const opp = document.getElementById("brief-opportunity");
  const act = document.getElementById("brief-actions");
  const risk = document.getElementById("brief-risks");
  const plan = document.getElementById("brief-3090");

  if (state.uploadMode) {
    const baseline = getBaselineCost();
    opp.textContent = `Uploaded dataset baseline spend is ${money(baseline)}. Use the globe and route filters to identify dominant lanes and candidate intervention points.`;
    act.innerHTML = "<li>Prioritize top-cost routes shown on the globe</li><li>Run Python pipeline for scenario simulation</li><li>Compare realized savings monthly</li>";
    risk.innerHTML = "<li>Scenario values are unavailable in browser-only mode.</li><li>Coordinate gaps may use deterministic pseudo-locations.</li>";
    plan.innerHTML = "<li><strong>30 days:</strong> validate uploaded data quality</li><li><strong>60 days:</strong> run model scenarios offline</li><li><strong>90 days:</strong> deploy optimized policies</li>";
    return;
  }

  const baseline = getBaselineCost();
  const best = [...state.scenarioRows].sort((a, b) => n(b.absolute_savings) - n(a.absolute_savings))[0];
  if (!baseline || !best) {
    opp.textContent = "Insufficient output data for recommendation rendering.";
    act.innerHTML = "<li>Run pipeline to generate scenario results.</li>";
    risk.innerHTML = "<li>No assumptions available.</li>";
    plan.innerHTML = "<li>30d: baseline</li><li>60d: scenarios</li><li>90d: rollout</li>";
    return;
  }

  opp.textContent = `Current baseline spend is ${money(baseline)}. Prioritizing ${best.scenario.replaceAll("_", " ")} can unlock ${money(best.absolute_savings)} (${pct(best.savings_pct)}) modeled savings.`;
  const top = state.scenarioRows.slice().sort((a, b) => n(b.absolute_savings) - n(a.absolute_savings)).slice(0, 3);
  act.innerHTML = top.map((t) => `<li><strong>${t.scenario.replaceAll("_", " ")}</strong> — ${money(t.absolute_savings)} (${pct(t.savings_pct)}), risk ${String(t.risk_level).toUpperCase()}</li>`).join("");
  risk.innerHTML = top.map((t) => `<li>${t.assumptions}</li>`).join("");
  plan.innerHTML = "<li><strong>30 days:</strong> pilot highest-cost lane actions</li><li><strong>60 days:</strong> scale successful policies</li><li><strong>90 days:</strong> institutionalize monthly scenario review</li>";
}

function setGlobeSize() {
  if (!state.globe) return;
  const el = document.getElementById("globe-view");
  state.globe.width(el.clientWidth).height(el.clientHeight);
}

function initGlobe() {
  const el = document.getElementById("globe-view");
  if (!window.Globe || !webglSupported()) return false;

  state.globe = window.Globe()(el)
    .globeImageUrl("https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg")
    .backgroundImageUrl("https://unpkg.com/three-globe/example/img/night-sky.png")
    .showAtmosphere(true)
    .atmosphereColor("#60a5fa")
    .atmosphereAltitude(0.18)
    .pathColor("color")
    .pathPointLat("lat")
    .pathPointLng("lng")
    .pathPointAlt("altitude")
    .pathStroke("width")
    .pathLabel("label")
    .pathTransitionDuration(0);

  setGlobeSize();
  state.globe.pointOfView({ lat: 18, lng: 20, altitude: 2.35 }, 0);
  const controls = state.globe.controls();
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.12;
  controls.minDistance = 160;
  controls.maxDistance = 420;

  window.addEventListener("resize", () => {
    setGlobeSize();
  });

  return true;
}

function renderGlobeOrFallback() {
  const rows = filteredRoutes();
  const note = document.getElementById("map-note");

  if (state.globe) {
    const data = toPathData(rows);
    state.globe.pathsData(data);
    note.textContent = `3D globe active. Showing ${rows.length} highest-cost filtered routes.`;
    return;
  }

  const mapEl = document.getElementById("map-view");
  mapEl.hidden = false;
  document.getElementById("globe-view").hidden = true;

  if (!window.L) {
    note.textContent = "Route map unavailable: Leaflet library did not load.";
    return;
  }

  if (!state.map) {
    state.map = window.L.map("map-view", { zoomControl: true }).setView([10, 15], 2);
    window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 14,
      attribution: "&copy; OpenStreetMap contributors"
    }).addTo(state.map);
  }

  state.mapLayers.forEach((l) => state.map.removeLayer(l));
  state.mapLayers = [];

  rows.forEach((r) => {
    const o = coordFor(r.origin);
    const d = coordFor(r.destination);
    const line = window.L.polyline([[o.lat, o.lon], [d.lat, d.lon]], {
      color: "#2563eb",
      weight: n(r.adjusted_cost) > 5000 ? 5 : 3,
      opacity: 0.75
    }).bindPopup(`${r.origin} -> ${r.destination}<br>${money(r.adjusted_cost)} (${r.carrier})`);
    line.addTo(state.map);
    state.mapLayers.push(line);
  });

  if (state.mapLayers.length) {
    const group = window.L.featureGroup(state.mapLayers);
    state.map.fitBounds(group.getBounds().pad(0.25));
  }

  note.textContent = `2D fallback active. Showing ${rows.length} filtered routes.`;
}

function aggregateUploadedRows(rows) {
  const map = mapUploadColumns(rows);
  if (!map) throw new Error("Uploaded CSV appears empty.");

  const missing = ["origin", "destination", "freight_cost"].filter((k) => !map[k]);
  if (missing.length) {
    throw new Error(`Missing required logical columns: ${missing.join(", ")}`);
  }

  const normalized = rows.map((r, idx) => ({
    shipment_id: map.shipment_id ? normalizeText(r[map.shipment_id]) : `row_${idx + 1}`,
    origin: normalizeText(r[map.origin]),
    destination: normalizeText(r[map.destination]),
    carrier: map.carrier ? normalizeText(r[map.carrier]) : "Unknown Carrier",
    freight_cost: Math.max(0, n(r[map.freight_cost]))
  })).filter((r) => r.origin && r.destination);

  const total = normalized.reduce((acc, r) => acc + r.freight_cost, 0);

  const keyMap = new Map();
  normalized.forEach((r) => {
    const key = `${r.origin}__${r.destination}__${r.carrier}`;
    const existing = keyMap.get(key) || {
      origin: r.origin,
      destination: r.destination,
      carrier: r.carrier,
      total_cost: 0,
      shipment_count: 0
    };

    existing.total_cost += r.freight_cost;
    existing.shipment_count += 1;
    keyMap.set(key, existing);
  });

  const routeRows = [...keyMap.values()]
    .map((r) => ({
      ...r,
      cost_share_pct: total ? ((r.total_cost / total) * 100).toFixed(2) : "0.00"
    }))
    .sort((a, b) => b.total_cost - a.total_cost);

  const baselineRows = [
    { metric: "total_shipments", value: String(normalized.length) },
    { metric: "total_logistics_cost", value: String(total) },
    { metric: "avg_cost_per_shipment", value: String(normalized.length ? total / normalized.length : 0) }
  ];

  const driverRows = routeRows.slice(0, 8).map((r) => ({
    source_table: "by_route",
    driver_value: `${r.origin} -> ${r.destination}`,
    total_cost: r.total_cost,
    cost_share_pct: r.cost_share_pct
  }));

  return { baselineRows, routeRows, driverRows };
}

function setUploadStatus(text, isError = false) {
  const el = document.getElementById("upload-status");
  el.textContent = text;
  el.classList.toggle("upload-status--error", isError);
}

function wireControls() {
  const scenario = document.getElementById("scenario-filter");
  const carrier = document.getElementById("carrier-filter");
  const topn = document.getElementById("topn-filter");
  const topnValue = document.getElementById("topn-value");
  const rotateBtn = document.getElementById("animation-toggle");
  const overlayToggle = document.getElementById("overlay-toggle");
  const overlayBody = document.getElementById("overlay-body");
  const uploadInput = document.getElementById("upload-csv");
  const resetUpload = document.getElementById("reset-upload");

  scenario.addEventListener("change", () => {
    state.selectedScenario = scenario.value;
    renderScenarioList();
    renderComparisonPanel();
    renderExecutiveBrief();
    renderGlobeOrFallback();
  });

  carrier.addEventListener("change", () => {
    state.selectedCarrier = carrier.value;
    renderGlobeOrFallback();
  });

  topn.addEventListener("input", () => {
    state.topN = n(topn.value);
    topnValue.textContent = String(state.topN);
    renderGlobeOrFallback();
  });

  rotateBtn.addEventListener("click", () => {
    state.rotating = !state.rotating;
    rotateBtn.textContent = state.rotating ? "Pause Rotation" : "Play Rotation";
    if (state.globe) {
      state.globe.controls().autoRotate = state.rotating;
    }
  });

  overlayToggle.addEventListener("click", () => {
    const collapsed = overlayBody.classList.toggle("overlay-body--collapsed");
    overlayToggle.textContent = collapsed ? "Controls" : "Hide Controls";
    overlayToggle.setAttribute("aria-expanded", String(!collapsed));
  });

  uploadInput.addEventListener("change", async () => {
    const file = uploadInput.files && uploadInput.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      const rows = parseCsv(text);
      const aggregated = aggregateUploadedRows(rows);

      state.uploadMode = true;
      state.baselineRows = aggregated.baselineRows;
      state.routeRows = aggregated.routeRows;
      state.driverRows = aggregated.driverRows;
      state.scenarioRows = [];
      state.metadata = null;
      state.selectedScenario = "baseline";
      state.selectedCarrier = "all";

      setModeBadge();
      updateImpactHeader();
      buildFilters();
      renderScenarioList();
      renderDriverList();
      renderComparisonPanel();
      renderExecutiveBrief();
      renderGlobeOrFallback();
      setUploadStatus(`Loaded ${file.name} locally.`);
    } catch (err) {
      setUploadStatus(err.message || "Upload failed.", true);
    }
  });

  resetUpload.addEventListener("click", async () => {
    uploadInput.value = "";
    setUploadStatus("No file uploaded.");
    await loadDefaultData();
  });
}

async function loadDefaultData() {
  const [baselineRows, scenarioRows, driverRows, routeRows, metadata, coords] = await Promise.all([
    loadCsv("../outputs/tables/baseline.csv", true),
    loadCsv("../outputs/tables/scenario_results.csv", true),
    loadCsv("../outputs/tables/top_drivers.csv", true),
    loadCsv("../outputs/tables/route_network.csv", true),
    loadJson("../outputs/metadata.json", true),
    loadJson("../config/location_coords.json", false)
  ]);

  state.uploadMode = false;
  state.baselineRows = baselineRows || [];
  state.scenarioRows = scenarioRows || [];
  state.driverRows = driverRows || [];
  state.routeRows = routeRows || [];
  state.metadata = metadata;
  state.coords = coords || {};
  state.selectedScenario = "baseline";
  state.selectedCarrier = "all";

  setModeBadge();
  updateImpactHeader();
  buildFilters();
  renderScenarioList();
  renderDriverList();
  renderComparisonPanel();
  renderExecutiveBrief();
  renderGlobeOrFallback();
}

async function bootstrap() {
  const coords = await loadJson("../config/location_coords.json", false);
  state.coords = coords || {};

  const hasGlobe = initGlobe();
  if (!hasGlobe) {
    document.getElementById("map-note").textContent = "WebGL unavailable. Switching to 2D route map fallback.";
  }

  wireControls();
  await loadDefaultData();
}

bootstrap().catch((err) => {
  const confidence = document.getElementById("impact-confidence");
  confidence.textContent = `Confidence: partial output state. ${err.message}`;
  document.getElementById("scenario-list").innerHTML =
    '<p class="empty">Required output artifacts missing. Generate outputs/tables and outputs/metadata.json.</p>';
  document.getElementById("driver-list").innerHTML =
    '<p class="empty">Top drivers unavailable in current deployment artifact set.</p>';
  document.getElementById("map-note").textContent =
    "Route visualization unavailable until route_network.csv and metadata are present.";
});
