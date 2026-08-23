import type { Position } from '@/lib/types';

export interface PortfolioPreset {
  id: string;
  name: string;
  description: string;
  category: 'core' | 'balanced' | 'factor' | 'alternative';
  holdings: Array<Pick<Position, 'symbol' | 'weight'>>;
}

/**
 * Starting points, not recommendations. Each is a well-known published
 * allocation; the weights are the definition of that allocation, and nothing
 * here asserts anything about expected performance.
 */
export const PRESETS: PortfolioPreset[] = [
  {
    id: 'sp500',
    name: 'S&P 500',
    description: 'A single US large-cap index fund — the default yardstick.',
    category: 'core',
    holdings: [{ symbol: 'SPY', weight: 100 }],
  },
  {
    id: 'total-market',
    name: 'US Total Market',
    description: 'The whole US listed market in one fund.',
    category: 'core',
    holdings: [{ symbol: 'VTI', weight: 100 }],
  },
  {
    id: 'sixty-forty',
    name: '60 / 40',
    description: 'The classic balanced mandate: 60% equities, 40% investment-grade bonds.',
    category: 'balanced',
    holdings: [
      { symbol: 'SPY', weight: 60 },
      { symbol: 'BND', weight: 40 },
    ],
  },
  {
    id: 'global-equity',
    name: 'Global Equity',
    description: 'US and international equities at roughly global market weight.',
    category: 'core',
    holdings: [
      { symbol: 'VTI', weight: 60 },
      { symbol: 'VXUS', weight: 40 },
    ],
  },
  {
    id: 'three-fund',
    name: 'Three-Fund',
    description: 'US equity, international equity and US bonds.',
    category: 'balanced',
    holdings: [
      { symbol: 'VTI', weight: 50 },
      { symbol: 'VXUS', weight: 30 },
      { symbol: 'BND', weight: 20 },
    ],
  },
  {
    id: 'permanent',
    name: 'Permanent Portfolio',
    description: "Harry Browne's four-way split across equities, long bonds, gold and cash.",
    category: 'alternative',
    holdings: [
      { symbol: 'VTI', weight: 25 },
      { symbol: 'TLT', weight: 25 },
      { symbol: 'GLD', weight: 25 },
      { symbol: 'CASH', weight: 25 },
    ],
  },
  {
    id: 'all-weather',
    name: 'All Weather (retail version)',
    description: 'The widely circulated retail adaptation of a risk-balanced allocation.',
    category: 'alternative',
    holdings: [
      { symbol: 'VTI', weight: 30 },
      { symbol: 'TLT', weight: 40 },
      { symbol: 'IEF', weight: 15 },
      { symbol: 'GLD', weight: 7.5 },
      { symbol: 'DBC', weight: 7.5 },
    ],
  },
  {
    id: 'aggressive-growth',
    name: 'Aggressive Growth',
    description: 'Concentrated in large-cap growth, including a leveraged sleeve.',
    category: 'factor',
    holdings: [
      { symbol: 'QQQ', weight: 60 },
      { symbol: 'SPY', weight: 20 },
      { symbol: 'TQQQ', weight: 20 },
    ],
  },
  {
    id: 'dividend',
    name: 'Dividend Focus',
    description: 'Dividend-oriented US equity with a bond sleeve.',
    category: 'factor',
    holdings: [
      { symbol: 'SCHD', weight: 50 },
      { symbol: 'VYM', weight: 30 },
      { symbol: 'BND', weight: 20 },
    ],
  },
  {
    id: 'golden-butterfly',
    name: 'Golden Butterfly',
    description: 'Five equal sleeves across size, duration and gold.',
    category: 'alternative',
    holdings: [
      { symbol: 'VTI', weight: 20 },
      { symbol: 'VB', weight: 20 },
      { symbol: 'TLT', weight: 20 },
      { symbol: 'SHY', weight: 20 },
      { symbol: 'GLD', weight: 20 },
    ],
  },
];

export function getPreset(id: string): PortfolioPreset | undefined {
  return PRESETS.find((p) => p.id === id);
}
