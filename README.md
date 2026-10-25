# Forkcast

Household meal planner: recipes with calories, a week/month planner (breakfast, lunch,
dinner, dessert, snacks) with planned vs. eaten per person, per-person calorie goals,
a shopping list built from the plan (minus the pantry), prices that learn from what you
pay, recipe import from links or pasted text, and food lookups (USDA, Open Food Facts,
barcodes). Cloudflare Workers + Hono + D1, installable on phones.

## Run locally

```bash
npm install
npx wrangler d1 migrations apply forkcast-db --local
npx wrangler dev --port 8791
node tests/demo.seed.mjs   # optional: a week of demo data (test accounts Dillion/1234, Julia/2468)
```

## Tests

```bash
npm test                     # units, ingredient parsing, matching, shopping math, recipe import
node tests/api.scenario.mjs  # end-to-end API checks against wrangler dev (wipes the local DB)
```

`.dev.vars` sets `ALLOW_TEST_RESET=1` so the API test can reset the local database; it is
never deployed.

## Deploy

```bash
npx wrangler d1 migrations apply forkcast-db --remote
npx wrangler deploy
```

The first person to open a fresh deployment creates the household and becomes admin.

Food search uses USDA FoodData Central. Without a key it uses the shared, heavily
rate-limited `DEMO_KEY`. A free key: https://fdc.nal.usda.gov/api-key-signup, then

```bash
npx wrangler secret put USDA_API_KEY
```

After adding starter foods to `src/seed.ts`, an admin's app can pick them up with
`POST /api/foods/seed` (only adds what's missing).

## Notes

- Starter nutrition is typical USDA data; starter prices are rough US estimates and are
  marked "est." until someone enters what they paid.
- Alexa's shopping list can't be written to by other apps (Amazon closed that API in 2024),
  so the list has a Share button instead.
