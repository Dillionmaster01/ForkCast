-- Forkcast: one household per deployment.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pin_hash TEXT NOT NULL,
  pin_salt TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  must_change_pin INTEGER NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT '#d9534f',
  kcal_goal INTEGER,
  protein_goal INTEGER,
  carbs_goal INTEGER,
  fat_goal INTEGER,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

-- nutrition per 100 g (basis 'g') or per item (basis 'each'); units = JSON {unit: grams}
CREATE TABLE foods (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  brand TEXT,
  source TEXT NOT NULL DEFAULT 'custom',      -- seed | usda | off | custom | restaurant
  source_ref TEXT,
  basis TEXT NOT NULL DEFAULT 'g',
  kcal REAL, protein REAL, carbs REAL, fat REAL,
  ml_g REAL,
  units TEXT,
  aisle TEXT NOT NULL DEFAULT 'Other',
  aliases TEXT,
  price REAL, price_qty REAL, price_unit TEXT,
  price_source TEXT,                          -- estimate | paid | entered
  price_updated TEXT,
  shop_unit TEXT,
  no_shop INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX foods_source_ref ON foods(source, source_ref) WHERE source_ref IS NOT NULL;

CREATE TABLE recipes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  servings REAL NOT NULL DEFAULT 4,
  description TEXT,
  steps TEXT,                                 -- JSON array of strings
  source_url TEXT,
  image_url TEXT,
  prep_min INTEGER,
  cook_min INTEGER,
  tags TEXT,                                  -- comma separated
  notes TEXT,
  site_kcal REAL,                             -- calories per serving the source site states
  favorite INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE recipe_ingredients (
  id TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  qty REAL,
  unit TEXT,
  name TEXT,
  note TEXT,
  food_id TEXT,
  grams REAL,                                 -- grams in one package for "1 (14 oz) can"
  optional INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX recipe_ingredients_recipe ON recipe_ingredients(recipe_id, position);

-- one meal in one slot; who eats it (and how much, and whether they did) is in plan_eaters
CREATE TABLE plan_items (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  slot TEXT NOT NULL,                         -- breakfast | lunch | dinner | dessert | snack
  position REAL NOT NULL DEFAULT 0,
  kind TEXT NOT NULL,                         -- recipe | food | quick
  recipe_id TEXT,
  food_id TEXT,
  qty REAL,                                   -- food: amount in one serving
  unit TEXT,
  title TEXT,
  kcal REAL, protein REAL, carbs REAL, fat REAL,   -- quick: per serving
  batch REAL NOT NULL DEFAULT 1,              -- recipe: how many times the recipe is made; 0 = leftovers, nothing to buy
  note TEXT,
  cooked INTEGER NOT NULL DEFAULT 0,
  cooked_log TEXT,                            -- pantry rows as they were before cooking, for undo
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX plan_items_date ON plan_items(date);

CREATE TABLE plan_eaters (
  plan_item_id TEXT NOT NULL REFERENCES plan_items(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  servings REAL NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'planned',     -- planned | eaten | skipped
  updated_at TEXT,
  PRIMARY KEY (plan_item_id, user_id)
);

CREATE TABLE pantry (
  id TEXT PRIMARY KEY,
  food_id TEXT,
  name TEXT NOT NULL,
  qty REAL,                                   -- null = have some, amount not tracked
  unit TEXT,
  staple INTEGER NOT NULL DEFAULT 0,          -- always have: never goes on the list
  updated_at TEXT NOT NULL
);

CREATE TABLE shopping_items (
  id TEXT PRIMARY KEY,
  food_id TEXT,
  name TEXT NOT NULL,
  qty REAL,
  unit TEXT,
  aisle TEXT NOT NULL DEFAULT 'Other',
  checked INTEGER NOT NULL DEFAULT 0,
  checked_at TEXT,
  paid REAL,
  source TEXT NOT NULL DEFAULT 'manual',      -- manual | plan
  for_text TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
