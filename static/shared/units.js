// Units, conversions and the nutrition / cost math.
// Shared as-is by the server (bundled by wrangler) and the browser, so a recipe's
// calories can never disagree between the two.
//
// A food carries its nutrition either per 100 g (basis "g") or per item (basis "each",
// used for restaurant items), plus what it needs to turn other units into grams:
//   ml_g   grams per millilitre (density) - lets any cup/tbsp/tsp amount convert
//   units  { unit: grams in one of it }   - e.g. { each: 50 } for an egg, { clove: 3 }

export const MASS = { mg: 0.001, g: 1, kg: 1000, oz: 28.3495, lb: 453.592 };
export const VOLUME = {
  pinch: 0.31, dash: 0.62, ml: 1, tsp: 4.92892, tbsp: 14.7868, floz: 29.5735,
  cup: 236.588, pint: 473.176, quart: 946.353, l: 1000, gallon: 3785.41,
};
export const COUNT = [
  'each', 'serving', 'clove', 'slice', 'can', 'jar', 'package', 'stick', 'bunch', 'head',
  'stalk', 'sprig', 'leaf', 'loaf', 'carton', 'bottle', 'ear', 'fillet', 'link', 'strip',
];

const ALIASES = {
  gram: 'g', grams: 'g', gr: 'g', gm: 'g', gms: 'g', kilogram: 'kg', kilograms: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg',
  milligram: 'mg', milligrams: 'mg', ounce: 'oz', ounces: 'oz', ozs: 'oz', pound: 'lb', pounds: 'lb', lbs: 'lb',
  milliliter: 'ml', milliliters: 'ml', millilitre: 'ml', millilitres: 'ml', mls: 'ml', cc: 'ml',
  liter: 'l', liters: 'l', litre: 'l', litres: 'l', ltr: 'l',
  teaspoon: 'tsp', teaspoons: 'tsp', tsps: 'tsp', tspn: 'tsp',
  tablespoon: 'tbsp', tablespoons: 'tbsp', tbs: 'tbsp', tbl: 'tbsp', tbls: 'tbsp', tbsps: 'tbsp', tblsp: 'tbsp', tblspn: 'tbsp',
  cups: 'cup', c: 'cup',
  'fl oz': 'floz', 'fl oz.': 'floz', 'fluid ounce': 'floz', 'fluid ounces': 'floz', 'fl ounce': 'floz', 'fl ounces': 'floz',
  pints: 'pint', pt: 'pint', pts: 'pint', quarts: 'quart', qt: 'quart', qts: 'quart', gallons: 'gallon', gal: 'gallon', gals: 'gallon',
  pinches: 'pinch', dashes: 'dash',
  ea: 'each', piece: 'each', pieces: 'each', pc: 'each', pcs: 'each', whole: 'each', item: 'each', items: 'each', count: 'each', ct: 'each',
  servings: 'serving', portion: 'serving', portions: 'serving',
  cloves: 'clove', slices: 'slice', cans: 'can', tin: 'can', tins: 'can', jars: 'jar',
  packages: 'package', pkg: 'package', pkgs: 'package', packet: 'package', packets: 'package', pack: 'package', packs: 'package',
  bag: 'package', bags: 'package', box: 'package', boxes: 'package', container: 'package', containers: 'package', envelope: 'package',
  sticks: 'stick', bunches: 'bunch', heads: 'head', stalks: 'stalk', rib: 'stalk', ribs: 'stalk', sprigs: 'sprig',
  leaves: 'leaf', loaves: 'loaf', cartons: 'carton', bottles: 'bottle', ears: 'ear', fillets: 'fillet', filets: 'fillet', filet: 'fillet',
  links: 'link', strips: 'strip',
};

// Canonical unit name, or null when the word isn't a unit at all.
export function normUnit(u) {
  if (u == null) return null;
  let s = String(u).trim();
  if (!s) return null;
  if (s === 'T' || s === 'Tb' || s === 'TB' || s === 'Tbs') return 'tbsp';
  if (s === 't') return 'tsp';
  s = s.toLowerCase().replace(/\.+$/, '').replace(/\./g, '').replace(/\s+/g, ' ');
  if (MASS[s] != null || VOLUME[s] != null || COUNT.includes(s)) return s;
  return ALIASES[s] || null;
}

export function dimOf(unit) {
  const u = normUnit(unit) || 'each';
  if (MASS[u] != null) return 'mass';
  if (VOLUME[u] != null) return 'volume';
  return 'count';
}

// Grams in ONE of `unit` for this food, or null when it can't be known.
export function unitGrams(food, unit) {
  const u = normUnit(unit) || 'each';
  if (MASS[u] != null) return MASS[u];
  const units = (food && food.units) || {};
  if (units[u] != null && Number(units[u]) > 0) return Number(units[u]);
  if (VOLUME[u] != null) {
    if (food && food.ml_g) return VOLUME[u] * food.ml_g;
    for (const v of ['cup', 'tbsp', 'tsp', 'ml']) {
      if (units[v]) return (VOLUME[u] * Number(units[v])) / VOLUME[v];
    }
    return null;
  }
  if (u === 'serving' && units.each) return Number(units.each);
  if (u === 'each' && units.serving) return Number(units.serving);
  return null;
}

