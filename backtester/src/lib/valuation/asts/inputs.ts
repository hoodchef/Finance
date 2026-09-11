/**
 * AST SpaceMobile (NASDAQ: ASTS) — the assumption set.
 *
 * A faithful port of `reference/asts/inputs.py`, the analyst's single source of
 * truth. Every value, label and source string is carried over verbatim: the
 * source text IS the documentation, and a reviewer reading a number on the page
 * must be able to see where it came from without opening the workbook.
 *
 * Nothing here was changed from the delivered model. A value that should move —
 * because a filing landed, or because the reader disagrees — moves in the page,
 * where the difference from the delivered model is shown, never here.
 *
 * Conventions (identical to the reference):
 *   - money in $ millions unless the unit says otherwise;
 *   - rates as decimals (0.0484 = 4.84%);
 *   - scenario rows carry four values in the order Distress, Bear, Base, Bull.
 */

export const SCENARIOS = ['Distress', 'Bear', 'Base', 'Bull'] as const;
export type ScenarioName = (typeof SCENARIOS)[number];
export type ScenarioIndex = 0 | 1 | 2 | 3;
export const SCENARIO_INDICES: readonly ScenarioIndex[] = [0, 1, 2, 3];
export const BASE: ScenarioIndex = 2;

/** 2026H2 stub, then calendar 2027–2040. Column S of the workbook (2041) is the normalised terminal year. */
export const PERIODS = ['2026H2', ...Array.from({ length: 14 }, (_, i) => String(2027 + i))] as const;
export const YEARS: readonly number[] = [2026, ...Array.from({ length: 14 }, (_, i) => 2027 + i)];
export const LENS: readonly number[] = [0.5, ...Array(14).fill(1)];
export const STARTS: readonly number[] = [2026.5, ...Array.from({ length: 14 }, (_, i) => 2027 + i)];
export const NP = PERIODS.length;

export type Unit = '%' | '$mm' | 'yr' | 'yrs' | '#' | 'x' | 'mm' | '$/mo' | 'flag' | '$mm/yr';
export type Quad = readonly [number, number, number, number];

interface Row<K extends string> {
  key: K;
  label: string;
  unit: Unit;
  source: string;
}
export interface GlobalRow<K extends string = string> extends Row<K> {
  value: number;
}
export interface ScenarioRow<K extends string = string> extends Row<K> {
  values: Quad;
}

const g = <K extends string>(key: K, label: string, unit: Unit, value: number, source: string): GlobalRow<K> => ({
  key, label, unit, value, source,
});
const s = <K extends string>(key: K, label: string, unit: Unit, values: Quad, source: string): ScenarioRow<K> => ({
  key, label, unit, values, source,
});

/* ------------------------------------------------------------------ global inputs */

