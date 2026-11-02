/**
 * Derives a GWT-RPC schema (wire layout of every serializable type + the
 * signature of every service method) from Lose It's compiled web JavaScript.
 *
 * GWT compiles one field serializer per type and registers them in a map:
 *     a[<typeSignatureConst>] = [instantiate, deserialize, serialize]
 * The bodies are flat sequences of stream reads/writes in wire order, e.g.
 *     function NKg(a,b){ QKg(b,rQ(gGd(a),254)); TKg(b,pGd(a)); UKg(b,sGd(a)); ... }
 * We classify the handful of obfuscated stream primitives (readObject,
 * readBoolean, readLong, ...) by their bodies, then replay each serializer
 * body into an op list. Because everything is derived structurally, a Lose It
 * redeploy only requires re-running this against the new build.
 */

export type Prim = "int" | "bool" | "num" | "long" | "str" | "obj";
export type Op = Prim | "map" | `arr:${Prim}`;
/** Array element reads; merged with the instantiate's length into `arr:*`. */
type RawOp = Op | `elems:${Prim}`;

export interface TypeSchema {
  /** Read order for server → client payloads (instantiate + deserialize). */
  read?: Op[];
  /** Write order for client → server payloads. */
  write?: Op[];
  enum?: true;
  /** Enum constant names by ordinal, when recoverable from the build. */
  names?: (string | null)[];
}

/** Bump when the extractor's output format changes so cached schemas regenerate. */
export const SCHEMA_VERSION = 2;

export interface GwtSchema {
  version: number;
  permutation: string;
  policyHash: string;
  service: string;
  types: Record<string, TypeSchema>;
  /** Method name → overloads, each a list of parameter type signatures. */
  methods: Record<string, string[][]>;
}

const SERVICE = "com.loseit.core.client.service.LoseItRemoteService";

/**
 * The cache.js and deferred fragments wrap the real code in double-quoted JS
 * string literals; decode and concatenate them so the code can be scanned.
 */
export function unwrapGwtScript(text: string): string {
  const parts: string[] = [];
  for (const m of text.matchAll(/"((?:[^"\\]|\\.)*)"/gs)) {
    const literal = m[1]!;
    if (literal.length < 1000) continue;
    const json = literal
      .replace(/\\'/g, "'")
      .replace(/\\x([0-9a-fA-F]{2})/g, "\\u00$1");
    try {
      parts.push(JSON.parse(`"${json}"`) as string);
    } catch {
      parts.push(literal);
    }
  }
  return parts.join("\n");
}

class FnIndex {
  private readonly starts = new Map<string, number>();
  private readonly bodies = new Map<string, string | null>();

