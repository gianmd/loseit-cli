import { extractSchema, type GwtSchema } from "./schema.js";

export const MODULE_BASE = "https://d3hsih69yn4d89.cloudfront.net/web/";

async function fetchText(url: string, timeoutMs: number): Promise<string | null> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (resp.status === 404 || resp.status === 403) return null;
  if (!resp.ok) throw new Error(`GET ${url} failed: HTTP ${resp.status}`);
  return resp.text();
}

/** The permutation is the `<hash>.cache.js` that web.nocache.js selects. */
export async function resolvePermutation(timeoutMs: number): Promise<string> {
  const nocache = await fetchText(`${MODULE_BASE}web.nocache.js`, timeoutMs);
  if (!nocache) throw new Error("web.nocache.js not found");
  const tokens = [...new Set(nocache.match(/[0-9A-F]{32}/g) ?? [])];
  for (const token of tokens) {
    const resp = await fetch(`${MODULE_BASE}${token}.cache.js`, {
      method: "HEAD",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (resp.ok) return token;
  }
  throw new Error(`no permutation found among ${tokens.length} candidates`);
}

/** Download the permutation's main script plus all deferred fragments. */
export async function fetchBuildScripts(
  permutation: string,
  timeoutMs: number,
): Promise<string[]> {
  const main = await fetchText(`${MODULE_BASE}${permutation}.cache.js`, timeoutMs);
  if (!main) throw new Error(`permutation ${permutation} not found`);
  const scripts = [main];
  for (let n = 1; n < 200; n++) {
    const frag = await fetchText(
      `${MODULE_BASE}deferredjs/${permutation}/${n}.cache.js`,
      timeoutMs,
    );
    if (frag === null) break;
    scripts.push(frag);
  }
  return scripts;
}

export async function loadLiveSchema(timeoutMs: number): Promise<GwtSchema> {
  const permutation = await resolvePermutation(timeoutMs);
  return extractSchema(await fetchBuildScripts(permutation, timeoutMs), permutation);
}
