import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Stable id generator that works in both the browser and on the server. */
export function uid(prefix = 'id'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

/** Deterministic colour per symbol so a ticker keeps its colour everywhere. */
const SERIES_COLORS = [
  '#38bdf8', '#a78bfa', '#34d399', '#fbbf24', '#fb7185',
  '#22d3ee', '#c084fc', '#4ade80', '#f97316', '#f472b6',
  '#60a5fa', '#2dd4bf', '#facc15', '#e879f9', '#94a3b8',
];

export function seriesColor(key: string, index?: number): string {
  if (index != null) return SERIES_COLORS[index % SERIES_COLORS.length];
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return SERIES_COLORS[h % SERIES_COLORS.length];
}

export const CHART_COLORS = SERIES_COLORS;

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
