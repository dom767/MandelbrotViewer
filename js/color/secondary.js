/**
 * Secondary (V) axis algorithms — independent of gradient presets.
 * Iterate writes escape.y; the colour pass maps it into the LUT V coordinate.
 */

export const SECONDARY_FLAT = "flat";
export const SECONDARY_ANGLE = "angle";
export const SECONDARY_STRIPES = "stripes";
export const SECONDARY_DE = "de";
export const SECONDARY_TRAP = "trap";

/** Orbit-trap shapes (sub-option when V axis = Orbit trap). */
export const TRAP_SHAPE_CROSS = "cross";
export const TRAP_SHAPE_CIRCLE = "circle";

/** GPU / colour-pass numeric codes (iterate uniform colourMode). */
export const SECONDARY_CODE = {
  [SECONDARY_FLAT]: 0,
  [SECONDARY_ANGLE]: 1,
  [SECONDARY_STRIPES]: 2,
  [SECONDARY_DE]: 3,
  /** Cross trap (+). Circle uses code 5 via secondaryCode(..., shape). */
  [SECONDARY_TRAP]: 4,
};

export const SECONDARY_CODE_TRAP_CIRCLE = 5;

export const SECONDARY_OPTIONS = [
  { id: SECONDARY_FLAT, label: "Flat" },
  { id: SECONDARY_ANGLE, label: "Angle" },
  { id: SECONDARY_STRIPES, label: "Stripes" },
  { id: SECONDARY_DE, label: "Distance estimate" },
  { id: SECONDARY_TRAP, label: "Orbit trap" },
];

export const TRAP_SHAPE_OPTIONS = [
  { id: TRAP_SHAPE_CROSS, label: "Cross (+)" },
  { id: TRAP_SHAPE_CIRCLE, label: "Circle (o)" },
];

export function normalizeSecondary(id) {
  // Legacy URL / state: trapo was its own secondary.
  if (id === "trapo") return SECONDARY_TRAP;
  return SECONDARY_CODE[id] != null ? id : SECONDARY_FLAT;
}

export function normalizeTrapShape(shape) {
  if (shape === TRAP_SHAPE_CIRCLE) return TRAP_SHAPE_CIRCLE;
  return TRAP_SHAPE_CROSS;
}

/**
 * Iterate / colour-pass code for a secondary (+ optional trap shape).
 * @param {string} id
 * @param {string} [trapShape]
 */
export function secondaryCode(id, trapShape = TRAP_SHAPE_CROSS) {
  const s = normalizeSecondary(id);
  if (s === SECONDARY_TRAP) {
    return normalizeTrapShape(trapShape) === TRAP_SHAPE_CIRCLE
      ? SECONDARY_CODE_TRAP_CIRCLE
      : SECONDARY_CODE[SECONDARY_TRAP];
  }
  return SECONDARY_CODE[s] ?? 0;
}

/** Packed-angle path (A/2A blend) vs scalar float in escape.y vs ignore. */
export function secondaryColourKind(id) {
  const s = normalizeSecondary(id);
  if (s === SECONDARY_ANGLE) return "angle";
  if (s === SECONDARY_FLAT) return "flat";
  return "scalar";
}

export function isTrapSecondary(id) {
  return normalizeSecondary(id) === SECONDARY_TRAP;
}

export function secondaryNeedsIterateKnobs(id) {
  const s = normalizeSecondary(id);
  return s === SECONDARY_STRIPES || s === SECONDARY_DE || s === SECONDARY_TRAP;
}
