import type {
  BacktestConfig,
  BacktestWarning,
  IsoDate,
  Position,
  PriceSeries,
} from '@/lib/types';
import { CASH_SYMBOL } from '@/lib/types';
import type { MarketDataProvider } from '@/lib/market-data/provider';
import { checkSeries } from '@/lib/market-data/integrity';
import { alignRates, getFxSeries } from '@/lib/market-data/fx';
import { buildDeflator, getInflationProvider } from '@/lib/market-data/inflation';
import { maxIso, minIso, yearsBetween } from '@/lib/market-data/dates';
import type { PreparedAsset, PreparedData } from './types';

/**
 * Turns a set of tickers plus a config into calendar-aligned arrays the engine
 * can walk without any further lookups or branching on data availability.
 *
 * Everything that could quietly corrupt a result — an asset that did not exist
 * yet, one that stopped trading, a gap in history — is resolved here, once, and
 * reported as a warning rather than being papered over.
 */

const RISK_FREE_SYMBOL = '^IRX';

function isCashSymbol(symbol: string): boolean {
  return symbol.toUpperCase() === CASH_SYMBOL;
}

function isCryptoSymbol(series: PriceSeries | undefined): boolean {
  return series?.meta.assetClass === 'crypto';
}

export interface PrepareOptions {
  symbols: Array<Pick<Position, 'symbol' | 'weight' | 'expenseRatio'>>;
  config: BacktestConfig;
  provider: MarketDataProvider;
  /** Extra tickers to align onto the same calendar (benchmarks). */
  extraSymbols?: string[];
}

