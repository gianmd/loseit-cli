import { GObj, type GVal } from "../gwt/codec.js";
import { LoseItClient, LoseItError } from "./client.js";
import { addDays, isoFromDayNumber, makeDayDate, resolveDate } from "./dates.js";
import {
  MEALS,
  SERVING_UNIT,
  SIG,
  Vocab,
  foodIdentifier,
  hourDate,
  items,
  makePk,
  newPk,
  num,
  nutrientMap,
  obj,
  payload,
  pkHex,
  readEntry,
  readFoodIdentifier,
  readNutrients,
  readServing,
  round,
  scaleServing,
  servingOptions,
  servingSizeFor,
  setEntryContext,
  str,
  timestamp,
  applyCustomFoodEdit,
  type EntryView,
  type FoodEdit,
  type Nutrients,
  type ServingOption,
} from "./model.js";

const LOCALE = "en-US";

export interface DayTotals {
  date: string;
  budget: number;
  food: number;
  exercise: number;
  /** budget - food + exercise, as shown by Lose It ("calories left"). */
  remaining: number;
}

export interface Amount {
  servings?: number | undefined;
  amount?: number | undefined;
  unit?: string | undefined;
}

export interface NewFood {
  name: string;
  brand?: string | undefined;
  nutrients: Nutrients;
  servingAmount?: number | undefined;
  unit?: string | undefined;
}

export interface Ingredient extends Amount {
  foodId: string;
}

/** High-level Lose It operations on top of the raw RPC client. */
export class LoseIt {
  private vocabCache: Vocab | null = null;

  constructor(readonly client: LoseItClient) {}

  get timezone(): string {
    return this.client.config.timezone;
  }

  date(input?: string): string {
    return resolveDate(input, this.timezone);
  }

  private dayDate(iso: string): GObj {
    return makeDayDate(iso, this.client.gmtOffset());
  }

  async vocab(): Promise<Vocab> {
    this.vocabCache ??= new Vocab(await this.client.ensureSchema());
    return this.vocabCache;
  }

  private async rpc(method: string, params: GVal[] = []): Promise<GVal> {
    return payload(await this.client.call(method, params));
  }

  // ─── diary ───────────────────────────────────────────────────────────────

  private async rawDay(date: string): Promise<GObj> {
    return obj(await this.rpc("getDailyDetailsForDate", [this.dayDate(date)]), "DailyDetails");
  }

  private totals(date: string, dailyLog: GVal, fallbackBudget: number, food: number): DayTotals {
    const log = dailyLog instanceof GObj ? dailyLog : null;
    const budget = log ? num(obj(log.f[6] ?? null).f[0] ?? null) : fallbackBudget;
    const foodCals = log ? num(log.f[4] ?? null) : food;
    const exercise = log ? num(log.f[2] ?? null) : 0;
    return {
      date,
      budget: Math.round(budget),
      food: Math.round(foodCals),
      exercise: Math.round(exercise),
      remaining: Math.round(budget - foodCals + exercise),
    };
  }

  async day(input?: string) {
    const date = this.date(input);
    const vocab = await this.vocab();
    const raw = await this.rawDay(date);
    const entries = items(raw.f[5] ?? null).map((e) => readEntry(vocab, e, date));
    const budget = raw.f[2] instanceof GObj ? num(raw.f[2].f[2] ?? null) : 0;
    const totals = this.totals(
      date,
      raw.f[3] ?? null,
      budget,
      entries.reduce((s, e) => s + e.calories, 0),
    );
    const meals = Object.fromEntries(
      MEALS.map((m) => {
        const list = entries.filter((e) => e.meal === m);
        return [m, { calories: list.reduce((s, e) => s + e.calories, 0), entries: list }];
      }),
    );
    const exercise = items(raw.f[4] ?? null).map((x) => {
      const ex = obj(x.f[4] ?? null);
      return {
        name: str(ex.f[4] ?? null),
        type: str(ex.f[5] ?? null),
        caloriesBurned: Math.round(num(x.f[1] ?? null)),
        minutes: num(x.f[9] ?? null),
      };
    });
    return { ...totals, nutrients: sumNutrients(entries), meals, exerciseLog: exercise };
  }

