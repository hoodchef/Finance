'use client';

import type { BacktestResult } from '@/lib/backtest';
import { TaxLotsPanel } from '../tax-lots';

export function GainsTab({ result }: { result: BacktestResult }) {
  return <TaxLotsPanel result={result} />;
}
