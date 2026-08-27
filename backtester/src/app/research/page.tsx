import type { Metadata } from 'next';
import { ResearchView } from './view';

export const metadata: Metadata = { title: 'Research' };

export default function Page() {
  return <ResearchView />;
}
