// The planner: a week of breakfast / lunch / dinner / dessert / snacks for everyone,
// what each person planned vs actually ate, and a month at a glance.
import {
  S, api, esc, h, $, $$, openSheet, confirmSheet, toast, fail, icon, avatar, stepper, fmtK, fmtMoney,
  SLOTS, slotLabel, todayIso, addDays, fmtDay, fmtShort, dowName, weekStartFor, monthName, userById, go, render, lsSet,
} from './app.js';
import { searchFoods } from '../shared/ingredients.js';
import { nutritionFor } from '../shared/units.js';
import { unitsFor, defaultUnit, unitName, foodLine, openFoodForm } from './foods.js';
import { openBuildSheet } from './shop.js';
import { recipeEmoji } from './recipes.js';

let filter = (() => { try { return localStorage.getItem('fc_filter') || 'all'; } catch { return 'all'; } })();
let anchor = null; // a date inside the week / month on screen

const goalOf = (uid) => userById(uid)?.goals?.kcal || null;
const peopleShown = () => (filter === 'all' ? S.users : S.users.filter((u) => u.id === filter));

function totalsHtml(totals, compact = false) {
  return peopleShown().map((u) => {
    const t = totals?.[u.id] || { eaten: { kcal: 0 }, planned: { kcal: 0 } };
    const e = t.eaten.kcal;
    const p = t.planned.kcal;
    const goal = goalOf(u.id);
    const scale = Math.max(goal || 0, e + p, 1);
    const over = goal && e + p > goal;
    const n = `${fmtK(e)}${p ? `<span class="muted pl"> +${fmtK(p)}</span>` : ''}${goal ? `<span class="muted"> / ${fmtK(goal)}</span>` : ''}`;
    return `<div class="ptotal" title="${esc(u.name)}: ${fmtK(e)} eaten, ${fmtK(p)} planned${goal ? `, goal ${fmtK(goal)}` : ''}">${avatar(u)}
      <div class="bar ${over ? 'over' : ''}"><i class="e" style="width:${(e / scale) * 100}%"></i><i class="p" style="width:${(p / scale) * 100}%"></i></div>
      <span class="n num">${n}</span></div>`;
  }).join('');
}

function mealMeta(it) {
  const bits = [];
  if (it.perServing) {
    if (filter !== 'all') {
      const me = it.eaters.find((e) => e.user_id === filter);
      if (me) bits.push(`${fmtK(it.perServing.kcal * me.servings)} kcal`);
    } else bits.push(`${fmtK(it.perServing.kcal)} kcal${it.kind === 'recipe' ? '/serving' : ''}`);
  } else if (it.kind !== 'quick') bits.push('<span title="Some ingredients have no calorie match">kcal ?</span>');
  if (it.kind === 'recipe' && it.batch === 0) bits.push('<span class="badge">leftovers</span>');
  else if (it.kind === 'recipe' && it.batch !== 1) bits.push(`<span class="badge">${it.batch}× batch</span>`);
  if (it.cooked) bits.push('<span class="badge herb">cooked</span>');
  if (it.brand) bits.push(esc(it.brand));
  return bits.join(' · ');
}

function mealHtml(it) {
  const eaters = it.eaters.map((e) => avatar(userById(e.user_id), e.status)).join('');
  return `<div class="meal" draggable="true" data-id="${esc(it.id)}" style="--slot-color:var(--slot-${it.slot})">
    ${it.image_url ? `<img src="${esc(it.image_url)}" alt="" loading="lazy">` : ''}
    <div class="grow"><div class="t ellipsis">${esc(it.title)}</div><div class="m">${mealMeta(it)}</div></div>
    <div class="eaters">${eaters}</div></div>`;
}

function visible(it) {
  return filter === 'all' || it.eaters.some((e) => e.user_id === filter);
}

