/** Thermal expansion of the rotor from a computed temperature field (spec 22.3).
 *
 * Takes the radial temperature profile from the conduction models
 * (`./thermalFdm.ts` / the section variant) and evaluates the classical
 * plane-stress thermoelastic solution for a free annular disc (Timoshenko &
 * Goodier, *Theory of Elasticity*, thermal-stress chapter):
 *
 *     s_r(r) = (r^2 - a^2) / (r^2 (b^2 - a^2)) * I(b)  -  I(r) / r^2
 *     s_t(r) = (r^2 + a^2) / (r^2 (b^2 - a^2)) * I(b)  +  I(r) / r^2  -  dT(r)
 *     with I(r) = integral_a^r dT(r') r' dr',  sigma = alpha * E * s
 *
 *     u(r) = r * alpha * ( s_t - nu * s_r + dT(r) )
 *
 * For a uniform temperature rise this reduces exactly to the free-growth result
 * `u = alpha * dT * r` with zero stress -- the anchor the tests pin.
 *
 * Assumptions (stated per the loud-assumptions convention):
 *
 * - **Free disc**: no restraint from the hat/buttons (floating rotors exist
 *   precisely to approximate this). Restraint would add mechanical stress and
 *   reduce growth.
 * - **Plane stress, thickness-averaged temperature**: valid for thin discs;
 *   through-thickness gradients are averaged out before evaluation. For stepped
 *   cross-sections the constant-thickness disc solution is an approximation.
 * - Displacements need only `thermal_expansion_1_k` and `poissons_ratio`;
 *   stresses additionally need `youngs_modulus_pa` (left `null` otherwise).
 * - `delta_t_c` is relative to the **reference (assembly) temperature** at
 *   which clearances were set -- growth is what changed since assembly.
 */
import { NeedsInputError } from "../errors.ts";
import type { RotorMaterial } from "../models/rotors.ts";

export interface ThermalExpansionResult {
  r_m: number[];
  delta_t_c: number[]; // thickness-averaged, vs reference temp
  radial_displacement_m: number[]; // u(r), positive outward
  outer_radial_growth_m: number; // u(b)
  outer_diametral_growth_m: number; // 2 u(b)
  hoop_stress_pa: number[] | null; // sigma_theta(r); null when E missing
  radial_stress_pa: number[] | null;
  peak_hoop_stress_pa: number | null;
}

/** Interpolated `u` at a radius inside the modeled domain. */
export function displacementAtRadiusM(result: ThermalExpansionResult, radiusM: number): number {
  const rFirst = result.r_m[0]!;
  const rLast = result.r_m[result.r_m.length - 1]!;
  if (!(rFirst <= radiusM && radiusM <= rLast)) {
    throw new Error(
      `radius ${(radiusM * 1000.0).toFixed(1)} mm is outside the modeled domain ` +
        `[${(rFirst * 1000.0).toFixed(1)}, ${(rLast * 1000.0).toFixed(1)}] mm`,
    );
  }
  return npInterp(radiusM, result.r_m, result.radial_displacement_m);
}

function isStrictlyIncreasing(r: number[]): boolean {
  for (let i = 1; i < r.length; i++) {
    if (r[i]! - r[i - 1]! <= 0.0) return false;
  }
  return true;
}

/** Free annular disc thermal growth from a radial temperature profile. */
export function radialExpansionFreeDisc(
  rM: number[],
  deltaTC: number[],
  material: RotorMaterial,
): ThermalExpansionResult {
  const r = rM;
  const deltaT = deltaTC;
  if (r.length < 2 || r.length !== deltaT.length) {
    throw new Error("r_m and delta_t_c must be matching 1D arrays with >= 2 points");
  }
  if (r[0]! <= 0.0 || !isStrictlyIncreasing(r)) {
    throw new Error("r_m must be strictly increasing and positive");
  }
  const alpha = material.thermal_expansion_1_k;
  if (alpha === null || alpha === undefined) {
    throw new NeedsInputError(`rotor_material[${material.name}].thermal_expansion_1_k`);
  }
  const nu = material.poissons_ratio;
  if (nu === null || nu === undefined) {
    throw new NeedsInputError(`rotor_material[${material.name}].poissons_ratio`);
  }

  const n = r.length;
  const a = r[0]!;
  const b = r[n - 1]!;

  // I(r) = cumulative integral of dT * r (trapezoid), I(a) = 0.
  const integrand = new Array<number>(n);
  for (let i = 0; i < n; i++) integrand[i] = deltaT[i]! * r[i]!;

  const cumulative = new Array<number>(n).fill(0.0);
  let running = 0.0;
  for (let i = 1; i < n; i++) {
    const dr = r[i]! - r[i - 1]!;
    running += 0.5 * (integrand[i]! + integrand[i - 1]!) * dr;
    cumulative[i] = running;
  }
  const total = cumulative[n - 1]!;

  const sR = new Array<number>(n);
  const sT = new Array<number>(n);
  const displacement = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const ri = r[i]!;
    sR[i] =
      ((ri ** 2 - a ** 2) / (ri ** 2 * (b ** 2 - a ** 2))) * total - cumulative[i]! / ri ** 2;
    sT[i] =
      ((ri ** 2 + a ** 2) / (ri ** 2 * (b ** 2 - a ** 2))) * total +
      cumulative[i]! / ri ** 2 -
      deltaT[i]!;
    displacement[i] = ri * alpha * (sT[i]! - nu * sR[i]! + deltaT[i]!);
  }

  const eModulus = material.youngs_modulus_pa;
  let hoop: number[] | null;
  let radial: number[] | null;
  let peakHoop: number | null;
  if (eModulus !== null && eModulus !== undefined) {
    hoop = new Array<number>(n);
    radial = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      hoop[i] = alpha * eModulus * sT[i]!;
      radial[i] = alpha * eModulus * sR[i]!;
    }
    // np.argmax(np.abs(hoop)) -- first extreme wins on ties.
    let bestIdx = 0;
    let bestAbs = Math.abs(hoop[0]!);
    for (let i = 1; i < n; i++) {
      const av = Math.abs(hoop[i]!);
      if (av > bestAbs) {
        bestAbs = av;
        bestIdx = i;
      }
    }
    peakHoop = hoop[bestIdx]!;
  } else {
    hoop = null;
    radial = null;
    peakHoop = null;
  }

  return {
    r_m: r,
    delta_t_c: deltaT,
    radial_displacement_m: displacement,
    outer_radial_growth_m: displacement[n - 1]!,
    outer_diametral_growth_m: 2.0 * displacement[n - 1]!,
    hoop_stress_pa: hoop,
    radial_stress_pa: radial,
    peak_hoop_stress_pa: peakHoop,
  };
}

