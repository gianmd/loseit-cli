import { GObj } from "../gwt/codec.js";

export const SIG_DAY_DATE = "com.loseit.core.shared.model.DayDate";
export const SIG_DATE = "java.util.Date";

/** Lose It day numbers count days since 2000-12-31 (2001-01-01 is day 1). */
const EPOCH = Date.UTC(2000, 11, 31);
const DAY_MS = 86_400_000;

/** ISO `YYYY-MM-DD` → Lose It day number. */
export function dayNumber(iso: string): number {
  const [y, m, d] = parseIso(iso);
  return Math.round((Date.UTC(y, m - 1, d) - EPOCH) / DAY_MS);
}

export function isoFromDayNumber(day: number): string {
  return new Date(EPOCH + day * DAY_MS).toISOString().slice(0, 10);
}

function parseIso(iso: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`invalid date "${iso}" (expected YYYY-MM-DD)`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Today's date (YYYY-MM-DD) in the given IANA timezone. */
export function todayIso(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
}

export function addDays(iso: string, days: number): string {
  return isoFromDayNumber(dayNumber(iso) + days);
}

/**
 * Accepts YYYY-MM-DD, "today", "yesterday", "tomorrow" or a signed day offset
 * like "-2".
 */
export function resolveDate(input: string | undefined, timezone: string): string {
  const today = todayIso(timezone);
  if (!input || input === "today") return today;
  if (input === "yesterday") return addDays(today, -1);
  if (input === "tomorrow") return addDays(today, 1);
  if (/^[+-]\d+$/.test(input)) return addDays(today, Number(input));
  parseIso(input);
  return input;
}

/**
 * Build a DayDate as the web client does: the Date is local midnight (plus
 * one second) expressed in epoch ms, alongside the day number and GMT offset.
 */
export function makeDayDate(iso: string, gmtOffset: number): GObj {
  const [y, m, d] = parseIso(iso);
  const ms = Date.UTC(y, m - 1, d) - gmtOffset * 3_600_000 + 1000;
  return new GObj(SIG_DAY_DATE, [new GObj(SIG_DATE, [BigInt(ms)]), dayNumber(iso), gmtOffset]);
}
