function parseCsvLine(line) {
  const values = [];
  let token = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        token += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      values.push(token);
      token = "";
    } else {
      token += char;
    }
  }

  values.push(token);
  return values.map((value) => value.trim());
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    return [];
  }

  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] || "";
    });
    return row;
  });
}

async function loadCsv(path, required = true) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) {
    if (required) {
      throw new Error(`Missing required CSV: ${path}`);
    }
    return null;
  }

  const text = await response.text();
  return parseCsv(text);
}

async function loadJson(path, required = true) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) {
    if (required) {
      throw new Error(`Missing required JSON: ${path}`);
    }
    return null;
  }

  return response.json();
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value) {
  return number(value).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2
  });
}

function pct(value) {
  return `${number(value).toFixed(2)}%`;
}

function webglSupported() {
  try {
    const canvas = document.createElement("canvas");
    return !!(window.WebGLRenderingContext && canvas.getContext("webgl"));
  } catch (_error) {
    return false;
  }
}

function normalizeText(value) {
  return String(value || "").trim();
}

let appState = {
  baselineRows: [],
  scenarioRows: [],
  driverRows: [],
  routeRows: [],
  metadata: null,
  coords: {},
  selectedScenario: "baseline",
  selectedCarrier: "all",
  topN: 8,
  globe: null,
  map: null,
  mapLayers: [],
  rotating: true
};

function getBaselineCost() {
  const row = appState.baselineRows.find((item) => item.metric === "total_logistics_cost");
  return row ? number(row.value) : 0;
}

function getScenarioByName(name) {
  return appState.scenarioRows.find((row) => row.scenario === name) || null;
}

function getAdjustedFactor() {
  if (appState.selectedScenario === "baseline") {
    return 1;
  }

  const scenario = getScenarioByName(appState.selectedScenario);
  if (!scenario) {
    return 1;
  }

  return Math.max(0, 1 - number(scenario.savings_pct) / 100);
}

function routeRowsWithAdjustedCost() {
  const factor = getAdjustedFactor();

  return appState.routeRows.map((row) => ({
    ...row,
    total_cost_num: number(row.total_cost),
    shipment_count_num: number(row.shipment_count),
    adjusted_cost: number(row.total_cost) * factor,
    carrier_norm: normalizeText(row.carrier)
  }));
}

function filteredRoutes() {
  const all = routeRowsWithAdjustedCost();
  const carrier = appState.selectedCarrier;

  const filtered = all.filter((row) => {
    if (carrier === "all") {
      return true;
    }
    return normalizeText(row.carrier_norm) === carrier;
  });

  return filtered
    .sort((a, b) => b.adjusted_cost - a.adjusted_cost)
    .slice(0, appState.topN);
}

function coordinateFor(locationName) {
  const normalized = normalizeText(locationName);
  return appState.coords[normalized] || null;
}

function toArcData(rows) {
  const arcs = [];
  let hiddenCount = 0;

  rows.forEach((row) => {
    const origin = coordinateFor(row.origin);
    const destination = coordinateFor(row.destination);
    if (!origin || !destination) {
      hiddenCount += 1;
      return;
    }

    arcs.push({
      startLat: number(origin.lat),
      startLng: number(origin.lon),
      endLat: number(destination.lat),
      endLng: number(destination.lon),
      color: row.adjusted_cost > 500 ? ["#f97316", "#f43f5e"] : ["#60a5fa", "#3b82f6"],
      stroke: row.adjusted_cost > 1200 ? 1.3 : 0.8,
      arcDashLength: 0.55,
      arcDashGap: 0.6,
      arcDashAnimateTime: appState.rotating ? 1500 : 0,
      label: `${row.origin} -> ${row.destination} (${row.carrier})\n${money(row.adjusted_cost)} | ${row.shipment_count} shipments`
    });
  });

  return { arcs, hiddenCount };
}

