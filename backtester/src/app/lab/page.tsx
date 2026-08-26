import type { Metadata } from 'next';
import { LabView } from './view';

export const metadata: Metadata = { title: 'Lab' };

export default function Page() {
  return <LabView />;
}
