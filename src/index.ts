import { Hono } from "hono";
import { hashPin, makeSalt, newId, newToken, nowIso } from "./auth";
import { SEED_FOODS, SEED_RESTAURANTS, slug } from "./seed";
import { extractRecipeFromHtml, parseRecipeText, fetchRecipePage, type RecipeDraft } from "./recipeImport";
import { searchUsda, usdaDetails, searchOff, offBarcode, type RemoteFood } from "./foodSearch";
// @ts-ignore - shared plain-JS modules (also served to the browser)
import { nutritionFor, costFor, normUnit, convertQty, addNut, ZERO, money, fmtAmount, dimOf } from "../static/shared/units.js";
// @ts-ignore
import { parseIngredient, matchFood, guessAisle, AISLES } from "../static/shared/ingredients.js";
// @ts-ignore
import { aggregateNeeds, subtract, keyFor, costOf, roundForBuying } from "../static/shared/shopping.js";

export interface Env {
  DB: D1Database;
  USDA_API_KEY?: string;
  ALLOW_TEST_RESET?: string;
}

type UserRow = {
  id: string; name: string; pin_hash: string; pin_salt: string; is_admin: number; must_change_pin: number;
  color: string; kcal_goal: number | null; protein_goal: number | null; carbs_goal: number | null; fat_goal: number | null;
  failed_logins: number; locked_until: string | null; created_at: string;
};
type Nut = { kcal: number; protein: number; carbs: number; fat: number };

const app = new Hono<{ Bindings: Env; Variables: { user: UserRow } }>();

const SLOTS = ["breakfast", "lunch", "dinner", "dessert", "snack"];
const STATUSES = ["planned", "eaten", "skipped"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COLORS = ["#d9534f", "#2f8f6b", "#7c5cc4", "#e08a1e", "#2b7bb9", "#c2477d"];

// ───────────────────────── helpers ─────────────────────────
const bad = (c: any, detail: string, status = 400) => c.json({ detail }, status);
async function body(c: any): Promise<any> {
  try {
    const b = await c.req.json();
    return b && typeof b === "object" ? b : {};
  } catch {
    return {};
  }
}
const isDate = (s: unknown): s is string => typeof s === "string" && DATE_RE.test(s) && !isNaN(Date.parse(s + "T00:00:00Z"));
function num(v: unknown, { min = -Infinity, max = Infinity, nullable = true } = {}): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return nullable ? null : undefined;
  const n = Number(v);
  if (!isFinite(n) || n < min || n > max) return undefined;
  return n;
}
const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
function addDays(iso: string, n: number) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a: string, b: string) {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
}
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const shortDay = (iso: string) => `${DOW[new Date(iso + "T00:00:00Z").getUTCDay()]} ${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
const roundNut = (n: Nut): Nut => ({ kcal: Math.round(n.kcal), protein: Math.round(n.protein * 10) / 10, carbs: Math.round(n.carbs * 10) / 10, fat: Math.round(n.fat * 10) / 10 });

async function selectIn<T = any>(env: Env, sql: string, ids: string[], extra: unknown[] = []): Promise<T[]> {
  const out: T[] = [];
  const uniq = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 80) {
    const chunk = uniq.slice(i, i + 80);
    const q = sql.replace("{IN}", chunk.map(() => "?").join(","));
    const { results } = await env.DB.prepare(q).bind(...chunk, ...extra).all();
    out.push(...(results as T[]));
  }
  return out;
}

function userOut(u: UserRow, self = false) {
  return {
    id: u.id, name: u.name, color: u.color, isAdmin: !!u.is_admin,
    goals: { kcal: u.kcal_goal, protein: u.protein_goal, carbs: u.carbs_goal, fat: u.fat_goal },
    ...(self ? { mustChangePin: !!u.must_change_pin } : {}),
  };
}

// ───────────────────────── foods ─────────────────────────
export function foodFromRow(r: any) {
  let units: Record<string, number> = {};
  try { units = r.units ? JSON.parse(r.units) : {}; } catch { units = {}; }
  return {
    id: r.id, name: r.name, brand: r.brand, source: r.source, source_ref: r.source_ref, basis: r.basis,
    kcal: r.kcal, protein: r.protein, carbs: r.carbs, fat: r.fat, ml_g: r.ml_g, units, aisle: r.aisle,
    aliases: r.aliases, price: r.price, price_qty: r.price_qty, price_unit: r.price_unit, price_source: r.price_source,
    price_updated: r.price_updated, shop_unit: r.shop_unit, no_shop: !!r.no_shop, archived: !!r.archived,
  };
}
type Food = ReturnType<typeof foodFromRow>;

async function allFoods(env: Env): Promise<Map<string, Food>> {
  const { results } = await env.DB.prepare("SELECT * FROM foods").all();
  return new Map((results as any[]).map((r) => [r.id, foodFromRow(r)]));
}

function foodInput(b: any, partial: boolean): { row?: Record<string, unknown>; error?: string } {
  const row: Record<string, unknown> = {};
  if (!partial || b.name !== undefined) {
    const name = str(b.name, 120);
    if (!name) return { error: "Give the food a name." };
    row.name = name;
  }
  if (b.brand !== undefined) row.brand = str(b.brand, 80) || null;
  if (b.basis !== undefined || !partial) row.basis = b.basis === "each" ? "each" : "g";
  for (const k of ["kcal", "protein", "carbs", "fat"]) {
    if (b[k] === undefined) continue;
    const v = num(b[k], { min: 0, max: 20000 });
    if (v === undefined) return { error: `${k} should be a number.` };
    row[k] = v;
  }
  if (b.ml_g !== undefined) {
    const v = num(b.ml_g, { min: 0.01, max: 5 });
    if (v === undefined) return { error: "Density should be between 0.01 and 5 g/ml." };
    row.ml_g = v;
  }
  if (b.units !== undefined) {
    const units: Record<string, number> = {};
    if (b.units && typeof b.units === "object") {
      for (const [k, v] of Object.entries(b.units)) {
        const u = normUnit(k);
        const g = Number(v);
        if (u && g > 0 && g < 100000) units[u] = Math.round(g * 100) / 100;
      }
    }
    row.units = JSON.stringify(units);
  }
  if (b.aisle !== undefined) row.aisle = AISLES.includes(b.aisle) ? b.aisle : "Other";
  if (b.aliases !== undefined) row.aliases = str(b.aliases, 500) || null;
  if (b.price !== undefined) {
    const v = num(b.price, { min: 0, max: 10000 });
    if (v === undefined) return { error: "Price should be a number." };
    row.price = v;
    row.price_updated = nowIso();
    row.price_source = v == null ? null : b.price_source === "paid" ? "paid" : "entered";
  }
  if (b.price_qty !== undefined) {
    const v = num(b.price_qty, { min: 0.0001, max: 100000 });
    if (v === undefined) return { error: "The price amount should be more than 0." };
    row.price_qty = v;
  }
  if (b.price_unit !== undefined) row.price_unit = normUnit(b.price_unit) || "each";
  if (b.shop_unit !== undefined) row.shop_unit = normUnit(b.shop_unit) || null;
  if (b.no_shop !== undefined) row.no_shop = b.no_shop ? 1 : 0;
  if (b.archived !== undefined) row.archived = b.archived ? 1 : 0;
  return { row };
}

async function insertFood(env: Env, row: Record<string, unknown>, userId: string | null) {
  const id = newId();
  const full: Record<string, unknown> = {
    id, source: "custom", basis: "g", aisle: "Other", units: "{}", created_by: userId, created_at: nowIso(), ...row,
  };
  if (full.aisle === "Other" && full.source !== "restaurant") full.aisle = guessAisle(String(full.name));
  const keys = Object.keys(full);
  await env.DB.prepare(`INSERT INTO foods (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
    .bind(...keys.map((k) => full[k] ?? null))
    .run();
  return id;
}