export async function prepareData({
  symbols,
  config,
  provider,
  extraSymbols = [],
}: PrepareOptions): Promise<PreparedData> {
  const warnings: BacktestWarning[] = [];

  const unique = new Map<string, { weight: number; expenseRatio?: number }>();
  for (const p of symbols) {
    const key = p.symbol.trim().toUpperCase();
    if (!key) continue;
    const existing = unique.get(key);
    unique.set(key, {
      weight: (existing?.weight ?? 0) + p.weight,
      expenseRatio: p.expenseRatio ?? existing?.expenseRatio,
    });
  }
  for (const s of extraSymbols) {
    const key = s.trim().toUpperCase();
    if (key && !unique.has(key)) unique.set(key, { weight: 0 });
  }

  const fetchList = [...unique.keys()].filter((s) => !isCashSymbol(s));
  const range = { start: config.start, end: config.end };

  const settled = await Promise.allSettled(
    fetchList.map((s) => provider.getHistoricalPrices(s, range)),
  );

  const seriesBySymbol = new Map<string, PriceSeries>();
  settled.forEach((res, i) => {
    const symbol = fetchList[i];
    if (res.status === 'fulfilled' && res.value.bars.length) {
      seriesBySymbol.set(symbol, res.value);
      warnings.push(...checkSeries(res.value));
      if (res.value.stale) {
        warnings.push({
          severity: 'warning',
          code: 'stale-cache',
          symbol,
          message: `${symbol} was served from a cached copy retrieved ${res.value.fetchedAt.slice(0, 10)} because the data provider could not be reached. These are real prices, but the most recent sessions may be missing.`,
        });
      }
    } else {
      const reason =
        res.status === 'rejected'
          ? res.reason instanceof Error
            ? res.reason.message
            : String(res.reason)
          : `No price history for ${symbol} between ${config.start} and ${config.end}.`;
      warnings.push({
        severity: 'error',
        code: 'symbol-unavailable',
        symbol,
        message: reason,
      });
    }
  });

  const usable = fetchList.filter((s) => seriesBySymbol.has(s));
  const hasCashSleeve = [...unique.keys()].some(isCashSymbol);

  // Weighted holdings that could not be loaded. A benchmark failing is a
  // nuisance; a funded holding failing means the requested portfolio cannot be
  // evaluated at all, and the caller must decide rather than be handed a
  // silently different one.
  const unavailableHoldings = fetchList.filter(
    (sym) => !seriesBySymbol.has(sym) && (unique.get(sym)?.weight ?? 0) !== 0,
  );

  // A portfolio made only of cash is legitimate — it is the baseline every
  // other allocation is measured against — but it has no priceable security to
  // derive a trading calendar from, so ask the provider for one.
  let fallbackCalendar: IsoDate[] = [];
  if (!usable.length && hasCashSleeve) {
    try {
      fallbackCalendar = await provider.getTradingCalendar(range);
    } catch {
      fallbackCalendar = [];
    }
    if (!fallbackCalendar.length) {
      warnings.push({
        severity: 'error',
        code: 'no-calendar',
        message:
          'A cash-only portfolio still needs a market calendar to run against, and one could not be loaded.',
      });
    }
  }

  if (!usable.length && !fallbackCalendar.length) {
    return {
      calendar: [],
      assets: [],
      warnings,
      riskFree: [],
      deflator: [],
      inflationSource: null,
      periodsPerYear: 252,
      sources: [],
      anySynthetic: provider.synthetic,
      unavailableHoldings,
    };
  }

  /* -------------------------------------------------------------- */
  /* Effective window                                                */
  /* -------------------------------------------------------------- */

  // Only weighted portfolio holdings constrain the window. A benchmark with a
  // shorter history should not shorten the portfolio's own backtest.
  const weighted = usable.filter((s) => (unique.get(s)?.weight ?? 0) !== 0);
  const constraining = weighted.length ? weighted : usable;

  const latestInception = constraining.reduce<IsoDate>(
    (acc, s) => maxIso(acc, seriesBySymbol.get(s)!.bars[0].date),
    config.start,
  );
  const earliestLastBar = constraining.reduce<IsoDate>(
    (acc, s) => minIso(acc, seriesBySymbol.get(s)!.bars.at(-1)!.date),
    config.end,
  );

  let effectiveStart = config.start;
  let effectiveEnd = config.end;

  const lateStarters = constraining.filter(
    (s) => seriesBySymbol.get(s)!.bars[0].date > config.start,
  );

  if (lateStarters.length) {
    if (config.inceptionPolicy === 'error') {
      for (const s of lateStarters) {
        warnings.push({
          severity: 'error',
          code: 'inception-after-start',
          symbol: s,
          message: `${s} has no price history before ${seriesBySymbol.get(s)!.bars[0].date}, which is after the requested start of ${config.start}.`,
        });
      }
    } else if (config.inceptionPolicy === 'truncate') {
      effectiveStart = latestInception;
      warnings.push({
        severity: 'warning',
        code: 'window-truncated',
        message: `Backtest starts ${effectiveStart} instead of ${config.start}: ${lateStarters
          .map((s) => `${s} (from ${seriesBySymbol.get(s)!.bars[0].date})`)
          .join(', ')} ${lateStarters.length === 1 ? 'has' : 'have'} no earlier history.`,
      });
    } else {
      warnings.push({
        severity: 'warning',
        code: 'pre-inception-cash',
        message: `${lateStarters.join(', ')} did not exist at the start date. Their target weight is held in cash until their first trading day.`,
      });
    }
  }

  const delisted = constraining.filter(
    (s) => seriesBySymbol.get(s)!.bars.at(-1)!.date < earliestLastBar,
  );
  const stoppedEarly = constraining.filter((s) => {
    const last = seriesBySymbol.get(s)!.bars.at(-1)!.date;
    // More than ~2 weeks of missing tail relative to the requested end.
    return last < config.end && yearsBetween(last, config.end) > 14 / 365.25;
  });
  for (const s of stoppedEarly) {
    warnings.push({
      severity: 'warning',
      code: 'series-ends-early',
      symbol: s,
      message: `${s} has no price data after ${seriesBySymbol.get(s)!.bars.at(-1)!.date}. The position is liquidated to cash on that date (possible delisting or ticker change).`,
    });
  }
  void delisted;

  /* -------------------------------------------------------------- */
  /* Currency                                                        */
  /* -------------------------------------------------------------- */

  // The engine sums `shares x price`, so holdings in different currencies must
  // be translated into one before they can be added. Where that is impossible
  // the run is refused rather than producing a confident wrong total.
  const weightedSymbols = usable.filter((s) => (unique.get(s)?.weight ?? 0) !== 0);
  const currencyOf = new Map<string, string>();
  for (const sym of weightedSymbols) {
    const ccy = seriesBySymbol.get(sym)?.meta.currency;
    if (ccy) currencyOf.set(sym, ccy.toUpperCase());
  }
  const distinct = new Set(currencyOf.values());

  /**
   * Default base is whichever currency the largest share of the portfolio is
   * already in, so a single-currency portfolio is never converted and never
   * acquires FX movement it did not actually experience.
   */
  let baseCurrency = config.baseCurrency?.toUpperCase();
  if (!baseCurrency && distinct.size > 0) {
    const byWeight = new Map<string, number>();
    for (const [sym, ccy] of currencyOf) {
      byWeight.set(ccy, (byWeight.get(ccy) ?? 0) + Math.abs(unique.get(sym)?.weight ?? 0));
    }
    baseCurrency = [...byWeight.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }

  const needsFx =
    baseCurrency != null &&
    [...currencyOf.values()].some((c) => c !== baseCurrency);

  if (distinct.size === 0 && weightedSymbols.length > 1) {
    // Provider does not report currency. An exchange suffix hints at the venue
    // but is not a statement about denomination, so this warns rather than
    // refusing or silently converting.
    const suffixes = new Set(
      weightedSymbols.map((s) => (/\.([A-Z]{1,3})$/.exec(s)?.[1] ?? 'US')),
    );
    if (suffixes.size > 1) {
      warnings.push({
        severity: 'warning',
        code: 'possible-mixed-currency',
        message: `These holdings are listed on different exchanges (${weightedSymbols.join(', ')}) and this data provider does not report currency, so no exchange-rate translation could be applied. If they are denominated differently, the totals below add incompatible units.`,
      });
    }
  }

  /* -------------------------------------------------------------- */
  /* Master calendar                                                 */
  /* -------------------------------------------------------------- */

  // Crypto trades every day; if it shared the calendar it would add weekends on
  // which every equity price is stale. Equities define the calendar whenever
  // there is at least one.
  const nonCrypto = usable.filter((s) => !isCryptoSymbol(seriesBySymbol.get(s)));
  const calendarSymbols = nonCrypto.length ? nonCrypto : usable;

  const dayset = new Set<IsoDate>();
  for (const s of calendarSymbols) {
    for (const bar of seriesBySymbol.get(s)!.bars) {
      if (bar.date >= effectiveStart && bar.date <= effectiveEnd) dayset.add(bar.date);
    }
  }
  for (const d of fallbackCalendar) {
    if (d >= effectiveStart && d <= effectiveEnd) dayset.add(d);
  }
  const calendar = [...dayset].sort();

  if (calendar.length < 2) {
    warnings.push({
      severity: 'error',
      code: 'window-too-short',
      message: `The selected window contains ${calendar.length} trading day(s). Widen the date range.`,
    });
    return {
      calendar,
      assets: [],
      warnings,
      riskFree: [],
      deflator: [],
      inflationSource: null,
      periodsPerYear: 252,
      sources: [],
      anySynthetic: provider.synthetic,
      unavailableHoldings,
    };
  }

  const dayIndex = new Map(calendar.map((d, i) => [d, i]));
  const span = yearsBetween(calendar[0], calendar.at(-1)!);

  // Annualising a two-week sample produces a CAGR of several hundred percent.
  // It is arithmetically correct and completely misleading, so say so.
  if (span < 1) {
    warnings.push({
      severity: 'warning',
      code: 'short-window',
      message: `This backtest covers ${calendar.length} trading days (${(span * 12).toFixed(1)} months). CAGR, volatility, Sharpe and Sortino are annualised from that short sample and extrapolate heavily — read the total return instead.`,
    });
  }
  const periodsPerYear =
    span >= 1 ? Math.min(366, Math.max(200, calendar.length / span)) : nonCrypto.length ? 252 : 365;

  /* -------------------------------------------------------------- */
  /* Calendar-aligned asset arrays                                   */
  /* -------------------------------------------------------------- */

  /* -------------------------------------------------------------- */
  /* Exchange rates                                                   */
  /* -------------------------------------------------------------- */

  /** Aligned rate per calendar day, by the currency being converted FROM. */
  const fxByCurrency = new Map<string, number[]>();
  let fxSourceLabel: string | null = null;

  if (needsFx && baseCurrency) {
    const foreign = [...new Set([...currencyOf.values()].filter((c) => c !== baseCurrency))];

    for (const from of foreign) {
      try {
        const series = await getFxSeries(from, baseCurrency, {
          start: calendar[0],
          end: calendar[calendar.length - 1],
        });
        const { rates, missingBefore } = alignRates(series, calendar);
        fxByCurrency.set(from, rates);
        fxSourceLabel = series.sourceLabel;

        if (missingBefore) {
          // Rates do not reach the start of the window. Extrapolating one
          // backwards would be inventing the single number the conversion
          // depends on, so the affected days are dropped instead.
          warnings.push({
            severity: 'warning',
            code: 'fx-history-short',
            message: `Exchange rates for ${from}/${baseCurrency} from ${series.sourceLabel} begin ${series.earliest}, after this backtest starts. Days before that cannot be valued and are excluded.`,
          });
        }
      } catch (err) {
        warnings.push({
          severity: 'error',
          code: 'fx-unavailable',
          message:
            err instanceof Error
              ? err.message
              : `No ${from}/${baseCurrency} exchange rate could be loaded, so this portfolio cannot be valued.`,
        });
      }
    }

    if (fxByCurrency.size > 0) {
      warnings.push({
        severity: 'info',
        code: 'fx-applied',
        message: `Holdings in ${foreign.join(', ')} are translated into ${baseCurrency} at the ${fxSourceLabel ?? 'published'} daily rate. Returns therefore include currency movement, which is real risk borne by a ${baseCurrency} investor and not an artefact.`,
      });
    }
  }

  const assets: PreparedAsset[] = [];

  for (const [symbol, spec] of unique) {
    if (isCashSymbol(symbol)) {
      assets.push({
        symbol: CASH_SYMBOL,
        name: 'Cash',
        isCash: true,
        targetWeight: spec.weight,
        expenseRatioPct: 0,
        prices: new Array(calendar.length).fill(1),
        stale: new Array(calendar.length).fill(false),
        dividends: new Array(calendar.length).fill(0),
        splitFactors: new Array(calendar.length).fill(1),
        firstIndex: 0,
        lastIndex: calendar.length - 1,
      });
      continue;
    }

    const series = seriesBySymbol.get(symbol);
    if (!series) continue;

    const prices = new Array<number>(calendar.length).fill(Number.NaN);
    const stale = new Array<boolean>(calendar.length).fill(false);
    const dividends = new Array<number>(calendar.length).fill(0);
    const splitFactors = new Array<number>(calendar.length).fill(1);

    const barByDate = new Map(series.bars.map((b) => [b.date, b]));
    let firstIndex = -1;
    let lastIndex = -1;
    let carried = Number.NaN;
    let staleRun = 0;
    let worstStaleRun = 0;

    for (let i = 0; i < calendar.length; i++) {
      const bar = barByDate.get(calendar[i]);
      if (bar) {
        prices[i] = bar.close;
        carried = bar.close;
        if (firstIndex < 0) firstIndex = i;
        lastIndex = i;
        staleRun = 0;
      } else if (Number.isFinite(carried)) {
        // The security did not trade on a day the master calendar did (a local
        // holiday, or a halt). Carry the last observed price forward — the only
        // honest option — and flag it.
        prices[i] = carried;
        stale[i] = true;
        staleRun++;
        worstStaleRun = Math.max(worstStaleRun, staleRun);
      }
    }

    // Everything after the last observed bar is not "stale price", it is
    // "no longer trading" — the engine liquidates there instead.
    for (let i = lastIndex + 1; i < calendar.length; i++) {
      prices[i] = Number.NaN;
      stale[i] = false;
    }

    if (worstStaleRun >= 5) {
      warnings.push({
        severity: 'warning',
        code: 'stale-prices',
        symbol,
        message: `${symbol} went up to ${worstStaleRun} consecutive market days without a price. The previous close is carried forward on those days.`,
      });
    }

    for (const d of series.dividends) {
      const i = dayIndex.get(d.date);
      if (i != null) dividends[i] += d.amount;
      else {
        // Ex-date on a day the master calendar does not contain: attribute it
        // to the next calendar day so the cash is never lost.
        const next = calendar.findIndex((c) => c >= d.date);
        if (next >= 0) dividends[next] += d.amount;
      }
    }

    if (series.adjustment === 'raw') {
      for (const s of series.splits) {
        const i = dayIndex.get(s.date);
        if (i != null) splitFactors[i] *= s.numerator / s.denominator;
      }
    }

    if (firstIndex < 0) {
      warnings.push({
        severity: 'error',
        code: 'no-data-in-window',
        symbol,
        message: `${symbol} has no price data inside ${calendar[0]} – ${calendar.at(-1)}.`,
      });
      continue;
    }

    // Translate into the base currency. Prices and dividends both convert at
    // the rate for their own day: a dividend received in USD is worth whatever
    // it was worth on the day it was paid, not at some later rate.
    const assetCurrency = currencyOf.get(symbol);
    const fx = assetCurrency ? fxByCurrency.get(assetCurrency) : undefined;
    if (fx) {
      for (let i = 0; i < calendar.length; i++) {
        const rate = fx[i];
        if (!Number.isFinite(rate)) {
          // No rate for this day means the holding cannot be valued in the
          // base currency; treat it as absent rather than guessing.
          prices[i] = Number.NaN;
          dividends[i] = 0;
          continue;
        }
        if (Number.isFinite(prices[i])) prices[i] *= rate;
        if (dividends[i]) dividends[i] *= rate;
      }
      // Re-derive the tradable span, which the missing rates may have shortened.
      firstIndex = prices.findIndex((v) => Number.isFinite(v) && v > 0);
      for (let i = calendar.length - 1; i >= 0; i--) {
        if (Number.isFinite(prices[i]) && prices[i] > 0) {
          lastIndex = i;
          break;
        }
      }
      if (firstIndex < 0) {
        warnings.push({
          severity: 'error',
          code: 'no-data-in-window',
          symbol,
          message: `${symbol} could not be converted into ${baseCurrency} for any day in this window.`,
        });
        continue;
      }
    }

    assets.push({
      symbol,
      name: series.meta.name,
      isCash: false,
      targetWeight: spec.weight,
      expenseRatioPct: spec.expenseRatio ?? config.fees.defaultExpenseRatioPct,
      prices,
      stale,
      dividends,
      splitFactors,
      firstIndex,
      lastIndex,
      series,
    });
  }

  /* -------------------------------------------------------------- */
  /* Risk-free rate                                                  */
  /* -------------------------------------------------------------- */

  const riskFree = new Array<number>(calendar.length).fill(0);
  if (config.riskFree.source === 'constant') {
    riskFree.fill(config.riskFree.constantPct / 100);
  } else if (config.riskFree.source === 'tbill' && provider.synthetic) {
    // A synthetic provider would happily generate a "^IRX" random walk, and
    // dividing it by 100 would yield double-digit risk-free rates that quietly
    // destroy every Sharpe and Sortino on the page.
    riskFree.fill(config.riskFree.constantPct / 100);
    warnings.push({
      severity: 'warning',
      code: 'risk-free-synthetic',
      message: `The Treasury bill series is not available from the ${provider.label} provider. Using the fixed ${config.riskFree.constantPct}% risk-free rate instead.`,
    });
  } else if (config.riskFree.source === 'tbill') {
    try {
      const irx = await provider.getHistoricalPrices(RISK_FREE_SYMBOL, {
        start: calendar[0],
        end: calendar.at(-1)!,
      });
      // ^IRX quotes the 13-week bill discount rate in percent.
      const byDate = new Map(irx.bars.map((b) => [b.date, b.close / 100]));
      let last = 0;
      let matched = 0;
      for (let i = 0; i < calendar.length; i++) {
        const v = byDate.get(calendar[i]);
        if (v != null && Number.isFinite(v)) {
          last = v;
          matched++;
        }
        riskFree[i] = last;
      }
      if (matched === 0) throw new Error('no overlapping observations');
    } catch {
      riskFree.fill(config.riskFree.constantPct / 100);
      warnings.push({
        severity: 'warning',
        code: 'risk-free-unavailable',
        message: `The 13-week Treasury bill series (^IRX) could not be loaded. Falling back to the fixed ${config.riskFree.constantPct}% risk-free rate for Sharpe and Sortino.`,
      });
    }
  }

  /* -------------------------------------------------------------- */
  /* Inflation                                                       */
  /* -------------------------------------------------------------- */

  let deflator = new Array<number>(calendar.length).fill(1);
  let inflationSource: PreparedData['inflationSource'] = null;

  if (config.inflation.mode !== 'off') {
    const inflationProvider = getInflationProvider(
      config.inflation.mode,
      config.inflation.constantPct,
    );
    try {
      const series = await inflationProvider.getSeries({
        start: calendar[0],
        end: calendar.at(-1)!,
      });
      const built = buildDeflator(calendar, series);
      deflator = built.deflator;
      warnings.push(...built.warnings);
      inflationSource = { label: series.label, synthetic: series.synthetic };
    } catch (err) {
      // Never fall back to a guessed rate: a real return computed from an
      // invented price level is worse than no real return at all.
      warnings.push({
        severity: 'warning',
        code: 'inflation-load-failed',
        message: `The inflation series could not be loaded (${
          err instanceof Error ? err.message : 'unknown error'
        }). Results are shown in nominal terms only.`,
      });
    }
  }

  const sources = [...seriesBySymbol.entries()].map(([symbol, s]) => ({
    symbol,
    source: s.source,
    synthetic: s.synthetic,
    // When this series was retrieved, and the last date it actually covers.
    // Both matter: a cached series can be fresh-looking but stale, and a live
    // fetch can still be missing the most recent sessions.
    fetchedAt: s.fetchedAt,
    lastBarDate: s.bars.at(-1)?.date,
    stale: s.stale === true,
  }));

  return {
    calendar,
    assets,
    warnings,
    riskFree,
    deflator,
    inflationSource,
    periodsPerYear,
    sources,
    anySynthetic: provider.synthetic || sources.some((s) => s.synthetic),
    unavailableHoldings,
  };
}
