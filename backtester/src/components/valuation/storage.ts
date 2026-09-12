import { deliveredInputs, GLOBAL_ROWS, SCENARIO_ROWS, type AstsInputs } from '@/lib/valuation/asts/inputs';

/**
 * The reader's edits to the model, kept per browser.
 *
 * Shared by the Valuation page and the Desk card so both show the same model:
 * a card quoting the delivered value beside a page the reader has edited would
 * be two answers to one question.
 */
export const STORE_KEY = 'valuation.asts.v1';

/** Stored edits are discarded if the delivered model they were made against has changed. */
export const FINGERPRINT = (() => {
  const s = JSON.stringify(deliveredInputs());
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `${s.length}:${h}`;
})();

export function validInputs(x: unknown): x is AstsInputs {
  if (!x || typeof x !== 'object') return false;
  const v = x as AstsInputs;
  const d = deliveredInputs();
  return (
    GLOBAL_ROWS.every((r) => Number.isFinite(v.global?.[r.key])) &&
    SCENARIO_ROWS.every(
      (r) => Array.isArray(v.scenario?.[r.key]) && v.scenario[r.key].length === 4 && v.scenario[r.key].every(Number.isFinite),
    ) &&
    v.shares?.length === d.shares.length && v.cash?.length === d.cash.length && v.debt?.length === d.debt.length &&
    v.converts?.length === d.converts.length && v.awards?.length === d.awards.length
  );
}

export interface Stored<O> {
  inputs: AstsInputs;
  options: Partial<O>;
}

export function loadStored<O>(): Stored<O> | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (s.fingerprint !== FINGERPRINT || !validInputs(s.inputs)) return null;
    return { inputs: s.inputs, options: s.options ?? {} };
  } catch {
    return null;
  }
}

export function saveStored<O>(inputs: AstsInputs, options: O): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ fingerprint: FINGERPRINT, inputs, options }));
  } catch {
    /* storage unavailable: edits last for the session */
  }
}
