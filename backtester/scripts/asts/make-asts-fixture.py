"""
Regenerates tests/fixtures/asts-reference.json.

The reference is the analyst's own package in `reference/asts/`, byte-for-byte
as delivered: `engine.py` (their independent implementation) and the workbook
`ASTS_Valuation_Model.xlsx` (their deliverable, with LibreOffice-cached values).
The two agree to ~1e-14 across all 2,560 cached cells, so the TypeScript port is
held to BOTH — the engine for every row and period, the workbook for everything
the engine does not compute (market statistics, checks, diagnostics, the live
sensitivity grid, the funding table).

Checking a port against arithmetic we also wrote would only prove the two
agree. Checking it against someone else's implementation — one that was itself
audited against a third (the Excel formulas) — proves it is right.

Cases are chosen so that each branch of the engine BINDS somewhere, not merely
runs. A fixture set drawn only from the delivered inputs would pass a port that
had deleted the straight-line tax schedule, the CIP pool cap, the NOL 80% limit,
the capped-call trigger, or the launch clamp, because none of those is the
binding constraint at the delivered point. Each case below names the branch it
exists to exercise.

    python3 scripts/asts/make-asts-fixture.py            # ~30 s
    python3 scripts/asts/make-asts-fixture.py --rerun-mc # + reproduce the MC (~3 min)

Requires numpy and scipy. No openpyxl: the workbook is read with the standard
library (scripts/asts/xlsx_reader.py).
"""
import copy, json, math, os, random, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
REF = os.path.join(ROOT, 'reference', 'asts')
sys.path[:0] = [REF, os.path.join(REF, 'data'), HERE]

import numpy as np                     # noqa: E402
import inputs as I                     # noqa: E402
import ibkr                            # noqa: E402
import engine as E                     # noqa: E402
import analytics as AN                 # noqa: E402
import xlsx_reader as XL               # noqa: E402

G0, S0 = copy.deepcopy(I.GLOBAL), copy.deepcopy(I.SCENARIO)
CAP0 = {k: copy.deepcopy(getattr(I, k)) for k in ('SHARES', 'CASH', 'DEBT', 'CONVERTS', 'AWARDS')}


def patch(glob=None, scen=None, capital=None):
    """Restore the delivered inputs, then apply a patch. Mirrors stress.patch."""
    I.GLOBAL[:] = copy.deepcopy(G0)
    I.SCENARIO[:] = copy.deepcopy(S0)
    for k, v in CAP0.items():
        getattr(I, k)[:] = copy.deepcopy(v)
    for k, v in (glob or {}).items():
        hit = [i for i, row in enumerate(I.GLOBAL) if row[0] == k]
        assert hit, f'unknown global {k}'
        row = I.GLOBAL[hit[0]]
        I.GLOBAL[hit[0]] = (row[0], row[1], row[2], v, row[4])
    for k, v in (scen or {}).items():
        hit = [i for i, row in enumerate(I.SCENARIO) if row[0] == k]
        assert hit, f'unknown scenario key {k}'
        row = I.SCENARIO[hit[0]]
        I.SCENARIO[hit[0]] = (row[0], row[1], row[2], tuple(v), row[4])
    for k, v in (capital or {}).items():
        getattr(I, k)[:] = copy.deepcopy(v)


ARRAYS = ['F', 'B', 'E', 'N', 'R', 'G', 'A', 'U', 'SC', 'C', 'cov1', 'cov2', 'ad1', 'ad2', 'subs1', 'subs2',
          'rev1', 'rev2', 'gov', 'prod', 'rev', 'cogs', 'var', 'lig', 'spec', 'opex', 'netx', 'sbc', 'ebitda',
          'ocx', 'ligpay', 'jleo', 'tdep', 'samort', 'ti', 'nol_e', 'tax', 'dnwc', 'cl', 'fcf', 'w', 'df',
          'Ecum', 'pv']
