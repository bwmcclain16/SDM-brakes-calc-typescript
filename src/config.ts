/** Configuration layer: schemas for the vehicle, brake hardware, rotor materials,
 * pad compounds, brake fluids, cooling parameters, tires, suspension, aero,
 * fasteners and rotor setups, plus loader functions and `*ToInternal()`
 * converters that turn config objects into the solver types.
 *
 * Mirrors `sdm_brakes/config.py`, with one deliberate architectural change: the
 * Python version reads YAML files from disk (`pathlib` + `yaml.safe_load`) and
 * validates them with pydantic. This is a STATIC BROWSER APP -- there is no
 * filesystem and no YAML parser dependency. Every `load_x(path)` function here
 * becomes `parseX(raw: unknown)`, which takes an ALREADY-PARSED plain JavaScript
 * value (the data files were converted to JSON at port time by
 * `tools/convert_data.py`, and it is the caller's job to `JSON.parse` them) and
 * performs only the pure validation/construction step.
 *
 * Validation is hand-written rather than delegated to a schema library (zero
 * runtime dependencies is a project-wide constraint): every required field is
 * checked for presence and type, and a missing or malformed field throws a
 * plain `Error` naming the offending field -- reproducing pydantic's
 * "catch bad data early with a readable message" job, not its full feature set.
 *
 * One data quirk this validation deliberately absorbs: PyYAML's default float
 * regex requires a SIGNED exponent (`[eE][-+][0-9]+`), so unsigned-exponent
 * literals like `1.0e8` fail to match and get resolved as plain strings
 * instead of floats. Pydantic's lax float coercion then accepts those numeric
 * strings transparently. Two fields in the shipped data are affected --
 * `brake_hardware.caliper_stiffness_n_per_m` ("1.0e8") and every fluid's
 * `bulk_modulus_pa` ("1.7e9") -- so every numeric field here accepts a
 * plain JSON number OR a numeric string, matching what pydantic actually did
 * with this exact data.
 */

import type {
  AxleBrake,
  BrakeHardware,
  Caliper,
  CoolingParameters,
  DriverMassSweep,
  Vehicle,
} from "./models/internal.ts";
import type { FastenerMaterial } from "./models/bobbins.ts";
import { fromPoints, type PadFrictionModel } from "./models/padFriction.ts";
import type { RotorMaterial } from "./models/rotors.ts";
import type { LoadSensitiveTire } from "./models/tires.ts";
import type { BrakeFluid } from "./models/fluid.ts";
import type { AxleSuspension, SuspensionSetup } from "./models/suspension.ts";
import type { CoefficientAero } from "./solvers/aero.ts";

// --- validation primitives -------------------------------------------------
// Small hand-written checks, not a schema library. Each throws a plain Error
// naming the offending field (dotted path) when a value is missing or the
// wrong type -- pydantic's job here, reproduced without the dependency.

function fieldPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function expectObject(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context}: expected an object, got ${describeType(value)}`);
  }
  return value as Record<string, unknown>;
}

function expectArray(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${context}: expected an array, got ${describeType(value)}`);
  }
  return value;
}

// Matches plain decimal/scientific-notation numeric literals only (no hex,
// no "Infinity"/"NaN" text, no underscores) -- see the module doc comment for
// why numeric strings need to be accepted at all.
const NUMERIC_STRING = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (NUMERIC_STRING.test(trimmed)) return Number(trimmed);
  }
  return undefined;
}

function requireNumber(obj: Record<string, unknown>, key: string, path: string): number {
  const raw = obj[key];
  const context = fieldPath(path, key);
  if (raw === undefined) throw new Error(`${context}: missing required field`);
  const n = toNumber(raw);
  if (n === undefined) throw new Error(`${context}: expected a number, got ${describeType(raw)}`);
  return n;
}

function optionalNumber(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): number | null | undefined {
  const raw = obj[key];
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const n = toNumber(raw);
  if (n === undefined) {
    throw new Error(`${fieldPath(path, key)}: expected a number or null, got ${describeType(raw)}`);
  }
  return n;
}

function numberWithDefault(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  fallback: number,
): number {
  const raw = obj[key];
  if (raw === undefined) return fallback;
  const n = toNumber(raw);
  if (n === undefined) {
    throw new Error(`${fieldPath(path, key)}: expected a number, got ${describeType(raw)}`);
  }
  return n;
}

function requireInt(obj: Record<string, unknown>, key: string, path: string): number {
  const n = requireNumber(obj, key, path);
  if (!Number.isInteger(n)) throw new Error(`${fieldPath(path, key)}: expected an integer, got ${n}`);
  return n;
}

function optionalInt(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): number | null | undefined {
  const n = optionalNumber(obj, key, path);
  if (n === null || n === undefined) return n;
  if (!Number.isInteger(n)) throw new Error(`${fieldPath(path, key)}: expected an integer, got ${n}`);
  return n;
}

function requireString(obj: Record<string, unknown>, key: string, path: string): string {
  const raw = obj[key];
  const context = fieldPath(path, key);
  if (raw === undefined) throw new Error(`${context}: missing required field`);
  if (typeof raw !== "string") throw new Error(`${context}: expected a string, got ${describeType(raw)}`);
  return raw;
}

function optionalString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): string | null | undefined {
  const raw = obj[key];
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string") {
    throw new Error(`${fieldPath(path, key)}: expected a string, got ${describeType(raw)}`);
  }
  return raw;
}

function booleanWithDefault(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  fallback: boolean,
): boolean {
  const raw = obj[key];
  if (raw === undefined) return fallback;
  if (typeof raw !== "boolean") {
    throw new Error(`${fieldPath(path, key)}: expected a boolean, got ${describeType(raw)}`);
  }
  return raw;
}

