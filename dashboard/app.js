// Launch Radar page: renders window.RADAR (written by main.ts beside this page) as a sortable,
// filterable board of pre-token protocols, a detail view per protocol with its model breakdown and
// farm plan, and a comparison view of the protocols whose token already trades. No network, no
// framework: the data script is the only input.

'use strict';

const R = window.RADAR;
const main = document.getElementById('board');

const params = new URLSearchParams(location.search);
const state = {
  view: params.get('view') === 'live' ? 'live' : 'board',
  q: params.get('q') ?? '',
  category: params.get('category') ?? '',
  chain: params.get('chain') ?? '',
  minTvl: Number(params.get('minTvl') ?? 0),
  watchlistOnly: params.get('watchlist') === '1',
  sort: params.get('sort') ?? 'rank',
  dir: 1,
  detail: params.get('detail') ?? '',
};

/** $1.24B, $312M, $45.2K, $980: the board's one money format. */
function fmtUsd(n) {
  if (n === null || n === undefined) return '—';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${Math.round(n)}`;
}

/** A signed percent, or an em dash when the snapshot reports none. */
function fmtPct(n) {
  if (n === null || n === undefined) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
}

/** An age in days as years and months, or "not reported". */
function fmtAge(days) {
  if (days === null || days === undefined) return 'not reported';
  if (days < 60) return `${days}d`;
  if (days < 730) return `${Math.round(days / 30.4)} mo`;
  return `${(days / 365.25).toFixed(1)} yrs`;
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

const categories = [...new Set(R.rows.map((r) => r.category).filter(Boolean))].sort();
const chains = [...new Set(R.rows.flatMap((r) => r.chains))].sort();

function header() {
  const wrap = el('div');
  const mast = el('header', 'masthead');
  mast.append(el('p', 'eyebrow', 'Launch Radar'));
  mast.append(el('h1', '', 'Which token launch is worth farming next?'));
  const lede = el('p', 'lede');
  lede.innerHTML =
    `Every protocol in the sealed DefiLlama snapshot of <strong>${R.as_of}</strong> that <strong>records no token yet</strong>, ` +
    `screened so no wrapped, staked or bridged product of a trading token sneaks in, and ranked by <strong>implied value</strong>: ` +
    `what a launch would be worth if the protocol's record stayed as it is. Each row opens a detail view with the model's ` +
    `working and a farm plan with costs and times. The watchlist is the floor, never the ceiling: the board also carries ` +
    `the early protocols below the $${Math.round(R.floor_usd / 1e6)}M line.`;
  mast.append(lede);
  const stats = el('div', 'stats');
  const figures = [
    [String(R.protocol_count), 'protocols scanned'],
    [String(R.watchlist_size), 'on the watchlist'],
    [String(R.board_size), 'ranked on the board'],
    [String(R.early_size), 'early, below the floor'],
    [fmtUsd(R.rows.length ? R.rows[0].implied_value_usd : 0), 'top implied value'],
  ];
  for (const [num, lab] of figures) {
    const s = el('div', 'stat');
    s.append(el('div', 'num', num), el('div', 'lab', lab));
    stats.append(s);
  }
  mast.append(stats);
  wrap.append(mast);

  const model = el('section', 'model');
  model.append(el('h2', '', `The value model (${R.model_version}): priced from the snapshot's own traded protocols`));
  const formula = el('p', 'formula', 'implied value = TVL × category multiple × growth factor × seasoning factor × breadth factor');
  model.append(formula);
  const explain = el('p');
  explain.textContent =
    `The category multiple is learned, not chosen: for each category it is the median market-cap/TVL ratio of that ` +
    `category's protocols whose token already trades, shrunk toward the universe median (${R.overall_multiple}×) by how few ` +
    `traded peers the category has, and clamped to 0.03–2.0×. The growth factor moves ±60% of the protocol's own 7-day TVL ` +
    `change; the seasoning factor pays up to +35% for a four-year no-token track record; the breadth factor adds 4% per ` +
    `extra chain, capped at +20%. No protocol name is special-cased: one function prices every row, and every factor of ` +
    `every row is printed in its detail view.`;
  model.append(explain);
  const prices = el('div', 'prices');
  for (const p of R.category_prices.slice(0, 10)) {
    const s = el('span');
    const b = el('b', '', `${p.category} ${p.multiple}×`);
    s.append(b, document.createTextNode(` (${p.peers} traded peers)`));
    prices.append(s);
  }
  model.append(prices);
  wrap.append(model);
  return wrap;
}