export async function renderPlan(mount, mode, arg) {
  if (arg && /^\d{4}-\d{2}-\d{2}$/.test(arg)) anchor = arg;
  if (!anchor) anchor = todayIso();
  if (filter !== 'all' && !userById(filter)) filter = 'all';
  const today = todayIso();
  let from;
  let to;
  if (mode === 'month') {
    const first = anchor.slice(0, 8) + '01';
    from = weekStartFor(first);
    const last = addDays(addDays(first, 32).slice(0, 8) + '01', -1);
    to = addDays(weekStartFor(last), 6);
  } else {
    from = weekStartFor(anchor);
    to = addDays(from, 6);
  }
  const data = await api('GET', `/api/plan?from=${from}&to=${to}`);
  const byDay = {};
  for (const it of data.items) (byDay[it.date] ||= []).push(it);

  const label = mode === 'month'
    ? `${monthName(Number(anchor.slice(5, 7)) - 1)} ${anchor.slice(0, 4)}`
    : `${fmtShort(from)} – ${from.slice(5, 7) === to.slice(5, 7) ? Number(to.slice(8, 10)) : fmtShort(to)}`;

  mount.innerHTML = `
    <div class="pagehead"><h1>${mode === 'month' ? 'This month' : 'Meal plan'}</h1><span class="spacer"></span>
      <button class="btn sm" data-copy title="Copy the meals from the week before">${icon('copy')}<span class="desk-only">Copy last week</span></button>
      <button class="btn sm primary" data-shop>${icon('cart')}Shopping list</button></div>
    <div class="toolbar">
      <div class="seg"><button data-mode="week" class="${mode === 'week' ? 'on' : ''}">Week</button><button data-mode="month" class="${mode === 'month' ? 'on' : ''}">Month</button></div>
      <button class="btn sm icon" data-prev aria-label="Previous">${icon('left')}</button>
      <div class="range-label">${esc(label)}</div>
      <button class="btn sm icon" data-next aria-label="Next">${icon('right')}</button>
      ${today >= from && today <= to && (mode === 'week' || anchor.slice(0, 7) === today.slice(0, 7)) ? '' : '<button class="btn sm ghost" data-today>Today</button>'}
    </div>
    <div class="chips" style="margin-bottom:12px">
      <button class="chip ${filter === 'all' ? 'on' : ''}" data-filter="all">Everyone</button>
      ${S.users.map((u) => `<button class="chip ${filter === u.id ? 'on' : ''}" data-filter="${esc(u.id)}"><span class="dot" style="background:${esc(u.color)}"></span>${esc(u.name)}</button>`).join('')}
    </div>
    <div id="cal"></div>`;

  const cal = $('#cal', mount);
  if (mode === 'month') cal.appendChild(monthGrid(from, to, anchor, byDay, data.totals, today));
  else cal.appendChild(weekGrid(from, byDay, data.totals, today));
  if (mode === 'week') cal.prepend(weekSummary(from, data.totals, today));

  const reload = () => render();
  $$('[data-mode]', mount).forEach((b) => (b.onclick = () => go(b.dataset.mode === 'month' ? `month/${anchor}` : `plan/${anchor}`)));
  $('[data-prev]', mount).onclick = () => { anchor = mode === 'month' ? addDays(anchor.slice(0, 8) + '01', -1) : addDays(from, -7); go(`${mode === 'month' ? 'month' : 'plan'}/${anchor}`); };
  $('[data-next]', mount).onclick = () => { anchor = mode === 'month' ? addDays(anchor.slice(0, 8) + '01', 32).slice(0, 8) + '01' : addDays(from, 7); go(`${mode === 'month' ? 'month' : 'plan'}/${anchor}`); };
  const tb = $('[data-today]', mount);
  if (tb) tb.onclick = () => { anchor = today; go(`${mode === 'month' ? 'month' : 'plan'}/${today}`); };
  $$('[data-filter]', mount).forEach((b) => (b.onclick = () => { filter = b.dataset.filter; lsSet('fc_filter', filter); render(); }));
  $('[data-shop]', mount).onclick = () => openBuildSheet(mode === 'week' ? (from < today && to >= today ? today : from) : today, mode === 'week' ? to : addDays(today, 6));
  $('[data-copy]', mount).onclick = async () => {
    const wf = mode === 'week' ? from : weekStartFor(today);
    const ok = await confirmSheet('Copy last week?', `Every meal from ${fmtShort(addDays(wf, -7))} – ${fmtShort(addDays(wf, -1))} is added again on the same days of the week starting ${fmtShort(wf)}, as planned.`, 'Copy meals');
    if (!ok) return;
    try {
      const r = await api('POST', '/api/plan/copy', { from: addDays(wf, -7), to: addDays(wf, -1), target: wf });
      toast(r.copied ? `Copied ${r.copied} meals.` : 'Last week had nothing to copy.');
      reload();
    } catch (e) { fail(e); }
  };

  // meals and empty slots
  $$('.meal', cal).forEach((el) => {
    const it = data.items.find((x) => x.id === el.dataset.id);
    el.onclick = () => openItemSheet(it, reload);
    el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', it.id); el.classList.add('dragging'); });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
  });
  $$('[data-add]', cal).forEach((b) => (b.onclick = () => {
    const [date, slot] = b.dataset.add.split('|');
    openAddSheet({ date, slot, eaters: filter === 'all' ? S.users.map((u) => u.id) : [filter], onDone: reload });
  }));
  $$('.slot', cal).forEach((slotEl) => {
    slotEl.addEventListener('dragover', (e) => { e.preventDefault(); slotEl.classList.add('drop-on'); });
    slotEl.addEventListener('dragleave', () => slotEl.classList.remove('drop-on'));
    slotEl.addEventListener('drop', async (e) => {
      e.preventDefault();
      slotEl.classList.remove('drop-on');
      const id = e.dataTransfer.getData('text/plain');
      const it = data.items.find((x) => x.id === id);
      if (!it || (it.date === slotEl.dataset.date && it.slot === slotEl.dataset.slot)) return;
      try {
        await api('PUT', `/api/plan/${id}`, { date: slotEl.dataset.date, slot: slotEl.dataset.slot });
        reload();
      } catch (err) { fail(err); }
    });
  });
  $$('.mcell', cal).forEach((c) => (c.onclick = () => { anchor = c.dataset.date; go(`plan/${c.dataset.date}`); }));
  // on a phone, open on today's card
  if (mode === 'week' && window.innerWidth < 1100 && $('.day.today', cal)) mount.dataset.focus = '.day.today';
}