  /** Per-day totals for the `days` days ending on `input` (inclusive). */
  async summary(input?: string, days = 7) {
    const end = this.date(input);
    const start = addDays(end, -(days - 1));
    // getWeeklySummary returns the Monday–Sunday week containing the date.
    const byDate = new Map<string, DayTotals>();
    for (let cursor = end; cursor > addDays(start, -7); cursor = addDays(cursor, -7)) {
      const week = obj(await this.rpc("getWeeklySummary", [this.dayDate(cursor), 1]), "WeeklySummary");
      for (const log of items(week.f[1] ?? null)) {
        const day = isoFromDayNumber(num(obj(log.f[1] ?? null).f[1] ?? null));
        byDate.set(day, this.totals(day, log, 0, 0));
      }
    }
    const out: DayTotals[] = [];
    for (let day = start; day <= end; day = addDays(day, 1)) {
      out.push(byDate.get(day) ?? { date: day, budget: 0, food: 0, exercise: 0, remaining: 0 });
    }
    const rows = out.map((d) => ({ ...d, logged: d.food > 0 }));
    const logged = out.filter((d) => d.food > 0);
    const sum = (k: keyof Omit<DayTotals, "date">) => out.reduce((s, d) => s + d[k], 0);
    return {
      from: out[0]?.date,
      to: end,
      days: rows,
      totals: {
        budget: sum("budget"),
        food: sum("food"),
        exercise: sum("exercise"),
        remaining: sum("remaining"),
        daysLogged: logged.length,
        averageFoodPerLoggedDay: logged.length
          ? Math.round(logged.reduce((s, d) => s + d.food, 0) / logged.length)
          : 0,
      },
    };
  }

  // ─── foods ───────────────────────────────────────────────────────────────

  /**
   * Database search, with foods from the user's recent diary (`historyDays`, 0 = off)
   * listed first and marked `fromHistory`, ahead of new variants from the database.
   */
  async searchFoods(query: string, limit = 20, historyDays = 90) {
    // The server's limit also counts section headers/footers, so over-ask and trim.
    const [res, history] = await Promise.all([
      this.rpc("searchFoods", [query, LOCALE, Math.max(limit + 10, 20), true, true]),
      historyDays > 0 ? this.foodHistory(query, historyDays) : Promise.resolve([]),
    ]);
    const seen = new Set(history.map((h) => h.id));
    const fromHistory = history.map((h) => ({
      id: h.id,
      name: h.name,
      brand: h.brand,
      kind: h.kind,
      fromHistory: true,
      timesLogged: h.timesLogged,
      lastUsed: h.lastUsed,
      usual: h.usual,
    }));
    const fromDatabase = searchResults(obj(res))
      .filter((r) => !seen.has(r.id))
      .map((r) => ({ ...r, fromHistory: false }));
    return [...fromHistory, ...fromDatabase].slice(0, limit);
  }

