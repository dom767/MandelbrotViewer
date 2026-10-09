/**
 * Split a JS Number (IEEE f64) into hi/lo f32 parts for GPU float-float.
 * hi + lo ≈ x with hi = round-to-f32(x).
 */
export function splitDouble(x) {
  const hi = Math.fround(x);
  const lo = Math.fround(x - hi);
  return { hi, lo };
}

/**
 * Binary frexp: x = mant * 2^exp with mant in [0.5, 1) (or zero).
 * Used to upload deep scales past f32 range as (mant, exp).
 */
export function frexpNumber(x) {
  if (!Number.isFinite(x) || x === 0) return { mant: 0, exp: 0 };
  const sign = x < 0 ? -1 : 1;
  const v = Math.abs(x);
  let exp = Math.floor(Math.log2(v)) + 1;
  let mant = v * 2 ** -exp;
  if (mant >= 1) {
    mant *= 0.5;
    exp += 1;
  } else if (mant > 0 && mant < 0.5) {
    mant *= 2;
    exp -= 1;
  }
  return { mant: Math.fround(sign * mant), exp };
}
