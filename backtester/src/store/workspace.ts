'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { BacktestConfig, CashflowLeg, Portfolio, Position } from '@/lib/types';
import { defaultConfig } from '@/lib/defaults';
import { PRESETS, type PortfolioPreset } from '@/lib/presets';
import { uid } from '@/lib/utils';
import { createRun, type SavedRun } from '@/lib/runs';
import type { BacktestResult } from '@/lib/backtest';

/**
 * All persisted user state lives here, in browser storage.
 *
 * Saved portfolios are user-owned documents, so they survive reloads without
 * requiring an account. `prisma/schema.prisma` defines the equivalent Postgres
 * model for when this moves server-side; `PortfolioRepository` in
 * `src/lib/storage.ts` is the seam that swap goes through.
 */

function emptyPortfolio(name = 'Untitled portfolio'): Portfolio {
  const now = new Date().toISOString();
  return { id: uid('pf'), name, positions: [], createdAt: now, updatedAt: now };
}

export function portfolioFromPreset(preset: PortfolioPreset): Portfolio {
  const now = new Date().toISOString();
  return {
    id: uid('pf'),
    name: preset.name,
    presetId: preset.id,
    createdAt: now,
    updatedAt: now,
    positions: preset.holdings.map((h) => ({
      id: uid('pos'),
      symbol: h.symbol,
      weight: h.weight,
    })),
  };
}

export interface WorkspaceState {
  /** False during the server-matched first paint; see `useHydrated`. */
  hydrated: boolean;
  setHydrated: () => void;
  portfolios: Portfolio[];
  draft: Portfolio;
  config: BacktestConfig;
  /**
   * Completed backtests, each holding an immutable snapshot of the portfolio
   * and config it ran against. Editing a portfolio never alters a saved run.
   */
  runs: SavedRun[];
  /** Run ids selected for comparison. Runs, not portfolios — see `lib/runs`. */
  compareRunIds: string[];

  setDraft: (p: Portfolio) => void;
  renameDraft: (name: string) => void;
  addPosition: (position?: Partial<Position>) => void;
  updatePosition: (id: string, patch: Partial<Position>) => void;
  removePosition: (id: string) => void;
  reorderPositions: (from: number, to: number) => void;
  equalWeight: () => void;
  normalizeWeights: () => void;
  clearDraft: () => void;
  loadPreset: (presetId: string) => void;

  saveDraft: (name?: string) => Portfolio;
  loadPortfolio: (id: string) => void;
  duplicatePortfolio: (id: string) => Portfolio | null;
  renamePortfolio: (id: string, name: string) => void;
  deletePortfolio: (id: string) => void;

  setConfig: (patch: Partial<BacktestConfig>) => void;
  addCashflow: () => void;
  updateCashflow: (id: string, patch: Partial<CashflowLeg>) => void;
  removeCashflow: (id: string) => void;
  setFees: (patch: Partial<BacktestConfig['fees']>) => void;
  resetConfig: () => void;
  addBenchmark: (symbol: string) => void;
  removeBenchmark: (symbol: string) => void;


  saveRun: (result: BacktestResult, label?: string) => SavedRun;
  renameRun: (runId: string, label: string) => void;
  deleteRun: (runId: string) => void;
  clearRuns: () => void;
  toggleCompareRun: (runId: string) => void;
  setCompareRunIds: (ids: string[]) => void;
}

const touch = (p: Portfolio): Portfolio => ({ ...p, updatedAt: new Date().toISOString() });

