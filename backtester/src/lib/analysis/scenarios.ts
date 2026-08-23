import type { BacktestConfig, BacktestWarning, IsoDate, Portfolio } from '@/lib/types';
import type { MarketDataProvider } from '@/lib/market-data/provider';
import { getProvider } from '@/lib/market-data';
import { prepareData } from '@/lib/engine/prepare';
import { runEngine } from '@/lib/engine/engine';
import { drawdownEpisodes, maxDrawdown, type DrawdownEpisode } from '@/lib/metrics';
import { daysBetween } from '@/lib/market-data/dates';
import { MAX_HISTORY_START } from '@/lib/defaults';

/**
 * Scenario analysis
 * =============================================================================
 * "How would this portfolio have held up in a crisis?"
 *
 * The episodes are **derived from price data, not hard-coded**. A table of
 * remembered crash dates is exactly the kind of plausible-looking input that is
 * wrong in ways nobody notices — off by a few weeks, or quietly describing the
 * S&P when the reference is the Nasdaq. Instead the reference index is run
 * through the engine, its drawdown episodes are computed, and the deepest ones
 * become the scenarios.
 *
 * Common names are applied only as decoration, and only when a computed
 * trough falls in the month that name refers to. The dates always come from the
 * data; if a name does not match, the episode is still shown, labelled by its
 * range.
 */

/**
 * Trough month → the name that period is universally known by. Used to label
 * an episode the data already found; never used to define one.
 */
const EPISODE_NAMES: Record<string, string> = {
  '1987-10': 'Black Monday',
  '1990-10': '1990 recession',
  '1998-08': 'LTCM and the Russian default',
  '2002-10': 'Dot-com crash',
  '2009-03': 'Global financial crisis',
  '2011-10': 'Euro sovereign debt crisis',
  '2016-02': 'China devaluation selloff',
  '2018-12': 'Q4 2018 selloff',
  '2020-03': 'COVID-19 crash',
  '2022-10': '2022 inflation and rate shock',
};

export interface ScenarioEpisode {
  id: string;
  /** Common name, when the trough month matches a known one. */
  name?: string;
  peakDate: IsoDate;
  troughDate: IsoDate;
  recoveryDate: IsoDate | null;
  /** The reference index's own drawdown across this episode. */
  referenceDepth: number;
  declineDays: number;
  recoveryDays: number | null;
  recovered: boolean;
}

export interface ScenarioOutcome {
  episode: ScenarioEpisode;
  /**
   * `full` — the portfolio traded through the whole episode.
   * `partial` — it existed for only part of it; figures cover what it covered.
   * `none` — no overlap at all, so nothing is reported.
   */
  coverage: 'full' | 'partial' | 'none';
  /** The window actually measured, which may be shorter than the episode. */
  measuredFrom: IsoDate | null;
  measuredTo: IsoDate | null;
  /** Portfolio time-weighted return from peak to trough. */
  portfolioDecline: number | null;
  /** Deepest portfolio drawdown inside the episode window. */
  portfolioMaxDrawdown: number | null;
  /** Peak to the reference's recovery date; null if it never recovered. */
  portfolioThroughRecovery: number | null;
  /** Portfolio decline ÷ reference decline. Below 1 means it fell less. */
  downsideCapture: number | null;
}

export interface ScenarioAnalysis {
  reference: { symbol: string; name: string };
  /** First date the reference index has history for. */
  referenceStart: IsoDate | null;
  outcomes: ScenarioOutcome[];
  portfolioStart: IsoDate | null;
  portfolioEnd: IsoDate | null;
  warnings: BacktestWarning[];
  synthetic: boolean;
}

/**
 * This view deliberately runs over the widest window available rather than the
 * user's chosen dates, so "the backtest was truncated to fit" is an internal
 * detail here, not something they asked for. Reporting it would be two
 * paragraphs of noise above the table; the span is stated in the header
 * instead.
 */
function withoutWindowNotices(warnings: BacktestWarning[]): BacktestWarning[] {
  return warnings.filter((w) => w.code !== 'window-truncated');
}

function nameFor(troughDate: IsoDate): string | undefined {
  return EPISODE_NAMES[troughDate.slice(0, 7)];
}

/** Index of the first calendar entry on or after `date`. */
function indexAtOrAfter(dates: IsoDate[], date: IsoDate): number {
  let lo = 0;
  let hi = dates.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] >= date) {
      found = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return found;
}

