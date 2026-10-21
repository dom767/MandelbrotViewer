/**
 * Per colour-scheme customisations in localStorage (doc + mapping).
 */

import {
  cloneDoc,
  docFromPreset,
  migratePresetId,
  DEFAULT_SCHEME_MAPPING,
} from "./gradient.js";

const STORAGE_KEY = "mandelbrot.colourSchemes";

function readAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

function writeAll(map) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* quota / private mode */
  }
}

/**
 * @returns {{ doc: object, offU: number, offV: number, densU: number, densV: number } | null}
 */
export function loadScheme(presetId) {
  const id = migratePresetId(presetId);
  const entry = readAll()[id];
  if (!entry?.doc) return null;
  return {
    doc: cloneDoc(entry.doc),
    offU: Number.isFinite(entry.offU) ? entry.offU : DEFAULT_SCHEME_MAPPING.offU,
    offV: Number.isFinite(entry.offV) ? entry.offV : DEFAULT_SCHEME_MAPPING.offV,
    densU: Number.isFinite(entry.densU) ? entry.densU : DEFAULT_SCHEME_MAPPING.densU,
    densV: Number.isFinite(entry.densV) ? entry.densV : DEFAULT_SCHEME_MAPPING.densV,
  };
}

/**
 * @param {string} presetId
 * @param {{ doc: object, offU?: number, offV?: number, densU?: number, densV?: number }} payload
 */
export function saveScheme(presetId, payload) {
  if (!payload?.doc) return;
  const id = migratePresetId(presetId);
  const map = readAll();
  map[id] = {
    doc: cloneDoc(payload.doc),
    offU: payload.offU ?? DEFAULT_SCHEME_MAPPING.offU,
    offV: payload.offV ?? DEFAULT_SCHEME_MAPPING.offV,
    densU: payload.densU ?? DEFAULT_SCHEME_MAPPING.densU,
    densV: payload.densV ?? DEFAULT_SCHEME_MAPPING.densV,
  };
  writeAll(map);
}

export function clearScheme(presetId) {
  const id = migratePresetId(presetId);
  const map = readAll();
  if (map[id] == null) return;
  delete map[id];
  writeAll(map);
}

/** Resolve stored scheme or factory default for a preset id. */
export function resolveScheme(presetId) {
  const id = migratePresetId(presetId);
  const stored = loadScheme(id);
  if (stored) {
    return {
      grad: id,
      gradDoc: stored.doc,
      offU: stored.offU,
      offV: stored.offV,
      densU: stored.densU,
      densV: stored.densV,
      goff: stored.offU,
      gdens: stored.densU,
    };
  }
  return {
    grad: id,
    gradDoc: docFromPreset(id),
    ...DEFAULT_SCHEME_MAPPING,
    goff: DEFAULT_SCHEME_MAPPING.offU,
    gdens: DEFAULT_SCHEME_MAPPING.densU,
  };
}

/** Persist current scheduler colour fields for the active scheme. */
export function saveSchemeFromParams(params) {
  const id = migratePresetId(params.grad || params.gradDoc?.presetId || "classic");
  const doc = params.gradDoc || docFromPreset(id);
  saveScheme(id, {
    doc,
    offU: params.offU ?? params.goff ?? DEFAULT_SCHEME_MAPPING.offU,
    offV: params.offV ?? DEFAULT_SCHEME_MAPPING.offV,
    densU: params.densU ?? params.gdens ?? DEFAULT_SCHEME_MAPPING.densU,
    densV: params.densV ?? DEFAULT_SCHEME_MAPPING.densV,
  });
}