async function seedFoods(env: Env) {
  const ts = nowIso();
  const stmts: D1PreparedStatement[] = [];
  const ins = env.DB.prepare(
    `INSERT OR IGNORE INTO foods (id, name, brand, source, source_ref, basis, kcal, protein, carbs, fat, ml_g, units, aisle, aliases,
      price, price_qty, price_unit, price_source, price_updated, shop_unit, no_shop, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  for (const f of SEED_FOODS) {
    stmts.push(ins.bind(newId(), f.n, null, "seed", slug(f.n), "g", f.k, f.p, f.c, f.f, f.d ?? null, JSON.stringify(f.u || {}),
      f.a, f.al ?? null, f.pr ? f.pr[0] : null, f.pr ? f.pr[1] : null, f.pr ? f.pr[2] : null, f.pr ? "estimate" : null,
      f.pr ? ts : null, f.su ?? null, 0, ts));
  }
  for (const [brand, item, k, p, c, fat] of SEED_RESTAURANTS) {
    stmts.push(ins.bind(newId(), item, brand, "restaurant", slug(`${brand} ${item}`), "each", k, p, c, fat, null, "{}",
      "Restaurants", null, null, null, null, null, null, null, 1, ts));
  }
  await env.DB.batch(stmts);
  return stmts.length;
}

// ───────────────────────── recipes ─────────────────────────
type RecipeOut = ReturnType<typeof computeRecipe>;

function computeRecipe(r: any, ings: any[], foods: Map<string, Food>, sides: any[] = []) {
  let total: Nut = { ...ZERO };
  let cost = 0;
  let costLines = 0;
  let unmatched = 0;
  let unconverted = 0;
  const lines = ings.map((i) => {
    const food = i.food_id ? foods.get(i.food_id) : null;
    let kcal: number | null = null;
    let lineCost: number | null = null;
    if (!food) {
      if (i.qty != null) unmatched++;
    } else if (i.qty != null) {
      const n = nutritionFor(food, i.qty, i.unit, i.grams);
      if (n) {
        total = addNut(total, n);
        kcal = Math.round(n.kcal);
      } else unconverted++;
      lineCost = costFor(food, i.qty, i.unit, i.grams);
      if (lineCost != null) { cost += lineCost; costLines++; }
    }
    return {
      id: i.id, position: i.position, text: i.text, qty: i.qty, unit: i.unit, name: i.name, note: i.note,
      food_id: food ? food.id : null, food_name: food ? food.name : null, grams: i.grams, optional: !!i.optional,
      kcal, cost: lineCost == null ? null : money(lineCost),
    };
  });
  const servings = Number(r.servings) > 0 ? Number(r.servings) : 1;
  const costable = lines.filter((l) => l.food_id && l.qty != null).length;
  let steps: string[] = [];
  try { steps = r.steps ? JSON.parse(r.steps) : []; } catch { steps = []; }
  return {
    id: r.id, name: r.name, servings, description: r.description, steps, source_url: r.source_url, image_url: r.image_url,
    prep_min: r.prep_min, cook_min: r.cook_min, tags: r.tags ? String(r.tags).split(",").map((t: string) => t.trim()).filter(Boolean) : [],
    notes: r.notes, site_kcal: r.site_kcal, favorite: !!r.favorite, archived: !!r.archived, created_at: r.created_at, updated_at: r.updated_at,
    is_side: !!r.is_side, sides,
    ingredients: lines,
    total: roundNut(total),
    perServing: roundNut({ kcal: total.kcal / servings, protein: total.protein / servings, carbs: total.carbs / servings, fat: total.fat / servings }),
    cost: costLines ? money(cost) : null,
    costPerServing: costLines ? money(cost / servings) : null,
    costPartial: costLines > 0 && costLines < costable,
    unmatched, unconverted,
  };
}

async function recipeBundle(env: Env, foods: Map<string, Food>, ids: string[] | null): Promise<Map<string, RecipeOut>> {
  let rows: any[];
  if (ids) {
    if (!ids.length) return new Map();
    rows = await selectIn(env, "SELECT * FROM recipes WHERE id IN ({IN})", ids);
  } else {
    rows = (await env.DB.prepare("SELECT * FROM recipes WHERE archived = 0 ORDER BY name COLLATE NOCASE").all()).results as any[];
  }
  const ingRows = await selectIn(env, "SELECT * FROM recipe_ingredients WHERE recipe_id IN ({IN}) ORDER BY position", rows.map((r) => r.id));
  const byRecipe = new Map<string, any[]>();
  for (const i of ingRows) {
    if (!byRecipe.has(i.recipe_id)) byRecipe.set(i.recipe_id, []);
    byRecipe.get(i.recipe_id)!.push(i);
  }
  const sideRows = await selectIn(env, "SELECT * FROM recipe_sides WHERE recipe_id IN ({IN}) ORDER BY position", rows.map((r) => r.id));
  const sideRecipes = new Map((await selectIn(env, "SELECT id, name, archived FROM recipes WHERE id IN ({IN})", sideRows.map((x) => x.side_recipe_id)))
    .map((x: any) => [x.id, x]));
  const sidesBy = new Map<string, any[]>();
  for (const x of sideRows) {
    const sr: any = x.side_recipe_id ? sideRecipes.get(x.side_recipe_id) : null;
    const sf = x.side_food_id ? foods.get(x.side_food_id) : null;
    if ((!sr && !sf) || (sr && sr.archived)) continue;
    const n = sf ? nutritionFor(sf, x.qty ?? 1, x.unit || (sf.basis === "each" ? "each" : "serving")) : null;
    if (!sidesBy.has(x.recipe_id)) sidesBy.set(x.recipe_id, []);
    sidesBy.get(x.recipe_id)!.push({
      kind: sr ? "recipe" : "food", recipe_id: sr ? sr.id : null, food_id: sf ? sf.id : null,
      name: sr ? sr.name : sf!.name, qty: x.qty, unit: x.unit, kcal: n ? Math.round(n.kcal) : null,
    });
  }
  return new Map(rows.map((r) => [r.id, computeRecipe(r, byRecipe.get(r.id) || [], foods, sidesBy.get(r.id) || [])]));
}

function recipeInput(b: any): { row?: Record<string, unknown>; ingredients?: any[]; sides?: any[]; error?: string } {
  const name = str(b.name, 150);
  if (!name) return { error: "Give the recipe a name." };
  const servings = num(b.servings, { min: 0.25, max: 200, nullable: false });
  if (servings == null) return { error: "Servings should be a number (at least ¼)." };
  const steps = (Array.isArray(b.steps) ? b.steps : String(b.steps || "").split("\n"))
    .map((s: unknown) => str(s, 2000)).filter(Boolean).slice(0, 120);
  const ings = Array.isArray(b.ingredients) ? b.ingredients.slice(0, 150) : [];
  const ingredients = ings
    .map((i: any) => (typeof i === "string" ? { text: i } : i || {}))
    .filter((i: any) => str(i.text, 300))
    .map((i: any) => {
      const text = str(i.text, 300);
      const p = parseIngredient(text);
      const qty = i.qty === undefined ? p.qty : num(i.qty, { min: 0, max: 100000 }) ?? null;
      const unit = i.unit === undefined ? p.unit : normUnit(i.unit) || (qty != null ? "each" : null);
      return {
        text, qty, unit: qty != null ? unit : null, name: i.name === undefined ? p.name : str(i.name, 150) || p.name,
        note: i.note === undefined ? p.note : str(i.note, 200) || null,
        grams: i.grams === undefined ? p.grams : num(i.grams, { min: 0, max: 100000 }) ?? null,
        optional: i.optional === undefined ? p.optional : !!i.optional,
        food_id: i.food_id === undefined ? undefined : i.food_id || null, // undefined = match automatically
      };
    });
  const tags = (Array.isArray(b.tags) ? b.tags : String(b.tags || "").split(","))
    .map((t: unknown) => str(t, 30)).filter(Boolean).slice(0, 12).join(",");
  const mins = (v: unknown) => num(v, { min: 0, max: 10000 }) ?? null;
  const url = str(b.source_url, 1000);
  const img = str(b.image_url, 1000);
  // suggested sides: undefined = leave them as they are
  const sides = b.sides === undefined ? undefined : (Array.isArray(b.sides) ? b.sides : []).slice(0, 12)
    .map((x: any) => ({
      recipe_id: x && typeof x.recipe_id === "string" ? x.recipe_id : null,
      food_id: x && typeof x.food_id === "string" ? x.food_id : null,
      qty: num(x?.qty, { min: 0.001, max: 10000 }) ?? null,
      unit: normUnit(x?.unit) || null,
    }))
    .filter((x: any) => x.recipe_id || x.food_id);
  return {
    sides,
    row: {
      name, servings, description: str(b.description, 2000) || null, steps: JSON.stringify(steps),
      source_url: /^https?:\/\//i.test(url) ? url : null, image_url: /^https?:\/\//i.test(img) ? img : null,
      prep_min: mins(b.prep_min), cook_min: mins(b.cook_min), tags: tags || null, notes: str(b.notes, 4000) || null,
      site_kcal: num(b.site_kcal, { min: 0, max: 20000 }) ?? null, favorite: b.favorite ? 1 : 0, is_side: b.is_side ? 1 : 0,
    },
    ingredients,
  };
}

async function writeIngredients(env: Env, recipeId: string, ingredients: any[], foods: Map<string, Food>) {
  const foodList = [...foods.values()];
  const stmts: D1PreparedStatement[] = [env.DB.prepare("DELETE FROM recipe_ingredients WHERE recipe_id = ?").bind(recipeId)];
  ingredients.forEach((i, pos) => {
    let foodId = i.food_id;
    if (foodId === undefined) foodId = matchFood(i.name, foodList, { unit: i.unit })?.food.id ?? null;
    else if (foodId && !foods.has(foodId)) foodId = null;
    stmts.push(env.DB.prepare(
      `INSERT INTO recipe_ingredients (id, recipe_id, position, text, qty, unit, name, note, food_id, grams, optional)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(newId(), recipeId, pos, i.text, i.qty, i.unit, i.name, i.note, foodId, i.grams, i.optional ? 1 : 0));
  });
  await env.DB.batch(stmts);
}

async function writeSides(env: Env, recipeId: string, sides: any[]) {
  const rIds = sides.map((x) => x.recipe_id).filter((id) => id && id !== recipeId);
  const fIds = sides.map((x) => x.food_id).filter(Boolean);
  const okR = new Set((await selectIn(env, "SELECT id FROM recipes WHERE id IN ({IN})", rIds)).map((x: any) => x.id));
  const okF = new Set((await selectIn(env, "SELECT id FROM foods WHERE id IN ({IN})", fIds)).map((x: any) => x.id));
  const stmts: D1PreparedStatement[] = [env.DB.prepare("DELETE FROM recipe_sides WHERE recipe_id = ?").bind(recipeId)];
  let pos = 0;
  for (const x of sides) {
    const rid = x.recipe_id && okR.has(x.recipe_id) ? x.recipe_id : null;
    const fid = !rid && x.food_id && okF.has(x.food_id) ? x.food_id : null;
    if (!rid && !fid) continue;
    stmts.push(env.DB.prepare("INSERT INTO recipe_sides (id, recipe_id, position, side_recipe_id, side_food_id, qty, unit) VALUES (?,?,?,?,?,?,?)")
      .bind(newId(), recipeId, pos++, rid, fid, fid ? x.qty ?? 1 : null, fid ? x.unit : null));
  }
  await env.DB.batch(stmts);
}

