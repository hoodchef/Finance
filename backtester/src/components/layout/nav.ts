import {
  BarChart3,
  Briefcase,
  GitCompare,
  LayoutDashboard,
  LineChart,
  Settings,
  Sparkles,
} from 'lucide-react';

export const NAV_ITEMS = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard, short: 'Home' },
  { href: '/backtest', label: 'Backtester', icon: LineChart, short: 'Test' },
  { href: '/portfolios', label: 'Portfolios', icon: Briefcase, short: 'Saved' },
  { href: '/compare', label: 'Compare', icon: GitCompare, short: 'Compare' },
  { href: '/analytics', label: 'Analytics', icon: Sparkles, short: 'Analysis' },
  { href: '/assets', label: 'Assets', icon: BarChart3, short: 'Assets' },
  { href: '/settings', label: 'Settings', icon: Settings, short: 'Settings' },
] as const;
