// Turning planned meals into a shopping list: add up every ingredient, then take off
// what's in the pantry and what's already on the list. Shared by server and browser.
import { normUnit, convertQty, costFor, dimOf } from './units.js';
import { normalizeName, guessAisle } from './ingredients.js';

export function keyFor(foodId, name) {
  return foodId ? `f:${foodId}` : `n:${normalizeName(name) || String(name || '').toLowerCase().trim()}`;
}

// Fewest amounts that add up all the parts: one unit when everything converts
// (the food's shopping unit first), otherwise one amount per unit.
export function combine(parts, food) {
  if (!parts.length) return [];
  const cands = [];
  const push = (u) => { const n = normUnit(u); if (n && !cands.includes(n)) cands.push(n); };
  if (food && food.shop_unit) push(food.shop_unit);
  for (const p of parts) push(p.unit);
  push('g');
  for (const t of cands) {
    let sum = 0;
    let ok = true;
    for (const p of parts) {
      const v = convertQty(food, p.qty, p.unit, t, p.hint);
      if (v == null) { ok = false; break; }
      sum += v;
    }
    if (ok) return [{ qty: sum, unit: t }];
  }
  const by = new Map();
  for (const p of parts) {
    const u = normUnit(p.unit) || 'each';
    by.set(u, (by.get(u) || 0) + p.qty);
  }
  return [...by.entries()].map(([unit, qty]) => ({ qty, unit }));
}

// lines: [{ food_id, name, qty, unit, hint, for }]
export function aggregateNeeds(lines, foodsById) {
  const groups = new Map();
  for (const l of lines) {
    const food = l.food_id ? foodsById[l.food_id] : null;
    const key = keyFor(food && food.id, l.name);
    if (!groups.has(key)) {
      groups.set(key, {
        key, food_id: food ? food.id : null, name: food ? food.name : String(l.name || '').trim(),
        aisle: (food && food.aisle) || guessAisle(l.name), parts: [], for: [], someQty: false,
      });
    }
    const g = groups.get(key);
    if (l.for && !g.for.includes(l.for)) g.for.push(l.for);
    if (l.qty == null || !(l.qty > 0)) { g.someQty = true; continue; }
    g.parts.push({ qty: l.qty, unit: normUnit(l.unit) || 'each', hint: l.hint || null });
  }
  return [...groups.values()].map((g) => ({ ...g, total: combine(g.parts, g.food_id ? foodsById[g.food_id] : null) }));
}

// Take `have` amounts (pantry rows or list items: { qty, unit, untracked }) off `need`.
// Returns what is left to buy and what was covered. `untracked` = "have it, amount unknown".
export function subtract(need, have, food) {
  const left = need.map((a) => ({ ...a }));
  let covered = false;
  let unmatched = false;
  for (const h of have) {
    if (h.untracked || h.qty == null) { covered = true; continue; }
    let rest = h.qty;
    let used = false;
    for (const a of left) {
      if (rest <= 0) break;
      const inA = convertQty(food, rest, h.unit, a.unit, h.hint);
      if (inA == null) continue;
      used = true;
      const take = Math.min(a.qty, inA);
      a.qty -= take;
      rest -= convertQty(food, take, a.unit, h.unit, h.hint) ?? rest;
    }
    if (!used) unmatched = true;
  }
  const buy = covered ? [] : left.filter((a) => a.qty > 1e-6);
  return { buy, covered: covered || (need.length > 0 && buy.length === 0), unmatched };
}

export function costOf(amounts, food) {
  if (!food) return null;
  let total = 0;
  for (const a of amounts) {
    const c = costFor(food, a.qty, a.unit, a.hint);
    if (c == null) return null;
    total += c;
  }
  return total;
}

// You can't buy a quarter of a head of garlic or 1.6 cans: countable units round up to whole ones.
export function roundForBuying(amounts) {
  return amounts.map((a) => (dimOf(a.unit) === 'count' ? { ...a, qty: Math.max(1, Math.ceil(a.qty - 0.05)) } : a));
}
