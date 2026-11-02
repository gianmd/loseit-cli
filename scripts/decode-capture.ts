// Dev helper: decode captured web-app GWT traffic. npx tsx scripts/decode-capture.ts <schema.json> <file.req.txt|file.res.txt>
import { readFileSync } from "node:fs";
import { decodeRequest, decodeResponse } from "../src/gwt/codec.js";
const schema = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const file = process.argv[3]!;
const text = readFileSync(file, "utf8");
const out = file.endsWith(".req.txt") ? decodeRequest(schema, text) : decodeResponse(schema, text);
console.log(JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? `${v}n` : v), 1));
