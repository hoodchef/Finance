import type { Metadata } from 'next';
import { SimulatorView } from './view';

export const metadata: Metadata = { title: 'Simulator' };

export default function Page() {
  return <SimulatorView />;
}