function requireNumberArray(obj: Record<string, unknown>, key: string, path: string): number[] {
  const context = fieldPath(path, key);
  const raw = obj[key];
  if (raw === undefined) throw new Error(`${context}: missing required field`);
  return expectArray(raw, context).map((v, i) => {
    const n = toNumber(v);
    if (n === undefined) throw new Error(`${context}[${i}]: expected a number, got ${describeType(v)}`);
    return n;
  });
}

function requireArrayField(obj: Record<string, unknown>, key: string, path: string): unknown[] {
  const context = fieldPath(path, key);
  const raw = obj[key];
  if (raw === undefined) throw new Error(`${context}: missing required field`);
  return expectArray(raw, context);
}

// --- shared source-provenance block ----------------------------------------

export interface SourceMetadata {
  source_title: string;
  source_url_or_file?: string | null;
  source_type: string;
  // Python allows `str | date`; the JSON conversion (tools/convert_data.py)
  // always emits ISO date strings, so only string survives here.
  date_accessed?: string | null;
  confidence: string;
  notes?: string | null;
}

function parseSourceMetadata(raw: unknown, path: string): SourceMetadata {
  const obj = expectObject(raw, path);
  return {
    source_title: requireString(obj, "source_title", path),
    source_url_or_file: optionalString(obj, "source_url_or_file", path),
    source_type: requireString(obj, "source_type", path),
    date_accessed: optionalString(obj, "date_accessed", path),
    confidence: requireString(obj, "confidence", path),
    notes: optionalString(obj, "notes", path),
  };
}

function parseOptionalSourceMetadata(raw: unknown, path: string): SourceMetadata | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  return parseSourceMetadata(raw, path);
}

// --- vehicle -----------------------------------------------------------------

export interface VehicleConfig {
  mass_without_driver_kg: number;
  static_front_weight_fraction: number;
  wheelbase_m: number;
  front_track_m: number;
  rear_track_m: number;
  cg_height_m: number;
  tire_rolling_radius_m: number;
  speed_sweep_mph: number[];
  single_stop_target_g: number;
  repeated_autocross_target_g: number;
  time_between_events_s: number[];
  source: SourceMetadata;
}

function parseVehicleConfig(raw: unknown, path: string): VehicleConfig {
  const obj = expectObject(raw, path);
  return {
    mass_without_driver_kg: requireNumber(obj, "mass_without_driver_kg", path),
    static_front_weight_fraction: requireNumber(obj, "static_front_weight_fraction", path),
    wheelbase_m: requireNumber(obj, "wheelbase_m", path),
    front_track_m: requireNumber(obj, "front_track_m", path),
    rear_track_m: requireNumber(obj, "rear_track_m", path),
    cg_height_m: requireNumber(obj, "cg_height_m", path),
    tire_rolling_radius_m: requireNumber(obj, "tire_rolling_radius_m", path),
    speed_sweep_mph: requireNumberArray(obj, "speed_sweep_mph", path),
    single_stop_target_g: requireNumber(obj, "single_stop_target_g", path),
    repeated_autocross_target_g: requireNumber(obj, "repeated_autocross_target_g", path),
    time_between_events_s: requireNumberArray(obj, "time_between_events_s", path),
    source: parseSourceMetadata(obj["source"], fieldPath(path, "source")),
  };
}

export function vehicleToInternal(config: VehicleConfig): Vehicle {
  return {
    mass_without_driver_kg: config.mass_without_driver_kg,
    static_front_weight_fraction: config.static_front_weight_fraction,
    wheelbase_m: config.wheelbase_m,
    front_track_m: config.front_track_m,
    rear_track_m: config.rear_track_m,
    cg_height_m: config.cg_height_m,
    tire_rolling_radius_m: config.tire_rolling_radius_m,
  };
}

// --- driver mass sweep ---------------------------------------------------

export interface DriverMassSweepConfig {
  min_kg: number;
  max_kg: number;
  points: number;
  source: SourceMetadata;
}

function parseDriverMassSweepConfig(raw: unknown, path: string): DriverMassSweepConfig {
  const obj = expectObject(raw, path);
  return {
    min_kg: requireNumber(obj, "min_kg", path),
    max_kg: requireNumber(obj, "max_kg", path),
    points: requireInt(obj, "points", path),
    source: parseSourceMetadata(obj["source"], fieldPath(path, "source")),
  };
}

export function driverMassSweepToInternal(config: DriverMassSweepConfig): DriverMassSweep {
  return { min_kg: config.min_kg, max_kg: config.max_kg, points: config.points };
}

// --- brake hardware --------------------------------------------------------

export interface CaliperConfig {
  name: string;
  piston_count: number;
  piston_diameter_mm: number;
  area_convention: string;
  source: SourceMetadata;
}

function parseCaliperConfig(raw: unknown, path: string): CaliperConfig {
  const obj = expectObject(raw, path);
  return {
    name: requireString(obj, "name", path),
    piston_count: requireInt(obj, "piston_count", path),
    piston_diameter_mm: requireNumber(obj, "piston_diameter_mm", path),
    area_convention: requireString(obj, "area_convention", path),
    source: parseSourceMetadata(obj["source"], fieldPath(path, "source")),
  };
}

export function caliperToInternal(config: CaliperConfig): Caliper {
  return {
    name: config.name,
    piston_count: config.piston_count,
    piston_diameter_mm: config.piston_diameter_mm,
    area_convention: config.area_convention,
  };
}

export interface AxleBrakeConfig {
  rotor_outer_diameter_mm: number;
  rotor_thickness_mm: number;
  rotor_mass_kg: number;
  pad_height_mm: number;
  caliper: CaliperConfig;
  rotor_material?: string | null;
  pad_swept_outer_diameter_mm?: number | null;
  pad_swept_inner_diameter_mm?: number | null;
  bobbin_count?: number | null;
  bobbin_circle_diameter_mm?: number | null;
  bobbin_button_diameter_mm?: number | null;
  bobbin_material?: string | null;
}

