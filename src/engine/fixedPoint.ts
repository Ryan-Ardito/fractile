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
