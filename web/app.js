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
  return values.map((v) => v.trim());
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const row = {};
    const cols = parseCsvLine(line);
    headers.forEach((h, idx) => {
      row[h] = cols[idx] || "";
    });
    return row;
  });
}

async function loadCsv(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`missing ${path}`);
  return parseCsv(await res.text());
}

const n = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
};

const money = (value) =>
  n(value).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2
  });

function updateStatus(text, ok) {
  const el = document.getElementById("status-text");
  el.textContent = text;
  el.style.color = ok ? "#0f766e" : "#334155";
}

function renderKpis(baselineRows, scenarioRows) {
  const metric = (name) => baselineRows.find((r) => r.metric === name)?.value;
  const best = [...scenarioRows].sort((a, b) => n(b.absolute_savings) - n(a.absolute_savings))[0];

  const values = [
    metric("total_logistics_cost") ? money(metric("total_logistics_cost")) : "--",
    metric("total_shipments") ? Math.round(n(metric("total_shipments"))).toLocaleString() : "--",
    metric("avg_cost_per_shipment") ? money(metric("avg_cost_per_shipment")) : "--",
    best ? `${money(best.absolute_savings)} (${n(best.savings_pct).toFixed(2)}%)` : "--"
  ];

  document.querySelectorAll(".kpi-value").forEach((el, idx) => {
    el.textContent = values[idx] || "--";
  });
}

function renderScenarios(rows) {
  const box = document.getElementById("scenario-cards");
  if (!rows.length) {
    box.innerHTML = "<p>Run pipeline to generate scenario results.</p>";
    return;
  }

  box.innerHTML = rows
    .sort((a, b) => n(b.absolute_savings) - n(a.absolute_savings))
    .map(
      (r, idx) => `
        <article class="scenario-card">
          <div class="scenario-top">
            <div class="scenario-name">#${idx + 1} ${(r.scenario || "scenario").replaceAll("_", " ")}</div>
            <div class="scenario-saving">${money(r.absolute_savings)}</div>
          </div>
          <div class="scenario-meta">Savings ${n(r.savings_pct).toFixed(2)}% | Risk ${(r.risk_level || "n/a").toUpperCase()}</div>
          <div class="scenario-meta">${r.assumptions || "No assumptions available."}</div>
        </article>
      `
    )
    .join("");
}

function renderDrivers(rows) {
  const box = document.getElementById("driver-list");
  if (!rows.length) {
    box.innerHTML = "<p>Top drivers will appear after pipeline run.</p>";
    return;
  }

  box.innerHTML = rows
    .slice(0, 8)
    .map(
      (r) => `
        <article class="driver-item">
          <p class="driver-main">${(r.source_table || "driver").replace("by_", "").replaceAll("_", " ")}: ${r.driver_value || "n/a"}</p>
          <p class="driver-sub">${money(r.total_cost)} | ${n(r.cost_share_pct).toFixed(2)}% share</p>
        </article>
      `
    )
    .join("");
}

async function loadRecommendation() {
  const box = document.getElementById("recommendation-box");
  try {
    const res = await fetch("../outputs/recommendation_onepager.md", { cache: "no-store" });
    if (!res.ok) throw new Error("missing recommendation");
    box.textContent = await res.text();
  } catch (_err) {
    box.textContent = "Run the pipeline to generate outputs/recommendation_onepager.md";
  }
}

async function boot() {
  try {
    const [baselineRows, scenarioRows, driverRows] = await Promise.all([
      loadCsv("../outputs/tables/baseline.csv"),
      loadCsv("../outputs/tables/scenario_results.csv"),
      loadCsv("../outputs/tables/top_drivers.csv")
    ]);

    renderKpis(baselineRows, scenarioRows);
    renderScenarios(scenarioRows);
    renderDrivers(driverRows);
    updateStatus("All output artifacts detected. Dashboard is live.", true);
  } catch (_err) {
    renderScenarios([]);
    renderDrivers([]);
    updateStatus("Outputs not ready yet. Run the pipeline first.", false);
  }

  await loadRecommendation();
}

boot();
