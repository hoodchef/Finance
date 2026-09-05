'use client';

import type { BacktestResult } from '@/lib/backtest';
import { InsightsPanel } from '../panels';
import { StrategySweep } from '../strategy-sweep';

export function InsightsTab({ result }: { result: BacktestResult }) {
  return (
    <>
      <InsightsPanel result={result} />
      {/* Beside the insights rather than in its own tab: it answers "was the
          rule worth it", which is the same question the rest of this tab asks
          about the portfolio. */}
      <StrategySweep />
    </>
  );
}