  constructor(private readonly js: string) {
    for (const m of js.matchAll(/function ([\w$]+)\(/g)) {
      if (!this.starts.has(m[1]!)) this.starts.set(m[1]!, m.index);
    }
  }

  body(name: string): string | null {
    if (this.bodies.has(name)) return this.bodies.get(name)!;
    const start = this.starts.get(name);
    let result: string | null = null;
    if (start !== undefined) {
      const open = this.js.indexOf("{", start);
      let depth = 0;
      for (let i = open; i < this.js.length; i++) {
        const ch = this.js[i];
        if (ch === "{") depth++;
        else if (ch === "}" && --depth === 0) {
          result = this.js.slice(open + 1, i);
          break;
        }
      }
    }
    this.bodies.set(name, result);
    return result;
  }
}

const READ_INT = "a.b[--a.a]";

interface Primitives {
  readers: Map<string, Prim>;
  readString: string;
  writers: Map<string, Prim>;
  writeToken: string;
  writeLong: string;
}

export class SchemaError extends Error {}

export function extractSchema(
  rawScripts: string[],
  permutation: string,
): GwtSchema {
  const js = rawScripts.map(unwrapGwtScript).join("\n");
  const fns = new FnIndex(js);

  const literals = new Map<string, string>();
  for (const m of js.matchAll(/([\w$]+)='((?:[^'\\]|\\.)*)'/g)) {
    if (!literals.has(m[1]!)) literals.set(m[1]!, m[2]!);
  }
  const resolve = (token: string): string =>
    token.startsWith("'") ? token.slice(1, -1) : (literals.get(token) ?? token);

  // ── serializer map ────────────────────────────────────────────────────────
  const entries = new Map<string, { inst?: string; deser?: string; ser?: string }>();
  for (const m of js.matchAll(
    /a\[([\w$]+)\]=\[([\w$]+),([\w$]+)(?:,([\w$]+))?\]/g,
  )) {
    const sig = literals.get(m[1]!);
    if (!sig || !sig.includes("/")) continue;
    const entry = entries.get(sig) ?? {};
    if (fns.body(m[2]!) !== null) entry.inst = m[2]!;
    if (fns.body(m[3]!) !== null) entry.deser = m[3]!;
    if (m[4] && fns.body(m[4]) !== null) entry.ser = m[4];
    entries.set(sig, entry);
  }
  if (entries.size < 100) {
    throw new SchemaError(`only found ${entries.size} serializer entries`);
  }

  const prims = classifyPrimitives(fns, [...entries.values()]);
  const types: Record<string, TypeSchema> = {};
  for (const [sig, entry] of entries) {
    const schema: TypeSchema = {};
    if (entry.inst && entry.deser) {
      const inst = fns.body(entry.inst)!;
      const instOps = readOps(fns, prims, inst, new Set());
      const deserOps = readOps(fns, prims, fns.body(entry.deser)!, new Set());
      if (/return c\[b\]/.test(inst)) {
        schema.enum = true;
        const names = enumNames(fns, js, resolve, inst);
        if (names) schema.names = names;
      }
      schema.read = mergeArray(instOps, deserOps);
    }
    if (entry.ser) {
      schema.write = writeOps(fns, prims, fns.body(entry.ser)!, new Set());
    }
    if (schema.read || schema.write) types[sig] = schema;
  }

  return {
    version: SCHEMA_VERSION,
    permutation,
    policyHash: findPolicyHash(js),
    service: SERVICE,
    types,
    methods: extractMethods(js, resolve),
  };
}

/**
 * Enum instantiate bodies index into `values()`, an array literal of constant
 * vars, each initialised as `X=new Ctor('Name',ordinal,...)`.
 */
function enumNames(
  fns: FnIndex,
  js: string,
  resolve: (token: string) => string,
  inst: string,
): (string | null)[] | undefined {
  let list = inst.match(/\[([\w$,]+)\]\)\)?;/)?.[1];
  if (!list) {
    const valuesFn = inst.match(/c=([\w$]+)\(\)/)?.[1];
    list = valuesFn ? fns.body(valuesFn)?.match(/\[([\w$,]+)\]\)/)?.[1] : undefined;
  }
  if (!list) return undefined;
  const names = list.split(",").map((v) => {
    const m = js.match(new RegExp(`[;{]${esc(v)}=new [\\w$]+\\(('[^']*'|[\\w$]+),\\d+`));
    return m ? resolve(m[1]!) : null;
  });
  return names.some((n) => n !== null) ? names : undefined;
}

/** An array's instantiate reads its length; its deserialize reads elements. */
function mergeArray(inst: RawOp[], deser: RawOp[]): Op[] {
  const last = deser[deser.length - 1];
  if (inst.length === 1 && inst[0] === "int" && deser.length === 1 && last?.startsWith("elems:")) {
    return [`arr:${last.slice(6)}` as Op];
  }
  const ops = [...inst, ...deser];
  if (ops.some((op) => op.startsWith("elems:"))) {
    throw new SchemaError(`array elements without a length: ${ops.join()}`);
  }
  return ops as Op[];
}

