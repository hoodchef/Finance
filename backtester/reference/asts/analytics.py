import sys, math, json
import numpy as np
from scipy import stats, optimize
sys.path.insert(0, "/home/claude/asts")
import engine as E
import inputs as I

SEED = 20260910
N = 20000
ms = E.market_stats(); PRICE = ms["price"]; BETA = ms["beta_adj"]
BASE = 2
bp = E.base_params(BASE)

# ---------------------------------------------------------------- MC specification
# name, kind, params, applies-as
DISTS = [
    ("take_t1", "lognormal", (0.10, 0.55), "Tier-1 peak take rate: median 10%, sigma(log) 0.55"),
    ("take_t2", "lognormal", (0.03, 0.70), "Tier-2 peak take rate: median 3%, sigma(log) 0.70"),
    ("arpu_t1", "tri", (3.50, 5.00, 6.50), "Tier-1 ARPU $/mo: triangular 3.50 / 5.00 / 6.50"),
    ("arpu_t2", "tri", (0.40, 0.75, 1.10), "Tier-2 ARPU $/mo: triangular 0.40 / 0.75 / 1.10"),
    ("unit_cost", "tri", (20.0, 22.0, 27.0), "Unit cost $mm: triangular 20 / 22 / 27 (overrun skew)"),
    ("delay", "discrete", ((0, 1, 2), (0.45, 0.35, 0.20)), "Deployment & service delay (yrs): 0/1/2 @ 45/35/20%"),
    ("cip_credit", "uniform", (0.25, 0.75), "CIP pre-funding share: uniform 25-75%"),
    ("opex_mult", "lognormal", (1.0, 0.15), "Fixed-opex level multiplier: median 1.0, sigma 0.15"),
    ("var_cost", "uniform", (0.09, 0.16), "Service variable cost %: uniform 9-16%"),
    ("gov_mult", "lognormal", (1.0, 0.35), "Government revenue multiplier: median 1.0, sigma 0.35"),
    ("wacc_shift", "normal", (0.0, 0.01), "WACC shift: normal(0, 1.0pp)"),
    ("g", "tri", (0.015, 0.025, 0.030), "Terminal growth: triangular 1.5 / 2.5 / 3.0%"),
    ("px_g", "uniform", (-0.03, 0.0), "ARPU repricing p.a. to 2032: uniform -3% to 0%"),
    ("sat_life", "discrete", ((6, 7, 8), (0.25, 0.50, 0.25)), "Satellite life (yrs): 6/7/8 @ 25/50/25%"),
]
NAMES = [d[0] for d in DISTS]
CORR_PAIRS = {("take_t1", "take_t2"): 0.6, ("take_t1", "arpu_t1"): -0.3, ("take_t2", "arpu_t2"): -0.3,
              ("unit_cost", "delay"): 0.4, ("delay", "take_t1"): -0.2}
P_DISTRESS = I.scen_value("prob", 0)


def corr_matrix():
    C = np.eye(len(NAMES))
    for (a, b), rho in CORR_PAIRS.items():
        i, j = NAMES.index(a), NAMES.index(b); C[i, j] = C[j, i] = rho
    return C


def marginal(u, kind, prm):
    if kind == "lognormal":
        return prm[0] * np.exp(prm[1] * stats.norm.ppf(u))
    if kind == "tri":
        a, m, b = prm; c = (m - a) / (b - a)
        return stats.triang.ppf(u, c, loc=a, scale=b - a)
    if kind == "uniform":
        return prm[0] + u * (prm[1] - prm[0])
    if kind == "normal":
        return prm[0] + prm[1] * stats.norm.ppf(u)
    if kind == "discrete":
        vals, pr = prm; cum = np.cumsum(pr)
        return np.array(vals)[np.searchsorted(cum, u, side="right").clip(0, len(vals) - 1)]


def draw_to_override(x):
    ov = {k: x[k] for k in ("take_t1", "take_t2", "arpu_t1", "arpu_t2", "unit_cost", "cip_credit", "var_cost",
                            "wacc_shift", "g", "px_g", "sat_life")}
    ov["opex_26"] = bp["opex_26"] * x["opex_mult"]; ov["opex_27"] = bp["opex_27"] * x["opex_mult"]
    for k in ("gov_26", "gov_27", "gov_28", "gov_29", "gov_30"):
        ov[k] = bp[k] * x["gov_mult"]
    return ov, int(x["delay"])


def monte_carlo(n=N, seed=SEED):
    rng = np.random.default_rng(seed)
    C = corr_matrix()
    eig = np.linalg.eigvalsh(C)
    Lc = np.linalg.cholesky(C)
    Z = rng.standard_normal((n, len(NAMES))) @ Lc.T
    U = stats.norm.cdf(Z)
    X = {nm: marginal(U[:, i], DISTS[i][1], DISTS[i][2]) for i, nm in enumerate(NAMES)}
    distress = rng.random(n) < P_DISTRESS
    v_distress = E.run(0)["vps"]
    vals = np.zeros(n); evs = np.zeros(n)
    for t in range(n):
        if distress[t]:
            vals[t] = v_distress; continue
        x = {k: X[k][t] for k in NAMES}
        ov, d = draw_to_override(x)
        r = E.run(BASE, ov=ov, beta_hi=BETA, delay=d)
        vals[t] = r["vps"]; evs[t] = r["ev"]
    return dict(vals=vals, X=X, distress=distress, eig_min=float(eig.min()), evs=evs)