export const useWorkspace = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      hydrated: false,
      setHydrated: () => set({ hydrated: true }),
      portfolios: [],
      draft: portfolioFromPreset(PRESETS[2]), // 60/40 — a sensible first run.
      config: defaultConfig(),
      runs: [],
      compareRunIds: [],

      setDraft: (p) => set({ draft: touch(p) }),
      renameDraft: (name) => set((s) => ({ draft: touch({ ...s.draft, name }) })),

      addPosition: (position) =>
        set((s) => ({
          draft: touch({
            ...s.draft,
            positions: [
              ...s.draft.positions,
              { id: uid('pos'), symbol: '', weight: 0, ...position },
            ],
          }),
        })),

      updatePosition: (id, patch) =>
        set((s) => ({
          draft: touch({
            ...s.draft,
            positions: s.draft.positions.map((p) => (p.id === id ? { ...p, ...patch } : p)),
          }),
        })),

      removePosition: (id) =>
        set((s) => ({
          draft: touch({
            ...s.draft,
            positions: s.draft.positions.filter((p) => p.id !== id),
          }),
        })),

      reorderPositions: (from, to) =>
        set((s) => {
          const next = [...s.draft.positions];
          const [moved] = next.splice(from, 1);
          if (!moved) return s;
          next.splice(to, 0, moved);
          return { draft: touch({ ...s.draft, positions: next }) };
        }),

      equalWeight: () =>
        set((s) => {
          const n = s.draft.positions.length;
          if (!n) return s;
          // Distribute the rounding remainder rather than leaving a gap:
          // three holdings become 33.34 / 33.33 / 33.33, summing to exactly 100.
          const base = Math.floor((100 / n) * 100) / 100;
          const weights = new Array(n).fill(base);
          const remainder = Math.round((100 - base * n) * 100) / 100;
          const steps = Math.round(remainder * 100);
          for (let i = 0; i < steps; i++) weights[i % n] = Math.round((weights[i % n] + 0.01) * 100) / 100;
          return {
            draft: touch({
              ...s.draft,
              positions: s.draft.positions.map((p, i) => ({ ...p, weight: weights[i] })),
            }),
          };
        }),

      normalizeWeights: () =>
        set((s) => {
          const total = s.draft.positions.reduce((a, p) => a + (p.weight || 0), 0);
          if (total <= 0) return s;
          const scaled = s.draft.positions.map((p) => ({
            ...p,
            weight: Math.round(((p.weight || 0) / total) * 10000) / 100,
          }));
          // Push any rounding residue onto the largest holding so the total is
          // exactly 100 and the warning banner clears.
          const sum = scaled.reduce((a, p) => a + p.weight, 0);
          const residue = Math.round((100 - sum) * 100) / 100;
          if (residue !== 0 && scaled.length) {
            const biggest = scaled.reduce((a, b) => (b.weight > a.weight ? b : a));
            biggest.weight = Math.round((biggest.weight + residue) * 100) / 100;
          }
          return { draft: touch({ ...s.draft, positions: scaled }) };
        }),

      clearDraft: () => set({ draft: emptyPortfolio() }),

      loadPreset: (presetId) => {
        const preset = PRESETS.find((p) => p.id === presetId);
        if (preset) set({ draft: portfolioFromPreset(preset) });
      },

      saveDraft: (name) => {
        const state = get();
        const draft = touch({ ...state.draft, name: name ?? state.draft.name });
        const exists = state.portfolios.some((p) => p.id === draft.id);
        set({
          draft,
          portfolios: exists
            ? state.portfolios.map((p) => (p.id === draft.id ? draft : p))
            : [draft, ...state.portfolios],
        });
        return draft;
      },

      loadPortfolio: (id) => {
        const found = get().portfolios.find((p) => p.id === id);
        if (found) set({ draft: { ...found } });
      },

      duplicatePortfolio: (id) => {
        const found = get().portfolios.find((p) => p.id === id);
        if (!found) return null;
        const now = new Date().toISOString();
        const copy: Portfolio = {
          ...found,
          id: uid('pf'),
          name: `${found.name} (copy)`,
          createdAt: now,
          updatedAt: now,
          positions: found.positions.map((p) => ({ ...p, id: uid('pos') })),
        };
        set((s) => ({ portfolios: [copy, ...s.portfolios] }));
        return copy;
      },

      renamePortfolio: (id, name) =>
        set((s) => ({
          portfolios: s.portfolios.map((p) => (p.id === id ? touch({ ...p, name }) : p)),
          draft: s.draft.id === id ? touch({ ...s.draft, name }) : s.draft,
        })),

      deletePortfolio: (id) =>
        set((s) => ({
          portfolios: s.portfolios.filter((p) => p.id !== id),
        })),

      setConfig: (patch) => set((s) => ({ config: { ...s.config, ...patch } })),

      addCashflow: () =>
        set((s) => ({
          config: {
            ...s.config,
            cashflows: [
              ...(s.config.cashflows ?? []),
              {
                id: uid('cf'),
                amount: -1000,
                kind: 'fixed',
                frequency: 'monthly',
                offsetMonths: 0,
                durationMonths: null,
                annualGrowthPct: 0,
                adjustForInflation: false,
              },
            ],
          },
        })),

      updateCashflow: (id, patch) =>
        set((s) => ({
          config: {
            ...s.config,
            cashflows: (s.config.cashflows ?? []).map((c) =>
              c.id === id ? { ...c, ...patch } : c,
            ),
          },
        })),

      removeCashflow: (id) =>
        set((s) => ({
          config: {
            ...s.config,
            cashflows: (s.config.cashflows ?? []).filter((c) => c.id !== id),
          },
        })),
      setFees: (patch) => set((s) => ({ config: { ...s.config, fees: { ...s.config.fees, ...patch } } })),
      resetConfig: () => set({ config: defaultConfig() }),

      addBenchmark: (symbol) =>
        set((s) => {
          const sym = symbol.trim().toUpperCase();
          if (!sym || s.config.benchmarks.includes(sym)) return s;
          return { config: { ...s.config, benchmarks: [...s.config.benchmarks, sym] } };
        }),

      removeBenchmark: (symbol) =>
        set((s) => ({
          config: {
            ...s.config,
            benchmarks: s.config.benchmarks.filter((b) => b !== symbol),
          },
        })),


      saveRun: (result, label) => {
        const run = createRun(result, label);
        set((s) => ({
          // Newest first, and capped: a run list is a working set, not an
          // archive, and every entry costs persisted storage. Runs are NOT
          // auto-pinned for comparison — silently filling the comparison as a
          // side effect of iterating would be surprising.
          runs: [run, ...s.runs].slice(0, 50),
        }));
        return run;
      },

      renameRun: (runId, label) =>
        set((s) => ({
          runs: s.runs.map((r) => (r.runId === runId ? { ...r, label } : r)),
        })),

      deleteRun: (runId) =>
        set((s) => ({
          runs: s.runs.filter((r) => r.runId !== runId),
          compareRunIds: s.compareRunIds.filter((id) => id !== runId),
        })),

      clearRuns: () => set({ runs: [], compareRunIds: [] }),

      toggleCompareRun: (runId) =>
        set((s) => ({
          compareRunIds: s.compareRunIds.includes(runId)
            ? s.compareRunIds.filter((id) => id !== runId)
            : s.compareRunIds.length >= 6
              ? s.compareRunIds
              : [...s.compareRunIds, runId],
        })),

      setCompareRunIds: (ids) => set({ compareRunIds: ids.slice(0, 6) }),
    }),
    {
      name: 'backtester.workspace.v1',
      version: 2,
      /**
       * Persisted state predates every config field added since it was written,
       * so a stored config is merged over the current defaults rather than used
       * as-is. Without this, adding a field ships a crash to everyone who has
       * used the app before.
       */
      migrate: (persisted) => {
        const state = (persisted ?? {}) as Partial<WorkspaceState>;
        const d = defaultConfig();
        return {
          ...state,
          config: {
            ...d,
            ...(state.config ?? {}),
            fees: { ...d.fees, ...(state.config?.fees ?? {}) },
            riskFree: { ...d.riskFree, ...(state.config?.riskFree ?? {}) },
            inflation: { ...d.inflation, ...(state.config?.inflation ?? {}) },
            cashflows: state.config?.cashflows ?? [],
          },
        } as WorkspaceState;
      },
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        portfolios: s.portfolios,
        draft: s.draft,
        config: s.config,
        runs: s.runs,
        compareRunIds: s.compareRunIds,
      }),
      onRehydrateStorage: () => (state) => {
        // Flipped after rehydration so components can avoid rendering persisted
        // values during the server-matched first paint.
        state?.setHydrated();
      },
    },
  ),
);


export function totalWeight(positions: Position[]): number {
  return Math.round(positions.reduce((a, p) => a + (Number(p.weight) || 0), 0) * 100) / 100;
}