  /** Every food entry logged between two dates (inclusive), oldest first. */
  private async entriesBetween(from: string, to: string): Promise<EntryView[]> {
    const vocab = await this.vocab();
    const userId = new GObj("java.lang.Integer", [await this.client.userId()]);
    const out: EntryView[] = [];
    // One call returns full DailyDetails for a whole range; chunk very long spans.
    for (let start = from; start <= to; start = addDays(start, 120)) {
      const end = addDays(start, 119) < to ? addDays(start, 119) : to;
      const days = items(
        await this.rpc("getDailyDetailsIncludingPendingForDateRange", [
          userId,
          this.dayDate(start),
          this.dayDate(end),
        ]),
      );
      for (const day of days) {
        for (const entry of items(day.f[5] ?? null)) {
          const dayDate = obj(obj(entry.f[1] ?? null).f[1] ?? null);
          out.push(readEntry(vocab, entry, isoFromDayNumber(num(dayDate.f[1] ?? null))));
        }
      }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Foods from the diary over the last `days` days, grouped by food: how often and how
   * recently each was logged, plus the usual portion and meal. Sorted by last use,
   * then frequency.
   */
  async foodHistory(query?: string, days = 90) {
    const to = this.date();
    const entries = await this.entriesBetween(addDays(to, -(days - 1)), to);
    const groups = new Map<string, EntryView[]>();
    for (const e of entries) groups.set(e.food.id, [...(groups.get(e.food.id) ?? []), e]);

    const history = [...groups.values()].map((list) => {
      const last = list[list.length - 1]!;
      const portion = mostCommon(list, (e) => `${round(e.amount, 2)} ${e.unit}`);
      return {
        id: last.food.id,
        name: last.food.name,
        brand: last.food.brand,
        kind: last.food.category === "Recipe" ? "recipe" : "food",
        timesLogged: list.length,
        lastUsed: last.date,
        usual: {
          amount: round(portion.amount, 2),
          unit: portion.unit,
          servings: round(portion.servings, 2),
          calories: portion.calories,
          meal: mostCommon(list, (e) => e.meal).meal,
        },
      };
    });
    history.sort((a, b) => b.lastUsed.localeCompare(a.lastUsed) || b.timesLogged - a.timesLogged);
    return filterByName(history, query);
  }

  async myFoods(query?: string) {
    return filterByName(searchResults(obj(await this.rpc("getMyFoodsSearchResults"))), query);
  }

  /**
   * Database or custom food as `[FoodIdentifier, FoodNutrients, FoodServingSize[]]`
   * (the FoodForFoodDatabase layout). Returns null for recipes.
   */
  private async rawFood(id: string): Promise<GObj | null> {
    const res = await this.rpc("getFood", [makePk(id), LOCALE]);
    if (res instanceof GObj) {
      await this.ensureFoodName(obj(res.f[0] ?? null));
      return res;
    }
    // getFood doesn't resolve freshly created custom foods; fall back to the list.
    const custom = items(await this.rpc("getCustomFoods")).find(
      (cf) => pkHex(cf.f[12] ?? null) === id.toLowerCase(),
    );
    if (!custom) return null;
    const serving = obj(custom.f[5] ?? null);
    return new GObj("FoodForFoodDatabase", [
      custom.f[4] ?? null,
      serving.f[0] ?? null,
      new GObj("FoodServingSize[]", [[serving.f[1] ?? null]]),
    ]);
  }

  /**
   * Some database records have lost their name (FoodIdentifier name = null) while
   * the diary and search index still show it. The server rejects entries without a
   * name ("Non rollback error"), so recover it from the most recent diary entry.
   */
  private async ensureFoodName(ident: GObj, override?: string): Promise<void> {
    if (override) {
      ident.f[3] = override;
      return;
    }
    if (str(ident.f[3] ?? null)) return;
    const id = pkHex(ident.f[9] ?? null);
    const to = this.date();
    const past = await this.entriesBetween(addDays(to, -364), to);
    const name = past.reverse().find((e) => e.food.id === id && e.food.name)?.food.name;
    if (name) ident.f[3] = name;
  }

  async food(id: string) {
    const vocab = await this.vocab();
    const raw = await this.rawFood(id);
    if (!raw) {
      const recipe = await this.recipe(id).catch(() => null);
      if (recipe) return { ...recipe, kind: "recipe" as const };
      throw new LoseItError(`food ${id} not found`, "not_found");
    }
    const nutr = obj(raw.f[1] ?? null);
    const sizes = items(raw.f[2] ?? null);
    return {
      kind: "food" as const,
      ...readFoodIdentifier(obj(raw.f[0] ?? null)),
      nutrientsPerServing: readNutrients(vocab, nutr, 1 / (num(nutr.f[1] ?? null) || 1)),
      servingOptions: servingOptions(vocab, sizes).map(({ raw: _raw, ...o }) => o),
    };
  }

  /** Resolve a requested amount into (servings, FoodServingSize option). */
  private pickServing(options: ServingOption[], fallback: GObj, want: Amount, vocab: Vocab) {
    if (want.unit) {
      const unit = vocab.unitName(vocab.unitOrdinal(want.unit));
      const option = options.find((o) => o.unit === unit);
      if (!option) {
        throw new LoseItError(
          `unit "${want.unit}" not available; options: ${options.map((o) => o.unit).join(", ") || "Serving"}`,
          "bad_unit",
        );
      }
      const amount = want.amount ?? option.perServing;
      return { servings: amount / option.perServing, size: option.raw };
    }
    const option = options.find((o) => o.isDefault) ?? options[0];
    const servings = want.servings ?? 1;
    if (!option) return { servings, size: fallback };
    return {
      servings: option.unit === SERVING_UNIT ? servings / option.perServing : servings,
      size: option.raw,
    };
  }

  async logFood(
    opts: { foodId: string; meal: number; date?: string | undefined; name?: string | undefined } & Amount,
  ): Promise<EntryView> {
    const vocab = await this.vocab();
    const date = this.date(opts.date);
    const raw = await this.rawFood(opts.foodId);
    const name =
      opts.name ??
      (raw ? (str(obj(raw.f[0] ?? null).f[3] ?? null) ?? "") : await this.recipeName(opts.foodId));
    if (!name) {
      throw new LoseItError(
        `food ${opts.foodId} has no name in Lose It's database and none was found in your diary; pass --name`,
        "unnamed_food",
      );
    }
    const entry = obj(
      await this.rpc("getUnsavedFoodLogEntry", [makePk(opts.foodId), LOCALE, name]),
      "FoodLogEntry",
    );
    await this.ensureFoodName(obj(entry.f[0] ?? null), name);
    const serving = obj(entry.f[2] ?? null);
    const unsavedSize = obj(serving.f[1] ?? null);
    const options = raw ? servingOptions(vocab, items(raw.f[2] ?? null)) : servingOptions(vocab, [unsavedSize]);
    const pick = this.pickServing(options, unsavedSize, opts, vocab);

    const nutr = obj(serving.f[0] ?? null);
    nutr.f[1] = (num(nutr.f[1] ?? null) * pick.servings) / (num(unsavedSize.f[0] ?? null) || 1);
    serving.f[1] = servingSizeFor(pick.size, pick.servings);
    setEntryContext(entry, this.dayDate(date), opts.meal);
    const ctx = obj(entry.f[1] ?? null);
    ctx.f[3] = -1;
    ctx.f[4] = -1;

    await this.rpc("updateFoodLogEntry", [entry]);
    return readEntry(vocab, entry, date);
  }

  /**
   * Copy entries from one day onto another (e.g. "same breakfast as 2 days ago").
   * Copies everything on `from` unless narrowed by `meal` or `ids`; each copy keeps
   * its food, amount and nutrients, lands in `toMeal` (default: its original meal)
   * and gets a fresh entry id.
   */
  async copyEntries(opts: {
    from: string;
    to?: string | undefined;
    meal?: number | undefined;
    toMeal?: number | undefined;
    ids?: string[] | undefined;
  }): Promise<{ from: string; to: string; copied: EntryView[] }> {
    const vocab = await this.vocab();
    const from = this.date(opts.from);
    const to = this.date(opts.to);
    const wanted = opts.ids?.map((id) => id.toLowerCase());
    const source = items((await this.rawDay(from)).f[5] ?? null).filter((e) => {
      const ctx = obj(e.f[1] ?? null);
      if (opts.meal !== undefined && num(ctx.f[8] ?? null) !== opts.meal) return false;
      return !wanted || wanted.includes(pkHex(e.f[6] ?? null));
    });
    if (source.length === 0) {
      const what = opts.meal !== undefined ? `${MEALS[opts.meal]} entries` : "matching entries";
      throw new LoseItError(`no ${what} on ${from}`, "not_found");
    }

    const copied: EntryView[] = [];
    for (const entry of source) {
      const ctx = obj(entry.f[1] ?? null);
      setEntryContext(entry, this.dayDate(to), opts.toMeal ?? num(ctx.f[8] ?? null));
      ctx.f[0] = null; // creation timestamp: let the server assign it
      ctx.f[3] = -1;
      ctx.f[4] = -1;
      entry.f[4] = -1n;
      entry.f[5] = BigInt(Date.now());
      entry.f[6] = newPk();
      await this.rpc("updateFoodLogEntry", [entry]);
      copied.push(readEntry(vocab, entry, to));
    }
    return { from, to, copied };
  }

  private async findEntry(id: string, date: string): Promise<GObj> {
    const raw = await this.rawDay(date);
    const entry = items(raw.f[5] ?? null).find((e) => pkHex(e.f[6] ?? null) === id.toLowerCase());
    if (!entry) throw new LoseItError(`entry ${id} not found on ${date}`, "not_found");
    return entry;
  }

  async editEntry(opts: {
    id: string;
    date?: string | undefined;
    meal?: number | undefined;
    moveTo?: string | undefined;
  } & Amount): Promise<EntryView> {
    const vocab = await this.vocab();
    const date = this.date(opts.date);
    const entry = await this.findEntry(opts.id, date);
    const serving = obj(entry.f[2] ?? null);
    const size = obj(serving.f[1] ?? null);

    if (opts.unit) {
      const raw = await this.rawFood(readFoodIdentifier(obj(entry.f[0] ?? null)).id);
      if (!raw) throw new LoseItError("changing the unit is only supported for database/custom foods", "bad_unit");
      const pick = this.pickServing(servingOptions(vocab, items(raw.f[2] ?? null)), size, opts, vocab);
      scaleServing(serving, pick.servings / (num(size.f[0] ?? null) || 1));
      serving.f[1] = servingSizeFor(pick.size, pick.servings);
    } else if (opts.servings !== undefined) {
      const current = readServing(vocab, serving).servings;
      scaleServing(serving, opts.servings / (current || 1));
    } else if (opts.amount !== undefined) {
      scaleServing(serving, opts.amount / (num(size.f[5] ?? null) || 1));
    }
    const ctx = obj(entry.f[1] ?? null);
    const meal = opts.meal ?? num(ctx.f[8] ?? null);
    const newDate = opts.moveTo ? this.date(opts.moveTo) : date;
    if (newDate === date) {
      setEntryContext(entry, obj(ctx.f[1] ?? null), meal);
      await this.rpc("updateFoodLogEntry", [entry]);
      return readEntry(vocab, entry, date);
    }

    // The server keys entries per day: saving with another date adds a copy and
    // leaves the original. Move = save a copy (fresh id) on the new day, then
    // delete the original.
    const original = await this.findEntry(opts.id, date);
    entry.f[6] = newPk();
    setEntryContext(entry, this.dayDate(newDate), meal);
    await this.rpc("updateFoodLogEntry", [entry]);
    await this.rpc("deleteFoodLogEntry", [original]);
    return readEntry(vocab, entry, newDate);
  }

  async deleteEntry(id: string, dateInput?: string): Promise<EntryView> {
    const vocab = await this.vocab();
    const date = this.date(dateInput);
    const entry = await this.findEntry(id, date);
    await this.rpc("deleteFoodLogEntry", [entry]);
    return readEntry(vocab, entry, date);
  }

  // ─── custom foods ────────────────────────────────────────────────────────

  private async foodServing(food: NewFood): Promise<GObj> {
    const vocab = await this.vocab();
    const amount = food.servingAmount ?? 1;
    return new GObj(SIG.foodServing, [
      new GObj(SIG.foodNutrients, [1, 1, nutrientMap(vocab, food.nutrients)]),
      new GObj(SIG.servingSize, [
        1,
        true,
        new GObj(SIG.foodMeasure, [vocab.unitOrdinal(food.unit ?? "Serving")]),
        1,
        amount,
        amount,
      ]),
    ]);
  }

  /** Create a reusable custom food. With `log`, also log one serving of it (as the web app does). */
  async createFood(food: NewFood, log?: { meal: number; date?: string | undefined }) {
    const pk = newPk();
    const ident = foodIdentifier({ name: food.name, brand: food.brand ?? "", pk });
    const serving = await this.foodServing(food);
    const now = BigInt(Date.now());

    if (log) {
      const date = this.date(log.date);
      const entry = new GObj(SIG.foodLogEntry, [
        ident,
        new GObj(SIG.context, [
          null, this.dayDate(date), false, -1, 0, false, null, null,
          new GObj(SIG.mealType, [log.meal]),
          new GObj(SIG.mealTypeExtra, [3]),
        ]),
        serving,
        false,
        -1n,
        now,
        newPk(),
      ]);
      await this.rpc("saveCustomFoodLogEntry", [entry, LOCALE, false, false]);
      return { id: pkHex(pk), entry: readEntry(await this.vocab(), entry, date) };
    }

    const custom = new GObj(SIG.customFood, [
      true, false, 1, -1, ident, serving, hourDate(this.client.gmtOffset()),
      false, 0, true, true, now, pk,
    ]);
    await this.rpc("saveCustomFood", [custom, LOCALE, false, false]);
    return { id: pkHex(pk), entry: null };
  }

  async customFoods(query?: string) {
    const vocab = await this.vocab();
    const list = items(await this.rpc("getCustomFoods")).map((cf) => ({
      ...readFoodIdentifier(obj(cf.f[4] ?? null)),
      perServing: readServing(vocab, obj(cf.f[5] ?? null)),
    }));
    return filterByName(list, query);
  }

  /**
   * Edit one of the user's custom foods, changing only the given fields.
   *
   * Lose It has no update RPC: saveCustomFood always stores the food under a new
   * primary key. With the first flag false it replaces the original (old id removed),
   * with it true it keeps the original and adds a copy. So an edit is a server-side
   * delete + recreate that keeps every other field (serving, icon, ...) but changes
   * the id; the result reports the new id and the diary entries still using the old one.
   */
  async editCustomFood(id: string, edit: FoodEdit, historyDays = 90) {
    const vocab = await this.vocab();
    const key = id.toLowerCase();
    const before = items(await this.rpc("getCustomFoods"));
    const food = before.find((cf) => pkHex(cf.f[12] ?? null) === key);
    if (!food) {
      if ((await this.recipes()).some((r) => r.id === key)) {
        throw new LoseItError(`${id} is a recipe, not a custom food; recipes can't be edited with food edit`, "not_custom");
      }
      if (await this.rawFood(key)) {
        throw new LoseItError(
          `${id} is a Lose It database food, not one of your custom foods. Database foods can't be edited; ` +
            "create a custom copy with `loseit food create` (see `loseit food show` for its current values) instead",
          "not_custom",
        );
      }
      throw new LoseItError(`food ${id} not found`, "not_found");
    }
    const updated = applyCustomFoodEdit(vocab, food, edit);
    if (updated.length === 0) throw new LoseItError("nothing to change: pass at least one field", "bad_input");
    const name = str(obj(food.f[4] ?? null).f[3] ?? null);

    const known = new Set(before.map((cf) => pkHex(cf.f[12] ?? null)));
    await this.rpc("saveCustomFood", [food, LOCALE, false, false]);
    const after = items(await this.rpc("getCustomFoods"));
    const oldKept = after.some((cf) => pkHex(cf.f[12] ?? null) === key);
    const created = after.filter(
      (cf) => !known.has(pkHex(cf.f[12] ?? null)) && str(obj(cf.f[4] ?? null).f[3] ?? null) === name,
    );
    if (created.length > 1 || (created.length === 0 && !oldKept)) {
      throw new LoseItError(
        `saved, but could not identify the edited food (${created.length} new custom foods named "${name}"); ` +
          `check \`loseit food mine "${name}" --custom\``,
        "verify_failed",
      );
    }
    const newId = created.length === 1 ? pkHex(created[0]!.f[12] ?? null) : key;

    const shown = await this.food(newId);
    const perServing = shown.kind === "food" ? shown.nutrientsPerServing : {};
    const mismatched = Object.entries(edit.nutrients ?? {})
      .filter(([k, v]) => Math.abs((perServing[k] ?? NaN) - v) > 0.01)
      .map(([k]) => k);
    if (mismatched.length > 0) {
      throw new LoseItError(
        `saved as ${newId}, but food show does not reflect ${mismatched.join(", ")}`,
        "verify_failed",
      );
    }

    const idChanged = newId !== key;
    const result = { id: newId, previousId: key, idChanged, updated, food: shown };
    if (!idChanged) return result;
    const to = this.date();
    const stale = (await this.entriesBetween(addDays(to, -(historyDays - 1)), to))
      .filter((e) => e.food.id === key)
      .map((e) => ({ id: e.id, date: e.date, meal: e.meal, calories: e.calories }));
    return {
      ...result,
      warning:
        `The food id changed from ${key} to ${newId}: Lose It can't update a custom food in place, so it ` +
        `was deleted and recreated with the same name and serving. Diary entries logged with the old id keep ` +
        `the old nutrients; re-log them with the new id (log delete, then log add ${newId}) to use the edited values.`,
      entriesWithOldId: stale,
    };
  }

  async deleteCustomFood(id: string) {
    await this.rpc("removeCustomFood", [new GObj(SIG.pkArray, [[makePk(id)]])]);
  }

  // ─── recipes ─────────────────────────────────────────────────────────────

  async recipes(query?: string) {
    return filterByName(searchResults(obj(await this.rpc("getRecipesSearchResults"))), query);
  }

  private async rawRecipes(): Promise<GObj[]> {
    return items(await this.rpc("getRecipes"));
  }

  private async recipeName(id: string): Promise<string> {
    const hit = (await this.recipes()).find((r) => r.id === id.toLowerCase());
    if (!hit) throw new LoseItError(`food or recipe ${id} not found`, "not_found");
    return hit.name;
  }

  private viewRecipe(vocab: Vocab, r: GObj) {
    const active = obj(r.f[0] ?? null);
    const whole = readServing(vocab, obj(active.f[2] ?? null));
    const yieldQty = num(r.f[4] ?? null) || 1;
    return {
      ...readFoodIdentifier(obj(active.f[1] ?? null)),
      brand: str(r.f[1] ?? null),
      notes: str(r.f[8] ?? null),
      yield: { amount: yieldQty, unit: vocab.unitName(num(r.f[11] ?? null)) },
      total: { calories: whole.calories, nutrients: whole.nutrients },
      perServing: {
        calories: Math.round(whole.calories / yieldQty),
        nutrients: Object.fromEntries(
          Object.entries(whole.nutrients).map(([k, v]) => [k, round(v / yieldQty)]),
        ),
      },
      ingredients: items(r.f[6] ?? null).map((ing) => ({
        ...readFoodIdentifier(obj(ing.f[1] ?? null)),
        ...readServing(vocab, obj(ing.f[2] ?? null)),
      })),
    };
  }

  async recipe(id: string) {
    const vocab = await this.vocab();
    const r = (await this.rawRecipes()).find((x) => pkHex(x.f[14] ?? null) === id.toLowerCase());
    if (!r) throw new LoseItError(`recipe ${id} not found`, "not_found");
    return this.viewRecipe(vocab, r);
  }

  async createRecipe(opts: {
    name: string;
    brand?: string | undefined;
    notes?: string | undefined;
    servings: number;
    ingredients: Ingredient[];
  }) {
    if (opts.ingredients.length === 0) throw new LoseItError("a recipe needs ingredients", "bad_input");
    const vocab = await this.vocab();
    const recipePk = newPk();
    const now = BigInt(Date.now());

    const ingredients: GObj[] = [];
    const totals = new Map<number, number>();
    for (const [i, ing] of opts.ingredients.entries()) {
      const raw = await this.rawFood(ing.foodId);
      if (!raw) throw new LoseItError(`ingredient ${ing.foodId} must be a database or custom food`, "bad_input");
      const ident = obj(raw.f[0] ?? null);
      const nutr = obj(raw.f[1] ?? null);
      const sizes = items(raw.f[2] ?? null);
      const pick = this.pickServing(servingOptions(vocab, sizes), sizes[0]!, ing, vocab);
      const factor = pick.servings / (num(nutr.f[1] ?? null) || 1);
      const pairs = (obj(nutr.f[2] ?? null).f[0] as [GVal, GVal][]).map(([k, v]): [GVal, GVal] => {
        const value = num(v) * factor;
        totals.set(num(k), (totals.get(num(k)) ?? 0) + value);
        return [k, new GObj(SIG.double, [value])];
      });
      const size = servingSizeFor(pick.size, pick.servings);
      ingredients.push(
        new GObj(SIG.ingredient, [
          false,
          ident,
          new GObj(SIG.foodServing, [
            new GObj(SIG.foodNutrients, [pick.servings, pick.servings, new GObj(SIG.hashMap, [pairs])]),
            size,
          ]),
          i + 1,
          false,
          -1,
          recipePk,
          now,
          newPk(),
        ]),
      );
    }

    const existing = await this.rawRecipes();
    const productId =
      Math.max(5000000, ...existing.map((r) => num(obj(r.f[0] ?? null).f[0] ?? null))) + 1;
    const servingUnit = new GObj(SIG.foodMeasure, [vocab.unitOrdinal("Serving")]);
    const totalMap = new GObj(SIG.hashMap, [
      [...totals].map(([k, v]): [GVal, GVal] => [new GObj(SIG.measurement, [k]), new GObj(SIG.double, [v])]),
    ]);
    const active = new GObj(SIG.activeFood, [
      productId,
      foodIdentifier({ productId, category: "Recipe", name: opts.name, pk: recipePk }),
      new GObj(SIG.foodServing, [
        new GObj(SIG.foodNutrients, [1, 1, totalMap]),
        new GObj(SIG.servingSize, [1, true, servingUnit, 1, opts.servings, opts.servings]),
      ]),
      hourDate(this.client.gmtOffset()),
      false,
      ingredients.length,
      true,
      true,
      now,
      recipePk,
    ]);
    const recipe = new GObj(SIG.recipe, [
      active,
      opts.brand ?? null,
      timestamp(),
      false,
      opts.servings,
      null,
      new GObj(SIG.ingredientArray, [ingredients]),
      true,
      opts.notes ?? null,
      null,
      null,
      servingUnit,
      true,
      now,
      recipePk,
    ]);
    await this.rpc("saveRecipe", [recipe]);
    return this.viewRecipe(vocab, recipe);
  }

  async deleteRecipe(id: string) {
    const r = (await this.rawRecipes()).find((x) => pkHex(x.f[14] ?? null) === id.toLowerCase());
    if (!r) throw new LoseItError(`recipe ${id} not found`, "not_found");
    await this.rpc("removeRecipe", [new GObj(SIG.recipeArray, [[r]])]);
    return { id: id.toLowerCase(), name: str(obj(obj(r.f[0] ?? null).f[1] ?? null).f[3] ?? null) };
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────

function sumNutrients(entries: EntryView[]): Nutrients {
  const out: Nutrients = {};
  for (const e of entries) {
    for (const [k, v] of Object.entries(e.nutrients)) out[k] = round((out[k] ?? 0) + v);
  }
  return out;
}

/** The most frequent item by `key`; ties go to the most recent (lists are oldest first). */
function mostCommon<T>(list: T[], key: (item: T) => string): T {
  const counts = new Map<string, { n: number; latest: T }>();
  for (const item of list) {
    const k = key(item);
    counts.set(k, { n: (counts.get(k)?.n ?? 0) + 1, latest: item });
  }
  let best: { n: number; latest: T } | undefined;
  for (const c of counts.values()) if (!best || c.n >= best.n) best = c;
  return best!.latest;
}

const RESULT_KIND: Record<number, string> = { 1: "food", 12: "recipe" };

function searchResults(res: GObj) {
  let section = "";
  const out: { id: string; name: string; brand: string | null; kind: string; verified: boolean; section: string }[] = [];
  for (const item of items(res.f[0] ?? null)) {
    if (item.type === "SearchResultHeader") section = str(item.f[3] ?? null) ?? "";
    if (item.type !== "SearchResultFood") continue;
    out.push({
      id: pkHex(item.f[0] ?? null),
      name: (str(item.f[3] ?? null) ?? "").trim(),
      brand: (str(item.f[4] ?? null) ?? "").trim() || null,
      kind: RESULT_KIND[num(item.f[6] ?? null)] ?? "food",
      verified: item.f[5] instanceof GObj,
      section,
    });
  }
  return out;
}

function filterByName<T extends { name: string; brand?: string | null }>(list: T[], query?: string): T[] {
  if (!query) return list;
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter((x) => {
    const hay = `${x.name} ${x.brand ?? ""}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}
