import type { Metadata } from 'next';
import { RetirementView } from './view';

export const metadata: Metadata = { title: 'Retirement' };

export default function Page() {
  return <RetirementView />;
}
