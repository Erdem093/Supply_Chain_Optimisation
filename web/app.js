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
  carrierRows: [],
  urgencyRows: [],
  metadata: null,
  coords: {},
  selectedScenario: "baseline",
  selectedCarrier: "all",
  topN: 12,
  globe: null,
  map: null,
  mapLayers: [],
  rotating: true,
  uploadMode: false,
  viewMode: "3d",
  charts: {},
  maskUpdater: null
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
    .sort((a, b) => b.adjusted_cost - a.adjusted_cost)
    .slice(0, 30);
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

// ── Arc colour helpers ─────────────────────────────────────────────────────────
function arcColorFor(cost) {
  // Solid bright colours — gradients look bad with small dot dash lengths
  if (cost > 8000) return ["rgba(255,80,0,0)",  "rgba(255,90,10,1)",  "rgba(255,80,0,0)"];
  if (cost > 5000) return ["rgba(255,170,0,0)", "rgba(255,185,0,1)",  "rgba(255,170,0,0)"];
  if (cost > 3000) return ["rgba(0,210,255,0)",  "rgba(0,220,255,1)",  "rgba(0,210,255,0)"];
  return                   ["rgba(80,140,255,0)", "rgba(90,155,255,1)", "rgba(80,140,255,0)"];
}

function arcAltFor(o, d) {
  const dLat = o.lat - d.lat;
  const dLon = o.lon - d.lon;
  const dist = Math.sqrt(dLat * dLat + dLon * dLon);
  return Math.min(0.25, Math.max(0.08, dist / 200));
}

function toArcData(rows) {
  return rows.map((r) => {
    const o = coordFor(r.origin);
    const d = coordFor(r.destination);
    const cost = n(r.adjusted_cost);
    return {
      startLat: o.lat, startLng: o.lon,
      endLat:   d.lat, endLng:   d.lon,
      color:    arcColorFor(cost),
      altitude: arcAltFor(o, d),
      stroke:   cost > 8000 ? 1.4 : cost > 5000 ? 1.1 : 0.8,
      animTime: cost > 8000 ? 8000 : cost > 5000 ? 10000 : 13000,
      label:    `${r.origin} → ${r.destination}\n${money(cost)} · ${r.carrier}`
    };
  });
}

// ── Hub point markers ──────────────────────────────────────────────────────────
function getPointsData(rows) {
  const hubs = new Map();
  rows.forEach((r) => {
    [{ name: r.origin, w: 1 }, { name: r.destination, w: 0.6 }].forEach(({ name, w }) => {
      const c = coordFor(name);
      const existing = hubs.get(name) || { lat: c.lat, lng: c.lon, name, vol: 0 };
      existing.vol += n(r.adjusted_cost) * w;
      hubs.set(name, existing);
    });
  });
  return [...hubs.values()].map((h) => {
    const col = h.vol > 20000 ? "rgba(255,80,0,0.9)" : h.vol > 10000 ? "rgba(255,170,0,0.85)" : "rgba(60,180,255,0.8)";
    return { lat: h.lat, lng: h.lng, label: h.name, color: col, r: Math.min(0.55, Math.max(0.18, h.vol / 40000)) };
  });
}

// ── Pulsing rings at top hubs ──────────────────────────────────────────────────
function getRingsData(rows) {
  const hubs = new Map();
  rows.forEach((r) => {
    const c = coordFor(r.origin);
    const ex = hubs.get(r.origin) || { lat: c.lat, lng: c.lon, vol: 0 };
    ex.vol += n(r.adjusted_cost);
    hubs.set(r.origin, ex);
  });
  return [...hubs.values()]
    .sort((a, b) => b.vol - a.vol)
    .slice(0, 5)
    .map((h) => ({
      lat: h.lat, lng: h.lng,
      color: (t) => `rgba(255,${Math.round(140 + 60 * t)},0,${(1 - t) * 0.6})`,
      maxR: 4, speed: 2, period: 900
    }));
}

