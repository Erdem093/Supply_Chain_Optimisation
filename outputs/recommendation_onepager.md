# Supply Chain Cost Optimization Recommendations

## Baseline Snapshot
- Total logistics cost: $5,034.50
- Total shipments: 10

## Top Cost Drivers
- route: Site A -> Kenya ($1,616.30, 32.10% share)
- route: Site B -> Uganda ($1,200.00, 23.84% share)
- route: Site C -> Rwanda ($1,148.20, 22.81% share)
- carrier: Air ($2,978.20, 59.16% share)
- carrier: Truck ($2,056.30, 40.84% share)

## Recommended Actions (Top 3 Scenarios)
1. **carrier_tier_switch** | Savings: $421.20 (8.37%) | Risk: medium
   - Assumption: Switched eligible lanes to lower-cost carrier tiers using configured unit-rate deltas; default delta -8%.
2. **lead_time_relaxation** | Savings: $78.00 (1.55%) | Risk: low
   - Assumption: Downgraded 35% of urgent shipments to standard lead time with -15% freight-rate impact.
3. **shipment_consolidation** | Savings: $0.00 (0.00%) | Risk: low
   - Assumption: Consolidated small shipments (<= 100.0) on route-carrier groups with >= 3 shipments at 12% unit-cost reduction.

## Decision Guidance
- Prioritize low-risk savings opportunities first, then pilot medium-risk carrier changes on high-cost lanes.
- Track realized vs modeled savings monthly and recalibrate assumptions after first implementation cycle.
