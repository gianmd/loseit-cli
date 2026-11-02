/**
 * Schema-driven GWT-RPC codec.
 *
 * Responses (`//OK[...]`) are read from the END of the payload array, which is
 * how the GWT client consumes them: version, flags, string table, then values
 * in reverse. Requests are written forward as a `|`-delimited token stream.
 */

import { decodeLong, encodeLong } from "./long.js";
import type { GwtSchema, Op, Prim } from "./schema.js";

/** A decoded Java object: its type signature plus fields in wire order. */
export class GObj {
  constructor(
    readonly sig: string,
    public f: GVal[] = [],
  ) {}

  /** Short class name, e.g. `FoodLogEntry` or `FoodLogEntry[]`. */
  get type(): string {
    const slash = this.sig.search(/\/\d+$/);
    const name = slash >= 0 ? this.sig.slice(0, slash) : this.sig;
    const arr = name.match(/^\[L(.*);$/);
    const base = (arr ? arr[1]! : name).split(".").pop()!;
    return arr ? `${base}[]` : base;
  }

  toJSON(): unknown {
    return { $type: this.type, f: this.f };
  }
}

export type GVal = null | number | bigint | boolean | string | GObj | GVal[] | [GVal, GVal][];

export class GwtRemoteError extends Error {
  constructor(
    message: string,
    readonly payload: GVal,
  ) {
    super(message);
    this.name = "GwtRemoteError";
  }
}

// ─── response parsing ──────────────────────────────────────────────────────

/**
 * Parse the JS array literal of a `//OK` / `//EX` response. Handles GWT's
 * `].concat([` splitting of large payloads, JS escapes and NaN/Infinity —
 * none of which JSON.parse accepts.
 */
export function parseJsArray(text: string): unknown[] {
  let i = 0;
  const ws = () => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };
  const value = (): unknown => {
    ws();
    const ch = text[i];
    if (ch === "[") return array();
    if (ch === '"' || ch === "'") return string(ch);
    const m = /^(-?Infinity|NaN|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i, i + 40));
    if (!m) throw new Error(`unexpected token at ${i}: ${text.slice(i, i + 20)}`);
    i += m[1]!.length;
    return Number(m[1]);
  };
  const array = (): unknown[] => {
    i++; // [
    const out: unknown[] = [];
    for (;;) {
      ws();
      if (text[i] === "]") {
        i++;
        // GWT splits huge payloads as `[...].concat([...],[...])`
        while (text.startsWith(".concat(", i)) {
          i += ".concat(".length;
          for (;;) {
            ws();
            for (const item of array()) out.push(item);
            ws();
            if (text[i++] === ")") break; // otherwise a ',' between chunks
          }
        }
        return out;
      }
      out.push(value());
      ws();
      if (text[i] === ",") i++;
    }
  };
  const string = (quote: string): string => {
    i++;
    let out = "";
    while (text[i] !== quote) {
      const ch = text[i++]!;
      if (ch !== "\\") {
        out += ch;
        continue;
      }
      const esc = text[i++]!;
      if (esc === "x") {
        out += String.fromCharCode(parseInt(text.slice(i, i + 2), 16));
        i += 2;
      } else if (esc === "u") {
        out += String.fromCharCode(parseInt(text.slice(i, i + 4), 16));
        i += 4;
      } else {
        out += { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" }[esc] ?? esc;
      }
    }
    i++;
    return out;
  };
  ws();
  return array();
}

class Reader {
  private pos: number;
  private readonly objects: GVal[] = [];

  constructor(
    private readonly schema: GwtSchema,
    private readonly values: unknown[],
    private readonly strings: string[],
  ) {
    this.pos = values.length;
  }

  private next(): unknown {
    if (this.pos <= 0) throw new Error("GWT payload exhausted");
    return this.values[--this.pos];
  }

  int(): number {
    const v = this.next();
    if (typeof v !== "number") throw new Error(`expected int, got ${JSON.stringify(v)}`);
    return v;
  }

  prim(kind: Prim): GVal {
    switch (kind) {
      case "int":
      case "num":
        return this.int();
      case "bool":
        return this.int() !== 0;
      case "long":
        return decodeLong(String(this.next()));
      case "str":
        return this.str();
      case "obj":
        return this.obj();
    }
  }

  str(): string | null {
    const idx = this.int();
    if (idx === 0) return null;
    const s = this.strings[idx - 1];
    if (s === undefined) throw new Error(`string index ${idx} out of range`);
    return s;
  }

  op(op: Op): GVal {
    if (op === "map") {
      const n = this.int();
      const pairs: [GVal, GVal][] = [];
      for (let k = 0; k < n; k++) pairs.push([this.obj(), this.obj()]);
      return pairs;
    }
    if (op.startsWith("arr:")) {
      const n = this.int();
      const kind = op.slice(4) as Prim;
      const items: GVal[] = [];
      for (let k = 0; k < n; k++) items.push(this.prim(kind));
      return items;
    }
    return this.prim(op as Prim);
  }

