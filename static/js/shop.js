// Shopping list (built from the plan or typed in), and the pantry: what's in stock,
// what you always have, and every food with its calories and price.
import { S, api, esc, h, $, $$, openSheet, confirmSheet, toast, fail, icon, fmtMoney, fmtK, todayIso, addDays, weekStartFor, fmtShort, go, render } from './app.js';
import { AISLES, searchFoods } from '../shared/ingredients.js';
import { fmtAmount } from '../shared/units.js';
import { openFoodPicker, openFoodForm, openScanner, unitsFor, unitName, defaultUnit, foodLine, priceText, ALL_UNITS } from './foods.js';

const byAisle = (items) => {
  const m = new Map();
  for (const it of items) { if (!m.has(it.aisle)) m.set(it.aisle, []); m.get(it.aisle).push(it); }
  return [...m.entries()].sort((a, b) => idx(a[0]) - idx(b[0]));
};
const idx = (a) => { const i = AISLES.indexOf(a); return i < 0 ? 99 : i; };

function listText(items) {
  return byAisle(items.filter((i) => !i.checked)).map(([aisle, list]) => `${aisle}\n${list.map((i) => `• ${i.name}${i.amountText ? ` - ${i.amountText}` : ''}`).join('\n')}`).join('\n\n');
}

export async function renderShop(mount) {
  const data = await api('GET', '/api/shopping');
  const todo = data.items.filter((i) => !i.checked);
  const cart = data.items.filter((i) => i.checked);
  mount.innerHTML = `<div class="pagehead"><h1>Shopping list</h1><span class="spacer"></span>
      ${todo.length ? `<button class="btn sm" data-share>${icon('share')}Share</button>` : ''}
      <button class="btn sm primary" data-build>${icon('plan')}Build from plan</button></div>
    ${todo.length ? `<div class="totalbar"><b class="num">≈ ${fmtMoney(data.estimate)}</b><span class="muted small">for ${todo.length} item${todo.length === 1 ? '' : 's'}${data.unpriced ? ` · ${data.unpriced} without a price` : ''}</span></div>` : ''}
    <form class="quick-add" id="qa"><input class="input grow" id="qn" placeholder="Add an item - e.g. 2 lb apples" autocomplete="off"><button class="btn">${icon('plus')}Add</button></form>
    <div id="lists"></div>`;
  const lists = $('#lists', mount);
  if (!data.items.length) {
    lists.innerHTML = `<div class="empty"><div class="art">🛒</div><h3>Nothing on the list</h3><p>Build it from the meals you've planned, or add things as you think of them.</p><button class="btn primary" data-build2>Build from this week's plan</button></div>`;
    $('[data-build2]', lists).onclick = () => openBuildSheet();
  } else {
    lists.innerHTML = byAisle(todo).map(([aisle, list]) => `<div class="aisle"><h3>${esc(aisle)}</h3><div class="card">${list.map(itemRow).join('')}</div></div>`).join('')
      + (cart.length ? `<div class="aisle"><h3>In the cart · ${cart.length}</h3><div class="card">${cart.map(itemRow).join('')}</div>
        <div class="row wrap" style="margin-top:10px"><button class="btn primary" data-finish>Done shopping - put ${cart.length} in the pantry</button><button class="btn ghost" data-clear>Clear without saving</button></div></div>` : '')
      + (todo.some((i) => i.priceSource === 'estimate' && i.paid == null) ? '<p class="tiny muted">* starter price estimate. Tap an item to enter what you paid; it is remembered for next time.</p>' : '');
  }
  $('[data-build]', mount).onclick = () => openBuildSheet();
  const sh = $('[data-share]', mount);
  if (sh) sh.onclick = async () => {
    const text = `Shopping list\n\n${listText(data.items)}`;
    try {
      if (navigator.share) await navigator.share({ title: 'Shopping list', text });
      else { await navigator.clipboard.writeText(text); toast('List copied - paste it anywhere.'); }
    } catch (e) { if (e.name !== 'AbortError') { try { await navigator.clipboard.writeText(text); toast('List copied - paste it anywhere.'); } catch { fail(e); } } }
  };
  $('#qa', mount).onsubmit = async (e) => {
    e.preventDefault();
    const raw = $('#qn', mount).value.trim();
    if (!raw) return;
    const { parseIngredient } = await import('../shared/ingredients.js');
    const p = parseIngredient(raw);
    try {
      await api('POST', '/api/shopping', { name: p.name, qty: p.qty, unit: p.unit });
      render();
      setTimeout(() => $('#qn')?.focus(), 80);
    } catch (err) { fail(err); }
  };
  $$('.shop-item', mount).forEach((row) => {
    const it = data.items.find((x) => x.id === row.dataset.id);
    $('.check', row).onclick = async () => {
      row.classList.toggle('done');
      $('.check', row).classList.toggle('on');
      try { await api('PUT', `/api/shopping/${it.id}`, { checked: !it.checked }); render(); } catch (e) { fail(e); }
    };
    $('.grow', row).onclick = () => editItem(it);
  });
  const fin = $('[data-finish]', mount);
  if (fin) fin.onclick = async () => {
    try { const r = await api('POST', '/api/shopping/finish', {}); toast(r.stocked ? `${r.stocked} item${r.stocked === 1 ? '' : 's'} added to the pantry.` : 'Cleared.'); render(); } catch (e) { fail(e); }
  };
  const clr = $('[data-clear]', mount);
  if (clr) clr.onclick = async () => { try { await api('POST', '/api/shopping/clear', { which: 'checked' }); render(); } catch (e) { fail(e); } };
}