function updateImpactHeader() {
  const baseline = getBaselineCost();
  const bestScenario = [...appState.scenarioRows].sort(
    (left, right) => number(right.absolute_savings) - number(left.absolute_savings)
  )[0];

  const topLane = [...appState.routeRows].sort(
    (left, right) => number(right.total_cost) - number(left.total_cost)
  )[0];

  const freshness = appState.metadata && appState.metadata.generated_at
    ? new Date(appState.metadata.generated_at).toLocaleString()
    : "Unknown";

  document.getElementById("impact-baseline").textContent = baseline ? money(baseline) : "--";
  document.getElementById("impact-savings").textContent = bestScenario
    ? `${money(bestScenario.absolute_savings)} (${pct(bestScenario.savings_pct)})`
    : "--";
  document.getElementById("impact-top-lane").textContent = topLane
    ? `${topLane.origin} -> ${topLane.destination}`
    : "--";
  document.getElementById("impact-freshness").textContent = freshness;

  const confidenceEl = document.getElementById("impact-confidence");
  const hasRoutes = appState.routeRows.length > 0;
  confidenceEl.textContent = hasRoutes
    ? "Confidence: outputs reconciled and route-level network generated successfully."
    : "Confidence: partial data only. Run pipeline to unlock route intelligence.";
}

function buildFilters() {
  const scenarioFilter = document.getElementById("scenario-filter");
  const carrierFilter = document.getElementById("carrier-filter");

  scenarioFilter.innerHTML = "";
  const baselineOption = document.createElement("option");
  baselineOption.value = "baseline";
  baselineOption.textContent = "Baseline";
  scenarioFilter.appendChild(baselineOption);

  appState.scenarioRows.forEach((row) => {
    const option = document.createElement("option");
    option.value = row.scenario;
    option.textContent = row.scenario.replaceAll("_", " ");
    scenarioFilter.appendChild(option);
  });

  carrierFilter.innerHTML = "";
  const allOption = document.createElement("option");
  allOption.value = "all";
  allOption.textContent = "All carriers";
  carrierFilter.appendChild(allOption);

  const carriers = [...new Set(appState.routeRows.map((row) => normalizeText(row.carrier)).filter(Boolean))].sort();
  carriers.forEach((carrier) => {
    const option = document.createElement("option");
    option.value = carrier;
    option.textContent = carrier;
    carrierFilter.appendChild(option);
  });

  scenarioFilter.value = appState.selectedScenario;
  carrierFilter.value = appState.selectedCarrier;
}

function renderScenarioList() {
  const el = document.getElementById("scenario-list");
  if (!appState.scenarioRows.length) {
    el.innerHTML = "<p class=\"empty\">Scenario outputs missing: outputs/tables/scenario_results.csv</p>";
    return;
  }

  el.innerHTML = appState.scenarioRows
    .slice()
    .sort((left, right) => number(right.absolute_savings) - number(left.absolute_savings))
    .map(
      (row, index) => `
        <article class="scenario-item ${appState.selectedScenario === row.scenario ? "scenario-item--active" : ""}">
          <div class="scenario-item__head">
            <strong>#${index + 1} ${row.scenario.replaceAll("_", " ")}</strong>
            <span>${money(row.absolute_savings)}</span>
          </div>
          <p>Savings ${pct(row.savings_pct)} | Risk ${String(row.risk_level || "n/a").toUpperCase()}</p>
        </article>
      `
    )
    .join("");
}

function renderDriverList() {
  const box = document.getElementById("driver-list");
  if (!appState.driverRows.length) {
    box.innerHTML = "<p class=\"empty\">Driver outputs missing: outputs/tables/top_drivers.csv</p>";
    return;
  }

  box.innerHTML = appState.driverRows
    .slice(0, 8)
    .map(
      (row) => `
        <article class="driver-item">
          <strong>${String(row.source_table || "driver").replace("by_", "").replaceAll("_", " ")}: ${row.driver_value}</strong>
          <p>${money(row.total_cost)} | ${pct(row.cost_share_pct)} share</p>
        </article>
      `
    )
    .join("");
}

function renderComparisonPanel() {
  const baselineCost = getBaselineCost();
  const scenario = appState.selectedScenario === "baseline" ? null : getScenarioByName(appState.selectedScenario);
  const scenarioCost = scenario ? number(scenario.scenario_cost) : baselineCost;
  const savings = baselineCost - scenarioCost;
  const savingsPct = baselineCost ? (savings / baselineCost) * 100 : 0;

  document.getElementById("compare-baseline").textContent = money(baselineCost);
  document.getElementById("compare-scenario").textContent = money(scenarioCost);
  document.getElementById("compare-savings").textContent = money(savings);
  document.getElementById("compare-savings-pct").textContent = pct(savingsPct);
}

