import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { GObj, decodeRequest, encodeRequest, type GVal } from "../gwt/codec.js";
import type { GwtSchema } from "../gwt/schema.js";
import { SIG, Vocab, applyCustomFoodEdit, makePk, readServing } from "./model.js";

const schema = JSON.parse(
  readFileSync(new URL("../../test/fixtures/schema.json", import.meta.url), "utf8"),
) as GwtSchema;
const vocab = new Vocab(schema);
const MODULE_BASE = "https://d3hsih69yn4d89.cloudfront.net/web/";

/** A CustomFood shaped like getCustomFoods returns them (base 2 servings, 1 logged). */
function customFood() {
  const ord = (k: string) => new GObj(SIG.measurement, [vocab.nutrientOrdinal(k)]);
  const shared = new GObj(SIG.double, [20]); // decoded maps can reuse one Double for equal values
  const ident = new GObj(SIG.foodIdentifier, [
    -1, "Fish", null, "Tuna", "Kirkland Signature", new GObj(SIG.productType, [0]), -1, null, 1n,
    makePk("8b83a0cb65074de48babbbf90776086f"),
  ]);
  const nutrients = new GObj(SIG.foodNutrients, [
    2,
    1,
    new GObj(SIG.hashMap, [
      [
        [ord("calories"), new GObj(SIG.double, [220])],
        [ord("protein"), shared],
        [ord("carbs"), shared],
      ] as [GVal, GVal][],
    ]),
  ]);
  const size = new GObj(SIG.servingSize, [1, true, new GObj(SIG.foodMeasure, [8]), 1, 56, 56]);
  return new GObj(SIG.customFood, [
    true, false, 1, -1, ident, new GObj(SIG.foodServing, [nutrients, size]),
    new GObj(SIG.hourDate, [new GObj(SIG.date, [1n]), 1]), false, 0, true, true, 1n,
    makePk("8b83a0cb65074de48babbbf90776086f"),
  ]);
}

test("food edit changes only the given fields, per serving", () => {
  const food = customFood();
  const updated = applyCustomFoodEdit(vocab, food, { nutrients: { sodium: 290, protein: 30 } }, 5000);
  assert.deepEqual(updated, ["sodium", "protein"]);

  // Map holds values for 2 servings; one serving is half of it.
  const view = readServing(vocab, (food.f[5] as GObj));
  assert.deepEqual(view.nutrients, { calories: 110, protein: 30, carbs: 10, sodium: 290 });

  const ident = food.f[4] as GObj;
  assert.equal(ident.f[3], "Tuna");
  assert.equal(ident.f[4], "Kirkland Signature");
  assert.equal(ident.f[8], 5000n);
  assert.equal(food.f[11], 5000n);
});

test("food edit sets name and brand without touching nutrients", () => {
  const food = customFood();
  const updated = applyCustomFoodEdit(vocab, food, { name: "Tuna, Solid Light", brand: "Kirkland" });
  assert.deepEqual(updated, ["name", "brand"]);
  assert.equal((food.f[4] as GObj).f[3], "Tuna, Solid Light");
  assert.equal((food.f[4] as GObj).f[4], "Kirkland");
  assert.deepEqual(readServing(vocab, food.f[5] as GObj).nutrients, { calories: 110, protein: 10, carbs: 10 });
});

test("edited food encodes as a saveCustomFood request and decodes back", () => {
  const food = customFood();
  applyCustomFoodEdit(vocab, food, { nutrients: { cholesterol: 30 } });
  const token = new GObj("com.loseit.core.client.service.ServiceRequestToken", [
    null,
    new GObj("com.loseit.core.client.model.UserId", [12345, "Test User", -5]),
  ]);
  const body = encodeRequest(schema, MODULE_BASE, {
    method: "saveCustomFood",
    paramTypes: schema.methods.saveCustomFood![0]!,
    params: [token, food, "en-US", false, false],
  });
  const decoded = decodeRequest(schema, body);
  assert.equal(decoded.method, "saveCustomFood");
  assert.deepEqual(decoded.params.slice(2), ["en-US", false, false]);
  const sent = decoded.params[1] as GObj;
  assert.deepEqual(readServing(vocab, sent.f[5] as GObj).nutrients, {
    calories: 110, protein: 10, carbs: 10, cholesterol: 30,
  });
});
