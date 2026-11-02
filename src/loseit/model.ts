/**
 * Typed views over decoded Lose It objects. Field positions are wire order as
 * extracted from the build (see gwt/schema.ts) and were mapped against live
 * data and captured web-app traffic.
 */

import { randomUUID } from "node:crypto";

import { GObj, resolveSig, type GVal } from "../gwt/codec.js";
import type { GwtSchema } from "../gwt/schema.js";

/** Class names; the writer resolves them to the build's `Name/CRC` signatures. */
export const SIG = {
  pk: "com.loseit.core.client.model.SimplePrimaryKey",
  bytes: "[B",
  double: "java.lang.Double",
  date: "java.util.Date",
  timestamp: "java.sql.Timestamp",
  hourDate: "com.loseit.core.client.model.HourDate",
  foodIdentifier: "com.loseit.core.client.model.FoodIdentifier",
  productType: "com.loseit.core.client.model.interfaces.FoodProductType",
  foodServing: "com.loseit.core.client.model.FoodServing",
  foodNutrients: "com.loseit.core.client.model.FoodNutrients",
  servingSize: "com.loseit.core.client.model.FoodServingSize",
  foodMeasure: "com.loseit.core.client.model.FoodMeasure",
  measurement: "com.loseit.healthdata.model.shared.food.FoodMeasurement",
  hashMap: "java.util.HashMap",
  mealType: "com.loseit.core.client.model.interfaces.FoodLogEntryType",
  mealTypeExtra: "com.loseit.core.client.model.interfaces.FoodLogEntryTypeExtra",
  foodLogEntry: "com.loseit.core.client.model.FoodLogEntry",
  context: "com.loseit.core.client.model.FoodLogEntryContext",
  customFood: "com.loseit.core.client.model.CustomFood",
  activeFood: "com.loseit.core.client.model.ActiveFood",
  recipe: "com.loseit.core.client.model.Recipe",
  recipeArray: "[Lcom.loseit.core.client.model.Recipe;",
  ingredient: "com.loseit.core.client.model.RecipeIngredient",
  ingredientArray: "[Lcom.loseit.core.client.model.RecipeIngredient;",
  pkArray: "[Lcom.loseit.core.client.model.interfaces.IPrimaryKey;",
  iPrimaryKey: "com.loseit.core.client.model.interfaces.IPrimaryKey",
} as const;

export const MEALS = ["breakfast", "lunch", "dinner", "snacks"] as const;
export type Meal = (typeof MEALS)[number];

export function parseMeal(input: string): number {
  const key = input.toLowerCase().replace(/s$/, "");
  const idx = MEALS.findIndex((m) => m.replace(/s$/, "") === key);
  if (idx < 0) throw new Error(`invalid meal "${input}" (use ${MEALS.join(", ")})`);
  return idx;
}

// ─── generic helpers ───────────────────────────────────────────────────────

export function obj(v: GVal, what = "object"): GObj {
  if (!(v instanceof GObj)) throw new Error(`expected ${what}, got ${String(v)}`);
  return v;
}

export function num(v: GVal): number {
  if (v instanceof GObj) return num(v.f[0] ?? null);
  if (typeof v === "bigint") return Number(v);
  return typeof v === "number" ? v : 0;
}

export function str(v: GVal): string | null {
  return typeof v === "string" ? v : null;
}

/** Unwrap a LoseItRemoteServiceResponse to its payload. */
export function payload(v: GVal): GVal {
  return v instanceof GObj && v.type === "LoseItRemoteServiceResponse" ? (v.f[3] ?? null) : v;
}

/** Items of an ArrayList / object array. */
export function items(v: GVal): GObj[] {
  if (!(v instanceof GObj)) return [];
  const list = v.f[0];
  return Array.isArray(list) ? (list as GVal[]).filter((x): x is GObj => x instanceof GObj) : [];
}

// ─── primary keys ──────────────────────────────────────────────────────────

export function pkHex(v: GVal): string {
  const bytes = obj(obj(v, "primary key").f[0] ?? null, "byte array").f[0] as number[];
  return Buffer.from(bytes.map((b) => b & 0xff)).toString("hex");
}

export function makePk(hex: string): GObj {
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`invalid id "${hex}" (expected 32 hex chars)`);
  const bytes = [...Buffer.from(hex, "hex")].map((b) => (b > 127 ? b - 256 : b));
  return new GObj(SIG.pk, [new GObj(SIG.bytes, [bytes])]);
}

/** Lose It primary keys are random UUIDv4 bytes. */
export function newPk(): GObj {
  return makePk(randomUUID().replace(/-/g, ""));
}

// ─── time values ───────────────────────────────────────────────────────────

export function timestamp(ms = Date.now()): GObj {
  return new GObj(SIG.timestamp, [BigInt(ms), 0]);
}

/** HourDate counts hours since 2001-01-01 00:00 in the user's standard offset. */
export function hourDate(gmt: number, ms = Date.now()): GObj {
  const base = Date.UTC(2001, 0, 1) - gmt * 3_600_000;
  return new GObj(SIG.hourDate, [
    new GObj(SIG.date, [BigInt(ms)]),
    Math.floor((ms - base) / 3_600_000),
  ]);
}

