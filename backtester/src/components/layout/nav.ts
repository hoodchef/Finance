import {
  BarChart3,
  Briefcase,
  Calculator,
  History,
  LayoutDashboard,
  LineChart,
  Settings,
  Sparkles,
} from 'lucide-react';

/**
 * Platform information architecture.
 *
 * The Backtester is the flagship research workspace: a dense, stateful surface
 * you iterate in, deliberately separate from the Dashboard, which is a
 * glanceable launchpad. Those are opposite ergonomics and do not belong on one
 * screen.
 *
 * "Runs" was previously "Compare". Comparison is a *mode*, not a destination —
 * a page you visit to re-select things you already had selected elsewhere is
 * friction. Runs accumulate from your own work and comparison happens inside
 * them, which removes the re-selection step entirely.
 *
 * Route paths are kept stable even where labels changed; they are deep-link
 * contracts and renaming them buys nothing.
 */
export const NAV_ITEMS = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard, short: 'Home' },
  { href: '/backtest', label: 'Backtester', icon: LineChart, short: 'Test' },
  { href: '/portfolios', label: 'Portfolios', icon: Briefcase, short: 'Saved' },
  { href: '/compare', label: 'Runs', icon: History, short: 'Runs' },
  { href: '/assets', label: 'Analyzer', icon: BarChart3, short: 'Analyze' },
  { href: '/analytics', label: 'Studies', icon: Sparkles, short: 'Studies' },
  { href: '/planner', label: 'Planner', icon: Calculator, short: 'Plan' },
  { href: '/settings', label: 'Settings', icon: Settings, short: 'Settings' },
] as const;
