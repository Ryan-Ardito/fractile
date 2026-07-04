// Fixed-point arithmetic on BigInt: a value x is stored as round(x * 2^bits).
// This is the precision backbone for deep zoom — tile addresses and the view
// center are exact, and only tiny *differences* are ever lowered to float64.

export const floatToFixed = (x: number, bits: number): bigint => {
  if (x === 0 || !Number.isFinite(x)) return 0n;
  const neg = x < 0;
  let v = neg ? -x : x;
  const ip = Math.floor(v);
  let acc = BigInt(ip);
  v -= ip;
  let remaining = bits;
  while (remaining > 0) {
    const s = Math.min(30, remaining);
    acc <<= BigInt(s);
    v *= 2 ** s;
    const chunk = Math.floor(v);
    acc += BigInt(chunk);
    v -= chunk;
    remaining -= s;
  }
  return neg ? -acc : acc;
};

export const fixedToFloat = (v: bigint, bits: number): number => {
  if (v === 0n) return 0;
  const neg = v < 0n;
  let a = neg ? -v : v;
  // Approximate bit length (within 3 bits) is enough to extract a full mantissa.
  const bitLength = a.toString(16).length * 4;
  const shift = bitLength - 56;
  if (shift > 0) a >>= BigInt(shift);
  else if (shift < 0) a <<= BigInt(-shift);
  const result = Number(a) * 2 ** (shift - bits);
  return neg ? -result : result;
};

export const rescale = (v: bigint, fromBits: number, toBits: number): bigint =>
  toBits >= fromBits ? v << BigInt(toBits - fromBits) : v >> BigInt(fromBits - toBits);

export const fixedMul = (a: bigint, b: bigint, bits: bigint): bigint =>
  (a * b) >> bits;

// --- extended-exponent helpers (arbitrary zoom) ---
//
// Past zoom ~1000, pixel-scale quantities (2^-zoom...) underflow float64.
// These helpers keep an explicit power-of-two exponent alongside a float64
// mantissa so the camera and the deep pixel path work at any depth.

export type FloatExp = { m: number; e: number };

// Fixed-point value as mantissa·2^e. The mantissa carries ~53 significant
// bits (|m| in [2^52, 2^56) up to the hex-length slop); consumers rescale by
// exponent differences, which stay small in every use here.
export const fixedToFloatExp = (v: bigint, bits: number): FloatExp => {
  if (v === 0n) return { m: 0, e: 0 };
  const neg = v < 0n;
  let a = neg ? -v : v;
  const bitLength = a.toString(16).length * 4;
  const shift = bitLength - 56;
  if (shift > 0) a >>= BigInt(shift);
  else if (shift < 0) a <<= BigInt(-shift);
  const m = Number(a);
  return { m: neg ? -m : m, e: shift - bits };
};

// Fixed-point value divided by 2^e, as float64 — i.e. the value measured in
// units of 2^e. Overflow to ±Infinity and underflow to 0 are both the
// correct saturations for every caller (ratios like "how many pixels").
export const fixedToFloatScaled = (v: bigint, bits: number, e: number): number => {
  if (v === 0n) return 0;
  const neg = v < 0n;
  let a = neg ? -v : v;
  const bitLength = a.toString(16).length * 4;
  const shift = bitLength - 56;
  if (shift > 0) a >>= BigInt(shift);
  else if (shift < 0) a <<= BigInt(-shift);
  const result = Number(a) * 2 ** (shift - bits - e);
  return neg ? -result : result;
};

// round(x · 2^e · 2^bits) — floatToFixed for values given as x·2^e, exact
// where floatToFixed is. x must be a normal float64 (the caller keeps the
// tiny scale in e); precision is x's own 53 bits.
export const floatToFixedShifted = (x: number, e: number, bits: number): bigint => {
  const base = floatToFixed(x, 52);
  const sh = bits + e - 52;
  return sh >= 0 ? base << BigInt(sh) : base >> BigInt(-sh);
};