def tornado():
    base_v = E.run(BASE, beta_hi=BETA)["vps"]
    out = []
    for i, (nm, kind, prm, desc) in enumerate(DISTS):
        lo_hi = []
        for q in (0.10, 0.90):
            v = float(marginal(np.array([q]), kind, prm)[0])
            x = {k: None for k in NAMES}
            ov, d = {}, 0
            if nm == "delay":
                d = int(v)
            elif nm == "opex_mult":
                ov = {"opex_26": bp["opex_26"] * v, "opex_27": bp["opex_27"] * v}
            elif nm == "gov_mult":
                ov = {k: bp[k] * v for k in ("gov_26", "gov_27", "gov_28", "gov_29", "gov_30")}
            else:
                ov = {nm: v}
            lo_hi.append((v, E.run(BASE, ov=ov, beta_hi=BETA, delay=d)["vps"]))
        out.append((nm, desc, lo_hi[0][0], lo_hi[0][1], lo_hi[1][0], lo_hi[1][1], abs(lo_hi[1][1] - lo_hi[0][1])))
    out.sort(key=lambda r: -r[6])
    return base_v, out


def grid(k1, v1, k2, v2):
    return [[E.run(BASE, ov={k1: a, k2: b}, beta_hi=BETA)["vps"] for b in v2] for a in v1]


def reverse_dcf():
    f = lambda t: E.run(BASE, ov={"take_t1": t}, beta_hi=BETA)["vps"] - PRICE
    take = optimize.brentq(f, 0.001, 0.6)
    fw = lambda s: E.run(BASE, ov={"wacc_shift": s}, beta_hi=BETA)["vps"] - PRICE
    shift = optimize.brentq(fw, -0.04, 0.04)
    r = E.run(BASE, ov={"wacc_shift": shift}, beta_hi=BETA)
    # prob-weighted: scale all scenarios' Tier-1 take by common multiplier
    def fp(m):
        tot = 0
        for s in range(4):
            tot += I.scen_value("prob", s) * E.run(s, ov={"take_t1": I.scen_value("take_t1", s) * m}, beta_hi=BETA)["vps"]
        return tot - PRICE
    mult = optimize.brentq(fp, 0.2, 5.0)
    return take, shift, r["w_hi"], r["w_t"], mult


def capex_timing_test():
    """A3-03: capex modelled at launch. Test: pay satellite capex one period earlier."""
    r = E.run(BASE, beta_hi=BETA)
    net = r["SC"] - r["C"]
    shifted = np.concatenate([net[1:], [net[-1]]])  # each period pays next period's launches
    delta_fcf = -(shifted - net)
    dpv = (delta_fcf * r["df"]).sum()
    S0, cash, debt, cf, inst = E.capital_structure()
    v2, *_ = E.per_share(r["E0"] + dpv, S0, inst)
    return r["vps"], v2, dpv


if __name__ == "__main__":
    import time; t = time.time()
    mc = monte_carlo()
    v = mc["vals"]
    pct = {q: float(np.percentile(v, q)) for q in (5, 10, 25, 50, 75, 90, 95)}
    se = v.std(ddof=1) / math.sqrt(len(v))
    conv = {k: float(v[:k].mean()) for k in (2500, 5000, 10000, 20000)}
    ke = E.run(BASE, beta_hi=BETA)["ke_hi"]
    er3 = (np.maximum(v, 1e-9) * (1 + ke) ** 3 / PRICE) ** (1 / 3) - 1
    base_v, torn = tornado()
    g1 = grid("take_t1", [0.04, 0.06, 0.08, 0.10, 0.12, 0.15, 0.20], "arpu_t1", [3.5, 4.0, 4.5, 5.0, 5.5, 6.0, 6.5])
    g2 = grid("unit_cost", [20, 22, 24, 26, 28], "cip_credit", [0.25, 0.4, 0.5, 0.6, 0.75])
    rev = reverse_dcf()
    ct = capex_timing_test()
    pw, sv = E.prob_weighted(beta_hi=BETA)
    res = dict(n=len(v), seed=SEED, mean=float(v.mean()), se=float(se), pct=pct, conv=conv,
               p_above=float((v > PRICE).mean()), p_zero=float((v <= 0.005).mean()), eig_min=mc["eig_min"],
               er3=dict(mean=float(np.mean(er3[v > 0])) if (v > 0).any() else None,
                        p10=float(np.percentile(er3, 10)), p50=float(np.percentile(er3, 50)), p90=float(np.percentile(er3, 90))),
               hist=np.histogram(np.minimum(v, 300), bins=np.arange(0, 310, 10))[0].tolist(),
               base_v=base_v, tornado=torn, g1=g1, g2=g2, rev=rev, capex_timing=ct, pw=pw, scen=sv, price=PRICE, ke=ke,
               dists=[(d[0], d[3]) for d in DISTS], corr=[(a, b, r) for (a, b), r in CORR_PAIRS.items()],
               p_distress=P_DISTRESS, mean_nondistress=float(v[~mc["distress"]].mean()))
    json.dump(res, open("/home/claude/asts/analytics.json", "w"), indent=1, default=float)
    print(json.dumps({k: res[k] for k in ("mean", "se", "pct", "conv", "p_above", "p_zero", "eig_min", "er3", "rev",
                                         "capex_timing", "pw", "mean_nondistress")}, indent=1, default=float))
    print("tornado:"); [print(" ", r[0], round(r[3], 1), round(r[5], 1)) for r in torn]
    print(f"{time.time()-t:.0f}s")
