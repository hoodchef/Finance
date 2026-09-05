import type { Metadata, Viewport } from 'next';
// Self-hosted from node_modules. See the typography note below.
import '@fontsource-variable/inter/opsz.css';
import '@fontsource-variable/jetbrains-mono';
import './globals.css';
import { AppShell } from '@/components/layout/app-shell';
import { ThemeProvider } from '@/components/layout/theme-provider';
import { TooltipProvider } from '@/components/ui/tooltip';

/**
 * Typography.
 * =============================================================================
 * Both faces are SELF-HOSTED from `node_modules`, and that is not a preference:
 * `next.config.js` sets `font-src 'self' data:`, so a link to a font CDN would
 * be blocked outright and the page would fall back to the system stack without
 * saying so.
 *
 * Before this, nothing was loaded at all. `--font-sans` was a system stack, so
 * the product rendered in SF on a Mac, Segoe UI on Windows and something else
 * again on Linux — three different products, none of them designed. The dead
 * giveaway was `font-feature-settings: 'cv02' 'cv03' 'cv04'` in `globals.css`:
 * those are Inter's own character variants, and they had never once applied.
 *
 * Inter for text, and specifically the OPTICAL SIZE build. Inter was drawn for
 * interfaces at small sizes, which is this product's whole constraint — tables
 * at 12px, labels at 11px — and the `opsz` axis makes the face adapt to the
 * size it is set at rather than scaling one drawing to all of them: wider
 * apertures and looser spacing down at 11px, tighter fit at a 24px headline
 * figure. `font-optical-sizing: auto` in `globals.css` is what drives it.
 *
 * JetBrains Mono for figures. `.numeric` puts every number in the product in
 * the mono face, and the terminal and bloomberg themes render their entire
 * interface in it, so it carries as much weight as the text face. It has an
 * unusually tall x-height for a monospace, which is what keeps a 12px column
 * of figures readable.
 *
 * Both are the variable builds: one file spans the whole weight range, so the
 * eight weights the interface uses cost one download rather than eight.
 *
 * The fontsource packages are used rather than `next/font/google` for the
 * optical-size build, which Google's Inter does not expose, and to keep the
 * files vendored in `node_modules` instead of fetched at build time.
 *
 * What that choice does NOT buy is Inter's character variants: neither build
 * ships them. Checked rather than assumed — rendered at 70px, `0123469aIl` is
 * identical with and without `cv01`/`cv02`/`cv05`/`cv08`, so an upper-case I
 * and a lower-case l stay indistinguishable stems in the text face. They are
 * told apart in the MONO face, which has a serifed I and a tailed l by
 * default, and that is the face every figure and every ticker is set in.
 */

export const metadata: Metadata = {
  title: {
    default: 'CanPath — Canadian financial planning and portfolio analytics',
    template: '%s · CanPath',
  },
  description:
    'Construct portfolios, backtest them against real historical market data, and analyse return, risk and attribution.',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0e1116' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
          // next-themes only applies a class for themes it knows about, and
          // "system" must stay in the list or the system option stops working.
          themes={['light', 'dark', 'terminal', 'bloomberg', 'system']}
        >
          <TooltipProvider delayDuration={200} skipDelayDuration={400}>
            <AppShell>{children}</AppShell>
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
