import type { Metadata } from 'next';
import { PlannerView } from './view';

export const metadata: Metadata = {
  title: 'Tax & benefits',
  description:
    'What your next dollar is actually worth in Canada, and which account it belongs in.',
};

export default function Page() {
  return <PlannerView />;
}
