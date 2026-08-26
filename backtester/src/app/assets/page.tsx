import type { Metadata } from 'next';
import { AssetsView } from './view';

export const metadata: Metadata = { title: 'Holdings' };

export default function Page() {
  return <AssetsView />;
}