SCALARS = ['w_hi', 'w_t', 'ke_hi', 'fcf41', 'e41', 'maint', 'tv', 'pv_tv', 'ev', 'E0', 'Ef', 'Sf', 'vps',
           'cash', 'debt', 'conv_face']
# Branch cases carry the arrays a branch can move; the delivered run carries all.
BRANCH_ARRAYS = ['E', 'N', 'R', 'SC', 'C', 'rev1', 'rev2', 'rev', 'ebitda', 'sbc', 'ocx', 'spec', 'samort',
                 'tdep', 'ti', 'nol_e', 'tax', 'cl', 'fcf', 'w', 'df', 'pv']
BRIEF_ARRAYS = ['E', 'N', 'rev', 'ebitda', 'tax', 'fcf']


def f(x, sig=None):
    x = float(x)
    # 12 significant digits is 1e-12 relative: three orders tighter than the
    # 1e-9 the port is held to, at roughly half the bytes of a full repr.
    return float(f'{x:.12g}') if sig else x


def record(r, arrays, sig=None):
    out = {k: f(r[k], sig) for k in SCALARS}
    out['conv'] = [bool(x) for x in r['conv']]
    for k in arrays:
        out[k] = [f(x, sig) for x in r[k]]
    return out


def run_all(arrays=ARRAYS, sig=None, **kw):
    runs = [E.run(s, **kw) for s in range(4)]
    probs = [I.scen_value('prob', s) for s in range(4)]
    return {'scenarios': [record(r, arrays, sig) for r in runs],
            'pw': f(sum(q * r['vps'] for q, r in zip(probs, runs)))}


