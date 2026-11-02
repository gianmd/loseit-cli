import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { MODULE_BASE, fetchBuildScripts, resolvePermutation } from "../gwt/build.js";
import {
  GObj,
  GwtRemoteError,
  decodeResponse,
  encodeRequest,
  type GVal,
} from "../gwt/codec.js";
import { SCHEMA_VERSION, extractSchema, type GwtSchema } from "../gwt/schema.js";
import type { Config } from "./config.js";

const SERVICE_URL = "https://www.loseit.com/web/service";
const LOGIN_URL = "https://api.loseit.com/account/login";
/** Re-check for a new web build at most this often. */
const BUILD_CHECK_MS = 6 * 60 * 60 * 1000;

export const SIG = {
  token: "com.loseit.core.client.service.ServiceRequestToken",
  userId: "com.loseit.core.client.model.UserId",
} as const;

interface Session {
  cookies: Record<string, string>;
  userId: number;
  username: string;
  createdAt: number;
}

interface BuildState {
  permutation: string;
  checkedAt: number;
}

export class LoseItError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "LoseItError";
  }
}

export class LoseItClient {
  private session: Session | null = null;
  private schema: GwtSchema | null = null;

  constructor(readonly config: Config) {}

  private path(name: string): string {
    return join(this.config.home, name);
  }

