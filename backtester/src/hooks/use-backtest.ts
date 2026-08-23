'use client';

import * as React from 'react';
import type { BacktestConfig, Portfolio } from '@/lib/types';
import type { BacktestResult } from '@/lib/backtest';
import type { ScenarioAnalysis } from '@/lib/analysis/scenarios';

export interface ApiError {
  error: string;
  field?: string;
  kind?: string;
  symbol?: string;
}

async function postJson<T>(url: string, body: unknown, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const data = await res.json().catch(() => ({ error: 'The server returned an unreadable response.' }));
  if (!res.ok) throw data as ApiError;
  return data as T;
}

/**
 * Runs a backtest against the API. Keeps the previous result visible while a
 * new run is in flight so the page never blanks out, and aborts a superseded
 * request so a slow earlier run cannot overwrite a newer one.
 */
export function useBacktest() {
  const [result, setResult] = React.useState<BacktestResult | null>(null);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [pending, setPending] = React.useState(false);
  const controller = React.useRef<AbortController | null>(null);

  const run = React.useCallback(
    async (portfolio: Pick<Portfolio, 'id' | 'name' | 'positions'>, config: BacktestConfig) => {
      controller.current?.abort();
      const ac = new AbortController();
      controller.current = ac;

      setPending(true);
      setError(null);
      try {
        const data = await postJson<BacktestResult>('/api/backtest', { portfolio, config }, ac.signal);
        if (!ac.signal.aborted) setResult(data);
        return data;
      } catch (err) {
        if (ac.signal.aborted) return null;
        setError(
          (err as ApiError)?.error
            ? (err as ApiError)
            : { error: 'Could not reach the backtest service. Check that the dev server is running.' },
        );
        return null;
      } finally {
        if (!ac.signal.aborted) setPending(false);
      }
    },
    [],
  );

  React.useEffect(() => () => controller.current?.abort(), []);

  return { result, error, pending, run, reset: () => setResult(null) };
}

export interface CompareEntry {
  portfolio: Pick<Portfolio, 'id' | 'name' | 'positions'>;
  config: BacktestConfig;
}

/**
 * Replays saved runs for comparison. Each entry carries its own config, since a
 * run is defined by the settings it executed under.
 */
export async function postBacktestCompare(
  entries: CompareEntry[],
  signal: AbortSignal,
): Promise<{ results: BacktestResult[] }> {
  return postJson('/api/compare', { entries }, signal);
}

export async function postRebalanceAnalysis(
  portfolio: Pick<Portfolio, 'id' | 'name' | 'positions'>,
  config: BacktestConfig,
  signal: AbortSignal,
) {
  return postJson<{
    scenarios: Array<{
      frequency: string;
      label: string;
      cagr: number;
      volatility: number;
      maxDrawdown: number;
      sharpe: number;
      sortino: number;
      finalValue: number;
      trades: number;
      tradingCosts: number;
      turnoverPerYear: number;
    }>;
    warnings: Array<{ severity: string; code: string; message: string; symbol?: string }>;
  }>('/api/rebalance-analysis', { portfolio, config }, signal);
}

export async function postScenarioAnalysis(
  portfolio: Pick<Portfolio, 'id' | 'name' | 'positions'>,
  config: BacktestConfig,
  reference: string,
  signal: AbortSignal,
): Promise<ScenarioAnalysis> {
  return postJson('/api/scenarios', { portfolio, config, reference }, signal);
}