export const GLOBAL_SECTIONS = [
  {
    title: 'Valuation & market',
    rows: [
      g('val_date', 'Valuation date (year fraction)', 'yr', 2026.69, 'DATA: 10-Sep-2026 = 2026 + 252/365.'),
      g('rf', 'Risk-free rate (10y UST)', '%', 0.0484, 'DATA: 10y UST 4.84% on 10-Sep-2026 (TradingEconomics / CNBC).'),
      g('erp', 'Equity risk premium (US implied)', '%', 0.0442,
        'DATA: Damodaran implied US ERP 4.42% at 1-Jul-2026 (Musings on Markets, Jul-2026).'),
      g('blume_w', 'Blume weight on raw beta', 'x', 0.67,
        'METHOD: Blume (1971) adjustment beta_adj = 0.67*raw + 0.33. Resolution R-01.'),
      g('dv_hi', 'Debt / capital - growth phase', '%', 0.15,
        'DATA-DERIVED: ~$4.2bn debt face vs ~$24.3bn equity mkt cap (Sep-2026) = 14.6%.'),
      g('kd_hi', 'Pre-tax cost of straight debt - growth phase', '%', 0.095,
        "ASSUMPTION: unrated issuer; straight-bond yield ~Rf+4.7%. Converts' coupons understate cost (embedded option)."),
      g('t_hi', 'Tax rate in WACC - growth phase', '%', 0.0,
        'LOGIC: no cash taxes paid while loss-making (NOLs/bonus depreciation) -> no interest tax shield.'),
      g('beta_term', 'Beta - mature phase', 'x', 1.0,
        'ASSUMPTION: mature satellite operator converges to market beta (Damodaran young-firm lifecycle method).'),
      g('dv_term', 'Debt / capital - mature phase', '%', 0.25, 'ASSUMPTION: mature telecom-like leverage.'),
      g('kd_term', 'Pre-tax cost of debt - mature phase', '%', 0.07, 'ASSUMPTION: BB-area mature issuer.'),
      g('t_term', 'Tax rate in WACC - mature phase', '%', 0.25, 'Equals cash tax rate.'),
      g('wacc_fade_start', 'WACC fade start year', 'yr', 2031, 'ASSUMPTION: fade begins after build-out.'),
      g('wacc_fade_end', 'WACC fade end year (mature from)', 'yr', 2035, 'ASSUMPTION.'),
      g('wacc_shift', 'WACC what-if shift (keep 0 for base valuation)', '%', 0.0,
        "LEVER: parallel shift to every period's WACC. Checked = 0 in delivered file."),
      g('g', 'Terminal growth (nominal)', '%', 0.025, 'ASSUMPTION: <= long-run nominal GDP and < Rf (checked).'),
    ],
  },
  {
    title: 'Operations (all scenarios)',
    rows: [
      g('tax_rate', 'Cash tax rate (fed 21% + state)', '%', 0.25, 'ASSUMPTION: 21% federal + ~4% blended state.'),
      g('nol_open', 'Opening tax NOL pool (30-Jun-2026)', '$mm', 1000.0,
        'ASSUMPTION (flagged): accumulated deficit $1,253.6mm (10-Q) includes non-deductible items; haircut to $1.0bn.'),
      g('nol_limit', 'NOL usage cap (% of taxable income)', '%', 0.8, 'LAW: post-TCJA federal 80% limitation.'),
      g('bonus_dep', '100% bonus depreciation on capex (1=on)', 'flag', 1,
        'LAW: OBBBA (Jul-2025) permanently restored 100% bonus depreciation. Verify with tax adviser.'),
      g('sat_life', 'Block 2 satellite design life', 'yrs', 7,
        "SECONDARY DATA: 7-yr lifetime per Gunter's Space Page (BlueBird Block 2). Flagged for confirmation."),
      g('loss_rate', 'Launch / early-life loss rate', '%', 0.05,
        'ASSUMPTION: 1 of 8 Block 2 lost (BB7, Apr-2026) = 12.5% observed; industry mature ~3-5%.'),
      g('fleet_open', 'Block 2 satellites launched at 30-Jun-2026', '#', 4,
        'DATA: BB6 (Dec-2025) + BB8-10 (17-Jun-2026). BB7 lost. (10-Q Note 1)'),
      g('cip_sat', 'Satellite CIP / advance launch payments 30-Jun-2026', '$mm', 1724.085,
        "DATA: 10-Q Note 4, 'Satellite materials ... advance launch payments'."),
      g('partner_subs', 'MNO partner subscriber base', 'mm', 3000.0,
        "DATA: company - 60+ MNO partners covering 'over 3 billion' subscribers (Q2-26 deck)."),
      g('t1_share', 'Share of partner base in Tier-1 (developed) markets', '%', 0.25,
        'ASSUMPTION: US/Canada/Europe/Japan/Gulf partners ~ 750mm of 3bn.'),
      g('s0_t1', 'Tier-1 coverage starts at fleet of', '#', 20, 'ASSUMPTION: intermittent service below ~20.'),
      g('sf_t1', 'Tier-1 continuous coverage at fleet of', '#', 60,
        "DATA: mgmt '~45-60 BlueBirds' for continuous US/Europe/Japan service (Q2-26 call); upper end used."),
      g('s0_t2', 'Tier-2 coverage starts at fleet of', '#', 60, 'ASSUMPTION.'),
      g('sf_t2', 'Tier-2 (global) coverage at fleet of', '#', 90,
        "DATA: CFO cost guidance references 'constellation of over 90 Block 2' (Q1/Q2-26 calls)."),
      g('h1_rev', 'H1-2026 actual revenue', '$mm', 46.255, 'DATA: 10-Q six months to 30-Jun-2026.'),
      g('guide_lo', 'FY2026 revenue guidance - low', '$mm', 150.0, 'DATA: Q2-26 business update.'),
      g('guide_hi', 'FY2026 revenue guidance - high', '$mm', 200.0, 'DATA: Q2-26 business update.'),
      g('contract_liab', 'Contract liabilities (cash already received)', '$mm', 266.933,
        'DATA: 10-Q $14.840mm current + $252.093mm non-current.'),
      g('cl_unwind_start', 'Contract-liability unwind start year', 'yr', 2027, 'ASSUMPTION: as service begins.'),
      g('cl_unwind_yrs', 'Contract-liability unwind years', 'yrs', 5, 'ASSUMPTION.'),
      g('nwc_pct', 'Net working capital % of annualised revenue', '%', 0.05,
        'ASSUMPTION: 60-90 day terms (10-Q) net of payables.'),
      g('h1_ann_rev', 'Annualised revenue, H1-2026 (NWC base)', '$mm', 92.51, 'DATA-DERIVED: 2 x H1 revenue.'),
      g('ligado_pay', 'Ligado spectrum closing payment', '$mm', 550.0,
        'DATA: 10-K FY25 - $550mm contingent payment at closing (regulatory approval pending).'),
      g('ligado_year', 'Ligado closing year', 'yr', 2027, 'ASSUMPTION: FCC application pending since Jan-2026.'),
      g('spec_fee', 'Annual spectrum usage payments (from closing)', '$mm', 100.0,
        'DATA+ASSUMPTION: L-band >= $80mm/yr (10-K) + ~$20mm est. 1670-1675 MHz (Crown Castle) fee.'),
      g('ligado_share', 'Ligado revenue share (% Tier-1 service revenue)', '%', 0.03,
        "ASSUMPTION (flagged, unverified): 'long-term net revenue sharing rights' - % not disclosed."),
      g('net_opex_sat', 'Network/ground/insurance opex per in-orbit satellite', '$mm/yr', 2.0,
        'ASSUMPTION (Agent 3 finding A3-02): ground segment, TT&C and in-orbit insurance scale with fleet.'),
      g('px_end', 'Last year of competitive ARPU repricing', 'yr', 2032,
        'ASSUMPTION (A3-01): repricing phase ends; ARPU then tracks long-run growth.'),
      g('arpu_lr_g', 'Long-run ARPU growth (after repricing phase)', '%', 0.015,
        'ASSUMPTION (A3-01): below CPI - D2D remains a competitive add-on.'),
      g('sub_g', 'Partner subscriber base growth (from 2027)', '%', 0.01,
        'ASSUMPTION (A3-01): population growth + incremental MNO partners.'),
      g('prod_margin', 'Gateway/product gross margin', '%', 0.05,
        'DATA-DERIVED: Q2-26 product rev $24.4mm vs COGS $24.1mm.'),
      g('gov_cogs', 'Government revenue COGS %', '%', 0.35,
        'ASSUMPTION: Q2-26 services COGS 16%; normalised higher at scale.'),
    ],
  },
] as const;

