/** Parametric rotor geometry & material model (spec section 19).
 *
 * All public functions return SI units. Geometry inputs are accepted in mm at the
 * boundary (matching the rest of the data layer) and converted internally. Any
 * quantity that cannot be derived without missing CAD data raises
 * `NeedsInputError` rather than being silently invented -- consistent with the
 * package-wide loud-failure convention.
 *
 * Effective-radius convention (spec 19.6): two methods are provided. The team's
 * production default is *uniform wear* (`r_eff = (r_o + r_i)/2`), matching the
 * 24-25 workbook. The *uniform pressure* method is also provided for the CAD-data
 * track. The selected assumption is exposed via `EFFECTIVE_RADIUS_METHODS`
 * so it can be printed in every report.
 */
import { NeedsInputError } from "../errors.ts";
import { mmToM } from "../units.ts";

export interface RotorMaterial {
  name: string;
  density_kg_m3: number;
  specific_heat_j_kgk: number;
  thermal_conductivity_w_mk?: number | null;
  youngs_modulus_pa?: number | null;
  poissons_ratio?: number | null;
  thermal_expansion_1_k?: number | null;
  yield_strength_pa?: number | null;
  // Surface emissivity of the rotor in service (oxidized brake surface, not
  // polished stock) — drives the radiation cooling term.
  emissivity?: number | null;
}

/** A parametric rotor candidate.
 *
 * `inner_swept_diameter_mm` is the inner edge of the pad swept band. When it
 * is not supplied directly it can be derived from the radial pad length
 * (`pad_height_mm`) via `rotorGeometryFromSweptBand`. `hat_interface_diameter_mm`
 * is the inner edge of the *structural* annulus used for mass/inertia; it is a
 * CAD value and is optional -- functions that need it raise `NeedsInputError`
 * when it is absent so the gap is never hidden.
 */
export interface RotorGeometry {
  outer_diameter_mm: number;
  inner_swept_diameter_mm: number;
  thickness_mm: number;
  material: RotorMaterial;
  hat_interface_diameter_mm?: number | null;
  cutout_area_mm2?: number;
  hole_area_mm2?: number;
}

/** Build geometry from the radial pad swept length.
 *
 * `pad_height_mm` is the radial extent of the pad, so the swept band runs
 * from `r_o` inward by `pad_height`: `inner_swept_diameter = OD - 2*pad_height`.
 */
export function rotorGeometryFromSweptBand(
  outerDiameterMm: number,
  padHeightMm: number,
  thicknessMm: number,
  material: RotorMaterial,
  hatInterfaceDiameterMm: number | null = null,
  cutoutAreaMm2 = 0.0,
  holeAreaMm2 = 0.0,
): RotorGeometry {
  return {
    outer_diameter_mm: outerDiameterMm,
    inner_swept_diameter_mm: outerDiameterMm - 2.0 * padHeightMm,
    thickness_mm: thicknessMm,
    material,
    hat_interface_diameter_mm: hatInterfaceDiameterMm,
    cutout_area_mm2: cutoutAreaMm2,
    hole_area_mm2: holeAreaMm2,
  };
}

// --- radii -------------------------------------------------------------

export function outerRadiusM(geom: RotorGeometry): number {
  return mmToM(geom.outer_diameter_mm) / 2.0;
}

export function innerSweptRadiusM(geom: RotorGeometry): number {
  return mmToM(geom.inner_swept_diameter_mm) / 2.0;
}

export function hatRadiusM(geom: RotorGeometry): number {
  if (geom.hat_interface_diameter_mm === null || geom.hat_interface_diameter_mm === undefined) {
    throw new NeedsInputError("rotor.hat_interface_diameter_mm");
  }
  return mmToM(geom.hat_interface_diameter_mm) / 2.0;
}

// --- areas (spec 19.2) ---------------------------------------------------

/** Pad-swept friction band area, one face: `pi (r_o^2 - r_i,swept^2)`. */
export function sweptAnnulusAreaM2(geom: RotorGeometry): number {
  const rO = outerRadiusM(geom);
  const rI = innerSweptRadiusM(geom);
  return Math.PI * (rO ** 2 - rI ** 2);
}

/** Material annulus from the hat interface to OD (needs CAD hat radius). */
export function structuralAnnulusAreaM2(geom: RotorGeometry): number {
  const rO = outerRadiusM(geom);
  const rHat = hatRadiusM(geom);
  return Math.PI * (rO ** 2 - rHat ** 2);
}

/** `A_net = A_annulus - A_cutouts - A_holes` over the structural annulus. */
export function netAreaM2(geom: RotorGeometry): number {
  const cutoutsM2 = (geom.cutout_area_mm2 ?? 0.0) / 1.0e6;
  const holesM2 = (geom.hole_area_mm2 ?? 0.0) / 1.0e6;
  return structuralAnnulusAreaM2(geom) - cutoutsM2 - holesM2;
}

// --- mass, thermal mass, inertia (spec 19.3-19.5) -------------------------

/** `m = rho * t * A_net` (spec 19.3). Needs the CAD hat radius. */
export function rotorMassKg(geom: RotorGeometry): number {
  return geom.material.density_kg_m3 * mmToM(geom.thickness_mm) * netAreaM2(geom);
}

