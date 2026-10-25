// Picking a food (household list, USDA, Open Food Facts, barcode) and editing one.
import { S, api, esc, h, $, $$, openSheet, toast, fail, icon, putFood, fmtK, fmtMoney } from './app.js';
import { searchFoods, AISLES } from '../shared/ingredients.js';
import { normUnit, VOLUME, unitLabel } from '../shared/units.js';

export const ALL_UNITS = ['g', 'oz', 'lb', 'kg', 'ml', 'l', 'tsp', 'tbsp', 'cup', 'floz', 'pint', 'quart', 'gallon', 'each', 'serving', 'slice', 'clove', 'can', 'jar', 'package', 'stick', 'bunch', 'head', 'stalk', 'loaf', 'carton', 'bottle', 'ear', 'fillet', 'link', 'strip', 'pinch', 'dash'];
const COUNTABLE = ALL_UNITS.slice(ALL_UNITS.indexOf('each'), ALL_UNITS.indexOf('pinch'));

export function unitName(u) {
  return { floz: 'fl oz', each: 'each / item' }[u] || u;
}

// Units an amount of this food can be given in, most natural first.
export function unitsFor(food) {
  if (!food) return ALL_UNITS;
  const out = [];
  const add = (u) => { if (u && !out.includes(u)) out.push(u); };
  const units = food.units || {};
  if (food.basis === 'each') {
    add('each');
    if (units.each) { add('g'); add('oz'); }
    return out;
  }
  add(food.shop_unit);
  for (const u of Object.keys(units)) add(u);
  const vol = food.ml_g || units.cup || units.tbsp || units.tsp;
  if (vol) ['cup', 'tbsp', 'tsp'].forEach(add);
  ['g', 'oz', 'lb'].forEach(add);
  if (vol) ['floz', 'ml'].forEach(add);
  return out;
}

export function defaultUnit(food) {
  if (!food) return 'each';
  if (food.basis === 'each') return 'each';
  const units = food.units || {};
  if (units.each) return 'each';
  if (units.serving) return 'serving';
  if (food.shop_unit && food.shop_unit !== 'each') return food.shop_unit;
  if (food.ml_g || units.cup) return 'cup';
  return 'g';
}

export function foodLine(f) {
  const per = f.basis === 'each' ? 'per item' : 'per 100 g';
  const src = { usda: 'USDA', off: 'Open Food Facts', seed: '', custom: 'yours', restaurant: '' }[f.source] || '';
  return `${f.kcal != null ? `${fmtK(f.kcal)} kcal ${per}` : 'no calories yet'}${f.brand ? ` · ${esc(f.brand)}` : ''}${src ? ` · ${src}` : ''}`;
}

export function priceText(f) {
  if (f.price == null || !f.price_qty) return '';
  const qty = f.price_qty === 1 ? '' : `${f.price_qty} `;
  const tag = f.price_source === 'estimate' ? ' (est.)' : f.price_source === 'paid' ? ' (paid)' : '';
  return `${fmtMoney(f.price)} / ${qty}${unitLabel(f.price_unit, f.price_qty) || 'each'}${tag}`;
}

