// node --test tests/import.test.mjs   (Node strips the TypeScript types itself)
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRecipeFromHtml, parseRecipeText, isoMinutes, decodeEntities } from '../src/recipeImport.ts';

const page = (ld) => `<!doctype html><html><head><title>Best Chili | Some Site</title>
<script type="application/ld+json">${JSON.stringify(ld)}</script></head><body>…</body></html>`;

test('JSON-LD recipe inside @graph with HowToSteps and sections', () => {
  const html = page({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebPage', name: 'x' },
      {
        '@type': ['Recipe', 'NewsArticle'],
        name: 'Weeknight Chili &amp; Cornbread',
        recipeYield: ['6', '6 servings'],
        prepTime: 'PT15M', cookTime: 'PT1H', totalTime: 'PT1H15M',
        image: [{ '@type': 'ImageObject', url: '/img/chili.jpg' }],
        nutrition: { calories: '420 kcal' },
        recipeIngredient: ['2 lbs ground beef', '1 (15 oz) can kidney beans, drained', '2 tbsp chili powder', 'Salt to taste'],
        recipeInstructions: [
          { '@type': 'HowToSection', name: 'Chili', itemListElement: [
            { '@type': 'HowToStep', text: 'Brown the beef.' },
            { '@type': 'HowToStep', text: 'Add beans &amp; spices; simmer <b>1 hour</b>.' },
          ] },
        ],
      },
    ],
  });
  const r = extractRecipeFromHtml(html, 'https://example.com/recipes/chili');
  assert.equal(r.name, 'Weeknight Chili & Cornbread');
  assert.equal(r.servings, 6);
  assert.equal(r.prepMin, 15);
  assert.equal(r.cookMin, 60);
  assert.equal(r.image, 'https://example.com/img/chili.jpg');
  assert.equal(r.kcalPerServing, 420);
  assert.equal(r.ingredients.length, 4);
  assert.deepEqual(r.steps, ['— Chili —', 'Brown the beef.', 'Add beans & spices; simmer 1 hour.']);
});

test('instructions as one string, yield as text, only totalTime', () => {
  const r = extractRecipeFromHtml(page({
    '@type': 'Recipe', name: 'Pancakes', recipeYield: 'Makes 8 pancakes', totalTime: 'PT20M',
    recipeIngredient: ['1 cup flour', '1 egg'], recipeInstructions: '1. Mix everything.\n2. Cook on a hot pan.',
  }), null);
  assert.equal(r.servings, 8);
  assert.equal(r.cookMin, 20);
  assert.deepEqual(r.steps, ['Mix everything.', 'Cook on a hot pan.']);
});

test('no recipe on the page', () => {
  assert.equal(extractRecipeFromHtml('<html><script type="application/ld+json">{"@type":"Article"}</script></html>'), null);
  assert.equal(extractRecipeFromHtml('<html><script type="application/ld+json">{not json</script></html>'), null);
});

test('microdata fallback', () => {
  const r = extractRecipeFromHtml(`<title>Grandma's Cookies - Blog</title><ul><li itemprop="recipeIngredient">2 cups flour</li><li itemprop="recipeIngredient">1 cup sugar</li></ul>`);
  assert.equal(r.name, "Grandma's Cookies");
  assert.deepEqual(r.ingredients, ['2 cups flour', '1 cup sugar']);
});

test('pasted text with headings', () => {
  const r = parseRecipeText(`Garlic Butter Pasta
Serves 4

Ingredients
- 1 lb spaghetti
- 4 tbsp butter
- 6 cloves garlic, minced

Instructions
1. Boil the pasta.
2. Melt butter and cook the garlic.
3. Toss together.`);
  assert.equal(r.name, 'Garlic Butter Pasta');
  assert.equal(r.servings, 4);
  assert.deepEqual(r.ingredients, ['1 lb spaghetti', '4 tbsp butter', '6 cloves garlic, minced']);
  assert.deepEqual(r.steps, ['Boil the pasta.', 'Melt butter and cook the garlic.', 'Toss together.']);
});

test('pasted text without headings', () => {
  const r = parseRecipeText(`Quick Salad
2 cups lettuce
1 tomato
Chop everything and toss with dressing before serving.`);
  assert.equal(r.name, 'Quick Salad');
  assert.deepEqual(r.ingredients, ['2 cups lettuce', '1 tomato']);
  assert.equal(r.steps.length, 1);
});

test('durations and entities', () => {
  assert.equal(isoMinutes('PT1H30M'), 90);
  assert.equal(isoMinutes('P0DT0H45M'), 45);
  assert.equal(isoMinutes('nope'), null);
  assert.equal(decodeEntities('&frac12; cup &#8211; &#x2019;'), '½ cup – ’');
});
