#!/usr/bin/env node
import { Command, Option } from "commander";

import { LoseIt, type Amount, type Ingredient } from "./loseit/api.js";
import { LoseItClient, LoseItError } from "./loseit/client.js";
import { loadConfig } from "./loseit/config.js";
import { parseMeal, type Nutrients } from "./loseit/model.js";

const config = loadConfig();
const client = new LoseItClient(config);
const api = new LoseIt(client);

function print(data: unknown): void {
  const json = JSON.stringify(
    data,
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    program.opts().compact ? undefined : 2,
  );
  process.stdout.write(`${json}\n`);
}

function run<A extends unknown[]>(fn: (...args: A) => Promise<unknown>) {
  return async (...args: A) => {
    try {
      const result = await fn(...args);
      if (result !== undefined) print(result);
    } catch (err) {
      const e = err as Error;
      const code = err instanceof LoseItError ? err.code : "error";
      process.stderr.write(`${JSON.stringify({ error: { code, message: e.message } })}\n`);
      process.exitCode = 1;
    }
  };
}

const number = (name: string) => (value: string) => {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
};

const dateOption = () =>
  new Option("-d, --date <date>", "YYYY-MM-DD, today, yesterday or an offset like -2").default("today");
const mealOption = () =>
  new Option("-m, --meal <meal>", "breakfast | lunch | dinner | snacks").makeOptionMandatory();
const amountOptions = (cmd: Command) =>
  cmd
    .option("-s, --servings <n>", "number of servings", number("servings"))
    .option("-a, --amount <n>", "amount in --unit (or the entry's current unit)", number("amount"))
    .option("-u, --unit <unit>", "serving unit, e.g. g, ml, cup, tbsp, each, serving");

function amountFrom(o: { servings?: number; amount?: number; unit?: string }): Amount {
  if (o.servings !== undefined && (o.amount !== undefined || o.unit)) {
    throw new LoseItError("use either --servings or --amount/--unit", "bad_input");
  }
  return { servings: o.servings, amount: o.amount, unit: o.unit };
}

const NUTRIENT_FLAGS: [string, string, string][] = [
  ["calories", "--calories <kcal>", "calories per serving"],
  ["protein", "--protein <g>", "protein (g)"],
  ["carbs", "--carbs <g>", "carbohydrates (g)"],
  ["fat", "--fat <g>", "fat (g)"],
  ["saturatedFat", "--saturated-fat <g>", "saturated fat (g)"],
  ["fiber", "--fiber <g>", "fiber (g)"],
  ["sugar", "--sugar <g>", "sugar (g)"],
  ["sodium", "--sodium <mg>", "sodium (mg)"],
  ["cholesterol", "--cholesterol <mg>", "cholesterol (mg)"],
];

const program = new Command()
  .name("loseit")
  .description(
    "Agent-friendly CLI for Lose It! — read your diary and calorie budget, log/edit/delete foods, " +
      "search and create foods and recipes. Output is JSON on stdout; errors are JSON on stderr with exit code 1.",
  )
  .option("--compact", "single-line JSON output")
  .showHelpAfterError();

// ─── auth ────────────────────────────────────────────────────────────────────

const auth = program.command("auth").description("manage the Lose It session");
auth
  .command("login")
  .description("log in with LOSEIT_EMAIL / LOSEIT_PASSWORD and cache the session")
  .action(
    run(async () => {
      const s = await client.login();
      await client.ensureSchema(true);
      return { ok: true, userId: s.userId, username: s.username, home: config.home };
    }),
  );
auth
  .command("status")
  .description("check that the cached session and Lose It build schema work")
  .action(
    run(async () => {
      const day = await api.day();
      return { ok: true, timezone: config.timezone, today: day.date, budget: day.budget };
    }),
  );
auth
  .command("logout")
  .description("forget the cached session")
  .action(run(async () => (await client.logout(), { ok: true })));

// ─── diary ───────────────────────────────────────────────────────────────────

program
  .command("day")
  .description("a day's food log by meal with budget, eaten, exercise and calories remaining")
  .addOption(dateOption())
  .action(run(async (o: { date: string }) => api.day(o.date)));