// hint = grams in one package for "1 (14 oz) can" style lines
export function toGrams(food, qty, unit, hint) {
  if (qty == null || !isFinite(qty)) return null;
  const u = normUnit(unit) || 'each';
  if (hint && dimOf(u) === 'count') return qty * hint;
  const g = unitGrams(food, u);
  return g == null ? null : qty * g;
}

export function convertQty(food, qty, from, to, hint) {
  if (qty == null) return null;
  const f = normUnit(from) || 'each';
  const t = normUnit(to) || 'each';
  if (f === t) return qty;
  if (MASS[f] != null && MASS[t] != null) return (qty * MASS[f]) / MASS[t];
  if (VOLUME[f] != null && VOLUME[t] != null) return (qty * VOLUME[f]) / VOLUME[t];
  const g = toGrams(food, qty, f, hint);
  const gt = unitGrams(food, t);
  if (g == null || !gt) return null;
  return g / gt;
}

export const ZERO = Object.freeze({ kcal: 0, protein: 0, carbs: 0, fat: 0 });

// Calories and macros for an amount of a food, or null when the amount can't be
// turned into the food's basis (e.g. "2 cups" of something with no density).
export function nutritionFor(food, qty, unit, hint) {
  if (!food || food.kcal == null || qty == null || !isFinite(qty)) return null;
  let factor;
  const u = normUnit(unit) || 'each';
  if (food.basis === 'each') {
    if (dimOf(u) === 'count' && !hint) factor = qty;
    else {
      const g = toGrams(food, qty, u, hint);
      const eg = food.units && Number(food.units.each);
      if (g == null || !eg) return null;
      factor = g / eg;
    }
  } else {
    const g = toGrams(food, qty, u, hint);
    if (g == null) return null;
    factor = g / 100;
  }
  return {
    kcal: (Number(food.kcal) || 0) * factor,
    protein: (Number(food.protein) || 0) * factor,
    carbs: (Number(food.carbs) || 0) * factor,
    fat: (Number(food.fat) || 0) * factor,
  };
}

// What an amount costs at the food's saved price ("$2.98 per 1 lb"), or null.
export function costFor(food, qty, unit, hint) {
  if (!food || food.price == null || !(Number(food.price_qty) > 0) || qty == null) return null;
  const n = convertQty(food, qty, unit, food.price_unit || 'each', hint);
  return n == null ? null : (Number(food.price) * n) / Number(food.price_qty);
}

export function addNut(a, b, k = 1) {
  return {
    kcal: a.kcal + b.kcal * k, protein: a.protein + b.protein * k,
    carbs: a.carbs + b.carbs * k, fat: a.fat + b.fat * k,
  };
}

// ── display ────────────────────────────────────────────────────────────────
const FRACS = [[1 / 8, '⅛'], [1 / 4, '¼'], [1 / 3, '⅓'], [3 / 8, '⅜'], [1 / 2, '½'], [5 / 8, '⅝'], [2 / 3, '⅔'], [3 / 4, '¾'], [7 / 8, '⅞']];
const FRACTION_UNITS = new Set(['cup', 'tsp', 'tbsp', 'each', 'can', 'jar', 'package', 'stick', 'bunch', 'head', 'stalk', 'clove', 'slice', 'loaf', 'serving', 'lb', 'pint', 'quart', 'gallon']);

export function fmtQty(n, unit) {
  if (n == null || !isFinite(n)) return '';
  if (n <= 0) return '0';
  const u = normUnit(unit) || 'each';
  if (n >= 20) return String(Math.round(n));
  if (FRACTION_UNITS.has(u)) {
    let whole = Math.floor(n);
    const frac = n - whole;
    if (frac > 0.94) return String(whole + 1);
    if (frac < 0.06) return whole ? String(whole) : String(Math.round(n * 100) / 100);
    let best = null;
    let gap = 0.045;
    for (const [v, sym] of FRACS) if (Math.abs(frac - v) < gap) { best = sym; gap = Math.abs(frac - v); }
    if (best) return whole ? `${whole} ${best}` : best;
  }
  if (n < 0.1) return String(Math.round(n * 100) / 100);
  return String(Math.round(n * 10) / 10);
}

const PLURAL = { leaf: 'leaves', loaf: 'loaves', bunch: 'bunches', package: 'packages', each: '' };
const LABEL = { floz: 'fl oz', each: '' };

export function unitLabel(unit, qty) {
  const u = normUnit(unit) || unit || 'each';
  if (LABEL[u] != null) return LABEL[u];
  if (MASS[u] != null || ['tsp', 'tbsp', 'ml', 'l', 'pinch', 'dash'].includes(u)) return u;
  if (qty != null && qty > 1.0001) return PLURAL[u] != null ? PLURAL[u] : u + 's';
  return u;
}

export function fmtAmount(qty, unit) {
  if (qty == null) return '';
  let u = normUnit(unit) || 'each';
  let q = qty;
  // plain grams read better as ounces / pounds on a US shopping list
  if (u === 'g') {
    if (q >= 340) { q = q / MASS.lb; u = 'lb'; } else { q = q / MASS.oz; u = 'oz'; }
  }
  if (u === 'ml' && q >= 240) { q = q / VOLUME.cup; u = 'cup'; }
  const lab = unitLabel(u, q);
  return lab ? `${fmtQty(q, u)} ${lab}` : fmtQty(q, u);
}

export function money(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
