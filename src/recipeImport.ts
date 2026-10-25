// Pulling a recipe out of a web page or pasted text.
// Almost every recipe site embeds the recipe as schema.org JSON-LD (it's what Google
// uses for recipe cards), so that is read first; a page without it can still be pasted.

export type RecipeDraft = {
  name: string;
  servings: number | null;
  ingredients: string[];
  steps: string[];
  image: string | null;
  prepMin: number | null;
  cookMin: number | null;
  description: string | null;
  sourceUrl: string | null;
  kcalPerServing: number | null;
};

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  frac12: "½", frac14: "¼", frac34: "¾", frac13: "⅓", frac23: "⅔", frac18: "⅛", deg: "°", rsquo: "’",
  lsquo: "‘", rdquo: "”", ldquo: "“", eacute: "é", egrave: "è", ntilde: "ñ", reg: "®", trade: "™", copy: "©",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return isFinite(n) && n > 0 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

function clean(s: unknown): string {
  if (s == null) return "";
  return decodeEntities(decodeEntities(String(s)))
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t ]+([.,;:!?)])/g, "$1")
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

// ISO 8601 durations: PT1H30M, P0DT0H20M
export function isoMinutes(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = s.match(/^P(?:(\d+)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:\d+(?:\.\d+)?S)?)?$/i);
  if (!m) return null;
  const mins = (Number(m[1]) || 0) * 1440 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
  return mins > 0 ? Math.round(mins) : null;
}

function firstNumber(v: unknown): number | null {
  const arr = Array.isArray(v) ? v : [v];
  for (const x of arr) {
    if (typeof x === "number" && x > 0) return x;
    const m = String(x ?? "").match(/(\d+(?:\.\d+)?)/);
    if (m && Number(m[1]) > 0) return Number(m[1]);
  }
  return null;
}

function hasType(node: any, type: string): boolean {
  const t = node && node["@type"];
  if (!t) return false;
  return (Array.isArray(t) ? t : [t]).some((x) => String(x).toLowerCase() === type.toLowerCase());
}

function findRecipeNode(data: any, depth = 0): any {
  if (!data || depth > 6) return null;
  if (Array.isArray(data)) {
    for (const d of data) {
      const r = findRecipeNode(d, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (typeof data !== "object") return null;
  if (hasType(data, "Recipe")) return data;
  for (const k of ["@graph", "mainEntity", "mainEntityOfPage", "itemListElement", "item"]) {
    if (data[k]) {
      const r = findRecipeNode(data[k], depth + 1);
      if (r) return r;
    }
  }
  return null;
}

function stepsFrom(v: any, out: string[] = [], depth = 0): string[] {
  if (v == null || depth > 5) return out;
  if (typeof v === "string") {
    const t = clean(v);
    // one big block of text: split it into its lines / numbered steps
    for (const line of t.split(/\n+|(?<=\.)\s+(?=\d+[.)]\s)/)) {
      const s = line.replace(/^\s*(step\s*)?\d+[.):]\s*/i, "").trim();
      if (s) out.push(s);
    }
    return out;
  }
  if (Array.isArray(v)) {
    for (const x of v) stepsFrom(x, out, depth + 1);
    return out;
  }
  if (typeof v === "object") {
    if (hasType(v, "HowToSection") || v.itemListElement) {
      if (v.name && typeof v.name === "string" && v.itemListElement) out.push(`— ${clean(v.name)} —`);
      return stepsFrom(v.itemListElement, out, depth + 1);
    }
    const t = v.text ?? v.name ?? v.description;
    if (t) stepsFrom(String(t), out, depth + 1);
  }
  return out;
}

function imageFrom(v: any): string | null {
  if (!v) return null;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    for (const x of v) {
      const r = imageFrom(x);
      if (r) return r;
    }
    return null;
  }
  return typeof v.url === "string" ? v.url : typeof v.contentUrl === "string" ? v.contentUrl : null;
}

function parseJsonLoose(raw: string): any {
  const s = raw.trim().replace(/^<!--/, "").replace(/-->$/, "").trim();
  try {
    return JSON.parse(s);
  } catch {
    // stray control characters inside strings are the usual culprit
    try {
      return JSON.parse(s.replace(/[\u0000-\u001f]+/g, " "));
    } catch {
      return null;
    }
  }
}

