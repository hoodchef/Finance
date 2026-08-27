import type { Metadata } from 'next';
import { AnalyticsView } from './view';

export const metadata: Metadata = { title: 'Studies' };

export default function Page() {
  return <AnalyticsView />;
}
