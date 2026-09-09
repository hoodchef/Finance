import type { Metadata } from 'next';
import { DeskView } from './view';

export const metadata: Metadata = {
  title: 'Desk',
  description:
    'Momentum, flow, volatility and participation for one security, each read as a shape rather than a score.',
};

export default function DeskPage() {
  return <DeskView />;
}
