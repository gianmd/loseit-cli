/**
 * GWT-RPC encodes Java `long` values as base64 strings (big-endian, leading
 * zero digits dropped) using the alphabet below. `java.util.Date` is sent as
 * its epoch-millisecond long, so this is also how dates travel on the wire.
 */

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789$_";

const DIGIT = new Map([...ALPHABET].map((ch, i) => [ch, i]));

export function decodeLong(token: string): bigint {
  let value = 0n;
  for (const ch of token) {
    const digit = DIGIT.get(ch);
    if (digit === undefined) throw new Error(`invalid GWT long token: ${token}`);
    value = (value << 6n) | BigInt(digit);
  }
  return BigInt.asIntN(64, value);
}

export function encodeLong(input: bigint | number): string {
  let value = BigInt.asUintN(64, BigInt(input));
  if (value === 0n) return "A";
  let out = "";
  while (value > 0n) {
    out = ALPHABET[Number(value & 63n)] + out;
    value >>= 6n;
  }
  return out;
}
