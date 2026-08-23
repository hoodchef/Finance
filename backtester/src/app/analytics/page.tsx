import type { Metadata } from 'next';
import { AnalyticsView } from './view';

export const metadata: Metadata = { title: 'Analytics' };

export default function Page() {
  return <AnalyticsView />;
}
