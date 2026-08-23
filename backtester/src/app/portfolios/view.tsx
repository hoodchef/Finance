'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Briefcase,
  Copy,
  GitCompare,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Trash2,
} from 'lucide-react';
import { PageBody, PageHeader } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { AllocationBar } from '@/components/builder/allocation-bar';
import { useHydrated } from '@/hooks/use-hydrated';
import { totalWeight, useWorkspace } from '@/store/workspace';
import { formatDate } from '@/lib/format';
import { seriesColor } from '@/lib/utils';

export function PortfoliosView() {
  const router = useRouter();
  const hydrated = useHydrated();
  const portfolios = useWorkspace((s) => s.portfolios);
  const compareIds = useWorkspace((s) => s.compareIds);
  const loadPortfolio = useWorkspace((s) => s.loadPortfolio);
  const duplicatePortfolio = useWorkspace((s) => s.duplicatePortfolio);
  const renamePortfolio = useWorkspace((s) => s.renamePortfolio);
  const deletePortfolio = useWorkspace((s) => s.deletePortfolio);
  const toggleCompare = useWorkspace((s) => s.toggleCompare);
  const clearDraft = useWorkspace((s) => s.clearDraft);

  const [renaming, setRenaming] = React.useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = React.useState<{ id: string; name: string } | null>(null);

  function openInBuilder(id: string) {
    loadPortfolio(id);
    router.push('/backtest');
  }

  return (
    <>
      <PageHeader
        title="Portfolios"
        description="Saved allocations. Everything here lives in this browser — nothing is uploaded."
        actions={
          <>
            {compareIds.length > 1 && (
              <Button asChild variant="outline" size="sm">
                <Link href="/compare">
                  <GitCompare />
                  Compare {compareIds.length}
                </Link>
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => {
                clearDraft();
                router.push('/backtest');
              }}
            >
              <Plus />
              New portfolio
            </Button>
          </>
        }
      />

      <PageBody>
        {!hydrated ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-40 animate-pulse rounded-lg border border-border bg-card" />
            ))}
          </div>
        ) : portfolios.length === 0 ? (
          <EmptyState
            icon={Briefcase}
            title="No saved portfolios"
            description="Build an allocation in the backtester and press Save. It will appear here for rerunning, duplicating and comparing."
            action={
              <Button asChild>
                <Link href="/backtest">
                  <Plus />
                  Build a portfolio
                </Link>
              </Button>
            }
            className="py-20"
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {portfolios.map((p) => {
              const total = totalWeight(p.positions);
              const selected = compareIds.includes(p.id);
              return (
                <article
                  key={p.id}
                  className="flex flex-col rounded-lg border border-border bg-card p-4"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h2 className="truncate text-sm font-medium">{p.name}</h2>
                      <p className="mt-0.5 text-2xs text-muted-foreground">
                        {p.positions.length} holding{p.positions.length === 1 ? '' : 's'} · updated{' '}
                        {formatDate(p.updatedAt.slice(0, 10))}
                      </p>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${p.name}`}>
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => openInBuilder(p.id)}>
                          <Play />
                          Open and run
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => setRenaming({ id: p.id, name: p.name })}
                        >
                          <Pencil />
                          Rename
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => duplicatePortfolio(p.id)}>
                          <Copy />
                          Duplicate
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => toggleCompare(p.id)}>
                          <GitCompare />
                          {selected ? 'Remove from comparison' : 'Add to comparison'}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          destructive
                          onSelect={() => setDeleting({ id: p.id, name: p.name })}
                        >
                          <Trash2 />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                  <div className="mt-3 space-y-2">
                    <AllocationBar positions={p.positions} />
                    <div className="flex flex-wrap gap-x-2.5 gap-y-1 text-2xs text-muted-foreground">
                      {p.positions.slice(0, 6).map((pos, i) => (
                        <span key={pos.id} className="flex items-center gap-1">
                          <span
                            aria-hidden
                            className="h-1.5 w-1.5 rounded-sm"
                            style={{ backgroundColor: seriesColor(pos.symbol || pos.id, i) }}
                          />
                          <span className="numeric text-foreground">{pos.symbol || '—'}</span>
                          <span className="numeric">{pos.weight}%</span>
                        </span>
                      ))}
                      {p.positions.length > 6 && <span>+{p.positions.length - 6} more</span>}
                    </div>
                  </div>

                  <div className="mt-auto flex items-center gap-2 pt-4">
                    {Math.abs(total - 100) > 0.005 && (
                      <Badge variant="warning">{total}% allocated</Badge>
                    )}
                    {selected && <Badge variant="primary">In comparison</Badge>}
                    <div className="flex-1" />
                    <Button size="sm" variant="outline" onClick={() => openInBuilder(p.id)}>
                      <Play />
                      Run
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </PageBody>

      {/* Rename ------------------------------------------------------- */}
      <Dialog open={renaming != null} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename portfolio</DialogTitle>
          </DialogHeader>
          <form
            className="p-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (renaming?.name.trim()) renamePortfolio(renaming.id, renaming.name.trim());
              setRenaming(null);
            }}
          >
            <Input
              autoFocus
              value={renaming?.name ?? ''}
              onChange={(e) =>
                setRenaming((r) => (r ? { ...r, name: e.target.value } : r))
              }
              aria-label="Portfolio name"
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setRenaming(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!renaming?.name.trim()}>
                Save
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete ------------------------------------------------------- */}
      <Dialog open={deleting != null} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete this portfolio?</DialogTitle>
            <DialogDescription>
              <span className="font-medium text-foreground">{deleting?.name}</span> will be removed
              from this browser. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleting) deletePortfolio(deleting.id);
                setDeleting(null);
              }}
            >
              <Trash2 />
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
