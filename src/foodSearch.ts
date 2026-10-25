// Looking foods up online: USDA FoodData Central (generic and branded foods, free key)
// and Open Food Facts (packaged products and barcodes, no key). A result only lands in
// the household's own food list when someone picks it, so each food is fetched once.

export type RemoteFood = {
  source: "usda" | "off";
  ref: string;
  name: string;
  brand: string | null;
  kcal: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  units: Record<string, number>;
  ml_g: number | null;
  detail: string | null; // "Foundation", "Branded", "per 100 g"...
};

const OFF_UA = "Forkcast/1.0 (household meal planner)";
const r1 = (n: unknown) => (n == null || !isFinite(Number(n)) ? null : Math.round(Number(n) * 10) / 10);

function titleCase(s: string) {
  return s.length > 3 && s === s.toUpperCase() ? s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : s;
}

async function getJson(url: string, headers: Record<string, string> = {}, timeoutMs = 9000): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal: ctl.signal });
    if (res.status === 429) throw new Error("The food database is busy (too many lookups) - try again in a minute.");
    if (!res.ok) throw new Error(`Food lookup failed (${res.status}).`);
    return await res.json();
  } catch (e: any) {
    if (e && e.name === "AbortError") throw new Error("The food database took too long to answer.");
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// ── USDA ─────────────────────────────────────────────────────────────────
function usdaNutrient(list: any[], ids: number[], names: string[]): number | null {
  for (const id of ids) {
    const n = list.find((x) => (x.nutrientId ?? x.nutrient?.id) === id);
    if (n) {
      const v = n.value ?? n.amount;
      const unit = String(n.unitName ?? n.nutrient?.unitName ?? "").toUpperCase();
      if (v != null) return unit === "KJ" ? v / 4.184 : v;
    }
  }
  for (const nm of names) {
    const n = list.find((x) => String(x.nutrientName ?? x.nutrient?.name ?? "").toLowerCase().startsWith(nm));
    if (n && (n.value ?? n.amount) != null) {
      const unit = String(n.unitName ?? n.nutrient?.unitName ?? "").toUpperCase();
      const v = n.value ?? n.amount;
      if (unit !== "KJ") return v;
    }
  }
  return null;
}

function usdaMacros(list: any[]) {
  return {
    kcal: r1(usdaNutrient(list, [1008, 2047, 2048], ["energy"])),
    protein: r1(usdaNutrient(list, [1003], ["protein"])),
    carbs: r1(usdaNutrient(list, [1005, 1050], ["carbohydrate"])),
    fat: r1(usdaNutrient(list, [1004, 1085], ["total lipid"])),
  };
}

export async function searchUsda(key: string, q: string): Promise<RemoteFood[]> {
  const url = `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${encodeURIComponent(key)}&query=${encodeURIComponent(q)}&pageSize=12&dataType=${encodeURIComponent("Foundation,SR Legacy,Branded")}`;
  const data = await getJson(url);
  const foods: any[] = data.foods || [];
  // generic foods first - they're what recipes mean
  foods.sort((a, b) => (a.dataType === "Branded" ? 1 : 0) - (b.dataType === "Branded" ? 1 : 0));
  return foods.slice(0, 12).map((f) => {
    const units: Record<string, number> = {};
    if (f.servingSize && String(f.servingSizeUnit || "").toLowerCase() === "g") units.serving = Number(f.servingSize);
    return {
      source: "usda" as const,
      ref: String(f.fdcId),
      name: titleCase(String(f.description || "Food")),
      brand: f.brandName || f.brandOwner || null,
      ...usdaMacros(f.foodNutrients || []),
      units,
      ml_g: null,
      detail: f.dataType === "Branded" ? "Branded · per 100 g" : `${f.dataType} · per 100 g`,
    };
  });
}

const PORTION_WORDS: Record<string, string> = {
  cup: "cup", cups: "cup", tbsp: "tbsp", tablespoon: "tbsp", tsp: "tsp", teaspoon: "tsp", slice: "slice",
  clove: "clove", stalk: "stalk", stick: "stick", can: "can", large: "each", medium: "each", small: "each",
  each: "each", piece: "each", whole: "each", fruit: "each", serving: "serving", oz: "oz", "fl oz": "floz",
};

export async function usdaDetails(key: string, ref: string): Promise<RemoteFood> {
  const f = await getJson(`https://api.nal.usda.gov/fdc/v1/food/${encodeURIComponent(ref)}?api_key=${encodeURIComponent(key)}`);
  const units: Record<string, number> = {};
  let sizeRank = 9;
  for (const p of f.foodPortions || []) {
    const g = Number(p.gramWeight);
    const amt = Number(p.amount) || 1;
    if (!(g > 0)) continue;
    const label = `${p.measureUnit?.name && p.measureUnit.name !== "undetermined" ? p.measureUnit.name : ""} ${p.modifier || ""} ${p.portionDescription || ""}`.toLowerCase();
    const word = Object.keys(PORTION_WORDS).find((w) => new RegExp(`(^|[^a-z])${w}([^a-z]|$)`).test(label));
    if (!word) continue;
    const u = PORTION_WORDS[word];
    if (u === "oz" || u === "floz") continue;
    // for "each", medium beats large beats small
    if (u === "each") {
      const rank = word === "medium" ? 0 : word === "large" ? 1 : word === "small" ? 2 : 3;
      if (rank >= sizeRank) continue;
      sizeRank = rank;
      units.each = Math.round((g / amt) * 10) / 10;
      continue;
    }
    if (units[u] == null) units[u] = Math.round((g / amt) * 10) / 10;
  }
  if (f.servingSize && String(f.servingSizeUnit || "").toLowerCase() === "g") units.serving = Number(f.servingSize);
  const ml_g = units.cup ? Math.round((units.cup / 236.588) * 1000) / 1000 : units.tbsp ? Math.round((units.tbsp / 14.7868) * 1000) / 1000 : null;
  return {
    source: "usda", ref: String(f.fdcId), name: titleCase(String(f.description || "Food")),
    brand: f.brandName || f.brandOwner || null, ...usdaMacros(f.foodNutrients || []), units, ml_g,
    detail: f.dataType || null,
  };
}

// ── Open Food Facts ─────────────────────────────────────────────────────
function offToFood(p: any): RemoteFood | null {
  if (!p) return null;
  const n = p.nutriments || {};
  const kcal = n["energy-kcal_100g"] ?? (n["energy_100g"] != null ? n["energy_100g"] / 4.184 : null);
  const name = String(p.product_name || p.generic_name || "").trim();
  if (!name) return null;
  const units: Record<string, number> = {};
  const sq = Number(p.serving_quantity);
  if (sq > 0) units.serving = sq;
  return {
    source: "off", ref: String(p.code || p._id), name, brand: (p.brands || "").split(",")[0].trim() || null,
    kcal: r1(kcal), protein: r1(n.proteins_100g), carbs: r1(n.carbohydrates_100g), fat: r1(n.fat_100g),
    units, ml_g: null, detail: [p.quantity, p.serving_size ? `serving ${p.serving_size}` : null].filter(Boolean).join(" · ") || null,
  };
}

const OFF_FIELDS = "code,product_name,generic_name,brands,nutriments,serving_quantity,serving_size,quantity";

export async function searchOff(q: string): Promise<RemoteFood[]> {
  const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=12&fields=${OFF_FIELDS}`;
  const data = await getJson(url, { "User-Agent": OFF_UA });
  return (data.products || []).map(offToFood).filter((x: RemoteFood | null): x is RemoteFood => !!x && x.kcal != null);
}

export async function offBarcode(code: string): Promise<RemoteFood | null> {
  const clean = code.replace(/\D/g, "");
  if (clean.length < 6) return null;
  const data = await getJson(`https://world.openfoodfacts.org/api/v2/product/${clean}.json?fields=${OFF_FIELDS}`, { "User-Agent": OFF_UA });
  if (data.status !== 1 || !data.product) return null;
  const f = offToFood({ ...data.product, code: clean });
  return f;
}