/** Through-thickness strain `eps_z(r)` for the same plane-stress solution.
 *
 * Plane stress means `sigma_z = 0`, so the disc is free to grow through its
 * thickness:
 *
 *     eps_z = alpha * dT - nu * (sigma_r + sigma_theta) / E
 *
 * A uniform temperature rise is stress-free, which recovers the free-growth
 * value `alpha * dT` exactly. Without `youngs_modulus_pa` the stress terms
 * are unknown, so that free-growth value is returned as the (slightly larger)
 * fallback -- the Poisson correction is a few percent for realistic rotor
 * gradients.
 */
export function axialStrainProfile(
  result: ThermalExpansionResult,
  material: RotorMaterial,
): number[] {
  const alpha = material.thermal_expansion_1_k;
  if (alpha === null || alpha === undefined) {
    throw new NeedsInputError(`rotor_material[${material.name}].thermal_expansion_1_k`);
  }
  const freeGrowth = result.delta_t_c.map((dt) => alpha * dt);
  const eModulus = material.youngs_modulus_pa;
  if (result.hoop_stress_pa === null || eModulus === null || eModulus === undefined) {
    return freeGrowth;
  }
  const nu = material.poissons_ratio;
  if (nu === null || nu === undefined) {
    throw new NeedsInputError(`rotor_material[${material.name}].poissons_ratio`);
  }
  const radialStress = result.radial_stress_pa!;
  const hoopStress = result.hoop_stress_pa;
  return freeGrowth.map((fg, i) => fg - (nu * (radialStress[i]! + hoopStress[i]!)) / eModulus);
}

/** Thickness-averaged dT(r) from an annulus-model snapshot (n_axial, n_radial). */
export function annulusDeltaTProfile(
  temperatureC: number[][],
  zM: number[],
  referenceTemperatureC: number,
): number[] {
  const nAxial = temperatureC.length;
  const nRadial = temperatureC[0]!.length;
  const span = zM[zM.length - 1]! - zM[0]!;

  // np.trapezoid(temperature_c, z_m, axis=0): integrate down the axial rows
  // for each radial column.
  const integral = new Array<number>(nRadial).fill(0.0);
  for (let i = 0; i < nAxial - 1; i++) {
    const dz = zM[i + 1]! - zM[i]!;
    const rowA = temperatureC[i]!;
    const rowB = temperatureC[i + 1]!;
    for (let j = 0; j < nRadial; j++) {
      integral[j]! += 0.5 * (rowA[j]! + rowB[j]!) * dz;
    }
  }
  return integral.map((v) => v / span - referenceTemperatureC);
}

/** Thickness-averaged dT(r) from a section-model snapshot (NaN outside).
 *
 * Returns `[delta_t, valid]` where `valid` flags radial columns that contain
 * any material; callers should evaluate expansion on the valid (contiguous)
 * span only.
 */
export function sectionDeltaTProfile(
  temperatureC: number[][],
  referenceTemperatureC: number,
): [number[], boolean[]] {
  const nAxial = temperatureC.length;
  const nRadial = temperatureC[0]!.length;
  const averaged = new Array<number>(nRadial);
  const valid = new Array<boolean>(nRadial);
  for (let j = 0; j < nRadial; j++) {
    let sum = 0.0;
    let count = 0;
    for (let i = 0; i < nAxial; i++) {
      const v = temperatureC[i]![j]!;
      if (!Number.isNaN(v)) {
        sum += v;
        count++;
      }
    }
    const mean = count > 0 ? sum / count : NaN;
    averaged[j] = mean;
    valid[j] = !Number.isNaN(mean);
  }
  const deltaT = averaged.map((v) => v - referenceTemperatureC);
  return [deltaT, valid];
}

// --- small numpy-semantics helpers ------------------------------------------

/** np.interp: linear interpolation, clamped at both ends (never extrapolated). */
function npInterp(x: number, xp: number[], fp: number[]): number {
  const n = xp.length;
  if (x <= xp[0]!) return fp[0]!;
  if (x >= xp[n - 1]!) return fp[n - 1]!;
  for (let i = 0; i < n - 1; i++) {
    const x0 = xp[i]!;
    const x1 = xp[i + 1]!;
    if (x0 <= x && x <= x1) {
      if (x1 === x0) return fp[i]!;
      return fp[i]! + (fp[i + 1]! - fp[i]!) * ((x - x0) / (x1 - x0));
    }
  }
  return fp[n - 1]!; // unreachable given the bounds checks above
}