function parseAxleBrakeConfig(raw: unknown, path: string): AxleBrakeConfig {
  const obj = expectObject(raw, path);
  return {
    rotor_outer_diameter_mm: requireNumber(obj, "rotor_outer_diameter_mm", path),
    rotor_thickness_mm: requireNumber(obj, "rotor_thickness_mm", path),
    rotor_mass_kg: requireNumber(obj, "rotor_mass_kg", path),
    pad_height_mm: requireNumber(obj, "pad_height_mm", path),
    caliper: parseCaliperConfig(obj["caliper"], fieldPath(path, "caliper")),
    rotor_material: optionalString(obj, "rotor_material", path),
    pad_swept_outer_diameter_mm: optionalNumber(obj, "pad_swept_outer_diameter_mm", path),
    pad_swept_inner_diameter_mm: optionalNumber(obj, "pad_swept_inner_diameter_mm", path),
    bobbin_count: optionalInt(obj, "bobbin_count", path),
    bobbin_circle_diameter_mm: optionalNumber(obj, "bobbin_circle_diameter_mm", path),
    bobbin_button_diameter_mm: optionalNumber(obj, "bobbin_button_diameter_mm", path),
    bobbin_material: optionalString(obj, "bobbin_material", path),
  };
}

export function axleBrakeToInternal(config: AxleBrakeConfig): AxleBrake {
  return {
    rotor_outer_diameter_mm: config.rotor_outer_diameter_mm,
    rotor_thickness_mm: config.rotor_thickness_mm,
    rotor_mass_kg: config.rotor_mass_kg,
    pad_height_mm: config.pad_height_mm,
    caliper: caliperToInternal(config.caliper),
    rotor_material: config.rotor_material,
    pad_swept_outer_diameter_mm: config.pad_swept_outer_diameter_mm,
    pad_swept_inner_diameter_mm: config.pad_swept_inner_diameter_mm,
    bobbin_count: config.bobbin_count,
    bobbin_circle_diameter_mm: config.bobbin_circle_diameter_mm,
    bobbin_button_diameter_mm: config.bobbin_button_diameter_mm,
    bobbin_material: config.bobbin_material,
  };
}

export interface BrakeHardwareConfig {
  front: AxleBrakeConfig;
  rear: AxleBrakeConfig;
  front_pressure_fraction: number;
  rear_pressure_fraction: number;
  master_cylinder_bore_mm?: number | null;
  front_master_cylinder_bore_mm?: number | null;
  rear_master_cylinder_bore_mm?: number | null;
  pedal_ratio: number;
  pedal_efficiency: number;
  max_pedal_travel_deg: number;
  pad_friction_coefficient?: number | null;
  pedal_arm_length_mm?: number | null;
  caliper_stiffness_n_per_m?: number | null;
  system_fluid_volume_ml?: number | null;
  line_rated_pressure_pa?: number | null;
  source: SourceMetadata;
}

function parseBrakeHardwareConfig(raw: unknown, path: string): BrakeHardwareConfig {
  const obj = expectObject(raw, path);
  return {
    front: parseAxleBrakeConfig(obj["front"], fieldPath(path, "front")),
    rear: parseAxleBrakeConfig(obj["rear"], fieldPath(path, "rear")),
    front_pressure_fraction: requireNumber(obj, "front_pressure_fraction", path),
    rear_pressure_fraction: requireNumber(obj, "rear_pressure_fraction", path),
    master_cylinder_bore_mm: optionalNumber(obj, "master_cylinder_bore_mm", path),
    front_master_cylinder_bore_mm: optionalNumber(obj, "front_master_cylinder_bore_mm", path),
    rear_master_cylinder_bore_mm: optionalNumber(obj, "rear_master_cylinder_bore_mm", path),
    pedal_ratio: requireNumber(obj, "pedal_ratio", path),
    pedal_efficiency: numberWithDefault(obj, "pedal_efficiency", path, 0.8),
    max_pedal_travel_deg: requireNumber(obj, "max_pedal_travel_deg", path),
    pad_friction_coefficient: optionalNumber(obj, "pad_friction_coefficient", path),
    pedal_arm_length_mm: optionalNumber(obj, "pedal_arm_length_mm", path),
    caliper_stiffness_n_per_m: optionalNumber(obj, "caliper_stiffness_n_per_m", path),
    system_fluid_volume_ml: optionalNumber(obj, "system_fluid_volume_ml", path),
    line_rated_pressure_pa: optionalNumber(obj, "line_rated_pressure_pa", path),
    source: parseSourceMetadata(obj["source"], fieldPath(path, "source")),
  };
}

/** Dual master cylinders: front/rear circuits are hydraulically independent.
 * A circuit-specific bore wins; otherwise fall back to the shared
 * `master_cylinder_bore_mm`. Throws when neither is set. */
function resolveBoreMm(circuitBoreMm: number | null | undefined, sharedBoreMm: number | null | undefined): number {
  const bore = circuitBoreMm ?? sharedBoreMm;
  if (bore === null || bore === undefined) {
    throw new Error(
      "master cylinder bore missing: set front/rear bores or a shared master_cylinder_bore_mm",
    );
  }
  return bore;
}

