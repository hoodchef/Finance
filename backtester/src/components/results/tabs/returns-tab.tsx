'use client';

import type { BacktestResult } from '@/lib/backtest';
import { AnnualReturnsChart, AnnualSummary } from '@/components/charts/annual-returns';
import { MonthlyHeatmap } from '@/components/charts/monthly-heatmap';
import { RollingChart, RollingTable } from '@/components/charts/rolling-chart';
import { PeriodReturnsTable } from '../period-returns';

export function ReturnsTab({ result }: { result: BacktestResult }) {
  return (
    <>
      <AnnualReturnsChart result={result} />
      <AnnualSummary result={result} />
      <MonthlyHeatmap monthly={result.metrics.monthly} annual={result.metrics.annual} />
      <RollingChart result={result} />
      <RollingTable result={result} />
      <PeriodReturnsTable result={result} />
    </>
  );
}
