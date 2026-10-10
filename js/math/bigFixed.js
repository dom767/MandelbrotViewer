/**
 * Signed fixed-point numbers with BigInt (FRAC fractional bits).
 * Used for the camera, perturbation reference orbit, and CPU reference iterate.
 */

/** Fractional bits: 384 ⇒ min quantum ~2^-384 ≈ 2.5e-116 (supports zoom ~1e90). */
export const FRAC_BITS = 384n;
const SCALE = 1n << FRAC_BITS;
const BAIL2 = 256;

export class Fixed {
  /** @param {bigint} raw */
  constructor(raw) {
    this.raw = raw;
  }

  static zero() {
    return new Fixed(0n);
  }

  /** Convert a JS Number into fixed-point (exact for dyadics within range). */
  static fromNumber(x) {
    if (!Number.isFinite(x) || x === 0) return Fixed.zero();
    const neg = x < 0;
    let v = Math.abs(x);
    const intPart = Math.floor(v);
    let frac = v - intPart;
    let raw = BigInt(intPart) << FRAC_BITS;
    let bitsLeft = Number(FRAC_BITS);
    while (bitsLeft > 0 && frac > 0) {
      const take = Math.min(32, bitsLeft);
      frac *= 2 ** take;
      const chunk = Math.floor(frac);
      frac -= chunk;
      bitsLeft -= take;
      if (chunk) raw += BigInt(chunk) << BigInt(bitsLeft);
    }
    return new Fixed(neg ? -raw : raw);
  }

  /**
   * Parse decimal or scientific string (e.g. "-0.75", "3.5e-18").
   * Keeps far more digits than JS Number.
   */
  static fromString(str, fallback = 0) {
    if (str instanceof Fixed) return str;
    if (typeof str === "number") return Fixed.fromNumber(str);
    if (str == null || str === "") return Fixed.fromNumber(fallback);
    const s = String(str).trim().toLowerCase();
    if (!s) return Fixed.fromNumber(fallback);
    const m = s.match(/^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/);
    if (!m) {
      const n = Number(s);
      return Number.isFinite(n) ? Fixed.fromNumber(n) : Fixed.fromNumber(fallback);
    }
    const neg = m[1] === "-";
    const intDigits = m[2] || "0";
    const fracDigits = m[3] || "";
    const exp = m[4] != null ? Number(m[4]) : 0;
    if (!Number.isFinite(exp)) return Fixed.fromNumber(fallback);

    // value = digits * 10^(exp - fracLen) with digits = int+frac as bigint
    const digits = BigInt(intDigits + fracDigits || "0");
    const exp10 = exp - fracDigits.length;
    let raw;
    if (exp10 >= 0) {
      raw = digits * pow10(exp10) * SCALE;
    } else {
      const den = pow10(-exp10);
      raw = (digits * SCALE) / den;
    }
    return new Fixed(neg ? -raw : raw);
  }

  /** Coerce Number | string | Fixed → Fixed (always a new instance). */
  static coerce(v, fallback = 0) {
    if (v instanceof Fixed) return v.copy();
    if (typeof v === "string") return Fixed.fromString(v, fallback);
    if (typeof v === "number") return Fixed.fromNumber(v);
    return Fixed.fromNumber(fallback);
  }

  /**
   * Best JS Number approximation. Uses the top 53 bits of the significand so
   * tiny scales (≪ 2^-53) still convert — the old "int + top frac bits" path
   * returned 0 for |x| < ~1.1e-16 and made the GPU see scale=0 (solid frame).
   */
  toNumber() {
    if (this.raw === 0n) return 0;
    const neg = this.raw < 0n;
    const r = neg ? -this.raw : this.raw;
    const bits = bigBitLength(r);
    // value = r * 2^(-FRAC) = mantissa * 2^(bits-1-FRAC)
    // where mantissa is the top 53 bits of r interpreted as an integer.
    const mShift = bits > 53n ? bits - 53n : 0n;
    const mantissa = Number(r >> mShift); // ≤ 53-bit integer
    const exp = Number(mShift) - Number(FRAC_BITS);
    const result = mantissa * 2 ** exp;
    return neg ? -result : result;
  }

