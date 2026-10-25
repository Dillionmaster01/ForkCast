// Recipes: the list, one recipe (scaled, with steps), the editor with live calorie
// matching, and importing from a link or pasted text.
import { S, api, esc, h, $, $$, openSheet, confirmSheet, toast, fail, icon, fmtK, fmtMoney, todayIso, go, render } from './app.js';
import { parseIngredient, matchFood } from '../shared/ingredients.js';
import { nutritionFor, fmtAmount, addNut, ZERO } from '../shared/units.js';
import { openFoodPicker } from './foods.js';
import { openAddSheet } from './plan.js';

let filterTag = 'all';
let search = '';

const EMOJI = [
  [/pasta|spaghetti|lasagna|noodle|mac/i, '🍝'], [/salad/i, '🥗'], [/soup|chili|stew|curry/i, '🍲'], [/taco|burrito|quesadilla|enchilada/i, '🌮'],
  [/pizza/i, '🍕'], [/pancake|waffle/i, '🥞'], [/cookie/i, '🍪'], [/cake|brownie|dessert|pie/i, '🍰'], [/burger/i, '🍔'],
  [/chicken/i, '🍗'], [/steak|beef/i, '🥩'], [/fish|salmon|shrimp|tuna/i, '🐟'], [/egg|omelet|breakfast/i, '🍳'], [/rice/i, '🍚'],
  [/sandwich|wrap/i, '🥪'], [/smoothie|shake/i, '🥤'], [/guac|dip|salsa/i, '🥑'], [/bread|muffin/i, '🍞'],
];
export const recipeEmoji = (name, tags = []) => (EMOJI.find(([re]) => re.test(`${name} ${tags.join(' ')}`)) || [0, '🍽️'])[1];
const phClass = (name) => `ph-${([...String(name)].reduce((a, c) => a + c.charCodeAt(0), 0) % 5) + 1}`;
const mins = (r) => { const t = (r.prep_min || 0) + (r.cook_min || 0); return t ? (t >= 60 ? `${Math.floor(t / 60)} h${t % 60 ? ` ${t % 60} m` : ''}` : `${t} min`) : ''; };