// ───────────────────────── plan ─────────────────────────
function itemPerServing(item: any, recipes: Map<string, RecipeOut>, foods: Map<string, Food>): Nut | null {
  if (item.kind === "recipe") return recipes.get(item.recipe_id)?.perServing ?? null;
  if (item.kind === "food") {
    const f = foods.get(item.food_id);
    if (!f) return null;
    const n = nutritionFor(f, item.qty ?? 1, item.unit || (f.basis === "each" ? "each" : "serving"));
    return n ? roundNut(n) : null;
  }
  if (item.kind === "quick") {
    return { kcal: Number(item.kcal) || 0, protein: Number(item.protein) || 0, carbs: Number(item.carbs) || 0, fat: Number(item.fat) || 0 };
  }
  return null;
}

async function planRange(env: Env, from: string, to: string) {
  const [itemsRes, eatersRes, usersRes, foods] = await Promise.all([
    env.DB.prepare("SELECT * FROM plan_items WHERE date >= ? AND date <= ? ORDER BY date, position, created_at").bind(from, to).all(),
    env.DB.prepare(
      `SELECT pe.* FROM plan_eaters pe JOIN plan_items pi ON pi.id = pe.plan_item_id WHERE pi.date >= ? AND pi.date <= ?`
    ).bind(from, to).all(),
    env.DB.prepare("SELECT * FROM users ORDER BY created_at").all(),
    allFoods(env),
  ]);
  const items = itemsRes.results as any[];
  const users = usersRes.results as unknown as UserRow[];
  const eatersBy = new Map<string, any[]>();
  for (const e of eatersRes.results as any[]) {
    if (!eatersBy.has(e.plan_item_id)) eatersBy.set(e.plan_item_id, []);
    eatersBy.get(e.plan_item_id)!.push(e);
  }
  const recipes = await recipeBundle(env, foods, items.filter((i) => i.kind === "recipe").map((i) => i.recipe_id));
  const totals: Record<string, Record<string, { eaten: Nut; planned: Nut }>> = {};
  const out = items.map((i) => {
    const per = itemPerServing(i, recipes, foods);
    const order = (uid: string) => users.findIndex((u) => u.id === uid);
    const eaters = (eatersBy.get(i.id) || []).map((e) => ({ user_id: e.user_id, servings: e.servings, status: e.status }))
      .sort((a, b) => order(a.user_id) - order(b.user_id));
    for (const e of eaters) {
      if (e.status === "skipped" || !per) continue;
      const day = (totals[i.date] ||= {});
      const t = (day[e.user_id] ||= { eaten: { ...ZERO }, planned: { ...ZERO } });
      if (e.status === "eaten") t.eaten = addNut(t.eaten, per, e.servings);
      else t.planned = addNut(t.planned, per, e.servings);
    }
    const r = i.kind === "recipe" ? recipes.get(i.recipe_id) : null;
    const f = i.kind === "food" ? foods.get(i.food_id) : null;
    return {
      id: i.id, date: i.date, slot: i.slot, position: i.position, kind: i.kind, recipe_id: i.recipe_id, food_id: i.food_id, parent_id: i.parent_id,
      qty: i.qty, unit: i.unit, batch: i.batch, note: i.note, cooked: !!i.cooked,
      kcal: i.kcal, protein: i.protein, carbs: i.carbs, fat: i.fat,
      title: i.title || r?.name || (f ? f.name : "Meal"),
      brand: f?.brand || null,
      image_url: r?.image_url || null,
      recipe_servings: r?.servings ?? null,
      perServing: per,
      eaters,
    };
  });
  for (const d of Object.values(totals)) for (const t of Object.values(d)) { t.eaten = roundNut(t.eaten); t.planned = roundNut(t.planned); }
  return { items: out, totals, users: users.map((u) => userOut(u)), recipes, foods };
}

function rangeFrom(c: any): { from: string; to: string } | null {
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (!isDate(from) || !isDate(to) || to < from || daysBetween(from, to) > 92) return null;
  return { from, to };
}

// ───────────────────────── pantry & shopping ─────────────────────────
function haveFromRows(rows: any[]) {
  const by = new Map<string, any[]>();
  for (const r of rows) {
    const k = keyFor(r.food_id, r.name);
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(r);
  }
  return by;
}

async function addToPantry(env: Env, foods: Map<string, Food>, item: { food_id: string | null; name: string; qty: number | null; unit: string | null }) {
  const key = keyFor(item.food_id, item.name);
  const { results } = await env.DB.prepare("SELECT * FROM pantry").all();
  const existing = (results as any[]).filter((r) => keyFor(r.food_id, r.name) === key);
  const food = item.food_id ? foods.get(item.food_id) : null;
  const ts = nowIso();
  if (existing.some((r) => r.staple || r.qty == null)) {
    // already "always have" / "have some" - nothing to count
    return;
  }
  if (item.qty != null) {
    for (const r of existing) {
      const add = convertQty(food, item.qty, item.unit, r.unit);
      if (add != null) {
        await env.DB.prepare("UPDATE pantry SET qty = ?, updated_at = ? WHERE id = ?").bind(Math.round((r.qty + add) * 1000) / 1000, ts, r.id).run();
        return;
      }
    }
  }
  await env.DB.prepare("INSERT INTO pantry (id, food_id, name, qty, unit, staple, updated_at) VALUES (?,?,?,?,?,0,?)")
    .bind(newId(), item.food_id, food ? food.name : item.name, item.qty, item.qty != null ? normUnit(item.unit) || "each" : null, ts)
    .run();
}

async function shoppingPreview(env: Env, from: string, to: string) {
  const plan = await planRange(env, from, to);
  const { foods, recipes } = plan;
  const lines: any[] = [];
  for (const it of plan.items) {
    if (!(it.batch > 0)) continue;
    const active = it.eaters.filter((e) => e.status !== "skipped");
    if (it.eaters.length && !active.length) continue;
    const label = `${it.title} (${shortDay(it.date)})`;
    if (it.kind === "recipe") {
      const r = recipes.get(it.recipe_id);
      if (!r) continue;
      for (const ing of r.ingredients) {
        lines.push({ food_id: ing.food_id, name: ing.name || ing.text, qty: ing.qty != null ? ing.qty * it.batch : null, unit: ing.unit, hint: ing.grams, for: label, optional: ing.optional });
      }
    } else if (it.kind === "food") {
      const f = foods.get(it.food_id);
      if (!f || f.no_shop || f.source === "restaurant") continue;
      const servings = active.reduce((s, e) => s + (Number(e.servings) || 0), 0) || 1;
      lines.push({ food_id: f.id, name: f.name, qty: (it.qty ?? 1) * servings, unit: it.unit || (f.basis === "each" ? "each" : "serving"), for: label });
    }
  }
  const foodsById = Object.fromEntries([...foods.entries()]);
  const groups = aggregateNeeds(lines, foodsById);
  const [{ results: pantryRows }, { results: listRows }] = await Promise.all([
    env.DB.prepare("SELECT * FROM pantry").all(),
    env.DB.prepare("SELECT * FROM shopping_items WHERE checked = 0").all(),
  ]);
  const pantryBy = haveFromRows(pantryRows as any[]);
  const listBy = haveFromRows(listRows as any[]);
  const out = groups.map((g: any) => {
    const food = g.food_id ? foods.get(g.food_id) : null;
    const pRows = pantryBy.get(g.key) || [];
    const lRows = listBy.get(g.key) || [];
    const staple = pRows.some((r) => r.staple);
    const afterPantry = subtract(g.total, pRows.map((r) => ({ qty: r.qty, unit: r.unit, untracked: r.staple || r.qty == null })), food);
    const pantryCovered = staple || (pRows.length > 0 && (afterPantry.covered || (g.total.length === 0 && pRows.length > 0)));
    let buy = pantryCovered ? [] : afterPantry.buy;
    let listCovered = false;
    if (!pantryCovered && lRows.length) {
      const afterList = subtract(buy.length ? buy : g.total, lRows.map((r) => ({ qty: r.qty, unit: r.unit, untracked: r.qty == null })), food);
      listCovered = afterList.covered || (g.total.length === 0);
      buy = listCovered ? [] : afterList.buy;
    }
    buy = roundForBuying(buy);
    const cost = buy.length ? costOf(buy, food) : null;
    // "10 tbsp" of butter reads better next to what the store sells it by: "(≈ 5 oz)"
    let alt: string | null = null;
    if (food && food.price_unit && buy.length === 1 && dimOf(buy[0].unit) === "volume" && dimOf(food.price_unit) === "mass") {
      const g = convertQty(food, buy[0].qty, buy[0].unit, "g");
      if (g != null) alt = String(fmtAmount(g, "g"));
    }
    return {
      key: g.key, food_id: g.food_id, name: g.name, aisle: g.aisle, for: g.for,
      need: g.total, needText: g.total.map((a: any) => fmtAmount(a.qty, a.unit)).join(" + ") || "some",
      buy, buyText: buy.map((a: any) => fmtAmount(a.qty, a.unit)).join(" + ") || (pantryCovered || listCovered ? "" : "some"), buyAlt: alt,
      haveText: pRows.length ? (staple ? "always have" : pRows.map((r) => (r.qty == null ? "some" : fmtAmount(r.qty, r.unit))).join(" + ")) : null,
      onListText: lRows.length ? lRows.map((r) => (r.qty == null ? "on list" : fmtAmount(r.qty, r.unit))).join(" + ") : null,
      covered: pantryCovered || listCovered,
      coveredBy: staple ? "staple" : pantryCovered ? "pantry" : listCovered ? "list" : null,
      pantryCheck: afterPantry.unmatched,
      cost: cost == null ? null : money(cost),
      optionalOnly: lines.filter((l) => keyFor(l.food_id, l.name) === g.key).every((l) => l.optional),
    };
  });
  const order = (a: string) => { const i = AISLES.indexOf(a); return i < 0 ? 99 : i; };
  out.sort((a: any, b: any) => order(a.aisle) - order(b.aisle) || a.name.localeCompare(b.name));
  return { from, to, lines: out, meals: plan.items.filter((i) => i.batch > 0 && (i.kind === "recipe" || i.kind === "food")).length };
}

