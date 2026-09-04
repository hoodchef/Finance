import {
  BarChart3,
  Briefcase,
  Building2,
  Calculator,
  CandlestickChart,
  FlaskConical,
  History,
  Hourglass,
  LayoutDashboard,
  LineChart,
  Grid3x3,
  Settings,
  Sigma,
  Sparkles,
  Waves,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * Platform information architecture.
 *
 * Fourteen destinations, grouped by **what each one is about** rather than by
 * what you do there:
 *
 *   Plan       — you: your income, your taxes, your retirement.
 *   Markets    — one security: its price, its filings, its options.
 *   Portfolio  — one allocation: build it, test it, take it apart, project it.
 *   Workspace  — your saved work, and the machinery underneath it.
 *
 * This replaces a Plan / Build / Analyse / Workspace split, which cut by verb.
 * That reading put six of thirteen destinations under "Analyse" and left
 * "Build" with two, and — worse — it scattered the three single-security pages
 * across two groups, so Research sat beside Studies and Simulator, which are
 * about a portfolio, while Options sat five rows from the chart of the same
 * company. Grouping by subject puts Charts, Research and Options together,
 * which is exactly the set `TickerBar` moves between, and gives four menus of
 * three, three, five and three instead of three, two, six and three.
 *
 * Route paths are stable even where labels changed; they are deep-link
 * contracts and renaming them buys nothing. Labels are load-bearing too:
 * `tests/routes.test.ts` requires each one to match the `PageHeader` title of
 * the page it leads to, so a page that reads "Charts" is not reached by a menu
 * item that says "Chart".
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
      {
        href: '/retirement',
        label: 'Retirement',
        icon: Hourglass,
        short: 'Retire',
        hint: 'What CPP and OAS will pay',
      },
    ],
  },
  {
    id: 'markets',
    label: 'Markets',
    /**
     * One security at a time, in the order you meet it: the price first,
     * then what the company reported, then what its options cost. These three
     * are the destinations `TickerBar` switches between, so the grouping and
     * the bar tell the same story.
     */
    items: [
      {
        href: '/chart',
        label: 'Charts',
        icon: CandlestickChart,
        short: 'Chart',
        hint: 'Price and events for one security',
      },
      {
        href: '/research',
        label: 'Research',
        icon: Building2,
        short: 'Co',
        hint: 'Company fundamentals from SEC filings',
      },
      {
        href: '/options',
        label: 'Options',
        icon: Sigma,
        short: 'Opts',
        hint: 'Multi-leg payoff, Greeks and risk',
      },
    ],
  },
  {
    id: 'portfolio',
    label: 'Portfolio',
    /** Build it, test it, take it apart, study it, project it. In that order. */
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
        href: '/lattice',
        label: 'Distribution lab',
        icon: Grid3x3,
        short: 'Lab',
        hint: 'The lattice, the ridge and how holdings relate',
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
 * The destinations that are about **one security**, in reading order.
 *
 * `TickerBar` renders these as the views of whatever symbol is in focus, so the
 * set lives here with the rest of the information architecture rather than in
 * the component: one place decides what a destination is called, and the bar
 * cannot drift into naming a page something the menus do not.
 *
 * Backtest is the odd one — its page belongs to portfolio work — but "what
 * would holding this have returned" is the fourth question you ask about a
 * company, and refusing to offer it from the bar would send you back to a
 * search box to ask it.
 */
export const TICKER_LENSES: NavItem[] = ['/chart', '/research', '/options', '/backtest']
  .map((href) => NAV_ITEMS.find((i) => i.href === href))
  .filter((i): i is NavItem => Boolean(i));

/**
 * The bottom bar on mobile. Five, not fourteen: a bar of fourteen targets is
 * unusable at thumb size, and these are the five that carry the journey end to
 * end. The nav bar's menu reaches the other nine.
 *
 * Charts takes the slot Studies held. Looking a security up is the thing people
 * do standing in a queue; Studies is a page of wide tables that wants a desk,
 * and is one tap away in the menu.
 */
export const MOBILE_NAV: NavItem[] = ['/', '/chart', '/planner', '/backtest', '/simulator']
  .map((href) => NAV_ITEMS.find((i) => i.href === href))
  .filter((i): i is NavItem => Boolean(i));
