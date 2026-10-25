// End-to-end API checks against a local `wrangler dev` (it wipes the local database first).
//   node tests/api.scenario.mjs            all steps
//   node tests/api.scenario.mjs 1 2        just those steps
const BASE = process.env.BASE || 'http://localhost:8791';
const only = process.argv.slice(2).map(Number);
let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? '  ✔' : '  ✖'} ${label}${ok ? '' : `  ${extra}`}`);
};
const near = (a, b, tol = 0.03) => a != null && Math.abs(a - b) <= Math.abs(b) * tol + 1;

async function api(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
}

function iso(d) { return d.toISOString().slice(0, 10); }
const today = new Date();
const D = (n) => { const d = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

const S = {}; // shared state between steps

async function step1() {
  console.log('Step 1 · household, sign-in, goals');
  let r = await api('POST', '/api/__test/reset', {});
  check(r.status === 200, 'local database reset', JSON.stringify(r.data));
  r = await api('GET', '/api/setup-needed');
  check(r.data.setupNeeded === true, 'fresh install asks for setup');
  r = await api('POST', '/api/setup', { name: 'Dillion', pin: '12' });
  check(r.status === 400, 'short PIN refused');
  r = await api('POST', '/api/setup', { name: 'Dillion', pin: '1234', kcal_goal: 2200 });
  check(r.status === 200 && r.data.token && r.data.user.isAdmin, 'first person becomes admin', JSON.stringify(r.data));
  S.d = r.data.token; S.dId = r.data.user.id;
  check(r.data.user.goals.kcal === 2200, 'calorie goal saved at setup');
  r = await api('POST', '/api/setup', { name: 'Someone', pin: '1111' });
  check(r.status === 400, 'setup can only happen once');
  r = await api('GET', '/api/foods', undefined, S.d);
  S.foods = r.data;
  const seeds = r.data.filter((f) => f.source === 'seed').length;
  const rest = r.data.filter((f) => f.source === 'restaurant').length;
  check(seeds > 100 && rest > 40, `starter foods loaded (${seeds} ingredients, ${rest} restaurant items)`);
  r = await api('POST', '/api/foods/seed', {}, S.d);
  r = await api('GET', '/api/foods', undefined, S.d);
  check(r.data.length === S.foods.length, 're-seeding adds no duplicates');

  r = await api('POST', '/api/users', { name: 'Julia', pin: '5678', goals: { kcal: 1800, protein: 90 } }, S.d);
  check(r.status === 200 && r.data.goals.kcal === 1800 && r.data.goals.protein === 90, 'admin adds Julia with her own goals', JSON.stringify(r.data));
  S.jId = r.data.id;
  r = await api('POST', '/api/login', { user_id: S.jId, pin: '5678' });
  check(r.status === 200 && r.data.user.mustChangePin === true, 'temp PIN signs in and asks for a new PIN');
  S.j = r.data.token;
  r = await api('PUT', '/api/me', { current_pin: '5678', new_pin: '5678' }, S.j);
  check(r.status === 400, 'cannot keep the temporary PIN');
  r = await api('PUT', '/api/me', { current_pin: '5678', new_pin: '2468' }, S.j);
  check(r.status === 200 && r.data.mustChangePin === false, 'Julia picks her own PIN');
  r = await api('POST', '/api/login', { user_id: S.jId, pin: '2468' });
  check(r.status === 200, 'new PIN works');
  S.j = r.data.token;
  r = await api('POST', '/api/users', { name: 'Nope', pin: '1111' }, S.j);
  check(r.status === 403, 'only the admin can add people');
  r = await api('PUT', '/api/me', { goals: { kcal: 1750, carbs: 200 } }, S.j);
  check(r.data.goals.kcal === 1750 && r.data.goals.carbs === 200, 'each person sets their own goals');
  r = await api('PUT', `/api/users/${S.dId}`, { goals: { kcal: 1 } }, S.j);
  check(r.status === 403, "can't change someone else's goals unless admin");

  r = await api('POST', '/api/users', { name: 'Lock Test', pin: '0000' }, S.d);
  const lockId = r.data.id;
  for (let i = 0; i < 5; i++) r = await api('POST', '/api/login', { user_id: lockId, pin: '9999' });
  r = await api('POST', '/api/login', { user_id: lockId, pin: '0000' });
  check(r.status === 429, 'five wrong PINs locks sign-in for a while');
  await api('DELETE', `/api/users/${lockId}`, undefined, S.d);
  r = await api('GET', '/api/users');
  check(r.data.length === 2 && !('pin_hash' in r.data[0]), 'sign-in list shows names only');
  r = await api('GET', '/api/plan?from=2026-01-01&to=2026-01-07');
  check(r.status === 401, 'data needs sign-in');
}

async function step2() {
  console.log('Step 2 · recipes, calories, planner');
  const ings = ['2 cups all-purpose flour', '2 large eggs', '1 1/2 cups milk', '2 tbsp butter, melted', '2 tbsp sugar', '1 tsp baking powder', 'pinch of salt'];
  let r = await api('POST', '/api/recipes', { name: 'Test Pancakes', servings: 4, ingredients: ings, steps: 'Mix.\nCook.', tags: 'breakfast, quick' }, S.d);
  check(r.status === 200, 'recipe saved', JSON.stringify(r.data));
  S.pancakes = r.data;
  check(r.data.ingredients.every((i) => i.food_id), 'every ingredient matched a food', JSON.stringify(r.data.ingredients.map((i) => [i.text, i.food_name])));
  // by hand: flour 913 + eggs 143 + milk 183 + butter 204 + sugar 97 + baking powder 2 = 1542 → 386 per serving
  check(near(r.data.perServing.kcal, 386), `calories per serving ≈ 386 (got ${r.data.perServing.kcal})`);
  check(r.data.cost > 0 && r.data.costPerServing > 0, `estimated cost $${r.data.cost} ($${r.data.costPerServing}/serving)`);
  check(r.data.steps.length === 2 && r.data.tags.includes('quick'), 'steps and tags kept');

  // edit: change servings and swap an ingredient to unmatched
  const edited = { ...r.data, servings: 2, ingredients: [...r.data.ingredients.map((i) => ({ text: i.text, food_id: i.food_id })), { text: '1 cup dragonfruit puree', food_id: null }] };
  r = await api('PUT', `/api/recipes/${S.pancakes.id}`, edited, S.d);
  check(near(r.data.perServing.kcal, 771) && r.data.unmatched === 1, `2 servings doubles the per-serving calories; unknown ingredient flagged (${r.data.perServing.kcal}, ${r.data.unmatched})`);
  r = await api('PUT', `/api/recipes/${S.pancakes.id}`, { ...edited, servings: 4, ingredients: ings }, S.d);
  check(near(r.data.perServing.kcal, 386), 'back to 4 servings');
  r = await api('PUT', `/api/recipes/${S.pancakes.id}`, { favorite: true }, S.d);
  check(r.data.favorite === true && r.data.ingredients.length === 7, 'favorite toggle keeps the recipe intact');

  const bigmac = S.foods.find((f) => f.name === 'Big Mac');
  const eggs = S.foods.find((f) => f.name === 'Eggs');
  S.day = D(1);
  r = await api('POST', '/api/plan', { date: S.day, slot: 'breakfast', kind: 'recipe', recipe_id: S.pancakes.id, batch: 1,
    eaters: [{ user_id: S.dId, servings: 2, status: 'eaten' }, { user_id: S.jId, servings: 1 }] }, S.d);
  check(r.status === 200, 'pancakes planned for breakfast');
  S.pItem = r.data.id;
  r = await api('POST', '/api/plan', { date: S.day, slot: 'lunch', kind: 'food', food_id: bigmac.id, eaters: [{ user_id: S.jId, status: 'eaten' }] }, S.j);
  check(r.status === 200, 'Big Mac logged for Julia');
  S.bmItem = r.data.id;
  r = await api('POST', '/api/plan', { date: S.day, slot: 'snack', kind: 'quick', title: 'Granola bar', kcal: 190, eaters: [{ user_id: S.dId, status: 'eaten' }] }, S.d);
  check(r.status === 200, 'quick-add snack with calories');
  r = await api('POST', '/api/plan', { date: S.day, slot: 'dinner', kind: 'food', food_id: eggs.id, qty: 3, unit: 'each', eaters: [{ user_id: S.dId }] }, S.d);
  S.eggItem = r.data.id;
  r = await api('POST', '/api/plan', { date: S.day, slot: 'brunch', kind: 'quick', title: 'x', kcal: 1 }, S.d);
  check(r.status === 400, 'unknown slot refused');

  r = await api('GET', `/api/plan?from=${S.day}&to=${S.day}`, undefined, S.d);
  const t = r.data.totals[S.day];
  check(near(t[S.dId].eaten.kcal, 386 * 2 + 190), `Dillion ate ≈ ${386 * 2 + 190} (got ${t[S.dId].eaten.kcal})`);
  check(near(t[S.dId].planned.kcal, 214), `Dillion has 3 eggs ≈ 214 still planned (got ${t[S.dId].planned.kcal})`);
  check(t[S.jId].eaten.kcal === 590 && near(t[S.jId].planned.kcal, 386), `Julia: 590 eaten, ≈386 planned (got ${t[S.jId].eaten.kcal}, ${t[S.jId].planned.kcal})`);
  check(r.data.items.length === 4 && r.data.users.find((u) => u.id === S.jId).goals.kcal === 1750, 'plan returns items and everyone\'s goals');

  // Julia actually skipped the pancakes and had something else
  r = await api('PUT', `/api/plan/${S.pItem}/eaters/${S.jId}`, { status: 'skipped' }, S.j);
  r = await api('POST', '/api/plan', { date: S.day, slot: 'breakfast', kind: 'quick', title: 'Yogurt', kcal: 150, eaters: [{ user_id: S.jId, status: 'eaten' }] }, S.j);
  r = await api('GET', `/api/plan?from=${S.day}&to=${S.day}`, undefined, S.d);
  check(r.data.totals[S.day][S.jId].eaten.kcal === 740 && r.data.totals[S.day][S.jId].planned.kcal === 0, 'planned vs actual: skipped meal drops out, the swap counts');

  // move the eggs to tomorrow's lunch, then duplicate
  r = await api('PUT', `/api/plan/${S.eggItem}`, { date: D(2), slot: 'lunch' }, S.d);
  r = await api('POST', `/api/plan/${S.eggItem}/duplicate`, { date: D(3), slot: 'breakfast' }, S.d);
  r = await api('GET', `/api/plan?from=${D(1)}&to=${D(3)}`, undefined, S.d);
  const eggsItems = r.data.items.filter((i) => i.title === 'Eggs');
  check(eggsItems.length === 2 && eggsItems[0].date === D(2) && eggsItems[0].slot === 'lunch' && eggsItems[1].slot === 'breakfast', 'move and duplicate');
  check(eggsItems[1].eaters[0].status === 'planned', 'a duplicate starts as planned');

  // copy the 3 days a week ahead
  r = await api('POST', '/api/plan/copy', { from: D(1), to: D(3), target: D(8) }, S.d);
  check(r.data.copied === 6, `copy days forward (${r.data.copied} meals)`);
  r = await api('GET', `/api/plan?from=${D(8)}&to=${D(10)}`, undefined, S.d);
  check(r.data.items.length === 6 && r.data.items.every((i) => i.eaters.every((e) => e.status === 'planned')), 'copied meals are all planned');

  r = await api('GET', `/api/stats?from=${D(1)}&to=${D(7)}`, undefined, S.d);
  const dStats = r.data.people.find((p) => p.id === S.dId);
  check(r.data.days.length === 7 && dStats.daysLogged === 1 && near(dStats.avgKcal, 962), `stats: Dillion 1 day logged, avg ≈ 962 (got ${dStats.avgKcal})`);
  r = await api('DELETE', `/api/plan/${S.bmItem}`, undefined, S.j);
  r = await api('GET', `/api/plan?from=${S.day}&to=${S.day}`, undefined, S.d);
  check(r.data.totals[S.day][S.jId].eaten.kcal === 150, 'removing a meal takes its calories away');
  r = await api('DELETE', `/api/recipes/${S.pancakes.id}`, undefined, S.d);
  r = await api('GET', `/api/plan?from=${S.day}&to=${S.day}`, undefined, S.d);
  check(near(r.data.totals[S.day][S.dId].eaten.kcal, 962), 'deleting a planned recipe archives it; old calories stay');
  r = await api('GET', '/api/recipes', undefined, S.d);
  check(!r.data.some((x) => x.id === S.pancakes.id), 'archived recipe leaves the recipe list');
}

async function step3() {
  console.log('Step 3 · shopping list, pantry, prices');
  const f = (n) => S.foods.find((x) => x.name === n);
  let r = await api('POST', '/api/recipes', { name: 'Chili', servings: 6, ingredients: [
    '2 lbs ground beef', '1 onion, diced', '3 cloves garlic', '1 (15 oz) can kidney beans', '2 (14.5 oz) cans diced tomatoes',
    '2 tbsp chili powder', 'Salt to taste', '1 cup shredded cheddar cheese'] }, S.d);
  S.chili = r.data;
  check(r.data.ingredients.every((i) => i.food_id), 'chili ingredients matched', JSON.stringify(r.data.ingredients.filter((i) => !i.food_id).map((i) => i.text)));
  r = await api('POST', '/api/recipes', { name: 'Tacos', servings: 4, ingredients: ['1 lb ground beef', '8 corn tortillas', '1/2 onion', '1 cup shredded cheddar'] }, S.d);
  S.tacos = r.data;
  const from = D(20);
  const to = D(26);
  S.chiliItem = (await api('POST', '/api/plan', { date: D(20), slot: 'dinner', kind: 'recipe', recipe_id: S.chili.id, eaters: [{ user_id: S.dId }, { user_id: S.jId }] }, S.d)).data.id;
  await api('POST', '/api/plan', { date: D(22), slot: 'dinner', kind: 'recipe', recipe_id: S.tacos.id, batch: 2, eaters: [{ user_id: S.dId }, { user_id: S.jId }] }, S.d);
  await api('POST', '/api/plan', { date: D(21), slot: 'lunch', kind: 'recipe', recipe_id: S.chili.id, batch: 0, eaters: [{ user_id: S.dId }] }, S.d); // leftovers
  await api('POST', '/api/plan', { date: D(21), slot: 'dinner', kind: 'food', food_id: f('Big Mac').id, eaters: [{ user_id: S.jId }] }, S.d);
  await api('POST', '/api/plan', { date: D(23), slot: 'breakfast', kind: 'food', food_id: f('Eggs').id, qty: 2, unit: 'each', eaters: [{ user_id: S.dId }, { user_id: S.jId, servings: 1.5 }] }, S.d);

  // pantry: salt always, 2 onions in stock, 6 eggs
  await api('POST', '/api/pantry', { food_id: f('Salt').id, staple: true }, S.d);
  await api('POST', '/api/pantry', { food_id: f('Onion').id, qty: 2, unit: 'each' }, S.d);
  await api('POST', '/api/pantry', { food_id: f('Eggs').id, qty: 6, unit: 'each' }, S.d);
  await api('POST', '/api/pantry', { food_id: f('Eggs').id, qty: 6, unit: 'each' }, S.d); // merges → 12
  r = await api('GET', '/api/pantry', undefined, S.d);
  check(r.data.find((p) => p.name === 'Eggs').qty === 12, 'adding to the pantry merges amounts');

  r = await api('POST', '/api/shopping/preview', { from, to }, S.d);
  const L = Object.fromEntries(r.data.lines.map((l) => [l.name, l]));
  check(near(L['Ground beef (80/20)'].need[0].qty, 4, 0.001) && L['Ground beef (80/20)'].need[0].unit === 'lb', `beef: chili 2 lb + tacos 2×1 lb = 4 lb (got ${L['Ground beef (80/20)'].needText})`);
  check(L['Ground beef (80/20)'].for.length === 2, 'each line says which meals need it');
  check(L['Salt'].covered && L['Salt'].coveredBy === 'staple', '"always have" salt is not bought');
  check(L['Eggs'].covered && L['Eggs'].coveredBy === 'pantry', 'eggs: 2 + 3 needed, 12 in the pantry → covered');
  check(L['Onion'].covered && near(L['Onion'].need[0].qty, 2, 0.01), `onion: chili 1 + tacos ½×2 = 2 needed, 2 in the pantry → covered (need ${L['Onion'].needText})`);
  check(near(L['Diced tomatoes (canned)'].need[0].qty, 2, 0.01) && L['Diced tomatoes (canned)'].need[0].unit === 'can', `tomatoes: 2 cans (got ${L['Diced tomatoes (canned)'].needText})`);
  check(L['Corn tortillas'].need[0].qty === 16, 'tortillas doubled for a 2× batch');
  check(!L['Big Mac'], 'restaurant food never goes on the list');
  check(L['Cheddar cheese'] && near(L['Cheddar cheese'].need[0].qty, 3, 0.01), `cheddar 1 + 2 = 3 cups (got ${L['Cheddar cheese']?.needText})`);
  check(L['Ground beef (80/20)'].cost > 20, `beef has an estimated cost ($${L['Ground beef (80/20)'].cost})`);
  S.preview = r.data;

  const toAdd = r.data.lines.filter((l) => !l.covered).map((l) => ({ food_id: l.food_id, name: l.name, qty: l.buy[0]?.qty ?? null, unit: l.buy[0]?.unit ?? null, aisle: l.aisle, for_text: l.for.join(', ') }));
  r = await api('POST', '/api/shopping/add', { lines: toAdd, staples: [{ food_id: f('Chili powder').id }] }, S.d);
  check(r.data.added === toAdd.length && r.data.items.length === toAdd.length, `added ${r.data.added} lines to the list`);
  check(r.data.estimate > 20, `list estimate $${r.data.estimate}`);
  r = await api('POST', '/api/shopping/preview', { from, to }, S.d);
  check(r.data.lines.every((l) => l.covered), 'building again finds everything already on the list or at home');
  check(r.data.lines.find((l) => l.name === 'Chili powder').coveredBy === 'staple', '"always have" chosen in the preview sticks');

  r = await api('POST', '/api/shopping', { name: 'paper towels', aisle: 'Household' }, S.d);
  r = await api('POST', '/api/shopping', { name: 'ground beef', qty: 1, unit: 'lb' }, S.d);
  const beef = r.data.items.find((i) => i.name === 'Ground beef (80/20)');
  check(near(beef.qty, 5, 0.001), `typing "ground beef" adds to the existing line (${beef.amountText})`);

  // shop: tick beef with the price paid, tick paper towels, finish
  r = await api('PUT', `/api/shopping/${beef.id}`, { checked: true, paid: 24.95 }, S.d);
  r = await api('GET', '/api/foods', undefined, S.d);
  const beefFood = r.data.find((x) => x.name === 'Ground beef (80/20)');
  check(beefFood.price === 24.95 && beefFood.price_qty === 5 && beefFood.price_unit === 'lb' && beefFood.price_source === 'paid', 'price paid becomes the new price ($4.99/lb)');
  const towels = (await api('GET', '/api/shopping', undefined, S.d)).data.items.find((i) => i.name === 'paper towels');
  await api('PUT', `/api/shopping/${towels.id}`, { checked: true }, S.d);
  r = await api('POST', '/api/shopping/finish', {}, S.d);
  check(r.data.stocked === 1 && !r.data.items.some((i) => i.checked), 'done shopping: food goes to the pantry, household items just leave');
  r = await api('GET', '/api/pantry', undefined, S.d);
  check(r.data.some((p) => p.name === 'Ground beef (80/20)' && near(p.qty, 5, 0.001)), 'beef now in the pantry');

  // cook the chili: pantry gives up 2 lb beef, 1 onion
  r = await api('POST', `/api/plan/${S.chiliItem}/cooked`, {}, S.d);
  check(r.data.changed >= 2, `cooking updates ${r.data.changed} pantry items`);
  r = await api('GET', '/api/pantry', undefined, S.d);
  check(near(r.data.find((p) => p.name === 'Ground beef (80/20)').qty, 3, 0.001) && near(r.data.find((p) => p.name === 'Onion').qty, 1, 0.001), 'beef 5→3 lb, onions 2→1');
  r = await api('POST', `/api/plan/${S.chiliItem}/cooked`, {}, S.d);
  check(r.data.already === true, 'cooking twice does nothing');
  r = await api('POST', `/api/plan/${S.chiliItem}/uncooked`, {}, S.d);
  r = await api('GET', '/api/pantry', undefined, S.d);
  check(near(r.data.find((p) => p.name === 'Ground beef (80/20)').qty, 5, 0.001) && near(r.data.find((p) => p.name === 'Onion').qty, 2, 0.001), 'undo puts it back');
  r = await api('PUT', `/api/plan/${S.chiliItem}/eaters/${S.dId}`, { status: 'eaten' }, S.d);
  check(r.data.pantryLines >= 2, 'eating an uncooked recipe offers to update the pantry');
  r = await api('POST', '/api/shopping/clear', { which: 'all' }, S.d);
  check(r.data.items.length === 0, 'clear the list');
}

async function step4() {
  console.log('Step 4 · import, food lookups, custom foods');
  let r = await api('POST', '/api/recipes/parse', { text: `Garlic Butter Pasta\nServes 4\n\nIngredients\n1 lb spaghetti\n4 tbsp unsalted butter\n6 cloves garlic, minced\n1/2 cup grated parmesan\nSalt and pepper to taste\n\nInstructions\n1. Boil the pasta.\n2. Melt butter, cook garlic.\n3. Toss with cheese.` }, S.d);
  check(r.status === 200 && r.data.ingredients.length === 5 && r.data.steps.length === 3 && r.data.servings === 4, 'pasted recipe parsed', JSON.stringify(r.data).slice(0, 300));
  check(r.data.ingredients.filter((i) => i.food_id).length === 5, 'pasted ingredients all matched', JSON.stringify(r.data.ingredients.map((i) => [i.name, i.food_id])));
  r = await api('POST', '/api/recipes', r.data, S.d);
  check(r.status === 200 && r.data.perServing.kcal > 400, `saved imported recipe (${r.data.perServing.kcal} kcal/serving)`);
  r = await api('POST', '/api/recipes/parse', { url: 'ftp://example.com/x' }, S.d);
  check(r.status === 422, 'non-web links refused');
  r = await api('POST', '/api/recipes/parse', { text: 'just some words' }, S.d);
  check(r.status === 400, 'text with no ingredients explains what to do');

  r = await api('POST', '/api/foods', { name: 'Homemade granola', basis: 'g', kcal: 471, protein: 10, carbs: 64, fat: 20, units: { cup: 120 }, aisle: 'Pantry', price: 4, price_qty: 1, price_unit: 'lb' }, S.d);
  check(r.status === 200 && r.data.units.cup === 120, 'custom food with its own cup weight');
  const gran = r.data;
  r = await api('POST', '/api/foods', { name: 'Gas station burrito', source: 'restaurant', brand: 'QuikTrip', kcal: 620, protein: 22, carbs: 70, fat: 27 }, S.d);
  check(r.data.basis === 'each' && r.data.no_shop === true, 'custom restaurant item counts per item and stays off the list');
  r = await api('POST', '/api/plan', { date: D(30), slot: 'breakfast', kind: 'food', food_id: gran.id, qty: 0.5, unit: 'cup', eaters: [{ user_id: S.dId, status: 'eaten' }] }, S.d);
  r = await api('GET', `/api/plan?from=${D(30)}&to=${D(30)}`, undefined, S.d);
  check(near(r.data.totals[D(30)][S.dId].eaten.kcal, 283), `½ cup granola ≈ 283 kcal (got ${r.data.totals[D(30)][S.dId].eaten.kcal})`);
  r = await api('PUT', `/api/foods/${gran.id}`, { kcal: 400 }, S.d);
  r = await api('GET', `/api/plan?from=${D(30)}&to=${D(30)}`, undefined, S.d);
  check(near(r.data.totals[D(30)][S.dId].eaten.kcal, 240), 'editing a food updates the meals that use it');
  r = await api('DELETE', `/api/foods/${gran.id}`, undefined, S.d);
  check(r.data.archived === true, 'a food that was eaten is archived, not deleted');

  // live lookups (network) - reported, not required
  r = await api('GET', '/api/foods/remote?q=cheddar%20cheese&source=usda', undefined, S.d);
  if (r.status === 200 && r.data.results.length) {
    check(r.data.results[0].kcal > 300, `USDA search works (${r.data.results[0].name}, ${r.data.results[0].kcal} kcal/100 g)`);
    const pick = r.data.results.find((x) => !x.brand) || r.data.results[0];
    r = await api('POST', '/api/foods/remote-import', { source: 'usda', ref: pick.ref }, S.d);
    check(r.status === 200 && r.data.source === 'usda', `USDA food imported with units ${JSON.stringify(r.data.units)}`);
    const again = await api('POST', '/api/foods/remote-import', { source: 'usda', ref: pick.ref }, S.d);
    check(again.data.id === r.data.id, 'importing the same food twice reuses it');
  } else console.log(`  · USDA lookup unavailable (${r.status} ${r.data?.detail}) - DEMO_KEY is rate limited`);
  r = await api('GET', '/api/foods/barcode/0049000028911', undefined, S.d); // a Coca-Cola can
  if (r.status === 200) check(r.data.food.kcal >= 0 && r.data.food.source === 'off', `barcode lookup works (${r.data.food.name})`);
  else console.log(`  · barcode lookup unavailable (${r.status} ${r.data?.detail})`);
}

const steps = { 1: step1, 2: step2, 3: step3, 4: step4 };
for (const [n, fn] of Object.entries(steps)) {
  if (only.length && !only.includes(Number(n))) continue;
  try { await fn(); } catch (e) { fail++; console.log(`  ✖ step ${n} crashed: ${e.stack}`); break; }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