// ─── nutrients ─────────────────────────────────────────────────────────────

/** FoodMeasurement name → friendly key. Volume/Weight describe the serving, not nutrients. */
function nutrientKey(name: string): string {
  if (name === "Energy") return "calories";
  if (name === "Carbohydrate") return "carbs";
  return name.charAt(0).toLowerCase() + name.slice(1);
}

export class Vocab {
  readonly measurements: string[];
  readonly units: string[];

  constructor(schema: GwtSchema) {
    const names = (cls: string) =>
      (schema.types[resolveSig(schema, cls)]?.names ?? []).map((n) => n ?? "");
    this.measurements = names(SIG.measurement);
    this.units = names(SIG.foodMeasure);
  }

  nutrientKey(ordinal: number): string {
    return nutrientKey(this.measurements[ordinal] ?? `nutrient${ordinal}`);
  }

  nutrientOrdinal(key: string): number {
    const idx = this.measurements.findIndex((n) => nutrientKey(n) === key);
    if (idx < 0) throw new Error(`unknown nutrient "${key}"`);
    return idx;
  }

  unitName(ordinal: number): string {
    return this.units[ordinal] ?? `unit${ordinal}`;
  }

  unitOrdinal(input: string): number {
    const alias: Record<string, string> = {
      g: "Gram", gram: "Gram", grams: "Gram", kg: "Kilogram", mg: "Milligram",
      oz: "Ounce", lb: "Pound", lbs: "Pound", ml: "Milliliter", l: "Liter",
      floz: "FluidOunce", "fl-oz": "FluidOunce", tsp: "Teaspoon", tbsp: "Tablespoon",
      cup: "Cup", cups: "Cup", each: "Each", piece: "Piece", slice: "Slice",
      serving: "Serving", servings: "Serving",
    };
    const name = alias[input.toLowerCase()] ?? input;
    const idx = this.units.findIndex((u) => u.toLowerCase() === name.toLowerCase());
    if (idx < 0) throw new Error(`unknown unit "${input}"`);
    return idx;
  }
}

export type Nutrients = Record<string, number>;

const SERVING_METRICS = new Set(["volume", "weight"]);

/** Read a FoodNutrients map (scaled by `factor`) into friendly keys. */
export function readNutrients(vocab: Vocab, foodNutrients: GObj, factor = 1): Nutrients {
  const out: Nutrients = {};
  const pairs = obj(foodNutrients.f[2] ?? null, "nutrient map").f[0] as [GVal, GVal][];
  for (const [k, v] of pairs) {
    const key = vocab.nutrientKey(num(k));
    if (SERVING_METRICS.has(key)) continue;
    out[key] = round(num(v) * factor);
  }
  return out;
}

export function nutrientMap(vocab: Vocab, nutrients: Nutrients, factor = 1): GObj {
  const pairs: [GVal, GVal][] = Object.entries(nutrients).map(([k, v]) => [
    new GObj(SIG.measurement, [vocab.nutrientOrdinal(k)]),
    new GObj(SIG.double, [v * factor]),
  ]);
  return new GObj(SIG.hashMap, [pairs]);
}

export interface FoodEdit {
  name?: string | undefined;
  brand?: string | undefined;
  /** Per-serving values to set; nutrients not listed keep their current value. */
  nutrients?: Nutrients | undefined;
}

/**
 * Apply an edit to a CustomFood in place, touching only the given fields.
 * Returns the names of the fields that were set.
 */
export function applyCustomFoodEdit(vocab: Vocab, food: GObj, edit: FoodEdit, now = Date.now()): string[] {
  const ident = obj(food.f[4] ?? null, "FoodIdentifier");
  const nutr = obj(obj(food.f[5] ?? null, "FoodServing").f[0] ?? null, "FoodNutrients");
  const changed: string[] = [];
  if (edit.name !== undefined) {
    ident.f[3] = edit.name;
    changed.push("name");
  }
  if (edit.brand !== undefined) {
    ident.f[4] = edit.brand;
    changed.push("brand");
  }
  // The map holds values for `base`; one serving is qty/base of it.
  const toStored = (num(nutr.f[0] ?? null) || 1) / (num(nutr.f[1] ?? null) || 1);
  const pairs = obj(nutr.f[2] ?? null, "nutrient map").f[0] as [GVal, GVal][];
  for (const [key, value] of Object.entries(edit.nutrients ?? {})) {
    const ordinal = vocab.nutrientOrdinal(key);
    // Always a fresh Double: decoded maps can share one instance between equal values.
    const stored = new GObj(SIG.double, [value * toStored]);
    const pair = pairs.find(([k]) => num(k) === ordinal);
    if (pair) pair[1] = stored;
    else pairs.push([new GObj(SIG.measurement, [ordinal]), stored]);
    changed.push(key);
  }
  if (changed.length > 0) {
    ident.f[8] = BigInt(now);
    food.f[11] = BigInt(now);
  }
  return changed;
}

