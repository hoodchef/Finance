# ASTS Intrinsic Valuation Model — reproducibility package

`ASTS_Valuation_Model.xlsx` is the deliverable (live formulas). This folder rebuilds and re-verifies it.

| File | Role |
|---|---|
| `inputs.py` | Single source of truth for every assumption, with source/rationale |
| `data/ibkr.py` | Raw IBKR weekly closes (ASTS, SPY) retrieved 10-Sep-2026 |
| `build_xlsx.py`, `finalize.py` | Agent 1: generate the formula workbook |
| `engine.py` | Agent 2: independent reference implementation |
| `analytics.py` | Agent 2: Monte Carlo (seed 20260910), tornado, grids, reverse DCF |
| `audit.py` | Agent 3: recalculated workbook vs engine, every row/period/scenario |
| `stress.py`, `final_validation.py` | Break tests, fuzzing, economic property tests |

Rebuild: `python3 analytics.py && python3 finalize.py && python3 recalc.py ASTS_Valuation_Model.xlsx && python3 audit.py ASTS_Valuation_Model.xlsx`
Requires numpy, scipy, openpyxl, LibreOffice (for recalc).
