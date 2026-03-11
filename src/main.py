from __future__ import annotations

import argparse
import json
import time
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from .cost_driver_analysis import analyze_cost_drivers
from .data_pipeline import CANONICAL, load_and_prepare_data
from .reporting import build_recommendation
from .scenario_model import simulate_scenarios
from .visualize import create_visualizations


def _read_config(config_path: str) -> dict:
    path = Path(config_path)
    if not path.exists():
        return {}
    if path.suffix.lower() == ".json":
        return json.loads(path.read_text())

    try:
        import yaml  # type: ignore
    except ImportError as exc:
        raise RuntimeError(
            "YAML config requires pyyaml. Install requirements or provide JSON config."
        ) from exc
    return yaml.safe_load(path.read_text()) or {}


def _build_route_network(df: pd.DataFrame) -> pd.DataFrame:
    route_parts = df[CANONICAL.route].astype(str).str.split("->", n=1, expand=True)

    routes = pd.DataFrame(
        {
            "origin": route_parts[0].str.strip(),
            "destination": route_parts[1].fillna("Unknown").str.strip(),
            "carrier": df[CANONICAL.carrier].astype(str),
            "freight_cost": df[CANONICAL.freight_cost],
            "shipment_id": df[CANONICAL.shipment_id],
        }
    )

    grouped = (
        routes.groupby(["origin", "destination", "carrier"], as_index=False)
        .agg(total_cost=("freight_cost", "sum"), shipment_count=("shipment_id", "count"))
        .sort_values(["total_cost", "origin", "destination"], ascending=[False, True, True])
        .reset_index(drop=True)
    )

    total_cost_all = grouped["total_cost"].sum()
    grouped["cost_share_pct"] = (
        (grouped["total_cost"] / total_cost_all * 100.0).round(2) if total_cost_all else 0.0
    )

    return grouped[["origin", "destination", "total_cost", "shipment_count", "cost_share_pct", "carrier"]]


def _write_tables(
    driver_summary: dict[str, pd.DataFrame],
    scenario_results: pd.DataFrame,
    route_network: pd.DataFrame,
    output_dir: str,
) -> None:
    table_dir = Path(output_dir) / "tables"
    table_dir.mkdir(parents=True, exist_ok=True)

    for name, df in driver_summary.items():
        df.to_csv(table_dir / f"{name}.csv", index=False)
    scenario_results.to_csv(table_dir / "scenario_results.csv", index=False)
    route_network.to_csv(table_dir / "route_network.csv", index=False)


def _write_metadata(
    input_path: str,
    output_dir: str,
    df: pd.DataFrame,
    scenario_results: pd.DataFrame,
    route_network: pd.DataFrame,
) -> None:
    best = scenario_results.sort_values("absolute_savings", ascending=False).head(1)
    best_row = best.iloc[0] if not best.empty else None

    metadata = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "dataset_name": Path(input_path).name,
        "key_totals": {
            "total_shipments": int(len(df)),
            "total_logistics_cost": float(df[CANONICAL.freight_cost].sum()),
            "unique_routes": int(route_network[["origin", "destination"]].drop_duplicates().shape[0]),
            "unique_carriers": int(df[CANONICAL.carrier].nunique()),
        },
        "best_scenario": (
            {
                "name": str(best_row["scenario"]),
                "absolute_savings": float(best_row["absolute_savings"]),
                "savings_pct": float(best_row["savings_pct"]),
                "risk_level": str(best_row["risk_level"]),
            }
            if best_row is not None
            else None
        ),
    }

    out_path = Path(output_dir) / "metadata.json"
    out_path.write_text(json.dumps(metadata, indent=2))


def run_pipeline(input_path: str, output_dir: str) -> None:
    start = time.perf_counter()
    project_root = Path(__file__).resolve().parents[1]
    default_config = project_root / "config" / "scenario_config.json"

    df = load_and_prepare_data(input_path)
    config = _read_config(str(default_config))
    driver_summary = analyze_cost_drivers(df)
    scenario_results = simulate_scenarios(df, config)
    route_network = _build_route_network(df)

    _write_tables(driver_summary, scenario_results, route_network, output_dir)
    create_visualizations(driver_summary, scenario_results, output_dir)
    _write_metadata(input_path, output_dir, df, scenario_results, route_network)

    recommendation = build_recommendation(scenario_results, driver_summary)
    out_path = Path(output_dir) / "recommendation_onepager.md"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(recommendation)

    elapsed = time.perf_counter() - start
    print(f"Pipeline complete in {elapsed:.2f} seconds. Outputs written to {output_dir}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Supply chain cost optimization analysis pipeline")
    parser.add_argument("--input", required=True, help="Path to Kaggle logistics CSV")
    parser.add_argument("--output", default="outputs", help="Output directory path")
    args = parser.parse_args()
    run_pipeline(args.input, args.output)


if __name__ == "__main__":
    main()