# ------------------------------------------------------------------ workbook
def workbook_values():
    S = XL.load(os.path.join(REF, 'ASTS_Valuation_Model.xlsx'))

    def by_label(sheet, label_col, value_col, label):
        ws = S[sheet]
        for ref, (v, _) in ws.items():
            if ref[0] == label_col and v == label:
                return ws[f'{value_col}{ref[1:]}'][0]
        raise KeyError(f'{sheet}: {label}')

    md = {}
    for r in range(7, 24):
        md[S['Market_Data'][f'I{r}'][0]] = S['Market_Data'][f'J{r}'][0]
    wacc = {S['WACC'][f'A{r}'][0]: S['WACC'][f'C{r}'][0] for r in range(5, 17)}
    cap = {
        'S0': by_label('Capital_Structure', 'A', 'B', 'Basic economic shares (mm) - S0'),
        'cash': by_label('Capital_Structure', 'A', 'D', 'Total cash & liquid assets'),
        'pfCash': S['Capital_Structure']['D21'][0],
        'debt': by_label('Capital_Structure', 'A', 'B', 'Total non-convertible debt'),
        'convFace': by_label('Capital_Structure', 'A', 'B', 'Total convertible face'),
        'debtCheck': S['Capital_Structure']['B36'][0],
        'mktCap': S['Capital_Structure']['B60'][0],
        'mktEv': S['Capital_Structure']['B61'][0],
        'dvMkt': S['Capital_Structure']['B62'][0],
    }
    cols = [chr(ord('D') + i) for i in range(15)]
    calc = []
    for s in range(4):
        ws = S[f'Calc_{I.SCEN[s]}']
        rows = {v[0]: int(k[1:]) for k, v in ws.items()
                if k[0] == 'A' and k[1:].isdigit() and isinstance(v[0], str)}

        def row(label):
            return [f(ws.get(f'{c}{rows[label]}', (0.0,))[0] or 0.0) for c in cols]

        def scal(label):
            v = ws[f'C{rows[label]}'][0]
            return v if isinstance(v, str) else f(v)
        calc.append({
            'growth': row('Revenue growth (annualised)'),
            'subsPerSat': row('Paying users per satellite in orbit (mm)'),
            'costs': row('Total operating costs'),
            'margin': row('EBITDA margin'),
            'cumFcf': row('Cumulative FCFF from 1-Jul-2026'),
            'netSC': row('Satellite capex, cash'),
            'pool': scal('CIP pre-funding pool (scalar, col C)'),
            'tvPct': scal('Terminal value % of EV'),
            'tvMult': scal('Implied terminal EV / EBITDA (2041)'),
            'pvExplicit': scal('Sum of PV of explicit FCFF'),
            'upside': scal('Upside / (downside) vs current price'),
            'fy26': scal('FY2026 revenue (H1 actual + H2 model)'),
            'minFcf': scal('Peak cumulative funding need (min cumulative FCFF)'),
            'maxSubsPerSat': scal('Max paying users per satellite (mm)'),
            'cagr': scal('Revenue CAGR 2036-2040'),
            'm40': scal('EBITDA margin 2040'),
            'rev30': scal('Revenue 2030'),
            'rev35': scal('Revenue 2035'),
        })
    vs = S['Valuation_Summary']
    summary = {
        'pw': vs['F11'][0], 'price': vs['F21'][0], 'pwUpside': vs['F22'][0], 'ke': vs['F23'][0],
        'er3': vs['F24'][0], 'er5': vs['F25'][0], 'mktEv': vs['F26'][0], 'baseEvOverMkt': vs['F27'][0],
    }
    sens = [[f(S['Sensitivity'][f'{c}{r}'][0]) for c in 'BCDEF'] for r in range(6, 11)]
    risk = S['Risk']
    funding = {
        'available': [f(risk[f'{c}18'][0]) for c in 'BCDE'],
        'peakNeed': [f(risk[f'{c}19'][0]) for c in 'BCDE'],
        'headroom': [f(risk[f'{c}20'][0]) for c in 'BCDE'],
        'sharpe': f(risk['B14'][0]),
    }
    ck = S['Checks']
    checks = []
    for r in range(5, 60):
        lab = ck.get(f'B{r}', (None,))[0]
        if not lab:
            continue
        v = ck[f'C{r}'][0]
        checks.append({'label': lab, 'value': v if isinstance(v, str) else f(v), 'pass': ck[f'D{r}'][0] is True})
    return {'marketData': md, 'wacc': wacc, 'capital': cap, 'calc': calc, 'summary': summary,
            'sensitivity': sens, 'funding': funding, 'checks': checks, 'status': ck['C3'][0]}


