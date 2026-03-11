from __future__ import annotations

from collections import OrderedDict

import pandas as pd

from .data_pipeline import CANONICAL


def _group_cost(df: pd.DataFrame, column: str, top_n: int = 10) -> pd.DataFrame:
    grouped = (
        df.groupby(column, dropna=False, as_index=False)[CANONICAL.freight_cost]
        .sum()
        .rename(columns={column: "driver_value", CANONICAL.freight_cost: "total_cost"})
    )
    grouped["cost_share_pct"] = (grouped["total_cost"] / grouped["total_cost"].sum() * 100).round(2)
    grouped["driver"] = column
    grouped = grouped.sort_values(["total_cost", "driver_value"], ascending=[False, True]).reset_index(drop=True)
    return grouped.head(top_n)


def analyze_cost_drivers(df: pd.DataFrame) -> dict[str, pd.DataFrame]:
    """Compute deterministic baseline and top cost drivers."""
    baseline_total = float(df[CANONICAL.freight_cost].sum())

    summaries = OrderedDict()
    summaries["baseline"] = pd.DataFrame(
        {
            "metric": ["total_shipments", "total_logistics_cost", "avg_cost_per_shipment"],
            "value": [len(df), baseline_total, baseline_total / max(len(df), 1)],
        }
    )

    for col in [CANONICAL.route, CANONICAL.carrier, CANONICAL.geography, "shipment_size_bucket", CANONICAL.urgency]:
        summaries[f"by_{col}"] = _group_cost(df, col)

    top_rows = []
    for name, table in summaries.items():
        if name == "baseline":
            continue
        table_copy = table.copy()
        table_copy["source_table"] = name
        top_rows.append(table_copy.head(3))

    summaries["top_drivers"] = pd.concat(top_rows, ignore_index=True)
    return summaries
