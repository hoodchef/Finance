'use client';

import type { BacktestResult } from '@/lib/backtest';
import { HoldingsTable } from '../tables';

export function HoldingsTab({
  result,
  onSelect,
}: {
  result: BacktestResult;
  onSelect: (symbol: string) => void;
}) {
  return <HoldingsTable result={result} onSelect={onSelect} />;
}