  obj(): GVal {
    const ref = this.int();
    if (ref < 0) {
      const back = this.objects[-(ref + 1)];
      if (back === undefined) throw new Error(`bad back-reference ${ref}`);
      return back;
    }
    if (ref === 0) return null;
    const sig = this.strings[ref - 1];
    if (!sig) throw new Error(`type index ${ref} out of range`);
    const ops = this.schema.types[sig]?.read;
    if (!ops) throw new Error(`no deserializer for ${sig}`);

    const slot = this.objects.length;
    this.objects.push(null);
    if (sig.startsWith("java.lang.String/")) {
      const s = this.str();
      this.objects[slot] = s;
      return s;
    }
    const obj = new GObj(sig);
    this.objects[slot] = obj;
    for (const op of ops) obj.f.push(this.op(op));
    return obj;
  }
}

/** Decode a raw `//OK[...]` response body into its return value. */
export function decodeResponse(schema: GwtSchema, body: string): GVal {
  const trimmed = body.trim();
  const ok = trimmed.startsWith("//OK");
  if (!ok && !trimmed.startsWith("//EX")) {
    throw new Error(`unexpected GWT response: ${trimmed.slice(0, 120)}`);
  }
  const arr = parseJsArray(trimmed.slice(4));
  const version = arr[arr.length - 1];
  const strings = arr[arr.length - 3];
  if (typeof version !== "number" || !Array.isArray(strings)) {
    throw new Error("malformed GWT response envelope");
  }
  const reader = new Reader(schema, arr.slice(0, -3), strings as string[]);
  const result = reader.obj();
  if (!ok) {
    const message = result instanceof GObj ? describeException(result) : String(result);
    throw new GwtRemoteError(message, result);
  }
  return result;
}

function describeException(ex: GObj): string {
  const text = ex.f.find((v): v is string => typeof v === "string");
  return text ? `${ex.type}: ${text}` : ex.type;
}

/**
 * Like decodeResponse, but for methods whose declared return type is a
 * primitive/void (the value is a raw token, not an object).
 */
export function decodeRawResponse(body: string): unknown[] {
  return parseJsArray(body.trim().slice(4));
}

// ─── request decoding (for inspecting captured web-app traffic) ─────────────

/** Split a request body on `|`, undoing GWT's `\\!` / `\\\\` / `\\0` escapes. */
function splitRequest(body: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === "\\") {
      const n = body[++i];
      cur += n === "!" ? "|" : n === "0" ? "\0" : (n ?? "");
    } else if (ch === "|") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  return out;
}

export interface DecodedRequest {
  method: string;
  paramTypes: string[];
  params: GVal[];
}

export function decodeRequest(schema: GwtSchema, body: string): DecodedRequest {
  const toks = splitRequest(body);
  let pos = 3;
  const strings = toks.slice(pos, pos + Number(toks[2]));
  pos += strings.length;
  const objects: GVal[] = [];
  const next = () => toks[pos++]!;
  const str = () => {
    const i = Number(next());
    return i === 0 ? null : strings[i - 1]!;
  };
  const prim = (kind: Prim): GVal => {
    switch (kind) {
      case "int":
      case "num":
        return Number(next());
      case "bool":
        return next() === "1";
      case "long":
        return decodeLong(next());
      case "str":
        return str();
      case "obj":
        return obj();
    }
  };
  const op = (o: Op): GVal => {
    if (o === "map") {
      const n = Number(next());
      const pairs: [GVal, GVal][] = [];
      for (let k = 0; k < n; k++) pairs.push([obj(), obj()]);
      return pairs;
    }
    if (o.startsWith("arr:")) {
      const n = Number(next());
      return Array.from({ length: n }, () => prim(o.slice(4) as Prim));
    }
    return prim(o as Prim);
  };
  const obj = (): GVal => {
    const ref = Number(next());
    if (ref < 0) return objects[-(ref + 1)] ?? null;
    if (ref === 0) return null;
    const sig = strings[ref - 1]!;
    const slot = objects.length;
    objects.push(null);
    if (sig.startsWith("java.lang.String/")) return (objects[slot] = str());
    const ops = schema.types[sig]?.write ?? schema.types[sig]?.read;
    if (!ops) throw new Error(`no serializer for ${sig}`);
    const o = new GObj(sig);
    objects[slot] = o;
    for (const x of ops) o.f.push(op(x));
    return o;
  };
  next(); // module base
  next(); // policy
  next(); // service
  const method = str()!;
  const count = Number(next());
  const paramTypes = Array.from({ length: count }, () => str()!);
  const params = paramTypes.map((t) => {
    const p = PRIMITIVE_PARAMS[t];
    if (p) return prim(p);
    if (t.startsWith("java.lang.String/")) return str();
    return obj();
  });
  return { method, paramTypes, params };
}