export async function renderRecipes(mount) {
  const list = await api('GET', '/api/recipes');
  const tags = [...new Set(list.flatMap((r) => r.tags))].sort();
  mount.innerHTML = `<div class="pagehead"><h1>Recipes</h1><span class="muted small">${list.length}</span><span class="spacer"></span>
      <button class="btn sm" data-import>${icon('share', 'style="transform:rotate(180deg)"')}Import</button>
      <button class="btn sm primary" data-new>${icon('plus')}New recipe</button></div>
    <input class="input" id="rq" placeholder="Search recipes or tags" value="${esc(search)}" style="margin-bottom:10px">
    <div class="chips" style="margin-bottom:14px"><button class="chip ${filterTag === 'all' ? 'on' : ''}" data-tag="all">All</button>
      <button class="chip ${filterTag === 'fav' ? 'on' : ''}" data-tag="fav">★ Favorites</button>
      ${tags.map((t) => `<button class="chip ${filterTag === t ? 'on' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}</div>
    <div id="grid"></div>`;
  const draw = () => {
    const q = search.toLowerCase();
    const shown = list.filter((r) => (filterTag === 'all' || (filterTag === 'fav' ? r.favorite : r.tags.includes(filterTag))) && (!q || r.name.toLowerCase().includes(q) || r.tags.some((t) => t.toLowerCase().includes(q))))
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name));
    $('#grid', mount).innerHTML = shown.length ? `<div class="rgrid">${shown.map((r) => `<div class="rcard" data-id="${esc(r.id)}">
        <div class="img ${r.image_url ? '' : phClass(r.name)}" ${r.image_url ? `style="background-image:url('${esc(r.image_url)}')"` : ''}>${r.image_url ? '' : recipeEmoji(r.name, r.tags)}${r.favorite ? '<span class="fav">★</span>' : ''}</div>
        <div class="body"><div class="name">${esc(r.name)}</div>
        <div class="meta"><span class="num"><b>${fmtK(r.perServing.kcal)}</b> kcal</span>${r.costPerServing != null ? `<span>${fmtMoney(r.costPerServing)}/serv</span>` : ''}${mins(r) ? `<span>${mins(r)}</span>` : ''}${r.unmatched ? '<span style="color:var(--amber)">● check</span>' : ''}</div></div></div>`).join('')}</div>`
      : `<div class="empty"><div class="art">📖</div><h3>${list.length ? 'Nothing matches' : 'Your cookbook is empty'}</h3><p>${list.length ? 'Try another search.' : 'Add a recipe you make, or import one from any recipe site.'}</p>
        ${list.length ? '' : '<div class="row" style="justify-content:center"><button class="btn" data-import2>Import from a link</button><button class="btn primary" data-new2>New recipe</button></div>'}</div>`;
    $$('.rcard', mount).forEach((c) => (c.onclick = () => go(`recipe/${c.dataset.id}`)));
    const i2 = $('[data-import2]', mount); if (i2) i2.onclick = openImportSheet;
    const n2 = $('[data-new2]', mount); if (n2) n2.onclick = () => openRecipeEditor(null);
  };
  $('#rq', mount).oninput = (e) => { search = e.target.value; draw(); };
  $$('[data-tag]', mount).forEach((b) => (b.onclick = () => { filterTag = b.dataset.tag; $$('[data-tag]', mount).forEach((x) => x.classList.toggle('on', x === b)); draw(); }));
  $('[data-import]', mount).onclick = openImportSheet;
  $('[data-new]', mount).onclick = () => openRecipeEditor(null);
  draw();
}

function recipeBody(r, ingredients) {
  return {
    name: r.name, servings: r.servings, description: r.description, steps: r.steps, source_url: r.source_url, image_url: r.image_url,
    prep_min: r.prep_min, cook_min: r.cook_min, tags: r.tags, notes: r.notes, site_kcal: r.site_kcal, favorite: r.favorite,
    ingredients: ingredients.map((i) => ({ text: i.text, qty: i.qty, unit: i.unit, name: i.name, note: i.note, grams: i.grams, optional: i.optional, food_id: i.food_id || null })),
  };
}

const scaleBy = {};
const doneSteps = {};

export async function renderRecipe(mount, id) {
  const r = await api('GET', `/api/recipes/${encodeURIComponent(id)}`);
  const scale = scaleBy[id] || 1;
  const done = (doneSteps[id] ||= new Set());
  const servings = Math.round(r.servings * scale * 100) / 100;
  mount.innerHTML = `<a href="#recipes" class="link small" style="display:inline-flex;align-items:center;gap:4px;margin-bottom:10px">${icon('left', 'width="16" height="16"')}Recipes</a>
    <div class="recipe-hero">
      <div class="img ${r.image_url ? '' : `noimg ${phClass(r.name)}`}" ${r.image_url ? `style="background-image:url('${esc(r.image_url)}')"` : ''}>${r.image_url ? '' : recipeEmoji(r.name, r.tags)}</div>
      <div><div class="row wrap">${r.tags.map((t) => `<span class="badge">${esc(t)}</span>`).join('')}</div>
        <h1>${esc(r.name)}</h1>
        ${r.description ? `<p class="muted" style="margin:0 0 8px">${esc(r.description)}</p>` : ''}
        <div class="stats">
          <div class="stat big"><b>${fmtK(r.perServing.kcal)}</b><span>kcal / serving</span></div>
          <div class="stat"><b>${r.perServing.protein}g</b><span>protein</span></div>
          <div class="stat"><b>${r.perServing.carbs}g</b><span>carbs</span></div>
          <div class="stat"><b>${r.perServing.fat}g</b><span>fat</span></div>
        </div>
        <div class="row wrap small muted" style="gap:14px">
          ${r.costPerServing != null ? `<span>≈ <b style="color:var(--text)">${fmtMoney(r.costPerServing)}</b>/serving (${fmtMoney(r.cost)} total${r.costPartial ? ', some items unpriced' : ''})</span>` : '<span>No prices yet</span>'}
          ${r.prep_min ? `<span>Prep ${r.prep_min} min</span>` : ''}${r.cook_min ? `<span>Cook ${r.cook_min} min</span>` : ''}
          ${r.site_kcal ? `<span title="What the recipe's website says">Site says ${fmtK(r.site_kcal)} kcal</span>` : ''}
        </div>
        ${r.unmatched + r.unconverted ? `<div class="note" style="margin-top:10px;border-left:3px solid var(--amber)"><b>${r.unmatched + r.unconverted} ingredient${r.unmatched + r.unconverted === 1 ? '' : 's'}</b> aren't counted in the calories yet - tap the orange ones below to match them.</div>` : ''}
        <div class="row wrap" style="margin-top:14px">
          <button class="btn primary" data-plan>${icon('plan')}Add to plan</button>
          <button class="btn" data-edit>${icon('edit')}Edit</button>
          <button class="btn icon" data-fav title="Favorite" style="${r.favorite ? 'color:#e0a400' : ''}">${icon('star', r.favorite ? 'fill="currentColor"' : '')}</button>
          <button class="btn icon ghost danger" data-del title="Delete">${icon('trash')}</button>
        </div></div></div>
    <div class="cols">
      <div><div class="row" style="margin:20px 0 6px"><h2 style="font-size:21px" class="grow">Ingredients</h2>
        <span class="row small muted">Serves ${stepperless(servings)}</span></div>
        <div>${r.ingredients.map((i, idx) => {
          const q = i.qty != null ? fmtAmount(i.qty * scale, i.unit) : '';
          const unmatched = !i.food_id && i.qty != null;
          return `<div class="ing ${unmatched ? 'unmatched' : ''}" data-i="${idx}" style="cursor:pointer" title="${i.food_name ? `Counted as ${esc(i.food_name)}` : 'Not matched to a food'}">
            <span class="q">${esc(q)}</span><span class="n">${esc(i.name)}${i.note ? ` <small>${esc(i.note)}</small>` : ''}${i.optional ? ' <small>(optional)</small>' : ''}
            <br><small>${i.food_name ? `→ ${esc(i.food_name)}` : unmatched ? 'tap to match a food' : ''}</small></span>
            <span class="tiny muted num">${i.kcal != null ? `${fmtK(i.kcal * scale)}` : ''}</span></div>`;
        }).join('')}</div></div>
      <div><h2 style="font-size:21px;margin:20px 0 6px">Steps</h2>
        ${r.steps.length ? `<ol class="steps">${r.steps.map((s, i) => /^—.*—$/.test(s) ? `<li class="section">${esc(s.replace(/—/g, '').trim())}</li>` : `<li data-step="${i}" class="${done.has(i) ? 'done' : ''}">${esc(s)}</li>`).join('')}</ol>` : '<p class="muted">No steps written down.</p>'}
        ${r.notes ? `<h2 style="font-size:19px;margin:18px 0 6px">Notes</h2><p style="white-space:pre-wrap">${esc(r.notes)}</p>` : ''}
        ${r.source_url ? `<p class="small"><a href="${esc(r.source_url)}" target="_blank" rel="noopener">Original recipe ↗</a></p>` : ''}
      </div></div>`;

  const sv = $('#servings', mount);
  sv.onchange = () => { const v = Number(sv.value); if (v > 0) { scaleBy[id] = v / r.servings; render(); } };
  $$('[data-step]', mount).forEach((li) => (li.onclick = () => { const i = Number(li.dataset.step); if (done.has(i)) done.delete(i); else done.add(i); li.classList.toggle('done'); }));
  $('[data-plan]', mount).onclick = () => openAddSheet({ date: todayIso(), slot: 'dinner', eaters: S.users.map((u) => u.id), recipeId: r.id, onDone: () => {} });
  $('[data-edit]', mount).onclick = () => openRecipeEditor(r);
  $('[data-fav]', mount).onclick = async () => { try { await api('PUT', `/api/recipes/${r.id}`, { favorite: !r.favorite }); render(); } catch (e) { fail(e); } };
  $('[data-del]', mount).onclick = async () => {
    if (!(await confirmSheet('Delete this recipe?', 'Meals already planned or eaten keep their calories.', 'Delete', true))) return;
    try { await api('DELETE', `/api/recipes/${r.id}`); toast('Recipe deleted.'); go('recipes'); } catch (e) { fail(e); }
  };
  $$('.ing', mount).forEach((row) => (row.onclick = () => {
    const ing = r.ingredients[Number(row.dataset.i)];
    openFoodPicker({
      title: `Count “${ing.name}” as…`, query: ing.name,
      onPick: async (food) => {
        const ings = r.ingredients.map((x, k) => (k === Number(row.dataset.i) ? { ...x, food_id: food.id } : x));
        try { await api('PUT', `/api/recipes/${r.id}`, recipeBody(r, ings)); toast(`Now counted as ${food.name}.`); render(); } catch (e) { fail(e); }
      },
    });
  }));
}
function stepperless(v) {
  return `<input id="servings" class="input num" type="number" min="0.25" step="any" value="${v}" style="width:72px;min-height:32px;padding:4px 8px;text-align:center">`;
}

// ── editor ──────────────────────────────────────────────────────────
export function openRecipeEditor(recipe, { draft = false } = {}) {
  const r = recipe || { name: '', servings: 4, steps: [], tags: [], ingredients: [] };
  const rows = (r.ingredients || []).map((i) => ({ text: i.text, food_id: i.food_id || null, manual: !draft && !!i.food_id }));
  if (!rows.length) rows.push({ text: '', food_id: null, manual: false });
  const isNew = !recipe || !recipe.id;
  const sh = openSheet({
    title: isNew ? (draft ? 'Check the imported recipe' : 'New recipe') : 'Edit recipe',
    wide: true,
    body: `<form id="rf">
      <label class="field"><span>Name</span><input class="input" name="name" required maxlength="150" value="${esc(r.name)}"></label>
      <div class="grid4"><label class="field"><span>Servings</span><input class="input" name="servings" type="number" min="0.25" step="any" required value="${esc(r.servings)}"></label>
        <label class="field"><span>Prep min</span><input class="input" name="prep_min" type="number" min="0" value="${esc(r.prep_min ?? '')}"></label>
        <label class="field"><span>Cook min</span><input class="input" name="cook_min" type="number" min="0" value="${esc(r.cook_min ?? '')}"></label>
        <label class="field"><span>Tags</span><input class="input" name="tags" placeholder="dinner, quick" value="${esc((r.tags || []).join(', '))}"></label></div>
      <div class="field"><span>Ingredients - one per line, the way a recipe writes them</span><div class="ing-edit" id="rows"></div>
        <div class="row wrap" style="margin-top:6px"><button type="button" class="btn sm" id="addrow">${icon('plus')}Ingredient</button><button type="button" class="btn sm ghost" id="paste">Paste a list</button>
        <span class="spacer"></span><span class="small" id="tot"></span></div></div>
      <label class="field"><span>Steps - one per line</span><textarea class="input" name="steps" rows="6">${esc((r.steps || []).join('\n'))}</textarea></label>
      <details ${r.description || r.notes || r.image_url || r.source_url ? 'open' : ''}><summary class="small muted" style="cursor:pointer;margin-bottom:10px">Photo, link, notes</summary>
        <label class="field"><span>Short description</span><input class="input" name="description" value="${esc(r.description || '')}"></label>
        <div class="grid2"><label class="field"><span>Photo link</span><input class="input" name="image_url" type="url" value="${esc(r.image_url || '')}"></label>
        <label class="field"><span>Original recipe link</span><input class="input" name="source_url" type="url" value="${esc(r.source_url || '')}"></label></div>
        <label class="field"><span>Notes</span><textarea class="input" name="notes" rows="3">${esc(r.notes || '')}</textarea></label></details>
      <div class="err" id="rerr"></div></form>`,
    foot: `<button class="btn" data-cancel>Cancel</button><button class="btn primary" data-save>${isNew ? 'Save recipe' : 'Save'}</button>`,
  });
  const box = $('#rows', sh.el);
  const foodsNoRest = () => S.foods.filter((f) => f.source !== 'restaurant');

  const rowFood = (row, p) => {
    if (row.manual) return row.food_id ? S.foodsById[row.food_id] : null;
    const m = p.name ? matchFood(p.name, foodsNoRest(), { unit: p.unit }) : null;
    row.food_id = m ? m.food.id : null;
    return m ? m.food : null;
  };
  function rowEl(row) {
    const el = h(`<div class="ing-row"><div><input class="input" placeholder="e.g. 2 cups flour" value="${esc(row.text)}"><div class="parsed"></div></div>
      <button type="button" class="btn ghost sm icon" title="Remove">${icon('close')}</button></div>`);
    const inp = $('input', el);
    const info = $('.parsed', el);
    const refresh = () => {
      row.text = inp.value;
      const p = parseIngredient(row.text);
      if (!row.text.trim()) { info.innerHTML = ''; totals(); return; }
      const food = rowFood(row, p);
      const n = food && p.qty != null ? nutritionFor(food, p.qty, p.unit, p.grams) : null;
      info.innerHTML = `<span>${p.qty != null ? esc(fmtAmount(p.qty, p.unit) || '') : 'no amount'}</span>·<span>${esc(p.name)}</span>
        <button type="button" class="match ${food ? '' : 'none'}">${food ? `→ ${esc(food.name)}` : 'match a food'}</button>
        ${n ? `<span class="num">${fmtK(n.kcal)} kcal</span>` : food && p.qty != null ? '<span style="color:var(--amber)">can\'t convert this amount</span>' : ''}`;
      $('.match', info).onclick = () => openFoodPicker({
        title: `Count “${p.name}” as…`, query: p.name,
        onPick: (f) => { row.food_id = f.id; row.manual = true; refresh(); },
      });
      totals();
    };
    inp.oninput = () => { if (row.manual && !row.food_id) row.manual = false; refresh(); };
    $('button.btn', el).onclick = () => { rows.splice(rows.indexOf(row), 1); el.remove(); totals(); };
    el._refresh = refresh;
    return el;
  }
  function totals() {
    let t = { ...ZERO };
    let missing = 0;
    for (const row of rows) {
      if (!row.text.trim()) continue;
      const p = parseIngredient(row.text);
      const food = row.food_id ? S.foodsById[row.food_id] : null;
      const n = food && p.qty != null ? nutritionFor(food, p.qty, p.unit, p.grams) : null;
      if (n) t = addNut(t, n); else if (p.qty != null) missing++;
    }
    const sv = Number($('[name=servings]', sh.el).value) || 1;
    $('#tot', sh.el).innerHTML = `<b class="num">${fmtK(t.kcal / sv)}</b> kcal per serving${missing ? ` <span style="color:var(--amber)">(${missing} not counted)</span>` : ''}`;
  }
  const addRow = (row) => { const el = rowEl(row); box.appendChild(el); el._refresh(); return el; };
  rows.forEach((row) => addRow(row));
  $('#addrow', sh.el).onclick = () => { const row = { text: '', food_id: null, manual: false }; rows.push(row); $('input', addRow(row)).focus(); };
  $('#paste', sh.el).onclick = () => {
    const p = openSheet({ title: 'Paste ingredients', body: '<textarea class="input" id="pl" rows="10" placeholder="One ingredient per line"></textarea>', foot: '<button class="btn primary" data-ok>Add them</button>' });
    $('[data-ok]', p.el).onclick = () => {
      const lines = $('#pl', p.el).value.split('\n').map((l) => l.trim()).filter(Boolean);
      for (let k = rows.length - 1; k >= 0; k--) if (!rows[k].text.trim()) { rows.splice(k, 1); box.children[k]?.remove(); }
      lines.forEach((text) => { const row = { text, food_id: null, manual: false }; rows.push(row); addRow(row); });
      p.close();
    };
  };
  $('[name=servings]', sh.el).oninput = totals;
  $('[data-cancel]', sh.el).onclick = () => sh.close();
  $('[data-save]', sh.el).onclick = async () => {
    const form = $('#rf', sh.el);
    if (!form.reportValidity()) return;
    const fd = new FormData(form);
    const n = (k) => (fd.get(k) ? Number(fd.get(k)) : null);
    const body = {
      name: fd.get('name'), servings: Number(fd.get('servings')), prep_min: n('prep_min'), cook_min: n('cook_min'),
      tags: String(fd.get('tags') || '').split(',').map((t) => t.trim()).filter(Boolean),
      steps: String(fd.get('steps') || '').split('\n').map((s) => s.trim()).filter(Boolean),
      description: fd.get('description'), image_url: fd.get('image_url'), source_url: fd.get('source_url'), notes: fd.get('notes'),
      site_kcal: r.site_kcal ?? null, favorite: !!r.favorite,
      ingredients: rows.filter((x) => x.text.trim()).map((x) => ({ text: x.text.trim(), food_id: x.food_id || null })),
    };
    try {
      const saved = isNew ? await api('POST', '/api/recipes', body) : await api('PUT', `/api/recipes/${recipe.id}`, body);
      sh.close();
      toast(isNew ? 'Recipe saved.' : 'Saved.');
      if (location.hash === `#recipe/${saved.id}`) render(); else go(`recipe/${saved.id}`);
    } catch (e) { $('#rerr', sh.el).textContent = e.message; }
  };
  if (isNew && !draft) setTimeout(() => $('[name=name]', sh.el).focus(), 60);
}