# ------------------------------------------------------------------ cases
BRANCH_CASES = [
    # name, globals, scenario, capital, run kwargs, the branch this exists to make bind
    ('bonus_off', {'bonus_dep': 0}, {}, None, {}, 'straight-line tax depreciation over the cohort window'),
    ('bonus_off_life5', {'bonus_dep': 0, 'sat_life': 5}, {}, None, {}, 'straight-line with a shorter window'),
    ('life6', {'sat_life': 6}, {}, None, {}, 'retirement indexing, earlier cohort'),
    ('life8', {'sat_life': 8}, {}, None, {}, 'retirement indexing, later cohort'),
    ('ligado_2026', {'ligado_year': 2026}, {}, None, {}, 'spectrum payment, fees and amortisation in the stub'),
    ('ligado_2030', {'ligado_year': 2030}, {}, None, {}, 'spectrum timing late'),
    ('fleet_shrink', {}, {'fl_ss': (40, 60, 60, 80)}, None, {}, 'launch clamp N = max(0, ...) binds'),
    ('cip_none', {}, {'cip_credit': (0, 0, 0, 0)}, None, {}, 'empty CIP pool'),
    ('cip_full', {}, {'cip_credit': (1, 1, 1, 1)}, None, {}, 'CIP pool exhausts later'),
    ('nol_zero', {'nol_open': 0}, {}, None, {}, 'no opening NOL; losses build the pool'),
    ('nol_huge', {'nol_open': 50000}, {}, None, {}, 'NOL never exhausts: the 80% cap binds every year'),
    ('val_after_mid', {'val_date': 2026.80}, {}, None, {}, 'valuation date after the stub mid-point'),
    ('zero_adoption', {}, {'take_t1': (0, 0, 0, 0), 'take_t2': (0, 0, 0, 0)}, None, {}, 'no service revenue'),
    ('t_2040', {}, {'t1_start': (2040,) * 4, 't2_start': (2040,) * 4}, None, {}, 'adoption only in the last period'),
    ('bull_converts', {}, {'take_t1': (0.03, 0.06, 0.10, 0.30)}, None, {}, 'capped 2034 notes convert: K = cap'),
    ('px_end_2026', {'px_end': 2026}, {}, None, {}, 'repricing clip with an upper bound below the lower'),
    ('fade_long', {'wacc_fade_start': 2028, 'wacc_fade_end': 2040}, {}, None, {}, 'long WACC fade'),
    ('fade_none', {'wacc_fade_start': 2033, 'wacc_fade_end': 2033}, {}, None, {}, 'single-year fade'),
    ('loss_high', {'loss_rate': 0.30}, {}, None, {}, 'launch-loss gross-up'),
    ('unit_cost_extreme', {}, {'unit_cost': (100, 100, 100, 100)}, None, {}, 'negative equity: limited-liability floor'),
    ('g_zero', {'g': 0.0}, {}, None, {}, 'zero terminal growth'),
    ('wacc_shift_up', {'wacc_shift': 0.02}, {}, None, {}, 'WACC lever'),
    ('beta_high', {}, {}, None, {'beta_hi': 2.0}, 'beta override'),
    ('delay1', {}, {}, None, {'delay': 1}, 'deployment and service delay 1 yr'),
    ('delay2', {}, {}, None, {'delay': 2}, 'deployment and service delay 2 yrs'),
    ('jleo_all', {}, {'jleo': (300, 300, 300, 300)}, None, {}, 'J-LEO inflow in every scenario'),
    ('cl_long', {'cl_unwind_start': 2026, 'cl_unwind_yrs': 10}, {}, None, {}, 'contract-liability unwind from the stub'),
    ('sbc_floor_binds', {}, {'sbc_floor': (0.2, 0.2, 0.2, 0.2)}, None, {}, 'SBC floor at % of revenue binds'),
    ('ocx_floor_binds', {}, {'ocx_floor': (5000, 5000, 5000, 5000)}, None, {}, 'other-capex floor binds'),
    ('coverage_saturates', {'s0_t1': 2, 'sf_t1': 5, 's0_t2': 5, 'sf_t2': 8}, {}, None, {}, 'coverage clip at 1'),
    ('no_awards', {}, {}, {'AWARDS': []}, {}, 'dilution table without awards'),
    ('extra_capped_convert', {}, {}, {'CONVERTS': CAP0['CONVERTS'] + [('test capped', 500.0, 40.0, 50.0, 'test')]},
     {}, 'a capped convert whose cap is below Base value'),
    ('cash_excluded', {}, {}, {'CASH': [(a, b, 0 if 'Restricted' in a else c, d) for a, b, c, d in CAP0['CASH']]},
     {}, 'include flags respected'),
]


def branch_cases():
    out = []
    for name, g, sc, cap, kw, why in BRANCH_CASES:
        patch(g, sc, cap)
        res = run_all(BRANCH_ARRAYS, 12, **kw)
        out.append({'name': name, 'why': why, 'global': g, 'scenario': {k: list(v) for k, v in sc.items()},
                    'capital': {k: [list(x) for x in v] for k, v in (cap or {}).items()}, 'run': kw, **res})
    patch()
    return out


