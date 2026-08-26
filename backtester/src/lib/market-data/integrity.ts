import type { BacktestWarning, PriceSeries } from '@/lib/types';

/**
 * Provider-agnostic sanity checks run on every series before it reaches the
 * engine. The point is that a data problem surfaces as a visible warning rather
 * than as a plausible-looking but wrong equity curve.
 */

export interface IntegrityOptions {
  /** Overnight move above this multiple is treated as a suspected raw split. */
  splitJumpRatio?: number;
  /** Calendar-day gap above this is reported as a history gap. */
  maxGapDays?: number;
  /** Tolerance when rederiving dividends from the adjusted close. */
  dividendTolerance?: number;
}

export interface DividendReconciliation {
  date: string;
  reported: number;
  impliedFromAdjClose: number;
  relativeError: number;
}

/**
 * Rederives each cash dividend from the step in `adjClose / close` and compares
 * it to the reported amount.
 *
 * For a vendor-standard adjusted series, on ex-date `t`:
 *   ratio_t / ratio_{t-1} === 1 / (1 - D / C_{t-1})
 * so  D === C_{t-1} * (1 - ratio_{t-1} / ratio_t).
 *
 * A mismatch means the dividend feed and the price feed disagree, which would
 * silently distort every reinvestment the engine makes.
 */
export function reconcileDividends(series: PriceSeries): DividendReconciliation[] {
  const index = new Map(series.bars.map((b, i) => [b.date, i]));
  const out: DividendReconciliation[] = [];

  for (const div of series.dividends) {
    const i = index.get(div.date);
    if (i == null || i === 0) continue;
    const prev = series.bars[i - 1];
    const curr = series.bars[i];
    if (!prev.close || !curr.close || !prev.adjClose || !curr.adjClose) continue;

    const ratioPrev = prev.adjClose / prev.close;
    const ratioCurr = curr.adjClose / curr.close;
    if (ratioCurr <= 0 || ratioPrev <= 0) continue;

    const implied = prev.close * (1 - ratioPrev / ratioCurr);
    out.push({
      date: div.date,
      reported: div.amount,
      impliedFromAdjClose: implied,
      relativeError: div.amount === 0 ? 0 : Math.abs(implied - div.amount) / div.amount,
    });
  }
  return out;
}

/**
 * Detects a price series that claims to be split-adjusted but still contains
 * a raw split discontinuity — the single most damaging silent data error in a
 * backtest, since it manufactures or destroys a large chunk of return.
 */
export function detectUnadjustedSplits(
  series: PriceSeries,
  jumpRatio = 1.45,
): BacktestWarning[] {
  if (series.adjustment !== 'split-adjusted' || !series.splits.length) return [];
  const index = new Map(series.bars.map((b, i) => [b.date, i]));
  const warnings: BacktestWarning[] = [];

  for (const split of series.splits) {
    const i = index.get(split.date);
    if (i == null || i === 0) continue;
    const prev = series.bars[i - 1].close;
    const curr = series.bars[i].close;
    if (!prev || !curr) continue;
    const move = prev / curr;
    const expected = split.numerator / split.denominator;
    // Only flag when the move actually tracks the split ratio; an unrelated
    // large drop on the same day is a market event, not a data error.
    if (expected >= jumpRatio && move > jumpRatio && Math.abs(move / expected - 1) < 0.15) {
      warnings.push({
        severity: 'error',
        code: 'unadjusted-split',
        symbol: series.meta.symbol,
        message: `${series.meta.symbol} shows a ${expected.toFixed(0)}:1 price discontinuity on ${split.date} that matches an unapplied stock split. Results for this asset would be wrong; the data source needs checking.`,
      });
    }
  }
  return warnings;
}

export function checkSeries(
  series: PriceSeries,
  options: IntegrityOptions = {},
): BacktestWarning[] {
  const interval = series.interval ?? 'daily';
  // Both the gap threshold and the dividend reconciliation below assume bars
  // are one trading day apart. On a weekly series every bar is a seven-day
  // "gap", so the threshold scales with the interval rather than crying wolf.
  const intervalDays = interval === 'monthly' ? 31 : interval === 'weekly' ? 7 : 1;

  const {
    splitJumpRatio = 1.45,
    maxGapDays = 10 * intervalDays,
    dividendTolerance = 0.02,
  } = options;
  const warnings: BacktestWarning[] = [];

  if (!series.bars.length) {
    warnings.push({
      severity: 'error',
      code: 'no-data',
      symbol: series.meta.symbol,
      message: `No price history for ${series.meta.symbol} in the selected window.`,
    });
    return warnings;
  }

  warnings.push(...detectUnadjustedSplits(series, splitJumpRatio));

  // Non-positive or non-finite prices.
  const bad = series.bars.filter((b) => !Number.isFinite(b.close) || b.close <= 0);
  if (bad.length) {
    warnings.push({
      severity: 'error',
      code: 'invalid-price',
      symbol: series.meta.symbol,
      message: `${series.meta.symbol} has ${bad.length} non-positive or invalid closing price(s); those days are excluded.`,
    });
  }

  // History gaps beyond a long weekend + holiday.
  let worstGap = 0;
  let worstGapAt = '';
  for (let i = 1; i < series.bars.length; i++) {
    const gap =
      (Date.parse(`${series.bars[i].date}T00:00:00Z`) -
        Date.parse(`${series.bars[i - 1].date}T00:00:00Z`)) /
      86_400_000;
    if (gap > worstGap) {
      worstGap = gap;
      worstGapAt = series.bars[i].date;
    }
  }
  if (worstGap > maxGapDays) {
    warnings.push({
      severity: 'warning',
      code: 'history-gap',
      symbol: series.meta.symbol,
      message: `${series.meta.symbol} has a ${Math.round(worstGap)}-day gap in its price history ending ${worstGapAt}. Prices are carried forward across the gap.`,
    });
  }

  // Dividend feed vs adjusted close.
  //
  // Only meaningful on daily bars. The implied dividend is derived from the
  // PREVIOUS bar's close, which on a weekly series is a week before the
  // ex-date rather than the day before it — so the implied figure is wrong by
  // however much the price moved that week, and every weekly series would
  // report a mismatch. A warning that always fires is worse than no warning:
  // it teaches people to ignore the one that matters on daily data.
  const recon = interval === 'daily' ? reconcileDividends(series) : [];
  const mismatched = recon.filter((r) => r.relativeError > dividendTolerance);
  if (mismatched.length > Math.max(1, recon.length * 0.1)) {
    warnings.push({
      severity: 'warning',
      code: 'dividend-mismatch',
      symbol: series.meta.symbol,
      message: `${mismatched.length} of ${recon.length} dividends for ${series.meta.symbol} do not reconcile with the adjusted close. Dividend-reinvested returns for this asset may be off.`,
    });
  }

  return warnings;
}
