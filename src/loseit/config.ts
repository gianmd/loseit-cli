import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  email: string | undefined;
  password: string | undefined;
  timezone: string;
  home: string;
  timeoutMs: number;
}

/**
 * Credentials come from the environment, optionally seeded from
 * `$LOSEIT_HOME/.env` (default `~/.config/loseit`). Real environment variables
 * win. The working directory is ignored since agents call this from anywhere.
 */
export function loadConfig(): Config {
  const home = process.env.LOSEIT_HOME ?? join(homedir(), ".config", "loseit");
  const envFile = join(home, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  return {
    email: process.env.LOSEIT_EMAIL,
    password: process.env.LOSEIT_PASSWORD,
    timezone:
      process.env.LOSEIT_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    home,
    timeoutMs: Number(process.env.LOSEIT_TIMEOUT_MS ?? 30_000),
  };
}