async function shoppingList(env: Env) {
  const [{ results }, foods] = await Promise.all([
    env.DB.prepare("SELECT * FROM shopping_items ORDER BY checked, created_at").all(),
    allFoods(env),
  ]);
  let est = 0;
  let unpriced = 0;
  const items = (results as any[]).map((r) => {
    const food = r.food_id ? foods.get(r.food_id) : null;
    const cost = food && r.qty != null ? costFor(food, r.qty, r.unit) : null;
    if (!r.checked) { if (cost != null) est += cost; else unpriced++; }
    return {
      id: r.id, food_id: r.food_id, name: r.name, qty: r.qty, unit: r.unit, aisle: r.aisle, checked: !!r.checked,
      paid: r.paid, source: r.source, for_text: r.for_text, amountText: r.qty != null ? fmtAmount(r.qty, r.unit) : "",
      cost: cost == null ? null : money(cost), priceSource: food?.price_source || null,
    };
  });
  const order = (a: string) => { const i = AISLES.indexOf(a); return i < 0 ? 99 : i; };
  items.sort((a, b) => Number(a.checked) - Number(b.checked) || order(a.aisle) - order(b.aisle) || a.name.localeCompare(b.name));
  return { items, estimate: money(est), unpriced };
}

async function addShoppingLine(env: Env, foods: Map<string, Food>, userId: string, l: any, source: string) {
  const food = l.food_id ? foods.get(l.food_id) : null;
  const name = food ? food.name : str(l.name, 150);
  if (!name) return false;
  const qty = num(l.qty, { min: 0, max: 100000 }) ?? null;
  const unit = qty != null ? normUnit(l.unit) || "each" : null;
  const key = keyFor(food?.id, name);
  const { results } = await env.DB.prepare("SELECT * FROM shopping_items WHERE checked = 0").all();
  const same = (results as any[]).filter((r) => keyFor(r.food_id, r.name) === key);
  const forText = str(l.for_text, 300) || null;
  for (const r of same) {
    if (r.qty == null && qty == null) return true;
    if (r.qty == null) {
      await env.DB.prepare("UPDATE shopping_items SET qty = ?, unit = ? WHERE id = ?").bind(qty, unit, r.id).run();
      return true;
    }
    if (qty == null) return true;
    const add = convertQty(food, qty, unit, r.unit);
    if (add != null) {
      const ft = [r.for_text, forText].filter(Boolean).join(", ").slice(0, 300) || null;
      await env.DB.prepare("UPDATE shopping_items SET qty = ?, for_text = ? WHERE id = ?").bind(Math.round((r.qty + add) * 1000) / 1000, ft, r.id).run();
      return true;
    }
  }
  const aisle = AISLES.includes(l.aisle) ? l.aisle : food?.aisle || guessAisle(name);
  await env.DB.prepare(
    `INSERT INTO shopping_items (id, food_id, name, qty, unit, aisle, checked, source, for_text, created_by, created_at)
     VALUES (?,?,?,?,?,?,0,?,?,?,?)`
  ).bind(newId(), food?.id ?? null, name, qty, unit, aisle, source, forText, userId, nowIso()).run();
  return true;
}

// ───────────────────────── auth ─────────────────────────
async function requireAuth(c: any, next: any) {
  const auth = c.req.header("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return bad(c, "Not signed in", 401);
  const user = await c.env.DB.prepare("SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token = ?")
    .bind(token).first();
  if (!user) return bad(c, "Not signed in", 401);
  c.set("user", user);
  await next();
}

app.get("/api/setup-needed", async (c) => {
  const row = await c.env.DB.prepare("SELECT COUNT(*) c FROM users").first<{ c: number }>();
  return c.json({ setupNeeded: (row?.c || 0) === 0 });
});

app.get("/api/users", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM users ORDER BY created_at").all();
  return c.json((results as unknown as UserRow[]).map((u) => ({ id: u.id, name: u.name, color: u.color })));
});

const validPin = (p: unknown) => typeof p === "string" && /^\d{4,8}$/.test(p);

app.post("/api/setup", async (c) => {
  const b = await body(c);
  const row = await c.env.DB.prepare("SELECT COUNT(*) c FROM users").first<{ c: number }>();
  if ((row?.c || 0) > 0) return bad(c, "This household is already set up.");
  const name = str(b.name, 40);
  if (!name) return bad(c, "Enter your name.");
  if (!validPin(b.pin)) return bad(c, "Pick a PIN of 4 to 8 digits.");
  const salt = makeSalt();
  const id = newId();
  await c.env.DB.prepare(
    `INSERT INTO users (id, name, pin_hash, pin_salt, is_admin, color, kcal_goal, created_at) VALUES (?,?,?,?,1,?,?,?)`
  ).bind(id, name, await hashPin(b.pin, salt), salt, COLORS[0], num(b.kcal_goal, { min: 500, max: 10000 }) ?? null, nowIso()).run();
  await seedFoods(c.env);
  const token = newToken();
  await c.env.DB.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)").bind(token, id, nowIso()).run();
  const u = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
  return c.json({ token, user: userOut(u!, true) });
});

app.post("/api/login", async (c) => {
  const b = await body(c);
  const u = await c.env.DB.prepare("SELECT * FROM users WHERE id = ? OR name = ?").bind(str(b.user_id, 64), str(b.name, 40)).first<UserRow>();
  if (!u) return bad(c, "Unknown person", 401);
  if (u.locked_until && u.locked_until > nowIso()) return bad(c, "Too many wrong PINs - wait a few minutes and try again.", 429);
  if (typeof b.pin !== "string" || (await hashPin(b.pin, u.pin_salt)) !== u.pin_hash) {
    const fails = (u.failed_logins || 0) + 1;
    const lock = fails >= 5 ? new Date(Date.now() + 5 * 60000).toISOString() : null;
    await c.env.DB.prepare("UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?").bind(lock ? 0 : fails, lock, u.id).run();
    return bad(c, lock ? "Too many wrong PINs - wait 5 minutes and try again." : "That PIN isn't right.", 401);
  }
  await c.env.DB.prepare("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?").bind(u.id).run();
  const token = newToken();
  await c.env.DB.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)").bind(token, u.id, nowIso()).run();
  return c.json({ token, user: userOut(u, true) });
});

app.post("/api/logout", async (c) => {
  const auth = c.req.header("Authorization") || "";
  if (auth.startsWith("Bearer ")) await c.env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(auth.slice(7)).run();
  return c.json({ ok: true });
});

// test-only: wipes everything, available only when .dev.vars sets ALLOW_TEST_RESET=1 (never deployed)
app.post("/api/__test/reset", async (c) => {
  if (c.env.ALLOW_TEST_RESET !== "1") return c.json({ detail: "Not found" }, 404);
  await c.env.DB.batch(["plan_eaters", "plan_items", "recipe_ingredients", "recipes", "shopping_items", "pantry", "foods", "sessions", "users"]
    .map((t) => c.env.DB.prepare(`DELETE FROM ${t}`)));
  return c.json({ ok: true });
});

app.use("/api/*", async (c, next) => {
  const p = c.req.path;
  if (["/api/setup-needed", "/api/users", "/api/setup", "/api/login", "/api/logout"].includes(p) && !(p === "/api/users" && c.req.method !== "GET")) return next();
  return requireAuth(c, next);
});

app.get("/api/me", (c) => c.json(userOut(c.get("user"), true)));

function goalsInput(b: any, row: Record<string, unknown>): string | null {
  for (const [k, col, max] of [["kcal", "kcal_goal", 10000], ["protein", "protein_goal", 1000], ["carbs", "carbs_goal", 2000], ["fat", "fat_goal", 1000]] as const) {
    const v = b.goals ? b.goals[k] : undefined;
    if (v === undefined) continue;
    const n = num(v, { min: 0, max });
    if (n === undefined) return `The ${k} goal should be a number.`;
    row[col] = n == null || n === 0 ? null : Math.round(n);
  }
  return null;
}

async function updateUser(c: any, target: UserRow, b: any, self: boolean) {
  const row: Record<string, unknown> = {};
  const err = goalsInput(b, row);
  if (err) return bad(c, err);
  if (b.color !== undefined && /^#[0-9a-f]{6}$/i.test(b.color)) row.color = b.color;
  if (b.name !== undefined) {
    const name = str(b.name, 40);
    if (!name) return bad(c, "Enter a name.");
    const clash = await c.env.DB.prepare("SELECT 1 FROM users WHERE name = ? AND id != ?").bind(name, target.id).first();
    if (clash) return bad(c, "Someone already has that name.");
    row.name = name;
  }
  if (b.new_pin !== undefined) {
    if (!validPin(b.new_pin)) return bad(c, "The PIN should be 4 to 8 digits.");
    if (self) {
      if (typeof b.current_pin !== "string" || (await hashPin(b.current_pin, target.pin_salt)) !== target.pin_hash) return bad(c, "Your current PIN isn't right.");
      if (target.must_change_pin && b.new_pin === b.current_pin) return bad(c, "Pick a new PIN, not the temporary one.");
    }
    const salt = makeSalt();
    row.pin_salt = salt;
    row.pin_hash = await hashPin(b.new_pin, salt);
    row.must_change_pin = self ? 0 : 1; // an admin resetting someone's PIN makes it temporary
  }
  const keys = Object.keys(row);
  if (keys.length) {
    await c.env.DB.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).bind(...keys.map((k) => row[k]), target.id).run();
  }
  const u = (await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(target.id).first()) as UserRow;
  return c.json(userOut(u, self));
}

