from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import pandas as pd

from .cost_driver_analysis import analyze_cost_drivers
from .data_pipeline import load_and_prepare_data
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


def _write_tables(driver_summary: dict[str, pd.DataFrame], scenario_results: pd.DataFrame, output_dir: str) -> None:
    table_dir = Path(output_dir) / "tables"
    table_dir.mkdir(parents=True, exist_ok=True)

    for name, df in driver_summary.items():
        df.to_csv(table_dir / f"{name}.csv", index=False)
    scenario_results.to_csv(table_dir / "scenario_results.csv", index=False)


def run_pipeline(input_path: str, output_dir: str) -> None:
    start = time.perf_counter()
    project_root = Path(__file__).resolve().parents[1]
    default_config = project_root / "config" / "scenario_config.json"

    df = load_and_prepare_data(input_path)
    config = _read_config(str(default_config))
    driver_summary = analyze_cost_drivers(df)
    scenario_results = simulate_scenarios(df, config)

    _write_tables(driver_summary, scenario_results, output_dir)
    create_visualizations(driver_summary, scenario_results, output_dir)

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
