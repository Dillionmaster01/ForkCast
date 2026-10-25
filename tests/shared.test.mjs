// node --test tests/shared.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIngredient, matchFood, searchFoods, guessAisle } from '../static/shared/ingredients.js';
import { nutritionFor, costFor, convertQty, fmtAmount, fmtQty, normUnit } from '../static/shared/units.js';
import { aggregateNeeds, subtract, costOf, roundForBuying } from '../static/shared/shopping.js';

const near = (a, b, tol = 0.02) => assert.ok(Math.abs(a - b) <= Math.abs(b) * tol + 0.01, `${a} ≉ ${b}`);

const FOODS = [
  { id: 'flour', name: 'All-purpose flour', aliases: 'flour,ap flour', basis: 'g', kcal: 364, protein: 10.3, carbs: 76.3, fat: 1, ml_g: 0.53, units: {}, price: 3, price_qty: 5, price_unit: 'lb' },
  { id: 'egg', name: 'Eggs', aliases: 'egg,large egg', basis: 'g', kcal: 143, protein: 12.6, carbs: 0.7, fat: 9.5, units: { each: 50 }, price: 3.5, price_qty: 12, price_unit: 'each', shop_unit: 'each' },
  { id: 'butter', name: 'Butter', aliases: 'unsalted butter', basis: 'g', kcal: 717, protein: 0.9, carbs: 0.1, fat: 81, ml_g: 0.96, units: { stick: 113 }, price: 4.5, price_qty: 1, price_unit: 'lb' },
  { id: 'pb', name: 'Peanut butter', basis: 'g', kcal: 588, protein: 25, carbs: 20, fat: 50, ml_g: 1.08, units: {} },
  { id: 'milk', name: 'Milk (2%)', aliases: 'milk', basis: 'g', kcal: 50, protein: 3.3, carbs: 4.8, fat: 2, ml_g: 1.03, units: {}, price: 3.75, price_qty: 1, price_unit: 'gallon' },
  { id: 'beans', name: 'Black beans (canned)', aliases: 'black beans', basis: 'g', kcal: 91, protein: 6, carbs: 16.6, fat: 0.3, ml_g: 0.73, units: { can: 260 }, price: 1, price_qty: 1, price_unit: 'can', shop_unit: 'can' },
  { id: 'onion', name: 'Onion', aliases: 'yellow onion,red onion', basis: 'g', kcal: 40, protein: 1.1, carbs: 9.3, fat: 0.1, ml_g: 0.68, units: { each: 110 }, price: 1.2, price_qty: 1, price_unit: 'lb', shop_unit: 'each' },
  { id: 'gpow', name: 'Garlic powder', basis: 'g', kcal: 331, protein: 16.6, carbs: 72.7, fat: 0.7, ml_g: 0.63, units: {} },
  { id: 'garlic', name: 'Garlic', aliases: 'garlic clove,minced garlic', basis: 'g', kcal: 149, protein: 6.4, carbs: 33, fat: 0.5, units: { clove: 3, head: 40 }, price: 0.6, price_qty: 1, price_unit: 'head', shop_unit: 'head' },
  { id: 'salt', name: 'Salt', aliases: 'kosher salt', basis: 'g', kcal: 0, protein: 0, carbs: 0, fat: 0, ml_g: 1.22, units: {} },
  { id: 'pepper', name: 'Black pepper', aliases: 'pepper', basis: 'g', kcal: 251, protein: 10, carbs: 64, fat: 3, ml_g: 0.47, units: {} },
  { id: 'bell', name: 'Bell pepper', aliases: 'green bell pepper,red bell pepper', basis: 'g', kcal: 26, protein: 1, carbs: 6, fat: 0.3, units: { each: 119 } },
  { id: 'bigmac', name: 'Big Mac', brand: "McDonald's", source: 'restaurant', basis: 'each', kcal: 590, protein: 25, carbs: 46, fat: 34, units: {} },
];
const byId = Object.fromEntries(FOODS.map((f) => [f.id, f]));

test('units normalise', () => {
  assert.equal(normUnit('Tablespoons'), 'tbsp');
  assert.equal(normUnit('T'), 'tbsp');
  assert.equal(normUnit('t'), 'tsp');
  assert.equal(normUnit('tsp.'), 'tsp');
  assert.equal(normUnit('fl oz'), 'floz');
  assert.equal(normUnit('lbs'), 'lb');
  assert.equal(normUnit('onion'), null);
});