/* ------------------------------------------------------------------ scenario inputs */

export const SCENARIO_SECTIONS = [
  {
    title: 'Scenario probabilities',
    rows: [
      s('prob', 'Scenario probability', '%', [0.15, 0.25, 0.4, 0.2],
        'ASSUMPTION: Distress reflects failure-to-scale/competitive loss; must sum to 100% (checked).'),
    ],
  },
  {
    title: 'Constellation deployment (Block 2 in orbit, end of period)',
    rows: [
      s('fl_26', 'Fleet end-2026', '#', [15, 20, 25, 35],
        'DATA anchor: 7 in orbit Aug-2026; mgmt target ~45 in early 2027. Base haircuts for BB7 loss / slip history.'),
      s('fl_27', 'Fleet end-2027', '#', [30, 45, 60, 75], 'ASSUMPTION.'),
      s('fl_28', 'Fleet end-2028', '#', [45, 60, 90, 100], 'ASSUMPTION.'),
      s('fl_29', 'Fleet end-2029', '#', [45, 75, 90, 110], 'ASSUMPTION.'),
      s('fl_ss', 'Steady-state fleet (2030+)', '#', [45, 90, 90, 120], 'ASSUMPTION: Distress = cannot fund beyond ~45.'),
      s('unit_cost', 'Satellite cost incl. launch', '$mm', [25.0, 24.0, 22.0, 21.0],
        'DATA: mgmt $21-23mm/sat incl. direct materials & launch (Q2-26 call). Bear/Distress = overrun.'),
      s('unit_infl', 'Unit cost inflation after 2028', '%', [0.025, 0.025, 0.02, 0.015], 'ASSUMPTION.'),
      s('cip_credit', 'Share of satellite CIP that pre-funds future launches', '%', [0.4, 0.45, 0.5, 0.6],
        'ASSUMPTION (Tier-1 sensitivity): CIP also holds NRE, early-unit overruns, later-year launch deposits. R-04.'),
    ],
  },
  {
    title: 'Commercial service (MNO wholesale revenue share)',
    rows: [
      s('t1_start', 'Tier-1 commercial service start year', 'yr', [2029, 2028, 2027, 2027],
        'DATA anchor: beta service 2026 (Q2-26 deck); commercial thereafter.'),
      s('t2_start', 'Tier-2 commercial service start year', 'yr', [2031, 2030, 2029, 2028], 'ASSUMPTION.'),
      s('take_t1', 'Tier-1 peak take rate (% covered partner subs)', '%', [0.03, 0.06, 0.1, 0.15],
        'ASSUMPTION: incl. subs bundled in premium plans. Reverse-DCF solves market-implied value.'),
      s('take_t2', 'Tier-2 peak take rate', '%', [0.005, 0.015, 0.03, 0.05], 'ASSUMPTION.'),
      s('ramp', 'Adoption ramp: years from 5% to 95% of peak', 'yrs', [8, 7, 6, 5], 'ASSUMPTION (logistic).'),
      s('arpu_t1', 'Tier-1 ASTS monthly ARPU (after MNO share)', '$/mo', [3.5, 4.25, 5.0, 6.0],
        'DATA anchor: T-Mobile/Starlink T-Satellite retail $10/mo; ~50/50 wholesale share -> $5.'),
      s('arpu_t2', 'Tier-2 ASTS monthly ARPU', '$/mo', [0.4, 0.6, 0.75, 1.0], 'ASSUMPTION: emerging-market pricing.'),
      s('px_g', 'Annual ARPU change (from 2027)', '%', [-0.03, -0.02, -0.01, 0.0],
        'ASSUMPTION: competitive pressure (Starlink D2C) vs inflation.'),
      s('var_cost', 'Service variable cost % of service revenue', '%', [0.15, 0.13, 0.12, 0.11], 'ASSUMPTION.'),
    ],
  },
  {
    title: 'Government & product revenue',
    rows: [
      s('gov_26', 'Government revenue 2026H2', '$mm', [35.0, 40.0, 45.0, 50.0],
        'DATA anchor: >$125mm USG awards; ~$100mm funded 2026-27 (Q2-26 call).'),
      s('gov_27', 'Government revenue 2027', '$mm', [60.0, 80.0, 100.0, 130.0], 'ASSUMPTION.'),
      s('gov_28', 'Government revenue 2028', '$mm', [80.0, 120.0, 160.0, 220.0], 'ASSUMPTION.'),
      s('gov_29', 'Government revenue 2029', '$mm', [90.0, 150.0, 220.0, 320.0], 'ASSUMPTION.'),
      s('gov_30', 'Government revenue 2030', '$mm', [100.0, 180.0, 280.0, 420.0], 'ASSUMPTION.'),
      s('gov_g', 'Government revenue growth after 2030', '%', [0.02, 0.04, 0.06, 0.08], 'ASSUMPTION.'),
      s('prod_26', 'Gateway/product revenue 2026H2', '$mm', [70.0, 80.0, 83.7, 90.0],
        'DATA-DERIVED: Base ties FY26 to guidance midpoint $175mm (H1 $46.3mm + H2).'),
      s('prod_27', 'Gateway/product revenue 2027', '$mm', [60.0, 90.0, 120.0, 150.0], 'ASSUMPTION.'),
      s('prod_28', 'Gateway/product revenue 2028', '$mm', [30.0, 50.0, 80.0, 100.0], 'ASSUMPTION.'),
      s('prod_ss', 'Gateway/product revenue 2029+', '$mm', [20.0, 30.0, 40.0, 50.0], 'ASSUMPTION.'),
    ],
  },
  {
    title: 'Operating costs (ex-D&A)',
    rows: [
      s('opex_26', 'Fixed adj. opex (ex-COGS, ex-SBC) 2026H2', '$mm', [215.0, 210.0, 210.0, 205.0],
        'DATA anchor: Q2-26 adj. opex ex-COGS $95.9mm/qtr, rising.'),
      s('opex_27', 'Fixed adj. opex 2027', '$mm', [480.0, 470.0, 460.0, 450.0], 'ASSUMPTION.'),
      s('opex_g28', 'Fixed opex growth 2028', '%', [0.08, 0.09, 0.1, 0.12], 'ASSUMPTION.'),
      s('opex_g29', 'Fixed opex growth 2029', '%', [0.05, 0.07, 0.08, 0.1], 'ASSUMPTION.'),
      s('opex_g30', 'Fixed opex growth 2030', '%', [0.03, 0.05, 0.06, 0.08], 'ASSUMPTION.'),
      s('opex_gss', 'Fixed opex growth 2031+', '%', [0.035, 0.035, 0.035, 0.035], 'ASSUMPTION: ~inflation + 1%.'),
      s('sbc_26', 'Stock-based comp 2026H2', '$mm', [125.0, 125.0, 120.0, 120.0],
        'DATA anchor: Q2-26 SBC $63.5mm/qtr. Treated as a real cost (R-06).'),
      s('sbc_27', 'Stock-based comp 2027', '$mm', [250.0, 240.0, 230.0, 230.0], 'ASSUMPTION.'),
      s('sbc_decay', 'SBC annual decline (absolute) after 2027', '%', [0.08, 0.1, 0.1, 0.12], 'ASSUMPTION.'),
      s('sbc_floor', 'SBC floor (% revenue)', '%', [0.04, 0.035, 0.035, 0.03], 'ASSUMPTION.'),
    ],
  },
  {
    title: 'Other capex & non-dilutive funding',
    rows: [
      s('ocx_26', 'Other capex (ground, facilities) 2026H2', '$mm', [180.0, 170.0, 150.0, 150.0], 'ASSUMPTION.'),
      s('ocx_27', 'Other capex 2027', '$mm', [250.0, 230.0, 200.0, 220.0], 'ASSUMPTION.'),
      s('ocx_28', 'Other capex 2028', '$mm', [150.0, 170.0, 150.0, 180.0], 'ASSUMPTION.'),
      s('ocx_pct', 'Other capex % revenue (2029+)', '%', [0.04, 0.035, 0.03, 0.03], 'ASSUMPTION.'),
      s('ocx_floor', 'Other capex floor (2029+)', '$mm', [60.0, 80.0, 80.0, 100.0], 'ASSUMPTION.'),
      s('jleo', 'J-LEO non-dilutive capital received (2028)', '$mm', [0.0, 0.0, 0.0, 300.0],
        'DATA anchor: preliminary J-LEO selection, up to ~$1bn to Rakuten JV (Q2-26 deck). Bull only.'),
    ],
  },
] as const;