export function brakeHardwareToInternal(config: BrakeHardwareConfig): BrakeHardware {
  if (!(0.0 < config.pedal_efficiency && config.pedal_efficiency < 1.0)) {
    throw new Error(
      "pedal_efficiency must be in (0, 1); a value of 1.0 (lossless pedal) is not permitted",
    );
  }
  return {
    front: axleBrakeToInternal(config.front),
    rear: axleBrakeToInternal(config.rear),
    front_pressure_fraction: config.front_pressure_fraction,
    rear_pressure_fraction: config.rear_pressure_fraction,
    front_master_cylinder_bore_mm: resolveBoreMm(
      config.front_master_cylinder_bore_mm,
      config.master_cylinder_bore_mm,
    ),
    rear_master_cylinder_bore_mm: resolveBoreMm(
      config.rear_master_cylinder_bore_mm,
      config.master_cylinder_bore_mm,
    ),
    pedal_ratio: config.pedal_ratio,
    pedal_efficiency: config.pedal_efficiency,
    max_pedal_travel_deg: config.max_pedal_travel_deg,
    pad_friction_coefficient: config.pad_friction_coefficient,
    pedal_arm_length_mm: config.pedal_arm_length_mm,
    caliper_stiffness_n_per_m: config.caliper_stiffness_n_per_m,
    system_fluid_volume_ml: config.system_fluid_volume_ml,
    line_rated_pressure_pa: config.line_rated_pressure_pa,
  };
}

// --- baseline config (vehicle + driver sweep + brake hardware) -------------

export interface BaselineConfig {
  vehicle: VehicleConfig;
  driver_mass_sweep: DriverMassSweepConfig;
  brake_hardware: BrakeHardwareConfig;
  // Python types this `list[dict[str, Any]]`: free-form audit trail entries,
  // deliberately not schema-validated beyond "array of objects".
  assumptions: Array<Record<string, unknown>>;
}

/** Parses an already-loaded vehicle baseline document (e.g. the contents of
 * `data/vehicles/fsae_2026_baseline.json`) into a `BaselineConfig`.
 * Replaces Python's `load_baseline_config(path)`. */
export function parseBaselineConfig(raw: unknown): BaselineConfig {
  const obj = expectObject(raw, "<baseline config>");
  return {
    vehicle: parseVehicleConfig(obj["vehicle"], "vehicle"),
    driver_mass_sweep: parseDriverMassSweepConfig(obj["driver_mass_sweep"], "driver_mass_sweep"),
    brake_hardware: parseBrakeHardwareConfig(obj["brake_hardware"], "brake_hardware"),
    assumptions: requireArrayField(obj, "assumptions", "").map((v, i) =>
      expectObject(v, `assumptions[${i}]`),
    ),
  };
}

// --- rotor materials ---------------------------------------------------------

// Field names mirror the JSON keys exactly (mixed-case unit suffixes,
// e.g. `specific_heat_J_kgK`), not full snake_case -- consistent with the
// rest of the port's "match the JSON keys exactly" convention.
export interface RotorMaterialConfig {
  name: string;
  density_kg_m3: number;
  specific_heat_J_kgK: number;
  thermal_conductivity_W_mK?: number | null;
  youngs_modulus_Pa?: number | null;
  poissons_ratio?: number | null;
  thermal_expansion_1_K?: number | null;
  yield_strength_Pa?: number | null;
  emissivity?: number | null;
  source?: string | null;
  confidence?: string | null;
}

function parseRotorMaterialConfig(raw: unknown, path: string): RotorMaterialConfig {
  const obj = expectObject(raw, path);
  return {
    name: requireString(obj, "name", path),
    density_kg_m3: requireNumber(obj, "density_kg_m3", path),
    specific_heat_J_kgK: requireNumber(obj, "specific_heat_J_kgK", path),
    thermal_conductivity_W_mK: optionalNumber(obj, "thermal_conductivity_W_mK", path),
    youngs_modulus_Pa: optionalNumber(obj, "youngs_modulus_Pa", path),
    poissons_ratio: optionalNumber(obj, "poissons_ratio", path),
    thermal_expansion_1_K: optionalNumber(obj, "thermal_expansion_1_K", path),
    yield_strength_Pa: optionalNumber(obj, "yield_strength_Pa", path),
    emissivity: optionalNumber(obj, "emissivity", path),
    source: optionalString(obj, "source", path),
    confidence: optionalString(obj, "confidence", path),
  };
}

export function rotorMaterialToInternal(config: RotorMaterialConfig): RotorMaterial {
  return {
    name: config.name,
    density_kg_m3: config.density_kg_m3,
    specific_heat_j_kgk: config.specific_heat_J_kgK,
    thermal_conductivity_w_mk: config.thermal_conductivity_W_mK,
    youngs_modulus_pa: config.youngs_modulus_Pa,
    poissons_ratio: config.poissons_ratio,
    thermal_expansion_1_k: config.thermal_expansion_1_K,
    yield_strength_pa: config.yield_strength_Pa,
    emissivity: config.emissivity,
  };
}

/** Parses an already-loaded `rotor_materials.json` document into a
 * name -> RotorMaterial map. Replaces Python's `load_rotor_materials(path)`. */
export function parseRotorMaterials(raw: unknown): Record<string, RotorMaterial> {
  const doc = expectObject(raw, "<rotor materials>");
  const result: Record<string, RotorMaterial> = {};
  requireArrayField(doc, "materials", "").forEach((entry, i) => {
    const config = parseRotorMaterialConfig(entry, `materials[${i}]`);
    result[config.name] = rotorMaterialToInternal(config);
  });
  return result;
}

// --- cooling -----------------------------------------------------------------

export interface CoolingConfig {
  convection_coefficient_W_m2K: number;
  emissivity: number;
  ambient_temperature_C: number;
  allowable_rotor_temperature_C: number;
  vane_area_multiplier: number;
  air_specific_heat_J_kgK: number;
  air_density_kg_m3: number;
  cooling_air_delta_T_C: number;
  rotor_heat_fraction: number;
  source?: SourceMetadata | null;
}

