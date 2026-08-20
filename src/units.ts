/** Unit conversions.
 *
 * Python used `pint` here, but only for three fixed conversions with constant
 * factors -- the registry bought nothing at runtime and cost a dependency.
 * These are the exact factors pint resolves to, so results are bit-identical.
 * (Verified against the golden fixtures.) */
import { MPH_TO_MPS, MM_TO_M } from "./constants.ts";

export const mphToMps = (speedMph: number): number => speedMph * MPH_TO_MPS;
export const mmToM = (lengthMm: number): number => lengthMm * MM_TO_M;
export const areaMm2ToM2 = (areaMm2: number): number => areaMm2 * 1e-6;
