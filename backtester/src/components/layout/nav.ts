import {
  BarChart3,
  Briefcase,
  Calculator,
  FlaskConical,
  History,
  LayoutDashboard,
  LineChart,
  Settings,
  Sparkles,
  Waves,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * Platform information architecture.
 *
 * The nav is grouped by the question being asked, in the order a user actually
 * asks them: what is my situation, what should I hold, what would it have done,
 * what might it do. A flat list of ten destinations gives no such reading —
 * and, when the planner sat seventh among peers, made one product look like two
 * bolted together.
 *
 * Route paths are stable even where labels changed; they are deep-link
 * contracts and renaming them buys nothing.
 */

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Bottom-bar label. Space there is roughly six characters. */
  short: string;
  /** Shown in the sidebar under the label; the reason to click. */
  hint: string;
}

export interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'plan',
    label: 'Plan',
    items: [
      {
        href: '/',
        label: 'Overview',
        icon: LayoutDashboard,
        short: 'Home',
        hint: 'Where everything stands',
      },
      {
        href: '/planner',
        label: 'Tax & benefits',
        icon: Calculator,
        short: 'Plan',
        hint: 'What your next dollar costs',
      },
    ],
  },
  {
    id: 'build',
    label: 'Build',
    items: [
      {
        href: '/portfolios',
        label: 'Portfolios',
        icon: Briefcase,
        short: 'Saved',
        hint: 'Allocations you have saved',
      },
      {
        href: '/backtest',
        label: 'Backtest',
        icon: LineChart,
        short: 'Test',
        hint: 'What it would have done',
      },
    ],
  },
  {
    id: 'analyse',
    label: 'Analyse',
    items: [
      {
        href: '/assets',
        label: 'Holdings',
        icon: BarChart3,
        short: 'Assets',
        hint: 'Each position on its own',
      },
      {
        href: '/analytics',
        label: 'Studies',
        icon: Sparkles,
        short: 'Studies',
        hint: 'Factors, scenarios, rebalancing',
      },
      {
        href: '/simulator',
        label: 'Simulator',
        icon: Waves,
        short: 'Sim',
        hint: 'What it might do next',
      },
    ],
  },
  {
    id: 'workspace',
    label: 'Workspace',
    items: [
      {
        href: '/compare',
        label: 'Runs',
        icon: History,
        short: 'Runs',
        hint: 'Saved results, side by side',
      },
      {
        href: '/lab',
        label: 'Lab',
        icon: FlaskConical,
        short: 'Lab',
        hint: 'Inspect and stress the engine',
      },
      {
        href: '/settings',
        label: 'Settings',
        icon: Settings,
        short: 'Setup',
        hint: 'Data sources and defaults',
      },
    ],
  },
];

/** Flat list, for anything that needs every destination. */
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/**
 * The bottom bar on mobile. Five, not ten: a bar of ten targets is unusable at
 * thumb size, and these are the five that carry the journey end to end.
 */
export const MOBILE_NAV: NavItem[] = ['/', '/planner', '/backtest', '/simulator', '/analytics']
  .map((href) => NAV_ITEMS.find((i) => i.href === href))
  .filter((i): i is NavItem => Boolean(i));
