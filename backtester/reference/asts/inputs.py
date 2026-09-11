"""ASTS valuation model - assumption set (single source of truth).

Every entry: key -> (label, unit, value(s), source/rationale).
Scenario entries carry a 4-tuple (Distress, Bear, Base, Bull).
Numbers marked DATA come from filings / market data; ASSUMPTION = analyst judgement.
"""
SCEN = ["Distress", "Bear", "Base", "Bull"]
PERIODS = ["2026H2"] + [str(y) for y in range(2027, 2041)]
YEARS = [2026] + list(range(2027, 2041))            # calendar year of each period
LENS = [0.5] + [1.0] * 14                            # period length (years)
STARTS = [2026.5] + [float(y) for y in range(2027, 2041)]

# ---------------------------------------------------------------- global inputs
GLOBAL = [
    # key, label, unit, value, source
    ("hdr", "VALUATION & MARKET", None, None, None),
    ("val_date", "Valuation date (year fraction)", "yr", 2026.690,
     "DATA: 10-Sep-2026 = 2026 + 252/365."),
    ("rf", "Risk-free rate (10y UST)", "%", 0.0484,
     "DATA: 10y UST 4.84% on 10-Sep-2026 (TradingEconomics / CNBC)."),
    ("erp", "Equity risk premium (US implied)", "%", 0.0442,
     "DATA: Damodaran implied US ERP 4.42% at 1-Jul-2026 (Musings on Markets, Jul-2026)."),
    ("blume_w", "Blume weight on raw beta", "x", 0.67,
     "METHOD: Blume (1971) adjustment beta_adj = 0.67*raw + 0.33. Resolution R-01."),
    ("dv_hi", "Debt / capital - growth phase", "%", 0.15,
     "DATA-DERIVED: ~$4.2bn debt face vs ~$24.3bn equity mkt cap (Sep-2026) = 14.6%."),
    ("kd_hi", "Pre-tax cost of straight debt - growth phase", "%", 0.095,
     "ASSUMPTION: unrated issuer; straight-bond yield ~Rf+4.7%. Converts' coupons understate cost (embedded option)."),
    ("t_hi", "Tax rate in WACC - growth phase", "%", 0.0,
     "LOGIC: no cash taxes paid while loss-making (NOLs/bonus depreciation) -> no interest tax shield."),
    ("beta_term", "Beta - mature phase", "x", 1.00,
     "ASSUMPTION: mature satellite operator converges to market beta (Damodaran young-firm lifecycle method)."),
    ("dv_term", "Debt / capital - mature phase", "%", 0.25, "ASSUMPTION: mature telecom-like leverage."),
    ("kd_term", "Pre-tax cost of debt - mature phase", "%", 0.070, "ASSUMPTION: BB-area mature issuer."),
    ("t_term", "Tax rate in WACC - mature phase", "%", 0.25, "Equals cash tax rate."),
    ("wacc_fade_start", "WACC fade start year", "yr", 2031, "ASSUMPTION: fade begins after build-out."),
    ("wacc_fade_end", "WACC fade end year (mature from)", "yr", 2035, "ASSUMPTION."),
    ("wacc_shift", "WACC what-if shift (keep 0 for base valuation)", "%", 0.0,
     "LEVER: parallel shift to every period's WACC. Checked = 0 in delivered file."),
    ("g", "Terminal growth (nominal)", "%", 0.025,
     "ASSUMPTION: <= long-run nominal GDP and < Rf (checked)."),
    ("hdr", "OPERATIONS (all scenarios)", None, None, None),
    ("tax_rate", "Cash tax rate (fed 21% + state)", "%", 0.25, "ASSUMPTION: 21% federal + ~4% blended state."),
    ("nol_open", "Opening tax NOL pool (30-Jun-2026)", "$mm", 1000.0,
     "ASSUMPTION (flagged): accumulated deficit $1,253.6mm (10-Q) includes non-deductible items; haircut to $1.0bn."),
    ("nol_limit", "NOL usage cap (% of taxable income)", "%", 0.80, "LAW: post-TCJA federal 80% limitation."),
    ("bonus_dep", "100% bonus depreciation on capex (1=on)", "flag", 1,
     "LAW: OBBBA (Jul-2025) permanently restored 100% bonus depreciation. Verify with tax adviser."),
    ("sat_life", "Block 2 satellite design life", "yrs", 7,
     "SECONDARY DATA: 7-yr lifetime per Gunter's Space Page (BlueBird Block 2). Flagged for confirmation."),
    ("loss_rate", "Launch / early-life loss rate", "%", 0.05,
     "ASSUMPTION: 1 of 8 Block 2 lost (BB7, Apr-2026) = 12.5% observed; industry mature ~3-5%."),
    ("fleet_open", "Block 2 satellites launched at 30-Jun-2026", "#", 4,
     "DATA: BB6 (Dec-2025) + BB8-10 (17-Jun-2026). BB7 lost. (10-Q Note 1)"),
    ("cip_sat", "Satellite CIP / advance launch payments 30-Jun-2026", "$mm", 1724.085,
     "DATA: 10-Q Note 4, 'Satellite materials ... advance launch payments'."),
    ("partner_subs", "MNO partner subscriber base", "mm", 3000.0,
     "DATA: company - 60+ MNO partners covering 'over 3 billion' subscribers (Q2-26 deck)."),
    ("t1_share", "Share of partner base in Tier-1 (developed) markets", "%", 0.25,
     "ASSUMPTION: US/Canada/Europe/Japan/Gulf partners ~ 750mm of 3bn."),
    ("s0_t1", "Tier-1 coverage starts at fleet of", "#", 20, "ASSUMPTION: intermittent service below ~20."),
    ("sf_t1", "Tier-1 continuous coverage at fleet of", "#", 60,
     "DATA: mgmt '~45-60 BlueBirds' for continuous US/Europe/Japan service (Q2-26 call); upper end used."),
    ("s0_t2", "Tier-2 coverage starts at fleet of", "#", 60, "ASSUMPTION."),
    ("sf_t2", "Tier-2 (global) coverage at fleet of", "#", 90,
     "DATA: CFO cost guidance references 'constellation of over 90 Block 2' (Q1/Q2-26 calls)."),
    ("h1_rev", "H1-2026 actual revenue", "$mm", 46.255, "DATA: 10-Q six months to 30-Jun-2026."),
    ("guide_lo", "FY2026 revenue guidance - low", "$mm", 150.0, "DATA: Q2-26 business update."),
    ("guide_hi", "FY2026 revenue guidance - high", "$mm", 200.0, "DATA: Q2-26 business update."),
    ("contract_liab", "Contract liabilities (cash already received)", "$mm", 266.933,
     "DATA: 10-Q $14.840mm current + $252.093mm non-current."),
    ("cl_unwind_start", "Contract-liability unwind start year", "yr", 2027, "ASSUMPTION: as service begins."),
    ("cl_unwind_yrs", "Contract-liability unwind years", "yrs", 5, "ASSUMPTION."),
    ("nwc_pct", "Net working capital % of annualised revenue", "%", 0.05, "ASSUMPTION: 60-90 day terms (10-Q) net of payables."),
    ("h1_ann_rev", "Annualised revenue, H1-2026 (NWC base)", "$mm", 92.51, "DATA-DERIVED: 2 x H1 revenue."),
    ("ligado_pay", "Ligado spectrum closing payment", "$mm", 550.0,
     "DATA: 10-K FY25 - $550mm contingent payment at closing (regulatory approval pending)."),
    ("ligado_year", "Ligado closing year", "yr", 2027, "ASSUMPTION: FCC application pending since Jan-2026."),
    ("spec_fee", "Annual spectrum usage payments (from closing)", "$mm", 100.0,
     "DATA+ASSUMPTION: L-band >= $80mm/yr (10-K) + ~$20mm est. 1670-1675 MHz (Crown Castle) fee."),
    ("ligado_share", "Ligado revenue share (% Tier-1 service revenue)", "%", 0.03,
     "ASSUMPTION (flagged, unverified): 'long-term net revenue sharing rights' - % not disclosed."),
    ("net_opex_sat", "Network/ground/insurance opex per in-orbit satellite", "$mm/yr", 2.0,
     "ASSUMPTION (Agent 3 finding A3-02): ground segment, TT&C and in-orbit insurance scale with fleet."),
    ("px_end", "Last year of competitive ARPU repricing", "yr", 2032,
     "ASSUMPTION (A3-01): repricing phase ends; ARPU then tracks long-run growth."),
    ("arpu_lr_g", "Long-run ARPU growth (after repricing phase)", "%", 0.015,
     "ASSUMPTION (A3-01): below CPI - D2D remains a competitive add-on."),
    ("sub_g", "Partner subscriber base growth (from 2027)", "%", 0.01,
     "ASSUMPTION (A3-01): population growth + incremental MNO partners."),
    ("prod_margin", "Gateway/product gross margin", "%", 0.05, "DATA-DERIVED: Q2-26 product rev $24.4mm vs COGS $24.1mm."),
    ("gov_cogs", "Government revenue COGS %", "%", 0.35, "ASSUMPTION: Q2-26 services COGS 16%; normalised higher at scale."),
]

