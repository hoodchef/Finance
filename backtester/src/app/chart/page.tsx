import type { Metadata } from 'next';
import { ChartView } from './view';

export const metadata: Metadata = {
  title: 'Charts',
  description: 'Search any security and explore its price history, fundamentals and events.',
};

export default function ChartPage() {
  return <ChartView />;
}