// ── picker ──────────────────────────────────────────────────────────
export function openFoodPicker({ title = 'Choose a food', query = '', restaurants = false, onPick }) {
  const sh = openSheet({
    title,
    body: `<div class="row" style="margin-bottom:10px"><input class="input grow" id="fq" placeholder="Search foods" value="${esc(query)}" autocomplete="off"></div>
      <div class="list" id="local"></div>
      <div class="note" style="margin-top:12px"><b>Not in the list?</b> Look it up online or make your own.
        <div class="row wrap" style="margin-top:8px">
          <button class="btn sm" data-remote="usda">${icon('search')}USDA</button>
          <button class="btn sm" data-remote="off">${icon('search')}Packaged products</button>
          <button class="btn sm" data-scan>${icon('scan')}Barcode</button>
          <button class="btn sm" data-new>${icon('plus')}New food</button>
        </div></div>
      <div class="list" id="remote" style="margin-top:8px"></div>`,
  });
  const q = $('#fq', sh.el);
  const pick = (f) => { sh.close(); onPick(f); };
  const draw = () => {
    const pool = S.foods.filter((f) => !f.archived && (restaurants ? true : f.source !== 'restaurant'));
    const list = q.value.trim() ? searchFoods(q.value, pool, 40) : pool.filter((f) => f.source !== 'seed' && f.source !== 'restaurant').slice(-12).reverse();
    $('#local', sh.el).innerHTML = list.length
      ? list.map((f) => `<div class="li click" data-id="${esc(f.id)}"><div class="grow"><div class="t">${esc(f.name)}</div><div class="s">${foodLine(f)}</div></div></div>`).join('')
      : `<div class="muted small" style="padding:8px 4px">${q.value.trim() ? 'Nothing in your foods matches.' : 'Type to search your foods.'}</div>`;
    $$('#local .li', sh.el).forEach((el) => (el.onclick = () => pick(S.foodsById[el.dataset.id])));
  };
  q.oninput = draw;
  draw();
  setTimeout(() => q.focus(), 60);

  $$('[data-remote]', sh.el).forEach((b) => (b.onclick = async () => {
    const term = q.value.trim();
    if (term.length < 2) { toast('Type what you are looking for first.'); q.focus(); return; }
    const box = $('#remote', sh.el);
    box.innerHTML = '<div class="muted small" style="padding:8px">Looking it up…</div>';
    try {
      const r = await api('GET', `/api/foods/remote?source=${b.dataset.remote}&q=${encodeURIComponent(term)}`);
      if (!r.results.length) { box.innerHTML = '<div class="muted small" style="padding:8px">Nothing found online.</div>'; return; }
      box.innerHTML = r.results.map((f, i) => `<div class="li click" data-i="${i}"><div class="grow"><div class="t">${esc(f.name)}</div>
        <div class="s">${f.kcal != null ? `${fmtK(f.kcal)} kcal per 100 g` : 'no calorie data'}${f.brand ? ` · ${esc(f.brand)}` : ''}${f.detail ? ` · ${esc(f.detail)}` : ''}</div></div>
        <span class="badge">${r.source === 'usda' ? 'USDA' : 'OFF'}</span></div>`).join('');
      $$('.li', box).forEach((el) => (el.onclick = async () => {
        const f = r.results[Number(el.dataset.i)];
        if (f.kcal == null) { toast('That one has no calorie information.'); return; }
        el.style.opacity = '.5';
        try {
          const saved = await api('POST', '/api/foods/remote-import', { source: f.source, ref: f.ref });
          putFood(saved);
          pick(saved);
        } catch (e) { el.style.opacity = ''; fail(e); }
      }));
    } catch (e) { box.innerHTML = `<div class="err" style="padding:8px">${esc(e.message)}</div>`; }
  }));
  $('[data-scan]', sh.el).onclick = () => openScanner((f) => pick(f));
  $('[data-new]', sh.el).onclick = () => openFoodForm(null, { name: q.value.trim(), restaurant: restaurants === 'only', onSaved: (f) => pick(f) });
  return sh;
}

// ── barcode ─────────────────────────────────────────────────────────
export function openScanner(onFound) {
  const canScan = 'BarcodeDetector' in window && navigator.mediaDevices?.getUserMedia;
  const sh = openSheet({
    title: 'Barcode',
    body: `${canScan ? '<video id="cam" playsinline muted style="width:100%;border-radius:12px;background:#000;aspect-ratio:4/3;object-fit:cover"></video><p class="muted small">Point the camera at the barcode.</p>' : '<p class="muted small" style="margin-top:0">This browser can\'t read barcodes with the camera. Type the numbers under the barcode instead.</p>'}
      <form id="bf" class="row"><input class="input grow" id="code" inputmode="numeric" placeholder="Barcode number"><button class="btn primary">Look up</button></form>
      <div class="err" id="berr"></div>`,
    onClose: () => stop(),
  });
  let stream = null;
  let timer = null;
  const stop = () => { if (timer) clearInterval(timer); if (stream) stream.getTracks().forEach((t) => t.stop()); };
  const lookup = async (code) => {
    $('#berr', sh.el).textContent = '';
    try {
      const r = await api('GET', `/api/foods/barcode/${encodeURIComponent(code)}`);
      putFood(r.food);
      sh.close();
      onFound(r.food);
    } catch (e) { $('#berr', sh.el).textContent = e.message; }
  };
  $('#bf', sh.el).onsubmit = (e) => { e.preventDefault(); const c = $('#code', sh.el).value.replace(/\D/g, ''); if (c) lookup(c); };
  if (canScan) {
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        const v = $('#cam', sh.el);
        v.srcObject = stream;
        await v.play();
        const det = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] });
        timer = setInterval(async () => {
          try {
            const codes = await det.detect(v);
            if (codes.length) { stop(); $('#code', sh.el).value = codes[0].rawValue; lookup(codes[0].rawValue); }
          } catch { /* keep trying */ }
        }, 350);
      } catch {
        $('#berr', sh.el).textContent = "Couldn't open the camera - type the number instead.";
      }
    })();
  }
}

