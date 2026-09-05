import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runEngine } from '../src/lib/engine/engine';
import { prepareData } from '../src/lib/engine/prepare';
import { computeMetrics } from '../src/lib/metrics';
import { buildReport } from '../src/lib/metrics/report';
import { drawdownSeries } from '../src/lib/metrics/drawdown';
import { computeAllRolling } from '../src/lib/metrics/rolling';
import { buildPrepared, makeCalendar, testConfig } from './helpers';
import type { IsoDate } from '../src/lib/types';

/**
 * The engine's performance and accounting baseline.
 * =============================================================================
 * Gated behind `BENCH=1` (`npm run bench`) because it is a measurement, not an
 * assertion: it takes seconds, and the numbers depend on the machine. The point
 * is to have ONE reproducible way to answer "did that change make it faster,
 * and did it change any figure it should not have".
 *
 * Two things are measured, and they are deliberately different in kind.
 *
 *   TIMING is measured on a deterministic synthetic price path. The walk is
 *   seeded, so the work is identical run to run, and the shape of the data is
 *   irrelevant to how long the loop takes. Nothing here is presented as a
 *   result — synthetic prices are for the stopwatch only.
 *
 *   ACCOUNTING is measured on the recorded Tiingo fixtures, which are real SPY
 *   and BND history. Those figures are the ones that must not move when the
 *   engine is optimised, and `tests/engine-invariants.test.ts` is what pins
 *   them. If the fixtures are absent (they are gitignored — personal-use
 *   licence) that half skips and says so, rather than quietly measuring
 *   nothing.
 */

const BENCH = process.env.BENCH === '1';
const FIXTURES = path.join(__dirname, 'fixtures');

