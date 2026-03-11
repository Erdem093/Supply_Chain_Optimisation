from __future__ import annotations

from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd


def _save_top_driver_chart(driver_df: pd.DataFrame, title: str, path: Path) -> None:
    chart = driver_df.head(10).copy()
    fig, ax = plt.subplots(figsize=(10, 5))
    ax.barh(chart["driver_value"].astype(str), chart["total_cost"], color="#2f6f95")
    ax.set_title(title)
    ax.set_xlabel("Total Cost")
    ax.set_ylabel("Driver")
    ax.invert_yaxis()
    fig.tight_layout()
    fig.savefig(path, dpi=160)
    plt.close(fig)


def create_visualizations(driver_summary: dict[str, pd.DataFrame], scenario_results: pd.DataFrame, output_dir: str) -> None:
    figures_dir = Path(output_dir) / "figures"
    figures_dir.mkdir(parents=True, exist_ok=True)

    for key in ["by_route", "by_carrier", "by_geography", "by_shipment_size_bucket", "by_urgency"]:
        if key in driver_summary:
            _save_top_driver_chart(
                driver_summary[key],
                title=f"Top Cost Drivers: {key.replace('by_', '').replace('_', ' ').title()}",
                path=figures_dir / f"{key}.png",
            )

    # Scenario comparison.
    fig, ax = plt.subplots(figsize=(9, 5))
    x = scenario_results["scenario"].astype(str)
    y = scenario_results["absolute_savings"]
    ax.bar(x, y, color=["#3e8e41", "#2a9d8f", "#264653"])
    ax.set_title("Estimated Cost Savings by Scenario")
    ax.set_ylabel("Absolute Savings")
    ax.set_xlabel("Scenario")
    ax.tick_params(axis="x", rotation=15)
    fig.tight_layout()
    fig.savefig(figures_dir / "scenario_savings.png", dpi=160)
    plt.close(fig)