def fuzz_cases(n=20, seed=20260911):
    """Every numeric scenario input perturbed +/-25% at once (final_validation.py's scheme, more trials)."""
    rng = random.Random(seed)
    INT_KEYS = {'t1_start', 't2_start', 'fl_26', 'fl_27', 'fl_28', 'fl_29', 'fl_ss'}
    out = []
    for trial in range(n):
        sc = {}
        for key, lab, unit, vals, src in S0:
            if key in ('hdr', 'prob'):
                continue
            new = []
            for v in vals:
                if key in INT_KEYS:
                    new.append(int(v) if key.endswith('start') else max(5, int(round(v * rng.uniform(0.75, 1.25)))))
                else:
                    new.append(v * rng.uniform(0.75, 1.25))
            sc[key] = tuple(new)
        g = {'g': rng.uniform(0.015, 0.03), 'sat_life': rng.choice([6, 7, 8]), 'loss_rate': rng.uniform(0, 0.12),
             'nol_open': rng.uniform(0, 2000), 'rf': rng.uniform(0.035, 0.055),
             'bonus_dep': rng.choice([0, 1]), 'ligado_year': rng.choice([2026, 2027, 2028])}
        kw = {'delay': rng.choice([0, 0, 1, 2])}
        patch(g, sc)
        res = run_all(BRIEF_ARRAYS, 12, **kw)
        out.append({'name': f'fuzz{trial}', 'global': g, 'scenario': {k: list(v) for k, v in sc.items()},
                    'capital': {}, 'run': kw, **res})
    patch()
    return out


# ------------------------------------------------------------------ analytics
def analytics_reference(rerun_mc):
    stamped = json.load(open(os.path.join(REF, 'analytics.json')))
    base_v, torn = AN.tornado()
    g1 = AN.grid('take_t1', [0.04, 0.06, 0.08, 0.10, 0.12, 0.15, 0.20], 'arpu_t1', [3.5, 4.0, 4.5, 5.0, 5.5, 6.0, 6.5])
    g2 = AN.grid('unit_cost', [20, 22, 24, 26, 28], 'cip_credit', [0.25, 0.4, 0.5, 0.6, 0.75])
    rev = AN.reverse_dcf()
    ct = AN.capex_timing_test()
    # Recomputed deterministic analytics must equal what the analyst stamped.
    assert abs(base_v - stamped['base_v']) < 1e-9
    for a, b in zip(torn, stamped['tornado']):
        assert a[0] == b[0] and all(abs(float(x) - float(y)) < 1e-9 for x, y in zip(a[2:], b[2:])), (a, b)
    assert np.allclose(g1, stamped['g1'], rtol=0, atol=1e-9) and np.allclose(g2, stamped['g2'], rtol=0, atol=1e-9)
    assert np.allclose(rev, stamped['rev'], rtol=0, atol=1e-9), (rev, stamped['rev'])
    assert np.allclose(ct, stamped['capex_timing'], rtol=0, atol=1e-9)

    # Copula and marginal transforms, pinned exactly. The RNG stream cannot be
    # reproduced outside numpy (PCG64 + ziggurat), so the simulation itself is
    # checked statistically; everything downstream of the uniforms is exact.
    C = AN.corr_matrix()
    L = np.linalg.cholesky(C)
    u_rows = [[0.5] * 14, [0.1] * 14, [0.9] * 14,
              [0.03, 0.97, 0.2, 0.8, 0.35, 0.62, 0.11, 0.44, 0.73, 0.28, 0.51, 0.66, 0.05, 0.95],
              [0.99, 0.01, 0.6, 0.4, 0.9, 0.1, 0.75, 0.25, 0.3, 0.7, 0.45, 0.55, 0.85, 0.15]]
    draws = []
    for u in u_rows:
        x = {nm: float(AN.marginal(np.array([u[i]]), AN.DISTS[i][1], AN.DISTS[i][2])[0])
             for i, nm in enumerate(AN.NAMES)}
        ov, d = AN.draw_to_override(x)
        r = E.run(AN.BASE, ov=ov, beta_hi=AN.BETA, delay=d)
        draws.append({'u': u, 'x': x, 'delay': d, 'vps': f(r['vps']), 'ev': f(r['ev'])})
    mc = {k: stamped[k] for k in ('n', 'seed', 'mean', 'se', 'pct', 'p_above', 'p_zero', 'mean_nondistress', 'hist',
                                   'eig_min', 'conv')}
    if rerun_mc:
        res = AN.monte_carlo()
        v = res['vals']
        assert abs(float(v.mean()) - stamped['mean']) < 1e-9, 'MC does not reproduce the stamped mean'
        mc['reproduced'] = True
    return {
        'tornado': [{'key': t[0], 'desc': t[1], 'lo': f(t[2]), 'vLo': f(t[3]), 'hi': f(t[4]), 'vHi': f(t[5]),
                     'swing': f(t[6])} for t in torn],
        'baseV': f(base_v), 'g1': g1, 'g2': g2,
        'reverse': {'take': f(rev[0]), 'shift': f(rev[1]), 'wHi': f(rev[2]), 'wT': f(rev[3]), 'mult': f(rev[4])},
        'capexTiming': {'base': f(ct[0]), 'shifted': f(ct[1]), 'dpv': f(ct[2])},
        'corr': C.tolist(), 'cholesky': L.tolist(), 'eigMin': f(np.linalg.eigvalsh(C).min()),
        'draws': draws, 'mc': mc, 'beta': f(AN.BETA), 'price': f(AN.PRICE),
    }