  /**
   * Decimal string with enough digits for URL / deep zoom (scientific if huge/tiny).
   */
  toDecimalString(sigDigits = 48) {
    if (this.raw === 0n) return "0";
    const neg = this.raw < 0n;
    const r = neg ? -this.raw : this.raw;
    // r / 2^FRAC ≈ mantissa * 10^exp10
    // Use long division into decimal.
    const intPart = r >> FRAC_BITS;
    let frac = r & (SCALE - 1n);
    let intStr = intPart.toString();
    let fracStr = "";
    const maxFrac = Math.max(sigDigits, 1);
    for (let i = 0; i < maxFrac && frac !== 0n; i++) {
      frac *= 10n;
      const digit = frac >> FRAC_BITS;
      fracStr += digit.toString();
      frac &= SCALE - 1n;
    }
    // Trim trailing zeros in frac
    fracStr = fracStr.replace(/0+$/, "");
    let body = fracStr ? `${intStr}.${fracStr}` : intStr;
    // Scientific form when appropriate
    const nApprox = this.toNumber();
    if (
      Number.isFinite(nApprox) &&
      nApprox !== 0 &&
      (Math.abs(nApprox) >= 1e6 || Math.abs(nApprox) < 1e-3)
    ) {
      // Keep all requested digits (URL deep-zoom needs far more than 20).
      return this.toExponential(sigDigits);
    }
    return (neg ? "-" : "") + body;
  }

  /** Scientific notation string from fixed-point (works beyond Number range). */
  toExponential(fracDigits = 6) {
    if (this.raw === 0n) return "0.000000e+0";
    const neg = this.raw < 0n;
    let r = neg ? -this.raw : this.raw;
    // Find exponent such that mantissa in [1, 10)
    // value = r / 2^FRAC
    // log10(value) ≈ log10(r) - FRAC*log10(2)
    const bitLen = bigBitLength(r);
    // value ≈ 2^(bitLen-1 - FRAC) * (r / 2^(bitLen-1))
    const exp2 = Number(bitLen - 1n - FRAC_BITS);
    let exp10 = Math.floor(exp2 * Math.LOG10E * Math.LN2);
    // Refine: compute mantissa = value * 10^(-exp10) via integer math
    // mantissa_fixed = r * 10^(-exp10) / 2^FRAC, want ~[1,10) * SCALE
    let pow = exp10;
    let mantRaw;
    if (pow >= 0) {
      mantRaw = r / pow10(pow);
    } else {
      mantRaw = r * pow10(-pow);
    }
    // mantRaw is still over 2^FRAC scale; normalize to [1,10)
    // Compare mantRaw with SCALE (1.0) and 10*SCALE
    const one = SCALE;
    const ten = SCALE * 10n;
    while (mantRaw >= ten) {
      mantRaw /= 10n;
      exp10 += 1;
    }
    while (mantRaw > 0n && mantRaw < one) {
      mantRaw *= 10n;
      exp10 -= 1;
    }
    // Format mantissa with fracDigits after decimal
    const intDigit = mantRaw / SCALE;
    let frac = mantRaw % SCALE;
    let fracStr = "";
    for (let i = 0; i < fracDigits; i++) {
      frac *= 10n;
      fracStr += (frac / SCALE).toString();
      frac %= SCALE;
    }
    const sign = neg ? "-" : "";
    const eSign = exp10 >= 0 ? "+" : "-";
    return `${sign}${intDigit}.${fracStr}e${eSign}${Math.abs(exp10)}`;
  }

  add(o) {
    return new Fixed(this.raw + o.raw);
  }

  sub(o) {
    return new Fixed(this.raw - o.raw);
  }

  mul(o) {
    return new Fixed((this.raw * o.raw) >> FRAC_BITS);
  }

  /** this / o (fixed-point). */
  div(o) {
    if (o.raw === 0n) return Fixed.zero();
    return new Fixed((this.raw << FRAC_BITS) / o.raw);
  }

