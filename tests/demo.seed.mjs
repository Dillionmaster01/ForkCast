// Fills a LOCAL wrangler dev database with a believable week for trying the UI.
// Wipes it first. Test accounts: Dillion / 1234 (admin), Julia / 2468.
const BASE = process.env.BASE || 'http://localhost:8791';
async function api(method, path, body, token) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}
const pad = (n) => String(n).padStart(2, '0');
const t = new Date();
const D = (n) => { const d = new Date(t.getFullYear(), t.getMonth(), t.getDate() + n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

await api('POST', '/api/__test/reset', {});
const { token: d, user: du } = await api('POST', '/api/setup', { name: 'Dillion', pin: '1234', kcal_goal: 2200 });
const ju = await api('POST', '/api/users', { name: 'Julia', pin: '5678', goals: { kcal: 1750, protein: 90 } }, d);
const jl = await api('POST', '/api/login', { user_id: ju.id, pin: '5678' });
await api('PUT', '/api/me', { current_pin: '5678', new_pin: '2468' }, jl.token);
const foods = await api('GET', '/api/foods', undefined, d);
const F = (n) => foods.find((f) => f.name === n).id;
const R = async (name, servings, ingredients, steps, tags, extra = {}) => (await api('POST', '/api/recipes', { name, servings, ingredients, steps, tags, ...extra }, d)).id;

const pancakes = await R('Fluffy Pancakes', 4, ['2 cups all-purpose flour', '2 large eggs', '1 1/2 cups milk', '2 tbsp butter, melted', '2 tbsp sugar', '1 tbsp baking powder', 'pinch of salt'], ['Whisk the dry ingredients.', 'Whisk milk, eggs and butter, then stir into the dry mix.', 'Cook ¼ cup at a time on a hot buttered pan.'], 'breakfast, quick', { prep_min: 10, cook_min: 15, favorite: true });
const chili = await R('Weeknight Chili', 6, ['2 lbs ground beef', '1 onion, diced', '3 cloves garlic, minced', '1 (15 oz) can kidney beans, drained', '2 (14.5 oz) cans diced tomatoes', '2 tbsp chili powder', '1 tsp ground cumin', 'Salt to taste', '1 cup shredded cheddar cheese'], ['Brown the beef with the onion.', 'Add garlic and spices for a minute.', 'Add beans and tomatoes; simmer 30 minutes.', 'Serve topped with cheddar.'], 'dinner', { prep_min: 15, cook_min: 40 });
const tacos = await R('Beef Tacos', 4, ['1 lb ground beef', '8 corn tortillas', '1/2 onion, chopped', '1 cup shredded cheddar', '1 tomato, diced', '1 cup romaine lettuce, shredded', '1/2 cup salsa'], ['Brown the beef.', 'Warm the tortillas.', 'Fill and top.'], 'dinner, quick', { cook_min: 20 });
const bread = await R('Garlic Bread', 6, ['1 loaf white bread', '6 tbsp butter, softened', '4 cloves garlic, minced', '2 tbsp parmesan'], ['Mix butter, garlic and parmesan.', 'Spread on sliced bread and bake at 400°F for 10 minutes.'], 'side', { is_side: true });
const salad = await R('Side Salad', 4, ['1 head romaine lettuce', '1 cucumber', '2 tomatoes', '1/4 cup olive oil', '2 tbsp vinegar'], ['Chop and toss with oil and vinegar.'], 'side, healthy', { is_side: true });
const pasta = await R('Garlic Butter Pasta', 4, ['1 lb spaghetti', '4 tbsp unsalted butter', '6 cloves garlic, minced', '1/2 cup grated parmesan', 'Salt and pepper to taste'], ['Boil the pasta.', 'Melt butter and cook the garlic.', 'Toss with pasta and cheese.'], 'dinner, quick', { cook_min: 20, sides: [{ recipe_id: bread }, { recipe_id: salad }] });
const salmon = await R('Lemon Salmon & Rice', 2, ['2 salmon fillets', '1 cup white rice', '1 lemon', '1 tbsp olive oil', '2 cups broccoli florets'], ['Cook the rice.', 'Roast salmon and broccoli at 400°F for 12 minutes.', 'Squeeze lemon over.'], 'dinner, healthy', { prep_min: 10, cook_min: 25, sides: [{ recipe_id: salad }, { food_id: F('Green beans'), qty: 1, unit: 'cup' }] });
const oats = await R('Peanut Butter Oatmeal', 1, ['1/2 cup rolled oats', '1 cup milk', '1 tbsp peanut butter', '1 banana'], ['Simmer oats in milk 5 minutes.', 'Top with peanut butter and banana.'], 'breakfast');

const both = (status = 'planned', s1 = 1, s2 = 1) => [{ user_id: du.id, servings: s1, status }, { user_id: ju.id, servings: s2, status }];
const add = (body) => api('POST', '/api/plan', body, d);
for (let i = -2; i <= 5; i++) {
  const date = D(i);
  const past = i < 0;
  const st = past ? 'eaten' : 'planned';
  await add({ date, slot: 'breakfast', kind: 'recipe', recipe_id: i % 2 ? pancakes : oats, batch: i % 2 ? 1 : 2, eaters: both(st, i % 2 ? 2 : 1, 1) });
  if (i % 3 === 0) await add({ date, slot: 'lunch', kind: 'food', food_id: F('Chicken Burrito Bowl (rice, black beans, salsa, cheese)'), eaters: [{ user_id: du.id, status: st }] });
  else await add({ date, slot: 'lunch', kind: 'food', food_id: F('Deli turkey'), qty: 4, unit: 'slice', eaters: both(st) });
  const dinner = [chili, tacos, pasta, salmon][(i + 4) % 4];
  await add({ date, slot: 'dinner', kind: 'recipe', recipe_id: dinner, batch: 1, eaters: both(st, 1.5, 1), sides: dinner === pasta ? [{ kind: 'recipe', recipe_id: bread }] : [] });
  if (i === 1 || i === 4) await add({ date, slot: 'dessert', kind: 'food', food_id: F('Vanilla ice cream'), qty: 1, unit: 'cup', eaters: both(st) });
  if (past) await add({ date, slot: 'snack', kind: 'quick', title: 'Granola bar', kcal: 190, eaters: [{ user_id: ju.id, status: 'eaten' }] });
}
await add({ date: D(0), slot: 'lunch', kind: 'food', food_id: F('Big Mac'), eaters: [{ user_id: ju.id, status: 'eaten' }] });
for (const [n, q, u] of [['Eggs', 6, 'each'], ['Milk (2%)', 0.5, 'gallon'], ['Onion', 2, 'each'], ['White rice (dry)', 2, 'lb']]) await api('POST', '/api/pantry', { food_id: F(n), qty: q, unit: u }, d);
for (const n of ['Salt', 'Black pepper', 'Olive oil', 'Vegetable oil']) await api('POST', '/api/pantry', { food_id: F(n), staple: true }, d);
await api('POST', '/api/shopping', { name: 'coffee', aisle: 'Drinks' }, d);
await api('POST', '/api/shopping', { name: 'paper towels', aisle: 'Household' }, d);
console.log('demo data ready');
