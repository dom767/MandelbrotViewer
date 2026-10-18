/**
 * Secondary (V) axis algorithms — independent of gradient presets.
 * Iterate writes escape.y; the colour pass maps it into the LUT V coordinate.
 */

export const SECONDARY_FLAT = "flat";
export const SECONDARY_ANGLE = "angle";
export const SECONDARY_STRIPES = "stripes";
export const SECONDARY_DE = "de";
/** Cross (axes) orbit trap. */
export const SECONDARY_TRAP = "trap";
/** Circle orbit trap (|z| = 0.5). */
export const SECONDARY_TRAP_O = "trapo";

/** GPU / colour-pass numeric codes (iterate uniform colourMode). */
export const SECONDARY_CODE = {
  [SECONDARY_FLAT]: 0,
  [SECONDARY_ANGLE]: 1,
  [SECONDARY_STRIPES]: 2,
  [SECONDARY_DE]: 3,
  [SECONDARY_TRAP]: 4,
  [SECONDARY_TRAP_O]: 5,
};

export const SECONDARY_OPTIONS = [
  { id: SECONDARY_FLAT, label: "Flat" },
  { id: SECONDARY_ANGLE, label: "Angle" },
  { id: SECONDARY_STRIPES, label: "Stripes" },
  { id: SECONDARY_DE, label: "Distance estimate" },
  { id: SECONDARY_TRAP, label: "Orbit trap +" },
  { id: SECONDARY_TRAP_O, label: "Orbit trap o" },
];

export function normalizeSecondary(id) {
  return SECONDARY_CODE[id] != null ? id : SECONDARY_FLAT;
}

export function secondaryCode(id) {
  return SECONDARY_CODE[normalizeSecondary(id)] ?? 0;
}

/** Packed-angle path (A/2A blend) vs scalar float in escape.y vs ignore. */
export function secondaryColourKind(id) {
  const s = normalizeSecondary(id);
  if (s === SECONDARY_ANGLE) return "angle";
  if (s === SECONDARY_FLAT) return "flat";
  return "scalar";
}

export function isTrapSecondary(id) {
  const s = normalizeSecondary(id);
  return s === SECONDARY_TRAP || s === SECONDARY_TRAP_O;
}

export function secondaryNeedsIterateKnobs(id) {
  const s = normalizeSecondary(id);
  return s === SECONDARY_STRIPES || s === SECONDARY_DE;
}
