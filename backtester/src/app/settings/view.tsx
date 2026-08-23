'use client';

import * as React from 'react';
import { Database, Download, FlaskConical, Trash2, Upload } from 'lucide-react';
import { PageBody, PageHeader } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
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

export function SettingsView() {
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
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="font-medium">Yahoo Finance</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  Daily split-adjusted closes, cash dividends and split events. No API key needed.
                  This is an unofficial endpoint: it is delayed, occasionally rate-limits, and
                  carries no accuracy warranty.
                </p>
              </div>
              <Badge variant="positive">Active</Badge>
            </div>

            <Separator />

            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="flex items-center gap-1.5 font-medium">
                  <FlaskConical className="h-3.5 w-3.5" />
                  Demo (synthetic)
                </p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  A seeded random walk for exploring the product offline. Results carry a permanent
                  banner because the prices are invented. Enable it by setting{' '}
                  <code className="rounded bg-muted px-1 py-0.5 text-2xs">
                    MARKET_DATA_PROVIDER=demo
                  </code>{' '}
                  in <code className="rounded bg-muted px-1 py-0.5 text-2xs">.env.local</code> and
                  restarting the server.
                </p>
              </div>
              <Badge variant="outline">Env var</Badge>
            </div>

            <p className="rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
              The provider is chosen on the server rather than in this panel on purpose: a data
              source is a property of the deployment, and a toggle here would let one browser tab
              show synthetic results while another shows real ones.
            </p>
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