def properties():
    """final_validation.py's economic property grids, recomputed on the engine."""
    beta = E.market_stats()['beta_adj']

    def vps(**ov):
        return f(E.run(2, ov=ov, beta_hi=beta)['vps'])
    grids = {'take_t1': [0.02, 0.05, 0.08, 0.1, 0.15, 0.25], 'arpu_t1': [3, 4, 5, 6, 7], 'take_t2': [0, 0.02, 0.04, 0.08],
             'unit_cost': [18, 22, 26, 30], 'wacc_shift': [-0.02, 0, 0.02, 0.04], 'opex_27': [350, 460, 600, 800],
             'spec_fee': [0, 100, 200], 'cip_credit': [0, 0.5, 1.0]}
    return {k: {'x': xs, 'vps': [vps(**{k: x}) for x in xs]} for k, xs in grids.items()}


if __name__ == '__main__':
    rerun = '--rerun-mc' in sys.argv
    patch()
    ms = E.market_stats()
    out = {
        'meta': {
            'source': 'reference/asts (analyst package, unmodified): engine.py + ASTS_Valuation_Model.xlsx',
            'generator': 'scripts/asts/make-asts-fixture.py',
            'numpy': np.__version__,
            'periods': I.PERIODS, 'years': I.YEARS, 'lens': I.LENS, 'starts': I.STARTS,
        },
        'market': {'betaRaw': f(ms['beta_raw']), 'betaAdj': f(ms['beta_adj']), 'vol': f(ms['vol']),
                   'price': f(ms['price']), 'time': ibkr.TIME, 'asts': ibkr.ASTS, 'spy': ibkr.SPY},
        'delivered': run_all(),
        'workbook': workbook_values(),
        'branches': branch_cases(),
        'fuzz': fuzz_cases(),
        'analytics': analytics_reference(rerun),
        'properties': properties(),
    }
    # Cross-check: engine and workbook agree on the headline before anything is written.
    assert abs(out['delivered']['pw'] - out['workbook']['summary']['pw']) < 1e-9
    assert out['workbook']['status'] == 'ALL PASS'
    path = os.path.join(ROOT, 'tests', 'fixtures', 'asts-reference.json')
    with open(path, 'w') as fh:
        json.dump(out, fh, separators=(',', ':'))
    print(f'wrote {path}: {os.path.getsize(path):,} bytes; {len(out["branches"])} branch cases, '
          f'{len(out["fuzz"])} fuzz cases, {len(out["workbook"]["checks"])} checks')
