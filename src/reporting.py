from __future__ import annotations

import pandas as pd


def build_recommendation(scenario_results: pd.DataFrame, driver_summary: dict) -> str:
    """Generate one-page executive recommendation markdown."""
    baseline_df = driver_summary["baseline"]
    baseline_cost = float(
        baseline_df.loc[baseline_df["metric"] == "total_logistics_cost", "value"].iloc[0]
    )

    top_scenarios = scenario_results.head(3).copy()
    lines = [
        "# Supply Chain Cost Optimization Recommendations",
        "",
        "## Baseline Snapshot",
        f"- Total logistics cost: ${baseline_cost:,.2f}",
        f"- Total shipments: {int(baseline_df.loc[baseline_df['metric'] == 'total_shipments', 'value'].iloc[0])}",
        "",
        "## Top Cost Drivers",
    ]

    top_drivers = driver_summary["top_drivers"].head(5)
    for _, row in top_drivers.iterrows():
        lines.append(
            f"- {row['source_table'].replace('by_', '').replace('_', ' ')}: {row['driver_value']} "
            f"(${row['total_cost']:,.2f}, {row['cost_share_pct']:.2f}% share)"
        )

    lines.extend(["", "## Recommended Actions (Top 3 Scenarios)"])
    for i, (_, row) in enumerate(top_scenarios.iterrows(), start=1):
        lines.append(
            f"{i}. **{row['scenario']}** | Savings: ${row['absolute_savings']:,.2f} "
            f"({row['savings_pct']:.2f}%) | Risk: {row['risk_level']}"
        )
        lines.append(f"   - Assumption: {row['assumptions']}")

    lines.extend(
        [
            "",
            "## Decision Guidance",
            "- Prioritize low-risk savings opportunities first, then pilot medium-risk carrier changes on high-cost lanes.",
            "- Track realized vs modeled savings monthly and recalibrate assumptions after first implementation cycle.",
        ]
    )

    return "\n".join(lines) + "\n"
