'use client';

import type { BacktestResult } from '@/lib/backtest';
import type { SubjectSet } from '@/lib/analytics/subject';
import { DrawdownChart } from '@/components/charts/drawdown-chart';
import { CorrelationPanel } from '../correlation-matrix';
import { DrawdownTable, RiskTable } from '../tables';

export function RiskTab({ result, subjects }: { result: BacktestResult; subjects: SubjectSet }) {
  return (
    <>
      <DrawdownChart subjects={subjects} />
      <DrawdownTable result={result} />
      <CorrelationPanel result={result} />
      <RiskTable result={result} />
    </>
  );
}