  neg() {
    return new Fixed(-this.raw);
  }

  abs() {
    return this.raw < 0n ? this.neg() : this;
  }

  copy() {
    return new Fixed(this.raw);
  }

  lt(o) {
    return this.raw < o.raw;
  }

  gt(o) {
    return this.raw > o.raw;
  }
}

function pow10(n) {
  let p = 1n;
  const N = Math.abs(n | 0);
  for (let i = 0; i < N; i++) p *= 10n;
  return p;
}

function bigBitLength(v) {
  if (v <= 0n) return 0n;
  let n = v;
  let bits = 0n;
  while (n > 0n) {
    n >>= 1n;
    bits += 1n;
  }
  return bits;
}

/**
 * Compute reference orbit at C = (cx, cy).
 * @returns {{ zs: Float32Array, len: number, escaped: boolean }}
 *   zs is interleaved Zx,Zy for n = 0 .. len-1 (Z_n used at each perturbation step).
 */
export function computeReferenceOrbit(cx, cy, maxIter) {
  const Cx = Fixed.coerce(cx);
  const Cy = Fixed.coerce(cy);
  let zx = Fixed.zero();
  let zy = Fixed.zero();

  const zs = new Float32Array(Math.max(maxIter, 1) * 2);
  let len = 0;
  let escaped = false;
  const bailRaw = Fixed.fromNumber(BAIL2).raw;

  for (let n = 0; n < maxIter; n++) {
    zs[n * 2] = zx.toNumber();
    zs[n * 2 + 1] = zy.toNumber();
    len = n + 1;

    const zx2 = zx.mul(zx);
    const zy2 = zy.mul(zy);
    if (zx2.raw + zy2.raw > bailRaw) {
      escaped = true;
      break;
    }

    // z = z^2 + c
    const twoxy = zx.mul(zy);
    const nx = zx2.sub(zy2).add(Cx);
    const ny = twoxy.add(twoxy).add(Cy);
    zx = nx;
    zy = ny;
  }

  return { zs: zs.subarray(0, len * 2), len, escaped };
}

/**
 * Smooth Mandelbrot iteration in fixed-point (same bailout / continuous
 * potential as the GPU shaders). Returns -1 for interior.
 */
export function mandelSmoothFixed(cx, cy, maxIter) {
  const Cx = cx instanceof Fixed ? cx : Fixed.fromNumber(cx);
  const Cy = cy instanceof Fixed ? cy : Fixed.fromNumber(cy);
  let zx = Fixed.zero();
  let zy = Fixed.zero();
  const bailRaw = Fixed.fromNumber(BAIL2).raw;

  for (let i = 0; i < maxIter; i++) {
    const zx2 = zx.mul(zx);
    const zy2 = zy.mul(zy);
    const mag2Raw = zx2.raw + zy2.raw;
    if (mag2Raw > bailRaw) {
      const mag2 = new Fixed(mag2Raw).toNumber();
      const logZn = Math.log2(mag2) * 0.5;
      return i + 1 - Math.log2(logZn);
    }
    const twoxy = zx.mul(zy);
    const nx = zx2.sub(zy2).add(Cx);
    const ny = twoxy.add(twoxy).add(Cy);
    zx = nx;
    zy = ny;
  }
  return -1;
}

/** Map pixel + subpixel offset into the complex plane (Fixed). */
export function complexFromPixelFixed(
  centerX,
  centerY,
  scale,
  aspect,
  width,
  height,
  px,
  py,
  sxOff,
  syOff
) {
  const u = (px + sxOff) / width;
  const v = (py + syOff) / height;
  const sc = Fixed.coerce(scale);
  const cx = Fixed.coerce(centerX).add(Fixed.fromNumber(u - 0.5).mul(sc));
  const cy = Fixed.coerce(centerY).sub(
    Fixed.fromNumber(v - 0.5).mul(sc).mul(Fixed.fromNumber(1 / aspect))
  );
  return { x: cx, y: cy };
}
