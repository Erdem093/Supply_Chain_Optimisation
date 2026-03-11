from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd


@dataclass(frozen=True)
class CanonicalColumns:
    shipment_id: str = "shipment_id"
    ship_date: str = "ship_date"
    route: str = "route"
    carrier: str = "carrier"
    geography: str = "geography"
    shipment_size: str = "shipment_size"
    urgency: str = "urgency"
    freight_cost: str = "freight_cost"


CANONICAL = CanonicalColumns()

# Ordered aliases. First existing alias wins.
COLUMN_ALIASES: dict[str, list[str]] = {
    CANONICAL.shipment_id: ["id", "shipment_id", "asn_dn", "po_so", "pq"],
    CANONICAL.ship_date: [
        "shipment_date",
        "ship_date",
        "po_sent_to_vendor_date",
        "scheduled_delivery_date",
        "delivered_to_client_date",
        "pq_first_sent_to_client_date",
    ],
    CANONICAL.carrier: ["carrier", "fulfill_via", "vendor", "shipment_mode"],
    CANONICAL.geography: ["country", "destination_country", "geography", "region"],
    CANONICAL.shipment_size: [
        "line_item_quantity",
        "weight_kilograms",
        "shipment_size",
        "quantity",
    ],
    CANONICAL.freight_cost: ["freight_cost_usd", "freight_cost", "transport_cost", "cost"],
    CANONICAL.urgency: ["urgency", "shipment_mode", "priority"],
}


def _normalize_name(name: str) -> str:
    return (
        name.strip()
        .lower()
        .replace("(", "")
        .replace(")", "")
        .replace("#", "")
        .replace("/", "_")
        .replace("-", "_")
        .replace(" ", "_")
    )


def _first_existing_column(columns: list[str], aliases: list[str]) -> str | None:
    normalized = {_normalize_name(c): c for c in columns}
    for alias in aliases:
        if alias in normalized:
            return normalized[alias]
    return None


def _map_columns(df: pd.DataFrame) -> dict[str, str]:
    mapping: dict[str, str] = {}
    for canonical, aliases in COLUMN_ALIASES.items():
        found = _first_existing_column(list(df.columns), aliases)
        if found is not None:
            mapping[canonical] = found
    return mapping


def _validate_required_columns(mapped: dict[str, str]) -> None:
    required = {CANONICAL.freight_cost, CANONICAL.shipment_size, CANONICAL.geography, CANONICAL.carrier}
    missing = sorted(required.difference(mapped.keys()))
    if missing:
        raise ValueError(
            "Input data missing required logical columns: "
            + ", ".join(missing)
            + ". Available mapping: "
            + str(mapped)
        )


def _derive_ship_date(df: pd.DataFrame, mapped: dict[str, str]) -> pd.Series:
    source = mapped.get(CANONICAL.ship_date)
    if source is None:
        return pd.to_datetime("today").normalize() + pd.to_timedelta(np.arange(len(df)), unit="D")
    return pd.to_datetime(df[source], errors="coerce")


def _derive_route(df: pd.DataFrame) -> pd.Series:
    possible_origin = ["manufacturing_site", "origin", "origin_country"]
    possible_dest = ["country", "destination_country", "geography", "region"]
    origin_col = _first_existing_column(list(df.columns), possible_origin)
    dest_col = _first_existing_column(list(df.columns), possible_dest)

    if origin_col and dest_col:
        return df[origin_col].astype(str) + " -> " + df[dest_col].astype(str)
    if dest_col:
        return "Unknown Origin -> " + df[dest_col].astype(str)
    return pd.Series(["Unknown Route"] * len(df), index=df.index)


def _derive_urgency(df: pd.DataFrame, mapped: dict[str, str]) -> pd.Series:
    if mapped.get(CANONICAL.urgency):
        raw = df[mapped[CANONICAL.urgency]].astype(str).str.lower()
        return np.where(raw.str.contains("air|urgent|expedite|express"), "urgent", "standard")

    possible_sched = _first_existing_column(list(df.columns), ["scheduled_delivery_date"])
    possible_actual = _first_existing_column(list(df.columns), ["delivered_to_client_date", "delivery_recorded_date"])
    if possible_sched and possible_actual:
        sched = pd.to_datetime(df[possible_sched], errors="coerce")
        actual = pd.to_datetime(df[possible_actual], errors="coerce")
        delay_days = (actual - sched).dt.days
        return np.where(delay_days.fillna(0) > 3, "urgent", "standard")

    return pd.Series(["standard"] * len(df), index=df.index)


def _clean_numeric(series: pd.Series, default_value: float = 0.0) -> pd.Series:
    cleaned = pd.to_numeric(series, errors="coerce").fillna(default_value)
    return cleaned


def _winsorize(series: pd.Series, lower_q: float = 0.01, upper_q: float = 0.99) -> pd.Series:
    low, high = series.quantile([lower_q, upper_q]).values
    return series.clip(lower=low, upper=high)


def load_and_prepare_data(input_path: str) -> pd.DataFrame:
    """Load logistics dataset and transform into canonical analytical schema."""
    raw = pd.read_csv(input_path)
    raw.columns = [_normalize_name(c) for c in raw.columns]
    mapped = _map_columns(raw)
    _validate_required_columns(mapped)

    df = pd.DataFrame(index=raw.index)
    df[CANONICAL.shipment_id] = (
        raw[mapped[CANONICAL.shipment_id]].astype(str)
        if mapped.get(CANONICAL.shipment_id)
        else raw.index.astype(str)
    )
    df[CANONICAL.ship_date] = _derive_ship_date(raw, mapped)
    df[CANONICAL.route] = _derive_route(raw)
    df[CANONICAL.carrier] = raw[mapped[CANONICAL.carrier]].astype(str).fillna("Unknown Carrier")
    df[CANONICAL.geography] = raw[mapped[CANONICAL.geography]].astype(str).fillna("Unknown Geography")
    df[CANONICAL.shipment_size] = _clean_numeric(raw[mapped[CANONICAL.shipment_size]], 1.0)
    df[CANONICAL.freight_cost] = _clean_numeric(raw[mapped[CANONICAL.freight_cost]], 0.0)
    df[CANONICAL.urgency] = _derive_urgency(raw, mapped)

    # Ensure non-negative values and reproducible outlier treatment.
    df[CANONICAL.shipment_size] = df[CANONICAL.shipment_size].clip(lower=0.0)
    df[CANONICAL.freight_cost] = _winsorize(df[CANONICAL.freight_cost].clip(lower=0.0))

    df["shipment_size_bucket"] = pd.cut(
        df[CANONICAL.shipment_size],
        bins=[-1, 100, 1000, float("inf")],
        labels=["small", "medium", "large"],
    ).astype(str)

    return df


def get_required_columns() -> set[str]:
    return {CANONICAL.freight_cost, CANONICAL.shipment_size, CANONICAL.geography, CANONICAL.carrier}


def get_mapping_preview(input_path: str) -> dict[str, Any]:
    """Helper for debugging data source assumptions."""
    raw = pd.read_csv(input_path, nrows=20)
    raw.columns = [_normalize_name(c) for c in raw.columns]
    return _map_columns(raw)