/** Deterministic geometric walk. Seeded, so the timing is reproducible. */
function walk(n: number, seed: number, drift = 0.0003, vol = 0.011): number[] {
  let s = seed >>> 0;
  const rand = () => {
    // mulberry32 — same generator the lattice uses.
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out: number[] = [100];
  for (let i = 1; i < n; i++) {
    // Box–Muller, so the walk has a normal shape rather than a uniform one.
    const u = Math.max(1e-12, rand());
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
    out.push(out[i - 1] * Math.exp(drift - (vol * vol) / 2 + vol * z));
  }
  return out;
}

interface Scale {
  label: string;
  assets: number;
  days: number;
}

/** Sizes chosen to bracket real use and then go past it. */
const SCALES: Scale[] = [
  { label: '2 assets x 10y', assets: 2, days: 2520 },
  { label: '10 assets x 10y', assets: 10, days: 2520 },
  { label: '25 assets x 25y', assets: 25, days: 6300 },
  { label: '40 assets x 25y', assets: 40, days: 6300 },
];

function buildScale(scale: Scale) {
  const calendar = makeCalendar('2000-01-03', scale.days);
  const specs = Array.from({ length: scale.assets }, (_, k) => ({
    symbol: `A${k}`,
    prices: walk(calendar.length, 1000 + k * 17),
    weight: 100 / scale.assets,
    // A dividend every quarter and a split midway, so the accounting paths in
    // the loop are actually exercised rather than skipped.
    dividends: Object.fromEntries(
      Array.from({ length: Math.floor(calendar.length / 63) }, (_, q) => [q * 63 + 5, 0.4]),
    ),
    splitFactors: { [Math.floor(calendar.length / 2)]: 2 },
  }));
  return { calendar, specs };
}

function ms(fn: () => unknown): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

/** Median of repeated runs; a single timing on a laptop is mostly noise. */
function medianMs(fn: () => unknown, runs = 5): number {
  const times = Array.from({ length: runs }, () => ms(fn));
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

describe.runIf(BENCH)('engine throughput', () => {
  it('measures the full pipeline across portfolio sizes', () => {
    const rows: string[] = [];
    for (const scale of SCALES) {
      const { calendar, specs } = buildScale(scale);
      const config = testConfig({
        start: calendar[0],
        end: calendar[calendar.length - 1],
        rebalance: 'monthly',
        contributionAmount: 500,
        contributionFrequency: 'monthly',
      });
      const data = buildPrepared(calendar, specs);
      const portfolio = {
        id: 'bench',
        name: scale.label,
        positions: specs.map((sp) => ({ id: sp.symbol, symbol: sp.symbol, weight: sp.weight })),
      };

      const engineMs = medianMs(() => runEngine({ data, config, portfolio }));
      const result = runEngine({ data, config, portfolio });

      const metricsMs = medianMs(() =>
        computeMetrics({
          daily: result.daily,
          periodsPerYear: 252,
          riskFree: new Array(result.daily.length).fill(0),
        }),
      );

      const index = result.daily.map((d) => d.index);
      const dates = result.daily.map((d) => d.date);
      const returns = result.daily.map((d) => d.twrReturn);
      const rollingMs = medianMs(() => computeAllRolling(dates, index, returns, 252));

      const cells = [
        scale.label.padEnd(18),
        `engine ${engineMs.toFixed(1)}ms`.padEnd(18),
        `metrics ${metricsMs.toFixed(1)}ms`.padEnd(18),
        `rolling ${rollingMs.toFixed(1)}ms`.padEnd(18),
        `${result.daily.length} days`,
      ];
      rows.push(cells.join(' '));
      // A guard, not a target: catches an accidental quadratic, and nothing else.
      expect(engineMs).toBeLessThan(60_000);
    }
    // eslint-disable-next-line no-console
    console.log('\n' + rows.join('\n') + '\n');
  }, 600_000);

  it('reports peak heap for the largest portfolio', () => {
    const scale = SCALES[SCALES.length - 1];
    const { calendar, specs } = buildScale(scale);
    const data = buildPrepared(calendar, specs);
    const config = testConfig({ start: calendar[0], end: calendar[calendar.length - 1] });
    const portfolio = {
      id: 'bench',
      name: scale.label,
      positions: specs.map((sp) => ({ id: sp.symbol, symbol: sp.symbol, weight: sp.weight })),
    };

    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    const result = runEngine({ data, config, portfolio });
    const after = process.memoryUsage().heapUsed;
    // eslint-disable-next-line no-console
    console.log(
      `\n${scale.label}: heap +${((after - before) / 1024 / 1024).toFixed(1)} MB, ` +
        `${result.daily.length} daily records, ${result.transactions.length} transactions\n`,
    );
    expect(result.daily.length).toBeGreaterThan(0);
  }, 600_000);
});

/**
 * The accounting baseline, on real recorded history.
 *
 * Printed rather than asserted here — `engine-invariants.test.ts` is what
 * holds these to account. This exists so a human can read the whole picture in
 * one place before and after a change.
 */
describe.runIf(BENCH && fs.existsSync(path.join(FIXTURES, 'tiingo-spy-2015-2024.json')))(
  'accounting baseline on recorded SPY/BND history',
  () => {
    it('prints every headline figure', async () => {
      const { fixtureProvider } = await import('./fixture-provider');
      const provider = fixtureProvider();
      const config = testConfig({
        start: '2015-01-05',
        end: '2024-12-31',
        rebalance: 'monthly',
        initialInvestment: 100_000,
      });
      const portfolio = {
        id: 'bench',
        name: '60/40',
        positions: [
          { id: 'spy', symbol: 'SPY', weight: 60 },
          { id: 'bnd', symbol: 'BND', weight: 40 },
        ],
      };
      const data = await prepareData({ symbols: portfolio.positions, config, provider });
      const result = runEngine({ data, config, portfolio });
      const metrics = computeMetrics({
        daily: result.daily,
        periodsPerYear: 252,
        riskFree: new Array(result.daily.length).fill(0),
      });
      const dates = result.daily.map((d) => d.date);
      const index = result.daily.map((d) => d.index);
      const report = buildReport({ metrics, dates, index });

      const line = (k: string, v: unknown) => `  ${k.padEnd(26)} ${v}`;
      const pct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(4)}%`);
      const num = (v: number | null) => (v == null ? '—' : v.toFixed(6));

      // eslint-disable-next-line no-console
      console.log(
        '\n' +
          [
            'ACCOUNTING BASELINE — 60/40 SPY/BND, monthly rebalance, 2015-2024',
            line('total return', pct(metrics.returns.totalReturn)),
            line('CAGR', pct(metrics.returns.cagr)),
            line('volatility (ann.)', pct(metrics.risk.volatility)),
            line('sharpe', num(metrics.ratios.sharpe)),
            line('sortino', num(metrics.ratios.sortino)),
            line('calmar', num(metrics.ratios.calmar)),
            line('max drawdown', pct(metrics.risk.maxDrawdown)),
            line('longest drawdown (days)', metrics.risk.longestDrawdownDays),
            line('downside deviation', pct(metrics.risk.downsideDeviation)),
            line('skew', num(metrics.risk.skewness)),
            line('kurtosis (excess)', num(metrics.risk.kurtosis)),
            line('VaR 95 / cVaR 95', `${pct(metrics.risk.var95)} / ${pct(metrics.risk.cvar95)}`),
            line('positive day rate', pct(metrics.risk.positiveDayRate)),
            line('trades', result.totals.tradeCount),
            line('rebalances', result.totals.rebalanceCount),
            line('dividends', result.totals.totalDividends.toFixed(2)),
            line('ulcer index', pct(report.groups.find((g) => g.id === 'risk')!
              .rows.find((r) => r.key === 'ulcer')!.value)),
            line('drawdown episodes', drawdownSeries(dates, index).filter((d) => d.drawdown < 0).length),
            line('observations', result.daily.length),
          ].join('\n') +
          '\n',
      );
      expect(result.daily.length).toBeGreaterThan(2000);
    }, 600_000);
  },
);
