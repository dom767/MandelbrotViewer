import { fp32Iterator } from "./fp32.js";
import { floatFloatIterator } from "./floatFloat.js";
import { perturbationIterator } from "./perturbation.js";
import { perturbationScaledIterator } from "./perturbationScaled.js";
import { cpuRefIterator } from "./cpuRef.js";
import { cpuF64Iterator } from "./cpuF64.js";

const iterators = new Map();

export function registerIterator(iter) {
  iterators.set(iter.id, iter);
}

export function getIterator(id) {
  return iterators.get(id) ?? null;
}

export function listIterators() {
  return [...iterators.values()];
}

export function defaultIteratorId() {
  return "fp32";
}

registerIterator(fp32Iterator);
registerIterator(floatFloatIterator);
registerIterator(perturbationIterator);
registerIterator(perturbationScaledIterator);
registerIterator(cpuF64Iterator);
registerIterator(cpuRefIterator);