function parseCoolingConfig(raw: unknown, path: string): CoolingConfig {
  const obj = expectObject(raw, path);
  return {
    convection_coefficient_W_m2K: requireNumber(obj, "convection_coefficient_W_m2K", path),
    emissivity: requireNumber(obj, "emissivity", path),
    ambient_temperature_C: requireNumber(obj, "ambient_temperature_C", path),
    allowable_rotor_temperature_C: requireNumber(obj, "allowable_rotor_temperature_C", path),
    vane_area_multiplier: numberWithDefault(obj, "vane_area_multiplier", path, 1.0),
    air_specific_heat_J_kgK: numberWithDefault(obj, "air_specific_heat_J_kgK", path, 1005.0),
    air_density_kg_m3: numberWithDefault(obj, "air_density_kg_m3", path, 1.16),
    cooling_air_delta_T_C: numberWithDefault(obj, "cooling_air_delta_T_C", path, 30.0),
    rotor_heat_fraction: numberWithDefault(obj, "rotor_heat_fraction", path, 1.0),
    source: parseOptionalSourceMetadata(obj["source"], fieldPath(path, "source")),
  };
}

export function coolingToInternal(config: CoolingConfig): CoolingParameters {
  return {
    convection_coefficient_w_m2k: config.convection_coefficient_W_m2K,
    emissivity: config.emissivity,
    ambient_temperature_c: config.ambient_temperature_C,
    allowable_rotor_temperature_c: config.allowable_rotor_temperature_C,
    vane_area_multiplier: config.vane_area_multiplier,
    air_specific_heat_j_kgk: config.air_specific_heat_J_kgK,
    air_density_kg_m3: config.air_density_kg_m3,
    cooling_air_delta_t_c: config.cooling_air_delta_T_C,
    rotor_heat_fraction: config.rotor_heat_fraction,
  };
}

/** Parses an already-loaded `cooling_baseline.json` document (top-level
 * `cooling:` key) straight into `CoolingParameters`. Replaces Python's
 * `load_cooling_parameters(path)`. */
export function parseCoolingParameters(raw: unknown): CoolingParameters {
  const doc = expectObject(raw, "<cooling config>");
  const section = doc["cooling"];
  if (section === undefined) throw new Error("cooling: missing required field");
  return coolingToInternal(parseCoolingConfig(section, "cooling"));
}

// --- fastener materials (bobbin/button hardware) ----------------------------

export interface FastenerMaterialConfig {
  name: string;
  yield_strength_Pa: number;
  ultimate_strength_Pa?: number | null;
  shear_yield_strength_Pa?: number | null;
  density_kg_m3?: number | null;
  source?: string | null;
  confidence?: string | null;
}

function parseFastenerMaterialConfig(raw: unknown, path: string): FastenerMaterialConfig {
  const obj = expectObject(raw, path);
  return {
    name: requireString(obj, "name", path),
    yield_strength_Pa: requireNumber(obj, "yield_strength_Pa", path),
    ultimate_strength_Pa: optionalNumber(obj, "ultimate_strength_Pa", path),
    shear_yield_strength_Pa: optionalNumber(obj, "shear_yield_strength_Pa", path),
    density_kg_m3: optionalNumber(obj, "density_kg_m3", path),
    source: optionalString(obj, "source", path),
    confidence: optionalString(obj, "confidence", path),
  };
}

export function fastenerMaterialToInternal(config: FastenerMaterialConfig): FastenerMaterial {
  return {
    name: config.name,
    yield_strength_pa: config.yield_strength_Pa,
    ultimate_strength_pa: config.ultimate_strength_Pa,
    shear_yield_strength_pa: config.shear_yield_strength_Pa,
    density_kg_m3: config.density_kg_m3,
  };
}

/** Parses an already-loaded `fastener_materials.json` document into a
 * name -> FastenerMaterial map. Replaces Python's `load_fastener_materials(path)`. */
export function parseFastenerMaterials(raw: unknown): Record<string, FastenerMaterial> {
  const doc = expectObject(raw, "<fastener materials>");
  const result: Record<string, FastenerMaterial> = {};
  requireArrayField(doc, "materials", "").forEach((entry, i) => {
    const config = parseFastenerMaterialConfig(entry, `materials[${i}]`);
    result[config.name] = fastenerMaterialToInternal(config);
  });
  return result;
}

// --- pad friction (temperature-dependent mu curves) -------------------------

export interface PadFrictionTableConfig {
  design_mu?: number | null;
  points: Array<[number, number]>;
}

function parsePointPairs(raw: unknown, path: string): Array<[number, number]> {
  return expectArray(raw, path).map((pair, i) => {
    const pairContext = `${path}[${i}]`;
    const pairArr = expectArray(pair, pairContext);
    if (pairArr.length !== 2) {
      throw new Error(`${pairContext}: expected a [temperature, mu] pair, got ${pairArr.length} elements`);
    }
    const t = toNumber(pairArr[0]);
    const m = toNumber(pairArr[1]);
    if (t === undefined || m === undefined) {
      throw new Error(`${pairContext}: expected two numbers, got ${JSON.stringify(pair)}`);
    }
    return [t, m] as [number, number];
  });
}

function parsePadFrictionTableConfig(raw: unknown, path: string): PadFrictionTableConfig {
  const obj = expectObject(raw, path);
  const pointsContext = fieldPath(path, "points");
  const rawPoints = obj["points"];
  if (rawPoints === undefined) throw new Error(`${pointsContext}: missing required field`);
  return {
    design_mu: optionalNumber(obj, "design_mu", path),
    points: parsePointPairs(rawPoints, pointsContext),
  };
}

