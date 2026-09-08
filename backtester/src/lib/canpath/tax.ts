import rawConfig from './data/taxyear_2026.json';
import type {
  Bracket,
  FederalConfig,
  PayrollDeductions,
  TaxConfig,
} from './types';

/**
 * Canadian income tax and payroll deductions.
 *
 * Ported from CanPath's Python reference (`engine/tax.py`) via its JavaScript
 * port. The Python remains the source of truth: `tests/canpath-parity.test.ts`
 * checks every function here against `fixtures.json`, which is generated from
 * the reference. If the two disagree, the reference is right.
 */

/** The canonical parameter set. Never hard-code a figure that lives here. */
export const TAX_CONFIG = rawConfig as unknown as TaxConfig;

export function taxYear(): number {
  return TAX_CONFIG.tax_year;
}

export function supportedProvinces(): string[] {
  return Object.keys(TAX_CONFIG.provinces).sort();
}

/**
 * Tax from a progressive bracket table.
 *
 * Each bracket's `floor` is where its rate starts applying; the rate applies
 * only to income above that floor and below the next one. The top bracket runs
 * to infinity.
 */
export function bracketTax(taxableIncome: number, brackets: Bracket[]): number {
  if (taxableIncome <= 0) return 0;
  let tax = 0;
  for (let i = 0; i < brackets.length; i++) {
    const floor = brackets[i].floor;
    if (taxableIncome <= floor) break;
    const ceiling = i + 1 < brackets.length ? brackets[i + 1].floor : Infinity;
    tax += (Math.min(taxableIncome, ceiling) - floor) * brackets[i].rate;
  }
  return tax;
}

/**
 * The federal basic personal amount, which is itself income-tested: the
 * additional portion phases out across the second-highest bracket, so the BPA
 * is not a constant.
 */
export function federalBPA(netIncome: number, cfg: TaxConfig = TAX_CONFIG): number {
  const b: FederalConfig['bpa'] = cfg.federal.bpa;
  let additional: number;
  if (netIncome <= b.phaseout_start) additional = b.additional;
  else if (netIncome >= b.phaseout_end) additional = 0;
  else {
    additional =
      b.additional *
      ((b.phaseout_end - netIncome) / (b.phaseout_end - b.phaseout_start));
  }
  return b.base + additional;
}

export function federalTax(taxableIncome: number, cfg: TaxConfig = TAX_CONFIG): number {
  if (taxableIncome <= 0) return 0;
  const gross = bracketTax(taxableIncome, cfg.federal.brackets);
  const credit = federalBPA(taxableIncome, cfg) * cfg.federal.credit_rate;
  return Math.max(0, gross - credit);
}

export function provincialTax(
  taxableIncome: number,
  province: string,
  cfg: TaxConfig = TAX_CONFIG,
): number {
  if (taxableIncome <= 0) return 0;
  const p = cfg.provinces[province];
  if (!p) throw new Error(`Province ${province} not supported`);

  let tax = Math.max(0, bracketTax(taxableIncome, p.brackets) - p.bpa * p.credit_rate);

  // Some provinces apply a low-income tax reduction on top of the BPA credit,
  // which itself phases out — creating a second, province-specific band of
  // elevated marginal rate that the posted brackets do not show.
  const tr = p.tax_reduction;
  if (tr) {
    let reduction = tr.max_credit;
    if (taxableIncome > tr.threshold) {
      reduction -= (taxableIncome - tr.threshold) * tr.phaseout_rate;
    }
    tax = Math.max(0, tax - Math.max(0, reduction));
  }
  return tax;
}

export function combinedTax(
  taxableIncome: number,
  province: string,
  cfg: TaxConfig = TAX_CONFIG,
): number {
  return federalTax(taxableIncome, cfg) + provincialTax(taxableIncome, province, cfg);
}

/**
 * CPP, CPP2 and EI.
 *
 * Deliberately excluded from the marginal rate: they are levied on gross
 * employment income, and an RRSP deduction does not reduce them. They are
 * still most of the gap between gross pay and take-home, so they are reported
 * separately rather than ignored.
 */
export function payrollDeductions(
  income: number,
  cfg: TaxConfig = TAX_CONFIG,
): PayrollDeductions {
  const pr = cfg.payroll;
  const cppBase = Math.max(0, Math.min(income, pr.cpp.ympe) - pr.cpp.basic_exemption);
  const cpp = cppBase * pr.cpp.rate;
  const cpp2 = Math.max(0, Math.min(income, pr.cpp2.yampe) - pr.cpp.ympe) * pr.cpp2.rate;
  const ei = Math.min(income, pr.ei.max_insurable) * pr.ei.rate;
  return { cpp, cpp2, ei, total: cpp + cpp2 + ei };
}