export type GlobalKey = (typeof GLOBAL_SECTIONS)[number]['rows'][number]['key'];
export type ScenarioKey = (typeof SCENARIO_SECTIONS)[number]['rows'][number]['key'];
export type ParamKey = GlobalKey | ScenarioKey;

export const GLOBAL_ROWS: readonly GlobalRow<GlobalKey>[] = GLOBAL_SECTIONS.flatMap<GlobalRow<GlobalKey>>((x) => x.rows);
export const SCENARIO_ROWS: readonly ScenarioRow<ScenarioKey>[] = SCENARIO_SECTIONS.flatMap<ScenarioRow<ScenarioKey>>(
  (x) => x.rows,
);

/** The workbook highlights these in yellow: the inputs the value actually turns on. */
export const KEY_DRIVERS: ReadonlySet<ParamKey> = new Set<ParamKey>([
  'take_t1', 'arpu_t1', 'prob', 'unit_cost', 'fl_ss', 'cip_credit', 't1_start', 'rf', 'erp', 'g', 'sat_life', 'take_t2',
]);

/* ------------------------------------------------------------------ capital structure (DATA) */

export interface ShareRow { label: string; count: number; source: string }
/**
 * `role` names what the row IS, so the pro forma cash reconciliation and the
 * available-liquidity figure can be computed by meaning rather than by the row's
 * position in a spreadsheet. At the delivered inputs both reproduce the
 * workbook's positional formulas exactly.
 */