app.put("/api/me", async (c) => updateUser(c, c.get("user"), await body(c), true));

app.get("/api/household", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM users ORDER BY created_at").all();
  return c.json((results as unknown as UserRow[]).map((u) => userOut(u)));
});

app.post("/api/users", async (c) => {
  const me = c.get("user");
  if (!me.is_admin) return bad(c, "Only the household admin can add people.", 403);
  const b = await body(c);
  const name = str(b.name, 40);
  if (!name) return bad(c, "Enter their name.");
  if (!validPin(b.pin)) return bad(c, "The temporary PIN should be 4 to 8 digits.");
  if (await c.env.DB.prepare("SELECT 1 FROM users WHERE name = ?").bind(name).first()) return bad(c, "Someone already has that name.");
  const { results } = await c.env.DB.prepare("SELECT color FROM users").all();
  const used = new Set((results as any[]).map((r) => r.color));
  const color = COLORS.find((x) => !used.has(x)) || COLORS[(results.length) % COLORS.length];
  const salt = makeSalt();
  const id = newId();
  const row: Record<string, unknown> = {};
  goalsInput(b, row);
  await c.env.DB.prepare(
    `INSERT INTO users (id, name, pin_hash, pin_salt, is_admin, must_change_pin, color, kcal_goal, protein_goal, carbs_goal, fat_goal, created_at)
     VALUES (?,?,?,?,0,1,?,?,?,?,?,?)`
  ).bind(id, name, await hashPin(b.pin, salt), salt, color, row.kcal_goal ?? null, row.protein_goal ?? null, row.carbs_goal ?? null, row.fat_goal ?? null, nowIso()).run();
  const u = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
  return c.json(userOut(u!));
});

app.put("/api/users/:id", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  if (id === me.id) return updateUser(c, me, await body(c), true);
  if (!me.is_admin) return bad(c, "Only the household admin can change other people.", 403);
  const target = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
  if (!target) return bad(c, "Not found", 404);
  return updateUser(c, target, await body(c), false);
});

app.delete("/api/users/:id", async (c) => {
  const me = c.get("user");
  if (!me.is_admin) return bad(c, "Only the household admin can remove people.", 403);
  if (c.req.param("id") === me.id) return bad(c, "You can't remove yourself.");
  await c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

// ───────────────────────── foods ─────────────────────────
app.get("/api/foods", async (c) => {
  const foods = await allFoods(c.env);
  return c.json([...foods.values()].filter((f) => !f.archived || c.req.query("archived") === "1"));
});

app.post("/api/foods", async (c) => {
  const b = await body(c);
  const { row, error } = foodInput(b, false);
  if (error) return bad(c, error);
  row!.source = b.source === "restaurant" ? "restaurant" : "custom";
  if (row!.source === "restaurant") { row!.basis = "each"; row!.no_shop = 1; row!.aisle = "Restaurants"; }
  const id = await insertFood(c.env, row!, c.get("user").id);
  const r = await c.env.DB.prepare("SELECT * FROM foods WHERE id = ?").bind(id).first();
  return c.json(foodFromRow(r));
});

app.put("/api/foods/:id", async (c) => {
  const existing = await c.env.DB.prepare("SELECT * FROM foods WHERE id = ?").bind(c.req.param("id")).first<any>();
  if (!existing) return bad(c, "Not found", 404);
  const { row, error } = foodInput(await body(c), true);
  if (error) return bad(c, error);
  if (existing.source === "restaurant") delete row!.aisle;
  const keys = Object.keys(row!);
  if (keys.length) {
    await c.env.DB.prepare(`UPDATE foods SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).bind(...keys.map((k) => row![k] ?? null), existing.id).run();
  }
  const r = await c.env.DB.prepare("SELECT * FROM foods WHERE id = ?").bind(existing.id).first();
  return c.json(foodFromRow(r));
});

// a food that's used anywhere is archived (kept for old meals), otherwise deleted
app.delete("/api/foods/:id", async (c) => {
  const id = c.req.param("id");
  const used = await c.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM recipe_ingredients WHERE food_id = ?) + (SELECT COUNT(*) FROM plan_items WHERE food_id = ?) AS n`
  ).bind(id, id).first<{ n: number }>();
  if ((used?.n || 0) > 0) {
    await c.env.DB.prepare("UPDATE foods SET archived = 1 WHERE id = ?").bind(id).run();
    return c.json({ archived: true });
  }
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM pantry WHERE food_id = ?").bind(id),
    c.env.DB.prepare("UPDATE shopping_items SET food_id = NULL WHERE food_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM foods WHERE id = ?").bind(id),
  ]);
  return c.json({ deleted: true });
});

app.post("/api/foods/seed", async (c) => c.json({ checked: await seedFoods(c.env) }));

app.get("/api/foods/remote", async (c) => {
  const q = str(c.req.query("q"), 100);
  if (q.length < 2) return bad(c, "Type at least 2 letters.");
  const source = c.req.query("source") === "off" ? "off" : "usda";
  try {
    const results = source === "off" ? await searchOff(q) : await searchUsda(c.env.USDA_API_KEY || "DEMO_KEY", q);
    return c.json({ source, results });
  } catch (e: any) {
    return bad(c, e?.message || "Lookup failed.", 502);
  }
});

async function importRemote(env: Env, f: RemoteFood, userId: string) {
  const existing = await env.DB.prepare("SELECT * FROM foods WHERE source = ? AND source_ref = ?").bind(f.source, f.ref).first();
  if (existing) {
    if ((existing as any).archived) await env.DB.prepare("UPDATE foods SET archived = 0 WHERE id = ?").bind((existing as any).id).run();
    return foodFromRow({ ...(existing as any), archived: 0 });
  }
  const id = await insertFood(env, {
    name: f.name.slice(0, 120), brand: f.brand, source: f.source, source_ref: f.ref, basis: "g",
    kcal: f.kcal, protein: f.protein, carbs: f.carbs, fat: f.fat, ml_g: f.ml_g, units: JSON.stringify(f.units || {}),
    aisle: guessAisle(f.name),
  }, userId);
  return foodFromRow(await env.DB.prepare("SELECT * FROM foods WHERE id = ?").bind(id).first());
}

app.post("/api/foods/remote-import", async (c) => {
  const b = await body(c);
  try {
    let f: RemoteFood | null = null;
    if (b.source === "usda") f = await usdaDetails(c.env.USDA_API_KEY || "DEMO_KEY", str(b.ref, 20));
    else if (b.source === "off") f = await offBarcode(str(b.ref, 20));
    if (!f || f.kcal == null) return bad(c, "That food has no calorie information.");
    return c.json(await importRemote(c.env, f, c.get("user").id));
  } catch (e: any) {
    return bad(c, e?.message || "Lookup failed.", 502);
  }
});

app.get("/api/foods/barcode/:code", async (c) => {
  const code = c.req.param("code").replace(/\D/g, "");
  const local = await c.env.DB.prepare("SELECT * FROM foods WHERE source = 'off' AND source_ref = ?").bind(code).first();
  if (local) return c.json({ food: foodFromRow(local) });
  try {
    const f = await offBarcode(code);
    if (!f) return bad(c, "No product found for that barcode.", 404);
    if (f.kcal == null) return bad(c, "That product has no calorie information.", 404);
    return c.json({ food: await importRemote(c.env, f, c.get("user").id) });
  } catch (e: any) {
    return bad(c, e?.message || "Lookup failed.", 502);
  }
});

// ───────────────────────── recipes ─────────────────────────
app.get("/api/recipes", async (c) => {
  const foods = await allFoods(c.env);
  const bundle = await recipeBundle(c.env, foods, null);
  return c.json([...bundle.values()].map((r) => ({
    id: r.id, name: r.name, servings: r.servings, image_url: r.image_url, tags: r.tags, favorite: r.favorite,
    perServing: r.perServing, costPerServing: r.costPerServing, prep_min: r.prep_min, cook_min: r.cook_min,
    unmatched: r.unmatched + r.unconverted, ingredientCount: r.ingredients.length, updated_at: r.updated_at,
    is_side: r.is_side, sides: r.sides,
  })));
});

app.get("/api/recipes/:id", async (c) => {
  const foods = await allFoods(c.env);
  const r = (await recipeBundle(c.env, foods, [c.req.param("id")])).get(c.req.param("id"));
  if (!r) return bad(c, "Not found", 404);
  return c.json(r);
});

app.post("/api/recipes", async (c) => {
  const { row, ingredients, sides, error } = recipeInput(await body(c));
  if (error) return bad(c, error);
  const id = newId();
  const ts = nowIso();
  const full = { id, ...row!, created_by: c.get("user").id, created_at: ts, updated_at: ts };
  const keys = Object.keys(full);
  await c.env.DB.prepare(`INSERT INTO recipes (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).bind(...keys.map((k) => (full as any)[k])).run();
  const foods = await allFoods(c.env);
  await writeIngredients(c.env, id, ingredients!, foods);
  if (sides) await writeSides(c.env, id, sides);
  return c.json((await recipeBundle(c.env, foods, [id])).get(id));
});

app.put("/api/recipes/:id", async (c) => {
  const id = c.req.param("id");
  const exists = await c.env.DB.prepare("SELECT 1 FROM recipes WHERE id = ?").bind(id).first();
  if (!exists) return bad(c, "Not found", 404);
  const b = await body(c);
  // a quick favorite toggle doesn't resend the whole recipe
  if (Object.keys(b).length === 1 && b.favorite !== undefined) {
    await c.env.DB.prepare("UPDATE recipes SET favorite = ? WHERE id = ?").bind(b.favorite ? 1 : 0, id).run();
  } else {
    const { row, ingredients, sides, error } = recipeInput(b);
    if (error) return bad(c, error);
    const full: Record<string, unknown> = { ...row!, updated_at: nowIso() };
    const keys = Object.keys(full);
    await c.env.DB.prepare(`UPDATE recipes SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).bind(...keys.map((k) => full[k]), id).run();
    await writeIngredients(c.env, id, ingredients!, await allFoods(c.env));
    if (sides) await writeSides(c.env, id, sides);
  }
  const foods = await allFoods(c.env);
  return c.json((await recipeBundle(c.env, foods, [id])).get(id));
});

