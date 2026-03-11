from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .data_pipeline import CANONICAL


@dataclass(frozen=True)
class ScenarioResult:
    scenario: str
    baseline_cost: float
    scenario_cost: float
    absolute_savings: float
    savings_pct: float
    risk_level: str
    assumptions: str


def _apply_consolidation(df: pd.DataFrame, config: dict) -> tuple[pd.DataFrame, str]:
    cfg = config.get("consolidation", {})
    min_shipments = int(cfg.get("min_shipments_to_merge", 3))
    small_threshold = float(cfg.get("small_shipment_max_units", 100.0))
    reduction_rate = float(cfg.get("cost_reduction_rate", 0.12))

    out = df.copy()
    group_cols = [CANONICAL.route, CANONICAL.carrier]
    group_count = out.groupby(group_cols)[CANONICAL.shipment_id].transform("count")
    eligible = (group_count >= min_shipments) & (out[CANONICAL.shipment_size] <= small_threshold)
    out["scenario_cost"] = np.where(
        eligible,
        out[CANONICAL.freight_cost] * (1 - reduction_rate),
        out[CANONICAL.freight_cost],
    )
    assumption = (
        f"Consolidated small shipments (<= {small_threshold}) on route-carrier groups with "
        f">= {min_shipments} shipments at {reduction_rate:.0%} unit-cost reduction."
    )
    return out, assumption


def _apply_carrier_switch(df: pd.DataFrame, config: dict) -> tuple[pd.DataFrame, str]:
    cfg = config.get("carrier_switch", {})
    default_delta = float(cfg.get("default_unit_rate_delta", -0.08))
    eligible_lanes = set(cfg.get("eligible_lanes", []))
    tier_map = cfg.get("target_tier_map", {})

    out = df.copy()
    out["scenario_cost"] = out[CANONICAL.freight_cost]

    if eligible_lanes:
        lane_mask = out[CANONICAL.route].isin(eligible_lanes)
    else:
        lane_mask = pd.Series([True] * len(out), index=out.index)

    if tier_map:
        deltas = out[CANONICAL.carrier].map(tier_map).fillna(default_delta)
    else:
        deltas = pd.Series([default_delta] * len(out), index=out.index)

    out.loc[lane_mask, "scenario_cost"] = out.loc[lane_mask, CANONICAL.freight_cost] * (1 + deltas[lane_mask])
    assumption = (
        "Switched eligible lanes to lower-cost carrier tiers using configured unit-rate deltas; "
        f"default delta {default_delta:.0%}."
    )
    return out, assumption


def _apply_lead_time_relaxation(df: pd.DataFrame, config: dict) -> tuple[pd.DataFrame, str]:
    cfg = config.get("lead_time", {})
    urgent_classes = set([str(v).lower() for v in cfg.get("eligible_urgent_classes", ["urgent"])])
    downgrade_ratio = float(cfg.get("downgrade_ratio", 0.35))
    rate_impact = float(cfg.get("rate_impact", -0.15))

    out = df.copy()
    out["scenario_cost"] = out[CANONICAL.freight_cost]

    is_urgent = out[CANONICAL.urgency].astype(str).str.lower().isin(urgent_classes)
    urgent_idx = out[is_urgent].index
    n_to_downgrade = int(len(urgent_idx) * downgrade_ratio)

    if n_to_downgrade > 0:
        selected = sorted(urgent_idx.tolist())[:n_to_downgrade]
        out.loc[selected, "scenario_cost"] = out.loc[selected, CANONICAL.freight_cost] * (1 + rate_impact)

    assumption = (
        f"Downgraded {downgrade_ratio:.0%} of urgent shipments to standard lead time "
        f"with {rate_impact:.0%} freight-rate impact."
    )
    return out, assumption


def _summarize(df: pd.DataFrame, scenario_name: str, risk_level: str, assumptions: str) -> ScenarioResult:
    baseline = float(df[CANONICAL.freight_cost].sum())
    scenario_cost = float(df["scenario_cost"].sum())
    savings = baseline - scenario_cost
    savings_pct = (savings / baseline * 100.0) if baseline else 0.0
    return ScenarioResult(
        scenario=scenario_name,
        baseline_cost=baseline,
        scenario_cost=scenario_cost,
        absolute_savings=savings,
        savings_pct=savings_pct,
        risk_level=risk_level,
        assumptions=assumptions,
    )


def simulate_scenarios(df: pd.DataFrame, config: dict) -> pd.DataFrame:
    """Run deterministic scenario simulations and rank by savings."""
    scenario_rows: list[ScenarioResult] = []

    c_df, c_assumption = _apply_consolidation(df, config)
    scenario_rows.append(_summarize(c_df, "shipment_consolidation", "low", c_assumption))

    carrier_df, carrier_assumption = _apply_carrier_switch(df, config)
    scenario_rows.append(_summarize(carrier_df, "carrier_tier_switch", "medium", carrier_assumption))

    lead_df, lead_assumption = _apply_lead_time_relaxation(df, config)
    scenario_rows.append(_summarize(lead_df, "lead_time_relaxation", "low", lead_assumption))

    result = pd.DataFrame([row.__dict__ for row in scenario_rows])
    result = result.sort_values(["absolute_savings", "scenario"], ascending=[False, True]).reset_index(drop=True)
    return result