# ---------------------------------------------------------------- scenario inputs
SCENARIO = [
    ("hdr", "SCENARIO PROBABILITIES", None, None, None),
    ("prob", "Scenario probability", "%", (0.15, 0.25, 0.40, 0.20),
     "ASSUMPTION: Distress reflects failure-to-scale/competitive loss; must sum to 100% (checked)."),
    ("hdr", "CONSTELLATION DEPLOYMENT (Block 2 in orbit, end of period)", None, None, None),
    ("fl_26", "Fleet end-2026", "#", (15, 20, 25, 35),
     "DATA anchor: 7 in orbit Aug-2026; mgmt target ~45 in early 2027. Base haircuts for BB7 loss / slip history."),
    ("fl_27", "Fleet end-2027", "#", (30, 45, 60, 75), "ASSUMPTION."),
    ("fl_28", "Fleet end-2028", "#", (45, 60, 90, 100), "ASSUMPTION."),
    ("fl_29", "Fleet end-2029", "#", (45, 75, 90, 110), "ASSUMPTION."),
    ("fl_ss", "Steady-state fleet (2030+)", "#", (45, 90, 90, 120),
     "ASSUMPTION: Distress = cannot fund beyond ~45."),
    ("unit_cost", "Satellite cost incl. launch", "$mm", (25.0, 24.0, 22.0, 21.0),
     "DATA: mgmt $21-23mm/sat incl. direct materials & launch (Q2-26 call). Bear/Distress = overrun."),
    ("unit_infl", "Unit cost inflation after 2028", "%", (0.025, 0.025, 0.020, 0.015), "ASSUMPTION."),
    ("cip_credit", "Share of satellite CIP that pre-funds future launches", "%", (0.40, 0.45, 0.50, 0.60),
     "ASSUMPTION (Tier-1 sensitivity): CIP also holds NRE, early-unit overruns, later-year launch deposits. R-04."),
    ("hdr", "COMMERCIAL SERVICE (MNO wholesale revenue share)", None, None, None),
    ("t1_start", "Tier-1 commercial service start year", "yr", (2029, 2028, 2027, 2027),
     "DATA anchor: beta service 2026 (Q2-26 deck); commercial thereafter."),
    ("t2_start", "Tier-2 commercial service start year", "yr", (2031, 2030, 2029, 2028), "ASSUMPTION."),
    ("take_t1", "Tier-1 peak take rate (% covered partner subs)", "%", (0.03, 0.06, 0.10, 0.15),
     "ASSUMPTION: incl. subs bundled in premium plans. Reverse-DCF solves market-implied value."),
    ("take_t2", "Tier-2 peak take rate", "%", (0.005, 0.015, 0.03, 0.05), "ASSUMPTION."),
    ("ramp", "Adoption ramp: years from 5% to 95% of peak", "yrs", (8, 7, 6, 5), "ASSUMPTION (logistic)."),
    ("arpu_t1", "Tier-1 ASTS monthly ARPU (after MNO share)", "$/mo", (3.50, 4.25, 5.00, 6.00),
     "DATA anchor: T-Mobile/Starlink T-Satellite retail $10/mo; ~50/50 wholesale share -> $5."),
    ("arpu_t2", "Tier-2 ASTS monthly ARPU", "$/mo", (0.40, 0.60, 0.75, 1.00), "ASSUMPTION: emerging-market pricing."),
    ("px_g", "Annual ARPU change (from 2027)", "%", (-0.03, -0.02, -0.01, 0.0),
     "ASSUMPTION: competitive pressure (Starlink D2C) vs inflation."),
    ("var_cost", "Service variable cost % of service revenue", "%", (0.15, 0.13, 0.12, 0.11), "ASSUMPTION."),
    ("hdr", "GOVERNMENT & PRODUCT REVENUE", None, None, None),
    ("gov_26", "Government revenue 2026H2", "$mm", (35.0, 40.0, 45.0, 50.0),
     "DATA anchor: >$125mm USG awards; ~$100mm funded 2026-27 (Q2-26 call)."),
    ("gov_27", "Government revenue 2027", "$mm", (60.0, 80.0, 100.0, 130.0), "ASSUMPTION."),
    ("gov_28", "Government revenue 2028", "$mm", (80.0, 120.0, 160.0, 220.0), "ASSUMPTION."),
    ("gov_29", "Government revenue 2029", "$mm", (90.0, 150.0, 220.0, 320.0), "ASSUMPTION."),
    ("gov_30", "Government revenue 2030", "$mm", (100.0, 180.0, 280.0, 420.0), "ASSUMPTION."),
    ("gov_g", "Government revenue growth after 2030", "%", (0.02, 0.04, 0.06, 0.08), "ASSUMPTION."),
    ("prod_26", "Gateway/product revenue 2026H2", "$mm", (70.0, 80.0, 83.7, 90.0),
     "DATA-DERIVED: Base ties FY26 to guidance midpoint $175mm (H1 $46.3mm + H2)."),
    ("prod_27", "Gateway/product revenue 2027", "$mm", (60.0, 90.0, 120.0, 150.0), "ASSUMPTION."),
    ("prod_28", "Gateway/product revenue 2028", "$mm", (30.0, 50.0, 80.0, 100.0), "ASSUMPTION."),
    ("prod_ss", "Gateway/product revenue 2029+", "$mm", (20.0, 30.0, 40.0, 50.0), "ASSUMPTION."),
    ("hdr", "OPERATING COSTS (ex-D&A)", None, None, None),
    ("opex_26", "Fixed adj. opex (ex-COGS, ex-SBC) 2026H2", "$mm", (215.0, 210.0, 210.0, 205.0),
     "DATA anchor: Q2-26 adj. opex ex-COGS $95.9mm/qtr, rising."),
    ("opex_27", "Fixed adj. opex 2027", "$mm", (480.0, 470.0, 460.0, 450.0), "ASSUMPTION."),
    ("opex_g28", "Fixed opex growth 2028", "%", (0.08, 0.09, 0.10, 0.12), "ASSUMPTION."),
    ("opex_g29", "Fixed opex growth 2029", "%", (0.05, 0.07, 0.08, 0.10), "ASSUMPTION."),
    ("opex_g30", "Fixed opex growth 2030", "%", (0.03, 0.05, 0.06, 0.08), "ASSUMPTION."),
    ("opex_gss", "Fixed opex growth 2031+", "%", (0.035, 0.035, 0.035, 0.035), "ASSUMPTION: ~inflation + 1%."),
    ("sbc_26", "Stock-based comp 2026H2", "$mm", (125.0, 125.0, 120.0, 120.0),
     "DATA anchor: Q2-26 SBC $63.5mm/qtr. Treated as a real cost (R-06)."),
    ("sbc_27", "Stock-based comp 2027", "$mm", (250.0, 240.0, 230.0, 230.0), "ASSUMPTION."),
    ("sbc_decay", "SBC annual decline (absolute) after 2027", "%", (0.08, 0.10, 0.10, 0.12), "ASSUMPTION."),
    ("sbc_floor", "SBC floor (% revenue)", "%", (0.04, 0.035, 0.035, 0.03), "ASSUMPTION."),
    ("hdr", "OTHER CAPEX & NON-DILUTIVE FUNDING", None, None, None),
    ("ocx_26", "Other capex (ground, facilities) 2026H2", "$mm", (180.0, 170.0, 150.0, 150.0), "ASSUMPTION."),
    ("ocx_27", "Other capex 2027", "$mm", (250.0, 230.0, 200.0, 220.0), "ASSUMPTION."),
    ("ocx_28", "Other capex 2028", "$mm", (150.0, 170.0, 150.0, 180.0), "ASSUMPTION."),
    ("ocx_pct", "Other capex % revenue (2029+)", "%", (0.04, 0.035, 0.03, 0.03), "ASSUMPTION."),
    ("ocx_floor", "Other capex floor (2029+)", "$mm", (60.0, 80.0, 80.0, 100.0), "ASSUMPTION."),
    ("jleo", "J-LEO non-dilutive capital received (2028)", "$mm", (0.0, 0.0, 0.0, 300.0),
     "DATA anchor: preliminary J-LEO selection, up to ~$1bn to Rakuten JV (Q2-26 deck). Bull only."),
]

