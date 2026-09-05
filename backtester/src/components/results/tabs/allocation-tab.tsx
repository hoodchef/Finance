'use client';

import type { BacktestResult } from '@/lib/backtest';
import {
  AllocationDonut,
  AllocationDrift,
  ContributionChart,
} from '@/components/charts/allocation-charts';

export function AllocationTab({ result }: { result: BacktestResult }) {
  return (
    <>
      <div className="grid gap-5 lg:grid-cols-2">
        <AllocationDonut result={result} />
        <ContributionChart result={result} />
      </div>
      <AllocationDrift result={result} />
    </>
  );
}
