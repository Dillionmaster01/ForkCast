// Ingredient lines ("1 (14 oz) can black beans, drained") into amount / unit / name,
// and matching a name to a food. Shared by the server and the browser.
import { normUnit, dimOf, MASS, VOLUME } from './units.js';

const UNICODE_FRACS = {
  '½': '1/2', '⅓': '1/3', '⅔': '2/3', '¼': '1/4', '¾': '3/4', '⅕': '1/5', '⅖': '2/5', '⅗': '3/5',
  '⅘': '4/5', '⅙': '1/6', '⅚': '5/6', '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8',
};
const NUM = String.raw`(?:\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?|\.\d+)`;
const SIZE = ['large', 'medium', 'small', 'extra-large', 'jumbo', 'big', 'xl'];

function num(s) {
  s = s.trim();
  const m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (m) return Number(m[3]) ? Number(m[1]) + Number(m[2]) / Number(m[3]) : Number(m[1]);
  const f = s.match(/^(\d+)\/(\d+)$/);
  if (f) return Number(f[2]) ? Number(f[1]) / Number(f[2]) : null;
  const v = parseFloat(s);
  return isFinite(v) ? v : null;
}

const PKG_RE = new RegExp(String.raw`^\(\s*(${NUM})\s*-?\s*([a-zA-Z. ]+?)\s*\)\s*`);

function packageGrams(qtyText, unitText) {
  const pu = normUnit(unitText);
  const pq = num(qtyText);
  if (!pu || pq == null) return null;
  if (MASS[pu] != null) return pq * MASS[pu];
  if (VOLUME[pu] != null) return pq * VOLUME[pu]; // ~1 g/ml: close enough for canned goods
  return null;
}

export function parseIngredient(text) {
  const original = String(text || '').replace(/\s+/g, ' ').trim();
  let s = original.replace(/^[\s\-–—•*▢□☐·]+/, '');
  for (const [k, v] of Object.entries(UNICODE_FRACS)) {
    s = s.replace(new RegExp(`(\\d)?${k}`, 'g'), (_m, d) => (d ? `${d} ` : ' ') + v);
  }
  s = s.replace(/(\d)\s*⁄\s*(\d)/g, '$1/$2').replace(/\s+/g, ' ').trim();

  let optional = false;
  if (/\(optional\)|,?\s*optional\s*$/i.test(s)) {
    optional = true;
    s = s.replace(/\s*\(optional\)\s*/i, ' ').replace(/,?\s*optional\s*$/i, '').trim();
  }

  let qty = null;
  let unit = null;
  let grams = null;
  const notes = [];

  const qm = s.match(new RegExp(String.raw`^(${NUM})(?:\s*(?:-|–|to)\s*(${NUM}))?\s*`));
  if (qm) {
    const a = num(qm[1]);
    const b = qm[2] ? num(qm[2]) : null;
    qty = b != null && a != null ? (a + b) / 2 : a;
    s = s.slice(qm[0].length);
  } else {
    const am = s.match(/^(a|an|one)\s+(?=\S)/i);
    if (am) {
      const rest = s.slice(am[0].length);
      const w = (rest.match(/^([A-Za-z.]+)/) || [])[1];
      // "a pinch of salt", "an onion" - but not "a few" / "a little"
      if (!/^(few|little|bit|handful|splash|drizzle|couple)\b/i.test(rest) && (normUnit(w) || /^[a-z]/i.test(rest))) {
        qty = 1;
        s = rest;
      }
    }
  }

  if (qty != null) {
    let pm = s.match(PKG_RE);
    if (pm) {
      grams = packageGrams(pm[1], pm[2]);
      notes.push(`${pm[1]} ${pm[2]}`.trim());
      s = s.slice(pm[0].length);
    }
    const um = s.match(/^(fl\.?\s*oz\.?|fluid\s+ounces?|[A-Za-z]+(?:-[a-z]+)?\.?)(?=[\s,(]|$)\s*/);
    if (um) {
      const word = um[1];
      const nu = normUnit(word);
      if (/^dozen$/i.test(word)) {
        qty *= 12;
        unit = 'each';
        s = s.slice(um[0].length);
      } else if (nu) {
        unit = nu;
        s = s.slice(um[0].length);
      } else if (SIZE.includes(word.toLowerCase())) {
        unit = 'each';
        notes.push(word.toLowerCase());
        s = s.slice(um[0].length);
      }
    }
    // "1 can (14 oz) tomatoes"
    if (grams == null && unit && dimOf(unit) === 'count') {
      pm = s.match(PKG_RE);
      if (pm) {
        grams = packageGrams(pm[1], pm[2]);
        notes.push(`${pm[1]} ${pm[2]}`.trim());
        s = s.slice(pm[0].length);
      }
    }
    if (!unit) unit = 'each';
    if (dimOf(unit) !== 'count') grams = null;
    // "2 cups minus 2 tablespoons flour", "1 cup plus 2 tablespoons sugar": the small fix-up is dropped
    s = s.replace(new RegExp(String.raw`^(plus|minus)\s+${NUM}\s+[A-Za-z.]+\s+`, 'i'), '');
  } else {
    // "Pinch of salt", "Dash hot sauce"
    const pm = s.match(/^(pinch|dash)(es)?\s+(of\s+)?/i);
    if (pm) { qty = 1; unit = normUnit(pm[1]); s = s.slice(pm[0].length); }
  }

  s = s.replace(/^of\s+/i, '');
  let name = s;
  const parens = name.match(/\(([^)]*)\)/g);
  if (parens) {
    for (const p of parens) notes.push(p.slice(1, -1).trim());
    name = name.replace(/\([^)]*\)/g, ' ');
  }
  const ci = name.indexOf(',');
  if (ci >= 0) {
    notes.push(name.slice(ci + 1).trim());
    name = name.slice(0, ci);
  }
  const taste = name.match(/\s+(to taste|as needed|for serving|for garnish|or to taste)\s*$/i);
  if (taste) {
    notes.push(taste[1].toLowerCase());
    name = name.slice(0, taste.index);
  }
  name = name.replace(/\s+/g, ' ').trim();

  return {
    text: original,
    qty: qty != null && isFinite(qty) ? qty : null,
    unit: qty != null ? unit : null,
    name: name || original,
    note: notes.filter(Boolean).join(', ') || null,
    grams,
    optional,
  };
}

