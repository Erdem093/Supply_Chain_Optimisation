from __future__ import annotations

import time
from pathlib import Path

import pandas as pd

from src.cost_driver_analysis import analyze_cost_drivers
from src.data_pipeline import CANONICAL, get_required_columns, load_and_prepare_data
from src.main import run_pipeline
from src.scenario_model import simulate_scenarios


def _make_sample_dataset(path: Path, n: int = 120) -> None:
    rows = []
    base_date = pd.Timestamp("2024-01-01")
    for i in range(n):
        rows.append(
            {
                "ID": f"S{i:04d}",
                "Country": "Kenya" if i % 2 == 0 else "Uganda",
                "Fulfill Via": "Air" if i % 3 == 0 else "Truck",
                "Shipment Mode": "Urgent Air" if i % 5 == 0 else "Standard",
                "PO Sent to Vendor Date": (base_date + pd.Timedelta(days=i % 30)).strftime("%Y-%m-%d"),
                "Manufacturing Site": "Site A" if i % 2 == 0 else "Site B",
                "Line Item Quantity": (i % 200) + 1,
                "Freight Cost (USD)": float(100 + (i % 20) * 15),
            }
        )
    pd.DataFrame(rows).to_csv(path, index=False)


def test_data_integrity_and_required_columns(tmp_path: Path) -> None:
    csv_path = tmp_path / "sample.csv"
    _make_sample_dataset(csv_path)

    df = load_and_prepare_data(str(csv_path))
    required = get_required_columns()

    assert required.issubset(set(df.columns))
    assert (df[CANONICAL.freight_cost] >= 0).all()
    assert (df[CANONICAL.shipment_size] >= 0).all()


def test_analysis_cost_consistency(tmp_path: Path) -> None:
    csv_path = tmp_path / "sample.csv"
    _make_sample_dataset(csv_path)
    df = load_and_prepare_data(str(csv_path))

    summary = analyze_cost_drivers(df)
    baseline_total = float(
        summary["baseline"].loc[
            summary["baseline"]["metric"] == "total_logistics_cost", "value"
        ].iloc[0]
    )
    direct_total = float(df[CANONICAL.freight_cost].sum())

    assert abs(baseline_total - direct_total) < 1e-6
    assert len(summary["top_drivers"]) > 0


def test_scenario_sanity(tmp_path: Path) -> None:
    csv_path = tmp_path / "sample.csv"
    _make_sample_dataset(csv_path)
    df = load_and_prepare_data(str(csv_path))

    config = {
        "consolidation": {
            "min_shipments_to_merge": 3,
            "small_shipment_max_units": 120,
            "cost_reduction_rate": 0.10,
        },
        "carrier_switch": {"default_unit_rate_delta": -0.05, "eligible_lanes": []},
        "lead_time": {
            "eligible_urgent_classes": ["urgent"],
            "downgrade_ratio": 0.30,
            "rate_impact": -0.10,
        },
    }

    out = simulate_scenarios(df, config)
    assert set(out["scenario"].tolist()) == {
        "shipment_consolidation",
        "carrier_tier_switch",
        "lead_time_relaxation",
    }
    assert (out["scenario_cost"] <= out["baseline_cost"]).all()
    expected_savings = out["baseline_cost"] - out["scenario_cost"]
    assert (out["absolute_savings"] - expected_savings).abs().max() < 1e-9


def test_end_to_end_outputs_and_runtime(tmp_path: Path) -> None:
    csv_path = tmp_path / "sample.csv"
    out_dir = tmp_path / "outputs"
    _make_sample_dataset(csv_path, n=300)

    start = time.perf_counter()
    run_pipeline(str(csv_path), str(out_dir))
    elapsed = time.perf_counter() - start

    assert elapsed < 120
    assert (out_dir / "recommendation_onepager.md").exists()

    table_dir = out_dir / "tables"
    fig_dir = out_dir / "figures"
    assert any(table_dir.glob("*.csv"))
    assert any(fig_dir.glob("*.png"))
