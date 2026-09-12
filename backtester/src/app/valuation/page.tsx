import type { Metadata } from 'next';
import { ValuationView } from './view';

export const metadata: Metadata = { title: 'Valuation' };

export default function Page() {
  return <ValuationView />;
}