function renderExecutiveBrief() {
  const opportunityEl = document.getElementById("brief-opportunity");
  const actionsEl = document.getElementById("brief-actions");
  const risksEl = document.getElementById("brief-risks");
  const planEl = document.getElementById("brief-3090");

  const baselineCost = getBaselineCost();
  const best = [...appState.scenarioRows].sort(
    (left, right) => number(right.absolute_savings) - number(left.absolute_savings)
  )[0];

  if (!baselineCost || !best) {
    opportunityEl.textContent = "Insufficient output data. Generate baseline and scenario artifacts to render executive recommendations.";
    actionsEl.innerHTML = "<li>Run pipeline to populate scenario_results.csv</li>";
    risksEl.innerHTML = "<li>Data unavailable for risk framing.</li>";
    planEl.innerHTML = "<li>30d: run baseline pipeline</li><li>60d: simulate scenarios</li><li>90d: publish execution roadmap</li>";
    return;
  }

  const scenarioName = best.scenario.replaceAll("_", " ");
  opportunityEl.textContent = `Current baseline spend is ${money(baselineCost)}. Prioritizing ${scenarioName} can unlock approximately ${money(best.absolute_savings)} (${pct(best.savings_pct)}) in modeled transport savings while maintaining service coverage.`;

  const topActions = appState.scenarioRows
    .slice()
    .sort((left, right) => number(right.absolute_savings) - number(left.absolute_savings))
    .slice(0, 3);

  actionsEl.innerHTML = topActions
    .map(
      (item) => `<li><strong>${item.scenario.replaceAll("_", " ")}</strong> — ${money(item.absolute_savings)} (${pct(item.savings_pct)}), risk ${String(item.risk_level).toUpperCase()}</li>`
    )
    .join("");

  const assumptionLines = topActions.map((item) => `<li>${item.assumptions}</li>`);
  risksEl.innerHTML = assumptionLines.join("");

  planEl.innerHTML = [
    `<li><strong>30 days:</strong> Validate top-lane assumptions and launch a pilot on the highest-cost route.</li>`,
    `<li><strong>60 days:</strong> Scale successful policy changes across eligible carriers and urgent classes.</li>`,
    `<li><strong>90 days:</strong> Institutionalize scenario tracking with monthly realized-vs-modeled savings reviews.</li>`
  ].join("");
}

function initGlobe() {
  const el = document.getElementById("globe-view");
  if (!window.Globe || !webglSupported()) {
    return false;
  }

  const globe = window.Globe()(el)
    .globeImageUrl("https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg")
    .backgroundImageUrl("https://unpkg.com/three-globe/example/img/night-sky.png")
    .showAtmosphere(true)
    .atmosphereColor("#60a5fa")
    .atmosphereAltitude(0.18)
    .arcLabel("label");

  globe.controls().autoRotate = true;
  globe.controls().autoRotateSpeed = 0.4;
  appState.globe = globe;
  return true;
}

