import type { Metadata } from 'next';
import { PerformanceView } from './view';

export const metadata: Metadata = {
  title: 'Performance metrics',
  description:
    'Risk-adjusted ratios, returns, risk and benchmark-relative statistics for one portfolio, ' +
    'each stating the convention it follows.',
};

export default function PerformancePage() {
  return <PerformanceView />;
}