  private async readJson<T>(name: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(this.path(name), "utf8")) as T;
    } catch {
      return null;
    }
  }

  private async writeJson(name: string, data: unknown): Promise<void> {
    await mkdir(this.config.home, { recursive: true, mode: 0o700 });
    await writeFile(this.path(name), JSON.stringify(data), { mode: 0o600 });
  }

  // ─── auth ────────────────────────────────────────────────────────────────

  async login(): Promise<Session> {
    const { email, password } = this.config;
    if (!email || !password) {
      throw new LoseItError(
        `LOSEIT_EMAIL and LOSEIT_PASSWORD must be set (env or ${this.path(".env")})`,
        "missing_credentials",
      );
    }
    const resp = await fetch(LOGIN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({ username: email, password, grant_type: "password" }),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
    if (!resp.ok) {
      throw new LoseItError(`login failed: HTTP ${resp.status}`, "login_failed");
    }
    const cookies: Record<string, string> = {};
    for (const header of resp.headers.getSetCookie()) {
      const m = header.match(/^([^=]+)=([^;]*)/);
      if (m) cookies[m[1]!] = m[2]!;
    }
    const data = (await resp.json()) as { user_id: number; username: string };
    this.session = {
      cookies,
      userId: data.user_id,
      username: data.username,
      createdAt: Date.now(),
    };
    await this.writeJson("session.json", this.session);
    return this.session;
  }

  private async ensureSession(): Promise<Session> {
    this.session ??= await this.readJson<Session>("session.json");
    return this.session ?? (await this.login());
  }

  async logout(): Promise<void> {
    this.session = null;
    await this.writeJson("session.json", null);
  }

  // ─── build schema ────────────────────────────────────────────────────────

  async ensureSchema(force = false): Promise<GwtSchema> {
    if (this.schema && !force) return this.schema;
    const state = await this.readJson<BuildState>("build.json");
    let permutation = state?.permutation;
    if (force || !permutation || Date.now() - state!.checkedAt > BUILD_CHECK_MS) {
      permutation = await resolvePermutation(this.config.timeoutMs);
      await this.writeJson("build.json", { permutation, checkedAt: Date.now() });
    }
    const file = `schema-${permutation}.json`;
    let schema = await this.readJson<GwtSchema>(file);
    if (schema?.version !== SCHEMA_VERSION) {
      const scripts = await fetchBuildScripts(permutation, this.config.timeoutMs);
      schema = extractSchema(scripts, permutation);
      await this.writeJson(file, schema);
    }
    this.schema = schema;
    return schema;
  }

  // ─── RPC ─────────────────────────────────────────────────────────────────

  /** Hours from GMT for the user's timezone on the given date (Lose It uses whole hours). */
  gmtOffset(at = new Date()): number {
    const part = new Intl.DateTimeFormat("en-US", {
      timeZone: this.config.timezone,
      timeZoneName: "shortOffset",
    })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value;
    const m = part?.match(/GMT([+-]\d+)(?::(\d+))?/);
    return m ? Number(m[1]) : 0;
  }

  token(session: Session): GObj {
    const user = new GObj(SIG.userId, [session.userId, session.username, this.gmtOffset()]);
    return new GObj(SIG.token, [null, user]);
  }

  /**
   * Call a LoseItRemoteService method. `params` excludes the leading
   * ServiceRequestToken, which is added automatically. When a method is
   * overloaded, pass `paramTypes` (without the token) to pick one.
   */
  async call(method: string, params: GVal[] = [], paramTypes?: string[]): Promise<GVal> {
    return this.callOnce(method, params, paramTypes, false);
  }

  private async callOnce(
    method: string,
    params: GVal[],
    paramTypes: string[] | undefined,
    retried: boolean,
  ): Promise<GVal> {
    const schema = await this.ensureSchema(retried);
    const session = await this.ensureSession();

    const overloads = schema.methods[method];
    if (!overloads) throw new LoseItError(`unknown RPC method ${method}`, "unknown_method");
    const bare = (t: string) => t.replace(/\/\d+$/, "");
    const types = paramTypes
      ? overloads.find((o) => o.slice(1).map(bare).join() === paramTypes.map(bare).join())
      : overloads.find((o) => o.length === params.length + 1);
    if (!types) {
      throw new LoseItError(
        `no overload of ${method} matches; available: ${JSON.stringify(overloads)}`,
        "bad_overload",
      );
    }

    const body = encodeRequest(schema, MODULE_BASE, {
      method,
      paramTypes: types,
      params: [this.token(session), ...params],
    });

    const resp = await fetch(SERVICE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "text/x-gwt-rpc; charset=utf-8",
        "X-GWT-Module-Base": MODULE_BASE,
        "X-GWT-Permutation": schema.permutation,
        "x-Loseit-HoursFromGMT": String(this.gmtOffset()),
        Cookie: Object.entries(session.cookies)
          .map(([k, v]) => `${k}=${v}`)
          .join("; "),
      },
      body,
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
    const text = await resp.text();
    const debugDir = process.env.LOSEIT_DEBUG_DIR;
    if (debugDir) {
      const stamp = `${Date.now()}-${method}`;
      await mkdir(debugDir, { recursive: true });
      await writeFile(join(debugDir, `${stamp}.req.txt`), body);
      await writeFile(join(debugDir, `${stamp}.res.txt`), text);
    }

    if (resp.status === 401 || resp.status === 403) {
      if (retried) throw new LoseItError(`${method}: not authorized`, "unauthorized");
      await this.login();
      return this.callOnce(method, params, paramTypes, true);
    }
    if (!resp.ok) {
      // A stale build/policy surfaces as a 500 IncompatibleRemoteServiceException.
      if (!retried && /IncompatibleRemoteService|SerializationException/.test(text)) {
        return this.callOnce(method, params, paramTypes, true);
      }
      throw new LoseItError(`${method}: HTTP ${resp.status} ${text.slice(0, 300)}`, "http_error");
    }

    try {
      return decodeResponse(schema, text);
    } catch (err) {
      if (err instanceof GwtRemoteError) {
        if (!retried && /Authentication|NotLoggedIn|Session/i.test(err.message)) {
          await this.login();
          return this.callOnce(method, params, paramTypes, true);
        }
        if (!retried && /IncompatibleRemoteService/.test(err.message)) {
          return this.callOnce(method, params, paramTypes, true);
        }
        throw new LoseItError(`${method}: ${err.message}`, "remote_error");
      }
      throw err;
    }
  }
}
