/**
 * Shared iterate uniform size (bytes). Must match Params in iterator WGSL:
 * word 15 = pad / refLen, 16 = colourMode (secondary axis), 17 = stripeFreq,
 * 18 = stripeWindow, 19 = deGain.
 */
export const ITERATE_PARAMS_SIZE = 80;
