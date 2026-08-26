"""
Regenerates tests/fixtures/regression-reference.json.

The reference values come from statsmodels, an independent and long-tested
implementation. Checking our OLS against arithmetic we also wrote would only
prove the two agree; checking it against statsmodels proves it is right.

The residuals are deliberately AR(1) *and* heteroskedastic. With iid residuals
Newey-West and classical standard errors agree, and a fixture built that way
would pass whether or not the HAC sandwich were implemented at all. Here the
alpha standard error differs by ~1.7x, which is the difference between an alpha
that looks significant and one that does not.

    pip install statsmodels numpy
    python3 scripts/make-regression-fixture.py
"""
import json, numpy as np, statsmodels.api as sm

rng = np.random.default_rng(20260824)
n = 900

mkt = rng.normal(0.0004, 0.010, n)
smb = rng.normal(0.0001, 0.006, n)
hml = rng.normal(0.0000, 0.006, n)

eps = np.zeros(n)
z = rng.normal(0, 1, n)
for t in range(1, n):
    scale = 0.004 * (1 + 25 * abs(mkt[t]))
    eps[t] = 0.55 * eps[t - 1] + scale * z[t]

y = 0.00012 + 1.05 * mkt + 0.35 * smb - 0.22 * hml + eps

X = sm.add_constant(np.column_stack([mkt, smb, hml]))
ols = sm.OLS(y, X).fit()
L = int(np.floor(4 * (n / 100) ** (2 / 9)))
hac = sm.OLS(y, X).fit(cov_type="HAC", cov_kwds={"maxlags": L, "use_correction": False})

names = ["Alpha", "Mkt-RF", "SMB", "HML"]
json.dump(
    {
        "note": "Reference values from statsmodels OLS / HAC(Bartlett). Regenerate with scripts/make-regression-fixture.py",
        "lags": L,
        "n": n,
        "y": y.tolist(),
        "x": {"Mkt-RF": mkt.tolist(), "SMB": smb.tolist(), "HML": hml.tolist()},
        "expected": {
            "params": dict(zip(names, ols.params.tolist())),
            "seOls": dict(zip(names, ols.bse.tolist())),
            "seNW": dict(zip(names, hac.bse.tolist())),
            "tNW": dict(zip(names, hac.tvalues.tolist())),
            "pNW": dict(zip(names, hac.pvalues.tolist())),
            "rSquared": float(ols.rsquared),
            "adjRSquared": float(ols.rsquared_adj),
            "residStd": float(np.sqrt(ols.ssr / (n - 4))),
        },
    },
    open("tests/fixtures/regression-reference.json", "w"),
)
print(f"wrote tests/fixtures/regression-reference.json (n={n}, lags={L})")