// ── food form ───────────────────────────────────────────────────────
export function openFoodForm(food, { name = '', restaurant = false, onSaved } = {}) {
  const f = food || { name, basis: restaurant ? 'each' : 'g', source: restaurant ? 'restaurant' : 'custom', units: {}, aisle: 'Other' };
  const isRest = f.source === 'restaurant';
  const units = { ...(f.units || {}) };
  if (!units.cup && f.ml_g) units.cup = Math.round(f.ml_g * VOLUME.cup);
  const unitRows = Object.entries(units);
  const opt = (list, cur) => list.map((u) => `<option value="${u}" ${u === cur ? 'selected' : ''}>${esc(unitName(u))}</option>`).join('');
  const sh = openSheet({
    title: food ? 'Edit food' : isRest ? 'New restaurant item' : 'New food',
    wide: true,
    body: `<form id="ff">
      <div class="grid2"><label class="field"><span>Name</span><input class="input" name="name" required maxlength="120" value="${esc(f.name)}"></label>
      <label class="field"><span>${isRest ? 'Restaurant' : 'Brand (optional)'}</span><input class="input" name="brand" maxlength="80" value="${esc(f.brand || '')}"></label></div>
      ${isRest ? '' : `<label class="field"><span>Nutrition is</span><select class="input" name="basis"><option value="g" ${f.basis !== 'each' ? 'selected' : ''}>per 100 g</option><option value="each" ${f.basis === 'each' ? 'selected' : ''}>per item / serving</option></select></label>`}
      <div class="grid4"><label class="field"><span>Calories</span><input class="input" name="kcal" type="number" step="any" min="0" value="${f.kcal ?? ''}" required></label>
      <label class="field"><span>Protein g</span><input class="input" name="protein" type="number" step="any" min="0" value="${f.protein ?? ''}"></label>
      <label class="field"><span>Carbs g</span><input class="input" name="carbs" type="number" step="any" min="0" value="${f.carbs ?? ''}"></label>
      <label class="field"><span>Fat g</span><input class="input" name="fat" type="number" step="any" min="0" value="${f.fat ?? ''}"></label></div>
      ${isRest ? '' : `
      <div class="field"><span>What one of these weighs (lets recipes use cups, slices, cans…)</span>
        <div id="urows" class="list"></div><button type="button" class="link" id="addu" style="align-self:flex-start;margin-top:4px">+ Add a weight</button></div>
      <div class="grid2"><label class="field"><span>Store aisle</span><select class="input" name="aisle">${AISLES.map((a) => `<option ${a === f.aisle ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select></label>
      <label class="field"><span>Buy it by the</span><select class="input" name="shop_unit"><option value="">(any)</option>${opt(ALL_UNITS, f.shop_unit)}</select></label></div>
      <div class="field"><span>Price</span><div class="row"><span>$</span><input class="input" name="price" type="number" step="0.01" min="0" style="max-width:110px" value="${f.price ?? ''}">
        <span class="muted">per</span><input class="input" name="price_qty" type="number" step="any" min="0" style="max-width:80px" value="${f.price_qty ?? 1}">
        <select class="input" name="price_unit" style="max-width:130px">${opt(ALL_UNITS, f.price_unit || 'each')}</select></div>
        ${f.price_source === 'estimate' ? '<span class="tiny muted">Starter price is a rough US estimate - change it to what you pay.</span>' : ''}</div>
      <label class="field"><span>Other names (comma separated, helps recipes find it)</span><input class="input" name="aliases" value="${esc(f.aliases || '')}"></label>
      <label class="row small" style="margin-bottom:8px"><input type="checkbox" name="no_shop" ${f.no_shop ? 'checked' : ''}> Never put this on the shopping list</label>`}
      <div class="err" id="ferr"></div></form>`,
    foot: `${food && food.id ? `<button class="btn ghost danger" data-del>${icon('trash')}Remove</button><span class="spacer"></span>` : ''}<button class="btn" data-close2>Cancel</button><button class="btn primary" data-save>Save</button>`,
  });
  const urow = (u = 'each', g = '') => h(`<div class="row" style="padding:4px 0"><span class="muted">1</span><select class="input" style="max-width:140px" data-u>${opt(COUNTABLE.concat(['cup', 'tbsp', 'tsp']), u)}</select><span class="muted">=</span><input class="input" type="number" step="any" min="0" style="max-width:100px" data-g value="${esc(g)}"><span class="muted">g</span><button type="button" class="btn ghost sm icon" data-x>${icon('close')}</button></div>`);
  const ur = $('#urows', sh.el);
  if (ur) {
    const addRow = (u, g) => { const r = urow(u, g); $('[data-x]', r).onclick = () => r.remove(); ur.appendChild(r); };
    unitRows.forEach(([u, g]) => addRow(u, g));
    $('#addu', sh.el).onclick = () => addRow('each', '');
  }
  $('[data-close2]', sh.el).onclick = () => sh.close();
  const del = $('[data-del]', sh.el);
  if (del) del.onclick = async () => {
    try {
      const r = await api('DELETE', `/api/foods/${food.id}`);
      if (r.archived) putFood({ ...food, archived: true }); else { S.foods = S.foods.filter((x) => x.id !== food.id); delete S.foodsById[food.id]; }
      toast(r.archived ? 'Removed (kept for meals that already use it).' : 'Food removed.');
      sh.close();
      onSaved && onSaved(null);
    } catch (e) { fail(e); }
  };
  $('[data-save]', sh.el).onclick = async () => {
    const form = $('#ff', sh.el);
    if (!form.reportValidity()) return;
    const fd = new FormData(form);
    const n = (k) => (fd.get(k) === '' || fd.get(k) == null ? null : Number(fd.get(k)));
    const body = { name: fd.get('name'), brand: fd.get('brand'), kcal: n('kcal'), protein: n('protein'), carbs: n('carbs'), fat: n('fat') };
    if (isRest) body.source = 'restaurant';
    else {
      body.basis = fd.get('basis');
      const u = {};
      $$('#urows .row', sh.el).forEach((r) => { const g = Number($('[data-g]', r).value); if (g > 0) u[$('[data-u]', r).value] = g; });
      body.units = u;
      body.ml_g = u.cup ? Math.round((u.cup / VOLUME.cup) * 1000) / 1000 : u.tbsp ? Math.round((u.tbsp / VOLUME.tbsp) * 1000) / 1000 : (f.ml_g ?? null);
      body.aisle = fd.get('aisle');
      body.shop_unit = fd.get('shop_unit') || null;
      body.aliases = fd.get('aliases');
      body.no_shop = !!fd.get('no_shop');
      const price = n('price');
      if (price !== f.price || n('price_qty') !== f.price_qty || fd.get('price_unit') !== f.price_unit) {
        body.price = price;
        body.price_qty = n('price_qty') || 1;
        body.price_unit = fd.get('price_unit');
      }
    }
    try {
      const saved = food && food.id ? await api('PUT', `/api/foods/${food.id}`, body) : await api('POST', '/api/foods', body);
      putFood(saved);
      sh.close();
      onSaved && onSaved(saved);
    } catch (e) { $('#ferr', sh.el).textContent = e.message; }
  };
}

export { normUnit };