// ── import ──────────────────────────────────────────────────────────
export function openImportSheet() {
  const sh = openSheet({
    title: 'Import a recipe',
    body: `<div class="tabs"><button data-t="link" class="on">From a link</button><button data-t="paste">Paste text</button></div>
      <div data-p="link"><label class="field"><span>Recipe page link</span><input class="input" id="url" type="url" placeholder="https://…" inputmode="url"></label>
        <p class="muted small" style="margin-top:0">Works with most recipe sites. Some sites block apps - paste the text instead.</p></div>
      <div data-p="paste" class="hidden"><label class="field"><span>The recipe</span><textarea class="input" id="txt" rows="12" placeholder="Title&#10;&#10;Ingredients&#10;2 cups flour&#10;…&#10;&#10;Instructions&#10;1. Mix…"></textarea></label></div>
      <div class="err" id="ierr"></div>`,
    foot: '<button class="btn primary" data-go>Read recipe</button>',
  });
  let mode = 'link';
  $$('[data-t]', sh.el).forEach((b) => (b.onclick = () => {
    mode = b.dataset.t;
    $$('[data-t]', sh.el).forEach((x) => x.classList.toggle('on', x === b));
    $$('[data-p]', sh.el).forEach((p) => p.classList.toggle('hidden', p.dataset.p !== mode));
  }));
  setTimeout(() => $('#url', sh.el).focus(), 60);
  $('[data-go]', sh.el).onclick = async () => {
    const btn = $('[data-go]', sh.el);
    $('#ierr', sh.el).textContent = '';
    const payload = mode === 'link' ? { url: $('#url', sh.el).value.trim() } : { text: $('#txt', sh.el).value };
    if (!(payload.url || payload.text)) { $('#ierr', sh.el).textContent = mode === 'link' ? 'Paste a link first.' : 'Paste the recipe first.'; return; }
    btn.disabled = true;
    btn.textContent = 'Reading…';
    try {
      const d = await api('POST', '/api/recipes/parse', payload);
      sh.close();
      openRecipeEditor(d, { draft: true });
    } catch (e) {
      $('#ierr', sh.el).textContent = e.message;
    } finally { btn.disabled = false; btn.textContent = 'Read recipe'; }
  };
}