function classifyPrimitives(
  fns: FnIndex,
  entries: { deser?: string; ser?: string }[],
): Primitives {
  const readers = new Map<string, Prim>();
  let readString = "";
  const writers = new Map<string, Prim>();
  let writeToken = "";
  let writeLong = "";

  for (const entry of entries) {
    const deser = entry.deser ? fns.body(entry.deser) : null;
    if (deser) {
      for (const m of deser.matchAll(/([\w$]+)\(a\)/g)) {
        const name = m[1]!;
        if (readers.has(name)) continue;
        const body = fns.body(name) ?? "";
        if (/<0\)/.test(body) && body.includes(READ_INT)) readers.set(name, "obj");
        else if (body.includes(`!!${READ_INT}`)) readers.set(name, "bool");
        else if (body.includes(`Number(${READ_INT})`)) readers.set(name, "num");
        else if (/^var a=b\.b\[--b\.a\]/.test(body)) readers.set(name, "long");
      }
      const s = deser.match(/([\w$]+)\(a,a\.b\[--a\.a\]\)/);
      if (s && !readString) readString = s[1]!;
    }
    const ser = entry.ser ? fns.body(entry.ser) : null;
    if (ser) {
      for (const m of ser.matchAll(/([\w$]+)\(a,/g)) {
        const name = m[1]!;
        if (writers.has(name) || name === writeToken) continue;
        const body = fns.body(name) ?? "";
        if (body.includes("could not get type signature")) writers.set(name, "obj");
        else if (!isLoop(body) && body.includes("?'1':'0'")) writers.set(name, "bool");
        else if (!isLoop(body) && /\(a\.a,''\+b\)/.test(body)) writers.set(name, "num");
      }
      const tok = ser.match(/([\w$]+)\(a,[\w$.]+\?'1':'0'\)/);
      if (tok && !writeToken) writeToken = tok[1]!;
    }
  }
  for (const entry of entries) {
    const ser = entry.ser ? fns.body(entry.ser) : null;
    const lng = ser?.match(new RegExp(`${esc(writeToken)}\\(a,([\\w$]+)\\(b\\.[\\w$]+\\)\\)`));
    if (lng) {
      writeLong = lng[1]!;
      break;
    }
  }
  // writeString is the single-statement `writeToken(a,''+addString(a,b))`.
  for (const entry of entries) {
    const ser = entry.ser ? fns.body(entry.ser) : null;
    if (!ser) continue;
    for (const m of ser.matchAll(/([\w$]+)\(a,b\.[\w$]+\)/g)) {
      const name = m[1]!;
      if (writers.has(name)) continue;
      const body = fns.body(name) ?? "";
      if (new RegExp(`${esc(writeToken)}\\(a,''\\+[\\w$]+\\(a,b\\)\\)`).test(body)) {
        writers.set(name, "str");
      }
    }
  }

  const need = ["obj", "bool", "num", "long"] as const;
  for (const kind of need) {
    if (![...readers.values()].includes(kind)) {
      throw new SchemaError(`could not identify GWT reader for ${kind}`);
    }
  }
  if (!readString || !writeToken || !writeLong) {
    throw new SchemaError("could not identify GWT string/token/long primitives");
  }
  return { readers, readString, writers, writeToken, writeLong };
}

function esc(s: string): string {
  return s.replace(/[$]/g, "\\$");
}