test('parse common ingredient lines', () => {
  const cases = [
    ['2 cups all-purpose flour', 2, 'cup', 'all-purpose flour'],
    ['1 1/2 cups milk', 1.5, 'cup', 'milk'],
    ['1½ cups milk', 1.5, 'cup', 'milk'],
    ['½ tsp. salt', 0.5, 'tsp', 'salt'],
    ['3 large eggs', 3, 'each', 'eggs'],
    ['1 onion, diced', 1, 'each', 'onion'],
    ['2-3 cloves garlic, minced', 2.5, 'clove', 'garlic'],
    ['1 T butter', 1, 'tbsp', 'butter'],
    ['400g chickpeas', 400, 'g', 'chickpeas'],
    ['2 lbs ground beef', 2, 'lb', 'ground beef'],
    ['a pinch of salt', 1, 'pinch', 'salt'],
    ['1 dozen eggs', 12, 'each', 'eggs'],
    ['▢ 8 oz cream cheese, softened', 8, 'oz', 'cream cheese'],
    ['1 cup (2 sticks) unsalted butter, softened', 1, 'cup', 'unsalted butter'],
    ['12 fl oz beer', 12, 'floz', 'beer'],
  ];
  for (const [text, qty, unit, name] of cases) {
    const p = parseIngredient(text);
    assert.equal(p.qty, qty, text);
    assert.equal(p.unit, unit, text);
    assert.equal(p.name, name, text);
  }
  const can = parseIngredient('1 (15 oz) can black beans, drained and rinsed');
  assert.equal(can.qty, 1);
  assert.equal(can.unit, 'can');
  assert.equal(can.name, 'black beans');
  near(can.grams, 425.2);
  assert.match(can.note, /drained and rinsed/);
  const taste = parseIngredient('Salt and pepper to taste');
  assert.equal(taste.qty, null);
  assert.equal(taste.name, 'Salt and pepper');
  assert.equal(parseIngredient('1/4 cup olive oil (optional)').optional, true);
  assert.equal(parseIngredient('a few sprigs thyme').qty, null);
  assert.equal(parseIngredient('2 cups minus 2 tablespoons cake flour (8 ½ ounces)').name, 'cake flour');
  assert.equal(parseIngredient('1 cup plus 2 tablespoons granulated sugar').name, 'granulated sugar');
  const pinch = parseIngredient('Pinch freshly ground black pepper');
  assert.deepEqual([pinch.qty, pinch.unit, pinch.name], [1, 'pinch', 'freshly ground black pepper']);
});

test('match ingredient names to foods', () => {
  const m = (s) => (matchFood(s, FOODS) || {}).food?.id || null;
  assert.equal(m('all-purpose flour'), 'flour');
  assert.equal(m('flour'), 'flour');
  assert.equal(m('large eggs'), 'egg');
  assert.equal(m('unsalted butter'), 'butter');
  assert.equal(m('creamy peanut butter'), 'pb');
  assert.equal(m('garlic powder'), 'gpow');
  assert.equal(m('garlic'), 'garlic');
  assert.equal(m('red onion'), 'onion');
  assert.equal(m('green bell pepper'), 'bell');
  assert.equal(m('Salt and pepper'), 'salt');
  assert.equal(m('coconut milk'), null, 'coconut milk is not milk');
  assert.equal(m('almond milk'), null, 'almond milk is not milk');
  const rice = [{ id: 'dry', name: 'White rice (dry)', aliases: 'rice,jasmine rice', basis: 'g', kcal: 365 }, { id: 'ckd', name: 'Cooked white rice', aliases: 'cooked rice,cooked jasmine rice', basis: 'g', kcal: 130 }];
  assert.equal(matchFood('cooked jasmine rice', rice).food.id, 'ckd', 'cooked rice is not dry rice');
  assert.equal(matchFood('jasmine rice', rice).food.id, 'dry');
  assert.equal(matchFood('cooked jasmine rice', rice.slice(0, 1)), null, 'no cooked rice → no match rather than dry rice');
  assert.equal(m('big mac'), null, 'restaurant items are not ingredients');
  const withCans = [...FOODS, { id: 'tom', name: 'Tomato', basis: 'g', kcal: 18, units: { each: 123 } }, { id: 'ctom', name: 'Diced tomatoes (canned)', aliases: 'diced tomatoes', basis: 'g', kcal: 24, units: { can: 411 } }];
  assert.equal(matchFood('diced tomatoes', withCans, { unit: 'can' }).food.id, 'ctom', 'a can points at the canned food');
  assert.equal(matchFood('tomatoes', withCans, { unit: 'each' }).food.id, 'tom');
  assert.equal(searchFoods('big', FOODS)[0].id, 'bigmac');
  assert.equal(guessAisle('fresh basil'), 'Produce');
  assert.equal(guessAisle('frozen corn'), 'Frozen');
});