function weekSummary(from, totals, today) {
  const days = [...Array(7)].map((_, i) => addDays(from, i));
  const rows = peopleShown().map((u) => {
    const logged = days.filter((d) => d <= today && (totals[d]?.[u.id]?.eaten.kcal || 0) > 0);
    if (!logged.length) return '';
    const avg = logged.reduce((s, d) => s + totals[d][u.id].eaten.kcal, 0) / logged.length;
    const goal = goalOf(u.id);
    return `<span class="row small">${avatar(u)}<span><b class="num">${fmtK(avg)}</b> avg eaten${goal ? ` · goal ${fmtK(goal)}` : ''} <span class="muted">(${logged.length} day${logged.length === 1 ? '' : 's'})</span></span></span>`;
  }).filter(Boolean);
  return h(`<div class="row wrap" style="gap:16px;margin:-4px 0 12px">${rows.join('')}</div>`);
}

function weekGrid(from, byDay, totals, today) {
  const days = [...Array(7)].map((_, i) => addDays(from, i));
  return h(`<div class="days week">${days.map((d) => {
    const items = (byDay[d] || []).filter(visible);
    return `<section class="day ${d === today ? 'today' : ''} ${d < today ? 'past' : ''}">
      <div class="day-head"><div class="day-name">${dowName(d)} ${Number(d.slice(8, 10))}<small>${d === today ? 'Today' : fmtShort(d)}</small></div>
        <div class="day-totals">${totalsHtml(totals[d])}</div></div>
      <div class="slots">${SLOTS.map((s) => {
        const list = items.filter((i) => i.slot === s.id);
        return `<div class="slot ${list.length ? '' : 'empty'}" data-slot="${s.id}" data-date="${d}"><div class="slot-name">${s.label}</div>
          <div class="slot-items">${list.map(mealHtml).join('')}<button class="add-meal" data-add="${d}|${s.id}">+ Add</button></div></div>`;
      }).join('')}</div>
      ${(() => {
        const empty = SLOTS.filter((s) => !items.some((i) => i.slot === s.id));
        return empty.length ? `<div class="quick-slots">${empty.map((s) => `<button class="add-meal" data-add="${d}|${s.id}" style="--slot-color:var(--slot-${s.id})">+ ${s.label}</button>`).join('')}</div>` : '';
      })()}</section>`;
  }).join('')}</div>`);
}

