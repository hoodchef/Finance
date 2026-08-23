import type { Metadata } from 'next';
import { BacktestWorkspace } from './workspace';

export const metadata: Metadata = {
  title: 'Backtester',
  description: 'Build a portfolio, configure the run, and see how it would have performed.',
};

export default function BacktestPage() {
  return <BacktestWorkspace />;
}