function controls() {
  const bar = el('div', 'controls');
  const search = el('div', 'field');
  search.append(el('label', '', 'Search'));
  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = 'Protocol name or slug';
  input.value = state.q;
  input.addEventListener('input', () => { state.q = input.value; renderTable(); });
  search.append(input);
  bar.append(search);

  const cat = el('div', 'field');
  cat.append(el('label', '', 'Category'));
  const catSel = document.createElement('select');
  catSel.append(new Option('All categories', ''));
  for (const c of categories) catSel.append(new Option(c, c));
  catSel.value = state.category;
  catSel.addEventListener('change', () => { state.category = catSel.value; renderTable(); });
  cat.append(catSel);
  bar.append(cat);

  const ch = el('div', 'field');
  ch.append(el('label', '', 'Chain'));
  const chSel = document.createElement('select');
  chSel.append(new Option('All chains', ''));
  for (const c of chains) chSel.append(new Option(c, c));
  chSel.value = state.chain;
  chSel.addEventListener('change', () => { state.chain = chSel.value; renderTable(); });
  ch.append(chSel);
  bar.append(ch);

  const tvl = el('div', 'field');
  tvl.append(el('label', '', 'Min TVL'));
  const tvlSel = document.createElement('select');
  for (const [lab, v] of [['Any size', 0], ['$5M+', 5e6], ['$25M+', 25e6], ['$50M+ (the floor)', 5e7], ['$250M+', 25e7], ['$1B+', 1e9]]) {
    tvlSel.append(new Option(lab, String(v)));
  }
  tvlSel.value = String(state.minTvl);
  tvlSel.addEventListener('change', () => { state.minTvl = Number(tvlSel.value); renderTable(); });
  tvl.append(tvlSel);
  bar.append(tvl);

  const check = el('label', 'check');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = state.watchlistOnly;
  box.addEventListener('change', () => { state.watchlistOnly = box.checked; renderTable(); });
  check.append(box, document.createTextNode('Watchlist only'));
  bar.append(check);

  const views = el('div', 'views');
  const boardBtn = el('button', '', 'Pre-token board');
  boardBtn.setAttribute('aria-pressed', String(state.view === 'board'));
  boardBtn.addEventListener('click', () => { state.view = 'board'; syncViews(); renderTable(); });
  const liveBtn = el('button', '', 'Already trading');
  liveBtn.setAttribute('aria-pressed', String(state.view === 'live'));
  liveBtn.addEventListener('click', () => { state.view = 'live'; syncViews(); renderTable(); });
  views.append(boardBtn, liveBtn);
  bar.append(views);
  bar.dataset.role = 'controls';
  return bar;
}

let boardBtnRef = null;
let liveBtnRef = null;
function syncViews() {
  if (boardBtnRef) boardBtnRef.setAttribute('aria-pressed', String(state.view === 'board'));
  if (liveBtnRef) liveBtnRef.setAttribute('aria-pressed', String(state.view === 'live'));
}

const COLUMNS = [
  ['rank', '#'],
  ['name', 'Protocol'],
  ['category', 'Category'],
  ['chains', 'Chains'],
  ['tvl_usd', 'TVL'],
  ['change_7d', '7d'],
  ['age_days', 'Age'],
  ['implied_value_usd', 'Implied value'],
];

function visibleRows() {
  const q = state.q.trim().toLowerCase();
  let rows = R.rows.filter((r) =>
    (!q || r.name.toLowerCase().includes(q) || r.slug.includes(q)) &&
    (!state.category || r.category === state.category) &&
    (!state.chain || r.chains.includes(state.chain)) &&
    r.tvl_usd >= state.minTvl &&
    (!state.watchlistOnly || r.watchlist));
  const key = state.sort;
  const dir = state.dir;
  rows = [...rows].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (typeof av === 'string') return dir * av.localeCompare(bv);
    if (Array.isArray(av) && Array.isArray(bv)) return dir * (av.length - bv.length || av.join().localeCompare(bv.join()));
    return dir * ((av ?? -Infinity) - (bv ?? -Infinity));
  });
  return rows;
}