function renderGlobeOrFallback() {
  const rows = filteredRoutes();
  const { arcs, hiddenCount } = toArcData(rows);
  const noteEl = document.getElementById("map-note");

  if (appState.globe) {
    appState.globe.arcsData(arcs);
    appState.globe.arcColor("color");
    appState.globe.arcStroke("stroke");
    appState.globe.arcDashLength("arcDashLength");
    appState.globe.arcDashGap("arcDashGap");
    appState.globe.arcDashAnimateTime("arcDashAnimateTime");
    noteEl.textContent = hiddenCount
      ? `${hiddenCount} routes hidden due to missing coordinates.`
      : "3D globe view active. Filter routes to explore cost concentration.";
    return;
  }

  const mapEl = document.getElementById("map-view");
  mapEl.hidden = false;
  document.getElementById("globe-view").hidden = true;

  if (!window.L) {
    noteEl.textContent = "Route map unavailable: Leaflet library did not load.";
    return;
  }

  if (!appState.map) {
    appState.map = window.L.map("map-view", { zoomControl: true }).setView([4, 22], 3);
    window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 14,
      attribution: "&copy; OpenStreetMap contributors"
    }).addTo(appState.map);
  }

  appState.mapLayers.forEach((layer) => appState.map.removeLayer(layer));
  appState.mapLayers = [];

  rows.forEach((row) => {
    const origin = coordinateFor(row.origin);
    const destination = coordinateFor(row.destination);
    if (!origin || !destination) {
      return;
    }

    const line = window.L.polyline(
      [
        [number(origin.lat), number(origin.lon)],
        [number(destination.lat), number(destination.lon)]
      ],
      {
        color: "#2563eb",
        weight: row.adjusted_cost > 1200 ? 4 : 2,
        opacity: 0.7
      }
    ).bindPopup(`${row.origin} -> ${row.destination}<br>${money(row.adjusted_cost)} (${row.carrier})`);

    line.addTo(appState.map);
    appState.mapLayers.push(line);
  });

  if (appState.mapLayers.length) {
    const group = window.L.featureGroup(appState.mapLayers);
    appState.map.fitBounds(group.getBounds().pad(0.2));
  }

  noteEl.textContent = hiddenCount
    ? `2D fallback active. ${hiddenCount} routes hidden due to missing coordinates.`
    : "2D fallback active. WebGL not available on this device/browser.";
}

function wireControls() {
  const scenarioFilter = document.getElementById("scenario-filter");
  const carrierFilter = document.getElementById("carrier-filter");
  const topNFilter = document.getElementById("topn-filter");
  const topNValue = document.getElementById("topn-value");
  const animationToggle = document.getElementById("animation-toggle");

  scenarioFilter.addEventListener("change", () => {
    appState.selectedScenario = scenarioFilter.value;
    renderScenarioList();
    renderComparisonPanel();
    renderExecutiveBrief();
    renderGlobeOrFallback();
  });

  carrierFilter.addEventListener("change", () => {
    appState.selectedCarrier = carrierFilter.value;
    renderGlobeOrFallback();
  });

  topNFilter.addEventListener("input", () => {
    appState.topN = number(topNFilter.value);
    topNValue.textContent = String(appState.topN);
    renderGlobeOrFallback();
  });

  animationToggle.addEventListener("click", () => {
    appState.rotating = !appState.rotating;
    animationToggle.textContent = appState.rotating ? "Pause Rotation" : "Play Rotation";

    if (appState.globe) {
      appState.globe.controls().autoRotate = appState.rotating;
    }

    renderGlobeOrFallback();
  });
}

async function bootstrap() {
  const [baselineRows, scenarioRows, driverRows, routeRows, metadata, coords] = await Promise.all([
    loadCsv("../outputs/tables/baseline.csv", true),
    loadCsv("../outputs/tables/scenario_results.csv", true),
    loadCsv("../outputs/tables/top_drivers.csv", true),
    loadCsv("../outputs/tables/route_network.csv", true),
    loadJson("../outputs/metadata.json", true),
    loadJson("../config/location_coords.json", false)
  ]);

  appState.baselineRows = baselineRows || [];
  appState.scenarioRows = scenarioRows || [];
  appState.driverRows = driverRows || [];
  appState.routeRows = routeRows || [];
  appState.metadata = metadata;
  appState.coords = coords || {};

  updateImpactHeader();
  buildFilters();
  renderScenarioList();
  renderDriverList();
  renderComparisonPanel();
  renderExecutiveBrief();

  const useGlobe = initGlobe();
  if (!useGlobe) {
    document.getElementById("map-note").textContent = "WebGL unavailable. Switching to 2D route map fallback.";
  }

  wireControls();
  renderGlobeOrFallback();
}

bootstrap().catch((error) => {
  const confidence = document.getElementById("impact-confidence");
  confidence.textContent = `Confidence: partial output state. ${error.message}`;

  document.getElementById("scenario-list").innerHTML =
    '<p class="empty">Required output artifacts missing. Generate outputs/tables and outputs/metadata.json.</p>';
  document.getElementById("driver-list").innerHTML =
    '<p class="empty">Top drivers unavailable in current deployment artifact set.</p>';
  document.getElementById("map-note").textContent =
    "Route visualization unavailable until route_network.csv and location mapping are present.";
});