function itemRow(i) {
  return `<div class="shop-item ${i.checked ? 'done' : ''}" data-id="${esc(i.id)}"><button class="check ${i.checked ? 'on' : ''}" aria-label="Got it">✓</button>
    <div class="grow" style="cursor:pointer;min-width:0"><div class="t">${esc(i.name)}</div>${i.for_text ? `<div class="s ellipsis">for ${esc(i.for_text)}</div>` : ''}</div>
    <div style="text-align:right"><div class="amt">${esc(i.amountText)}</div>${i.paid != null ? `<div class="cost">paid ${fmtMoney(i.paid)}</div>` : i.cost != null ? `<div class="cost">≈ ${fmtMoney(i.cost)}${i.priceSource === 'estimate' ? '*' : ''}</div>` : ''}</div></div>`;
}

function editItem(it) {
  const food = it.food_id ? S.foodsById[it.food_id] : null;
  const units = food ? unitsFor(food) : ALL_UNITS;
  if (it.unit && !units.includes(it.unit)) units.unshift(it.unit);
  const sh = openSheet({
    title: it.name,
    body: `<div class="grid2"><label class="field"><span>Amount</span><input class="input" id="q" type="number" min="0" step="any" value="${it.qty ?? ''}" placeholder="(any)"></label>
      <label class="field"><span>Unit</span><select class="input" id="u">${units.map((u) => `<option value="${u}" ${u === it.unit ? 'selected' : ''}>${esc(unitName(u))}</option>`).join('')}</select></label></div>
      <label class="field"><span>Aisle</span><select class="input" id="a">${AISLES.map((a) => `<option ${a === it.aisle ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select></label>
      ${food ? `<label class="field"><span>What it cost (saved as ${esc(food.name)}'s price for next time)</span><input class="input" id="p" type="number" min="0" step="0.01" value="${it.paid ?? ''}" placeholder="${it.cost != null ? `about ${it.cost.toFixed(2)}` : '$'}"></label>
        <p class="tiny muted" style="margin-top:-6px">${priceText(food) ? `Current price: ${esc(priceText(food))}` : 'No price saved yet.'}</p>` : '<p class="tiny muted">Not linked to a food, so it has no calories or price.</p>'}
      ${it.for_text ? `<p class="small muted">For ${esc(it.for_text)}</p>` : ''}`,
    foot: `<button class="btn ghost danger" data-del>${icon('trash')}Remove</button><span class="spacer"></span><button class="btn primary" data-save>Save</button>`,
  });
  $('[data-del]', sh.el).onclick = async () => { try { await api('DELETE', `/api/shopping/${it.id}`); sh.close(); render(); } catch (e) { fail(e); } };
  $('[data-save]', sh.el).onclick = async () => {
    const q = $('#q', sh.el).value;
    const body = { qty: q === '' ? null : Number(q), unit: $('#u', sh.el).value, aisle: $('#a', sh.el).value };
    const p = $('#p', sh.el);
    if (p && p.value !== '') body.paid = Number(p.value);
    try {
      await api('PUT', `/api/shopping/${it.id}`, body);
      if (body.paid != null && food) {
        const { loadFoods } = await import('./app.js');
        await loadFoods();
      }
      sh.close();
      render();
    } catch (e) { fail(e); }
  };
}

// ── build from the plan ─────────────────────────────────────────────
export function openBuildSheet(from0, to0) {
  const today = todayIso();
  const ws = weekStartFor(today);
  const presets = [
    ['This week', today, addDays(ws, 6)],
    ['Next week', addDays(ws, 7), addDays(ws, 13)],
    ['Next 7 days', today, addDays(today, 6)],
    ['Next 2 weeks', today, addDays(today, 13)],
    ['Rest of month', today, addDays(addDays(today, 32).slice(0, 8) + '01', -1)],
  ];
  let from = from0 || presets[0][1];
  let to = to0 || presets[0][2];
  const sh = openSheet({ title: 'Build the shopping list', wide: true });
  let preview = null;
  const sel = new Set();
  const staples = new Map();

  function rangeUI() {
    return `<div class="chips" style="margin-bottom:10px">${presets.map(([l, f, t]) => `<button class="chip ${f === from && t === to ? 'on' : ''}" data-f="${f}" data-t="${t}">${l}</button>`).join('')}</div>
      <div class="row wrap" style="margin-bottom:12px"><input class="input" type="date" id="bf" value="${from}" style="max-width:170px"><span class="muted">to</span><input class="input" type="date" id="bt" value="${to}" style="max-width:170px"></div>`;
  }
  async function load() {
    sh.body.innerHTML = `${rangeUI()}<div class="muted small">Adding up ${fmtShort(from)} – ${fmtShort(to)}…</div>`;
    bindRange();
    try {
      preview = await api('POST', '/api/shopping/preview', { from, to });
      sel.clear();
      staples.clear();
      for (const l of preview.lines) if (!l.covered && !l.optionalOnly) sel.add(l.key);
      draw();
    } catch (e) { sh.body.innerHTML = `${rangeUI()}<div class="err">${esc(e.message)}</div>`; bindRange(); }
  }
  function bindRange() {
    $$('[data-f]', sh.body).forEach((b) => (b.onclick = () => { from = b.dataset.f; to = b.dataset.t; load(); }));
    const f = $('#bf', sh.body);
    const t = $('#bt', sh.body);
    f.onchange = t.onchange = () => { if (f.value && t.value && t.value >= f.value) { from = f.value; to = t.value; load(); } };
  }
  function draw() {
    const lines = preview.lines;
    if (!lines.length) {
      sh.body.innerHTML = `${rangeUI()}<div class="empty"><div class="art">🗓️</div><h3>No meals to shop for</h3><p>${preview.meals ? 'Everything planned these days is leftovers or eating out.' : 'Plan some meals for these days first.'}</p></div>`;
      bindRange();
      sh.setFoot('');
      return;
    }
    const groups = byAisle(lines);
    sh.body.innerHTML = `${rangeUI()}<p class="small muted" style="margin-top:0">${preview.meals} meal${preview.meals === 1 ? '' : 's'}. Untick anything you already have. Tap <b>Always have</b> for things you never need to buy. Costs are for the amount the meals use.</p>
      ${groups.map(([aisle, list]) => `<div class="aisle"><h3>${esc(aisle)}</h3>${list.map((l) => {
        const covered = l.covered;
        const why = l.coveredBy === 'staple' ? 'always have' : l.coveredBy === 'pantry' ? `in the pantry (${esc(l.haveText)})` : l.coveredBy === 'list' ? `already on the list (${esc(l.onListText)})` : '';
        return `<div class="prev-line ${covered ? 'covered' : ''}" data-k="${esc(l.key)}"><button class="check ${sel.has(l.key) ? 'on' : ''}">✓</button>
          <div class="grow" style="min-width:0"><div class="row"><span class="t grow">${esc(l.name)}</span><b class="num">${esc(covered ? '' : l.buyText)}</b>${!covered && l.buyAlt ? `<span class="small muted num">&nbsp;≈ ${esc(l.buyAlt)}</span>` : ''}</div>
          <div class="small muted">${covered ? `✓ ${why}` : `${l.haveText ? `have ${esc(l.haveText)} · ` : ''}${l.onListText ? `on list ${esc(l.onListText)} · ` : ''}need ${esc(l.needText)}${l.pantryCheck ? ' · check the pantry amount' : ''}`}
            ${l.cost != null && !covered ? ` · ≈ ${fmtMoney(l.cost)}` : ''}${l.optionalOnly ? ' · optional' : ''}</div>
          <div class="for ellipsis">for ${esc(l.for.join(', '))}</div></div>
          ${covered || staples.has(l.key) ? (staples.has(l.key) ? '<span class="badge herb">always have</span>' : '') : '<button class="link tiny" data-staple>Always have</button>'}</div>`;
      }).join('')}</div>`).join('')}`;
    bindRange();
    $$('.prev-line', sh.body).forEach((row) => {
      const k = row.dataset.k;
      $('.check', row).onclick = () => { if (sel.has(k)) sel.delete(k); else sel.add(k); $('.check', row).classList.toggle('on', sel.has(k)); foot(); };
      const st = $('[data-staple]', row);
      if (st) st.onclick = () => { const l = lines.find((x) => x.key === k); staples.set(k, l); sel.delete(k); draw(); };
    });
    foot();
  }
  function foot() {
    const chosen = preview.lines.filter((l) => sel.has(l.key));
    const cost = chosen.reduce((s, l) => s + (l.cost || 0), 0);
    sh.setFoot(`<button class="btn" data-x>Cancel</button><button class="btn primary" data-add ${chosen.length || staples.size ? '' : 'disabled'}>Add ${chosen.length} item${chosen.length === 1 ? '' : 's'}${cost ? ` · ≈ ${fmtMoney(cost)}` : ''}</button>`);
    $('[data-x]', sh.el).onclick = () => sh.close();
    $('[data-add]', sh.el).onclick = async () => {
      const lines = chosen.map((l) => {
        const a = l.buy.length === 1 ? l.buy[0] : l.covered ? l.need[0] : null;
        return { food_id: l.food_id, name: l.name, qty: a ? a.qty : null, unit: a ? a.unit : null, aisle: l.aisle, for_text: l.for.join(', ') };
      });
      // more than one unit that couldn't be combined: add each amount
      for (const l of chosen) if (l.buy.length > 1) for (const a of l.buy.slice(1)) lines.push({ food_id: l.food_id, name: l.name, qty: a.qty, unit: a.unit, aisle: l.aisle, for_text: l.for.join(', ') });
      try {
        const r = await api('POST', '/api/shopping/add', { lines, staples: [...staples.values()].map((l) => ({ food_id: l.food_id, name: l.name })) });
        sh.close();
        toast(`Added ${chosen.length} item${chosen.length === 1 ? '' : 's'} to the list.`);
        if (location.hash === '#shop') render(); else go('shop');
        void r;
      } catch (e) { fail(e); }
    };
  }
  load();
}

// ── pantry ──────────────────────────────────────────────────────────
let foodFilter = 'all';
let foodSearch = '';

export async function renderPantry(mount, tab) {
  tab = ['stock', 'staples', 'foods'].includes(tab) ? tab : 'stock';
  mount.innerHTML = `<div class="pagehead"><h1>Pantry</h1></div>
    <div class="tabs">${[['stock', 'In stock'], ['staples', 'Always have'], ['foods', 'Foods & prices']].map(([k, l]) => `<button data-pt="${k}" class="${tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div id="pv"></div>`;
  $$('[data-pt]', mount).forEach((b) => (b.onclick = () => go(`pantry/${b.dataset.pt}`)));
  const pv = $('#pv', mount);
  if (tab === 'foods') return foodsTab(pv);
  const rows = await api('GET', '/api/pantry');
  if (tab === 'staples') {
    const st = rows.filter((r) => r.staple);
    pv.innerHTML = `<p class="muted small" style="margin-top:0">Things you never need to buy for a recipe - salt, oil, spices. They're skipped when the list is built.</p>
      <div class="row wrap" style="gap:8px;margin-bottom:14px">${st.map((r) => `<span class="chip">${esc(r.name)}<button class="link" data-rm="${esc(r.id)}" aria-label="Remove" style="color:var(--muted)">✕</button></span>`).join('') || '<span class="muted">Nothing yet.</span>'}</div>
      <button class="btn" data-add>${icon('plus')}Add something you always have</button>`;
    $$('[data-rm]', pv).forEach((b) => (b.onclick = async () => { try { await api('DELETE', `/api/pantry/${b.dataset.rm}`); render(); } catch (e) { fail(e); } }));
    $('[data-add]', pv).onclick = () => openFoodPicker({ title: 'Always have…', onPick: async (f) => { try { await api('POST', '/api/pantry', { food_id: f.id, staple: true }); render(); } catch (e) { fail(e); } } });
    return;
  }
  const stock = rows.filter((r) => !r.staple);
  pv.innerHTML = `<p class="muted small" style="margin-top:0">What's in the kitchen now. Ticked-off shopping lands here, cooking a recipe takes from it, and the shopping list only asks for what's missing.</p>
    <button class="btn primary" data-add style="margin-bottom:12px">${icon('plus')}Add to pantry</button>
    ${stock.length ? `<div class="card">${stock.map((r) => `<div class="shop-item" data-id="${esc(r.id)}" style="cursor:pointer"><div class="grow"><div class="t">${esc(r.name)}</div><div class="s">updated ${esc(fmtShort(r.updated_at.slice(0, 10)))}</div></div><div class="amt">${esc(r.amountText || 'have some')}</div></div>`).join('')}</div>`
      : '<div class="empty"><div class="art">🫙</div><h3>The pantry is empty</h3><p>Finish a shopping trip, or add what you have.</p></div>'}`;
  $('[data-add]', pv).onclick = () => openFoodPicker({ title: 'Add to the pantry', onPick: (f) => pantryAmount({ food: f, name: f.name, qty: 1, unit: defaultUnit(f) }, true) });
  $$('.shop-item', pv).forEach((el) => (el.onclick = () => {
    const r = stock.find((x) => x.id === el.dataset.id);
    pantryAmount({ row: r, food: r.food_id ? S.foodsById[r.food_id] : null, name: r.name, qty: r.qty, unit: r.unit }, false);
  }));
}

function pantryAmount({ row, food, name, qty, unit }, isNew) {
  const units = food ? unitsFor(food) : ALL_UNITS;
  if (unit && !units.includes(unit)) units.unshift(unit);
  const sh = openSheet({
    title: name,
    body: `<div class="grid2"><label class="field"><span>How much</span><input class="input" id="q" type="number" min="0" step="any" value="${qty ?? ''}" placeholder="(not counted)"></label>
      <label class="field"><span>Unit</span><select class="input" id="u">${units.map((u) => `<option value="${u}" ${u === unit ? 'selected' : ''}>${esc(unitName(u))}</option>`).join('')}</select></label></div>
      <p class="tiny muted" style="margin-top:-4px">Leave the amount empty for "have some" - it then always counts as covered.</p>
      <label class="row small"><input type="checkbox" id="st"> Always have this (never put it on the list)</label>`,
    foot: `${isNew ? '' : `<button class="btn ghost danger" data-del>${icon('trash')}Used up</button><span class="spacer"></span>`}<button class="btn primary" data-save>Save</button>`,
  });
  const del = $('[data-del]', sh.el);
  if (del) del.onclick = async () => { try { await api('DELETE', `/api/pantry/${row.id}`); sh.close(); render(); } catch (e) { fail(e); } };
  $('[data-save]', sh.el).onclick = async () => {
    const q = $('#q', sh.el).value;
    const body = { qty: q === '' ? null : Number(q), unit: $('#u', sh.el).value, staple: $('#st', sh.el).checked };
    try {
      if (isNew) await api('POST', '/api/pantry', { food_id: food?.id, name, ...body });
      else await api('PUT', `/api/pantry/${row.id}`, body);
      sh.close();
      render();
    } catch (e) { fail(e); }
  };
}

function foodsTab(pv) {
  pv.innerHTML = `<div class="row wrap" style="margin-bottom:10px">
      <button class="btn sm primary" data-new>${icon('plus')}New food</button>
      <button class="btn sm" data-rest>${icon('plus')}Restaurant item</button>
      <button class="btn sm" data-online>${icon('search')}Find online</button>
      <button class="btn sm" data-scan>${icon('scan')}Scan barcode</button></div>
    <input class="input" id="fs" placeholder="Search foods" value="${esc(foodSearch)}" style="margin-bottom:8px">
    <div class="chips" style="margin-bottom:10px">${[['all', 'All'], ['ing', 'Ingredients'], ['rest', 'Restaurants'], ['mine', 'Added by you']].map(([k, l]) => `<button data-ff="${k}" class="chip ${foodFilter === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="card" id="fl"></div>
    <p class="tiny muted">Starter nutrition is typical USDA data; starter prices (marked est.) are rough US estimates. Restaurant values come from the chains' published menus and may change. Edit anything.</p>`;
  const draw = () => {
    let pool = S.foods.filter((f) => !f.archived);
    if (foodFilter === 'ing') pool = pool.filter((f) => f.source !== 'restaurant');
    if (foodFilter === 'rest') pool = pool.filter((f) => f.source === 'restaurant');
    if (foodFilter === 'mine') pool = pool.filter((f) => ['custom', 'usda', 'off'].includes(f.source) || (f.source === 'restaurant' && !f.source_ref));
    const list = foodSearch.trim() ? searchFoods(foodSearch, pool, 200) : pool.slice().sort((a, b) => (a.brand || '').localeCompare(b.brand || '') || a.name.localeCompare(b.name));
    $('#fl', pv).innerHTML = list.length ? list.slice(0, 300).map((f) => `<div class="shop-item" data-id="${esc(f.id)}" style="cursor:pointer"><div class="grow" style="min-width:0"><div class="t">${esc(f.name)}</div><div class="s">${foodLine(f)}</div></div>
      <div class="cost" style="text-align:right">${esc(priceText(f))}</div></div>`).join('') : '<div class="empty">No foods match.</div>';
    $$('.shop-item', pv).forEach((el) => (el.onclick = () => openFoodForm(S.foodsById[el.dataset.id], { onSaved: draw })));
  };
  $('#fs', pv).oninput = (e) => { foodSearch = e.target.value; draw(); };
  $$('[data-ff]', pv).forEach((b) => (b.onclick = () => { foodFilter = b.dataset.ff; $$('[data-ff]', pv).forEach((x) => x.classList.toggle('on', x === b)); draw(); }));
  $('[data-new]', pv).onclick = () => openFoodForm(null, { name: foodSearch, onSaved: draw });
  $('[data-rest]', pv).onclick = () => openFoodForm(null, { restaurant: true, onSaved: draw });
  $('[data-online]', pv).onclick = () => openFoodPicker({ title: 'Find a food online', query: foodSearch, onPick: (f) => { toast(`${f.name} added to your foods.`); draw(); } });
  $('[data-scan]', pv).onclick = () => openScanner((f) => { toast(`${f.name} added to your foods.`); draw(); openFoodForm(f, { onSaved: draw }); });
  draw();
}

export { fmtAmount, fmtK };
