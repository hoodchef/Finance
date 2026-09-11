import sys, copy, importlib, subprocess, json, time
sys.path.insert(0, "/home/claude/asts")
import inputs as I
import engine as E

G0, S0 = copy.deepcopy(I.GLOBAL), copy.deepcopy(I.SCENARIO)


def patch(glob=None, scen=None):
    I.GLOBAL[:] = copy.deepcopy(G0); I.SCENARIO[:] = copy.deepcopy(S0)
    for k, v in (glob or {}).items():
        for i, row in enumerate(I.GLOBAL):
            if row[0] == k:
                I.GLOBAL[i] = (row[0], row[1], row[2], v, row[4])
    for k, v in (scen or {}).items():
        for i, row in enumerate(I.SCENARIO):
            if row[0] == k:
                I.SCENARIO[i] = (row[0], row[1], row[2], tuple(v), row[4])


CASES = [
    ("probabilities sum to 90%", {}, {"prob": (0.15, 0.25, 0.30, 0.20)}, ["probabilities"]),
    ("g = 6% (> Rf)", {"g": 0.06}, {}, ["below risk-free", "exceeds g"]),
    ("WACC lever +1%", {"wacc_shift": 0.01}, {}, ["lever is zero"]),
    ("bonus depreciation OFF", {"bonus_dep": 0}, {}, None),
    ("satellite life 5 yrs", {"sat_life": 5}, {}, None),
    ("zero commercial adoption", {}, {"take_t1": (0, 0, 0, 0), "take_t2": (0, 0, 0, 0)}, None),
    ("Bull take 40% (capacity breach)", {}, {"take_t1": (0.03, 0.06, 0.10, 0.40)}, ["users per satellite"]),
    ("no launch losses", {"loss_rate": 0.0}, {}, None),
    ("Ligado closes 2026", {"ligado_year": 2026}, {}, None),
    ("Tier-1 start 2040", {}, {"t1_start": (2040, 2040, 2040, 2040)}, None),
    ("fleet shrinks after 2029", {}, {"fl_ss": (45, 60, 60, 80)}, None),
    ("valuation date after stub midpoint", {"val_date": 2026.80}, {}, None),
]


def run_case(name, g, sc, expect):
    patch(g, sc)
    import build_xlsx; importlib.reload(build_xlsx)
    path = "/home/claude/asts/stress.xlsx"; build_xlsx.wb.save(path)
    out = subprocess.run(["python3", "/mnt/skills/public/xlsx/scripts/recalc.py", path, "120"], capture_output=True, text=True)
    rc = json.loads(out.stdout)
    import audit; importlib.reload(audit)
    worst, fails, failed, pw = audit.audit(path, verbose=False)
    fired = [f[0] for f in failed]
    ok_match = worst < 1e-9 and not fails and rc.get("total_errors", 1) == 0
    if expect:
        ok_fire = all(any(e in f for f in fired) for e in expect)
    else:
        ok_fire = True
    extra = [f for f in fired if not expect or not any(e in f for e in expect)]
    return ok_match, ok_fire, worst, fired, extra, pw, rc.get("total_errors")


if __name__ == "__main__":
    res = []
    for name, g, sc, expect in CASES:
        t = time.time()
        m, f, w, fired, extra, pw, errs = run_case(name, g, sc, expect)
        print(f"[{'PASS' if m and f else 'FAIL'}] {name:38s} match={m} (diff {w:.1e}, xl errors {errs}) "
              f"expected-check-fired={f} PW=${pw:.2f} | other checks tripped: {extra} ({time.time()-t:.0f}s)")
        res.append((name, m, f, w, fired, extra, pw))
    patch()
    json.dump([(r[0], r[1], r[2], r[3], r[4], r[5], r[6]) for r in res], open("/home/claude/asts/stress_results.json", "w"))
