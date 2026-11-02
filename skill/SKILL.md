---
name: loseit
description: Track calories in the user's Lose It! account with the `loseit` CLI — read the food diary and calories remaining (day or week), log/edit/delete foods, search the food database, create custom foods and recipes. Use whenever the user asks about calories, macros, what they ate, what they can still eat, or wants something logged in Lose It.
---

# Lose It! via the `loseit` CLI

All commands print JSON to stdout. On failure they print `{"error":{"code","message"}}` to
stderr and exit 1. Add `--compact` before the subcommand for single-line JSON.

## Reading

- `loseit day [-d DATE]` → `{date, budget, food, exercise, remaining, nutrients, meals:{breakfast|lunch|dinner|snacks:{calories, entries[]}}, exerciseLog[]}`.
  Each entry has `id` (needed for edit/delete), `food.id`, `food.name`, `servings`, `amount`, `unit`, `calories`, `nutrients`.
- `loseit summary [-d END] [-n DAYS]` → per-day `{date, budget, food, exercise, remaining, logged}` and `totals`. Default: 7 days ending today.
- `remaining` = budget − food + exercise (Lose It's "calories left"). `exercise` is what Lose It credits
  toward the budget; `exerciseLog[].caloriesBurned` is the raw burn per activity and is often not credited
  (e.g. 268 burned, 0 credited), so report `exercise`/`remaining`, not the log sum.

DATE: `YYYY-MM-DD`, `today`, `yesterday`, or an offset like `-2`.

## Logging food

1. Find the food: `loseit food search <words> [--limit N]` → `id`, `name`, `brand`, `kind` (food|recipe), `fromHistory`.
   Foods the user logged in the last 90 days come first with `fromHistory: true`, `timesLogged`, `lastUsed`
   and `usual {amount, unit, servings, calories, meal}` — prefer these over new database variants
   (e.g. "eggs" → the egg they always log). `--history-days 0` searches the database only.
   What they usually eat: `loseit food history [words] [--days 90]` (grouped by food, sorted by last used then frequency).
   Your own foods: `loseit food mine [words]`; recipes: `loseit recipe list [words]`.
2. Check units if you need a specific amount: `loseit food show <id>` → `nutrientsPerServing`, `servingOptions[{unit, perServing, isDefault}]`.
3. Log it: `loseit log add <id> -m <breakfast|lunch|dinner|snacks> [-d DATE] [-s SERVINGS | -a AMOUNT -u UNIT]`.
   Units: g, ml, oz, cup, tbsp, tsp, each, serving, … (must be one of the food's `servingOptions`).
   With neither `-s` nor `-a`, one default serving is logged. If the user gives no amount and the food has
   a `usual` portion from history, log that (`-a <usual.amount> -u <usual.unit>`).

Nothing in the database? Create it: `loseit food create --name "…" --calories 250 [--protein 20 --carbs 30 --fat 8 --fiber --sugar --saturated-fat --sodium --cholesterol] [--brand …] [--serving-amount 1 --serving-unit serving]`.
Add `--log -m <meal> [-d DATE]` to also log one serving immediately.

## Re-logging past meals ("same breakfast as 2 days ago")

- `loseit log copy --from <DATE> [-m <meal>] [--to <DATE>] [--to-meal <meal>] [--entry <id> ...]`
  copies the exact entries (same foods, amounts, nutrients) onto `--to` (default today) and returns `copied[]` with new ids.
  - "Add the breakfast I had 2 days ago" → `loseit log copy --from -2 -m breakfast`
  - "Same lunch as Monday, but as dinner" → `loseit log copy --from 2026-11-02 -m lunch --to-meal dinner`
  - "Repeat yesterday" (whole day) → `loseit log copy --from yesterday`
  - Only some items: run `loseit day -d <DATE>` first, then pass `--entry <id> --entry <id>`.
- Before copying, it's worth showing the user what will be copied (`loseit day -d <DATE>`) if the request is ambiguous.

## Changing the diary

- `loseit log edit <entryId> [-d DATE_IT_IS_ON] [-s N | -a N [-u UNIT]] [-m MEAL] [--move-to DATE]`
- `loseit log delete <entryId> [-d DATE_IT_IS_ON]`
Entry ids come from `loseit day`. Moving to another date returns a new entry id.

## Recipes

- `loseit recipe show <id>` → ingredients, `yield`, `total`, `perServing`.
- `loseit recipe create --name "…" --servings <yield> -i <foodId>[:<amount>[:<unit>]] -i … [--notes "…"] [--brand …]`
  (an ingredient amount without a unit is a number of servings of that food).
- `loseit recipe delete <id>`; log a recipe with `loseit log add <recipeId> -m <meal> -s <servings>`.

## Guidance

- Confirm with the user before deleting entries, foods or recipes.
- When the user gives a portion ("200 g of chicken"), prefer `-a 200 -u g` over guessing servings.
- After logging, `loseit day` shows the updated `remaining` to report back.
- Errors with code `missing_credentials` or `login_failed`: ask the user to set `LOSEIT_EMAIL`/`LOSEIT_PASSWORD` in `~/.config/loseit/.env` and run `loseit auth login`.