function boardTable() {
  const rows = visibleRows();
  const table = el('table');
  const thead = el('thead');
  const htr = el('tr');
  for (const [key, lab] of COLUMNS) {
    const th = el('th', state.sort === key ? 'sorted' : '', lab + (state.sort === key ? (state.dir === 1 ? ' ↑' : ' ↓') : ''));
    th.addEventListener('click', () => {
      if (state.sort === key) state.dir = -state.dir;
      else { state.sort = key; state.dir = key === 'rank' || key === 'name' ? 1 : -1; }
      renderTable();
    });
    htr.append(th);
  }
  thead.append(htr);
  table.append(thead);
  const tbody = el('tbody');
  if (rows.length === 0) {
    const tr = el('tr');
    const td = el('td', 'empty', 'No protocol matches these filters. Loosen one and the radar sweeps again.');
    td.colSpan = COLUMNS.length;
    tr.append(td);
    tbody.append(tr);
  }
  for (const r of rows) {
    const tr = el('tr');
    tr.tabIndex = 0;
    tr.append(el('td', 'rank', String(r.rank)));
    const nameTd = el('td');
    const nameSpan = el('span', 'name', r.name);
    nameTd.append(nameSpan);
    if (r.watchlist) nameTd.append(el('span', 'badge', 'Watchlist'));
    nameTd.append(el('span', 'slug', r.slug));
    tr.append(nameTd);
    tr.append(el('td', 'cat', r.category ?? '—'));
    tr.append(el('td', 'chains', r.chains.slice(0, 3).join(', ') + (r.chains.length > 3 ? ` +${r.chains.length - 3}` : '')));
    tr.append(el('td', '', fmtUsd(r.tvl_usd)));
    const chg = el('td', r.change_7d === null ? '' : r.change_7d >= 0 ? 'up' : 'down', fmtPct(r.change_7d));
    tr.append(chg);
    tr.append(el('td', '', fmtAge(r.age_days)));
    tr.append(el('td', 'implied', fmtUsd(r.implied_value_usd)));
    const open = () => openDetail(r);
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    tbody.append(tr);
  }
  table.append(tbody);
  return table;
}

function liveTable() {
  const table = el('table');
  const thead = el('thead');
  const htr = el('tr');
  for (const lab of ['Protocol', 'Category', 'TVL', 'Market cap', '7d', 'Mcap / TVL']) {
    htr.append(el('th', '', lab));
  }
  thead.append(htr);
  table.append(thead);
  const tbody = el('tbody');
  for (const r of R.live) {
    const tr = el('tr');
    const nameTd = el('td');
    nameTd.append(el('span', 'name', r.name), el('span', 'slug', r.slug));
    tr.append(nameTd);
    tr.append(el('td', 'cat', r.category ?? '—'));
    tr.append(el('td', '', fmtUsd(r.tvl_usd)));
    tr.append(el('td', 'implied', fmtUsd(r.mcap_usd)));
    tr.append(el('td', r.change_7d === null ? '' : r.change_7d >= 0 ? 'up' : 'down', fmtPct(r.change_7d)));
    tr.append(el('td', '', r.ratio === null ? '—' : `${r.ratio}×`));
    tbody.append(tr);
  }
  table.append(tbody);
  return table;
}

