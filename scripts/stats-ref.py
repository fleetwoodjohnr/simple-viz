"""Reference values for the statistics tests, from SciPy and statsmodels (independent implementations).

  python -m venv .venv && .venv/bin/pip install numpy scipy statsmodels
  .venv/bin/python scripts/stats-ref.py        # writes tests/fixtures/stats-ref.json

Run after `npm run fixtures`; commit the JSON together with any fixture change.
"""
import csv, json, math, pathlib
import numpy as np
from scipy import stats
import statsmodels.api as sm
from statsmodels.tsa.holtwinters import ExponentialSmoothing
from statsmodels.tsa.statespace.sarimax import SARIMAX
from statsmodels.tsa.stattools import kpss

root = pathlib.Path(__file__).resolve().parent.parent / 'tests' / 'fixtures'
rows = list(csv.DictReader(open(root / 'stats.csv')))
f = lambda r, k: float(r[k]) if r[k] != '' else math.nan
x1 = np.array([f(r, 'x1') for r in rows]); x2 = np.array([f(r, 'x2') for r in rows]); y = np.array([f(r, 'y') for r in rows])
y2 = np.array([f(r, 'y2') for r in rows]); grp = np.array([r['grp'] for r in rows]); cat = np.array([r['cat'] for r in rows])
b = np.array([int(r['b']) for r in rows]); before = np.array([f(r, 'before') for r in rows]); after = np.array([f(r, 'after') for r in rows])
ok = ~np.isnan(x2)
ref = {}

ref['describe_y'] = dict(mean=float(np.mean(y)), median=float(np.median(y)), sd=float(np.std(y, ddof=1)), skew=float(stats.skew(y, bias=False)), kurt=float(stats.kurtosis(y, bias=False)), q1=float(np.percentile(y, 25)), q3=float(np.percentile(y, 75)))
ref['corr_x1_y'] = dict(r=float(stats.pearsonr(x1, y).statistic), p=float(stats.pearsonr(x1, y).pvalue))
t1 = stats.ttest_1samp(y2, 11.0); ref['ttest_one'] = dict(t=float(t1.statistic), p=float(t1.pvalue))
a, c = y2[grp == 'A'], y2[grp == 'C']
tw = stats.ttest_ind(a, c, equal_var=False); ref['ttest_welch_A_C'] = dict(t=float(tw.statistic), p=float(tw.pvalue))
tp = stats.ttest_rel(after, before); ref['ttest_paired'] = dict(t=float(tp.statistic), p=float(tp.pvalue))
fa = stats.f_oneway(*[y2[grp == g] for g in 'ABC']); ref['anova'] = dict(F=float(fa.statistic), p=float(fa.pvalue))
tab = np.array([[np.sum((grp == g) & (cat == k)) for k in ['Blue', 'Green', 'Red']] for g in 'ABC'])
ch = stats.chi2_contingency(tab, correction=False); ref['chisq'] = dict(chi2=float(ch.statistic), p=float(ch.pvalue), df=int(ch.dof))
mw = stats.mannwhitneyu(a, c, alternative='two-sided', method='asymptotic', use_continuity=True); ref['mannwhitney_A_C'] = dict(U=float(mw.statistic), p=float(mw.pvalue))
kw = stats.kruskal(*[y2[grp == g] for g in 'ABC']); ref['kruskal'] = dict(H=float(kw.statistic), p=float(kw.pvalue))

X = sm.add_constant(np.column_stack([x1[ok], x2[ok]])); ols = sm.OLS(y[ok], X).fit()
ref['ols'] = dict(coef=ols.params.tolist(), se=ols.bse.tolist(), p=ols.pvalues.tolist(), r2=float(ols.rsquared), adj_r2=float(ols.rsquared_adj), F=float(ols.fvalue), n=int(ols.nobs))
P = sm.add_constant(np.column_stack([x1, x1 ** 2])); poly = sm.OLS(y, P).fit()
ref['poly2'] = dict(coef=poly.params.tolist(), r2=float(poly.rsquared))
L = sm.add_constant(np.column_stack([x1[ok], x2[ok]])); logit = sm.Logit(b[ok], L).fit(disp=0)
ref['logit'] = dict(coef=logit.params.tolist(), se=logit.bse.tolist(), llf=float(logit.llf), prsquared=float(logit.prsquared))
# Text predictors as indicators, the first value in sort order as the reference.
D = sm.add_constant(np.column_stack([x1, (grp == 'B').astype(float), (grp == 'C').astype(float)])); olsd = sm.OLS(y2, D).fit()
ref['ols_dummy'] = dict(coef=olsd.params.tolist(), se=olsd.bse.tolist(), r2=float(olsd.rsquared))
LD = sm.add_constant(np.column_stack([x1, (cat == 'Green').astype(float), (cat == 'Red').astype(float)])); logitd = sm.Logit(b, LD).fit(disp=0)
ref['logit_dummy'] = dict(coef=logitd.params.tolist(), se=logitd.bse.tolist(), llf=float(logitd.llf))
Z = np.column_stack([x1[ok], x2[ok], y[ok], y2[ok]]); R = np.corrcoef(Z, rowvar=False); ev = np.linalg.eigvalsh(R)[::-1]
ref['pca_eigenvalues'] = ev.tolist()