/** Parses an already-loaded `pad_compounds.json` document into a
 * name -> PadFrictionModel map. Replaces Python's `load_pad_friction_models(path)`.
 *
 * Only pads that carry a `mu_vs_temperature_table` are returned; pads with
 * just a prose `mu_vs_temperature` note are skipped (no callable curve yet). */
export function parsePadFrictionModels(raw: unknown): Record<string, PadFrictionModel> {
  const doc = expectObject(raw, "<pad compounds>");
  const result: Record<string, PadFrictionModel> = {};
  requireArrayField(doc, "pads", "").forEach((rawEntry, i) => {
    const entryPath = `pads[${i}]`;
    const entry = expectObject(rawEntry, entryPath);
    const table = entry["mu_vs_temperature_table"];
    if (table === undefined || table === null) return;
    const name = requireString(entry, "name", entryPath);
    const cfg = parsePadFrictionTableConfig(table, `${entryPath}.mu_vs_temperature_table`);
    const frictionCoefficient = optionalNumber(entry, "friction_coefficient", entryPath);
    const designMu = cfg.design_mu ?? frictionCoefficient ?? null;
    result[name] = fromPoints(name, cfg.points, designMu);
  });
  return result;
}

// --- coefficient aero (spec 11) ---------------------------------------------

export interface CoefficientAeroConfig {
  cl: number;
  cd: number;
  frontal_area_m2: number;
  air_density_kg_m3: number;
  x_cp0_m: number;
  k_pitch_m_per_deg: number;
  k_v_m_per_mps2: number;
  source?: SourceMetadata | null;
}

function parseCoefficientAeroConfig(raw: unknown, path: string): CoefficientAeroConfig {
  const obj = expectObject(raw, path);
  return {
    cl: requireNumber(obj, "cl", path),
    cd: requireNumber(obj, "cd", path),
    frontal_area_m2: requireNumber(obj, "frontal_area_m2", path),
    air_density_kg_m3: requireNumber(obj, "air_density_kg_m3", path),
    x_cp0_m: requireNumber(obj, "x_cp0_m", path),
    k_pitch_m_per_deg: numberWithDefault(obj, "k_pitch_m_per_deg", path, 0.0),
    k_v_m_per_mps2: numberWithDefault(obj, "k_v_m_per_mps2", path, 0.0),
    source: parseOptionalSourceMetadata(obj["source"], fieldPath(path, "source")),
  };
}

export function coefficientAeroToInternal(config: CoefficientAeroConfig): CoefficientAero {
  return {
    cl: config.cl,
    cd: config.cd,
    frontal_area_m2: config.frontal_area_m2,
    air_density_kg_m3: config.air_density_kg_m3,
    x_cp0_m: config.x_cp0_m,
    k_pitch_m_per_deg: config.k_pitch_m_per_deg,
    k_v_m_per_mps2: config.k_v_m_per_mps2,
  };
}

/** Parses an already-loaded `baseline_coefficient_aero.json` document
 * (top-level `coefficient_aero:` key) into a `CoefficientAero` (spec 11).
 * Replaces Python's `load_coefficient_aero(path)`. */
export function parseCoefficientAero(raw: unknown): CoefficientAero {
  const doc = expectObject(raw, "<coefficient aero config>");
  const section = doc["coefficient_aero"];
  if (section === undefined) throw new Error("coefficient_aero: missing required field");
  return coefficientAeroToInternal(parseCoefficientAeroConfig(section, "coefficient_aero"));
}

// --- suspension (spec 12.1) --------------------------------------------------

export interface AxleSuspensionConfig {
  spring_rate_n_per_m: number;
  motion_ratio: number;
  arb_roll_stiffness_nm_per_rad: number;
  roll_center_height_m: number;
  unsprung_mass_kg: number;
  unsprung_cg_height_m: number;
  tire_vertical_rate_n_per_m?: number | null;
}

function parseAxleSuspensionConfig(raw: unknown, path: string): AxleSuspensionConfig {
  const obj = expectObject(raw, path);
  return {
    spring_rate_n_per_m: requireNumber(obj, "spring_rate_n_per_m", path),
    motion_ratio: requireNumber(obj, "motion_ratio", path),
    arb_roll_stiffness_nm_per_rad: requireNumber(obj, "arb_roll_stiffness_nm_per_rad", path),
    roll_center_height_m: requireNumber(obj, "roll_center_height_m", path),
    unsprung_mass_kg: requireNumber(obj, "unsprung_mass_kg", path),
    unsprung_cg_height_m: requireNumber(obj, "unsprung_cg_height_m", path),
    tire_vertical_rate_n_per_m: optionalNumber(obj, "tire_vertical_rate_n_per_m", path),
  };
}

export function axleSuspensionToInternal(config: AxleSuspensionConfig): AxleSuspension {
  return {
    spring_rate_n_per_m: config.spring_rate_n_per_m,
    motion_ratio: config.motion_ratio,
    arb_roll_stiffness_nm_per_rad: config.arb_roll_stiffness_nm_per_rad,
    roll_center_height_m: config.roll_center_height_m,
    unsprung_mass_kg: config.unsprung_mass_kg,
    unsprung_cg_height_m: config.unsprung_cg_height_m,
    tire_vertical_rate_n_per_m: config.tire_vertical_rate_n_per_m,
  };
}

export interface SuspensionConfig {
  front: AxleSuspensionConfig;
  rear: AxleSuspensionConfig;
  source?: SourceMetadata | null;
}

function parseSuspensionConfig(raw: unknown, path: string): SuspensionConfig {
  const obj = expectObject(raw, path);
  return {
    front: parseAxleSuspensionConfig(obj["front"], fieldPath(path, "front")),
    rear: parseAxleSuspensionConfig(obj["rear"], fieldPath(path, "rear")),
    source: parseOptionalSourceMetadata(obj["source"], fieldPath(path, "source")),
  };
}