function monthGrid(from, to, anchorDate, byDay, totals, today) {
  const month = anchorDate.slice(0, 7);
  const cells = [];
  for (let d = from; d <= to; d = addDays(d, 1)) cells.push(d);
  const head = [...Array(7)].map((_, i) => `<div class="dow">${dowName(addDays(from, i))}</div>`).join('');
  const order = Object.fromEntries(SLOTS.map((s, i) => [s.id, i]));
  return h(`<div class="month">${head}${cells.map((d) => {
    const items = (byDay[d] || []).filter(visible).sort((a, b) => (a.slot === 'dinner' ? -1 : b.slot === 'dinner' ? 1 : order[a.slot] - order[b.slot]));
    const pk = peopleShown().map((u) => {
      const t = totals[d]?.[u.id];
      if (!t) return '';
      const sum = t.eaten.kcal + t.planned.kcal;
      if (!sum) return '';
      const goal = goalOf(u.id);
      const cls = !goal ? '' : sum > goal * 1.05 ? 'over' : 'ok';
      return `<span class="${cls}" title="${esc(u.name)}: ${fmtK(sum)} kcal">${esc(u.name[0])} ${sum >= 1000 ? (sum / 1000).toFixed(1) + 'k' : fmtK(sum)}</span>`;
    }).join('');
    return `<div class="mcell ${d.slice(0, 7) !== month ? 'other' : ''} ${d === today ? 'today' : ''}" data-date="${d}">
      <div class="d">${Number(d.slice(8, 10))}</div>
      ${items.slice(0, 3).map((it, i) => `<div class="ml ${i === 0 ? 'first' : ''}" style="--slot-color:var(--slot-${it.slot})">${esc(it.title)}</div>`).join('')}
      ${items.length > 3 ? `<div class="tiny muted">+${items.length - 3} more</div>` : ''}
      <div class="pk">${pk}</div></div>`;
  }).join('')}</div>`);
}

// ── adding a meal ───────────────────────────────────────────────────
let recipeCache = null;
async function recipes() {
  recipeCache = await api('GET', '/api/recipes');
  return recipeCache;
}

