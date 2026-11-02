// Dev helper: compact tree view of decoded JSON (from decode-capture.ts or `loseit rpc`). npx tsx scripts/show.ts <file.json>
import { readFileSync } from "node:fs";
const data = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const maxDepth = Number(process.argv[3] ?? 99);
function show(v: any, depth: number): string {
  if (v && typeof v === "object" && "$type" in v) {
    if (["Date", "Integer", "Double", "Long", "Boolean", "Float"].includes(v.$type)) return `${v.$type}(${v.f[0]})`;
    if (/Type$|Measurement$|Frequency$|Gender$/.test(v.$type) && v.f.length === 1) return `${v.$type}#${v.f[0]}`;
    if (v.$type === "SimplePrimaryKey") return `PK(${Buffer.from(v.f[0].f[0].map((b: number) => b & 255)).toString("hex")})`;
    if (depth >= maxDepth) return `${v.$type}{…}`;
    const parts = v.f.map((x: any, i: number) => `${i}:${show(x, depth + 1)}`);
    const one = `${v.$type}{${parts.join(", ")}}`;
    if (one.length < 160) return one;
    const pad = "  ".repeat(depth + 1);
    return `${v.$type}{\n${parts.map((p: string) => pad + p).join("\n")}\n${"  ".repeat(depth)}}`;
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    const parts = v.map((x) => show(x, depth + 1));
    const one = `[${parts.join(", ")}]`;
    if (one.length < 160) return one;
    const pad = "  ".repeat(depth + 1);
    return `[\n${parts.map((p) => pad + p).join("\n")}\n${"  ".repeat(depth)}]`;
  }
  return JSON.stringify(v);
}
console.log(show(data, 0));
