import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { deliveredInputs, YEARS } from '../src/lib/valuation/asts/inputs';
import { runModel, snapshotStats } from '../src/lib/valuation/asts/engine';
import { headline, expectedReturn } from '../src/lib/valuation/asts/summary';
import { availableLiquidity, financing, scenarioFinancing } from '../src/lib/valuation/asts/financing';

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'asts-reference.json'), 'utf8'));
const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(1, Math.abs(b));
const close = (a: number, b: number, what: string, tol = 1e-9) => {
  if (!(rel(a, b) < tol)) throw new Error(`${what}: ${a} vs ${b}`);
};

const inputs = deliveredInputs();
const model = runModel(inputs);
const market = snapshotStats(inputs);
const PRICE = FIX.workbook.summary.price;

describe('headline — the workbook’s Valuation_Summary and Risk derivations', () => {
  const h = headline(inputs, model, PRICE, market);
  const wb = FIX.workbook.summary;

  it('reproduces upside, Ke, expected returns and market-implied EV at $62.42', () => {
    close(h.pwUpside, wb.pwUpside, 'prob-weighted upside');
    close(h.ke, wb.ke, 'growth-phase Ke');
    close(h.er3, wb.er3, 'E[R] 3-yr');
    close(h.er5, wb.er5, 'E[R] 5-yr');
    close(h.mktEv, wb.mktEv, 'market-implied EV');
    close(h.baseEvOverMkt, wb.baseEvOverMkt, 'Base EV / market EV');
    close(h.mktCap, FIX.workbook.capital.mktCap, 'market cap');
    close(h.sharpe3, FIX.workbook.funding.sharpe, 'model-implied Sharpe');
    h.scenarios.forEach((sc, s) => close(sc.upside, FIX.workbook.calc[s].upside, `scenario ${s} upside`));
  });

  it('shows what the workbook implies: at $62.42 the 3-year expected return is below the risk-free rate', () => {
    expect(h.er3).toBeLessThan(inputs.global.rf);
    expect(h.sharpe3).toBeLessThan(0);
  });

  it('returns −100% rather than a complex number when value is zero', () => {
    expect(expectedReturn(0, 62.42, 0.1, 3)).toBe(-1);
  });

  it('reports multiples only where the denominator is positive', () => {
    // Distress EBITDA is negative in 2027: an EV/EBITDA there is meaningless, not negative.
    expect(model.runs[0].ebitda[YEARS.indexOf(2027)]).toBeLessThan(0);
    expect(h.scenarios[0].evEbitda[2027]).toBeNull();
    expect(h.scenarios[2].evRev[2030]).toBeCloseTo(model.runs[2].ev / model.runs[2].rev[YEARS.indexOf(2030)], 10);
  });
});

describe('financing — value view', () => {
  const noFacility = { issuePrice: PRICE, useLigadoFacility: false, minBuffer: 0 };

  it('starts from the Risk sheet’s available liquidity', () => {
    close(availableLiquidity(inputs), FIX.workbook.funding.available[0], 'available liquidity');
  });

  it('raises exactly the Risk sheet’s funding gap in each scenario', () => {
    const f = financing(inputs, model, noFacility);
    f.scenarios.forEach((sc, s) => {
      const gap = Math.max(0, -FIX.workbook.funding.headroom[s]);
      close(sc.raisedNominal, gap, `scenario ${s} raise`);
    });
    // Base is nearly funded: $78mm short of its deepest point, before the Ligado facility.
    expect(f.scenarios[2].raisedNominal).toBeCloseTo(78.077, 2);
    expect(f.scenarios[3].raisedNominal).toBe(0);
  });

  it('nests the delivered model: raising at the model’s own value changes nothing', () => {
    for (const s of [1, 2] as const) {
      const r = model.runs[s];
      const f = scenarioFinancing(inputs, r, { ...noFacility, issuePrice: r.vps });
      expect(f.raisedPv).toBeGreaterThan(0);
      close(f.vpsFinanced, r.vps, `scenario ${s} nested`);
      expect(f.newShares).toBeGreaterThan(0);
    }
  });

  it('dilutes below value, is accretive above it, and rises with the issue price', () => {
    const r = model.runs[2];
    const at = (p: number) => scenarioFinancing(inputs, r, { ...noFacility, issuePrice: p }).vpsFinanced;
    const prices = [20, 40, r.vps, 80, 120];
    const vals = prices.map(at);
    for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeGreaterThan(vals[i - 1]);
    expect(at(40)).toBeLessThan(r.vps);
    expect(at(80)).toBeGreaterThan(r.vps);
  });

  it('the committed Ligado facility closes Base’s gap', () => {
    const f = scenarioFinancing(inputs, model.runs[2], { ...noFacility, useLigadoFacility: true });
    expect(f.raisedNominal).toBe(0);
    expect(f.vpsFinanced).toBe(model.runs[2].vps);
  });

  it('a reserve buffer raises the buffer plus the gap, and triggers sooner', () => {
    const r = model.runs[2];
    const f0 = scenarioFinancing(inputs, r, noFacility);
    const f = scenarioFinancing(inputs, r, { ...noFacility, minBuffer: 500 });
    close(f.raisedNominal, 500 - (availableLiquidity(inputs) + r.minFcf), 'buffer + gap');
    expect(f.raises.findIndex((x) => x > 0)).toBeLessThanOrEqual(f0.raises.findIndex((x) => x > 0));
  });
});

describe('financing — cash view', () => {
  const f = scenarioFinancing(inputs, model.runs[2], { issuePrice: PRICE, useLigadoFacility: false, minBuffer: 0 });

  it('pays the tranche coupons from the filings: $73.743mm in a full year', () => {
    // 3.514×4.25% + 325×2.375% + 1150×2.00% + 1075×2.25% + 1150×1.625%
    const hand = 3.514 * 0.0425 + 325 * 0.02375 + 1150 * 0.02 + 1075 * 0.0225 + 1150 * 0.01625;
    close(f.runway.interest[YEARS.indexOf(2027)], hand, '2027 coupons');
    close(f.runway.interest[0], hand / 2, '2026H2 coupons');
    expect(hand).toBeCloseTo(73.743, 3);
  });

  it('repays only the notes that do not convert in that scenario', () => {
    // Base value ~$57: only the 4.25% notes (K $26.99) convert.
    const conv = model.runs[2].dilution.converts;
    expect(conv.slice(0, 5)).toEqual([true, false, false, false, false]);
    const byYear = (y: number) => f.runway.principal[YEARS.indexOf(y)];
    expect(byYear(2032)).toBe(325); // 2.375% notes; the 4.25% notes convert
    expect(byYear(2034)).toBe(1150);
    expect(byYear(2036)).toBe(1150 + 1075);
    expect(f.runway.principal.reduce((t, x) => t + x, 0)).toBe(325 + 1150 + 1150 + 1075);
  });

  it('coupons stop at maturity', () => {
    const y2037 = f.runway.interest[YEARS.indexOf(2037)];
    expect(y2037).toBe(0);
  });
});