// ─── request encoding ──────────────────────────────────────────────────────

const PRIMITIVE_PARAMS: Record<string, Prim> = {
  I: "int",
  S: "int",
  B: "int",
  C: "int",
  Z: "bool",
  D: "num",
  F: "num",
  J: "long",
};

const sigIndex = new WeakMap<GwtSchema, Map<string, string>>();

/** Resolve a bare class name (e.g. from model.ts) to the build's `Name/CRC` signature. */
export function resolveSig(schema: GwtSchema, sig: string): string {
  if (/\/\d+$/.test(sig)) return sig;
  let index = sigIndex.get(schema);
  if (!index) {
    index = new Map(Object.keys(schema.types).map((k) => [k.slice(0, k.lastIndexOf("/")), k]));
    sigIndex.set(schema, index);
  }
  const full = index.get(sig);
  if (!full) throw new Error(`type ${sig} not found in the current Lose It build`);
  return full;
}

class Writer {
  private readonly strings: string[] = [];
  private readonly stringIdx = new Map<string, number>();
  private readonly objects = new Map<GObj, number>();
  readonly tokens: string[] = [];

  constructor(private readonly schema: GwtSchema) {}

  addString(s: string | null): number {
    if (s === null) return 0;
    let idx = this.stringIdx.get(s);
    if (idx === undefined) {
      this.strings.push(s);
      idx = this.strings.length;
      this.stringIdx.set(s, idx);
    }
    return idx;
  }

  token(t: string | number): void {
    this.tokens.push(String(t));
  }

  prim(kind: Prim, v: GVal): void {
    switch (kind) {
      case "int":
      case "num":
        if (typeof v !== "number") throw new Error(`expected number, got ${String(v)}`);
        this.token(v);
        return;
      case "bool":
        this.token(v ? 1 : 0);
        return;
      case "long":
        this.token(encodeLong(v as bigint | number));
        return;
      case "str":
        this.token(this.addString(v as string | null));
        return;
      case "obj":
        this.obj(v);
        return;
    }
  }

  op(op: Op, v: GVal): void {
    if (op === "map") {
      const pairs = (v ?? []) as [GVal, GVal][];
      this.token(pairs.length);
      for (const [k, val] of pairs) {
        this.obj(k);
        this.obj(val);
      }
      return;
    }
    if (op.startsWith("arr:")) {
      const items = (v ?? []) as GVal[];
      this.token(items.length);
      for (const item of items) this.prim(op.slice(4) as Prim, item);
      return;
    }
    this.prim(op as Prim, v);
  }

  obj(v: GVal): void {
    if (v === null || v === undefined) {
      this.token(0);
      return;
    }
    if (typeof v === "string") {
      this.token(this.addString("java.lang.String/2004016611"));
      this.token(this.addString(v));
      return;
    }
    if (!(v instanceof GObj)) throw new Error(`cannot write ${String(v)} as an object`);
    const seen = this.objects.get(v);
    if (seen !== undefined) {
      this.token(-(seen + 1));
      return;
    }
    this.objects.set(v, this.objects.size);
    const sig = resolveSig(this.schema, v.sig);
    const ops = this.schema.types[sig]?.write ?? this.schema.types[sig]?.read;
    if (!ops) throw new Error(`no serializer for ${v.sig}`);
    if (ops.length !== v.f.length) {
      throw new Error(`${v.type}: expected ${ops.length} fields, got ${v.f.length}`);
    }
    this.token(this.addString(sig));
    ops.forEach((op, i) => this.op(op, v.f[i]!));
  }

  finish(): string {
    const esc = (s: string) =>
      s.replace(/\\/g, "\\\\").replace(/\|/g, "\\!").replace(/\0/g, "\\0");
    return [7, 0, this.strings.length, ...this.strings.map(esc), ...this.tokens].join("|") + "|";
  }
}

export interface RpcCall {
  method: string;
  /** Exact parameter type signatures (selects the overload). */
  paramTypes: string[];
  params: GVal[];
}

export function encodeRequest(
  schema: GwtSchema,
  moduleBase: string,
  call: RpcCall,
): string {
  const w = new Writer(schema);
  w.token(w.addString(moduleBase));
  w.token(w.addString(schema.policyHash));
  w.token(w.addString(schema.service));
  w.token(w.addString(call.method));
  w.token(call.params.length);
  for (const t of call.paramTypes) w.token(w.addString(t));
  call.paramTypes.forEach((type, i) => {
    const value = call.params[i] ?? null;
    const prim = PRIMITIVE_PARAMS[type];
    if (prim) w.prim(prim, value);
    else if (type.startsWith("java.lang.String/")) w.prim("str", value);
    else w.obj(value);
  });
  return w.finish();
}