app.delete("/api/recipes/:id", async (c) => {
  const id = c.req.param("id");
  const used = await c.env.DB.prepare("SELECT COUNT(*) n FROM plan_items WHERE recipe_id = ?").bind(id).first<{ n: number }>();
  if ((used?.n || 0) > 0) {
    // past meals keep their calories; the recipe just leaves the list
    await c.env.DB.prepare("UPDATE recipes SET archived = 1 WHERE id = ?").bind(id).run();
    return c.json({ archived: true });
  }
  await c.env.DB.prepare("DELETE FROM recipes WHERE id = ?").bind(id).run();
  return c.json({ deleted: true });
});

function draftOut(d: RecipeDraft, foods: Food[]) {
  return {
    name: d.name, servings: d.servings || 4, steps: d.steps, image_url: d.image, prep_min: d.prepMin, cook_min: d.cookMin,
    description: d.description, source_url: d.sourceUrl, site_kcal: d.kcalPerServing,
    ingredients: d.ingredients.map((text) => {
      const p = parseIngredient(text);
      const m = matchFood(p.name, foods, { unit: p.unit });
      return { ...p, food_id: m ? m.food.id : null };
    }),
  };
}

app.post("/api/recipes/parse", async (c) => {
  const b = await body(c);
  const foods = [...(await allFoods(c.env)).values()];
  if (typeof b.text === "string" && b.text.trim()) {
    const d = parseRecipeText(b.text.slice(0, 50000));
    if (!d.ingredients.length) return bad(c, "Couldn't find any ingredients. Put each ingredient on its own line under an \"Ingredients\" heading.");
    return c.json(draftOut(d, foods));
  }
  const url = str(b.url, 1000);
  if (!url) return bad(c, "Paste a recipe link or the recipe text.");
  try {
    const { html, finalUrl } = await fetchRecipePage(url);
    const d = extractRecipeFromHtml(html, finalUrl);
    if (!d) return bad(c, "Couldn't find a recipe on that page. Copy the recipe text and paste it instead.", 422);
    return c.json(draftOut(d, foods));
  } catch (e: any) {
    return bad(c, e?.message || "Couldn't open that link.", 422);
  }
});

// ───────────────────────── plan ─────────────────────────
app.get("/api/plan", async (c) => {
  const r = rangeFrom(c);
  if (!r) return bad(c, "Give from and to dates (up to 3 months apart).");
  const p = await planRange(c.env, r.from, r.to);
  return c.json({ from: r.from, to: r.to, items: p.items, totals: p.totals, users: p.users });
});

async function eatersInput(env: Env, raw: unknown, fallbackUser: string) {
  const { results } = await env.DB.prepare("SELECT id FROM users").all();
  const ids = new Set((results as any[]).map((r) => r.id));
  const list = Array.isArray(raw) ? raw : [{ user_id: fallbackUser }];
  const out: { user_id: string; servings: number; status: string }[] = [];
  for (const e of list) {
    if (!e || !ids.has(e.user_id) || out.some((o) => o.user_id === e.user_id)) continue;
    out.push({
      user_id: e.user_id,
      servings: num(e.servings, { min: 0, max: 50, nullable: false }) ?? 1,
      status: STATUSES.includes(e.status) ? e.status : "planned",
    });
  }
  return out;
}

async function createPlanItem(env: Env, userId: string, b: any): Promise<{ id?: string; error?: string }> {
  if (b.parent_id) {
    const parent = await env.DB.prepare("SELECT id, date, slot FROM plan_items WHERE id = ? AND parent_id IS NULL").bind(b.parent_id).first<any>();
    if (!parent) return { error: "That meal doesn't exist." };
    b = { ...b, date: parent.date, slot: parent.slot };
  }
  if (!isDate(b.date)) return { error: "Pick a day." };
  if (!SLOTS.includes(b.slot)) return { error: "Pick breakfast, lunch, dinner, dessert or snack." };
  const kind = ["recipe", "food", "quick"].includes(b.kind) ? b.kind : null;
  if (!kind) return { error: "Unknown meal type." };
  const row: Record<string, unknown> = { id: newId(), date: b.date, slot: b.slot, kind, parent_id: b.parent_id || null, created_by: userId, created_at: nowIso() };
  if (kind === "recipe") {
    const r = await env.DB.prepare("SELECT id, name FROM recipes WHERE id = ?").bind(b.recipe_id).first<any>();
    if (!r) return { error: "That recipe doesn't exist." };
    row.recipe_id = r.id;
    row.batch = num(b.batch, { min: 0, max: 20, nullable: false }) ?? 1;
  } else if (kind === "food") {
    const f = await env.DB.prepare("SELECT id, basis FROM foods WHERE id = ?").bind(b.food_id).first<any>();
    if (!f) return { error: "That food doesn't exist." };
    row.food_id = f.id;
    row.qty = num(b.qty, { min: 0.001, max: 100000, nullable: false }) ?? 1;
    row.unit = normUnit(b.unit) || (f.basis === "each" ? "each" : "serving");
    row.batch = b.batch === 0 ? 0 : 1;
  } else {
    const title = str(b.title, 120);
    if (!title) return { error: "Give it a name." };
    row.title = title;
    for (const k of ["kcal", "protein", "carbs", "fat"]) row[k] = num(b[k], { min: 0, max: 20000 }) ?? null;
    if (row.kcal == null) return { error: "Enter the calories." };
    row.batch = 0;
  }
  if (kind !== "quick" && b.title) row.title = str(b.title, 120) || null;
  row.note = str(b.note, 300) || null;
  const last = await env.DB.prepare("SELECT MAX(position) p FROM plan_items WHERE date = ? AND slot = ?").bind(b.date, b.slot).first<{ p: number | null }>();
  row.position = (last?.p ?? 0) + 1;
  const eaters = await eatersInput(env, b.eaters, userId);
  const keys = Object.keys(row);
  const stmts = [env.DB.prepare(`INSERT INTO plan_items (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).bind(...keys.map((k) => row[k] ?? null))];
  for (const e of eaters) {
    stmts.push(env.DB.prepare("INSERT INTO plan_eaters (plan_item_id, user_id, servings, status, updated_at) VALUES (?,?,?,?,?)")
      .bind(row.id, e.user_id, e.servings, e.status, nowIso()));
  }
  await env.DB.batch(stmts);
  return { id: row.id as string };
}

app.post("/api/plan", async (c) => {
  const b = await body(c);
  const userId = c.get("user").id;
  const main = await createPlanItem(c.env, userId, b);
  if (main.error) return bad(c, main.error);
  // sides chosen with the meal: each is its own item (own calories, own shopping), hung off the main
  const sides: string[] = [];
  if (Array.isArray(b.sides) && !b.parent_id) {
    const eaters = Array.isArray(b.eaters) ? b.eaters.map((e: any) => ({ user_id: e?.user_id, status: e?.status, servings: 1 })) : undefined;
    for (const sd of b.sides.slice(0, 12)) {
      if (!sd || typeof sd !== "object") continue;
      const r = await createPlanItem(c.env, userId, {
        kind: sd.kind === "food" ? "food" : "recipe", recipe_id: sd.recipe_id, food_id: sd.food_id, qty: sd.qty, unit: sd.unit,
        batch: sd.batch ?? 1, parent_id: main.id, eaters,
      });
      if (r.id) sides.push(r.id);
    }
  }
  return c.json({ id: main.id, sides });
});

app.put("/api/plan/:id", async (c) => {
  const id = c.req.param("id");
  const item = await c.env.DB.prepare("SELECT * FROM plan_items WHERE id = ?").bind(id).first<any>();
  if (!item) return bad(c, "Not found", 404);
  const b = await body(c);
  const row: Record<string, unknown> = {};
  if (b.date !== undefined) { if (!isDate(b.date)) return bad(c, "Pick a day."); row.date = b.date; }
  if (b.slot !== undefined) { if (!SLOTS.includes(b.slot)) return bad(c, "Unknown meal slot."); row.slot = b.slot; }
  if (b.position !== undefined) { const p = num(b.position, { nullable: false }); if (p != null) row.position = p; }
  if (b.batch !== undefined && item.kind !== "quick") { const v = num(b.batch, { min: 0, max: 20, nullable: false }); if (v != null) row.batch = v; }
  if (b.qty !== undefined && item.kind === "food") { const v = num(b.qty, { min: 0.001, max: 100000, nullable: false }); if (v != null) row.qty = v; }
  if (b.unit !== undefined && item.kind === "food") row.unit = normUnit(b.unit) || item.unit;
  if (b.note !== undefined) row.note = str(b.note, 300) || null;
  if (b.title !== undefined) row.title = str(b.title, 120) || (item.kind === "quick" ? item.title : null);
  if (item.kind === "quick") for (const k of ["kcal", "protein", "carbs", "fat"]) if (b[k] !== undefined) row[k] = num(b[k], { min: 0, max: 20000 }) ?? null;
  // moved to a different slot without a position: goes to the end of it
  if ((row.date || row.slot) && row.position === undefined) {
    const last = await c.env.DB.prepare("SELECT MAX(position) p FROM plan_items WHERE date = ? AND slot = ? AND id != ?")
      .bind(row.date ?? item.date, row.slot ?? item.slot, id).first<{ p: number | null }>();
    row.position = (last?.p ?? 0) + 1;
  }
  const stmts: D1PreparedStatement[] = [];
  const keys = Object.keys(row);
  if (keys.length) stmts.push(c.env.DB.prepare(`UPDATE plan_items SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).bind(...keys.map((k) => row[k]), id));
  // a meal's sides move with it
  if (row.date || row.slot) {
    stmts.push(c.env.DB.prepare("UPDATE plan_items SET date = ?, slot = ? WHERE parent_id = ?").bind(row.date ?? item.date, row.slot ?? item.slot, id));
  }
  if (b.eaters !== undefined) {
    const eaters = await eatersInput(c.env, b.eaters, c.get("user").id);
    stmts.push(c.env.DB.prepare("DELETE FROM plan_eaters WHERE plan_item_id = ?").bind(id));
    for (const e of eaters) {
      stmts.push(c.env.DB.prepare("INSERT INTO plan_eaters (plan_item_id, user_id, servings, status, updated_at) VALUES (?,?,?,?,?)")
        .bind(id, e.user_id, e.servings, e.status, nowIso()));
    }
  }
  if (stmts.length) await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});

