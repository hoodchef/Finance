import type { Metadata } from 'next';
import { PortfoliosView } from './view';

export const metadata: Metadata = { title: 'Portfolios' };

export default function Page() {
  return <PortfoliosView />;
}