export function openAddSheet({ date, slot, eaters, mode = 'plan', recipeId = null, onDone, afterAdd }) {
  const today = todayIso();
  const sh = openSheet({ title: mode === 'log' ? 'What did you have?' : `Add to ${slotLabel(slot)}` });
  let tab = 'recipes';
  const state = { date, slot };

  const header = () => `<div class="grid2" style="margin-bottom:6px">
      <label class="field"><span>Day</span><input class="input" type="date" data-k="date" value="${state.date}"></label>
      <label class="field"><span>Meal</span><select class="input" data-k="slot">${SLOTS.map((s) => `<option value="${s.id}" ${s.id === state.slot ? 'selected' : ''}>${s.label}</option>`).join('')}</select></label></div>`;
  const bindHeader = () => $$('[data-k]', sh.body).forEach((el) => (el.onchange = () => { state[el.dataset.k] = el.value; sh.setTitle(mode === 'log' ? 'What did you have?' : `Add to ${slotLabel(state.slot)}`); }));

  async function pickStep() {
    sh.setFoot('');
    sh.body.innerHTML = `${header()}
      <div class="tabs">${[['recipes', 'Recipes'], ['foods', 'Foods'], ['restaurants', 'Restaurants'], ['quick', 'Quick add']].map(([k, l]) => `<button data-tab="${k}" class="${tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div id="pick"></div>`;
    bindHeader();
    $$('[data-tab]', sh.body).forEach((b) => (b.onclick = () => { tab = b.dataset.tab; pickStep(); }));
    const box = $('#pick', sh.body);
    if (tab === 'quick') {
      box.innerHTML = `<form id="qf"><label class="field"><span>What was it?</span><input class="input" name="title" required maxlength="120" placeholder="e.g. Coffee with cream"></label>
        <div class="grid4"><label class="field"><span>Calories</span><input class="input" name="kcal" type="number" min="0" step="any" required></label>
        <label class="field"><span>Protein g</span><input class="input" name="protein" type="number" min="0" step="any"></label>
        <label class="field"><span>Carbs g</span><input class="input" name="carbs" type="number" min="0" step="any"></label>
        <label class="field"><span>Fat g</span><input class="input" name="fat" type="number" min="0" step="any"></label></div>
        <button class="btn primary" style="width:100%">Next</button></form>`;
      $('#qf', box).onsubmit = (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        const n = (k) => (f.get(k) === '' ? null : Number(f.get(k)));
        configStep({ kind: 'quick', title: f.get('title'), kcal: n('kcal'), protein: n('protein'), carbs: n('carbs'), fat: n('fat') });
      };
      return;
    }
    box.innerHTML = `<input class="input" id="q" placeholder="${tab === 'recipes' ? 'Search recipes' : tab === 'foods' ? 'Search foods' : 'Search restaurants or items'}" autocomplete="off" style="margin-bottom:8px"><div class="list" id="res"></div>`;
    const q = $('#q', box);
    const res = $('#res', box);
    let rlist = tab === 'recipes' ? recipeCache || (await recipes()) : null;
    if (tab === 'recipes' && recipeCache) recipes().then((r) => { rlist = r; draw(); }).catch(() => {});
    function draw() {
      const term = q.value.trim().toLowerCase();
      if (tab === 'recipes') {
        let list = rlist.filter((r) => !term || r.name.toLowerCase().includes(term) || r.tags.some((t) => t.toLowerCase().includes(term)));
        list = list.sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name));
        res.innerHTML = list.length ? list.map((r) => `<div class="li click" data-id="${esc(r.id)}">
            ${r.image_url ? `<img class="thumb" src="${esc(r.image_url)}" alt="">` : `<span class="thumb">${recipeEmoji(r.name, r.tags)}</span>`}
            <div class="grow"><div class="t">${r.favorite ? '★ ' : ''}${esc(r.name)}</div><div class="s">${fmtK(r.perServing.kcal)} kcal/serving · serves ${r.servings}${r.costPerServing != null ? ` · ${fmtMoney(r.costPerServing)}/serving` : ''}</div></div></div>`).join('')
          : `<div class="empty"><p>${rlist.length ? 'No recipe matches.' : 'No recipes yet.'}</p><a class="btn sm" href="#recipes">Add recipes</a></div>`;
        $$('.li', res).forEach((el) => (el.onclick = () => configStep({ kind: 'recipe', recipe: rlist.find((r) => r.id === el.dataset.id) })));
        return;
      }
      const rest = tab === 'restaurants';
      const pool = S.foods.filter((f) => !f.archived && (rest ? f.source === 'restaurant' : f.source !== 'restaurant'));
      let list = term ? searchFoods(term, pool, 40) : rest ? pool : pool.filter((f) => f.source !== 'seed').slice(-20).reverse();
      if (rest && !term) list = list.sort((a, b) => (a.brand || '').localeCompare(b.brand || '') || a.name.localeCompare(b.name));
      let lastBrand = null;
      res.innerHTML = list.map((f) => {
        const head = rest && !term && f.brand !== lastBrand ? `<div class="tiny muted" style="font-weight:800;text-transform:uppercase;letter-spacing:.05em;padding:10px 4px 2px">${esc(f.brand || 'Other')}</div>` : '';
        lastBrand = f.brand;
        return `${head}<div class="li click" data-id="${esc(f.id)}"><div class="grow"><div class="t">${esc(f.name)}</div><div class="s">${foodLine(f)}</div></div></div>`;
      }).join('') + `<div class="row wrap" style="padding:10px 0"><span class="muted small">${list.length ? 'Not here?' : 'Nothing found.'}</span>
        <button class="btn sm" data-newfood>${icon('plus')}${rest ? 'New restaurant item' : 'New food'}</button>
        ${rest ? '' : `<button class="btn sm" data-online>${icon('search')}Search online</button>`}</div>`;
      $$('.li', res).forEach((el) => (el.onclick = () => configStep({ kind: 'food', food: S.foodsById[el.dataset.id] })));
      $('[data-newfood]', res).onclick = () => openFoodForm(null, { name: q.value.trim(), restaurant: rest, onSaved: (f) => f && configStep({ kind: 'food', food: f }) });
      const on = $('[data-online]', res);
      if (on) on.onclick = async () => {
        const { openFoodPicker } = await import('./foods.js');
        openFoodPicker({ query: q.value.trim(), onPick: (f) => configStep({ kind: 'food', food: f }) });
      };
    }
    q.oninput = draw;
    draw();
    setTimeout(() => q.focus(), 60);
  }

  function configStep(choice) {
    const isRecipe = choice.kind === 'recipe';
    const food = choice.food;
    const eatenDefault = mode === 'log' || state.date < today;
    const units = food ? unitsFor(food) : [];
    const unit0 = food ? defaultUnit(food) : null;
    const name = isRecipe ? choice.recipe.name : food ? food.name : choice.title;
    sh.setTitle(name);
    sh.body.innerHTML = `${header()}
      ${isRecipe ? `<div class="note" style="margin-bottom:12px"><b>${fmtK(choice.recipe.perServing.kcal)} kcal</b> per serving · recipe makes ${choice.recipe.servings}</div>` : ''}
      ${food ? `<div class="field"><span>Amount in one serving</span><div class="row"><input class="input" id="qty" type="number" min="0" step="any" value="1" style="max-width:110px">
        <select class="input" id="unit" style="max-width:170px">${units.map((u) => `<option value="${u}" ${u === unit0 ? 'selected' : ''}>${esc(unitName(u))}</option>`).join('')}</select>
        <span class="muted small" id="kc"></span></div></div>` : ''}
      ${choice.kind === 'quick' ? `<div class="note" style="margin-bottom:12px"><b>${fmtK(choice.kcal)} kcal</b> per serving</div>` : ''}
      <div class="field"><span>Who's eating</span><div id="who"></div></div>
      <div class="field"><span>Status</span><div class="seg" id="st"><button type="button" data-s="planned" class="${eatenDefault ? '' : 'on'}">Planned</button><button type="button" data-s="eaten" class="${eatenDefault ? 'on' : ''}">Already eaten</button></div></div>
      ${isRecipe ? `<div class="field"><span>How much to make (for the shopping list)</span><div class="row">${stepper(1, { min: 0, max: 10, step: 0.5, name: 'batch' })}<span class="muted small" id="bt"></span></div></div>` : ''}
      ${food && food.source !== 'restaurant' && !food.no_shop ? '<label class="row small"><input type="checkbox" id="noshop"> Already have it - leave it off the shopping list</label>' : ''}`;
    sh.setFoot(`<button class="btn" data-back>Back</button><button class="btn primary" data-addit>Add</button>`);
    bindHeader();
    const who = $('#who', sh.body);
    const sel = new Set(eaters && eaters.length ? eaters : [S.me.id]);
    who.innerHTML = S.users.map((u) => `<div class="person-row ${sel.has(u.id) ? '' : 'off'}" data-u="${esc(u.id)}">
      <label class="row who" style="cursor:pointer"><input type="checkbox" ${sel.has(u.id) ? 'checked' : ''}>${avatar(u)}<b>${esc(u.name)}</b></label><span></span>
      <span class="row small">${stepper(1, { min: 0.25, max: 20, step: isRecipe ? 0.5 : 1, name: 'serv' })}<span class="muted">${isRecipe ? 'servings' : 'x'}</span></span></div>`).join('');
    $$('.person-row', who).forEach((r) => ($('input[type=checkbox]', r).onchange = (e) => r.classList.toggle('off', !e.target.checked)));
    $$('#st button', sh.body).forEach((b) => (b.onclick = () => $$('#st button', sh.body).forEach((x) => x.classList.toggle('on', x === b))));
    const kc = $('#kc', sh.body);
    const upd = () => {
      if (kc) {
        const n = nutritionFor(food, Number($('#qty', sh.body).value), $('#unit', sh.body).value);
        kc.textContent = n ? `${fmtK(n.kcal)} kcal` : "can't count this amount";
      }
      const bt = $('#bt', sh.body);
      if (bt) {
        const b = Number($('[name=batch]', sh.body).value);
        bt.textContent = b === 0 ? 'Leftovers - nothing to buy' : `${b}× recipe = ${Math.round(b * choice.recipe.servings * 10) / 10} servings`;
      }
    };
    sh.body.addEventListener('input', upd);
    upd();
    $('[data-back]', sh.el).onclick = () => { sh.setTitle(mode === 'log' ? 'What did you have?' : `Add to ${slotLabel(state.slot)}`); pickStep(); };
    $('[data-addit]', sh.el).onclick = async () => {
      const status = $('#st .on', sh.body).dataset.s;
      const list = $$('.person-row', who).filter((r) => $('input[type=checkbox]', r).checked)
        .map((r) => ({ user_id: r.dataset.u, servings: Number($('[name=serv]', r).value) || 1, status }));
      if (!list.length) { toast('Pick who is eating.'); return; }
      const body = { date: state.date, slot: state.slot, kind: choice.kind, eaters: list };
      if (isRecipe) { body.recipe_id = choice.recipe.id; body.batch = Number($('[name=batch]', sh.body).value); }
      else if (food) {
        body.food_id = food.id; body.qty = Number($('#qty', sh.body).value) || 1; body.unit = $('#unit', sh.body).value;
        if ($('#noshop', sh.body)?.checked) body.batch = 0;
      } else Object.assign(body, { title: choice.title, kcal: choice.kcal, protein: choice.protein, carbs: choice.carbs, fat: choice.fat });
      try {
        const r = await api('POST', '/api/plan', body);
        sh.close();
        if (afterAdd) await afterAdd(r.id);
        toast(`Added ${name}${state.date !== date ? ` to ${fmtDay(state.date)}` : ''}.`);
        onDone && onDone();
      } catch (e) { fail(e); }
    };
  }

  if (recipeId) {
    recipes().then((list) => {
      const r = list.find((x) => x.id === recipeId);
      if (r) configStep({ kind: 'recipe', recipe: r }); else pickStep();
    }).catch(fail);
  } else pickStep();
  return sh;
}