// one person's portion / status: planned, eaten, skipped
app.put("/api/plan/:id/eaters/:uid", async (c) => {
  const id = c.req.param("id");
  const uid = c.req.param("uid");
  const item = await c.env.DB.prepare("SELECT * FROM plan_items WHERE id = ?").bind(id).first<any>();
  if (!item) return bad(c, "Not found", 404);
  if (!(await c.env.DB.prepare("SELECT 1 FROM users WHERE id = ?").bind(uid).first())) return bad(c, "Unknown person.");
  const b = await body(c);
  const cur = await c.env.DB.prepare("SELECT * FROM plan_eaters WHERE plan_item_id = ? AND user_id = ?").bind(id, uid).first<any>();
  if (b.remove) {
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM plan_eaters WHERE plan_item_id = ? AND user_id = ?").bind(id, uid),
      c.env.DB.prepare("DELETE FROM plan_eaters WHERE user_id = ? AND plan_item_id IN (SELECT id FROM plan_items WHERE parent_id = ?)").bind(uid, id),
    ]);
    return c.json({ ok: true });
  }
  const status = b.status !== undefined ? (STATUSES.includes(b.status) ? b.status : null) : cur?.status || "planned";
  if (!status) return bad(c, "Unknown status.");
  const servings = b.servings !== undefined ? num(b.servings, { min: 0, max: 50, nullable: false }) : cur?.servings ?? 1;
  if (servings == null) return bad(c, "Portions should be a number.");
  await c.env.DB.prepare(
    `INSERT INTO plan_eaters (plan_item_id, user_id, servings, status, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT (plan_item_id, user_id) DO UPDATE SET servings = excluded.servings, status = excluded.status, updated_at = excluded.updated_at`
  ).bind(id, uid, servings, status, nowIso()).run();
  // ate / skipped the main meal: the same goes for its sides
  if (b.status !== undefined) {
    await c.env.DB.prepare("UPDATE plan_eaters SET status = ?, updated_at = ? WHERE user_id = ? AND plan_item_id IN (SELECT id FROM plan_items WHERE parent_id = ?)")
      .bind(status, nowIso(), uid, id).run();
  }
  // eaten a recipe that hasn't been cooked yet: say how much of it the pantry can give up
  let pantryLines = 0;
  if (status === "eaten" && item.kind === "recipe" && !item.cooked) pantryLines = (await cookPlan(c.env, item, true)).length;
  return c.json({ ok: true, pantryLines });
});

app.delete("/api/plan/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM plan_items WHERE id = ? OR parent_id = ?").bind(c.req.param("id"), c.req.param("id")).run();
  return c.json({ ok: true });
});

async function copyItems(env: Env, items: any[], shiftDays: number | null, target: { date?: string; slot?: string }, userId: string) {
  const ids = items.map((i) => i.id);
  const eaters = await selectIn(env, "SELECT * FROM plan_eaters WHERE plan_item_id IN ({IN})", ids);
  const stmts: D1PreparedStatement[] = [];
  const ts = nowIso();
  // a copied main keeps its copied sides; a side copied on its own stands alone
  const newIds = new Map(items.map((i) => [i.id, newId()]));
  for (const i of items) {
    const nid = newIds.get(i.id)!;
    const date = target.date ?? addDays(i.date, shiftDays || 0);
    stmts.push(env.DB.prepare(
      `INSERT INTO plan_items (id, date, slot, position, kind, recipe_id, food_id, qty, unit, title, kcal, protein, carbs, fat, batch, note, cooked, parent_id, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)`
    ).bind(nid, date, target.slot ?? i.slot, i.position + 1000, i.kind, i.recipe_id, i.food_id, i.qty, i.unit, i.title, i.kcal, i.protein, i.carbs, i.fat, i.batch, i.note,
      i.parent_id ? newIds.get(i.parent_id) ?? null : null, userId, ts));
    for (const e of eaters.filter((e) => e.plan_item_id === i.id)) {
      stmts.push(env.DB.prepare("INSERT INTO plan_eaters (plan_item_id, user_id, servings, status, updated_at) VALUES (?,?,?,'planned',?)")
        .bind(nid, e.user_id, e.servings, ts));
    }
  }
  for (let k = 0; k < stmts.length; k += 90) await env.DB.batch(stmts.slice(k, k + 90));
  return items.length;
}

app.post("/api/plan/:id/duplicate", async (c) => {
  const item = await c.env.DB.prepare("SELECT * FROM plan_items WHERE id = ?").bind(c.req.param("id")).first<any>();
  if (!item) return bad(c, "Not found", 404);
  const b = await body(c);
  if (!isDate(b.date)) return bad(c, "Pick a day.");
  const slot = SLOTS.includes(b.slot) ? b.slot : item.slot;
  const { results: kids } = await c.env.DB.prepare("SELECT * FROM plan_items WHERE parent_id = ?").bind(item.id).all();
  await copyItems(c.env, [item, ...(kids as any[])], null, { date: b.date, slot }, c.get("user").id);
  return c.json({ ok: true });
});

// copy a run of days (e.g. last week) onto another start date
app.post("/api/plan/copy", async (c) => {
  const b = await body(c);
  if (!isDate(b.from) || !isDate(b.to) || !isDate(b.target) || b.to < b.from || daysBetween(b.from, b.to) > 31) return bad(c, "Pick the days to copy (up to a month).");
  const { results } = await c.env.DB.prepare("SELECT * FROM plan_items WHERE date >= ? AND date <= ?").bind(b.from, b.to).all();
  const n = await copyItems(c.env, results as any[], daysBetween(b.from, b.target), {}, c.get("user").id);
  return c.json({ copied: n });
});

// Cooking a recipe takes its ingredients out of the pantry stock (only rows with an amount).
// dryRun just says which pantry rows would change.
async function cookPlan(env: Env, item: any, dryRun: boolean) {
  const foods = await allFoods(env);
  const r = (await recipeBundle(env, foods, [item.recipe_id])).get(item.recipe_id);
  if (!r) return [];
  const { results } = await env.DB.prepare("SELECT * FROM pantry WHERE staple = 0 AND qty IS NOT NULL").all();
  const rows = (results as any[]).map((x) => ({ ...x }));
  const before = new Map<string, any>();
  for (const ing of r.ingredients) {
    if (ing.qty == null || !ing.food_id) continue;
    const food = foods.get(ing.food_id);
    let need = ing.qty * (item.batch || 1);
    for (const p of rows) {
      if (need <= 1e-9 || p.food_id !== ing.food_id || p.qty <= 0) continue;
      const inP = convertQty(food, need, ing.unit, p.unit, ing.grams);
      if (inP == null) continue;
      if (!before.has(p.id)) before.set(p.id, { ...p });
      const take = Math.min(p.qty, inP);
      p.qty = Math.round((p.qty - take) * 1000) / 1000;
      need -= convertQty(food, take, p.unit, ing.unit, ing.grams) ?? need;
    }
  }
  if (dryRun) return [...before.values()];
  const stmts: D1PreparedStatement[] = [];
  const ts = nowIso();
  for (const p of rows) {
    if (!before.has(p.id)) continue;
    stmts.push(p.qty <= 1e-6
      ? env.DB.prepare("DELETE FROM pantry WHERE id = ?").bind(p.id)
      : env.DB.prepare("UPDATE pantry SET qty = ?, updated_at = ? WHERE id = ?").bind(p.qty, ts, p.id));
  }
  stmts.push(env.DB.prepare("UPDATE plan_items SET cooked = 1, cooked_log = ? WHERE id = ?").bind(JSON.stringify([...before.values()]), item.id));
  await env.DB.batch(stmts);
  return [...before.values()];
}

app.post("/api/plan/:id/cooked", async (c) => {
  const item = await c.env.DB.prepare("SELECT * FROM plan_items WHERE id = ?").bind(c.req.param("id")).first<any>();
  if (!item || item.kind !== "recipe") return bad(c, "Only recipes can be cooked.", 404);
  if (item.cooked) return c.json({ changed: 0, already: true });
  const changed = await cookPlan(c.env, item, false);
  return c.json({ changed: changed.length });
});

app.post("/api/plan/:id/uncooked", async (c) => {
  const item = await c.env.DB.prepare("SELECT * FROM plan_items WHERE id = ?").bind(c.req.param("id")).first<any>();
  if (!item) return bad(c, "Not found", 404);
  let log: any[] = [];
  try { log = item.cooked_log ? JSON.parse(item.cooked_log) : []; } catch { log = []; }
  const stmts: D1PreparedStatement[] = log.map((p) => c.env.DB.prepare(
    "INSERT OR REPLACE INTO pantry (id, food_id, name, qty, unit, staple, updated_at) VALUES (?,?,?,?,?,?,?)"
  ).bind(p.id, p.food_id, p.name, p.qty, p.unit, p.staple || 0, nowIso()));
  stmts.push(c.env.DB.prepare("UPDATE plan_items SET cooked = 0, cooked_log = NULL WHERE id = ?").bind(item.id));
  await c.env.DB.batch(stmts);
  return c.json({ restored: log.length });
});

