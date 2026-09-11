"""Reference implementation of the ASTS model (Agent 2).

Written independently of the Excel formula generator so that Agent 3 can audit
the workbook by comparing LibreOffice-recalculated values against this engine.
Also used for Monte Carlo, reverse-DCF and tornado (things Excel can't do live).
"""
import math
import sys
import numpy as np

sys.path.insert(0, "/home/claude/asts")
sys.path.insert(0, "/home/claude/asts/data")
import inputs as I
import ibkr

NP = len(I.PERIODS)


def market_stats():
    a = np.array(ibkr.ASTS, float)
    s = np.array(ibkr.SPY, float)
    ra = a[1:] / a[:-1] - 1
    rs = s[1:] / s[:-1] - 1
    ra, rs = ra[:-1], rs[:-1]              # drop final partial-week return (R-02)
    cov = np.cov(rs, ra, ddof=1)
    beta = cov[0, 1] / cov[0, 0]
    return dict(beta_raw=beta, beta_adj=I.glob("blume_w") * beta + (1 - I.glob("blume_w")),
                vol=ra.std(ddof=1) * math.sqrt(52), price=float(a[-1]))


def base_params(s):
    p = {row[0]: row[3] for row in I.GLOBAL if row[0] != "hdr"}
    for row in I.SCENARIO:
        if row[0] != "hdr":
            p[row[0]] = row[3][s]
    return p


def capital_structure():
    S0 = sum(r[1] for r in I.SHARES) / 1e6
    cash = sum(r[1] for r in I.CASH if r[2] == 1)
    debt = sum(r[1] for r in I.DEBT)
    conv_face = sum(r[1] for r in I.CONVERTS)
    inst = []  # (K, n_mm, D)
    for lab, face, cp, cap, _ in I.CONVERTS:
        n = face / cp
        K = cap if cap > 0 else cp
        inst.append((K, n, n * K))
    for lab, cnt, k, _ in I.AWARDS:
        n = cnt / 1e6
        inst.append((k, n, n * k))
    return S0, cash, debt, conv_face, inst


def per_share(E0, S0, inst):
    Ks = np.array([x[0] for x in inst]); ns = np.array([x[1] for x in inst]); Ds = np.array([x[2] for x in inst])
    conv = []
    for K in Ks:
        m = Ks <= K
        v = (E0 + Ds[m].sum()) / (S0 + ns[m].sum())
        conv.append(v > K)
    conv = np.array(conv)
    E = E0 + Ds[conv].sum(); S = S0 + ns[conv].sum()
    return max(0.0, E / S), E, S, conv


