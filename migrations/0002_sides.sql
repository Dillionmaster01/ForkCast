-- Sides: a recipe can be a side dish, a main recipe can suggest sides (recipes or plain
-- foods), and a planned side hangs off its main meal so it moves / copies / goes with it.
ALTER TABLE recipes ADD COLUMN is_side INTEGER NOT NULL DEFAULT 0;

CREATE TABLE recipe_sides (
  id TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  side_recipe_id TEXT,
  side_food_id TEXT,
  qty REAL,
  unit TEXT
);
CREATE INDEX recipe_sides_recipe ON recipe_sides(recipe_id, position);

ALTER TABLE plan_items ADD COLUMN parent_id TEXT;
CREATE INDEX plan_items_parent ON plan_items(parent_id);
