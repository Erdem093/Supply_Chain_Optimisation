from __future__ import annotations

from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.ticker as mticker
import numpy as np
import pandas as pd

# ── Design tokens ──────────────────────────────────────────────────────────────
_PALETTE = ["#2563eb", "#0ea5e9", "#0d9488", "#16a34a", "#d97706", "#dc2626", "#7c3aed", "#db2777"]
_SCENARIO_COLORS = ["#16a34a", "#2563eb", "#d97706"]
_BG = "#ffffff"
_SURFACE = "#f8fafc"
_GRID = "#e2e8f0"
_TEXT_DARK = "#0f172a"
_TEXT_MUTED = "#64748b"
_FONT_HEAD = "DejaVu Sans"


def _apply_style(fig: plt.Figure, ax: plt.Axes, title: str, subtitle: str = "") -> None:
    """Apply a clean, premium chart style."""
    fig.patch.set_facecolor(_BG)
    ax.set_facecolor(_SURFACE)

    # Remove top/right spines, soften bottom/left
    for spine in ("top", "right"):
        ax.spines[spine].set_visible(False)
    for spine in ("left", "bottom"):
        ax.spines[spine].set_color(_GRID)
        ax.spines[spine].set_linewidth(0.8)

    # Grid
    ax.set_axisbelow(True)
    ax.yaxis.grid(False)
    ax.xaxis.grid(True, color=_GRID, linewidth=0.7, linestyle="--", alpha=0.9)

    # Tick styling
    ax.tick_params(colors=_TEXT_MUTED, labelsize=10, length=0)

    # Title block
    fig.text(
        0.0, 1.0, title,
        transform=ax.transAxes,
        fontsize=14, fontweight="bold", color=_TEXT_DARK,
        va="bottom", ha="left",
    )
    if subtitle:
        fig.text(
            0.0, -0.02, subtitle,
            transform=ax.transAxes,
            fontsize=10, color=_TEXT_MUTED,
            va="top", ha="left",
        )


def _save_top_driver_chart(driver_df: pd.DataFrame, title: str, path: Path) -> None:
    chart = driver_df.head(8).copy()
    n_bars = len(chart)

    fig, ax = plt.subplots(figsize=(11, max(4.5, n_bars * 0.65)))

    colors = (_PALETTE * 3)[:n_bars]
    bars = ax.barh(
        chart["driver_value"].astype(str),
        chart["total_cost"],
        color=colors,
        height=0.60,
        edgecolor="none",
        zorder=3,
    )

    # Value labels
    max_val = float(chart["total_cost"].max()) if len(chart) else 1.0
    for bar, val in zip(bars, chart["total_cost"].tolist()):
        ax.text(
            bar.get_width() + max_val * 0.012,
            bar.get_y() + bar.get_height() / 2,
            f"${val:,.0f}",
            va="center", ha="left",
            fontsize=9, fontweight="600",
            color=_TEXT_DARK,
        )

    ax.invert_yaxis()
    ax.xaxis.set_major_formatter(mticker.FuncFormatter(lambda x, _: f"${x:,.0f}"))
    ax.set_xlim(0, max_val * 1.22)
    ax.set_xlabel("Total Logistics Cost (USD)", fontsize=10, color=_TEXT_MUTED, labelpad=8)

    _apply_style(fig, ax, title, subtitle="Top contributors to baseline spend")

    fig.tight_layout(pad=1.8)
    fig.savefig(path, dpi=160, bbox_inches="tight", facecolor=_BG)
    plt.close(fig)


def create_visualizations(
    driver_summary: dict[str, pd.DataFrame],
    scenario_results: pd.DataFrame,
    output_dir: str,
) -> None:
    figures_dir = Path(output_dir) / "figures"
    figures_dir.mkdir(parents=True, exist_ok=True)

    # Driver charts
    for key in ["by_route", "by_carrier", "by_geography", "by_shipment_size_bucket", "by_urgency"]:
        if key in driver_summary:
            label = key.replace("by_", "").replace("_", " ").title()
            _save_top_driver_chart(
                driver_summary[key],
                title=f"Cost Drivers by {label}",
                path=figures_dir / f"{key}.png",
            )

    # Scenario comparison chart
    fig, ax = plt.subplots(figsize=(10, 5.5))

    scenarios = scenario_results["scenario"].astype(str).tolist()
    savings = scenario_results["absolute_savings"].tolist()
    savings_pct = (
        scenario_results["savings_pct"].tolist()
        if "savings_pct" in scenario_results.columns
        else [0.0] * len(scenarios)
    )
    labels = [s.replace("_", " ").title() for s in scenarios]
    x = np.arange(len(labels))

    colors = (_SCENARIO_COLORS * 3)[: len(labels)]
    bars = ax.bar(
        x, savings,
        color=colors,
        width=0.50,
        edgecolor="none",
        zorder=3,
    )

    # Grid behind bars
    ax.yaxis.grid(True, color=_GRID, linewidth=0.7, linestyle="--", alpha=0.9, zorder=0)
    ax.xaxis.grid(False)
    ax.set_axisbelow(True)

    # Value labels above bars
    max_sav = float(max(savings)) if savings else 1.0
    for bar, val, spct in zip(bars, savings, savings_pct):
        if val > 0:
            ax.text(
                bar.get_x() + bar.get_width() / 2,
                bar.get_height() + max_sav * 0.018,
                f"${val:,.0f}\n({spct:.1f}%)",
                ha="center", va="bottom",
                fontsize=10.5, fontweight="700",
                color=_TEXT_DARK,
                linespacing=1.4,
            )
        else:
            ax.text(
                bar.get_x() + bar.get_width() / 2,
                max_sav * 0.025,
                "No savings\napplicable",
                ha="center", va="bottom",
                fontsize=9, color=_TEXT_MUTED,
                style="italic", linespacing=1.4,
            )

    ax.set_xticks(x)
    ax.set_xticklabels(labels, fontsize=11.5, fontweight="600", color=_TEXT_DARK)
    ax.set_xlim(-0.5, len(labels) - 0.5)
    ax.set_ylim(0, max_sav * 1.28 if max_sav > 0 else 1000)
    ax.yaxis.set_major_formatter(mticker.FuncFormatter(lambda y, _: f"${y:,.0f}"))
    ax.set_ylabel("Absolute Savings (USD)", fontsize=10, color=_TEXT_MUTED, labelpad=8)

    _apply_style(fig, ax, "Estimated Savings by Scenario", subtitle="Pipeline-modelled optimization scenarios")

    # Remove x/y spines for a cleaner bar chart look
    ax.spines["bottom"].set_visible(False)
    ax.tick_params(axis="x", length=0)

    fig.tight_layout(pad=1.8)
    fig.savefig(figures_dir / "scenario_savings.png", dpi=160, bbox_inches="tight", facecolor=_BG)
    plt.close(fig)