# ---------------------------------------------------------------- capital structure (DATA)
SHARES = [  # label, count, source
    ("Class A common (6-Aug-2026)", 299_789_305, "10-Q cover page"),
    ("Class B common = AST LLC units (exchangeable 1:1)", 11_215_111, "10-Q cover page"),
    ("Class C common = AST LLC units (exchangeable 1:1)", 78_163_078, "10-Q cover page"),
]
CASH = [  # label, $mm, include(1/0), source
    ("Cash & cash equivalents (30-Jun-2026)", 2288.253, 1, "10-Q balance sheet"),
    ("Restricted cash - non-current (UBS bridge collateral)", 428.400, 1, "10-Q Note 3; nets vs UBS loan"),
    ("Restricted cash - current (LC/customs collateral)", 6.181, 0, "10-Q; excluded - not available"),
    ("2034 notes gross proceeds (Jul-2026, $1.15bn)", 1150.000, 1, "8-K / PR 21-Jul-2026"),
    ("  less: discounts & expenses", -18.800, 1, "Net proceeds $1,131.2mm (pricing PR)"),
    ("  less: capped-call cost (scaled to $1.15bn)", -111.435, 1, "$96.9mm for $1.0bn (PR) x 1.15 - ESTIMATE"),
    ("Related-party notes receivable", 18.785, 1, "10-Q balance sheet"),
]
DEBT = [  # label, face $mm, source
    ("Trinity Capital equipment loan", 48.638, "10-Q Note 6"),
    ("UBS bridge loan (cash-collateralised)", 420.000, "10-Q Note 6"),
]
CONVERTS = [  # label, face $mm, conversion price, capped-call cap (0=none), source
    ("2032 4.25% converts", 3.514, 26.99, 0.0, "10-Q Note 6; conv. rate 37.0535"),
    ("2032 2.375% converts", 325.000, 72.07, 0.0, "10-Q Note 6; conv. rate 13.8750 (capped call ignored - conservative)"),
    ("2036 2.00% converts", 1150.000, 96.30, 0.0, "Pricing PR Oct-2025, $96.30"),
    ("2036 2.25% converts", 1075.000, 116.30, 0.0, "Pricing 8-K Feb-2026, conv. rate 8.5982"),
    ("2034 1.625% converts (Jul-2026)", 1150.000, 79.57, 149.20, "Pricing 8-K Jul-2026; capped call cap $149.20"),
]
AWARDS = [  # label, count, strike, source
    ("2020 Plan stock options", 1_957_612, 9.20, "Q1-26 10-Q (31-Mar-2026, latest disclosed)"),
    ("2024 Plan stock options", 55_718, 24.65, "Q2-26 10-Q count; strike = 10-K WAEP"),
    ("AST LLC incentive options", 5_320_887, 1.01, "Q2-25 10-Q (STALE - latest found)"),
    ("2020 Plan RSUs", 832_699, 0.0, "Q2-26 10-Q"),
    ("2024 Plan RSUs", 6_873_666, 0.0, "FY25 proxy (STALE, Dec-2025 - latest found)"),
]


def scen_value(key, s):
    for row in SCENARIO:
        if row[0] == key:
            return row[3][s]
    raise KeyError(key)


def glob(key):
    for row in GLOBAL:
        if row[0] == key:
            return row[3]
    raise KeyError(key)
