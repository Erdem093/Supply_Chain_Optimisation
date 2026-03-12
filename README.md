# Supply Tracker

Supply Tracker is a supply-chain cost intelligence app with two parts:
- A Python pipeline that analyzes logistics spend and writes output artifacts.
- A browser UI (`/web`) that visualizes routes on an interactive 3D globe, compares baseline vs scenario costs, and supports local CSV upload.

## Live Demo
- Vercel (Live Demo): `https://supply-chain-optimisation-3d2nsuysp-erdem093s-projects.vercel.app/web/`

## What The App Does
- Ranks top routes and cost drivers (route, carrier, geography, shipment size, urgency).
- Shows route intelligence in:
  - `3D GLOBE` (animated arcs, hubs, rings)
  - `2D MAP` fallback view
- Shows scenario impact panels (`Before vs After`, leaderboard, executive brief, charts).
- Supports two data modes:
  - `Demo`: reads generated pipeline outputs from `outputs/`
  - `Upload CSV`: processes your CSV in-browser (no upload to server)

## Exact Upload CSV Format (Required)
**Your CSV must contain logical columns for `origin`, `destination`, and `freight_cost`.**

Accepted header aliases:
- `origin`: `origin`, `manufacturing_site`, `source`, `from`, `origin_country`, `site`
- `destination`: `destination`, `country`, `destination_country`, `to`, `geography`, `region`
- `freight_cost`: `freight_cost_usd`, `freight_cost`, `freight cost usd`, `cost`, `transport_cost`

Optional aliases:
- `carrier`: `carrier`, `fulfill_via`, `vendor`, `shipment_mode`
- `shipment_id`: `shipment_id`, `id`, `asn_dn`, `po_so`, `pq`

Example:

```csv
shipment_id,origin,destination,carrier,freight_cost_usd
SHP-001,Shanghai Hub,Australia,Oceanic Freight,10031
SHP-002,Mumbai Hub,New Zealand,Global Cargo,7900
```

Notes:
- In Upload mode, scenario simulation is not run in-browser; scenario-specific outputs come from the Python pipeline.
- Missing coordinates fallback to deterministic pseudo-coordinates for visualization continuity.

## Run The Web App
From repo root:

```bash
python3 -m http.server 4173
```

Open:
- `http://localhost:4173/` (root redirects to `/web/`)

## Run The Python Pipeline

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m src.main --input /path/to/your_input.csv --output outputs
```

## Artifacts Used By The UI
The web app reads these files when in Demo mode:
- `outputs/tables/baseline.csv`
- `outputs/tables/scenario_results.csv`
- `outputs/tables/top_drivers.csv`
- `outputs/tables/route_network.csv`
- `outputs/metadata.json`
- `config/location_coords.json` (optional)

## Project Structure
- `src/data_pipeline.py` - ingestion and canonical transformation
- `src/cost_driver_analysis.py` - baseline and cost-driver analysis
- `src/scenario_model.py` - deterministic scenario simulation
- `src/visualize.py` - figure generation
- `src/reporting.py` - recommendation/summary output
- `src/main.py` - orchestration entrypoint
- `web/index.html` - dashboard shell
- `web/styles.css` - UI theme and layout
- `web/app.js` - interactivity, globe rendering, charts, upload handling

## Testing

```bash
pytest -q
```