/** `C_thermal = m * c_p` (spec 19.4).
 *
 * `massKg` may be passed explicitly (e.g. a measured rotor mass) so thermal
 * sizing works before the CAD hat radius is available; otherwise the mass is
 * derived from geometry.
 */
export function thermalMassJK(geom: RotorGeometry, massKg: number | null = null): number {
  const mass = massKg === null || massKg === undefined ? rotorMassKg(geom) : massKg;
  return mass * geom.material.specific_heat_j_kgk;
}

/** Ideal annular disk `J_z = 0.5 m (r_o^2 + r_i^2)` (spec 19.5).
 *
 * Uses the structural annulus radii. `massKg` may be supplied to use a
 * measured mass; otherwise it is derived from geometry (needs hat radius).
 */
export function polarInertiaKgM2(geom: RotorGeometry, massKg: number | null = null): number {
  const mass = massKg === null || massKg === undefined ? rotorMassKg(geom) : massKg;
  const rO = outerRadiusM(geom);
  const rI = hatRadiusM(geom);
  return 0.5 * mass * (rO ** 2 + rI ** 2);
}

// --- cooling surface areas (spec 19.1) ------------------------------------

/** Two swept faces plus the outer cylindrical edge, treating the rotor as
 * a solid disc (no internal vanes). */
export function solidConvectiveAreaM2(geom: RotorGeometry): number {
  const rO = outerRadiusM(geom);
  const edge = 2.0 * Math.PI * rO * mmToM(geom.thickness_mm);
  return 2.0 * sweptAnnulusAreaM2(geom) + edge;
}

/** Heat-transfer surface area available for convection.
 *
 * `vaneAreaMultiplier` scales the solid-disc area to account for the extra
 * wetted area of a vented rotor's internal vanes. The default 1.0 treats the
 * rotor as solid (conservative). Supply the cooling-baseline value (and sweep
 * it) once vane geometry is known -- this replaces the former hard gap with an
 * explicit, documented parameter.
 */
export function convectiveAreaM2(geom: RotorGeometry, vaneAreaMultiplier = 1.0): number {
  return vaneAreaMultiplier * solidConvectiveAreaM2(geom);
}

export function radiationAreaM2(geom: RotorGeometry): number {
  // Radiation sees the external solid-disc surface only (internal vanes
  // radiate to each other), so it does not take the vane multiplier.
  return solidConvectiveAreaM2(geom);
}

// --- effective friction radius (spec 19.6) --------------------------------

export function uniformPressureEffectiveRadiusM(geom: RotorGeometry): number {
  const rO = outerRadiusM(geom);
  const rI = innerSweptRadiusM(geom);
  return (2.0 / 3.0) * (rO ** 3 - rI ** 3) / (rO ** 2 - rI ** 2);
}

export function uniformWearEffectiveRadiusM(geom: RotorGeometry): number {
  return (outerRadiusM(geom) + innerSweptRadiusM(geom)) / 2.0;
}

export const EFFECTIVE_RADIUS_METHODS: Record<string, (geom: RotorGeometry) => number> = {
  uniform_wear: uniformWearEffectiveRadiusM,
  uniform_pressure: uniformPressureEffectiveRadiusM,
};

//: Production default. Matches the 24-25 workbook `r_o - pad_height/2` form
//: (uniform wear == (r_o + r_i)/2). CAD-confirmation TODO: re-evaluate vs
//: uniform pressure once the exact pad swept location is known.
export const DEFAULT_EFFECTIVE_RADIUS_METHOD = "uniform_wear";

export function effectiveRadiusM(
  geom: RotorGeometry,
  method: string = DEFAULT_EFFECTIVE_RADIUS_METHOD,
): number {
  const fn = EFFECTIVE_RADIUS_METHODS[method];
  if (fn === undefined) {
    throw new Error(
      `unknown effective-radius method '${method}'. ` +
        `Use one of ${JSON.stringify(Object.keys(EFFECTIVE_RADIUS_METHODS).sort())}.`,
    );
  }
  return fn(geom);
}

// --- cutout risk flags (spec 19.7) ----------------------------------------

/** Lightweight screening flags for material removal (spec 19.7).
 *
 * Geometric pattern checks (sharp corners, cross-drilling density) need the
 * actual cutout layout and are out of scope here; this covers the quantitative
 * removal/ligament/edge checks that the parametric data supports.
 */
export function cutoutRiskFlags(
  geom: RotorGeometry,
  minLigamentWidthMm: number | null = null,
  minEdgeDistanceMm: number | null = null,
  maxRemovedAreaFraction = 0.30,
): string[] {
  const flags: string[] = [];
  const removed = (geom.cutout_area_mm2 ?? 0.0) + (geom.hole_area_mm2 ?? 0.0);
  const sweptMm2 = sweptAnnulusAreaM2(geom) * 1e6;
  if (sweptMm2 > 0 && removed / sweptMm2 > maxRemovedAreaFraction) {
    flags.push("excessive thermal-mass / surface-area removal");
  }
  if (minLigamentWidthMm !== null && minLigamentWidthMm !== undefined && minLigamentWidthMm < 3.0) {
    flags.push("insufficient ligament width");
  }
  if (minEdgeDistanceMm !== null && minEdgeDistanceMm !== undefined && minEdgeDistanceMm < 3.0) {
    flags.push("insufficient edge distance");
  }
  if (geom.thickness_mm < 3.0) {
    flags.push("thin rotor section");
  }
  return flags;
}