def run(s, ov=None, beta_hi=None, delay=0):
    """Run scenario index s (0..3). ov: dict of parameter overrides. delay: shift deployment/start (yrs)."""
    p = base_params(s)
    if ov:
        p.update(ov)
    if beta_hi is None:
        beta_hi = market_stats()["beta_adj"]
    Y = np.array(I.YEARS, float); L = np.array(I.LENS); ST = np.array(I.STARTS); M = ST + L / 2
    life = int(round(p["sat_life"]))

    # ---- fleet targets (delay shifts path right)
    tgt_by_year = {2026: p["fl_26"], 2027: p["fl_27"], 2028: p["fl_28"], 2029: p["fl_29"]}
    def tgt(y):
        yy = y - delay
        if yy < 2026:
            return p["fleet_open"]
        return tgt_by_year.get(int(yy), p["fl_ss"])
    F = np.array([tgt(y) for y in Y], float)
    B = np.zeros(NP); E = np.zeros(NP); N = np.zeros(NP); R = np.zeros(NP)
    for i in range(NP):
        B[i] = p["fleet_open"] if i == 0 else E[i - 1]
        yr = Y[i] - life
        r = 0.0
        if yr == 2026:
            r = N[0] + p["fleet_open"]
        elif yr >= 2027:
            j = int(yr - 2026)
            r = N[j]
        R[i] = r
        N[i] = max(0.0, F[i] - B[i] + R[i])
        E[i] = B[i] - R[i] + N[i]
    G = N / (1 - p["loss_rate"])
    A = (B + E) / 2
    U = p["unit_cost"] * (1 + p["unit_infl"]) ** np.maximum(0, Y - 2028)
    SC = G * U
    pool = p["cip_sat"] * p["cip_credit"]
    C = np.zeros(NP); used = 0.0
    for i in range(NP):
        C[i] = min(SC[i], pool - used); used += C[i]

    # ---- revenue
    def cov(s0, sf):
        return np.clip((A - s0) / (sf - s0), 0, 1)
    cov1 = cov(p["s0_t1"], p["sf_t1"]); cov2 = cov(p["s0_t2"], p["sf_t2"])
    k = 2 * math.log(19) / p["ramp"]
    def adopt(y0, peak):
        y0 = y0 + delay
        return np.where(M >= y0, peak / (1 + np.exp(-k * (M - (y0 + p["ramp"] / 2)))), 0.0)
    ad1 = adopt(p["t1_start"], p["take_t1"]); ad2 = adopt(p["t2_start"], p["take_t2"])
    base_g = (1 + p["sub_g"]) ** np.maximum(0, Y - 2026)
    subs1 = p["partner_subs"] * base_g * p["t1_share"] * cov1 * ad1
    subs2 = p["partner_subs"] * base_g * (1 - p["t1_share"]) * cov2 * ad2
    pxf = (1 + p["px_g"]) ** np.clip(Y - 2027, 0, p["px_end"] - 2027) * \
          (1 + p["arpu_lr_g"]) ** np.maximum(0, Y - p["px_end"])
    rev1 = subs1 * p["arpu_t1"] * pxf * 12 * L
    rev2 = subs2 * p["arpu_t2"] * pxf * 12 * L
    gov = np.array([{2026: p["gov_26"], 2027: p["gov_27"], 2028: p["gov_28"], 2029: p["gov_29"],
                     2030: p["gov_30"]}.get(int(y), p["gov_30"] * (1 + p["gov_g"]) ** (y - 2030)) for y in Y])
    prod = np.array([{2026: p["prod_26"], 2027: p["prod_27"], 2028: p["prod_28"]}.get(int(y), p["prod_ss"]) for y in Y])
    rev = rev1 + rev2 + gov + prod

    # ---- costs
    cogs = prod * (1 - p["prod_margin"]) + gov * p["gov_cogs"]
    var = (rev1 + rev2) * p["var_cost"]
    lig = rev1 * p["ligado_share"]
    spec = np.where(Y >= p["ligado_year"], p["spec_fee"] * L, 0.0)
    opex = np.zeros(NP)
    for i, y in enumerate(Y):
        if y == 2026: opex[i] = p["opex_26"]
        elif y == 2027: opex[i] = p["opex_27"]
        elif y == 2028: opex[i] = opex[i - 1] * (1 + p["opex_g28"])
        elif y == 2029: opex[i] = opex[i - 1] * (1 + p["opex_g29"])
        elif y == 2030: opex[i] = opex[i - 1] * (1 + p["opex_g30"])
        else: opex[i] = opex[i - 1] * (1 + p["opex_gss"])
    sbc = np.where(Y == 2026, p["sbc_26"],
                   np.maximum(p["sbc_27"] * (1 - p["sbc_decay"]) ** np.maximum(0, Y - 2027), p["sbc_floor"] * rev))
    netx = A * p["net_opex_sat"] * L
    ebitda = rev - cogs - var - lig - spec - opex - netx - sbc

    # ---- capex & other cash items
    ocx = np.array([{2026: p["ocx_26"], 2027: p["ocx_27"], 2028: p["ocx_28"]}.get(int(y), 0.0) for y in Y])
    ocx = np.where(Y >= 2029, np.maximum(p["ocx_floor"], p["ocx_pct"] * rev), ocx)
    ligpay = np.where(Y == p["ligado_year"], p["ligado_pay"], 0.0)
    jleo = np.where(Y == 2028, p["jleo"], 0.0)

    # ---- tax
    capex_tax = SC + ocx
    if p["bonus_dep"] == 1:
        tdep = capex_tax.copy()
    else:
        tdep = np.array([capex_tax[(Y > y - life) & (Y <= y)].sum() / life * L[i] for i, y in enumerate(Y)])
    samort = np.where((Y >= p["ligado_year"]) & (Y < p["ligado_year"] + 15), p["ligado_pay"] / 15 * L, 0.0)
    ti = ebitda - tdep - samort
    nol_b = np.zeros(NP); nol_e = np.zeros(NP); use = np.zeros(NP); tax = np.zeros(NP)
    for i in range(NP):
        nol_b[i] = p["nol_open"] if i == 0 else nol_e[i - 1]
        use[i] = min(nol_b[i], max(0.0, ti[i]) * p["nol_limit"])
        nol_e[i] = nol_b[i] - use[i] + max(0.0, -ti[i])
        tax[i] = p["tax_rate"] * max(0.0, ti[i] - use[i])

    ann = rev / L
    prev = np.concatenate([[p["h1_ann_rev"]], ann[:-1]])
    dnwc = p["nwc_pct"] * (ann - prev)
    cl = np.where((Y >= p["cl_unwind_start"]) & (Y < p["cl_unwind_start"] + p["cl_unwind_yrs"]),
                  p["contract_liab"] / p["cl_unwind_yrs"] * L, 0.0)
    fcf = ebitda - tax - (SC - C) - ocx - ligpay + jleo - dnwc - cl

    # ---- discounting
    ke_hi = p["rf"] + beta_hi * p["erp"]
    w_hi = (1 - p["dv_hi"]) * ke_hi + p["dv_hi"] * p["kd_hi"] * (1 - p["t_hi"])
    ke_t = p["rf"] + p["beta_term"] * p["erp"]
    w_t = (1 - p["dv_term"]) * ke_t + p["dv_term"] * p["kd_term"] * (1 - p["t_term"])
    w_hi += p["wacc_shift"]; w_t += p["wacc_shift"]
    fs, fe = p["wacc_fade_start"], p["wacc_fade_end"]
    w = np.where(Y < fs, w_hi, np.where(Y >= fe, w_t, w_hi + (w_t - w_hi) * (Y - fs + 1) / (fe - fs + 1)))
    V = p["val_date"]
    Ecum = np.zeros(NP); df = np.zeros(NP)
    for i in range(NP):
        if i == 0:
            Ecum[0] = (1 + w[0]) ** (ST[0] + L[0] - V)
            df[0] = 1 / (1 + w[0]) ** (M[0] - V)
        else:
            Ecum[i] = Ecum[i - 1] * (1 + w[i]) ** L[i]
            df[i] = 1 / (Ecum[i - 1] * (1 + w[i]) ** (L[i] / 2))
    pv = fcf * df

    g = p["g"]
    e41 = ebitda[-1] * (1 + g)
    maint = p["fl_ss"] / life / (1 - p["loss_rate"]) * U[-1] * (1 + g)
    ocx41 = ocx[-1] * (1 + g)
    tax41 = p["tax_rate"] * max(0.0, e41 - maint - ocx41)
    dnwc41 = p["nwc_pct"] * rev[-1] * g
    fcf41 = e41 - tax41 - maint - ocx41 - dnwc41
    tv = fcf41 * (1 + w_t) ** 0.5 / (w_t - g)
    pv_tv = tv / Ecum[-1]
    ev = pv.sum() + pv_tv

    S0, cash, debt, conv_face, inst = capital_structure()
    E0 = ev + cash - debt - conv_face
    vps, Ef, Sf, conv = per_share(E0, S0, inst)
    return dict(p=p, F=F, B=B, E=E, N=N, R=R, G=G, A=A, U=U, SC=SC, C=C, cov1=cov1, cov2=cov2, ad1=ad1, ad2=ad2,
                subs1=subs1, subs2=subs2, rev1=rev1, rev2=rev2, gov=gov, prod=prod, rev=rev, cogs=cogs, var=var,
                lig=lig, spec=spec, opex=opex, netx=netx, sbc=sbc, ebitda=ebitda, ocx=ocx, ligpay=ligpay, jleo=jleo,
                tdep=tdep, samort=samort, ti=ti, nol_e=nol_e, tax=tax, dnwc=dnwc, cl=cl, fcf=fcf, w=w, df=df,
                Ecum=Ecum, pv=pv, w_hi=w_hi, w_t=w_t, ke_hi=ke_hi, fcf41=fcf41, e41=e41, maint=maint, tv=tv,
                pv_tv=pv_tv, ev=ev, E0=E0, Ef=Ef, Sf=Sf, conv=conv, vps=vps, cash=cash, debt=debt, conv_face=conv_face)


def prob_weighted(**kw):
    vals = [run(s, **kw)["vps"] for s in range(4)]
    probs = [I.scen_value("prob", s) for s in range(4)]
    return sum(v * q for v, q in zip(vals, probs)), vals


if __name__ == "__main__":
    ms = market_stats(); print(ms)
    for s in range(4):
        r = run(s)
        print(f"{I.SCEN[s]:9s} EV={r['ev']:9.0f} PV_TV={r['pv_tv']:9.0f} E0={r['E0']:9.0f} "
              f"vps={r['vps']:7.2f} S={r['Sf']:.1f} w_hi={r['w_hi']:.4f} w_t={r['w_t']:.4f}")
    pw, vals = prob_weighted(); print("prob-weighted", round(pw, 2))
