import type { Metadata } from 'next';
import { OptionsView } from './view';

export const metadata: Metadata = {
  title: 'Options',
  description: 'Build a multi-leg option position and analyse its payoff, Greeks and risk.',
};

export default function OptionsPage() {
  return <OptionsView />;
}