srows = list(csv.DictReader(open(root / 'series.csv'))); s = np.array([float(r['sales']) for r in srows])
init = dict(initial_level=float(np.mean(s[:12])), initial_trend=float((np.mean(s[12:24]) - np.mean(s[:12])) / 12), initial_seasonal=(s[:12] - np.mean(s[:12])).tolist())
hw = ExponentialSmoothing(s, trend='add', seasonal='add', seasonal_periods=12, initialization_method='known', **init).fit(smoothing_level=0.4, smoothing_trend=0.1, smoothing_seasonal=0.2, optimized=False)
ref['hw_fixed'] = dict(params=dict(alpha=0.4, beta=0.1, gamma=0.2), init=init, fitted=hw.fittedvalues.tolist(), forecast=hw.forecast(6).tolist())
hw_opt = ExponentialSmoothing(s, trend='add', seasonal='add', seasonal_periods=12, initialization_method='known', **init).fit()
ref['hw_opt_sse'] = float(hw_opt.sse)
# Multiplicative season (statsmodels seasonal='mul'), known start, fixed smoothing.
mi = dict(initial_level=float(np.mean(s[:12])), initial_trend=float((np.mean(s[12:24]) - np.mean(s[:12])) / 12), initial_seasonal=(s[:12] / np.mean(s[:12])).tolist())
hwm = ExponentialSmoothing(s, trend='add', seasonal='mul', seasonal_periods=12, initialization_method='known', **mi).fit(smoothing_level=0.4, smoothing_trend=0.1, smoothing_seasonal=0.2, optimized=False)
ref['hw_mul_fixed'] = dict(params=dict(alpha=0.4, beta=0.1, gamma=0.2), init=mi, fitted=hwm.fittedvalues.tolist(), forecast=hwm.forecast(6).tolist())

# Damped trend (statsmodels damped_trend=True), known start, fixed smoothing.
hwd = ExponentialSmoothing(s, trend='add', damped_trend=True, seasonal='add', seasonal_periods=12, initialization_method='known', **init).fit(smoothing_level=0.4, smoothing_trend=0.1, smoothing_seasonal=0.2, damping_trend=0.9, optimized=False)
ref['hw_damped_fixed'] = dict(params=dict(alpha=0.4, beta=0.1, gamma=0.2, phi=0.9), init=init, fitted=hwd.fittedvalues.tolist(), forecast=hwd.forecast(6).tolist())

# Multiplicative trend (statsmodels trend='mul'), with an additive and with a multiplicative season.
mt = dict(initial_level=float(np.mean(s[:12])), initial_trend=1.01)
for key, seasonal, init_s in [('hw_multrend_add', 'add', (s[:12] - np.mean(s[:12])).tolist()), ('hw_multrend_mul', 'mul', (s[:12] / np.mean(s[:12])).tolist())]:
    m = ExponentialSmoothing(s, trend='mul', seasonal=seasonal, seasonal_periods=12, initialization_method='known', initial_seasonal=init_s, **mt).fit(smoothing_level=0.4, smoothing_trend=0.1, smoothing_seasonal=0.2, optimized=False)
    ref[key] = dict(params=dict(alpha=0.4, beta=0.1, gamma=0.2), init=dict(mt, initial_seasonal=init_s), fitted=m.fittedvalues.tolist(), forecast=m.forecast(6).tolist())

# Seasonal ARIMA (SARIMAX, exact likelihood): fixed parameters, then the maximum-likelihood fit.
# simple_differencing=True: the likelihood of the differenced series, which is what Simple Viz maximizes.
sa = SARIMAX(s, order=(1, 1, 1), seasonal_order=(0, 1, 1, 12), simple_differencing=True)
sfx = sa.filter([0.5, -0.3, -0.4, 20.0])
sfc = SARIMAX(s, order=(1, 1, 1), seasonal_order=(0, 1, 1, 12)).filter([0.5, -0.3, -0.4, 20.0]).get_forecast(6)
sfit = sa.fit(disp=0)
ref['sarima_fixed'] = dict(ar=[0.5], ma=[-0.3], sma=[-0.4], sigma2=20.0, llf=float(sfx.llf), forecast=sfc.predicted_mean.tolist(), ci=sfc.conf_int(alpha=0.05).tolist())
ref['sarima_fit'] = dict(params=sfit.params.tolist(), llf=float(sfit.llf))
am = SARIMAX(s, order=(1, 0, 0), trend='c')
ref['ar1_mean'] = dict(c=40.0, ar=0.6, sigma2=300.0, llf=float(am.filter([40.0, 0.6, 300.0]).llf), fit_llf=float(am.fit(disp=0).llf))
# The airline series (Box & Jenkins, series G), logged: auto.arima's choice is ARIMA(0,1,1)(0,1,1)[12].
air = np.log(np.array([float(r['passengers']) for r in csv.DictReader(open(root / 'airline.csv'))]))
af = SARIMAX(air, order=(0, 1, 1), seasonal_order=(0, 1, 1, 12), simple_differencing=True).fit(disp=0)
ref['airline_fit'] = dict(params=af.params.tolist(), llf=float(af.llf))
ref['kpss_series'] = dict(lags=3, stat=float(kpss(s, regression='c', nlags=3)[0]))

json.dump(ref, open(root / 'stats-ref.json', 'w'), indent=1)
print('wrote', root / 'stats-ref.json')