export function suspensionToInternal(config: SuspensionConfig): SuspensionSetup {
  return {
    front: axleSuspensionToInternal(config.front),
    rear: axleSuspensionToInternal(config.rear),
  };
}

/** Parses an already-loaded `baseline_suspension.json` document (top-level
 * `suspension:` key) into a `SuspensionSetup` (spec 12.1). Replaces Python's
 * `load_suspension(path)`. */
export function parseSuspension(raw: unknown): SuspensionSetup {
  const doc = expectObject(raw, "<suspension config>");
  const section = doc["suspension"];
  if (section === undefined) throw new Error("suspension: missing required field");
  return suspensionToInternal(parseSuspensionConfig(section, "suspension"));
}

// --- tires (spec 10.1) --------------------------------------------------------

export interface TireConfig {
  name: string;
  mu_ref: number;
  fz_ref_n: number;
  k_mu: number;
  mu_min: number;
  mu_max: number;
  lateral_mu_scale: number;
  source?: SourceMetadata | null;
}

function parseTireConfig(raw: unknown, path: string): TireConfig {
  const obj = expectObject(raw, path);
  return {
    name: requireString(obj, "name", path),
    mu_ref: requireNumber(obj, "mu_ref", path),
    fz_ref_n: requireNumber(obj, "fz_ref_n", path),
    k_mu: requireNumber(obj, "k_mu", path),
    mu_min: requireNumber(obj, "mu_min", path),
    mu_max: requireNumber(obj, "mu_max", path),
    lateral_mu_scale: numberWithDefault(obj, "lateral_mu_scale", path, 1.0),
    source: parseOptionalSourceMetadata(obj["source"], fieldPath(path, "source")),
  };
}

export function tireToInternal(config: TireConfig): LoadSensitiveTire {
  return {
    name: config.name,
    mu_ref: config.mu_ref,
    fz_ref_n: config.fz_ref_n,
    k_mu: config.k_mu,
    mu_min: config.mu_min,
    mu_max: config.mu_max,
    lateral_mu_scale: config.lateral_mu_scale,
  };
}

/** Parses an already-loaded tire JSON document (spec 10.1) into a
 * name -> LoadSensitiveTire map. Replaces Python's `load_tires(path)`. */
export function parseTires(raw: unknown): Record<string, LoadSensitiveTire> {
  const doc = expectObject(raw, "<tires config>");
  const result: Record<string, LoadSensitiveTire> = {};
  requireArrayField(doc, "tires", "").forEach((entry, i) => {
    const config = parseTireConfig(entry, `tires[${i}]`);
    result[config.name] = tireToInternal(config);
  });
  return result;
}

// --- brake fluids (spec 23.1) -------------------------------------------------

export interface BrakeFluidConfig {
  name: string;
  dry_boiling_point_c: number;
  wet_boiling_point_c?: number | null;
  bulk_modulus_pa?: number | null;
  density_kg_m3?: number | null;
  manufacturer?: string | null;
  dot_rating?: string | null;
  base_fluid: boolean;
  source?: SourceMetadata | null;
}

function parseBrakeFluidConfig(raw: unknown, path: string): BrakeFluidConfig {
  const obj = expectObject(raw, path);
  return {
    name: requireString(obj, "name", path),
    dry_boiling_point_c: requireNumber(obj, "dry_boiling_point_c", path),
    wet_boiling_point_c: optionalNumber(obj, "wet_boiling_point_c", path),
    bulk_modulus_pa: optionalNumber(obj, "bulk_modulus_pa", path),
    density_kg_m3: optionalNumber(obj, "density_kg_m3", path),
    manufacturer: optionalString(obj, "manufacturer", path),
    dot_rating: optionalString(obj, "dot_rating", path),
    base_fluid: booleanWithDefault(obj, "base_fluid", path, false),
    source: parseOptionalSourceMetadata(obj["source"], fieldPath(path, "source")),
  };
}

export function brakeFluidToInternal(config: BrakeFluidConfig): BrakeFluid {
  return {
    name: config.name,
    dry_boiling_point_c: config.dry_boiling_point_c,
    wet_boiling_point_c: config.wet_boiling_point_c,
    bulk_modulus_pa: config.bulk_modulus_pa,
    density_kg_m3: config.density_kg_m3,
    manufacturer: config.manufacturer,
    dot_rating: config.dot_rating,
    base_fluid: config.base_fluid,
  };
}

/** Parses an already-loaded `brake_fluids.json` document into a
 * name -> BrakeFluid map (spec 23.1). Replaces Python's `load_brake_fluids(path)`. */
export function parseBrakeFluids(raw: unknown): Record<string, BrakeFluid> {
  const doc = expectObject(raw, "<brake fluids config>");
  const result: Record<string, BrakeFluid> = {};
  requireArrayField(doc, "fluids", "").forEach((entry, i) => {
    const config = parseBrakeFluidConfig(entry, `fluids[${i}]`);
    result[config.name] = brakeFluidToInternal(config);
  });
  return result;
}

// --- rotor setup config (app "Rotor Setup" page) ----------------------------

/** One axle's rotor definition as stored in a rotor config file.
 *
 * Required fields are the geometry every solver needs; optional fields fall
 * back to whatever the active vehicle config already carries when omitted
 * (`null`/`undefined` means "keep the vehicle file's value", not "clear it"). */
export interface RotorSpecConfig {
  rotor_outer_diameter_mm: number;
  rotor_thickness_mm: number;
  rotor_mass_kg: number;
  rotor_material?: string | null;
  pad_height_mm?: number | null;
  pad_swept_outer_diameter_mm?: number | null;
  pad_swept_inner_diameter_mm?: number | null;
  bobbin_count?: number | null;
  bobbin_circle_diameter_mm?: number | null;
  bobbin_button_diameter_mm?: number | null;
  bobbin_material?: string | null;
}

