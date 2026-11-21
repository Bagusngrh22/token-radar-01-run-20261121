// Token Radar dashboard (radar-3). Reads window.RADAR from data.js —
// no fetch, no network. Sortable/filterable board, a detail view for
// every row (full model breakdown + farm plan), a Top-10 chart, and a
// separate live-token tab. The page recomputes each row's implied value
// from the snapshot figures and says whether it matches board.json.
(function () {
  'use strict';
  var DATA = window.RADAR;
  var root = document.getElementById('board');
  if (!DATA || !DATA.rows) { root.textContent = 'No radar data loaded.'; return; }

  var state = { q: '', cat: 'all', chain: 'all', wl: false, tab: 'board', sort: 'implied', dir: -1, sel: null };
  readHash();

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined) return;
      if (k === 'text') n.textContent = v;
      else if (k === 'onclick') n.addEventListener('click', v);
      else if (k === 'style') n.setAttribute('style', v);
      else n.setAttribute(k, v);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function fmtUsd(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + String(n);
  }
  function fmtPct(n) { return n === null || n === undefined ? '—' : (n > 0 ? '+' : '') + n.toFixed(1) + '%'; }
  function money(n) { return '$' + Math.round(n).toLocaleString('en-US'); }

  // --- the model, re-run in the page from the same figures ---
  function impliedOf(r, m) {
    var growth = Math.min(m.growthHigh, Math.max(m.growthLow, r.change_7d === null ? 0 : r.change_7d));
    var gMult = 1 + (growth / 100) * m.momentumWeight;
    var age = r.age_days === null ? m.ageWhenUnknown : r.age_days;
    var mat = m.stayingBase + (Math.min(Math.max(age, 0), m.stayingDays) / m.stayingDays) * m.stayingSpan;
    return Math.max(1, Math.round(r.tvl_usd * r.category_multiple * r.chain_multiplier * gMult * mat));
  }
  function stakeSize(r) {
    if (r.tvl_usd >= 5e9) return 250;
    if (r.tvl_usd >= 1e9) return 150;
    if (r.tvl_usd >= 1e8) return 100;
    return 50;
  }
  function holdDays(age) { if (age === null) return 30; if (age < 180) return 60; if (age < 365) return 45; return 30; }
  function coreAction(r, size, chain) {
    var c = (r.category || '').toLowerCase(), name = r.name;
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0) return 'Lend $' + size + ' of USDC on ' + name + ' (' + chain + ') and leave the supply position open.';
    if (c.indexOf('dex') >= 0 || c.indexOf('yield') >= 0) return 'Add $' + size + ' of liquidity to the main ' + name + ' pool on ' + chain + ' and keep it in range.';
    if (c.indexOf('bridge') >= 0) return 'Bridge $' + size + ' of USDC into ' + chain + ' through ' + name + ', then use the bridged funds inside its app.';
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return 'Stake $' + size + ' of the chain\'s staking asset through ' + name + ' and keep the receipt token.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0) return 'Post $' + size + ' of USDC as margin on ' + name + ' and open one small hedged position.';
    if (c.indexOf('prediction') >= 0) return 'Fund $' + size + ' on ' + name + ' and take one position in an active market.';
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) return 'Deposit $' + size + ' into a ' + name + ' vault on ' + chain + ' and hold the vault shares.';
    if (c.indexOf('stable') >= 0) return 'Mint or deposit $' + size + ' of the stable asset through ' + name + ' on ' + chain + '.';
    if (c.indexOf('rwa') >= 0) return 'Mint $' + size + ' of the yield-bearing asset on ' + name + ' (' + chain + ') and hold it.';
    if (c.indexOf('insurance') >= 0) return 'Buy $' + size + ' of cover from ' + name + ' on ' + chain + ' and keep the policy active.';
    return 'Deposit $' + size + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
  }
  function planFor(r) {
    var chain = (r.chains && r.chains[0]) || 'its main chain', size = stakeSize(r), hold = holdDays(r.age_days);
    var gas = size >= 150 ? 8 : 4;
    return [
      'Open a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline on paper. Cost: under $3 of gas for the first transaction. Time: 5 minutes.',
      coreAction(r, size, chain) + ' Cost: $' + size + ' of capital and about $' + gas + ' of gas. Time: 15 minutes to set up.',
      'Return once a week and do one real action — a deposit, a borrow, a swap or a vote — so the wallet reads as active, not dormant. Cost: about $2 of gas a week. Time: 10 minutes a week.',
      'Keep the position open for at least ' + hold + ' days, so it is counted in more than one snapshot of activity. Cost: the $' + size + ' stays in the position. Time: ' + hold + ' days.',
      'Check the protocol\'s own points or rewards page before you move anything, and claim only from a link that page itself publishes. Cost: no fee to check, and never pay to claim. Time: 10 minutes.',
      'Log the wallet, the dates and every transaction hash, so you can repeat the position or unwind it cleanly later. Cost: nothing but the log. Time: 5 minutes.',
      'Re-check the radar each week: if TVL falls more than 30% in 7 days, unwind half the position; if a token appears, claim only from the protocol\'s own page. Cost: nothing but the check. Time: 5 minutes a week.'
    ];
  }

  // --- hash state, so a screenshot URL can open a filtered / detail view ---
  function readHash() {
    var p = new URLSearchParams(location.hash.slice(1));
    if (p.get('q')) state.q = p.get('q');
    if (p.get('cat')) state.cat = p.get('cat');
    if (p.get('chain')) state.chain = p.get('chain');
    if (p.get('wl') === '1') state.wl = true;
    if (p.get('tab')) state.tab = p.get('tab');
    if (p.get('sel')) state.sel = p.get('sel');
  }
  function writeHash() {
    var p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.cat !== 'all') p.set('cat', state.cat);
    if (state.chain !== 'all') p.set('chain', state.chain);
    if (state.wl) p.set('wl', '1');
    if (state.tab !== 'board') p.set('tab', state.tab);
    if (state.sel) p.set('sel', state.sel);
    history.replaceState(null, '', '#' + p.toString());
  }

  function visibleRows() {
    var q = state.q.trim().toLowerCase();
    var rows = DATA.rows.filter(function (r) {
      if (q && r.name.toLowerCase().indexOf(q) === -1 && r.slug.indexOf(q) === -1) return false;
      if (state.cat !== 'all' && (r.category || 'Other') !== state.cat) return false;
      if (state.chain !== 'all' && !(r.chains || []).includes(state.chain)) return false;
      if (state.wl && !r.on_watchlist) return false;
      return true;
    });
    var key = state.sort === 'tvl' ? 'tvl_usd' : state.sort === 'growth' ? 'change_7d' : 'implied_value_usd';
    // dir -1 = largest first (the board's own order for implied value),
    // dir +1 = smallest first. Null growth sorts last either way.
    rows.sort(function (a, b) {
      var av = a[key] === null ? -Infinity : a[key], bv = b[key] === null ? -Infinity : b[key];
      return state.dir === -1 ? bv - av : av - bv;
    });
    return rows;
  }

  function sortBtn(label, key) {
    var arrow = state.sort === key ? (state.dir === -1 ? ' ↓' : ' ↑') : '';
    return el('button', { type: 'button', text: label + arrow, onclick: function () {
      if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; }
      render();
    } });
  }

  function topTen() {
    var top = DATA.rows.slice(0, 10), max = top[0].implied_value_usd || 1;
    return el('section', { class: 'panel', 'aria-label': 'Top 10 by implied value' }, [
      el('h2', { text: 'Top 10 by implied value' }),
      el('p', { class: 'sub', text: 'The ten launches this radar values highest. Click a name to open its detail view and farm plan.' })
    ].concat(top.map(function (r) {
      return el('div', { class: 'chart-row' }, [
        el('span', { class: 'num', text: '#' + r.rank }),
        el('button', { type: 'button', text: r.name, onclick: function () { state.sel = r.slug; writeHash(); render(); } }),
        el('div', { class: 'bar', 'aria-hidden': 'true' }, [el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })]),
        el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
      ]);
    })));
  }

  function detailView(row) {
    var again = impliedOf(row, DATA.model);
    var ok = again === row.implied_value_usd;
    var m = DATA.model;
    var grid = el('div', { class: 'detail' }, [
      el('div', null, [el('span', { text: 'Implied value' }), el('b', { class: 'num', text: money(row.implied_value_usd) })]),
      el('div', null, [el('span', { text: 'TVL (rank of ' + DATA.rows.length + ' board rows)' }), el('b', { class: 'num', text: money(row.tvl_usd) + ' · #' + row.tvl_rank })]),
      el('div', null, [el('span', { text: 'Category multiple' }), el('b', { class: 'num', text: row.category_multiple.toFixed(4) })]),
      el('div', null, [el('span', { text: 'Chain multiplier' }), el('b', { class: 'num', text: row.chain_multiplier.toFixed(2) + ' · ' + (row.chains || []).length + ' chain(s)' })]),
      el('div', null, [el('span', { text: '7-day change' }), el('b', { class: row.change_7d !== null && row.change_7d < 0 ? 'neg' : 'pos', text: fmtPct(row.change_7d) })]),
      el('div', null, [el('span', { text: 'Growth multiplier' }), el('b', { class: 'num', text: row.growth_multiplier.toFixed(4) })]),
      el('div', null, [el('span', { text: 'Maturity multiplier' }), el('b', { class: 'num', text: row.maturity_multiplier.toFixed(4) })]),
      el('div', null, [el('span', { text: 'Age (listed)' }), el('b', { class: 'num', text: row.age_days === null ? 'unknown' : row.age_days + ' days' })])
    ]);
    var steps = el('ol', { class: 'farm' }, planFor(row).map(function (s) { return el('li', { text: s }); }));
    return el('section', { class: 'panel', id: 'detail' }, [
      el('h2', { text: '#' + row.rank + ' — ' + row.name + (row.on_watchlist ? ' · watchlist' : ' · early') }),
      el('p', { class: 'sub', text: (row.category || 'Other') + ' · ' + ((row.chains || []).join(', ') || 'no chain listed') + ' · records no token (per the snapshot — not proof it has none).' }),
      grid,
      el('p', { class: 'sub', text: 'Model ' + DATA.model_version + ': implied = round(TVL × category multiple × chain multiplier × growth multiplier × maturity multiplier). This page recomputes it as ' + money(again) + (ok ? ', the same number board.json carries.' : ', which differs from board.json — the data would be stale.') + ' An estimate, not a price.' }),
      el('p', { class: 'sub', text: 'Plan total: $' + stakeSize(row) + ' of capital plus about $' + (stakeSize(row) >= 150 ? 8 : 4) + ' of gas to set up, then about $2 of gas a week, held at least ' + holdDays(row.age_days) + ' days.' }),
      el('h2', { text: 'How to farm it' }),
      steps,
      el('button', { type: 'button', text: 'Close detail', onclick: function () { state.sel = null; writeHash(); render(); } })
    ]);
  }

  function render() {
    root.innerHTML = '';
    var wrap = el('div', { class: 'wrap' });
    var hero = el('header', { class: 'hero' }, [
      el('h1', { text: 'Token Radar — pre-token protocols, ranked by implied value' }),
      el('p', { text: 'Which protocol without a token yet would its launch be worth most — and what to do about it. Snapshot ' + DATA.as_of + ' · ' + DATA.rows.length + ' board rows · watchlist floor $' + (DATA.floor_usd / 1e6) + 'M TVL. Values are this radar\'s own estimates from the snapshot\'s figures, never a price.' }),
      el('div', { class: 'stats' }, [
        el('div', { class: 'stat' }, [el('b', { text: String(DATA.board_size) }), el('span', { text: 'board rows' })]),
        el('div', { class: 'stat' }, [el('b', { text: String(DATA.watchlist_size) }), el('span', { text: 'watchlist covered' })]),
        el('div', { class: 'stat' }, [el('b', { text: String(DATA.early_size) }), el('span', { text: 'early (below floor)' })]),
        el('div', { class: 'stat' }, [el('b', { text: String(DATA.live_size) }), el('span', { text: 'live tokens, set aside' })]),
        el('div', { class: 'stat' }, [el('b', { text: fmtUsd(DATA.rows[0].implied_value_usd) }), el('span', { text: 'top implied value' })])
      ])
    ]);
    wrap.appendChild(hero);

    var tabs = el('div', { class: 'tabs', role: 'tablist' }, [
      el('button', { type: 'button', role: 'tab', 'aria-selected': state.tab === 'board' ? 'true' : 'false', text: 'Board (' + DATA.rows.length + ')', onclick: function () { state.tab = 'board'; writeHash(); render(); } }),
      el('button', { type: 'button', role: 'tab', 'aria-selected': state.tab === 'live' ? 'true' : 'false', text: 'Live tokens (' + DATA.live.length + ')', onclick: function () { state.tab = 'live'; writeHash(); render(); } }),
      el('button', { type: 'button', role: 'tab', 'aria-selected': state.tab === 'model' ? 'true' : 'false', text: 'How the model works', onclick: function () { state.tab = 'model'; writeHash(); render(); } })
    ]);
    wrap.appendChild(tabs);

    if (state.tab === 'live') {
      var liveRows = DATA.live.map(function (p) {
        return el('tr', null, [
          el('td', { text: p.name }), el('td', { text: p.category || 'Other' }),
          el('td', { class: 'num', text: money(p.tvl_usd) }),
          el('td', { class: 'num', text: p.mcap_usd === null ? '—' : money(p.mcap_usd) }),
          el('td', { class: p.change_7d !== null && p.change_7d < 0 ? 'neg' : 'pos', text: fmtPct(p.change_7d) })
        ]);
      });
      wrap.appendChild(el('section', { class: 'panel' }, [
        el('h2', { text: 'Already trading — shown at the market\'s own value' }),
        el('p', { class: 'sub', text: 'These protocols already record a token, so they are never ranked by implied value. They are here so the board\'s pre-token rows are not confused with traded ones.' }),
        el('table', null, [el('thead', null, [el('tr', null, [el('th', { text: 'Protocol' }), el('th', { text: 'Category' }), el('th', { text: 'TVL' }), el('th', { text: 'Market cap' }), el('th', { text: '7d' })])]), el('tbody', null, liveRows)])
      ]));
    } else if (state.tab === 'model') {
      var m = DATA.model;
      wrap.appendChild(el('section', { class: 'panel' }, [
        el('h2', { text: 'How the model works — radar-3' }),
        el('pre', { text: 'implied = round( TVL x category_multiple x chain_multiplier x (1 + clamp(change_7d, ' + m.growthLow + ', ' + m.growthHigh + ') / 100 x ' + m.momentumWeight + ') x (' + m.stayingBase + ' + min(age_days, ' + m.stayingDays + ') / ' + m.stayingDays + ' x ' + m.stayingSpan + ') )' }),
        el('p', { class: 'sub', text: 'The category multiple is the median market-cap / TVL of the live-token protocols in the same category, read from this snapshot (global median ' + DATA.global_multiple.toFixed(4) + ' when a category has fewer than ' + m.minLiveForOwnMultiple + ' live protocols), clamped to ' + m.multipleLow + '–' + m.multipleHigh + '. The chain multiplier adds ' + (m.reachPerChain * 100) + '% per extra chain, up to ' + m.reachCapChains + ' chains. Age is the time since the protocol was first listed — the best record of how long it has run with no token; an unlisted age uses ' + m.ageWhenUnknown + ' days. No protocol name is special-cased: the same function scores every row.' }),
        el('p', { class: 'sub', text: 'The watchlist is the floor, never the ceiling: all ' + DATA.watchlist_size + ' watchlist protocols are on the board, plus ' + DATA.early_size + ' rankable pre-token protocols below the $' + (DATA.floor_usd / 1e6) + 'M floor, by TVL. "Records no token" is what the snapshot says — a protocol on the list may still have a token its record does not carry.' })
      ]));
      wrap.appendChild(topTen());
    } else {
      wrap.appendChild(topTen());
      var cats = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
      var chains = Array.from(new Set(DATA.rows.reduce(function (a, r) { return a.concat(r.chains || []); }, []))).sort();
      var q = el('input', { type: 'search', id: 'q', placeholder: 'Search name or slug…', value: state.q, 'aria-label': 'Search protocols' });
      q.addEventListener('input', function () { state.q = q.value; writeHash(); render(); });
      var catSel = el('select', { id: 'cat', 'aria-label': 'Filter by category' }, [el('option', { value: 'all', text: 'All categories' })].concat(cats.map(function (c) { return el('option', { value: c, text: c, selected: c === state.cat ? 'selected' : null }); })));
      catSel.addEventListener('change', function () { state.cat = catSel.value; writeHash(); render(); });
      var chainSel = el('select', { id: 'chain', 'aria-label': 'Filter by chain' }, [el('option', { value: 'all', text: 'All chains' })].concat(chains.map(function (c) { return el('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null }); })));
      chainSel.addEventListener('change', function () { state.chain = chainSel.value; writeHash(); render(); });
      var wlBtn = el('button', { type: 'button', 'aria-pressed': state.wl ? 'true' : 'false', text: 'Watchlist only', onclick: function () { state.wl = !state.wl; writeHash(); render(); } });
      var clearBtn = el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.cat = 'all'; state.chain = 'all'; state.wl = false; writeHash(); render(); } });
      wrap.appendChild(el('section', { class: 'panel' }, [
        el('div', { class: 'controls' }, [
          el('div', null, [el('label', { for: 'q', text: 'Search' }), q]),
          el('div', null, [el('label', { for: 'cat', text: 'Category' }), catSel]),
          el('div', null, [el('label', { for: 'chain', text: 'Chain' }), chainSel]),
          el('div', null, [el('label', { text: 'Scope' }), wlBtn])
        ]),
        el('p', { class: 'sub', text: 'Filters apply together; the count below updates as you type. ' }),
        clearBtn
      ]));

      var rows = visibleRows();
      var body = rows.map(function (r) {
        var tr = el('tr', null, [
          el('td', { class: 'num', text: '#' + r.rank }),
          el('td', null, [el('b', { text: r.name }), el('br'), el('span', { class: 'sub', text: (r.category || 'Other') + ' · ' + ((r.chains || []).slice(0, 2).join(', ') || '—') })]),
          el('td', null, [el('span', { class: r.on_watchlist ? 'tag' : 'tag early', text: r.on_watchlist ? 'watchlist' : 'early' })]),
          el('td', { class: 'num', text: fmtUsd(r.implied_value_usd) }),
          el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
          el('td', { class: r.change_7d !== null && r.change_7d < 0 ? 'neg' : 'pos', text: fmtPct(r.change_7d) })
        ]);
        tr.setAttribute('tabindex', '0');
        tr.addEventListener('click', function () { state.sel = r.slug; writeHash(); render(); });
        tr.addEventListener('keydown', function (e) { if (e.key === 'Enter') { state.sel = r.slug; writeHash(); render(); } });
        return tr;
      });
      var table = el('table', null, [
        el('thead', null, [el('tr', null, [
          el('th', null, [sortBtn('Rank', 'implied')]),
          el('th', { text: 'Protocol' }), el('th', { text: 'List' }),
          el('th', null, [sortBtn('Implied value', 'implied')]),
          el('th', null, [sortBtn('TVL', 'tvl')]),
          el('th', null, [sortBtn('7d', 'growth')])
        ])]),
        el('tbody', null, body)
      ]);
      var boardPanel = el('section', { class: 'panel' }, [
        el('h2', { text: 'Board — ' + rows.length + ' of ' + DATA.rows.length + ' rows' }),
        el('p', { class: 'sub', text: 'Click any row for its full model breakdown and farm plan. Sort by rank, implied value, TVL or 7-day change.' }),
        table
      ]);
      wrap.appendChild(boardPanel);
      var sel = state.sel ? DATA.rows.find(function (r) { return r.slug === state.sel; }) : null;
      if (sel) wrap.appendChild(detailView(sel));
    }
    root.appendChild(wrap);
    root.setAttribute('aria-busy', 'false');
    window.__shotReady = true;
    if (state.sel) {
      var d = document.getElementById('detail');
      if (d) d.scrollIntoView();
    }
  }
  render();
})();