function openDetail(r) {
  closeDetail();
  const scrim = el('div', 'scrim');
  scrim.addEventListener('click', closeDetail);
  scrim.dataset.role = 'scrim';
  const panel = el('aside', 'detail');
  panel.dataset.role = 'detail';
  const close = el('button', 'close', 'Close');
  close.addEventListener('click', closeDetail);
  panel.append(close);
  panel.append(el('h2', '', r.name));
  panel.append(el('p', 'sub', `${r.slug} · rank #${r.rank} of ${R.board_size}${r.watchlist ? ' · on the snapshot watchlist' : ' · early, below the watchlist floor'}`));
  const kv = el('div', 'kv');
  const pairs = [
    ['Implied value', fmtUsd(r.implied_value_usd)],
    ['TVL', fmtUsd(r.tvl_usd)],
    ['7-day TVL change', fmtPct(r.change_7d)],
    ['Running, no token recorded', fmtAge(r.age_days)],
    ['Category', r.category ?? 'none recorded'],
    ['Chains', r.chains.join(', ') || 'none recorded'],
  ];
  for (const [k, v] of pairs) {
    const d = el('div');
    d.append(el('div', 'k', k), el('div', 'v', v));
    kv.append(d);
  }
  panel.append(kv);

  panel.append(el('h3', '', 'How this value is built'));
  const intro = el('p');
  intro.textContent =
    `${fmtUsd(r.tvl_usd)} of TVL, priced at the ${r.category ?? 'universe'} multiple of ${r.model.category_multiple}× ` +
    `(the median of ${r.model.category_peers} traded peers, shrunk toward the universe median), then moved by its own ` +
    `7-day growth, its track record and its chain breadth. The factors multiply to the implied value above; nothing ` +
    `about ${r.name} itself is an input beyond its own record.`;
  panel.append(intro);
  const factors = el('table', 'factors');
  const frows = [
    ['TVL', fmtUsd(r.tvl_usd)],
    [`Category multiple (${r.model.category_peers} traded peers)`, `${r.model.category_multiple}×`],
    [`Growth factor (${r.model.growth_pct === null ? 'no change reported' : fmtPct(r.model.growth_pct) + ' in 7 days'})`, `${r.model.growth_factor}×`],
    [`Seasoning factor (${fmtAge(r.age_days)} with no token recorded)`, `${r.model.seasoning_factor}×`],
    [`Breadth factor (${r.chains.length} chain${r.chains.length === 1 ? '' : 's'})`, `${r.model.breadth_factor}×`],
    ['Implied value', fmtUsd(r.implied_value_usd)],
  ];
  for (const [k, v] of frows) {
    const tr = el('tr');
    tr.append(el('td', '', k), el('td', '', v));
    factors.append(tr);
  }
  panel.append(factors);

  panel.append(el('h3', '', 'The farm plan'));
  const note = el('p');
  note.textContent = 'Concrete steps, priced with the model\'s stated gas figures. A plan is a starting brief, not a promise: a launch may never come, and the implied value is this board\'s claim, not a forecast.';
  panel.append(note);
  const plan = el('ol', 'plan');
  for (const step of r.farm_steps) plan.append(el('li', '', step));
  panel.append(plan);

  document.body.append(scrim, panel);
}

function closeDetail() {
  for (const node of document.querySelectorAll('[data-role="scrim"], [data-role="detail"]')) node.remove();
}

const tableHost = el('div');
const countLine = el('p', 'count');

function renderTable() {
  tableHost.replaceChildren();
  countLine.replaceChildren();
  if (state.view === 'live') {
    countLine.textContent = `${R.live_size} protocols whose token already trades, by market cap. The model never ranks these: they are its calibration set, shown at the market's own values.`;
    tableHost.append(liveTable());
  } else {
    const rows = visibleRows();
    countLine.textContent = `Showing ${rows.length} of ${R.board_size} ranked protocols. Click a column to sort, a row for its detail and farm plan.`;
    tableHost.append(boardTable());
  }
}

function footer() {
  const f = el('footer');
  const p1 = el('p');
  p1.textContent =
    `Data: ${R.source}. The snapshot is sealed: every run of this program reads the same bytes, so the board above is ` +
    `rebuilt from the record, never fetched live. "Records no token" is DefiLlama's record, not proof a token does not ` +
    `exist; a protocol may carry a token its record does not show.`;
  const p2 = el('p');
  p2.textContent =
    'An implied value is what a launch would be worth if the protocol\'s record stayed as it is. It is not a prediction ' +
    'that a token will be issued, or when, and farming any protocol can lose the gas and the capital committed to it.';
  f.append(p1, p2);
  return f;
}

main.append(header());
const bar = controls();
main.append(bar);
boardBtnRef = bar.querySelectorAll('.views button')[0];
liveBtnRef = bar.querySelectorAll('.views button')[1];
main.append(countLine, tableHost, footer());
renderTable();
main.setAttribute('aria-busy', 'false');

if (state.detail) {
  const row = R.rows.find((r) => r.slug === state.detail) ?? R.rows[0];
  if (row) openDetail(row);
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });
