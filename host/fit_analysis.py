#!/usr/bin/env python3
"""Offline analysis harness for the ESWCap ADC RC-timing estimator.

Two estimators are implemented here, both mirroring the firmware:

  * old_fit  - the historic log-linear OLS fit  ln(V_inf - V) = ln(V_inf) - t/tau
               (the asymptote V_inf is assumed exact).
  * new_fit  - the voltage-domain damped Gauss-Newton / Levenberg-Marquardt fit
               V(t) = V_inf - (V_inf - V0)*exp(-(t - t0)/tau), solving V_inf and
               tau jointly (see src/main.c: rc_exp_fit).

Usage
-----
  python3 fit_analysis.py                 # synthetic self-test (bias vs. V_inf error)
  python3 fit_analysis.py --noise 3       # ... with 3 mV RMS ADC noise
  python3 fit_analysis.py --rec file.json # compare old vs new on saved curves
  python3 fit_analysis.py --rec file.json --csv out.csv

The recording JSON is the file produced by the dashboard's "Save JSON" button
(host/static/precision.js: saveRecordingJson).  Only curves with a stored fit
are analysed.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import random
import sys
from typing import Iterable, List, Optional, Sequence, Tuple

Point = Tuple[float, float]  # (x_us relative to first sample, mV)


# --------------------------------------------------------------------------- #
# shared
# --------------------------------------------------------------------------- #
def _ols(xs: Sequence[float], ys: Sequence[float]) -> Tuple[float, float, float]:
    """Ordinary least squares.  Returns (slope, intercept, r2)."""
    n = len(xs)
    if n < 3:
        return 0.0, 0.0, 0.0
    sx = sum(xs)
    sy = sum(ys)
    sxx = sum(x * x for x in xs)
    sxy = sum(x * y for x, y in zip(xs, ys))
    denom = n * sxx - sx * sx
    if abs(denom) < 1e-12:
        return 0.0, 0.0, 0.0
    slope = (n * sxy - sx * sy) / denom
    intercept = (sy - slope * sx) / n
    ybar = sy / n
    ss_res = sum((y - (slope * x + intercept)) ** 2 for x, y in zip(xs, ys))
    ss_tot = sum((y - ybar) ** 2 for y in ys)
    r2 = 1.0 - ss_res / ss_tot if ss_tot > 1e-12 else 0.0
    return slope, intercept, r2


# --------------------------------------------------------------------------- #
# legacy log-linear estimator
# --------------------------------------------------------------------------- #
def old_fit(pts: Sequence[Point], v_inf: float, min_gap: float = 12.0) -> Optional[float]:
    """Return tau (us) from the historic log-linear OLS fit, or None."""
    xs: List[float] = []
    ys: List[float] = []
    for x, v in pts:
        gap = v_inf - v
        if gap < min_gap:
            continue
        xs.append(x)
        ys.append(math.log(gap))
    if len(xs) < 6:
        return None
    slope, _, _ = _ols(xs, ys)
    if slope >= -1e-9:
        return None
    return -1.0 / slope


# --------------------------------------------------------------------------- #
# firmware-equivalent nonlinear estimator
# --------------------------------------------------------------------------- #
def _solve3(A, b):
    """Gauss-Jordan solve of a 3x3 system.  A is a list of 3 lists."""
    M = [list(A[i]) + [b[i]] for i in range(3)]
    for col in range(3):
        piv = max(range(col, 3), key=lambda r: abs(M[r][col]))
        if abs(M[piv][col]) < 1e-12:
            return None
        M[col], M[piv] = M[piv], M[col]
        d = M[col][col]
        M[col] = [v / d for v in M[col]]
        for r in range(3):
            if r == col:
                continue
            f = M[r][col]
            if f == 0.0:
                continue
            M[r] = [a - f * c for a, c in zip(M[r], M[col])]
    return [M[i][3] for i in range(3)]


def _model(x, v_inf, tau, t0, v0):
    return v_inf - (v_inf - v0) * math.exp(-(x - t0) / tau)


def new_fit(pts: Sequence[Point], v0: float, v_inf_hint: float = 0.0,
            t0_hint: float = 0.0, glitch_mv: float = 40.0,
            max_iter: int = 50) -> dict:
    """Return {'tau_us', 'v_inf_mv', 't0_us', 'r2', 'rmse_mv', 'tau_se_us', 'n'}."""
    # monotonic glitch filter
    work: List[Point] = []
    run_max = pts[0][1]
    for x, v in pts:
        run_max = max(run_max, v)
        if v < run_max - glitch_mv:
            continue
        work.append((x, v))
    if len(work) < 8:
        return {}

    xs = [p[0] for p in work]
    ys = [p[1] for p in work]
    y_max = max(ys)

    v_inf = v_inf_hint if v_inf_hint > 0 else y_max + 200.0
    if v_inf < y_max + 2.0:
        v_inf = y_max + 200.0
    t0 = t0_hint if t0_hint < 0 else 0.0

    v63 = v0 + 0.632 * (v_inf - v0)
    tau = 0.0
    for x, v in work:
        if v >= v63:
            tau = x - t0
            break
    if tau <= 0:
        tau = (xs[-1] - t0) * 0.4
    if tau <= 1e-3:
        tau = 1.0

    def cost(p):
        vv, tt, z0 = p
        return sum((_model(x, vv, tt, z0, v0) - y) ** 2 for x, y in work)

    p = [v_inf, tau, t0]
    c = cost(p)
    lam = 1e-2
    for _ in range(max_iter):
        A = [[0.0] * 3 for _ in range(3)]
        g = [0.0] * 3
        amp = p[0] - v0
        if amp <= 0:
            break
        for x, y in work:
            s = (x - p[2]) / p[1]
            s = max(s, -20.0)
            e = math.exp(-s)
            res = (p[0] - amp * e) - y
            J = [1.0 - e,
                 -amp * e * (x - p[2]) / (p[1] * p[1]),
                 -amp * e / p[1]]
            for a in range(3):
                g[a] += J[a] * res
                for b2 in range(3):
                    A[a][b2] += J[a] * J[b2]
        Ad = [row[:] for row in A]
        for a in range(3):
            Ad[a][a] += lam * (A[a][a] if A[a][a] > 0 else 1.0)
        delta = _solve3(Ad, g)
        if delta is None:
            lam *= 10.0
            if lam > 1e12:
                break
            continue
        np_ = [p[0] - delta[0], p[1] - delta[1], p[2] - delta[2]]
        if np_[1] < 1e-3:
            np_[1] = 1e-3
        if np_[0] <= v0:
            np_[0] = v0 + 1.0
        if np_[2] > 0:
            np_[2] = 0.0
        trial = cost(np_)
        if trial < c:
            p = np_
            c = trial
            lam *= 0.5
            if lam < 1e-9:
                lam = 1e-9
        else:
            lam *= 4.0
            if lam > 1e12:
                break

    v_inf, tau, t0 = p
    if not (tau > 0 and v_inf > v0):
        return {}
    m = len(work)
    rmse = math.sqrt(c / m)

    # log-domain R2 against the fitted asymptote (quality semantics)
    lx, ly = [], []
    for x, y in work:
        gap = v_inf - y
        if gap < 12.0:
            continue
        lx.append(x)
        ly.append(math.log(gap))
    r2 = 0.0
    if len(lx) >= 4:
        _, _, r2 = _ols(lx, ly)

    # tau standard error from sigma^2 * (J^T J)^-1
    tau_se = 0.0
    if m > 3:
        A = [[0.0] * 3 for _ in range(3)]
        amp = v_inf - v0
        for x, _ in work:
            s = max((x - t0) / tau, -20.0)
            e = math.exp(-s)
            J = [1.0 - e, -amp * e * (x - t0) / (tau * tau), -amp * e / tau]
            for a in range(3):
                for b2 in range(3):
                    A[a][b2] += J[a] * J[b2]
        sigma2 = c / (m - 3)
        col = _solve3(A, [0.0, 1.0, 0.0])
        if col is not None and sigma2 * col[1] > 0:
            tau_se = math.sqrt(sigma2 * col[1])

    return {"tau_us": tau, "v_inf_mv": v_inf, "t0_us": t0,
            "r2": r2, "rmse_mv": rmse, "tau_se_us": tau_se, "n": m}


# --------------------------------------------------------------------------- #
# synthetic self-test
# --------------------------------------------------------------------------- #
def synth_curve(tau_us: float, v_inf: float, v0: float = 0.0,
                n: int = 40, noise_mv: float = 0.0,
                capture_hi: float = 0.90, rng: Optional[random.Random] = None,
                quant_mv: float = 1.0) -> Tuple[List[Point], float]:
    """Generate an ideal RC charge curve sampled log-spaced in time.

    Returns (points, t0_hint) where a point x is relative to the first stored
    sample and t0_hint = -x_first (the drive edge, as the firmware computes it).
    """
    rng = rng or random.Random(1234)
    v_stop = v0 + capture_hi * (v_inf - v0)
    d_lo = 0.05 * tau_us
    d_hi = 6.0 * tau_us
    pts: List[Point] = []
    for i in range(n):
        frac = i / (n - 1)
        d = d_lo * (d_hi / d_lo) ** frac           # delay from the step edge
        v = _model(d, v_inf, tau_us, 0.0, v0)      # t0 = 0 in delay coordinates
        if v > v_stop:
            break
        if noise_mv:
            v += rng.gauss(0.0, noise_mv)
        if quant_mv:
            v = round(v / quant_mv) * quant_mv
        pts.append((d - d_lo, v))
    return pts, -d_lo


def selftest(noise_mv: float = 2.0, trials: int = 200, seed: int = 7) -> int:
    rng = random.Random(seed)
    print(f"synthetic self-test: {trials} trials, {noise_mv:.1f} mV RMS ADC noise\n")
    print(f"{'tau_true':>9} | {'old bias%':>9} {'old sd%':>8} | "
          f"{'new bias%':>9} {'new sd%':>8} | {'v_inf hint err':>13}")
    print("-" * 78)
    rc = 0
    for tau_true in (300.0, 3000.0, 30000.0):
        old_e, new_e = [], []
        for _ in range(trials):
            v_inf_true = 2600.0
            # deliberately biased asymptote hint (settle loop stops early)
            v_inf_hint = v_inf_true - rng.uniform(0.0, 120.0)
            pts = synth_curve(tau_true, v_inf_true, 100.0,
                              n=40, noise_mv=noise_mv, rng=rng)
            pts, t0_hint = pts
            ot = old_fit(pts, v_inf_hint)
            nt = new_fit(pts, 100.0, v_inf_hint, t0_hint)
            if ot:
                old_e.append(100.0 * (ot - tau_true) / tau_true)
            if nt.get("tau_us"):
                new_e.append(100.0 * (nt["tau_us"] - tau_true) / tau_true)
        ob = sum(old_e) / len(old_e)
        nb = sum(new_e) / len(new_e)
        osd = math.sqrt(sum((e - ob) ** 2 for e in old_e) / len(old_e))
        nsd = math.sqrt(sum((e - nb) ** 2 for e in new_e) / len(new_e))
        print(f"{tau_true:9.0f} | {ob:9.3f} {osd:8.3f} | {nb:9.3f} {nsd:8.3f} | {60.0:13.0f}")
        if abs(nb) > abs(ob) + 0.5 or nsd > osd + 0.5:
            rc = 1
    print("\n(new fit should show near-zero bias even with a biased asymptote hint)")
    return rc


# --------------------------------------------------------------------------- #
# recording analysis
# --------------------------------------------------------------------------- #
def analyze_recording(path: str, csv_out: Optional[str], v0_default: float = 0.0) -> int:
    with open(path, "r") as f:
        data = json.load(f)
    rows = []
    for cyc in data.get("cycles", []):
        cv = cyc.get("curve")
        if not cv or not cv.get("pts"):
            continue
        pts = [(float(p[0]), float(p[1])) for p in cv["pts"]]
        rng = int(cv.get("range", -1))
        v0 = float(cv.get("v0", v0_default) or v0_default)
        t0 = float(cv.get("t0_us", 0.0) or 0.0)
        vinf = float(cv.get("vinf", 0.0) or 0.0)
        ot = old_fit(pts, vinf) if vinf > 0 else None
        nt = new_fit(pts, v0, vinf, t0)
        rows.append({
            "cycle": cyc.get("idx"),
            "range": rng,
            "n": len(pts),
            "vinf_mv": vinf,
            "old_tau_us": ot,
            "new_tau_us": nt.get("tau_us"),
            "new_v_inf_mv": nt.get("v_inf_mv"),
            "new_r2": nt.get("r2"),
            "new_rmse_mv": nt.get("rmse_mv"),
            "new_tau_unc_us": nt.get("tau_se_us"),
        })
    if not rows:
        print("no curves found in recording")
        return 1
    print(f"{'cyc':>5} {'rng':>3} {'n':>3} {'vinf':>6} {'old_tau':>10} "
          f"{'new_tau':>10} {'fit_vinf':>9} {'R2':>8} {'rmse':>7} {'tau_unc':>8}")
    for r in rows:
        ot = f"{r['old_tau_us']:.1f}" if r["old_tau_us"] else "  -"
        nt = f"{r['new_tau_us']:.1f}" if r["new_tau_us"] else "  -"
        print(f"{str(r['cycle']):>5} {r['range']:>3} {r['n']:>3} {r['vinf_mv']:>6.0f} "
              f"{ot:>10} {nt:>10} {r['new_v_inf_mv']:>9.1f} {r['new_r2']:>8.4f} "
              f"{r['new_rmse_mv']:>7.2f} {r['new_tau_unc_us']:>8.2f}")
    if csv_out:
        with open(csv_out, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
        print(f"\nwrote {csv_out}")
    return 0


def main(argv: Sequence[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--rec", metavar="FILE", help="saved recording JSON to analyse")
    ap.add_argument("--csv", metavar="FILE", help="write per-curve results to CSV")
    ap.add_argument("--noise", type=float, default=2.0,
                    help="synthetic ADC noise in mV RMS (default 2.0)")
    ap.add_argument("--trials", type=int, default=200)
    args = ap.parse_args(argv)
    if args.rec:
        return analyze_recording(args.rec, args.csv)
    return selftest(noise_mv=args.noise, trials=args.trials)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))