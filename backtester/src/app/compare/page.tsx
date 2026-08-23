import type { Metadata } from 'next';
import { CompareView } from './view';

export const metadata: Metadata = { title: 'Compare' };

export default function Page() {
  return <CompareView />;
}