// ───────────────────────── stats ─────────────────────────
app.get("/api/stats", async (c) => {
  const r = rangeFrom(c);
  if (!r) return bad(c, "Give from and to dates (up to 3 months apart).");
  const p = await planRange(c.env, r.from, r.to);
  const days: string[] = [];
  for (let d = r.from; d <= r.to; d = addDays(d, 1)) days.push(d);
  const people = p.users.map((u) => {
    const series = days.map((d) => ({ date: d, eaten: p.totals[d]?.[u.id]?.eaten ?? { ...ZERO }, planned: p.totals[d]?.[u.id]?.planned ?? { ...ZERO } }));
    const logged = series.filter((s) => s.eaten.kcal > 0);
    const avg = logged.length ? roundNut(logged.reduce((a, s) => addNut(a, s.eaten), { ...ZERO } as Nut)).kcal / logged.length : null;
    const goal = u.goals.kcal;
    return {
      ...u, series,
      daysLogged: logged.length,
      avgKcal: avg == null ? null : Math.round(avg),
      daysOverGoal: goal ? logged.filter((s) => s.eaten.kcal > goal).length : null,
    };
  });
  return c.json({ from: r.from, to: r.to, days, people });
});

// ───────────────────────── pantry ─────────────────────────
app.get("/api/pantry", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM pantry ORDER BY staple DESC, name COLLATE NOCASE").all();
  return c.json((results as any[]).map((r) => ({ ...r, staple: !!r.staple, amountText: r.qty != null ? fmtAmount(r.qty, r.unit) : "" })));
});

app.post("/api/pantry", async (c) => {
  const b = await body(c);
  const foods = await allFoods(c.env);
  const food = b.food_id ? foods.get(b.food_id) : null;
  const name = food ? food.name : str(b.name, 150);
  if (!name) return bad(c, "What is it?");
  const qty = num(b.qty, { min: 0, max: 100000 }) ?? null;
  if (b.staple) {
    const key = keyFor(food?.id, name);
    const { results } = await c.env.DB.prepare("SELECT * FROM pantry").all();
    const same = (results as any[]).filter((r) => keyFor(r.food_id, r.name) === key);
    if (same.length) {
      await c.env.DB.prepare(`UPDATE pantry SET staple = 1, qty = NULL, unit = NULL, updated_at = ? WHERE id IN (${same.map(() => "?").join(",")})`)
        .bind(nowIso(), ...same.map((r) => r.id)).run();
    } else {
      await c.env.DB.prepare("INSERT INTO pantry (id, food_id, name, qty, unit, staple, updated_at) VALUES (?,?,?,NULL,NULL,1,?)")
        .bind(newId(), food?.id ?? null, name, nowIso()).run();
    }
    return c.json({ ok: true });
  }
  await addToPantry(c.env, foods, { food_id: food?.id ?? null, name, qty, unit: b.unit ?? null });
  return c.json({ ok: true });
});

app.put("/api/pantry/:id", async (c) => {
  const b = await body(c);
  const row: Record<string, unknown> = { updated_at: nowIso() };
  if (b.qty !== undefined) { const v = num(b.qty, { min: 0, max: 100000 }); if (v === undefined) return bad(c, "Amount should be a number."); row.qty = v; }
  if (b.unit !== undefined) row.unit = normUnit(b.unit) || null;
  if (b.staple !== undefined) { row.staple = b.staple ? 1 : 0; if (b.staple) { row.qty = null; row.unit = null; } }
  if (row.qty != null && !row.unit && b.unit === undefined) {
    const cur = await c.env.DB.prepare("SELECT unit FROM pantry WHERE id = ?").bind(c.req.param("id")).first<any>();
    if (!cur?.unit) row.unit = "each";
  }
  const keys = Object.keys(row);
  await c.env.DB.prepare(`UPDATE pantry SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).bind(...keys.map((k) => row[k]), c.req.param("id")).run();
  return c.json({ ok: true });
});

app.delete("/api/pantry/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM pantry WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

// ───────────────────────── shopping ─────────────────────────
app.get("/api/shopping", async (c) => c.json(await shoppingList(c.env)));

app.post("/api/shopping", async (c) => {
  const b = await body(c);
  const foods = await allFoods(c.env);
  let foodId = b.food_id && foods.has(b.food_id) ? b.food_id : null;
  if (!foodId && b.name) foodId = matchFood(b.name, [...foods.values()], { min: 0.9 })?.food.id ?? null;
  const ok = await addShoppingLine(c.env, foods, c.get("user").id, { ...b, food_id: foodId }, "manual");
  if (!ok) return bad(c, "What do you need?");
  return c.json(await shoppingList(c.env));
});

app.post("/api/shopping/preview", async (c) => {
  const b = await body(c);
  if (!isDate(b.from) || !isDate(b.to) || b.to < b.from || daysBetween(b.from, b.to) > 62) return bad(c, "Pick the days to shop for (up to 2 months).");
  return c.json(await shoppingPreview(c.env, b.from, b.to));
});

app.post("/api/shopping/add", async (c) => {
  const b = await body(c);
  const lines = Array.isArray(b.lines) ? b.lines.slice(0, 300) : [];
  const foods = await allFoods(c.env);
  let added = 0;
  for (const l of lines) if (await addShoppingLine(c.env, foods, c.get("user").id, l, "plan")) added++;
  // "always have" chosen from the preview
  for (const s of Array.isArray(b.staples) ? b.staples.slice(0, 100) : []) {
    const food = s.food_id ? foods.get(s.food_id) : null;
    const name = food ? food.name : str(s.name, 150);
    if (!name) continue;
    const key = keyFor(food?.id, name);
    const { results } = await c.env.DB.prepare("SELECT * FROM pantry").all();
    if ((results as any[]).some((r) => keyFor(r.food_id, r.name) === key && r.staple)) continue;
    await c.env.DB.prepare("INSERT INTO pantry (id, food_id, name, qty, unit, staple, updated_at) VALUES (?,?,?,NULL,NULL,1,?)")
      .bind(newId(), food?.id ?? null, name, nowIso()).run();
  }
  return c.json({ added, ...(await shoppingList(c.env)) });
});

app.put("/api/shopping/:id", async (c) => {
  const id = c.req.param("id");
  const item = await c.env.DB.prepare("SELECT * FROM shopping_items WHERE id = ?").bind(id).first<any>();
  if (!item) return bad(c, "Not found", 404);
  const b = await body(c);
  const row: Record<string, unknown> = {};
  if (b.checked !== undefined) { row.checked = b.checked ? 1 : 0; row.checked_at = b.checked ? nowIso() : null; }
  if (b.name !== undefined) { const n = str(b.name, 150); if (n) row.name = n; }
  if (b.qty !== undefined) { const v = num(b.qty, { min: 0, max: 100000 }); if (v === undefined) return bad(c, "Amount should be a number."); row.qty = v; if (v != null && !item.unit && b.unit === undefined) row.unit = "each"; }
  if (b.unit !== undefined) row.unit = normUnit(b.unit) || null;
  if (b.aisle !== undefined) row.aisle = AISLES.includes(b.aisle) ? b.aisle : "Other";
  if (b.paid !== undefined) {
    const v = num(b.paid, { min: 0, max: 10000 });
    if (v === undefined) return bad(c, "Price should be a number.");
    row.paid = v;
  }
  const keys = Object.keys(row);
  if (keys.length) await c.env.DB.prepare(`UPDATE shopping_items SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).bind(...keys.map((k) => row[k]), id).run();
  // what was actually paid becomes the food's price for next time
  const qty = row.qty !== undefined ? row.qty : item.qty;
  if (row.paid != null && item.food_id && qty != null && (qty as number) > 0) {
    await c.env.DB.prepare("UPDATE foods SET price = ?, price_qty = ?, price_unit = ?, price_source = 'paid', price_updated = ? WHERE id = ?")
      .bind(row.paid, qty, (row.unit !== undefined ? row.unit : item.unit) || "each", nowIso(), item.food_id).run();
  }
  return c.json(await shoppingList(c.env));
});

app.delete("/api/shopping/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM shopping_items WHERE id = ?").bind(c.req.param("id")).run();
  return c.json(await shoppingList(c.env));
});

// done shopping: everything ticked off goes into the pantry and leaves the list
app.post("/api/shopping/finish", async (c) => {
  const b = await body(c);
  const { results } = await c.env.DB.prepare("SELECT * FROM shopping_items WHERE checked = 1").all();
  const foods = await allFoods(c.env);
  let stocked = 0;
  if (b.to_pantry !== false) {
    for (const r of results as any[]) {
      // household items, or things that aren't food at all, don't belong in the pantry
      if (r.aisle === "Household") continue;
      await addToPantry(c.env, foods, { food_id: r.food_id, name: r.name, qty: r.qty, unit: r.unit });
      stocked++;
    }
  }
  await c.env.DB.prepare("DELETE FROM shopping_items WHERE checked = 1").run();
  return c.json({ stocked, ...(await shoppingList(c.env)) });
});

app.post("/api/shopping/clear", async (c) => {
  const b = await body(c);
  await c.env.DB.prepare(b.which === "all" ? "DELETE FROM shopping_items" : "DELETE FROM shopping_items WHERE checked = 1").run();
  return c.json(await shoppingList(c.env));
});

app.all("/api/*", (c) => bad(c, "Not found", 404));

export default app;