export type CashRole = 'cash' | 'restricted-collateral' | 'restricted-current' | 'proceeds' | 'proceeds-cost' | 'receivable';
export interface CashRow { label: string; amount: number; include: 0 | 1; source: string; role: CashRole }
export interface DebtRow { label: string; face: number; source: string; collateralised: boolean; coupon: number | null }
export interface ConvertRow {
  label: string;
  face: number;
  convPrice: number;
  /** Capped-call cap; 0 = none. When present the trigger is the cap and value added is n × cap. */
  cap: number;
  source: string;
  /** Coupon rate (from the tranche name), used only by the liquidity runway, never by the valuation. */
  coupon: number;
  /** ISO maturity date — the Risk sheet's maturity wall. */
  maturity: string;
  /** Issued after the 30-Jun-2026 balance sheet, so excluded from the 10-Q debt reconciliation. */
  postBalanceSheet: boolean;
}
export interface AwardRow { label: string; count: number; strike: number; source: string }

export const SHARES: readonly ShareRow[] = [
  { label: 'Class A common (6-Aug-2026)', count: 299_789_305, source: '10-Q cover page' },
  { label: 'Class B common = AST LLC units (exchangeable 1:1)', count: 11_215_111, source: '10-Q cover page' },
  { label: 'Class C common = AST LLC units (exchangeable 1:1)', count: 78_163_078, source: '10-Q cover page' },
];

