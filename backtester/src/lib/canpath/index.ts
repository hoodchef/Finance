/**
 * CanPath: Canadian tax, benefit and account-allocation engine.
 *
 * Ported from CanPath's Python reference (github.com/hoodchef/CanPath), which
 * remains the source of truth. `tests/canpath-parity.test.ts` replays the
 * reference's generated fixtures against this port.
 *
 * THE ONE RULE: never invent a Canadian tax parameter. Everything comes from
 * `data/taxyear_2026.json`, which records provenance in `source_notes`.
 */
export * from './types';
export * from './tax';
export * from './benefits';
export * from './position';
export * from './allocate';
export * from './projection';
