import type { Metadata } from 'next';
import { CompareView } from './view';

export const metadata: Metadata = { title: 'Runs' };

export default function Page() {
  return <CompareView />;
}