test('nutrition math', () => {
  near(nutritionFor(byId.flour, 1, 'cup').kcal, 364 * (236.588 * 0.53) / 100); // ~456
  near(nutritionFor(byId.egg, 2, 'each').kcal, 143);
  near(nutritionFor(byId.butter, 1, 'stick').kcal, 717 * 1.13);
  near(nutritionFor(byId.butter, 2, 'tbsp').kcal, 717 * (2 * 14.7868 * 0.96) / 100);
  near(nutritionFor(byId.beans, 1, 'can', 425).kcal, 91 * 4.25, 0.01); // the package size wins
  near(nutritionFor(byId.beans, 1, 'can').kcal, 91 * 2.6);
  near(nutritionFor(byId.bigmac, 2, 'each').kcal, 1180);
  assert.equal(nutritionFor(byId.egg, 1, 'cup'), null, 'no density for eggs');
});

test('cost math', () => {
  near(costFor(byId.egg, 6, 'each'), 1.75);
  near(costFor(byId.flour, 2, 'cup'), (3 / 5) * ((2 * 236.588 * 0.53) / 453.592));
  near(costFor(byId.milk, 2, 'cup'), 3.75 / 8);
  near(costFor(byId.onion, 2, 'each'), 1.2 * (220 / 453.592));
  assert.equal(costFor(byId.pb, 1, 'tbsp'), null, 'no price yet');
});

test('display', () => {
  assert.equal(fmtQty(1.5, 'cup'), '1 ½');
  assert.equal(fmtQty(0.333, 'cup'), '⅓');
  assert.equal(fmtAmount(2, 'cup'), '2 cups');
  assert.equal(fmtAmount(3, 'each'), '3');
  assert.equal(fmtAmount(907.18, 'g'), '2 lb');
  assert.equal(fmtAmount(226.8, 'g'), '8 oz');
  near(convertQty(byId.butter, 1, 'stick', 'tbsp'), 113 / (14.7868 * 0.96));
});

test('aggregate and subtract a shopping list', () => {
  const lines = [
    { food_id: 'egg', name: 'eggs', qty: 3, unit: 'each', for: 'Pancakes' },
    { food_id: 'egg', name: 'eggs', qty: 2, unit: 'each', for: 'Cookies' },
    { food_id: 'flour', name: 'flour', qty: 2, unit: 'cup', for: 'Cookies' },
    { food_id: 'flour', name: 'flour', qty: 100, unit: 'g', for: 'Pancakes' },
    { food_id: 'beans', name: 'black beans', qty: 1, unit: 'can', hint: 425, for: 'Chili' },
    { food_id: 'beans', name: 'black beans', qty: 1, unit: 'cup', for: 'Tacos' },
    { food_id: null, name: 'Fresh basil', qty: 1, unit: 'bunch', for: 'Pasta' },
    { food_id: null, name: 'fresh basil leaves', qty: null, unit: null, for: 'Salad' },
    { food_id: 'salt', name: 'salt', qty: null, unit: null, for: 'Chili' },
  ];
  const agg = aggregateNeeds(lines, byId);
  const g = Object.fromEntries(agg.map((x) => [x.key, x]));
  assert.deepEqual(g['f:egg'].total, [{ qty: 5, unit: 'each' }]);
  assert.deepEqual(g['f:egg'].for, ['Pancakes', 'Cookies']);
  assert.equal(g['f:flour'].total.length, 1);
  near(g['f:flour'].total[0].qty, 2 + 100 / (236.588 * 0.53));
  assert.equal(g['f:beans'].total[0].unit, 'can');
  // 425 g can + one cup (172.7 g) of beans, in 260 g cans
  near(g['f:beans'].total[0].qty, 1 + (236.588 * 0.73) / 260);
  assert.equal(agg.filter((x) => x.key.startsWith('n:')).length, 1, 'basil lines merge by name');
  assert.equal(g['f:salt'].someQty, true);

  // pantry: 4 eggs → buy 1; flour "have" (amount unknown) → covered
  const eggs = subtract(g['f:egg'].total, [{ qty: 4, unit: 'each' }], byId.egg);
  assert.deepEqual(eggs.buy, [{ qty: 1, unit: 'each' }]);
  assert.equal(subtract(g['f:flour'].total, [{ untracked: true }], byId.flour).covered, true);
  // 1 lb of flour in the pantry against ~2.8 cups needed (~354 g) → covered
  assert.equal(subtract(g['f:flour'].total, [{ qty: 1, unit: 'lb' }], byId.flour).covered, true);
  // 1 cup of milk in the pantry can't cover eggs - reported as unmatched
  assert.equal(subtract(g['f:egg'].total, [{ qty: 1, unit: 'cup' }], byId.egg).unmatched, true);
  near(costOf([{ qty: 5, unit: 'each' }], byId.egg), 3.5 * 5 / 12);
  assert.deepEqual(roundForBuying([{ qty: 0.225, unit: 'head' }, { qty: 1.66, unit: 'can' }, { qty: 2.8, unit: 'cup' }, { qty: 2.02, unit: 'each' }]),
    [{ qty: 1, unit: 'head' }, { qty: 2, unit: 'can' }, { qty: 2.8, unit: 'cup' }, { qty: 2, unit: 'each' }]);
});