// ── name matching ──────────────────────────────────────────────────────────
const DROP = new Set([
  'fresh', 'freshly', 'chopped', 'diced', 'minced', 'sliced', 'grated', 'shredded', 'finely', 'roughly', 'coarsely',
  'thinly', 'thickly', 'large', 'small', 'medium', 'extra', 'ripe', 'peeled', 'seeded', 'cubed', 'crushed', 'to', 'taste',
  'and', 'or', 'of', 'for', 'the', 'a', 'an', 'about', 'plus', 'divided', 'packed', 'softened', 'melted', 'room',
  'temperature', 'cold', 'warm', 'raw', 'organic', 'halved', 'quartered', 'trimmed', 'rinsed', 'drained',
  'lightly', 'beaten', 'optional', 'more', 'needed', 'serving', 'garnish', 'into', 'pieces', 'piece', 'inch', 'cut',
  'jumbo', 'xl', 'leaf', 'leaves', 'good', 'quality', 'store', 'bought', 'homemade', 'your', 'favorite', 'such', 'as', 'like', 'whole',
]);
// words that change what a thing is: "coconut milk" is not milk, "garlic powder" is not garlic
const IDENTITY = new Set([
  'coconut', 'almond', 'oat', 'soy', 'peanut', 'sweet', 'sour', 'condensed', 'evaporated', 'powder', 'powdered',
  'sauce', 'paste', 'juice', 'extract', 'oil', 'flour', 'starch', 'syrup', 'broth', 'stock', 'seasoning', 'chip',
  'cream', 'cheese', 'butter', 'milk', 'sugar', 'bread', 'crumb', 'vinegar', 'zest', 'seed', 'dried', 'jam',
  'frozen', 'canned', 'cooked', 'mix', 'dressing', 'cracker', 'noodle', 'tortilla', 'bouillon', 'gravy', 'soup', 'salsa',
]);

function singular(w) {
  if (w.length <= 3) return w;
  if (w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.endsWith('oes')) return w.slice(0, -2);
  if (w.endsWith('ves')) return w.slice(0, -3) + 'f';
  if (w.endsWith('ches') || w.endsWith('shes') || w.endsWith('xes')) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) return w.slice(0, -1);
  return w;
}

export function nameTokens(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s-]/g, ' ')
    .replace(/-/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !DROP.has(w))
    .map(singular)
    .filter((w) => w.length > 1);
}