program
  .command("summary")
  .description("per-day budget / eaten / exercise / remaining for a range ending on --date")
  .addOption(dateOption())
  .option("-n, --days <n>", "number of days (7 = a week)", number("days"), 7)
  .action(run(async (o: { date: string; days: number }) => api.summary(o.date, o.days)));

// ─── foods ───────────────────────────────────────────────────────────────────

const food = program.command("food").description("search, inspect and create foods");
food
  .command("search")
  .description(
    "search the Lose It food database; foods you logged recently come first (fromHistory: true)",
  )
  .argument("<query...>")
  .option("-l, --limit <n>", "max results", number("limit"), 20)
  .option("--history-days <n>", "how far back to look for your own foods (0 = database only)", number("history-days"), 90)
  .action(
    run(async (q: string[], o: { limit: number; historyDays: number }) =>
      api.searchFoods(q.join(" "), o.limit, o.historyDays),
    ),
  );
food
  .command("history")
  .description(
    "foods from your diary grouped by food: times logged, last used, usual amount/unit/meal " +
      "(sorted by last used, then frequency)",
  )
  .argument("[query...]")
  .option("--days <n>", "how many days back to scan", number("days"), 90)
  .action(run(async (q: string[], o: { days: number }) => api.foodHistory(q.join(" "), o.days)));
food
  .command("show")
  .description("nutrients per serving and available serving units for a food or recipe id")
  .argument("<id>")
  .action(run(async (id: string) => api.food(id)));
food
  .command("mine")
  .description("list your foods (custom + recently used), optionally filtered")
  .argument("[query...]")
  .option("--custom", "only foods you created")
  .action(
    run(async (q: string[], o: { custom?: boolean }) =>
      o.custom ? api.customFoods(q.join(" ")) : api.myFoods(q.join(" ")),
    ),
  );
const create = food
  .command("create")
  .description("create a custom food (nutrients are per serving); --log also logs one serving")
  .requiredOption("--name <name>", "food name")
  .option("--brand <brand>", "brand or restaurant")
  .option("--serving-amount <n>", "size of one serving in --serving-unit", number("serving-amount"), 1)
  .option("--serving-unit <unit>", "unit of one serving (serving, g, ml, cup, each, ...)", "serving")
  .option("--log", "also log one serving to --meal on --date")
  .addOption(new Option("-m, --meal <meal>", "meal for --log"))
  .addOption(dateOption());
for (const [, flag, desc] of NUTRIENT_FLAGS) create.option(flag, desc, number(flag));
create.action(
  run(async (o: Record<string, unknown>) => {
    if (o.calories === undefined) throw new LoseItError("--calories is required", "bad_input");
    const nutrients: Nutrients = {};
    for (const [key] of NUTRIENT_FLAGS) if (typeof o[key] === "number") nutrients[key] = o[key] as number;
    const spec = {
      name: o.name as string,
      brand: o.brand as string | undefined,
      nutrients,
      servingAmount: o.servingAmount as number,
      unit: o.servingUnit as string,
    };
    if (o.log && !o.meal) throw new LoseItError("--log requires --meal", "bad_input");
    return api.createFood(spec, o.log ? { meal: parseMeal(o.meal as string), date: o.date as string } : undefined);
  }),
);
food
  .command("delete")
  .description("delete one of your custom foods")
  .argument("<id>")
  .action(run(async (id: string) => (await api.deleteCustomFood(id), { ok: true, id })));

// ─── log ─────────────────────────────────────────────────────────────────────

