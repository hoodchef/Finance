import { NextResponse } from 'next/server';
import { runBacktest } from '@/lib/backtest';
import { getProvider } from '@/lib/market-data';
import { errorResponse } from '@/lib/api-errors';
import { parseConfig, parsePortfolio } from '@/lib/validate';
import { universeInfo } from '@/lib/market-data/universe';
import { queueStats } from '@/lib/jobs/queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The Lab's inspection endpoint.
 *
 * Returns a backtest together with the internal quantities that normally stay
 * inside the engine: the identity that must close, the ledger reconciliation,
 * the calendar it actually ran on, and every warning raised. The point is to
 * make the engine falsifiable from the UI — a number that disagrees with its
 * own components should be visible without attaching a debugger.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const portfolio = parsePortfolio(body.portfolio);
    const config = parseConfig(body.config);

    const started = Date.now();
    const result = await runBacktest({
      portfolio,
      config,
      provider: getProvider(),
      includeAssetAnalysis: true,
    });
    const elapsedMs = Date.now() - started;

    const t = result.totals;

    // P&L = ending value + divested + dividends - invested - trading cost.
    // Every term comes from the ledger, so a mismatch means the engine
    // disagrees with its own record rather than with a formula written here.
    // Two independent statements of the same gain.
    //
    //   reported   what the engine's own totals say
    //   rebuilt    realised + unrealised + dividends - every cost
    //
    // They are computed from different places in the ledger, so a non-zero
    // residual means the engine disagrees with itself. That is the single most
    // valuable thing this endpoint can surface, because every downstream
    // metric is derived from these numbers and would look plausible anyway.
    const costs =
      t.totalManagementFees + t.totalExpenseRatioCost + t.totalTradingCosts;
    const reportedGain = t.investmentGain;
    const rebuiltGain =
      t.totalRealisedGain + t.totalUnrealisedGain + t.totalDividends + t.totalCashInterest - costs;
    const residual = reportedGain - rebuiltGain;
    const scale = Math.max(1, Math.abs(t.finalValue));

    const identity = {
      endingValue: t.finalValue,
      netInvested: t.netInvested,
      contributions: t.totalContributions,
      withdrawals: t.totalWithdrawals,
      dividends: t.totalDividends,
      cashInterest: t.totalCashInterest,
      managementFees: t.totalManagementFees,
      expenseRatioCost: t.totalExpenseRatioCost,
      tradingCosts: t.totalTradingCosts,
      realised: t.totalRealisedGain,
      unrealised: t.totalUnrealisedGain,
      reportedGain,
      rebuiltGain,
      residual,
      // Relative, because an absolute cent means something different on a
      // thousand dollars than on ten million.
      closes: Math.abs(residual) / scale < 1e-6,
    };

    const perSymbol = result.lots.map((l) => ({
      symbol: l.symbol,
      openShares: l.openShares,
      openCostBasis: l.openCostBasis,
      realised: l.realisedGain,
      unrealised: l.unrealisedGain,
      dividends: l.dividends,
    }));

    return NextResponse.json({
      summary: {
        start: result.effectiveStart,
        end: result.effectiveEnd,
        tradingDays: result.series.length,
        transactions: result.transactions.length,
        elapsedMs,
        engineVersion: result.engineVersion,
      },
      metrics: result.metrics,
      totals: t,
      identity,
      perSymbol,
      warnings: result.warnings,
      dataSource: result.dataSource,
      universe: universeInfo(),
      queue: queueStats(),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