export function normalizeName(s) {
  return nameTokens(s).join(' ');
}

function scoreTokens(q, t) {
  if (!t.length) return 0;
  const inter = t.filter((x) => q.includes(x)).length;
  if (!inter) return 0;
  let sc = (2 * inter) / (q.length + t.length);
  if (inter === t.length) sc += 0.3;
  if (q.some((x) => IDENTITY.has(x) && !t.includes(x))) sc *= 0.5;
  if (t.some((x) => IDENTITY.has(x) && !q.includes(x))) sc *= 0.6;
  return sc;
}

// Best food for an ingredient name, or null when nothing is a confident match.
// `unit` breaks ties: "2 cans diced tomatoes" wants the food that comes in cans.
export function matchFood(name, foods, { min = 0.6, allowRestaurant = false, unit = null } = {}) {
  const q = nameTokens(name);
  const pkg = unit && !['each', 'serving'].includes(unit) && dimOf(unit) === 'count' ? unit : null;
  if (!q.length) return null;
  let best = null;
  let bestScore = 0;
  for (const f of foods) {
    if (!f || f.archived) continue;
    if (f.source === 'restaurant' && !allowRestaurant) continue;
    const cands = [f.name, ...(f.aliases ? String(f.aliases).split(',') : [])];
    const bonus = pkg && f.units && f.units[pkg] ? 0.25 : 0;
    for (const c of cands) {
      let sc = scoreTokens(q, nameTokens(c));
      if (sc > 0) sc += bonus;
      if (sc > bestScore) {
        bestScore = sc;
        best = f;
      }
    }
  }
  return best && bestScore >= min ? { food: best, score: bestScore } : null;
}

// Ranked search for a picker: every food that shares a word, best first.
export function searchFoods(query, foods, limit = 30) {
  const q = nameTokens(query);
  const raw = String(query || '').toLowerCase().trim();
  if (!raw) return [];
  const out = [];
  for (const f of foods) {
    if (!f || f.archived) continue;
    const label = `${f.name} ${f.brand || ''}`.toLowerCase();
    let sc = 0;
    if (label.startsWith(raw)) sc = 3;
    else if (label.includes(raw)) sc = 2;
    const cands = [f.name, ...(f.aliases ? String(f.aliases).split(',') : []), f.brand || ''];
    for (const c of cands) sc = Math.max(sc, q.length ? scoreTokens(q, nameTokens(c)) : 0);
    if (sc > 0.25) out.push([sc, f]);
  }
  out.sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name));
  return out.slice(0, limit).map((x) => x[1]);
}

// Where something lives in a grocery store, for foods that didn't come with an aisle.
const AISLE_WORDS = [
  ['Produce', 'apple banana berry lemon lime orange grape melon onion garlic potato tomato lettuce spinach kale carrot celery pepper jalapeno cucumber zucchini squash broccoli cauliflower cabbage mushroom avocado cilantro parsley basil mint ginger scallion corn bean sprout herb fruit vegetable peach pear plum mango pineapple'],
  ['Meat & Seafood', 'chicken beef pork turkey bacon sausage ham steak salmon shrimp fish tuna cod tilapia lamb ground meat'],
  ['Dairy & Eggs', 'milk cheese butter yogurt cream egg sour cheddar mozzarella parmesan'],
  ['Bakery', 'bread bun roll bagel tortilla pita croissant muffin'],
  ['Frozen', 'frozen ice'],
  ['Spices', 'salt cumin paprika oregano cinnamon nutmeg chili thyme rosemary seasoning spice vanilla clove'],
  ['Drinks', 'juice soda coffee tea water'],
  ['Pantry', 'flour sugar rice pasta noodle oil vinegar sauce broth stock can bean lentil oat cereal honey syrup peanut nut chip cracker baking soda powder cornstarch ketchup mustard mayonnaise salsa'],
];

export function guessAisle(name) {
  const t = nameTokens(name);
  if (t.includes('frozen')) return 'Frozen';
  for (const [aisle, words] of AISLE_WORDS) {
    const set = words.split(' ');
    if (t.some((w) => set.includes(w))) return aisle;
  }
  return 'Other';
}

export const AISLES = ['Produce', 'Meat & Seafood', 'Dairy & Eggs', 'Bakery', 'Pantry', 'Spices', 'Frozen', 'Drinks', 'Snacks', 'Household', 'Other'];