// ── one meal: who ate it, portions, move, cook ──────────────────────
export function openItemSheet(it, onDone) {
  const sh = openSheet({ title: it.title });
  const changed = () => { onDone && onDone(); };
  const draw = () => {
    const on = new Set(it.eaters.map((e) => e.user_id));
    const isRecipe = it.kind === 'recipe';
    sh.body.innerHTML = `
      <div class="row wrap small muted" style="margin-bottom:10px"><span class="badge" style="background:var(--slot-${it.slot});color:#fff">${slotLabel(it.slot)}</span>${fmtDay(it.date)}
        ${it.perServing ? `· <b class="num" style="color:var(--text)">${fmtK(it.perServing.kcal)} kcal</b>${isRecipe ? ' per serving' : ''}` : ''}
        ${it.brand ? `· ${esc(it.brand)}` : ''}</div>
      <div class="field"><span>Who's eating it</span>
      ${it.eaters.map((e) => {
        const u = userById(e.user_id);
        return `<div class="person-row" data-u="${esc(e.user_id)}"><span class="row who">${avatar(u)}<b>${esc(u?.name || '?')}</b></span>
          <span class="muted small num">${it.perServing ? `${fmtK(it.perServing.kcal * e.servings)} kcal` : ''}</span>
          <button class="btn ghost sm icon" data-rm title="Not eating this">${icon('close')}</button>
          <div class="controls">${stepper(e.servings, { min: 0.25, max: 20, step: isRecipe ? 0.5 : 1, name: 'serv' })}
            <div class="seg">${['planned', 'eaten', 'skipped'].map((s) => `<button data-s="${s}" class="${e.status === s ? 'on' : ''}">${{ planned: 'Planned', eaten: 'Ate it', skipped: 'Skipped' }[s]}</button>`).join('')}</div>
            <button class="link small" data-else>Ate something else</button></div></div>`;
      }).join('')}
      ${S.users.filter((u) => !on.has(u.id)).map((u) => `<button class="btn sm" data-join="${esc(u.id)}">${icon('plus')}${esc(u.name)}</button>`).join(' ')}</div>
      ${isRecipe ? `<div class="field"><span>Shopping</span><div class="row wrap">${stepper(it.batch, { min: 0, max: 10, step: 0.5, name: 'batch' })}
        <span class="muted small">${it.batch === 0 ? 'Leftovers - nothing to buy' : `× recipe (${Math.round(it.batch * (it.recipe_servings || 1) * 10) / 10} servings)`}</span></div></div>
        <div class="row wrap" style="margin-bottom:12px">
          ${it.cooked ? `<span class="badge herb">Cooked - pantry updated</span><button class="link small" data-uncook>Undo</button>` : `<button class="btn sm" data-cook>Cooked it - take from the pantry</button>`}
          <a class="btn sm ghost" href="#recipe/${esc(it.recipe_id)}">Open recipe</a></div>` : ''}
      ${it.kind === 'food' ? `<div class="field"><span>Amount in one serving</span><div class="row"><input class="input" id="qty" type="number" min="0" step="any" value="${it.qty ?? 1}" style="max-width:110px">
        <select class="input" id="unit" style="max-width:170px">${unitsFor(S.foodsById[it.food_id]).map((u) => `<option value="${u}" ${u === it.unit ? 'selected' : ''}>${esc(unitName(u))}</option>`).join('')}</select></div></div>` : ''}
      ${it.kind === 'quick' ? `<div class="grid2"><label class="field"><span>Name</span><input class="input" id="qt" value="${esc(it.title)}"></label><label class="field"><span>Calories</span><input class="input" id="qk" type="number" min="0" value="${it.kcal ?? ''}"></label></div>` : ''}
      <div class="field"><span>Move or copy to</span><div class="row wrap"><input class="input" type="date" id="md" value="${it.date}" style="max-width:170px">
        <select class="input" id="ms" style="max-width:150px">${SLOTS.map((s) => `<option value="${s.id}" ${s.id === it.slot ? 'selected' : ''}>${s.label}</option>`).join('')}</select>
        <button class="btn sm" data-move>Move</button><button class="btn sm" data-dup>${icon('copy')}Copy</button></div></div>`;
    sh.setFoot(`<button class="btn ghost danger" data-del>${icon('trash')}Remove</button><span class="spacer"></span><button class="btn primary" data-done>Done</button>`);
    bind();
  };

  const setEater = async (uid, patch) => {
    const r = await api('PUT', `/api/plan/${it.id}/eaters/${uid}`, patch);
    const e = it.eaters.find((x) => x.user_id === uid);
    if (e) Object.assign(e, patch); else it.eaters.push({ user_id: uid, servings: 1, status: 'planned', ...patch });
    changed();
    return r;
  };

  function bind() {
    $$('.person-row', sh.body).forEach((row) => {
      const uid = row.dataset.u;
      $$('[data-s]', row).forEach((b) => (b.onclick = async () => {
        try {
          const r = await setEater(uid, { status: b.dataset.s });
          draw();
          if (r.pantryLines && !it.cooked) {
            toast(`Take ${r.pantryLines} item${r.pantryLines === 1 ? '' : 's'} out of the pantry?`, { action: 'Update pantry', onAction: cook });
          }
        } catch (e) { fail(e); }
      }));
      $('[name=serv]', row).onchange = async (ev) => { try { await setEater(uid, { servings: Number(ev.target.value) || 1 }); draw(); } catch (e) { fail(e); } };
      $('[data-rm]', row).onclick = async () => {
        try { await api('PUT', `/api/plan/${it.id}/eaters/${uid}`, { remove: true }); it.eaters = it.eaters.filter((x) => x.user_id !== uid); changed(); draw(); } catch (e) { fail(e); }
      };
      $('[data-else]', row).onclick = async () => {
        try {
          await setEater(uid, { status: 'skipped' });
          sh.close();
          openAddSheet({ date: it.date, slot: it.slot, eaters: [uid], mode: 'log', onDone });
        } catch (e) { fail(e); }
      };
    });
    $$('[data-join]', sh.body).forEach((b) => (b.onclick = async () => { try { await setEater(b.dataset.join, { status: 'planned', servings: 1 }); draw(); } catch (e) { fail(e); } }));
    const batch = $('[name=batch]', sh.body);
    if (batch) batch.onchange = async () => { try { it.batch = Number(batch.value); await api('PUT', `/api/plan/${it.id}`, { batch: it.batch }); changed(); draw(); } catch (e) { fail(e); } };
    const cookB = $('[data-cook]', sh.body);
    if (cookB) cookB.onclick = cook;
    const unc = $('[data-uncook]', sh.body);
    if (unc) unc.onclick = async () => { try { const r = await api('POST', `/api/plan/${it.id}/uncooked`, {}); it.cooked = false; toast(`Put ${r.restored} item${r.restored === 1 ? '' : 's'} back in the pantry.`); changed(); draw(); } catch (e) { fail(e); } };
    const qty = $('#qty', sh.body);
    if (qty) {
      const save = async () => { try { await api('PUT', `/api/plan/${it.id}`, { qty: Number(qty.value) || 1, unit: $('#unit', sh.body).value }); changed(); } catch (e) { fail(e); } };
      qty.onchange = save;
      $('#unit', sh.body).onchange = save;
    }
    const qt = $('#qt', sh.body);
    if (qt) {
      const save = async () => { try { await api('PUT', `/api/plan/${it.id}`, { title: qt.value, kcal: Number($('#qk', sh.body).value) || 0 }); changed(); } catch (e) { fail(e); } };
      qt.onchange = save;
      $('#qk', sh.body).onchange = save;
    }
    $('[data-move]', sh.body).onclick = async () => {
      const date = $('#md', sh.body).value;
      const slot = $('#ms', sh.body).value;
      try { await api('PUT', `/api/plan/${it.id}`, { date, slot }); sh.close(); toast(`Moved to ${slotLabel(slot)} · ${fmtDay(date)}`); changed(); } catch (e) { fail(e); }
    };
    $('[data-dup]', sh.body).onclick = async () => {
      try { await api('POST', `/api/plan/${it.id}/duplicate`, { date: $('#md', sh.body).value, slot: $('#ms', sh.body).value }); toast(`Copied to ${fmtDay($('#md', sh.body).value)}.`); changed(); } catch (e) { fail(e); }
    };
    $('[data-del]', sh.el).onclick = async () => {
      try { await api('DELETE', `/api/plan/${it.id}`); sh.close(); toast(`Removed ${it.title}.`); changed(); } catch (e) { fail(e); }
    };
    $('[data-done]', sh.el).onclick = () => sh.close();
  }

  async function cook() {
    try {
      const r = await api('POST', `/api/plan/${it.id}/cooked`, {});
      it.cooked = true;
      toast(r.changed ? `Pantry updated (${r.changed} item${r.changed === 1 ? '' : 's'}).` : 'Marked cooked - nothing in the pantry to take out.', r.changed ? { action: 'Undo', onAction: async () => { await api('POST', `/api/plan/${it.id}/uncooked`, {}); changed(); } } : {});
      changed();
      if (document.body.contains(sh.el)) draw();
    } catch (e) { fail(e); }
  }

  draw();
  return sh;
}