const log = program.command("log").description("add, edit and delete diary entries");
amountOptions(
  log
    .command("add")
    .description("log a food or recipe by id (from `food search` / `recipe list`)")
    .argument("<foodId>")
    .addOption(mealOption())
    .addOption(dateOption()),
).action(
  run(async (foodId: string, o: { meal: string; date: string } & Amount) =>
    api.logFood({ foodId, meal: parseMeal(o.meal), date: o.date, ...amountFrom(o) }),
  ),
);
amountOptions(
  log
    .command("edit")
    .description("change an entry's quantity, unit, meal or date (entry ids come from `day`)")
    .argument("<entryId>")
    .addOption(new Option("-d, --date <date>", "the date the entry is currently on").default("today"))
    .addOption(new Option("-m, --meal <meal>", "move to another meal"))
    .option("--move-to <date>", "move the entry to another date"),
).action(
  run(async (id: string, o: { date: string; meal?: string; moveTo?: string } & Amount) =>
    api.editEntry({
      id,
      date: o.date,
      meal: o.meal ? parseMeal(o.meal) : undefined,
      moveTo: o.moveTo,
      ...amountFrom(o),
    }),
  ),
);
log
  .command("copy")
  .description(
    "copy entries from a past day onto another day, e.g. `log copy --from -2 -m breakfast` " +
      "re-logs the breakfast from 2 days ago today (same foods and amounts)",
  )
  .requiredOption("--from <date>", "day to copy from (YYYY-MM-DD, yesterday, -2, ...)")
  .option("--to <date>", "day to copy to", "today")
  .addOption(new Option("-m, --meal <meal>", "only copy this meal (default: the whole day)"))
  .addOption(new Option("--to-meal <meal>", "put the copies in this meal (default: same meal)"))
  .option("--entry <ids...>", "only copy these entry ids (from `day --date <from>`)")
  .action(
    run(async (o: { from: string; to: string; meal?: string; toMeal?: string; entry?: string[] }) =>
      api.copyEntries({
        from: o.from,
        to: o.to,
        meal: o.meal ? parseMeal(o.meal) : undefined,
        toMeal: o.toMeal ? parseMeal(o.toMeal) : undefined,
        ids: o.entry,
      }),
    ),
  );
log
  .command("delete")
  .description("delete a diary entry")
  .argument("<entryId>")
  .addOption(new Option("-d, --date <date>", "the date the entry is on").default("today"))
  .action(run(async (id: string, o: { date: string }) => ({ deleted: await api.deleteEntry(id, o.date) })));

// ─── recipes ─────────────────────────────────────────────────────────────────

const recipe = program.command("recipe").description("list, inspect, create and delete recipes");
recipe
  .command("list")
  .description("your recipes, optionally filtered by name")
  .argument("[query...]")
  .action(run(async (q: string[]) => api.recipes(q.join(" "))));
recipe
  .command("show")
  .description("recipe details: ingredients, totals and per-serving nutrition")
  .argument("<id>")
  .action(run(async (id: string) => api.recipe(id)));
recipe
  .command("create")
  .description(
    "create a recipe. Each --ingredient is <foodId>[:<amount>[:<unit>]] — without a unit the amount is servings",
  )
  .requiredOption("--name <name>", "recipe name")
  .requiredOption("--servings <n>", "how many servings the recipe makes", number("servings"))
  .requiredOption("-i, --ingredient <spec...>", "ingredient spec, repeatable")
  .option("--brand <brand>", "author / brand label")
  .option("--notes <text>", "notes or instructions")
  .action(
    run(async (o: { name: string; servings: number; ingredient: string[]; brand?: string; notes?: string }) => {
      const ingredients: Ingredient[] = o.ingredient.map((spec) => {
        const [foodId, qty, unit] = spec.split(":");
        const n = qty === undefined ? 1 : number("ingredient amount")(qty);
        return unit ? { foodId: foodId!, amount: n, unit } : { foodId: foodId!, servings: n };
      });
      return api.createRecipe({ ...o, ingredients });
    }),
  );
recipe
  .command("delete")
  .description("delete a recipe")
  .argument("<id>")
  .action(run(async (id: string) => ({ deleted: await api.deleteRecipe(id) })));

// ─── advanced ────────────────────────────────────────────────────────────────

program
  .command("schema")
  .description("re-resolve the Lose It web build and regenerate the RPC schema")
  .action(
    run(async () => {
      const schema = await client.ensureSchema(true);
      return {
        permutation: schema.permutation,
        policyHash: schema.policyHash,
        types: Object.keys(schema.types).length,
        methods: Object.keys(schema.methods).sort(),
      };
    }),
  );
program
  .command("rpc")
  .description("call a raw LoseItRemoteService method (params as a JSON array, token added automatically)")
  .argument("<method>")
  .argument("[params]", "JSON array of primitive params", "[]")
  .action(run(async (method: string, params: string) => client.call(method, JSON.parse(params))));

await program.parseAsync();
