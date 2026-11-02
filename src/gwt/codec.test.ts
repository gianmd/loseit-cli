import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Vocab, items, payload, pkHex, readEntry } from "../loseit/model.js";
import { GObj, decodeRequest, decodeResponse, encodeRequest, parseJsArray } from "./codec.js";
import { decodeLong, encodeLong } from "./long.js";
import type { GwtSchema } from "./schema.js";

// Fixtures are real web-app traffic captured from loseit.com (user id/name sanitized).
const fixture = (name: string) => readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), "utf8");
const schema = JSON.parse(fixture("schema.json")) as GwtSchema;
const MODULE_BASE = "https://d3hsih69yn4d89.cloudfront.net/web/";

test("long tokens round-trip", () => {
  assert.equal(encodeLong(-1n), "P__________");
  assert.equal(decodeLong("P__________"), -1n);
  for (const v of [0n, 1n, 63n, 64n, 1793639020904n, -5n, 2n ** 62n]) {
    assert.equal(decodeLong(encodeLong(v)), v);
  }
});

test("parses split payloads, escapes and NaN", () => {
  assert.deepEqual(parseJsArray('[1,2].concat([3],[4,["a\\x3Cb"],0,7])'), [1, 2, 3, 4, ["a<b"], 0, 7]);
  assert.deepEqual(parseJsArray("[NaN,-Infinity,1.5E3]"), [NaN, -Infinity, 1500]);
});

for (const name of ["updateFoodLogEntry-add", "updateFoodLogEntry-edit", "saveCustomFoodLogEntry"]) {
  test(`re-encodes the web app's ${name} request byte-for-byte`, () => {
    const original = fixture(`${name}.req.txt`);
    const decoded = decodeRequest(schema, original);
    const reencoded = encodeRequest(schema, MODULE_BASE, decoded);
    assert.equal(reencoded, original);
  });
}

test("decodes getUnsavedFoodLogEntry into a FoodLogEntry", () => {
  const entry = payload(decodeResponse(schema, fixture("getUnsavedFoodLogEntry.res.txt")));
  assert.ok(entry instanceof GObj);
  const view = readEntry(new Vocab(schema), entry, "2026-11-02");
  assert.equal(view.food.name, "Banana, Medium");
  assert.equal(view.food.id, "b2008d5cbe5048ba906cf99fc8f0c07c");
  assert.equal(view.calories, 105);
  assert.equal(view.unit, "Each");
  assert.equal(view.nutrients.protein, 1.3);
});

test("decodes search results", () => {
  const res = payload(decodeResponse(schema, fixture("searchFoods.res.txt")));
  const foods = items((res as GObj).f[0] ?? null).filter((x) => x.type === "SearchResultFood");
  assert.ok(foods.length > 10);
  assert.ok(foods.some((f) => f.f[3] === "Banana, Medium" && pkHex(f.f[0] ?? null) === "b2008d5cbe5048ba906cf99fc8f0c07c"));
});

test("edit request differs from add only in servings", () => {
  const add = decodeRequest(schema, fixture("updateFoodLogEntry-add.req.txt")).params[1] as GObj;
  const edit = decodeRequest(schema, fixture("updateFoodLogEntry-edit.req.txt")).params[1] as GObj;
  const size = (e: GObj) => ((e.f[2] as GObj).f[1] as GObj).f;
  assert.deepEqual(size(add).slice(0, 1), [1]);
  assert.deepEqual(size(edit).slice(0, 1), [2]);
  assert.equal(((edit.f[2] as GObj).f[0] as GObj).f[1], 2);
});