/** Index of the last calendar entry on or before `date`. */
function indexAtOrBefore(dates: IsoDate[], date: IsoDate): number {
  let lo = 0;
  let hi = dates.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= date) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export interface ScenarioOptions {
  portfolio: Pick<Portfolio, 'id' | 'name' | 'positions'>;
  config: BacktestConfig;
  provider?: MarketDataProvider;
  /** Index whose drawdowns define the episodes. */
  reference?: string;
  /** How many of the deepest episodes to report. */
  count?: number;
  /** Ignore drawdowns shallower than this (fraction, e.g. 0.1 for 10%). */
  minDepth?: number;
}

export async function runScenarioAnalysis({
  portfolio,
  config,
  provider = getProvider(),
  reference = 'SPY',
  count = 8,
  minDepth = 0.1,
}: ScenarioOptions): Promise<ScenarioAnalysis> {
  const referenceSymbol = reference.trim().toUpperCase();
  const warnings: BacktestWarning[] = [];

  /* ---------------------------------------------------------------- */
  /* 1. Find the episodes from the reference index's own history.      */
  /* ---------------------------------------------------------------- */

  // Deliberately over the widest window available, not the user's date range —
  // the point of this view is to reach crises the chosen range excludes.
  const wideConfig: BacktestConfig = {
    ...config,
    start: MAX_HISTORY_START,
    end: config.end,
    contributionAmount: 0,
    contributionFrequency: 'none',
    rebalance: 'never',
    dividends: 'reinvest',
    inceptionPolicy: 'truncate',
    benchmarks: [],
    fees: {
      managementFeePct: 0,
      tradingCostBps: 0,
      commissionPerTrade: 0,
      defaultExpenseRatioPct: 0,
    },
  };

  const referenceData = await prepareData({
    symbols: [{ symbol: referenceSymbol, weight: 100 }],
    config: wideConfig,
    provider,
  });

  const referenceAsset = referenceData.assets.find((a) => a.symbol === referenceSymbol);
  if (!referenceAsset || referenceData.calendar.length < 2) {
    return {
      reference: { symbol: referenceSymbol, name: referenceSymbol },
      referenceStart: null,
      outcomes: [],
      portfolioStart: null,
      portfolioEnd: null,
      warnings: [
        ...withoutWindowNotices(referenceData.warnings),
        {
          severity: 'error',
          code: 'reference-unavailable',
          symbol: referenceSymbol,
          message: `Could not load ${referenceSymbol}, so there is no reference index to derive crisis periods from.`,
        },
      ],
      synthetic: referenceData.anySynthetic,
    };
  }

  const referenceRun = runEngine({
    portfolio: {
      id: `ref-${referenceSymbol}`,
      name: referenceAsset.name,
      positions: [{ id: referenceSymbol, symbol: referenceSymbol, weight: 100 }],
    },
    config: wideConfig,
    data: referenceData,
    applyPortfolioFees: false,
  });

  const referenceDates = referenceRun.daily.map((d) => d.date);
  const referenceIndex = referenceRun.daily.map((d) => d.index);

  const episodes: ScenarioEpisode[] = drawdownEpisodes(
    referenceDates,
    referenceIndex,
    minDepth,
  )
    .slice(0, count)
    .map((e: DrawdownEpisode) => ({
      id: `${e.peakDate}_${e.troughDate}`,
      name: nameFor(e.troughDate),
      peakDate: e.peakDate,
      troughDate: e.troughDate,
      recoveryDate: e.recoveryDate,
      referenceDepth: e.depth,
      declineDays: e.declineDays,
      recoveryDays: e.recoveryDays,
      recovered: e.recovered,
    }));

  /* ---------------------------------------------------------------- */
  /* 2. Run the portfolio once over the widest window it supports.     */
  /* ---------------------------------------------------------------- */

  const portfolioPositions = portfolio.positions.filter(
    (p) => p.symbol.trim() && Number.isFinite(p.weight),
  );

  const portfolioData = await prepareData({
    symbols: portfolioPositions,
    // Keep the user's rebalancing and fees: the question is how *their*
    // strategy behaved, not how an idealised one would have.
    config: { ...wideConfig, rebalance: config.rebalance, fees: config.fees },
    provider,
  });

  if (portfolioData.calendar.length < 2) {
    return {
      reference: { symbol: referenceSymbol, name: referenceAsset.name },
      referenceStart: referenceDates[0] ?? null,
      outcomes: episodes.map((episode) => ({
        episode,
        coverage: 'none' as const,
        measuredFrom: null,
        measuredTo: null,
        portfolioDecline: null,
        portfolioMaxDrawdown: null,
        portfolioThroughRecovery: null,
        downsideCapture: null,
      })),
      portfolioStart: null,
      portfolioEnd: null,
      warnings: withoutWindowNotices([...referenceData.warnings, ...portfolioData.warnings]),
      synthetic: referenceData.anySynthetic || portfolioData.anySynthetic,
    };
  }

  const portfolioRun = runEngine({
    portfolio: { ...portfolio, positions: portfolioPositions },
    config: { ...wideConfig, rebalance: config.rebalance, fees: config.fees },
    data: portfolioData,
  });

  const pDates = portfolioRun.daily.map((d) => d.date);
  const pIndex = portfolioRun.daily.map((d) => d.index);
  const portfolioStart = pDates[0];
  const portfolioEnd = pDates[pDates.length - 1];

  /* ---------------------------------------------------------------- */
  /* 3. Slice the portfolio's own index inside each episode window.    */
  /* ---------------------------------------------------------------- */

  const outcomes: ScenarioOutcome[] = episodes.map((episode) => {
    const startIdx = indexAtOrAfter(pDates, episode.peakDate);
    const troughIdx = indexAtOrBefore(pDates, episode.troughDate);

    if (startIdx < 0 || troughIdx < 0 || troughIdx <= startIdx) {
      return {
        episode,
        coverage: 'none',
        measuredFrom: null,
        measuredTo: null,
        portfolioDecline: null,
        portfolioMaxDrawdown: null,
        portfolioThroughRecovery: null,
        downsideCapture: null,
      };
    }

    // The portfolio may have started after the episode's peak, in which case
    // its decline is measured from its own first day — and labelled partial so
    // nobody reads it as the full drawdown.
    const startedLate = pDates[startIdx] > episode.peakDate;
    const coverage: 'full' | 'partial' = startedLate ? 'partial' : 'full';

    const decline = pIndex[troughIdx] / pIndex[startIdx] - 1;
    const windowMax = maxDrawdown(pIndex.slice(startIdx, troughIdx + 1));

    let throughRecovery: number | null = null;
    if (episode.recoveryDate) {
      const recIdx = indexAtOrBefore(pDates, episode.recoveryDate);
      if (recIdx > startIdx) throughRecovery = pIndex[recIdx] / pIndex[startIdx] - 1;
    }

    return {
      episode,
      coverage,
      measuredFrom: pDates[startIdx],
      measuredTo: pDates[troughIdx],
      portfolioDecline: decline,
      portfolioMaxDrawdown: windowMax,
      portfolioThroughRecovery: throughRecovery,
      downsideCapture:
        episode.referenceDepth < 0 ? decline / episode.referenceDepth : null,
    };
  });

  const uncovered = outcomes.filter((o) => o.coverage === 'none').length;
  if (uncovered > 0) {
    warnings.push({
      severity: 'info',
      code: 'scenario-not-covered',
      message: `${uncovered} of ${episodes.length} periods pre-date this portfolio's history, which starts ${portfolioStart}. They are listed for context but no portfolio figures are shown for them.`,
    });
  }

  const partial = outcomes.filter((o) => o.coverage === 'partial').length;
  if (partial > 0) {
    warnings.push({
      severity: 'warning',
      code: 'scenario-partial',
      message: `${partial} period${partial === 1 ? '' : 's'} began before this portfolio did. Its decline there is measured from its own first trading day, so the fall it shows is smaller than the one the reference index experienced.`,
    });
  }

  void daysBetween;

  return {
    reference: { symbol: referenceSymbol, name: referenceAsset.name },
    referenceStart: referenceDates[0] ?? null,
    outcomes,
    portfolioStart,
    portfolioEnd,
    warnings: withoutWindowNotices([
      ...referenceData.warnings,
      ...portfolioData.warnings,
      ...warnings,
    ]),
    synthetic: referenceData.anySynthetic || portfolioData.anySynthetic,
  };
}
