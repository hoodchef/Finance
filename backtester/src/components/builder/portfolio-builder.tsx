'use client';

import * as React from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { AlertTriangle, Check, LayoutGrid, Plus, Scale, Wallet } from 'lucide-react';
import { CASH_SYMBOL } from '@/lib/types';
import { PRESETS } from '@/lib/presets';
import { totalWeight, useWorkspace } from '@/store/workspace';
import { uid } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { InfoTip } from '@/components/ui/tooltip';
import { EmptyState } from '@/components/ui/empty-state';
import { AllocationBar } from './allocation-bar';
import { HoldingRow } from './holding-row';
import { TickerSearch } from './ticker-search';

export function PortfolioBuilder() {
  const draft = useWorkspace((s) => s.draft);
  const addPosition = useWorkspace((s) => s.addPosition);
  const updatePosition = useWorkspace((s) => s.updatePosition);
  const removePosition = useWorkspace((s) => s.removePosition);
  const reorderPositions = useWorkspace((s) => s.reorderPositions);
  const equalWeight = useWorkspace((s) => s.equalWeight);
  const normalizeWeights = useWorkspace((s) => s.normalizeWeights);
  const renameDraft = useWorkspace((s) => s.renameDraft);
  const loadPreset = useWorkspace((s) => s.loadPreset);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const total = totalWeight(draft.positions);
  const balanced = Math.abs(total - 100) < 0.005;
  const duplicates = findDuplicates(draft.positions.map((p) => p.symbol.toUpperCase()));
  const missingTickers = draft.positions.filter((p) => !p.symbol.trim()).length;

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = draft.positions.findIndex((p) => p.id === active.id);
    const to = draft.positions.findIndex((p) => p.id === over.id);
    if (from >= 0 && to >= 0) reorderPositions(from, to);
  }

  return (
    <Card>
      <CardHeader className="gap-3 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <CardTitle className="sr-only">Portfolio</CardTitle>
            <input
              aria-label="Portfolio name"
              value={draft.name}
              onChange={(e) => renameDraft(e.target.value)}
              placeholder="Name this portfolio"
              className="w-full truncate bg-transparent text-base font-semibold outline-none placeholder:font-normal placeholder:text-muted-foreground/60 focus-visible:underline focus-visible:decoration-primary focus-visible:underline-offset-4"
            />
            <p className="mt-0.5 text-2xs text-muted-foreground">
              {draft.positions.length} holding{draft.positions.length === 1 ? '' : 's'}
            </p>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <LayoutGrid />
                Presets
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-96 w-72 overflow-y-auto">
              <DropdownMenuLabel>Replace with a preset</DropdownMenuLabel>
              {PRESETS.map((p) => (
                <DropdownMenuItem
                  key={p.id}
                  onSelect={() => loadPreset(p.id)}
                  className="flex-col items-start gap-0.5 py-2"
                >
                  <span className="text-xs font-medium">{p.name}</span>
                  <span className="text-2xs text-muted-foreground">{p.description}</span>
                  <span className="numeric mt-0.5 text-2xs text-muted-foreground/80">
                    {p.holdings.map((h) => `${h.symbol} ${h.weight}%`).join(' · ')}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="space-y-1.5">
          <AllocationBar positions={draft.positions} />
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Total allocation
              <InfoTip label="About total allocation">
                Weights are the share of the portfolio each holding targets. They should sum to
                100%. If they do not, the engine scales them proportionally so they do, and the
                backtest reports what it actually used.
              </InfoTip>
            </span>
            <Badge variant={balanced ? 'positive' : 'warning'} className="numeric text-xs">
              {balanced ? <Check className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
              {total.toFixed(2)}%
            </Badge>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {draft.positions.length === 0 ? (
          <EmptyState
            icon={Wallet}
            title="No holdings yet"
            description="Search for a ticker below, or start from one of the presets."
          />
        ) : (
          <>
            <div className="hidden grid-cols-[auto_minmax(0,1fr)_4.75rem_4.75rem_auto] gap-2 px-1 sm:grid">
              <span className="w-5" />
              <span className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                Holding
              </span>
              <span className="text-right text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                Weight
              </span>
              <span className="flex items-center justify-end gap-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                Expense
                <InfoTip label="About expense ratio">
                  The fund&rsquo;s own annual charge, in percent per year — 0.03 means three basis
                  points. It is modelled as a daily reduction in net asset value, separately from
                  the portfolio-level management fee. Leave it blank if you do not want to model it;
                  nothing is assumed for you.
                </InfoTip>
              </span>
              <span className="w-7" />
            </div>

            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToVerticalAxis, restrictToParentElement]}
              onDragEnd={onDragEnd}
            >
              <SortableContext
                items={draft.positions.map((p) => p.id)}
                strategy={verticalListSortingStrategy}
              >
                <div className="relative space-y-0.5">
                  {draft.positions.map((position, i) => (
                    <HoldingRow
                      key={position.id}
                      position={position}
                      index={i}
                      onChange={(patch) => updatePosition(position.id, patch)}
                      onRemove={() => removePosition(position.id)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          </>
        )}

        {(duplicates.length > 0 || missingTickers > 0) && (
          <div className="flex items-start gap-2 rounded-md border border-[hsl(var(--warning))]/30 bg-[hsl(var(--warning))]/8 p-2.5 text-xs">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[hsl(var(--warning))]" />
            <div className="space-y-0.5">
              {duplicates.length > 0 && (
                <p>
                  <span className="numeric font-medium">{duplicates.join(', ')}</span> appear
                  more than once. Their weights are combined into a single position.
                </p>
              )}
              {missingTickers > 0 && (
                <p>
                  {missingTickers} holding{missingTickers === 1 ? ' has' : 's have'} no ticker and
                  will be ignored.
                </p>
              )}
            </div>
          </div>
        )}

        <div className="space-y-2 border-t border-border pt-3">
          <TickerSearch
            onSelect={(meta) =>
              addPosition({
                id: uid('pos'),
                symbol: meta.symbol,
                name: meta.name,
                weight: 0,
              })
            }
          />
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => addPosition()}>
              <Plus />
              Blank row
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => addPosition({ symbol: CASH_SYMBOL, name: 'Cash', weight: 0 })}
            >
              <Wallet />
              Cash sleeve
            </Button>
            <div className="flex-1" />
            <Button
              variant="secondary"
              size="sm"
              onClick={equalWeight}
              disabled={draft.positions.length === 0}
            >
              <Scale />
              Equal weight
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={normalizeWeights}
              disabled={balanced || total <= 0}
            >
              Normalise to 100%
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function findDuplicates(symbols: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const s of symbols) {
    if (!s) continue;
    if (seen.has(s)) dupes.add(s);
    seen.add(s);
  }
  return [...dupes];
}