export const CASH: readonly CashRow[] = [
  { label: 'Cash & cash equivalents (30-Jun-2026)', amount: 2288.253, include: 1, source: '10-Q balance sheet', role: 'cash' },
  { label: 'Restricted cash - non-current (UBS bridge collateral)', amount: 428.4, include: 1,
    source: '10-Q Note 3; nets vs UBS loan', role: 'restricted-collateral' },
  { label: 'Restricted cash - current (LC/customs collateral)', amount: 6.181, include: 0,
    source: '10-Q; excluded - not available', role: 'restricted-current' },
  { label: '2034 notes gross proceeds (Jul-2026, $1.15bn)', amount: 1150.0, include: 1,
    source: '8-K / PR 21-Jul-2026', role: 'proceeds' },
  { label: '  less: discounts & expenses', amount: -18.8, include: 1,
    source: 'Net proceeds $1,131.2mm (pricing PR)', role: 'proceeds-cost' },
  { label: '  less: capped-call cost (scaled to $1.15bn)', amount: -111.435, include: 1,
    source: '$96.9mm for $1.0bn (PR) x 1.15 - ESTIMATE', role: 'proceeds-cost' },
  { label: 'Related-party notes receivable', amount: 18.785, include: 1, source: '10-Q balance sheet', role: 'receivable' },
];

export const DEBT: readonly DebtRow[] = [
  { label: 'Trinity Capital equipment loan', face: 48.638, source: '10-Q Note 6', collateralised: false, coupon: null },
  { label: 'UBS bridge loan (cash-collateralised)', face: 420.0, source: '10-Q Note 6', collateralised: true, coupon: null },
];