function parseRotorSpecConfig(raw: unknown, path: string): RotorSpecConfig {
  const obj = expectObject(raw, path);
  return {
    rotor_outer_diameter_mm: requireNumber(obj, "rotor_outer_diameter_mm", path),
    rotor_thickness_mm: requireNumber(obj, "rotor_thickness_mm", path),
    rotor_mass_kg: requireNumber(obj, "rotor_mass_kg", path),
    rotor_material: optionalString(obj, "rotor_material", path),
    pad_height_mm: optionalNumber(obj, "pad_height_mm", path),
    pad_swept_outer_diameter_mm: optionalNumber(obj, "pad_swept_outer_diameter_mm", path),
    pad_swept_inner_diameter_mm: optionalNumber(obj, "pad_swept_inner_diameter_mm", path),
    bobbin_count: optionalInt(obj, "bobbin_count", path),
    bobbin_circle_diameter_mm: optionalNumber(obj, "bobbin_circle_diameter_mm", path),
    bobbin_button_diameter_mm: optionalNumber(obj, "bobbin_button_diameter_mm", path),
    bobbin_material: optionalString(obj, "bobbin_material", path),
  };
}

export interface RotorSetupConfig {
  front: RotorSpecConfig;
  rear: RotorSpecConfig;
}

function parseRotorSetupConfig(raw: unknown, path: string): RotorSetupConfig {
  const obj = expectObject(raw, path);
  return {
    front: parseRotorSpecConfig(obj["front"], fieldPath(path, "front")),
    rear: parseRotorSpecConfig(obj["rear"], fieldPath(path, "rear")),
  };
}

/** Parses an already-loaded rotor config document (`{ rotors: { front, rear } }`).
 * Replaces Python's `load_rotor_setup(path)`; the "not a rotor config file"
 * check has no file path to report here, so the message names the missing
 * key instead. */
export function parseRotorSetup(raw: unknown): RotorSetupConfig {
  const doc = expectObject(raw, "<rotor setup>");
  if (!("rotors" in doc) || doc["rotors"] === undefined) {
    throw new Error("rotors: missing top-level 'rotors' key (not a rotor config document)");
  }
  return parseRotorSetupConfig(doc["rotors"], "rotors");
}

function rotorSpecFromAxle(axle: AxleBrake): RotorSpecConfig {
  return {
    rotor_outer_diameter_mm: axle.rotor_outer_diameter_mm,
    rotor_thickness_mm: axle.rotor_thickness_mm,
    rotor_mass_kg: axle.rotor_mass_kg,
    rotor_material: axle.rotor_material,
    pad_height_mm: axle.pad_height_mm,
    pad_swept_outer_diameter_mm: axle.pad_swept_outer_diameter_mm,
    pad_swept_inner_diameter_mm: axle.pad_swept_inner_diameter_mm,
    bobbin_count: axle.bobbin_count,
    bobbin_circle_diameter_mm: axle.bobbin_circle_diameter_mm,
    bobbin_button_diameter_mm: axle.bobbin_button_diameter_mm,
    bobbin_material: axle.bobbin_material,
  };
}

/** Snapshot the rotor-relevant fields of a BrakeHardware into config form.
 * Port of Python's `rotor_setup_from_brakes`. (The Python `save_rotor_setup`,
 * which YAML-dumps this to disk, has no equivalent here -- there is no
 * filesystem in the browser target, and `RotorSetupConfig` is already a
 * plain JSON-safe object, so no further serialization step is needed.) */
export function rotorSetupFromBrakes(brakes: BrakeHardware): RotorSetupConfig {
  return { front: rotorSpecFromAxle(brakes.front), rear: rotorSpecFromAxle(brakes.rear) };
}

function applyRotorSpecToAxle(axle: AxleBrake, spec: RotorSpecConfig): AxleBrake {
  return {
    ...axle,
    rotor_outer_diameter_mm: spec.rotor_outer_diameter_mm,
    rotor_thickness_mm: spec.rotor_thickness_mm,
    rotor_mass_kg: spec.rotor_mass_kg,
    // Remaining fields: null/undefined means "keep the vehicle file's value"
    // -- mirrors Python's `if value is not None: updates[field] = value`.
    rotor_material: spec.rotor_material ?? axle.rotor_material,
    pad_height_mm: spec.pad_height_mm ?? axle.pad_height_mm,
    pad_swept_outer_diameter_mm: spec.pad_swept_outer_diameter_mm ?? axle.pad_swept_outer_diameter_mm,
    pad_swept_inner_diameter_mm: spec.pad_swept_inner_diameter_mm ?? axle.pad_swept_inner_diameter_mm,
    bobbin_count: spec.bobbin_count ?? axle.bobbin_count,
    bobbin_circle_diameter_mm: spec.bobbin_circle_diameter_mm ?? axle.bobbin_circle_diameter_mm,
    bobbin_button_diameter_mm: spec.bobbin_button_diameter_mm ?? axle.bobbin_button_diameter_mm,
    bobbin_material: spec.bobbin_material ?? axle.bobbin_material,
  };
}

/** Overlay a rotor config onto brake hardware (`null`/`undefined` fields keep
 * the old values). Port of Python's `apply_rotor_setup`; load-bearing for the
 * app's Rotor Setup page. */
export function applyRotorSetup(brakes: BrakeHardware, setup: RotorSetupConfig): BrakeHardware {
  return {
    ...brakes,
    front: applyRotorSpecToAxle(brakes.front, setup.front),
    rear: applyRotorSpecToAxle(brakes.rear, setup.rear),
  };
}
