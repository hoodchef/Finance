import type { Metadata } from 'next';
import { OptimiseView } from './view';

export const metadata: Metadata = {
  title: 'Sharpe lab',
  description:
    'Re-weight a portfolio or build one from candidates, scored on history the solver never saw.',
};

export default function OptimisePage() {
  return <OptimiseView />;
}