export function extractRecipeFromHtml(html: string, url: string | null = null): RecipeDraft | null {
  const blocks = [...html.matchAll(/<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of blocks) {
    const data = parseJsonLoose(b[1]);
    const r = findRecipeNode(data);
    if (!r) continue;
    const ingredients = (Array.isArray(r.recipeIngredient) ? r.recipeIngredient : Array.isArray(r.ingredients) ? r.ingredients : [])
      .map((x: unknown) => clean(x))
      .filter(Boolean);
    const steps = stepsFrom(r.recipeInstructions);
    const name = clean(r.name) || clean(r.headline) || "Imported recipe";
    if (!ingredients.length && !steps.length) continue;
    const kcal = r.nutrition && firstNumber(r.nutrition.calories);
    let image = imageFrom(r.image);
    if (image && url) {
      try { image = new URL(image, url).href; } catch { image = null; }
    }
    return {
      name,
      servings: firstNumber(r.recipeYield ?? r.yield),
      ingredients,
      steps,
      image,
      prepMin: isoMinutes(r.prepTime),
      cookMin: isoMinutes(r.cookTime) ?? (isoMinutes(r.totalTime) != null && isoMinutes(r.prepTime) != null
        ? Math.max(0, isoMinutes(r.totalTime)! - isoMinutes(r.prepTime)!) || null : isoMinutes(r.totalTime)),
      description: clean(r.description) || null,
      sourceUrl: url,
      kcalPerServing: kcal != null ? Math.round(kcal) : null,
    };
  }
  // microdata fallback: itemprop="recipeIngredient"
  const ings = [...html.matchAll(/itemprop=["'](?:recipeIngredient|ingredients)["'][^>]*>([\s\S]*?)<\/(?:li|span|p|div)>/gi)].map((m) => clean(m[1])).filter(Boolean);
  if (ings.length) {
    const title = clean((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "") || "Imported recipe";
    const steps = [...html.matchAll(/itemprop=["']recipeInstructions["'][^>]*>([\s\S]*?)<\/(?:li|div|ol|p)>/gi)]
      .flatMap((m) => stepsFrom(m[1]));
    return {
      name: title.split(/\s[|–-]\s/)[0].trim(), servings: null, ingredients: ings, steps, image: null,
      prepMin: null, cookMin: null, description: null, sourceUrl: url, kcalPerServing: null,
    };
  }
  return null;
}

// Pasted text: an "Ingredients" heading and an "Instructions/Directions/Method/Steps"
// heading split it; without headings, lines that start with an amount are ingredients.
export function parseRecipeText(text: string): RecipeDraft {
  const lines = String(text || "").replace(/\r/g, "").split("\n").map((l) => l.trim());
  let name = "";
  let servings: number | null = null;
  const ingredients: string[] = [];
  const steps: string[] = [];
  let mode: "head" | "ing" | "steps" = "head";
  const hasHeadings = lines.some((l) => /^(ingredients?)\s*:?$/i.test(l));
  for (const raw of lines) {
    if (!raw) continue;
    const l = raw.replace(/^[\-–•*▢□☐·]\s*/, "");
    if (/^ingredients?\s*:?$/i.test(l)) { mode = "ing"; continue; }
    if (/^(instructions?|directions?|method|steps|preparation|how to make it)\s*:?$/i.test(l)) { mode = "steps"; continue; }
    const sv = l.match(/^(serves|servings|yield|makes)\s*:?\s*(\d+)/i);
    if (sv) { servings = Number(sv[2]); continue; }
    if (mode === "head") {
      if (!hasHeadings && /^([\d½¼¾⅓⅔⅛]|a\s|an\s)/i.test(l) && l.length < 120) { ingredients.push(l); mode = "ing"; continue; }
      if (!name) { name = l; continue; }
      if (!hasHeadings) steps.push(l.replace(/^\s*(step\s*)?\d+[.):]\s*/i, ""));
      continue;
    }
    if (mode === "ing") {
      // without headings, the first long sentence ends the ingredient list
      if (!hasHeadings && !/^([\d½¼¾⅓⅔⅛]|a\s|an\s)/i.test(l) && (l.length > 60 || /[.!]$/.test(l))) {
        mode = "steps";
        steps.push(l.replace(/^\s*(step\s*)?\d+[.):]\s*/i, ""));
        continue;
      }
      ingredients.push(l);
      continue;
    }
    steps.push(l.replace(/^\s*(step\s*)?\d+[.):]\s*/i, ""));
  }
  return {
    name: name || "New recipe", servings, ingredients, steps: steps.filter(Boolean), image: null,
    prepMin: null, cookMin: null, description: null, sourceUrl: null, kcalPerServing: null,
  };
}

export async function fetchRecipePage(url: string): Promise<{ html: string; finalUrl: string }> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("That doesn't look like a web address.");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Only web (http/https) links can be imported.");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(u.href, {
      signal: ctl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (res.status === 404 || res.status === 410) throw new Error("That page wasn't found - check the link.");
    if (!res.ok) throw new Error(`The site answered ${res.status} - it may block apps from reading it. Paste the recipe instead.`);
    const reader = res.body?.getReader();
    if (!reader) return { html: await res.text(), finalUrl: res.url || u.href };
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < 4_000_000) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    try { reader.cancel(); } catch { /* ignore */ }
    const all = new Uint8Array(size);
    let o = 0;
    for (const c of chunks) { all.set(c.subarray(0, Math.min(c.length, size - o)), o); o += c.length; if (o >= size) break; }
    return { html: new TextDecoder().decode(all), finalUrl: res.url || u.href };
  } catch (e: any) {
    if (e && e.name === "AbortError") throw new Error("The site took too long to answer. Try again or paste the recipe.");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