export const CONVERTS: readonly ConvertRow[] = [
  { label: '2032 4.25% converts', face: 3.514, convPrice: 26.99, cap: 0, source: '10-Q Note 6; conv. rate 37.0535',
    coupon: 0.0425, maturity: '2032-03-01', postBalanceSheet: false },
  { label: '2032 2.375% converts', face: 325.0, convPrice: 72.07, cap: 0,
    source: '10-Q Note 6; conv. rate 13.8750 (capped call ignored - conservative)',
    coupon: 0.02375, maturity: '2032-10-15', postBalanceSheet: false },
  { label: '2036 2.00% converts', face: 1150.0, convPrice: 96.3, cap: 0, source: 'Pricing PR Oct-2025, $96.30',
    coupon: 0.02, maturity: '2036-01-15', postBalanceSheet: false },
  { label: '2036 2.25% converts', face: 1075.0, convPrice: 116.3, cap: 0, source: 'Pricing 8-K Feb-2026, conv. rate 8.5982',
    coupon: 0.0225, maturity: '2036-04-15', postBalanceSheet: false },
  { label: '2034 1.625% converts (Jul-2026)', face: 1150.0, convPrice: 79.57, cap: 149.2,
    source: 'Pricing 8-K Jul-2026; capped call cap $149.20', coupon: 0.01625, maturity: '2034-02-01', postBalanceSheet: true },
];

export const AWARDS: readonly AwardRow[] = [
  { label: '2020 Plan stock options', count: 1_957_612, strike: 9.2, source: 'Q1-26 10-Q (31-Mar-2026, latest disclosed)' },
  { label: '2024 Plan stock options', count: 55_718, strike: 24.65, source: 'Q2-26 10-Q count; strike = 10-K WAEP' },
  { label: 'AST LLC incentive options', count: 5_320_887, strike: 1.01, source: 'Q2-25 10-Q (STALE - latest found)' },
  { label: '2020 Plan RSUs', count: 832_699, strike: 0.0, source: 'Q2-26 10-Q' },
  { label: '2024 Plan RSUs', count: 6_873_666, strike: 0.0, source: 'FY25 proxy (STALE, Dec-2025 - latest found)' },
];

/* ------------------------------------------------------------------ the mutable input set */

export interface AstsInputs {
  global: Record<GlobalKey, number>;
  scenario: Record<ScenarioKey, Quad>;
  shares: ShareRow[];
  cash: CashRow[];
  debt: DebtRow[];
  converts: ConvertRow[];
  awards: AwardRow[];
}

/** A fresh, independent copy of the model exactly as delivered. */
export function deliveredInputs(): AstsInputs {
  return {
    global: Object.fromEntries(GLOBAL_ROWS.map((r) => [r.key, r.value])) as Record<GlobalKey, number>,
    scenario: Object.fromEntries(SCENARIO_ROWS.map((r) => [r.key, [...r.values] as unknown as Quad])) as Record<
      ScenarioKey,
      Quad
    >,
    shares: SHARES.map((x) => ({ ...x })),
    cash: CASH.map((x) => ({ ...x })),
    debt: DEBT.map((x) => ({ ...x })),
    converts: CONVERTS.map((x) => ({ ...x })),
    awards: AWARDS.map((x) => ({ ...x })),
  };
}

/* ------------------------------------------------------------------ provenance classes */

/**
 * What kind of claim a source string makes. Read from the analyst's own prefix,
 * so the page can distinguish a number taken from a filing from a judgement —
 * which is the single most useful thing to know about any input.
 */
export type Basis = 'data' | 'derived' | 'secondary' | 'law' | 'method' | 'logic' | 'lever' | 'assumption';

export function basisOf(source: string): Basis {
  const t = source.trim();
  if (t.startsWith('DATA-DERIVED')) return 'derived';
  if (t.startsWith('SECONDARY DATA')) return 'secondary';
  if (t.startsWith('DATA')) return 'data';
  if (t.startsWith('LAW')) return 'law';
  if (t.startsWith('METHOD')) return 'method';
  if (t.startsWith('LOGIC') || t.startsWith('Equals')) return 'logic';
  if (t.startsWith('LEVER')) return 'lever';
  return 'assumption';
}

/** The analyst marked these as unverified or stale; the page must not let them pass as settled. */
export function isFlagged(source: string): boolean {
  return /flagged|unverified|STALE|ESTIMATE|confirmation/i.test(source);
}

export const MODEL_META = {
  company: 'AST SpaceMobile',
  ticker: 'ASTS',
  exchange: 'NASDAQ',
  currency: 'USD',
  valuationDate: '2026-09-10',
  balanceSheetDate: '2026-06-30',
  sharesDate: '2026-08-06',
  balanceSheetSource: 'Q2-2026 Form 10-Q, pro forma the Jul-2026 $1.15bn 2034 convertible',
  cik: '1780312',
} as const;
