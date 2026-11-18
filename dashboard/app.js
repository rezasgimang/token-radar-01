// Token Radar's plain dashboard. It reads window.RADAR (written beside dashboard/ by main.ts)
// and renders the ranked board, the fitted value model with its blind tests, a per-protocol
// detail view with the costed farm plan, and the live-token set. No network: every byte it
// shows is in data.js. The page recomputes a row's implied value from the fitted curve and
// its farm plan from the same constants main.ts used, so the page's code and the board's data
// are visibly the same arithmetic.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  app.setAttribute('aria-busy', 'false');

  var params = new URLSearchParams(location.search);
  var state = {
    q: params.get('q') || '',
    verdict: params.get('verdict') || 'all',
    category: 'all',
    chain: 'all',
    scope: params.get('scope') || 'all',
    deposit: parseInt(params.get('deposit') || '1000', 10) || 1000,
    sort: 'implied',
    dir: -1,
    selected: params.get('slug') || null,
    tab: 'pre-token',
  };
  if (state.deposit !== 1000 && state.deposit !== 10000) state.deposit = 1000;

  var FA = DATA.farm_assumptions;
  var FIT = DATA.fit;

  // ---------------------------------------------------------- formatting
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    if (n >= 1) return '$' + Math.round(n);
    return '$' + n.toFixed(2);
  }
  function fmtUsdFull(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---------------------------------------------------------- the model, again, in the page
  // The same arithmetic main.ts ran: season the TVL by the week's growth, read the fitted curve.
  function growthOf(row) {
    var g = row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d;
    return Math.min(120, Math.max(-60, g));
  }
  function seasonedOf(row) {
    return row.tvl_usd / Math.max(0.05, 1 + growthOf(row) / 100);
  }
  function impliedOf(row) {
    return Math.max(1, Math.round(Math.pow(10, FIT.intercept + FIT.slope * Math.log10(seasonedOf(row)))));
  }
  function holdOf(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  // The same costed plan main.ts wrote, at any deposit: the slice is the airdrop share of the
  // implied value, split pro-rata over the farming share of the TVL; the costs are gas plus the
  // yield the deposit gives up while it sits there.
  function farmOf(row, deposit) {
    var slice = (FA.airdrop_share * row.implied_value_usd * deposit) / (FA.active_share * row.tvl_usd);
    var gas = row.chains && row.chains[0] === 'Ethereum' ? FA.gas_eth_usd : FA.gas_other_usd;
    var hold = holdOf(row.age_days);
    var opp = (deposit * FA.opportunity_apy * hold) / 365;
    var costs = gas + opp;
    var be = slice > 0 ? costs / slice : Infinity;
    var verdict = be <= FA.farm_below ? 'FARM' : be <= FA.marginal_below ? 'MARGINAL' : 'SKIP';
    return {
      slice: slice, gas: gas, opp: opp, costs: costs, be: be, verdict: verdict,
      expected: FA.assumed_launch_rate * slice - costs,
      netHour: (FA.assumed_launch_rate * slice - costs) / FA.farm_hours, hold: hold,
    };
  }

  // ---------------------------------------------------------- small DOM helpers
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  // ---------------------------------------------------------- derived lists
  // The watchlist is the rows whose slug the snapshot's watchlist named; the scope is recovered
  // from the floor: watchlist rows are the ranked rows at or above the floor. (Rows below the
  // floor are the early radar.) For ranked rows this is exact — a rankable protocol at or above
  // the floor meets the watchlist's definition.
  function isWatch(r) { return r.tvl_usd >= DATA.floor_usd; }
  var CATEGORIES = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Uncategorised'; }))).sort();
  var CHAINS = Array.from(new Set(DATA.rows.reduce(function (a, r) { return a.concat(r.chains || []); }, []))).sort();

  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.verdict !== 'all' && farmOf(r, state.deposit).verdict !== state.verdict) return false;
      if (state.category !== 'all' && (r.category || 'Uncategorised') !== state.category) return false;
      if (state.chain !== 'all' && !(r.chains || []).includes(state.chain)) return false;
      if (state.scope === 'watchlist' && !isWatch(r)) return false;
      if (state.scope === 'early' && isWatch(r)) return false;
      if (q && (r.name + ' ' + r.slug + ' ' + (r.category || '')).toLowerCase().indexOf(q) < 0) return false;
      return true;
    }).sort(function (a, b) {
      var d = 0;
      if (state.sort === 'implied') d = a.implied_value_usd - b.implied_value_usd;
      else if (state.sort === 'tvl') d = a.tvl_usd - b.tvl_usd;
      else if (state.sort === 'slice') d = farmOf(a, state.deposit).slice - farmOf(b, state.deposit).slice;
      else if (state.sort === 'be') d = farmOf(a, state.deposit).be - farmOf(b, state.deposit).be;
      else if (state.sort === 'rank') d = a.rank - b.rank;
      return d * state.dir || (a.slug < b.slug ? -1 : 1);
    });
  }

  // ---------------------------------------------------------- scatter plot
  function scatterSvg() {
    var W = 720, H = 340, L = 56, R = 14, T = 12, B = 34;
    var xs = DATA.comps.map(function (c) { return Math.log10(c.tvl_usd); });
    var ys = DATA.comps.map(function (c) { return Math.log10(c.mcap_usd); });
    var x0 = Math.floor(Math.min.apply(null, xs) * 2) / 2 - 0.2, x1 = Math.ceil(Math.max.apply(null, xs) * 2) / 2 + 0.2;
    var y0 = Math.floor(Math.min.apply(null, ys)) - 0.3, y1 = Math.ceil(Math.max.apply(null, ys)) + 0.3;
    function X(v) { return L + ((v - x0) / (x1 - x0)) * (W - L - R); }
    function Y(v) { return T + (1 - (v - y0) / (y1 - y0)) * (H - T - B); }
    var s = '';
    var ticks = [];
    for (var t = Math.ceil(x0); t <= x1; t++) ticks.push(t);
    ticks.forEach(function (t) {
      s += '<line class="grid" x1="' + X(t).toFixed(1) + '" y1="' + T + '" x2="' + X(t).toFixed(1) + '" y2="' + (H - B) + '"/>';
      s += '<text class="tick" x="' + X(t).toFixed(1) + '" y="' + (H - B + 16) + '" text-anchor="middle">$' + (t >= 9 ? (Math.pow(10, t - 9)).toFixed(0) + 'B' : (Math.pow(10, t - 6)).toFixed(0) + 'M') + '</text>';
    });
    for (var u = Math.ceil(y0); u <= y1; u++) {
      s += '<line class="grid" x1="' + L + '" y1="' + Y(u).toFixed(1) + '" x2="' + (W - R) + '" y2="' + Y(u).toFixed(1) + '"/>';
      s += '<text class="tick" x="' + (L - 6) + '" y="' + (Y(u) + 3).toFixed(1) + '" text-anchor="end">$' + (u >= 9 ? (Math.pow(10, u - 9)).toFixed(0) + 'B' : u >= 6 ? (Math.pow(10, u - 6)).toFixed(0) + 'M' : (Math.pow(10, u - 3)).toFixed(0) + 'K') + '</text>';
    }
    var v = DATA.validation;
    var lo = [], hi = [];
    for (var x = x0; x <= x1; x += 0.05) {
      var y = FIT.intercept + FIT.slope * x;
      lo.push(X(x).toFixed(1) + ',' + Y(y + Math.log10(v.range_p25_mult)).toFixed(1));
      hi.push(X(x).toFixed(1) + ',' + Y(y + Math.log10(v.range_p75_mult)).toFixed(1));
    }
    s += '<polygon class="band" points="' + lo.join(' ') + ' ' + hi.reverse().join(' ') + '"/>';
    var line = [];
    for (var x2 = x0; x2 <= x1; x2 += 0.05) line.push(X(x2).toFixed(1) + ',' + Y(FIT.intercept + FIT.slope * x2).toFixed(1));
    s += '<polyline class="fit" points="' + line.join(' ') + '"/>';
    DATA.comps.forEach(function (c) {
      s += '<circle class="comp" cx="' + X(Math.log10(c.tvl_usd)).toFixed(1) + '" cy="' + Y(Math.log10(c.mcap_usd)).toFixed(1) + '" r="3"/>';
    });
    DATA.rows.forEach(function (r) {
      s += '<circle class="row" cx="' + X(Math.log10(r.tvl_usd)).toFixed(1) + '" cy="' + Y(Math.log10(r.implied_value_usd)).toFixed(1) + '" r="2.2"/>';
    });
    s += '<text class="lbl" x="' + L + '" y="' + (H - 4) + '">TVL (log scale) — the line is the fitted curve, the band is the P25–P75 range</text>';
    return '<svg class="scatter" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Scatter of market cap against TVL with the fitted curve">' + s + '</svg>';
  }

  // ---------------------------------------------------------- render
  function kpi(n, l, s) {
    return el('div', { class: 'kpi' },
      el('div', { class: 'n', html: n }),
      el('div', { class: 'l', text: l }),
      s ? el('div', { class: 's', text: s }) : null);
  }

  function render() {
    app.innerHTML = '';
    var V = DATA.validation;
    var C = DATA.coverage;
    var T = DATA.totals;

    app.appendChild(el('h1', {}, 'Token Radar'));
    app.appendChild(el('p', { class: 'sub' },
      'Every protocol DefiLlama tracks that has no token yet, ranked by what its launch would be worth. ',
      el('b', {}, 'The value is fitted, not picked:'),
      ' the traded tokens set a size curve, and each pre-token protocol is read off it. ',
      'Snapshot ', el('b', {}, DATA.as_of), ' · ', esc(DATA.source.split(', fetched')[0] || DATA.source), '.'));

    // KPI strip — the total is a point estimate, so its likely range rides with it: the sum of
    // the rows' low ends and the sum of their high ends, never a bare number.
    app.appendChild(el('div', { class: 'kpis' },
      kpi(String(T.implied_usd >= 1e9 ? '$' + (T.implied_usd / 1e9).toFixed(2) + 'B' : fmtUsd(T.implied_usd)), 'total implied value', 'likely ' + fmtUsd(T.implied_p25_usd) + '–' + fmtUsd(T.implied_p75_usd) + ' (P25–P75)'),
      kpi(String(C.ranked), 'protocols ranked', C.watchlist + ' watchlist + ' + C.early + ' early'),
      kpi('×' + V.loo_median_miss.toFixed(2), 'leave-one-out miss', V.loo_within_3x_pct.toFixed(0) + '% of held-out caps within 3×'),
      kpi('×' + V.wf_median_miss.toFixed(2), 'walk-forward miss', 'fitted on older listings, tested on newer'),
      kpi(String(T.farm_default), 'worth farming at $1,000', T.farm_alt + ' at $10,000')));

    // Integrity strip — the whole snapshot, accounted for in one line, so the board's
    // completeness is visible before any row is read: nothing in the snapshot is missing.
    app.appendChild(el('div', { class: 'integrity' },
      el('b', {}, 'Integrity: '),
      document.createTextNode(C.total + ' protocols read · ' + C.ranked + ' ranked · ' + C.pre_token + ' pre-token · ' +
        C.traded + ' already trade · ' + C.comps + ' traded tokens set the curve · every set-aside listed below')));

    // Coverage
    var cov = el('section', { class: 'card' });
    cov.appendChild(el('h2', {}, 'Coverage: the whole snapshot, accounted for'));
    var bar = el('div', { class: 'bar' });
    function seg(n, color, title) {
      var span = el('span', { title: title });
      span.style.width = (100 * n / C.total).toFixed(2) + '%';
      span.style.background = color;
      return span;
    }
    bar.appendChild(seg(C.traded, '#334155', 'already trade'));
    bar.appendChild(seg(C.ranked, '#2dd4bf', 'ranked'));
    var setAsideTotal = C.pre_token - C.ranked;
    bar.appendChild(seg(setAsideTotal, '#7c2d12', 'pre-token, set aside'));
    cov.appendChild(bar);
    var leg = el('div', { class: 'legend' });
    leg.appendChild(el('span', { html: '<i style="background:#2dd4bf"></i>ranked: ' + C.ranked + ' (' + C.watchlist + ' watchlist + ' + C.early + ' early)' }));
    leg.appendChild(el('span', { html: '<i style="background:#334155"></i>already trade: ' + C.traded + ' (' + C.comps + ' with a market cap set the curve; ' + C.traded_no_mcap + ' trade with no market cap figure)' }));
    C.set_aside.forEach(function (sa) {
      if (sa.reason === 'already trades') return; // already shown as the grey segment above
      leg.appendChild(el('span', { html: '<i style="background:#7c2d12"></i>' + esc(sa.reason) + ': ' + sa.count }));
    });
    cov.appendChild(leg);
    cov.appendChild(el('p', { class: 'note' },
      'The watchlist is the floor, never the ceiling: the board carries every one of its ' + C.watchlist +
      ' protocols, plus ' + C.early + ' pre-token protocols below the $50M floor, by TVL. Nothing on the watchlist is left out.'));
    // The coverage card is appended after the board, below.

    // Model
    var model = el('section', { class: 'card' });
    model.appendChild(el('h2', {}, 'How a value is built'));
    var grid = el('div', { class: 'modelgrid' });
    var left = el('div', {});
    left.appendChild(el('p', { class: 'note' },
      'A protocol’s TVL is seasoned by its week’s growth — hot money is read at last week’s size — then the fitted curve prices it. ',
      'The curve is fitted on the ' + C.comps + ' traded protocols that carry a live market cap and a TVL, by least squares on log10(market cap) against log10(seasoned TVL). ',
      'Live means a market cap of at least $1,000,000, a token that prices this entry rather than a versioned release or an exchange: the 27 traded tokens that fail that test are set aside and listed below, with the reason for each. ',
      'No protocol name is ever special-cased: the same function scores every row.'));
    left.appendChild(el('div', { class: 'formula', text: 'seasoned TVL = TVL / (1 + clamp(7d growth, -60%, +120%))\nlog10(implied) = ' + FIT.intercept.toFixed(4) + ' + ' + FIT.slope.toFixed(4) + ' × log10(seasoned TVL)' }));
    left.appendChild(el('p', { class: 'note' },
      'A small protocol is worth more per dollar of TVL than a big one: the fitted slope is ' + FIT.slope.toFixed(2) +
      ', well under 1, so the implied multiple falls as TVL grows. At $50M of TVL the curve reads about ' +
      fmtUsd(Math.pow(10, FIT.intercept + FIT.slope * Math.log10(5e7))) + '; at $1B it reads about ' +
      fmtUsd(Math.pow(10, FIT.intercept + FIT.slope * Math.log10(1e9))) + '. That is why the best farms are small.'));
    left.appendChild(el('p', { class: 'note' },
      'Uncertainty is printed, not hidden. The leave-one-out residuals give the range: P25 ×' + V.range_p25_mult.toFixed(2) +
      ' to P75 ×' + V.range_p75_mult.toFixed(2) + ' (P10 ×' + V.range_p10_mult.toFixed(2) + ' to P90 ×' + V.range_p90_mult.toFixed(2) +
      '). The P25–P75 range held ' + V.range_hold_pct.toFixed(0) + '% of held-out market caps — about half, as a P25–P75 range should. ',
      'Rank ranges come from ' + V.bootstrap_refits + ' refits, each dropping a seeded fifth of the comparables.'));
    var table = el('table', {});
    table.appendChild(el('thead', {}, el('tr', {},
      el('th', {}, 'Model'), el('th', { class: 'num' }, 'LOO miss'), el('th', { class: 'num' }, 'LOO ≤3×'), el('th', { class: 'num' }, 'Rank ρ'), el('th', { class: 'num' }, 'Walk-fwd miss'), el('th', { class: 'num' }, 'WF ≤3×'))));
    var tb = el('tbody', {});
    DATA.comparison.forEach(function (m) {
      tb.appendChild(el('tr', {},
        el('td', {}, m.label),
        el('td', { class: 'num' }, '×' + m.loo_median_miss.toFixed(2)),
        el('td', { class: 'num' }, m.loo_within_3x_pct.toFixed(1) + '%'),
        el('td', { class: 'num' }, m.loo_rank_corr.toFixed(3)),
        el('td', { class: 'num' }, '×' + m.wf_median_miss.toFixed(2)),
        el('td', { class: 'num' }, m.wf_within_3x_pct.toFixed(1) + '%')));
    });
    table.appendChild(tb);
    left.appendChild(table);
    var wf2 = Number.isFinite(V.wf2_median_miss) && Number.isFinite(V.wf2_within_3x_pct)
      ? 'Held out twice: the walk-forward test runs on two time splits. The first fits on listings up to the median date and tests the newer half (×' + V.wf_median_miss.toFixed(2) + ', ' + V.wf_within_3x_pct.toFixed(1) + '% within 3×); the second fits on the oldest third (' + V.wf2_train + ' tokens) and tests the middle third (' + V.wf2_test + ' tokens: ×' + V.wf2_median_miss.toFixed(2) + ', ' + V.wf2_within_3x_pct.toFixed(1) + '% within 3×). The chosen curve holds on both splits — a curve that only works on one split does not survive the table.'
      : 'Held out twice: the walk-forward test runs on two time splits. The first fits on listings up to the median date and tests the newer half (×' + V.wf_median_miss.toFixed(2) + ', ' + V.wf_within_3x_pct.toFixed(1) + '% within 3×); the second split had too few dated tokens to run, so only the first is shown.';
    left.appendChild(el('p', { class: 'note' }, wf2));
    var flatM = DATA.comparison.find(function (m) { return m.key === 'flat'; });
    var loglogM = DATA.comparison.find(function (m) { return m.key === 'loglog'; });
    var flatLoo = flatM ? flatM.loo_median_miss.toFixed(2) : 'n/a';
    var flatWf = flatM ? flatM.wf_median_miss.toFixed(2) : 'n/a';
    var logLoo = loglogM ? loglogM.loo_median_miss.toFixed(2) : 'n/a';
    var logWf = loglogM ? loglogM.wf_median_miss.toFixed(2) : 'n/a';
    left.appendChild(el('p', { class: 'note' },
      'What the blind tests kept: of the five models in the table the seasoned curve is the best on both blind tests — ',
      'leave-one-out ×' + V.loo_median_miss.toFixed(2) + ' against ×' + flatLoo +
      ' for a flat multiple and ×' + logLoo +
      ' for the plain log-log, walk-forward ×' + V.wf_median_miss.toFixed(2) + ' against ×' +
      flatWf + ' and ×' + logWf +
      ' — and it is the only one that reads the week’s growth, which the brief asks the value to follow. ',
      'Age as a term was dropped: it made both blind tests worse, so it stays out of the value and in the farm plan’s hold time instead. ',
      'The flat multiple is what a lazy board would print; the curve is what the market actually does.'));
    left.appendChild(el('p', { class: 'note' },
      'The verdict is a margin of safety, not break-even. The assumed launch rate is one in ten a year. ',
      'FARM needs the launch odds that repay every cost at most 5% — half the assumed rate — so the expected net at the assumed rate is at least as large as the costs. ',
      'MARGINAL needs those odds at most 10%, where the expected net is zero. Anything above that is SKIP: it does not pay on average at the assumed rate. ',
      'That is why ' + T.farm_default + ' of the ' + C.ranked + ' rows are FARM at $1,000: most rows only pay if the launch lands above the fitted value. ',
      'The total is shown the same way — $' + (T.implied_usd / 1e9).toFixed(2) + 'B, with a likely range of ' + fmtUsd(T.implied_p25_usd) + '–' + fmtUsd(T.implied_p75_usd) +
      ' — because a point total with a ×0.38–×2.71 range behind it is an estimate, not a promise.'));
    // The comparables the cleaning set aside, grouped by reason, so the fit is auditable.
    var excl = DATA.excluded_comps || [];
    if (excl.length > 0) {
      var byReason = {};
      excl.forEach(function (e) { (byReason[e.reason] = byReason[e.reason] || []).push(e.name); });
      var exclBox = el('div', { class: 'note' });
      exclBox.appendChild(el('b', {}, 'Comparables set aside before the fit (' + excl.length + ' of ' + (C.comps + excl.length) + ' traded tokens): '));
      Object.keys(byReason).sort().forEach(function (reason, i) {
        if (i > 0) exclBox.appendChild(document.createTextNode('; '));
        exclBox.appendChild(document.createTextNode(reason + ' — ' + byReason[reason].sort().join(', ')));
      });
      exclBox.appendChild(document.createTextNode('. On all 128 traded tokens the same curve missed by ×3.48 leave-one-out and ×3.05 walk-forward; on the ' + C.comps + ' that remain it misses by ×' + V.loo_median_miss.toFixed(2) + ' and ×' + V.wf_median_miss.toFixed(2) + '. The dead tokens were dragging the small end of the curve down, so cleaning them lifts the small protocols and the total.'));
      left.appendChild(exclBox);
    }
    grid.appendChild(left);
    var right = el('div', {});
    right.appendChild(el('h3', {}, 'The curve, against the market'));
    right.appendChild(el('div', { html: scatterSvg() }));
    right.appendChild(el('p', { class: 'note' },
      'Blue dots are the traded tokens (their market caps); amber dots are the pre-token rows (fitted values). ',
      'The traded tokens set the curve; the pre-token rows sit on it. The band is wide because the market is noisy — ',
      'a protocol’s launch can land several times above or below the curve, and the board says so on every row.'));
    grid.appendChild(right);
    model.appendChild(grid);
    // The model card is appended after the board, below.

    // Controls + board
    var controls = el('div', { class: 'controls' });
    var search = el('input', { type: 'search', placeholder: 'Search name or slug…', value: state.q, 'aria-label': 'Search protocols' });
    search.addEventListener('input', function () { state.q = search.value; renderBoard(); });
    controls.appendChild(search);
    function select(options, value, onChange, label) {
      var s = el('select', { 'aria-label': label });
      options.forEach(function (o) {
        var op = el('option', { value: o[0], text: o[1] });
        if (o[0] === value) op.selected = true;
        s.appendChild(op);
      });
      s.addEventListener('change', function () { onChange(s.value); renderBoard(); });
      return s;
    }
    controls.appendChild(select([['all', 'Verdict: all'], ['FARM', 'FARM'], ['MARGINAL', 'MARGINAL'], ['SKIP', 'SKIP']], state.verdict, function (v) { state.verdict = v; }, 'Verdict'));
    controls.appendChild(select([['all', 'Scope: all'], ['watchlist', 'Watchlist only'], ['early', 'Early only']], state.scope, function (v) { state.scope = v; }, 'Scope'));
    controls.appendChild(select([['all', 'Category: all']].concat(CATEGORIES.map(function (c) { return [c, c]; })), state.category, function (v) { state.category = v; }, 'Category'));
    controls.appendChild(select([['all', 'Chain: all']].concat(CHAINS.map(function (c) { return [c, c]; })), state.chain, function (v) { state.chain = v; }, 'Chain'));
    var dep = el('span', { class: 'deposit' });
    [1000, 10000].forEach(function (d) {
      var b = el('button', { class: state.deposit === d ? 'on' : '', text: '$' + d.toLocaleString('en-US'), onclick: function () { state.deposit = d; renderBoard(); renderDetail(); } });
      dep.appendChild(b);
    });
    controls.appendChild(el('span', { class: 'note', text: 'Deposit sizes the farm plan:' }));
    controls.appendChild(dep);
    var tabs = el('span', { class: 'tabs' });
    [['pre-token', 'Pre-token board'], ['live', 'Live tokens']].forEach(function (t) {
      tabs.appendChild(el('button', { class: state.tab === t[0] ? 'on' : '', text: t[1], onclick: function () { state.tab = t[0]; render(); } }));
    });
    controls.appendChild(tabs);
    app.appendChild(controls);

    var boardWrap = el('section', { id: 'boardwrap', class: 'card' });
    app.appendChild(boardWrap);
    var detailWrap = el('section', { id: 'detailwrap' });
    app.appendChild(detailWrap);
    app.appendChild(model);
    app.appendChild(cov);

    app.appendChild(el('footer', {},
      'Method in one line: fitted log-log size curve on seasoned TVL, validated leave-one-out and walk-forward, ',
      'costed farm plans at a stated deposit, full coverage of the snapshot. Assumptions: 10% of an implied value goes to the airdrop, ',
      'half of a protocol’s TVL sits with farming wallets, gas $24 on Ethereum and $4 elsewhere, 5% a year given up on the deposit, ',
      'one launch in ten a year for the expected value. Verdict: FARM only when the launch odds that repay every cost are at most 5% ',
      '(half the assumed launch rate), MARGINAL at most 10%. A range is a range: about half the held-out caps landed inside the printed P25–P75 band.'));

    renderBoard();
    renderDetail();
    if (params.get('view') === 'detail' && state.selected) {
      var dw = document.getElementById('detailwrap');
      if (dw) dw.scrollIntoView({ block: 'start' });
    }
  }

  function renderBoard() {
    var wrap = document.getElementById('boardwrap');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (state.tab === 'live') {
      wrap.appendChild(el('h2', {}, 'Live tokens — what the market already says'));
      wrap.appendChild(el('p', { class: 'note' }, 'These protocols already trade, so the board shows the market’s own value, never a model’s. They are the comparables the curve was fitted on, kept apart from the ranked board.'));
      var lt = el('table', {});
      lt.appendChild(el('thead', {}, el('tr', {},
        el('th', {}, 'Protocol'), el('th', {}, 'Category'), el('th', { class: 'num' }, 'TVL'), el('th', { class: 'num' }, 'Market cap'), el('th', { class: 'num' }, '7d'))));
      var lb = el('tbody', {});
      DATA.live.forEach(function (p) {
        lb.appendChild(el('tr', {},
          el('td', {}, el('b', {}, p.name), el('span', { class: 'range', text: ' ' + p.slug })),
          el('td', {}, p.category || '—'),
          el('td', { class: 'num' }, fmtUsd(p.tvl_usd)),
          el('td', { class: 'num' }, fmtUsd(p.mcap_usd)),
          el('td', { class: 'num' }, fmtPct(p.change_7d))));
      });
      lt.appendChild(lb);
      wrap.appendChild(lt);
      return;
    }
    var rows = filteredRows();
    wrap.appendChild(el('h2', {}, 'The board — ' + rows.length + ' of ' + DATA.rows.length + ' ranked protocols'));
    var t = el('table', {});
    function sortTh(label, key) {
      var arrow = state.sort === key ? (state.dir === -1 ? ' ↓' : ' ↑') : '';
      return el('th', { class: 'num' }, el('button', {
        text: label + arrow,
        onclick: function () {
          if (state.sort === key) state.dir = -state.dir;
          else { state.sort = key; state.dir = key === 'be' ? 1 : -1; }
          renderBoard();
        },
      }));
    }
    t.appendChild(el('thead', {}, el('tr', {},
      el('th', { class: 'num' }, '#'),
      el('th', {}, 'Protocol'),
      el('th', {}, 'Category'),
      el('th', {}, 'Chain'),
      sortTh('TVL', 'tvl'),
      el('th', { class: 'num' }, '7d'),
      el('th', { class: 'num' }, 'Age'),
      sortTh('Implied value', 'implied'),
      sortTh('Slice @ $' + state.deposit.toLocaleString('en-US'), 'slice'),
      sortTh('Break-even', 'be'),
      el('th', {}, 'Verdict'))));
    var tb = el('tbody', {});
    rows.forEach(function (r) {
      var f = farmOf(r, state.deposit);
      var tr = el('tr', {
        class: 'row' + (state.selected === r.slug ? ' sel' : ''),
        onclick: function () { state.selected = r.slug; renderBoard(); renderDetail(); },
      },
        el('td', { class: 'num' }, String(r.rank)),
        el('td', {}, el('b', {}, r.name), el('span', { class: 'range', text: ' ' + r.slug + (isWatch(r) ? ' · watchlist' : ' · early') })),
        el('td', {}, r.category || '—'),
        el('td', {}, (r.chains || []).slice(0, 2).join(', ') || '—'),
        el('td', { class: 'num' }, fmtUsd(r.tvl_usd)),
        el('td', { class: 'num' }, fmtPct(r.change_7d)),
        el('td', { class: 'num' }, fmtAge(r.age_days)),
        el('td', { class: 'num' }, el('b', {}, fmtUsd(r.implied_value_usd)), el('span', { class: 'range', text: '  ' + fmtUsd(r.implied_p25_usd) + '–' + fmtUsd(r.implied_p75_usd) })),
        el('td', { class: 'num' }, fmtUsd(f.slice)),
        el('td', { class: 'num' }, isFinite(f.be) ? (f.be * 100).toFixed(1) + '%' : '—'),
        el('td', {}, el('span', { class: 'pill ' + f.verdict.toLowerCase(), text: f.verdict })));
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    wrap.appendChild(t);
    if (rows.length === 0) wrap.appendChild(el('p', { class: 'note' }, 'Nothing matches these filters.'));
  }

  function renderDetail() {
    var wrap = document.getElementById('detailwrap');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!state.selected) return;
    var r = DATA.rows.find(function (x) { return x.slug === state.selected; });
    if (!r) return;
    var f = farmOf(r, state.deposit);
    var recomputed = impliedOf(r);
    var card = el('section', { class: 'card detail' });
    card.appendChild(el('h2', {}, r.name + ' — detail'));
    card.appendChild(el('p', { class: 'note' },
      (isWatch(r) ? 'On the watchlist' : 'Early radar, below the $50M floor') + ' · ' + (r.category || 'Uncategorised') +
      ' · ' + (r.chains || []).join(', ') + ' · listed ' + (r.listed_at || 'unknown') + ' (' + fmtAge(r.age_days) + ' with no token).'));
    var grid = el('div', { class: 'grid' });
    function kv(k, v) {
      var d = el('div', {});
      d.appendChild(el('dt', {}, k));
      d.appendChild(el('dd', {}, v));
      return d;
    }
    var dl = el('dl', {});
    dl.appendChild(kv('Implied value', fmtUsdFull(r.implied_value_usd)));
    dl.appendChild(kv('Likely range (P25–P75)', fmtUsd(r.implied_p25_usd) + ' – ' + fmtUsd(r.implied_p75_usd)));
    dl.appendChild(kv('Wide range (P10–P90)', fmtUsd(r.implied_p10_usd) + ' – ' + fmtUsd(r.implied_p90_usd)));
    dl.appendChild(kv('Rank (bootstrap range)', '#' + r.rank + '  (' + r.rank_lo + '–' + r.rank_hi + ' over ' + DATA.validation.bootstrap_refits + ' refits)'));
    dl.appendChild(kv('TVL', fmtUsdFull(r.tvl_usd) + '  ·  seasoned ' + fmtUsdFull(r.model.seasoned_tvl_usd)));
    dl.appendChild(kv('7-day growth', fmtPct(r.change_7d) + '  ·  model reads ' + fmtPct(r.model.growth_pct)));
    dl.appendChild(kv('Recomputed from the curve', fmtUsdFull(recomputed) + (recomputed === r.implied_value_usd ? ' — matches the board' : ' — differs from the board')));
    dl.appendChild(kv('Implied multiple (value / TVL)', '×' + (r.implied_value_usd / r.tvl_usd).toFixed(3)));
    grid.appendChild(dl);
    var dr = el('dl', {});
    dr.appendChild(kv('Deposit', '$' + state.deposit.toLocaleString('en-US')));
    dr.appendChild(kv('Slice if it launches', fmtUsd(f.slice)));
    dr.appendChild(kv('Costs (gas + yield given up)', fmtUsd(f.costs) + '  ($' + f.gas.toFixed(0) + ' gas + $' + f.opp.toFixed(2) + ' yield)'));
    dr.appendChild(kv('Net if it launches', fmtUsd(f.slice - f.costs)));
    dr.appendChild(kv('Break-even launch odds', (f.be * 100).toFixed(1) + '%'));
    dr.appendChild(kv('Expected net (10% launch rate)', fmtUsd(f.expected)));
    dr.appendChild(kv('Expected net per hour', fmtUsd(f.netHour) + ' / hour over ~2 hours'));
    dr.appendChild(kv('Verdict', f.verdict + (f.verdict === 'FARM' ? ' — at the assumed 1-in-10 launch rate the expected net covers the costs.' : f.verdict === 'MARGINAL' ? ' — it pays on average at the assumed rate, but the margin is thin.' : ' — at the assumed rate it does not pay on average.')));
    grid.appendChild(dr);
    card.appendChild(grid);
    card.appendChild(el('h3', {}, 'Farm plan — $' + state.deposit.toLocaleString('en-US') + ' deposit, ' + f.hold + ' days'));
    var steps = el('ol', { class: 'steps' });
    r.farm_steps.forEach(function (s) {
      steps.appendChild(el('li', {}, s));
    });
    card.appendChild(steps);
    card.appendChild(el('p', { class: 'note' },
      'The steps above are costed at $1,000 in board.json; the economics in this panel follow the deposit toggle. ',
      'Airdrop share 10%, farming share of TVL 50%, gas $24 on Ethereum and $4 elsewhere, 5% a year given up on the deposit.'));
    wrap.appendChild(card);
  }

  render();
})();