const isLoop = (body: string) => /\bfor\(|\bwhile\(/.test(body);

/** Read ops for a loop body: list (count + objs), map (count + pairs) or elements. */
function loopReadOps(prims: Primitives, body: string): RawOp[] {
  const objReads = [...prims.readers].filter(([, k]) => k === "obj").map(([n]) => n);
  const loop = body.slice(body.search(/\bfor\(|\bwhile\(/));
  const objCount = objReads.reduce(
    (n, name) => n + (loop.match(new RegExp(`${esc(name)}\\(a\\)`, "g"))?.length ?? 0),
    0,
  );
  if (/b\.length/.test(loop)) {
    if (objCount > 0) return ["elems:obj"];
    for (const [name, kind] of prims.readers) {
      if (loop.includes(`${name}(a)`)) return [`elems:${kind}`];
    }
    if (loop.includes(`${prims.readString}(a,`)) return ["elems:str"];
    return ["elems:int"];
  }
  if (objCount === 2) return ["map"];
  if (objCount === 1) return ["arr:obj"];
  throw new SchemaError(`unrecognised read loop: ${body.slice(0, 160)}`);
}

function readOps(fns: FnIndex, prims: Primitives, body: string, seen: Set<string>): RawOp[] {
  if (isLoop(body)) return loopReadOps(prims, body);
  const ops: RawOp[] = [];
  const pattern = new RegExp(
    `${esc(prims.readString)}\\(a,a\\.b\\[--a\\.a\\]\\)|a\\.b\\[--a\\.a\\]|([\\w$]+)\\(a\\)|([\\w$]+)\\(a,b\\)`,
    "g",
  );
  for (const m of body.matchAll(pattern)) {
    if (m[0].startsWith(`${prims.readString}(a,`)) ops.push("str");
    else if (m[0] === READ_INT) ops.push("int");
    else if (m[1]) {
      const kind = prims.readers.get(m[1]);
      if (kind) ops.push(kind);
    } else if (m[2] && !seen.has(m[2])) {
      const sub = fns.body(m[2]);
      if (sub !== null) ops.push(...readOps(fns, prims, sub, new Set([...seen, m[2]])));
    }
  }
  return ops;
}

function loopWriteOps(prims: Primitives, body: string): Op[] {
  const loop = body.slice(body.search(/\bfor\(|\bwhile\(/));
  const objWriters = [...prims.writers].filter(([, k]) => k === "obj").map(([n]) => n);
  const objCount = objWriters.reduce(
    (n, name) => n + (loop.match(new RegExp(`${esc(name)}\\(a,`, "g"))?.length ?? 0),
    0,
  );
  if (objCount === 2) return ["map"];
  if (objCount === 1) return ["arr:obj"];
  if (loop.includes(`${prims.writeToken}(a,''+b[`)) return ["arr:int"];
  for (const [name, kind] of prims.writers) {
    if (loop.includes(`${name}(a,b[`)) return [`arr:${kind}` as Op];
  }
  throw new SchemaError(`unrecognised write loop: ${body.slice(0, 160)}`);
}

function writeOps(fns: FnIndex, prims: Primitives, body: string, seen: Set<string>): Op[] {
  if (isLoop(body)) return loopWriteOps(prims, body);
  const ops: Op[] = [];
  const tok = esc(prims.writeToken);
  const pattern = new RegExp(
    `${tok}\\(a,[^;]*?\\?'1':'0'\\)|${tok}\\(a,${esc(prims.writeLong)}\\(|${tok}\\(a,''\\+[\\w$]+\\(a,|${tok}\\(a,''\\+|([\\w$]+)\\(a,b\\)|([\\w$]+)\\(a,`,
    "g",
  );
  for (const m of body.matchAll(pattern)) {
    const text = m[0];
    if (text.endsWith("?'1':'0')")) ops.push("bool");
    else if (text.includes(`${prims.writeLong}(`)) ops.push("long");
    else if (text.startsWith(`${prims.writeToken}(a,''+`)) ops.push(text.endsWith("(a,") ? "str" : "num");
    else if (m[1]) {
      const kind = prims.writers.get(m[1]);
      if (kind) ops.push(kind);
      else if (!seen.has(m[1])) {
        const sub = fns.body(m[1]);
        if (sub !== null) ops.push(...writeOps(fns, prims, sub, new Set([...seen, m[1]])));
      }
    } else if (m[2]) {
      const kind = prims.writers.get(m[2]);
      if (kind) ops.push(kind);
    }
  }
  return ops;
}

function findPolicyHash(js: string): string {
  // Each RPC proxy constructor: Base.call(this, moduleBase, path, '<policy>', serializer)
  const hashes = [
    ...js.matchAll(/\.call\(this,[\w$]+\(\),(?:null|'[^']*'),'([0-9A-F]{32})',[\w$]+\)/g),
  ].map((m) => m[1]!);
  const unique = [...new Set(hashes)];
  if (unique.length === 0) throw new SchemaError("policy hash not found");
  // Several proxies exist (remote logging, etc.); the LoseIt service is the
  // one whose path argument is null (it uses @RemoteServiceRelativePath).
  const service = [
    ...js.matchAll(/\.call\(this,[\w$]+\(\),null,'([0-9A-F]{32})',[\w$]+\)/g),
  ].map((m) => m[1]!);
  return service[0] ?? unique[0]!;
}

function extractMethods(
  js: string,
  resolve: (token: string) => string,
): Record<string, string[][]> {
  const methods: Record<string, string[][]> = {};
  const call =
    /new [\w$]+\(b,[\w$]+,([\w$]+|'[^']*')\);try\{[\w$]+=[\w$]+\([\w$]+,[\w$]+,(\d+)\);((?:[\w$]+\([\w$]+,''\+[\w$]+\([\w$]+,(?:[\w$]+|'[^']*')\)\);)*)/g;
  for (const m of js.matchAll(call)) {
    const name = resolve(m[1]!);
    const count = Number(m[2]);
    const types = [...m[3]!.matchAll(/,([\w$]+|'[^']*')\)\);/g)].map((t) => resolve(t[1]!));
    if (types.length !== count) continue;
    const overloads = (methods[name] ??= []);
    if (!overloads.some((o) => o.join() === types.join())) overloads.push(types);
  }
  return methods;
}
