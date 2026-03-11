# Supply Chain Cost Optimization Recommendations

## Baseline Snapshot
- Total logistics cost: $168,477.00
- Total shipments: 24

## Top Cost Drivers
- route: Shanghai Hub -> Australia ($10,031.00, 5.95% share)
- route: Los Angeles Hub -> China ($9,800.00, 5.82% share)
- route: Singapore Hub -> South Korea ($9,300.00, 5.52% share)
- carrier: Air ($84,100.00, 49.92% share)
- carrier: Ocean ($44,431.00, 26.37% share)

## Recommended Actions (Top 3 Scenarios)
1. **carrier_tier_switch** | Savings: $12,908.00 (7.66%) | Risk: medium
   - Assumption: Switched eligible lanes to lower-cost carrier tiers using configured unit-rate deltas; default delta -8%.
2. **lead_time_relaxation** | Savings: $3,555.00 (2.11%) | Risk: low
   - Assumption: Downgraded 35% of urgent shipments to standard lead time with -15% freight-rate impact.
3. **shipment_consolidation** | Savings: $0.00 (0.00%) | Risk: low
   - Assumption: Consolidated small shipments (<= 100.0) on route-carrier groups with >= 3 shipments at 12% unit-cost reduction.

## Decision Guidance
- Prioritize low-risk savings opportunities first, then pilot medium-risk carrier changes on high-cost lanes.
- Track realized vs modeled savings monthly and recalibrate assumptions after first implementation cycle.
