import sys, copy, random, json
import numpy as np
sys.path.insert(0, "/home/claude/asts")
import stress, engine as E, inputs as I

out = {}
# ---------------- A3: full break suite on final build
res = []
for case in stress.CASES:
    m, f, w, fired, extra, pw, errs = stress.run_case(*case)
    res.append((case[0], m and f))
stress.patch()
out["break_suite"] = res
print("Break suite:", sum(r[1] for r in res), "/", len(res), "pass")

# ---------------- A2: random fuzz - perturb EVERY numeric scenario input +/-25% simultaneously
rng = random.Random(7)
INT_KEYS = {"t1_start", "t2_start", "fl_26", "fl_27", "fl_28", "fl_29", "fl_ss"}
fz = []
for trial in range(6):
    sc = {}
    for key, lab, unit, vals, src in stress.S0:
        if key in ("hdr", "prob"):
            continue
        new = []
        for v in vals:
            if key in INT_KEYS:
                new.append(int(v) if key.endswith("start") else max(5, int(round(v * rng.uniform(0.75, 1.25)))))
            else:
                new.append(v * rng.uniform(0.75, 1.25))
        sc[key] = tuple(new)
    g = {"g": rng.uniform(0.015, 0.03), "sat_life": rng.choice([6, 7, 8]), "loss_rate": rng.uniform(0, 0.12),
         "nol_open": rng.uniform(0, 2000), "rf": rng.uniform(0.035, 0.055)}
    m, f, w, fired, extra, pw, errs = stress.run_case(f"fuzz{trial}", g, sc, None)
    fz.append((trial, m, float(w), pw, len(fired)))
    print(f"fuzz {trial}: workbook==engine {m} (max diff {w:.1e}) PW=${pw:.2f} checks tripped={len(fired)}")
stress.patch()
out["fuzz"] = fz

# ---------------- A1: economic property tests (engine)
beta = E.market_stats()["beta_adj"]
def vps(**ov): return E.run(2, ov=ov, beta_hi=beta)["vps"]
props = []
def mono(key, grid, direction):
    v = [vps(**{key: x}) for x in grid]
    d = np.diff(v)
    ok = np.all(d >= -1e-9) if direction > 0 else np.all(d <= 1e-9)
    props.append((f"value {'rises' if direction>0 else 'falls'} with {key}", bool(ok), [round(x, 2) for x in v]))
mono("take_t1", [0.02, 0.05, 0.08, 0.1, 0.15, 0.25], +1)
mono("arpu_t1", [3, 4, 5, 6, 7], +1)
mono("take_t2", [0, 0.02, 0.04, 0.08], +1)
mono("unit_cost", [18, 22, 26, 30], -1)
mono("wacc_shift", [-0.02, 0, 0.02, 0.04], -1)
mono("opex_27", [350, 460, 600, 800], -1)
mono("spec_fee", [0, 100, 200], -1)
mono("cip_credit", [0, 0.5, 1.0], +1)
# continuity across the $72.07 conversion trigger of the 2.375% notes
ts = np.linspace(0.10, 0.14, 400)
vs = np.array([vps(take_t1=t) for t in ts])
jumps = np.max(np.abs(np.diff(vs)))
props.append(("per-share value continuous through conversion triggers (max step over 0.01pp take)", bool(jumps < 0.5),
              f"max step ${jumps:.3f}; range ${vs.min():.1f}-${vs.max():.1f}"))
# finiteness under extremes
ext = [vps(take_t1=0.6), vps(unit_cost=100), vps(wacc_shift=0.05), vps(g=0.0), vps(take_t1=0, take_t2=0)]
props.append(("finite, non-negative under extremes", bool(all(np.isfinite(ext)) and min(ext) >= 0), [round(x, 2) for x in ext]))
for p in props:
    print(("PASS " if p[1] else "FAIL ") + p[0], p[2])
out["properties"] = props
json.dump(out, open("/home/claude/asts/final_validation.json", "w"), default=str, indent=1)
