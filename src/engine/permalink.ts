// URL-hash serialization of the view. The new format carries the center as
// hex fixed-point so deep locations survive the round trip; the legacy
// OpenLayers-era "#map=zoom/mercatorX/mercatorY" format is still parsed so
// old shared links keep working.

import { floatToFixed } from "./fixedPoint";

export type ViewState = {
  zoom: number;
  bits: number;
  cxFP: bigint;
  cyFP: bigint;
};

// Old world: EPSG:3857 meters, with 40075016.68... m spanning complex width 16.
const MERCATOR_PER_UNIT = 40075016.685578488 / 16;
const LEGACY_BITS = 128;

const fpToHex = (v: bigint): string =>
  v < 0n ? "-" + (-v).toString(16) : v.toString(16);

const hexToFp = (s: string): bigint =>
  s.startsWith("-") ? -BigInt("0x" + s.slice(1)) : BigInt("0x" + s);

export const serializeHash = (state: ViewState): string =>
  `#c=${state.zoom.toFixed(2)}/${state.bits}/${fpToHex(state.cxFP)}/${fpToHex(
    state.cyFP
  )}`;

export const parseHash = (hash: string): ViewState => {
  if (hash.startsWith("#c=")) {
    const parts = hash.slice(3).split("/");
    if (parts.length !== 4) throw new Error("invalid location hash");
    const zoom = parseFloat(parts[0]);
    const bits = parseInt(parts[1], 10);
    if (!Number.isFinite(zoom) || !Number.isInteger(bits) || bits <= 0) {
      throw new Error("invalid location hash");
    }
    return { zoom, bits, cxFP: hexToFp(parts[2]), cyFP: hexToFp(parts[3]) };
  }

  if (hash.startsWith("#map=")) {
    const parts = hash.slice(5).split("/");
    if (parts.length !== 3) throw new Error("invalid location hash");
    const zoom = parseFloat(parts[0]);
    const mx = parseFloat(parts[1]);
    const my = parseFloat(parts[2]);
    if (!Number.isFinite(zoom) || !Number.isFinite(mx) || !Number.isFinite(my)) {
      throw new Error("invalid location hash");
    }
    // Mercator y points north (screen up); our imaginary axis points down.
    return {
      zoom,
      bits: LEGACY_BITS,
      cxFP: floatToFixed(mx / MERCATOR_PER_UNIT, LEGACY_BITS),
      cyFP: floatToFixed(-my / MERCATOR_PER_UNIT, LEGACY_BITS),
    };
  }

  throw new Error("invalid location hash");
};
