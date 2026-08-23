'use client';

import * as React from 'react';
import { Database, Download, Scale, Trash2, Upload } from 'lucide-react';
import { PageBody, PageHeader } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ThemeToggle } from '@/components/layout/theme-toggle';
import { useHydrated } from '@/hooks/use-hydrated';
import { useWorkspace } from '@/store/workspace';
import { cn } from '@/lib/utils';

interface DataSourceInfoResponse {
  active: { id: string; label: string; description: string; synthetic: boolean };
  licence: {
    commercial: string;
    summary: string;
    commercialPath: string;
    freeTier: string;
    corporateActions: string;
  } | null;
  rejected: Array<{ provider: string; reason: string }>;
  tiingoKeyConfigured: boolean;
}

export function SettingsView() {
  const [source, setSource] = React.useState<DataSourceInfoResponse | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void fetch('/api/data-source')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) setSource(d as DataSourceInfoResponse);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const hydrated = useHydrated();
  const portfolios = useWorkspace((s) => s.portfolios);
  const config = useWorkspace((s) => s.config);
  const draft = useWorkspace((s) => s.draft);
  const [confirmClear, setConfirmClear] = React.useState(false);
  const [importError, setImportError] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  function exportWorkspace() {
    const payload = JSON.stringify({ version: 1, portfolios, draft, config }, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `backtester-workspace-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function importWorkspace(file: File) {
    setImportError(null);
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!Array.isArray(data.portfolios)) throw new Error('No portfolios found in that file.');
      useWorkspace.setState((s) => ({
        portfolios: [...data.portfolios, ...s.portfolios],
        config: data.config ?? s.config,
      }));
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'That file could not be read.');
    }
  }

  return (
    <>
      <PageHeader title="Settings" description="Appearance, data source and stored portfolios." />

      <PageBody className="max-w-3xl space-y-5">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle>Appearance</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm">Colour theme</p>
              <p className="text-xs text-muted-foreground">
                System follows your operating system setting.
              </p>
            </div>
            <ThemeToggle />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2">
              <Database className="h-4 w-4" />
              Market data
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Which provider is serving prices, and what its terms allow.
            </p>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {source ? (
              <>
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 font-medium">
                      {source.active.label}
                      {source.active.synthetic && <Badge variant="warning">Synthetic</Badge>}
                    </p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      {source.active.description}
                    </p>
                  </div>
                  <Badge variant={source.active.synthetic ? 'warning' : 'positive'}>Active</Badge>
                </div>

                {source.licence && (
                  <div
                    className={cn(
                      'rounded-md border p-3 text-xs leading-relaxed',
                      source.licence.commercial === 'permitted'
                        ? 'border-border bg-muted/40'
                        : 'border-[hsl(var(--warning))]/40 bg-[hsl(var(--warning))]/8',
                    )}
                  >
                    <p className="mb-1 flex items-center gap-1.5 font-medium">
                      <Scale className="h-3.5 w-3.5" />
                      {source.licence.commercial === 'unlicensed'
                        ? 'No data licence'
                        : source.licence.commercial === 'personal-only'
                          ? 'Personal use only'
                          : 'No licence required'}
                    </p>
                    <p>{source.licence.summary}</p>
                    {source.licence.commercial !== 'permitted' && (
                      <p className="mt-1.5 text-muted-foreground">
                        <span className="font-medium">To build a product on this:</span>{' '}
                        {source.licence.commercialPath}
                      </p>
                    )}
                    <p className="mt-1.5 text-2xs text-muted-foreground">
                      Free tier: {source.licence.freeTier} · Corporate actions:{' '}
                      {source.licence.corporateActions}
                    </p>
                  </div>
                )}

                <Separator />

                <div>
                  <p className="mb-1.5 text-xs font-medium">Switching provider</p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Set <code className="rounded bg-muted px-1 py-0.5 text-2xs">MARKET_DATA_PROVIDER</code>{' '}
                    in <code className="rounded bg-muted px-1 py-0.5 text-2xs">.env.local</code> and
                    restart. Tiingo additionally needs{' '}
                    <code className="rounded bg-muted px-1 py-0.5 text-2xs">TIINGO_API_KEY</code>
                    {source.tiingoKeyConfigured ? ' (configured).' : ' (not configured).'} After
                    changing provider, run{' '}
                    <code className="rounded bg-muted px-1 py-0.5 text-2xs">npm run verify:data</code>{' '}
                    to check its corporate-action conventions against live data before trusting a
                    backtest.
                  </p>
                </div>

                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                    Providers evaluated and rejected ({source.rejected.length})
                  </summary>
                  <ul className="mt-2 space-y-1.5 border-l border-border pl-3">
                    {source.rejected.map((r) => (
                      <li key={r.provider}>
                        <span className="font-medium">{r.provider}</span>
                        <span className="text-muted-foreground"> — {r.reason}</span>
                      </li>
                    ))}
                  </ul>
                </details>

                <p className="rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
                  The provider is chosen on the server, never by the browser. A request cannot ask
                  for synthetic data, and an unrecognised setting falls back to real data rather
                  than generated data.
                </p>
              </>
            ) : (
              <Skeleton className="h-40 w-full" />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle>Stored data</CardTitle>
            <p className="text-xs text-muted-foreground">
              Portfolios and settings are kept in this browser&rsquo;s local storage. Nothing is
              sent anywhere except the ticker symbols needed to fetch prices.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm">
              {hydrated ? (
                <>
                  <span className="numeric font-medium">{portfolios.length}</span> saved portfolio
                  {portfolios.length === 1 ? '' : 's'}
                </>
              ) : (
                '—'
              )}
            </p>

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={exportWorkspace} disabled={!hydrated}>
                <Download />
                Export workspace
              </Button>
              <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                <Upload />
                Import workspace
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept="application/json"
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void importWorkspace(file);
                  e.target.value = '';
                }}
              />
              <Button
                variant="outline"
                size="sm"
                className="text-negative"
                onClick={() => setConfirmClear(true)}
                disabled={!hydrated || portfolios.length === 0}
              >
                <Trash2 />
                Delete all portfolios
              </Button>
            </div>

            {importError && <p className="text-xs text-negative">{importError}</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle>About this build</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5 text-xs text-muted-foreground">
            <p>
              Backtests are computed server-side by a deterministic event-driven engine. Every
              metric on a results page is derived from the engine&rsquo;s daily ledger; nothing is
              hard-coded or sampled.
            </p>
            <p>
              This tool is for research and education. It is not investment advice, and past
              performance does not predict future results.
            </p>
          </CardContent>
        </Card>
      </PageBody>

      <Dialog open={confirmClear} onOpenChange={setConfirmClear}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete every saved portfolio?</DialogTitle>
            <DialogDescription>
              All {portfolios.length} saved portfolios will be removed from this browser. Export
              first if you want a copy. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmClear(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                useWorkspace.setState({ portfolios: [] });
                setConfirmClear(false);
              }}
            >
              <Trash2 />
              Delete all
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