export function round(n: number, digits = 2): number {
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

// ─── food servings ─────────────────────────────────────────────────────────

/**
 * FoodServing = { FoodNutrients{ baseQty, qty, map }, FoodServingSize }.
 * The map holds nutrients for `baseQty`; the logged amount is qty/baseQty of it.
 * FoodServingSize = { servings, isDefault, unit, baseServings, baseAmount, amount }.
 */
/**
 * When an entry is measured in the "Serving" unit, a user's "servings" means
 * that unit (a recipe's base quantity can be the whole batch, e.g. 1 = 4 Servings).
 */
export const SERVING_UNIT = "Serving";

export interface ServingView {
  servings: number;
  amount: number;
  unit: string;
  calories: number;
  nutrients: Nutrients;
}

export function readServing(vocab: Vocab, foodServing: GObj): ServingView {
  const nutr = obj(foodServing.f[0] ?? null, "FoodNutrients");
  const size = obj(foodServing.f[1] ?? null, "FoodServingSize");
  const base = num(nutr.f[0] ?? null) || 1;
  const nutrients = readNutrients(vocab, nutr, num(nutr.f[1] ?? null) / base);
  const unit = vocab.unitName(num(size.f[2] ?? null));
  const amount = round(num(size.f[5] ?? null), 4);
  return {
    servings: unit === SERVING_UNIT ? amount : round(num(size.f[0] ?? null), 4),
    amount,
    unit,
    calories: Math.round(nutrients.calories ?? 0),
    nutrients,
  };
}

/** Scale a FoodServing's logged quantity in place by `k` (as the web app does). */
export function scaleServing(foodServing: GObj, k: number): void {
  const nutr = obj(foodServing.f[0] ?? null);
  const size = obj(foodServing.f[1] ?? null);
  nutr.f[1] = num(nutr.f[1] ?? null) * k;
  size.f[0] = num(size.f[0] ?? null) * k;
  size.f[5] = num(size.f[5] ?? null) * k;
}

export interface ServingOption {
  unit: string;
  /** Amount of `unit` in one serving of the food. */
  perServing: number;
  isDefault: boolean;
  raw: GObj;
}

export function servingOptions(vocab: Vocab, sizes: GObj[]): ServingOption[] {
  return sizes.map((s) => ({
    unit: vocab.unitName(num(s.f[2] ?? null)),
    perServing: round(num(s.f[4] ?? null) / (num(s.f[3] ?? null) || 1), 4),
    isDefault: s.f[1] === true,
    raw: s,
  }));
}

/** A FoodServingSize for `servings` servings expressed in `option`'s unit. */
export function servingSizeFor(option: GObj, servings: number): GObj {
  const base = num(option.f[3] ?? null) || 1;
  const baseAmount = num(option.f[4] ?? null);
  return new GObj(SIG.servingSize, [
    servings,
    option.f[1] ?? false,
    option.f[2] ?? null,
    base,
    baseAmount,
    (baseAmount * servings) / base,
  ]);
}

// ─── food identifiers ──────────────────────────────────────────────────────

export interface FoodRef {
  id: string;
  name: string;
  brand: string | null;
  category: string | null;
}

export function readFoodIdentifier(fi: GObj): FoodRef {
  return {
    id: pkHex(fi.f[9] ?? null),
    name: str(fi.f[3] ?? null) ?? "",
    brand: str(fi.f[4] ?? null) || null,
    category: str(fi.f[1] ?? null),
  };
}

export function foodIdentifier(opts: {
  productId?: number;
  name: string;
  brand?: string;
  category?: string;
  pk: GObj;
}): GObj {
  return new GObj(SIG.foodIdentifier, [
    opts.productId ?? -1,
    opts.category ?? "Default",
    null,
    opts.name,
    opts.brand ?? "",
    new GObj(SIG.productType, [0]),
    -1,
    null,
    BigInt(Date.now()),
    opts.pk,
  ]);
}

// ─── food log entries ──────────────────────────────────────────────────────

export interface EntryView extends ServingView {
  id: string;
  date: string;
  meal: Meal;
  food: FoodRef;
}

export function readEntry(vocab: Vocab, entry: GObj, date: string): EntryView {
  const ctx = obj(entry.f[1] ?? null, "FoodLogEntryContext");
  const meal = MEALS[num(ctx.f[8] ?? null)] ?? "snacks";
  return {
    id: pkHex(entry.f[6] ?? null),
    date,
    meal,
    food: readFoodIdentifier(obj(entry.f[0] ?? null)),
    ...readServing(vocab, obj(entry.f[2] ?? null)),
  };
}

export function setEntryContext(entry: GObj, dayDate: GObj, meal: number): void {
  const ctx = obj(entry.f[1] ?? null, "FoodLogEntryContext");
  ctx.f[1] = dayDate;
  ctx.f[8] = new GObj(SIG.mealType, [meal]);
}
