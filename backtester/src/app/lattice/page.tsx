import type { Metadata } from 'next';
import { LatticeView } from './view';

export const metadata: Metadata = {
  title: 'Distribution lab',
  description:
    'The binomial lattice that prices an option, the shape it leaves at each horizon, and how holdings move together.',
};

export default function LatticePage() {
  return <LatticeView />;
}