function setModeBadge() {
  const badge = document.getElementById("mode-badge");
  if (!badge) return;
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

  const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setEl("impact-baseline", baseline ? money(baseline) : "--");
  setEl("impact-savings", state.uploadMode ? "Run Python model" : best ? `${money(best.absolute_savings)} (${pct(best.savings_pct)})` : "--");
  setEl("impact-top-lane", top ? `${top.origin} -> ${top.destination}` : "--");
  setEl("impact-freshness", freshness);
  setEl("impact-confidence", state.uploadMode
    ? "Confidence: uploaded CSV processed locally in browser. No data leaves your device."
    : "Confidence: pipeline outputs reconciled with route-level network.");
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

  const sorted = state.scenarioRows
    .slice()
    .sort((a, b) => n(b.absolute_savings) - n(a.absolute_savings));

  el.innerHTML = sorted
    .map(
      (r, i) => `
      <article class="scenario-item ${state.selectedScenario === r.scenario ? "scenario-item--active" : ""}" data-scenario="${r.scenario}">
        <div class="scenario-item__head"><strong>#${i + 1} ${r.scenario.replaceAll("_", " ")}</strong><span>${money(r.absolute_savings)}</span></div>
        <p>Savings ${pct(r.savings_pct)} | Risk ${String(r.risk_level).toUpperCase()}</p>
      </article>
    `
    )
    .join("");

  el.querySelectorAll(".scenario-item").forEach((item) => {
    item.addEventListener("click", () => {
      state.selectedScenario = item.dataset.scenario;
      const sf = document.getElementById("scenario-filter");
      if (sf) sf.value = state.selectedScenario;
      renderScenarioList();
      renderComparisonPanel();
      renderExecutiveBrief();
      renderGlobeOrFallback();
    });
  });
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
      (r, i) => `
      <article class="driver-item">
        <div class="driver-item__rank">${i + 1}</div>
        <div class="driver-item__body">
          <strong>${String(r.source_table || "driver").replace("by_", "").replaceAll("_", " ")}: ${r.driver_value}</strong>
          <p>${money(r.total_cost)} &mdash; ${pct(r.cost_share_pct)} share</p>
        </div>
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
    .globeImageUrl("https://unpkg.com/three-globe/example/img/earth-night.jpg")
    .backgroundImageUrl(null)
    .showAtmosphere(true)
    .atmosphereColor("#2255cc")
    .atmosphereAltitude(0.15)
    // Animated arcs (comets)
    .arcsData([])
    .arcStartLat("startLat").arcStartLng("startLng")
    .arcEndLat("endLat").arcEndLng("endLng")
    .arcColor("color")
    .arcAltitude("altitude")
    .arcStroke("stroke")
    .arcDashLength(0.01)
    .arcDashGap(0.03)
    .arcDashAnimateTime("animTime")
    .arcLabel("label")
    // Glow dots at hubs
    .pointsData([])
    .pointLat("lat").pointLng("lng")
    .pointColor("color")
    .pointAltitude(0.005)
    .pointRadius("r")
    .pointLabel("label")
    // Pulsing rings at top hubs
    .ringsData([])
    .ringLat("lat").ringLng("lng")
    .ringColor("color")
    .ringMaxRadius("maxR")
    .ringPropagationSpeed("speed")
    .ringRepeatPeriod("period");

  setGlobeSize();

  // Transparent WebGL background so the CSS star field shows through seamlessly
  try {
    const renderer = state.globe.renderer();
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.style.background = "transparent";
    // Also force any globe.gl-injected wrapper divs to be transparent
    el.querySelectorAll("div").forEach(d => { d.style.background = "transparent"; });
  } catch (_) {}

  state.globe.pointOfView({ lat: 20, lng: 15, altitude: 2.2 }, 0);
  const controls = state.globe.controls();
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.10;
  controls.minDistance = 150;
  controls.maxDistance = 500;

  // Dynamic circular alpha mask that blends the globe edges into page background.
  const globeShell = document.querySelector(".globe-shell");
  const updateMaskFromZoom = () => {
    if (!state.globe || !globeShell) return;
    const altitude = state.globe.pointOfView().altitude ?? 2.2;
    const t = Math.min(1, Math.max(0, (2.2 - altitude) / (2.2 - 0.55)));
    const corePct = 33 + t * 18;
    const softPct = 20 - t * 5;
    globeShell.style.setProperty("--mask-core", `${corePct.toFixed(2)}%`);
    globeShell.style.setProperty("--mask-soft", `${softPct.toFixed(2)}%`);
  };
  state.maskUpdater = updateMaskFromZoom;
  updateMaskFromZoom();
  if (controls && typeof controls.addEventListener === "function") {
    controls.addEventListener("change", updateMaskFromZoom);
  }

  window.addEventListener("resize", () => {
    setGlobeSize();
    updateMaskFromZoom();
  });

  // Canvas pixel manipulation: load the night texture, boost city light pixels
  // selectively via a non-linear power curve, then feed the modified image back
  // via globeImageUrl() — the official API, cannot be overridden by globe.gl internals.
  // Pixels brighter than threshold get boosted (city lights), dark pixels (ocean) stay dark.
  // RGB channels are scaled proportionally so hue is fully preserved.
  const boostLights = () => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = "https://unpkg.com/three-globe/example/img/earth-night.jpg";
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height);
      for (let i = 0; i < d.data.length; i += 4) {
        const r = d.data[i], g = d.data[i + 1], b = d.data[i + 2];
        const brightness = (r + g + b) / 3;
        // City lights are warm (yellow/white): R and G are high relative to B.
        // Ocean pixels are blue-dominant: B > R and B > G.
        // Only boost pixels that are warm (not blue-dominant) and bright enough.
        const isWarm = (r + g) > b * 1.8;
        if (brightness > 35 && isWarm) {
          // Boost city lights and shift toward warm yellow by reducing blue channel
          const boost = Math.min(5, Math.pow(brightness / 255, 0.3) * 6);
          d.data[i]     = Math.min(255, r * boost);
          d.data[i + 1] = Math.min(255, g * boost * 0.92);
          d.data[i + 2] = Math.min(255, b * boost * 0.5); // reduce blue → warm yellow glow
        } else {
          // Keep the base darker so directional light creates a clear day/night split.
          const suppress = isWarm ? 0.68 : 0.56;
          d.data[i]     = Math.min(255, r * suppress);
          d.data[i + 1] = Math.min(255, g * suppress);
          d.data[i + 2] = Math.min(255, b * (isWarm ? suppress : suppress * 0.88));
        }
      }
      ctx.putImageData(d, 0, 0);
      // Use PNG to avoid JPEG compression blocking artifacts
      state.globe.globeImageUrl(c.toDataURL("image/png"));
    };
    img.onerror = () => {};
  };
  setTimeout(boostLights, 500);

  // Replace globe.gl's default lights with a directional "sun" from upper-left.
  // Balanced fill lights preserve depth so one hemisphere reads as day and the other as night.
  const addSunLight = () => {
    try {
      if (!window.THREE) { setTimeout(addSunLight, 400); return; }
      // Remove existing lights so the setup below is deterministic.
      const toRemove = [];
      state.globe.scene().traverse(obj => { if (obj.isLight) toRemove.push(obj); });
      toRemove.forEach(l => l.parent && l.parent.remove(l));

      // Force globe material to respond more strongly to directional light.
      const globeMat = state.globe.globeMaterial && state.globe.globeMaterial();
      if (globeMat) {
        globeMat.emissive = new window.THREE.Color(0x000000);
        globeMat.emissiveIntensity = 0;
        globeMat.shininess = 18;
        globeMat.specular = new window.THREE.Color(0x5f7ea8);
        globeMat.needsUpdate = true;
      }

      // Primary warm key light ("sun")
      const sun = new window.THREE.DirectionalLight(0xfff0c7, 4.4);
      sun.position.set(-320, 120, 220);
      state.globe.scene().add(sun);

      // Near-zero ambient to keep the night side dark.
      const ambient = new window.THREE.AmbientLight(0x0a1222, 0.04);
      state.globe.scene().add(ambient);

      // Soft sky/ground contribution to avoid hard clipping at the terminator.
      const hemi = new window.THREE.HemisphereLight(0x3b5f96, 0x070d18, 0.12);
      state.globe.scene().add(hemi);

      // Cool, weak rim/fill from opposite side for subtle contour.
      const rim = new window.THREE.DirectionalLight(0x375b93, 0.10);
      rim.position.set(240, -70, -180);
      state.globe.scene().add(rim);
    } catch (_) {}
  };
  setTimeout(addSunLight, 800);

  // Cloud layer — slightly larger sphere with transparent cloud texture
  const addClouds = () => {
    try {
      if (!window.THREE) { setTimeout(addClouds, 400); return; }
      const geo = new window.THREE.SphereGeometry(101, 64, 64);
      const tex = new window.THREE.TextureLoader().load(
        "https://unpkg.com/three-globe/example/img/earth-clouds.png"
      );
      const mat = new window.THREE.MeshLambertMaterial({
        map: tex, transparent: true, opacity: 0.7, depthWrite: false
      });
      const clouds = new window.THREE.Mesh(geo, mat);
      state.globe.scene().add(clouds);
      // Slowly counter-rotate clouds
      const tick = () => { clouds.rotation.y += 0.00008; requestAnimationFrame(tick); };
      tick();
    } catch (_) {}
  };
  setTimeout(addClouds, 1000);

  return true;
}

function render2DMap(rows) {
  const note = document.getElementById("map-note");
  if (!window.L) {
    note.textContent = "Leaflet library unavailable.";
    return;
  }

  if (!state.map) {
    state.map = window.L.map("map-view", { zoomControl: false }).setView([15, 20], 2);
    window.L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 14,
      attribution: "&copy; OpenStreetMap &copy; CARTO"
    }).addTo(state.map);
  } else {
    setTimeout(() => state.map.invalidateSize(), 100);
  }

  state.mapLayers.forEach((l) => state.map.removeLayer(l));
  state.mapLayers = [];

  rows.forEach((r) => {
    const o = coordFor(r.origin);
    const d = coordFor(r.destination);
    const cost = n(r.adjusted_cost);
    const color = cost > 8000 ? "#ff4444" : cost > 5000 ? "#ff9500" : cost > 3000 ? "#ffcc00" : "#00d4ff";
    const weight = cost > 8000 ? 4 : cost > 5000 ? 3 : 2;
    const line = window.L.polyline([[o.lat, o.lon], [d.lat, d.lon]], {
      color, weight, opacity: 0.85
    }).bindPopup(`<strong>${r.origin} → ${r.destination}</strong><br>${money(cost)} · ${r.carrier}`);
    line.addTo(state.map);
    state.mapLayers.push(line);

    // origin/dest markers
    [{ lat: o.lat, lng: o.lon, name: r.origin }, { lat: d.lat, lng: d.lon, name: r.destination }].forEach(pt => {
      const m = window.L.circleMarker([pt.lat, pt.lng], {
        radius: 4, fillColor: color, fillOpacity: 0.9, color: "#fff", weight: 1
      }).bindTooltip(pt.name);
      m.addTo(state.map);
      state.mapLayers.push(m);
    });
  });

  if (state.mapLayers.length) {
    try {
      const group = window.L.featureGroup(state.mapLayers.filter(l => l.getBounds));
      if (group.getLayers().length) state.map.fitBounds(group.getBounds().pad(0.2));
    } catch(_) {}
  }
  note.textContent = `Showing ${rows.length} routes.`;
}

function renderGlobeOrFallback() {
  const rows = filteredRoutes();
  const note = document.getElementById("map-note");
  const globeEl = document.getElementById("globe-view");
  const mapEl = document.getElementById("map-view");

  if (state.viewMode === "2d" || !state.globe) {
    globeEl.hidden = true;
    mapEl.hidden = false;
    render2DMap(rows);
    return;
  }

  // 3D globe
  globeEl.hidden = false;
  mapEl.hidden = true;
  state.globe
    .arcsData(toArcData(rows))
    .pointsData(getPointsData(rows))
    .ringsData(getRingsData(rows));
  if (typeof state.maskUpdater === "function") state.maskUpdater();
  note.textContent = `Showing ${rows.length} routes.`;
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


// ── Chart.js native charts ────────────────────────────────────────────────────
const CHART_COLORS = ["#7a1f2a", "#9a3348", "#27b87a", "#9b7fe8", "#e05252", "#29b8c8", "#7a3446", "#5c1a2a"];
const ROUTE_HIGH_COLOR = "#7a1f2a";
const ROUTE_LIGHT_LOW_1 = "#cf96a4";
const ROUTE_LIGHT_LOW_2 = "#e2b5bf";
const STANDARD_NEUTRAL = "#7e8797";

function destroyChart(id) {
  if (state.charts[id]) {
    state.charts[id].destroy();
    delete state.charts[id];
  }
}

function renderCharts() {
  if (typeof Chart === "undefined") return;

  const chartDefaults = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: "rgba(8,12,24,0.96)",
        titleColor: "#c8d4e8",
        bodyColor: "#4f6480",
        borderColor: "rgba(180,200,240,0.1)",
        borderWidth: 1,
        titleFont: { family: "Inter", size: 12, weight: "600" },
        bodyFont: { family: "Inter", size: 11 },
        padding: 10,
        cornerRadius: 8
      }
    }
  };

  // Chart 1: Scenario savings bar
  const scenEl = document.getElementById("chart-scenarios");
  if (scenEl && state.scenarioRows.length) {
    destroyChart("scenarios");
    const sorted = [...state.scenarioRows].sort((a, b) => n(b.absolute_savings) - n(a.absolute_savings));
    state.charts.scenarios = new Chart(scenEl, {
      type: "bar",
      data: {
        labels: sorted.map(r => r.scenario.replaceAll("_", " ")),
        datasets: [{
          data: sorted.map(r => n(r.absolute_savings)),
          backgroundColor: sorted.map((_, i) => CHART_COLORS[i % CHART_COLORS.length] + "cc"),
          borderColor: sorted.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]),
          borderWidth: 1.5,
          borderRadius: 6,
          borderSkipped: false
        }]
      },
      options: {
        ...chartDefaults,
        plugins: {
          ...chartDefaults.plugins,
          tooltip: {
            ...chartDefaults.plugins.tooltip,
            callbacks: { label: ctx => " " + money(ctx.parsed.y) }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { font: { family: "Inter", size: 11, weight: "600" }, color: "#4f6480" }
          },
          y: {
            grid: { color: "rgba(180,200,240,0.07)", lineWidth: 1 },
            ticks: {
              font: { family: "Inter", size: 10 }, color: "#4f6480",
              callback: v => "$" + (v >= 1000 ? (v / 1000).toFixed(0) + "k" : v)
            },
            beginAtZero: true
          }
        }
      }
    });
  }

  // Chart 2: Top routes horizontal bar
  const routesEl = document.getElementById("chart-routes");
  if (routesEl && state.routeRows.length) {
    destroyChart("routes");
    const top8 = [...state.routeRows].sort((a, b) => n(b.total_cost) - n(a.total_cost)).slice(0, 8);
    const routeLabels = top8.map((r) => `${r.origin.replace(" Hub", "")} → ${r.destination}`);
    const routeColors = top8.map((r, i) => {
      const label = `${r.origin} -> ${r.destination}`.toLowerCase();
      if (label.includes("mumbai") && label.includes("new zealand")) return ROUTE_LIGHT_LOW_1;
      if (label.includes("nairobi") && label.includes("united kingdom")) return ROUTE_LIGHT_LOW_2;
      if (i === 6) return ROUTE_LIGHT_LOW_1;
      if (i === 7) return ROUTE_LIGHT_LOW_2;
      return CHART_COLORS[i % CHART_COLORS.length];
    });
    state.charts.routes = new Chart(routesEl, {
      type: "bar",
      data: {
        labels: routeLabels,
        datasets: [{
          data: top8.map(r => n(r.total_cost)),
          backgroundColor: routeColors.map((c) => `${c}cc`),
          borderColor: routeColors,
          borderWidth: 1.5,
          borderRadius: 4
        }]
      },
      options: {
        ...chartDefaults,
        indexAxis: "y",
        plugins: {
          ...chartDefaults.plugins,
          tooltip: {
            ...chartDefaults.plugins.tooltip,
            callbacks: { label: ctx => " " + money(ctx.parsed.x) }
          }
        },
        scales: {
          x: {
            grid: { color: "rgba(180,200,240,0.07)", lineWidth: 1 },
            ticks: {
              font: { family: "Inter", size: 10 }, color: "#4f6480",
              callback: v => "$" + (v >= 1000 ? (v / 1000).toFixed(0) + "k" : v)
            },
            beginAtZero: true
          },
          y: {
            grid: { display: false },
            ticks: { font: { family: "Inter", size: 10 }, color: "#4f6480" }
          }
        }
      }
    });
  }

  // Chart 3: Carrier donut
  const carriersEl = document.getElementById("chart-carriers");
  const carrierData = state.driverRows.filter(r => r.source_table === "by_carrier");
  if (carriersEl && carrierData.length) {
    destroyChart("carriers");
    state.charts.carriers = new Chart(carriersEl, {
      type: "doughnut",
      data: {
        labels: carrierData.map(r => r.driver_value),
        datasets: [{
          data: carrierData.map(r => n(r.total_cost)),
          backgroundColor: CHART_COLORS.slice(0, carrierData.length),
          borderColor: "transparent",
          borderWidth: 0,
          hoverOffset: 6
        }]
      },
      options: {
        ...chartDefaults,
        plugins: {
          ...chartDefaults.plugins,
          legend: {
            display: true,
            position: "bottom",
            labels: { font: { family: "Inter", size: 11 }, padding: 12, usePointStyle: true, color: "#c8d4e8" }
          },
          tooltip: {
            ...chartDefaults.plugins.tooltip,
            callbacks: { label: ctx => " " + money(ctx.parsed) + " (" + ctx.label + ")" }
          }
        },
        cutout: "62%"
      }
    });
  }

  // Chart 4: Urgency donut
  const urgencyEl = document.getElementById("chart-urgency");
  const urgencyData = state.driverRows.filter(r => r.source_table === "by_urgency");
  if (urgencyEl && urgencyData.length) {
    destroyChart("urgency");
    const sortedUrgencyData = [...urgencyData].sort((a, b) => {
      const aLabel = String(a.driver_value || "").toLowerCase();
      const bLabel = String(b.driver_value || "").toLowerCase();
      const rank = (label) => (label.includes("standard") ? 0 : label.includes("urgent") ? 1 : 2);
      return rank(aLabel) - rank(bLabel);
    });
    const urgencyColors = sortedUrgencyData.map((r, i) => {
      const label = String(r.driver_value || "").toLowerCase();
      if (label.includes("urgent")) return ROUTE_HIGH_COLOR;
      if (label.includes("standard")) return STANDARD_NEUTRAL;
      return CHART_COLORS[i % CHART_COLORS.length];
    });
    state.charts.urgency = new Chart(urgencyEl, {
      type: "doughnut",
      data: {
        labels: sortedUrgencyData.map(r => r.driver_value),
        datasets: [{
          data: sortedUrgencyData.map(r => n(r.total_cost)),
          backgroundColor: urgencyColors,
          borderColor: "transparent",
          borderWidth: 0,
          hoverOffset: 6
        }]
      },
      options: {
        ...chartDefaults,
        plugins: {
          ...chartDefaults.plugins,
          legend: {
            display: true,
            position: "bottom",
            labels: { font: { family: "Inter", size: 11 }, padding: 12, usePointStyle: true, color: "#c8d4e8" }
          },
          tooltip: {
            ...chartDefaults.plugins.tooltip,
            callbacks: { label: ctx => " " + money(ctx.parsed) + " (" + ctx.label + ")" }
          }
        },
        cutout: "62%"
      }
    });
  }
}

function wireControls() {
  const scenario = document.getElementById("scenario-filter");

  // Data source controls (top strip)
  const btnDemo = document.getElementById("btn-demo");
  const btnUpload = document.getElementById("btn-upload");
  const uploadPanel = document.getElementById("upload-panel");
  const uploadInput = document.getElementById("upload-csv");

  // Globe 3D / 2D toggle
  const btn3d = document.getElementById("btn-3d");
  const btn2d = document.getElementById("btn-2d");
  if (btn3d && btn2d) {
    btn3d.addEventListener("click", () => {
      state.viewMode = "3d";
      btn3d.classList.add("view-tab--active");
      btn2d.classList.remove("view-tab--active");
      document.getElementById("globe-view").hidden = false;
      document.getElementById("map-view").hidden = true;
      renderGlobeOrFallback();
    });
    btn2d.addEventListener("click", () => {
      state.viewMode = "2d";
      btn2d.classList.add("view-tab--active");
      btn3d.classList.remove("view-tab--active");
      renderGlobeOrFallback();
    });
  }

  // scenario filter still wires from leaderboard clicks; keep dropdown in sync
  if (scenario) {
    scenario.addEventListener("change", () => {
      state.selectedScenario = scenario.value;
      renderScenarioList();
      renderComparisonPanel();
      renderExecutiveBrief();
      renderGlobeOrFallback();
    });
  }

  btnDemo.addEventListener("click", async () => {
    if (uploadInput) uploadInput.value = "";
    setUploadStatus("No file selected.");
    uploadPanel.hidden = true;
    btnDemo.classList.add("ds-tab--active");
    btnDemo.setAttribute("aria-selected", "true");
    btnUpload.classList.remove("ds-tab--active");
    btnUpload.setAttribute("aria-selected", "false");
    await loadDefaultData();
  });

  btnUpload.addEventListener("click", () => {
    uploadPanel.hidden = false;
    btnUpload.classList.add("ds-tab--active");
    btnUpload.setAttribute("aria-selected", "true");
    btnDemo.classList.remove("ds-tab--active");
    btnDemo.setAttribute("aria-selected", "false");
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
      renderCharts();
      setUploadStatus(`Loaded ${file.name} locally.`);
    } catch (err) {
      setUploadStatus(err.message || "Upload failed.", true);
    }
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

  // Default to the best-savings scenario so Before/After shows non-zero
  const bestScen = [...state.scenarioRows]
    .sort((a, b) => n(b.absolute_savings) - n(a.absolute_savings))
    .find((r) => n(r.absolute_savings) > 0);
  state.selectedScenario = bestScen ? bestScen.scenario : "baseline";
  state.selectedCarrier = "all";

  setModeBadge();
  updateImpactHeader();
  buildFilters();
  renderScenarioList();
  renderDriverList();
  renderComparisonPanel();
  renderExecutiveBrief();
  renderGlobeOrFallback();
  renderCharts();
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
  if (confidence) confidence.textContent = `Confidence: partial output state. ${err.message}`;
  document.getElementById("scenario-list").innerHTML =
    '<p class="empty">Required output artifacts missing. Generate outputs/tables and outputs/metadata.json.</p>';
  document.getElementById("driver-list").innerHTML =
    '<p class="empty">Top drivers unavailable in current deployment artifact set.</p>';
  document.getElementById("map-note").textContent =
    "Route visualization unavailable until route_network.csv and metadata are present.";
});
