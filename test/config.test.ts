/** config.ts has no golden-fixture coverage (config.py is I/O-heavy pydantic
 * validation, not a pure numeric function the Python fixture extractor
 * targets), so this loads the REAL JSON data files from `data/` directly
 * (via node:fs + JSON.parse -- only in this test; the library itself stays
 * IO-free) and exercises the parsers/converters against them. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  applyRotorSetup,
  brakeFluidToInternal,
  brakeHardwareToInternal,
  parseBaselineConfig,
  parseBrakeFluids,
  parseCoefficientAero,
  parseCoolingParameters,
  parseFastenerMaterials,
  parsePadFrictionModels,
  parseRotorMaterials,
  parseRotorSetup,
  parseSuspension,
  parseTires,
  rotorSetupFromBrakes,
  vehicleToInternal,
} from "../src/config.ts";
import type { AxleBrake, BrakeHardware, Caliper } from "../src/models/internal.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, "..", "data");

function loadJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(join(DATA_DIR, relativePath), "utf8"));
}

// --- vehicle / baseline config -----------------------------------------------

test("baseline vehicle config parses and vehicleToInternal produces the expected values", () => {
  const raw = loadJson("vehicles/fsae_2026_baseline.json");
  const baseline = parseBaselineConfig(raw);
  const vehicle = vehicleToInternal(baseline.vehicle);

  assert.equal(vehicle.mass_without_driver_kg, 199.02);
  assert.equal(vehicle.wheelbase_m, 1.53);
  assert.equal(vehicle.cg_height_m, 0.2845);
  assert.equal(vehicle.front_track_m, 1.207);
  assert.equal(vehicle.rear_track_m, 1.194);
  assert.equal(vehicle.static_front_weight_fraction, 0.476);
  assert.equal(vehicle.tire_rolling_radius_m, 0.1778);

  assert.equal(baseline.driver_mass_sweep.points, 9);
  assert.equal(baseline.assumptions.length, 7);
});

test("baseline brake hardware resolves the shared master cylinder bore and the quoted-scientific-notation caliper stiffness", () => {
  const raw = loadJson("vehicles/fsae_2026_baseline.json");
  const baseline = parseBaselineConfig(raw);
  const hardware = brakeHardwareToInternal(baseline.brake_hardware);

  // Both circuits fall back to the shared master_cylinder_bore_mm (15.875).
  assert.equal(hardware.front_master_cylinder_bore_mm, 15.875);
  assert.equal(hardware.rear_master_cylinder_bore_mm, 15.875);

  // The source JSON stores this as the STRING "1.0e8" (a PyYAML quirk: its
  // float regex requires a signed exponent, so unsigned "1.0e8" resolves as
  // a plain string). The parser must coerce it the same way pydantic did.
  assert.equal(hardware.caliper_stiffness_n_per_m, 1.0e8);
  assert.equal(typeof hardware.caliper_stiffness_n_per_m, "number");

  assert.equal(hardware.front.caliper.piston_count, 4);
  assert.equal(hardware.rear.caliper.piston_count, 2);
  assert.equal(hardware.pedal_efficiency, 0.8);
});

// --- rotor materials ----------------------------------------------------------

test("rotor materials parse and 1020 steel has the expected properties", () => {
  const raw = loadJson("materials/rotor_materials.json");
  const materials = parseRotorMaterials(raw);

  const steel = materials["1020 steel"];
  assert.ok(steel, "expected a '1020 steel' entry");
  assert.equal(steel.density_kg_m3, 7870);
  assert.equal(steel.specific_heat_j_kgk, 486);
  assert.equal(steel.thermal_conductivity_w_mk, 51.9);
});

// --- cooling parameters ---------------------------------------------------------

test("cooling parameters parse to the documented baseline values", () => {
  const raw = loadJson("thermal/cooling_baseline.json");
  const cooling = parseCoolingParameters(raw);

  assert.equal(cooling.convection_coefficient_w_m2k, 60);
  assert.equal(cooling.emissivity, 0.55);
  assert.equal(cooling.ambient_temperature_c, 35);
  assert.equal(cooling.allowable_rotor_temperature_c, 500);
});

// --- fastener materials / brake fluids / tires / pads / aero / suspension ------

test("fastener materials parse (bobbin/button hardware)", () => {
  const materials = parseFastenerMaterials(loadJson("materials/fastener_materials.json"));
  const ti = materials["Ti-6Al-4V"];
  assert.ok(ti, "expected a 'Ti-6Al-4V' entry");
  assert.equal(ti.yield_strength_pa, 880_000_000);
  assert.equal(ti.shear_yield_strength_pa, null);
});

test("brake fluids parse and coerce the quoted-scientific-notation bulk modulus", () => {
  const fluids = parseBrakeFluids(loadJson("materials/brake_fluids.json"));
  const motul = fluids["Motul RBF660 Factory Line"];
  assert.ok(motul, "expected a 'Motul RBF660 Factory Line' entry");
  assert.equal(motul.bulk_modulus_pa, 1.7e9);
  assert.equal(typeof motul.bulk_modulus_pa, "number");
  assert.equal(motul.base_fluid, true);
  // base_fluid defaults to false when the document omits it.
  const rh665 = fluids["Performance Friction RH665"];
  assert.equal(rh665?.base_fluid, false);
});

test("tires parse (spec 10.1)", () => {
  const tires = parseTires(loadJson("tires/generic_load_sensitive_mu.json"));
  const slick = tires["generic_fsae_slick"];
  assert.ok(slick, "expected a 'generic_fsae_slick' entry");
  assert.equal(slick.mu_ref, 1.6);
  assert.equal(slick.fz_ref_n, 690);
});

test("pad friction models parse only the pads carrying a mu_vs_temperature_table", () => {
  const pads = parsePadFrictionModels(loadJson("materials/pad_compounds.json"));
  const h38 = pads["Brembo H38 sintered"];
  assert.ok(h38, "expected a 'Brembo H38 sintered' entry");
  assert.equal(h38.design_mu, 0.48);
  assert.equal(h38.temperatures_c[0], 100);
  assert.equal(h38.mu_values[0], 0.54);
});

test("coefficient aero parses (spec 11)", () => {
  const aero = parseCoefficientAero(loadJson("aero/baseline_coefficient_aero.json"));
  assert.equal(aero.cl, 3.0);
  assert.equal(aero.cd, 1.4);
  assert.equal(aero.x_cp0_m, 0.8415);
});

test("suspension parses (spec 12.1)", () => {
  const suspension = parseSuspension(loadJson("suspension/baseline_suspension.json"));
  assert.equal(suspension.front.spring_rate_n_per_m, 35000);
  assert.equal(suspension.rear.motion_ratio, 0.9);
});

// --- rotor setup overlay --------------------------------------------------------

function fakeCaliper(): Caliper {
  return { name: "test caliper", piston_count: 4, piston_diameter_mm: 24, area_convention: "total_active_piston_area" };
}

function fakeAxle(overrides: Partial<AxleBrake> = {}): AxleBrake {
  return {
    rotor_outer_diameter_mm: 183,
    rotor_thickness_mm: 4,
    rotor_mass_kg: 0.8,
    pad_height_mm: 34.5,
    caliper: fakeCaliper(),
    rotor_material: "1020 steel",
    pad_swept_outer_diameter_mm: 182,
    pad_swept_inner_diameter_mm: 148,
    bobbin_count: 6,
    bobbin_circle_diameter_mm: 145,
    bobbin_button_diameter_mm: 8,
    bobbin_material: "Ti-6Al-4V",
    ...overrides,
  };
}

function fakeBrakeHardware(): BrakeHardware {
  return {
    front: fakeAxle(),
    rear: fakeAxle({ rotor_outer_diameter_mm: 165, pad_height_mm: 25 }),
    front_pressure_fraction: 0.55,
    rear_pressure_fraction: 0.45,
    front_master_cylinder_bore_mm: 15.875,
    rear_master_cylinder_bore_mm: 15.875,
    pedal_ratio: 3.4,
    pedal_efficiency: 0.8,
    max_pedal_travel_deg: 10.0,
    pad_friction_coefficient: 0.48,
  };
}

test("parseRotorSetup + applyRotorSetup overlays a rotor config, leaving absent fields untouched", () => {
  const raw = loadJson("rotors/SDM26_Rotor.json");
  const setup = parseRotorSetup(raw);

  const brakes = fakeBrakeHardware();
  const updated = applyRotorSetup(brakes, setup);

  // Required geometry fields are always overwritten from the rotor config.
  assert.equal(updated.front.rotor_outer_diameter_mm, 183.0);
  assert.equal(updated.front.rotor_mass_kg, 0.451);
  assert.equal(updated.front.pad_height_mm, 25.6);
  assert.equal(updated.front.bobbin_count, 3);
  assert.equal(updated.front.bobbin_material, "7075-T6 aluminum");
  assert.equal(updated.rear.rotor_mass_kg, 0.269);

  // Fields the caller never touches (pressure fractions, pedal ratio, ...)
  // pass straight through untouched.
  assert.equal(updated.front_pressure_fraction, brakes.front_pressure_fraction);
  assert.equal(updated.pedal_ratio, brakes.pedal_ratio);
  assert.equal(updated.front.caliper, brakes.front.caliper);
});

test("applyRotorSetup keeps the old value when an optional rotor-spec field is absent", () => {
  const brakes = fakeBrakeHardware();
  // A rotor spec that only sets the three REQUIRED geometry fields; every
  // optional field is omitted, so applyRotorSetup must keep the vehicle's
  // existing values for all of them (Python: "None means keep, not clear").
  const minimalSetup = {
    front: { rotor_outer_diameter_mm: 190, rotor_thickness_mm: 5, rotor_mass_kg: 0.9 },
    rear: { rotor_outer_diameter_mm: 170, rotor_thickness_mm: 5, rotor_mass_kg: 0.7 },
  };

  const updated = applyRotorSetup(brakes, minimalSetup);

  assert.equal(updated.front.rotor_outer_diameter_mm, 190);
  assert.equal(updated.front.rotor_thickness_mm, 5);
  assert.equal(updated.front.rotor_mass_kg, 0.9);
  // Untouched -- carried over from the original brake hardware.
  assert.equal(updated.front.pad_height_mm, brakes.front.pad_height_mm);
  assert.equal(updated.front.rotor_material, brakes.front.rotor_material);
  assert.equal(updated.front.pad_swept_outer_diameter_mm, brakes.front.pad_swept_outer_diameter_mm);
  assert.equal(updated.front.bobbin_count, brakes.front.bobbin_count);
  assert.equal(updated.front.bobbin_circle_diameter_mm, brakes.front.bobbin_circle_diameter_mm);
  assert.equal(updated.front.bobbin_button_diameter_mm, brakes.front.bobbin_button_diameter_mm);
  assert.equal(updated.front.bobbin_material, brakes.front.bobbin_material);
  assert.equal(updated.rear.rotor_material, brakes.rear.rotor_material);
});

test("rotorSetupFromBrakes + applyRotorSetup round-trips a snapshot back onto itself unchanged", () => {
  const brakes = fakeBrakeHardware();
  const snapshot = rotorSetupFromBrakes(brakes);
  const roundTripped = applyRotorSetup(brakes, snapshot);
  assert.deepEqual(roundTripped, brakes);
});

// --- malformed input reporting ---------------------------------------------

test("a malformed baseline config throws with a message naming the bad field", () => {
  const raw = loadJson("vehicles/fsae_2026_baseline.json") as Record<string, unknown>;
  const vehicle = raw["vehicle"] as Record<string, unknown>;
  const broken = { ...raw, vehicle: { ...vehicle, wheelbase_m: "not-a-number" } };

  assert.throws(() => parseBaselineConfig(broken), /vehicle\.wheelbase_m/);
});

test("a missing required field throws with a message naming the bad field", () => {
  const raw = loadJson("vehicles/fsae_2026_baseline.json") as Record<string, unknown>;
  const vehicle = raw["vehicle"] as Record<string, unknown>;
  const { cg_height_m: _drop, ...vehicleWithoutCgHeight } = vehicle;
  const broken = { ...raw, vehicle: vehicleWithoutCgHeight };

  assert.throws(() => parseBaselineConfig(broken), /vehicle\.cg_height_m/);
});

test("a rotor config missing the top-level 'rotors' key throws naming it", () => {
  assert.throws(() => parseRotorSetup({ front: {}, rear: {} }), /rotors/);
});

test("pedal_efficiency of 1.0 (lossless pedal) is rejected", () => {
  const raw = loadJson("vehicles/fsae_2026_baseline.json") as Record<string, unknown>;
  const hardware = raw["brake_hardware"] as Record<string, unknown>;
  const broken = parseBaselineConfig({ ...raw, brake_hardware: { ...hardware, pedal_efficiency: 1.0 } });

  assert.throws(() => brakeHardwareToInternal(broken.brake_hardware), /pedal_efficiency/);
});

test("a missing master cylinder bore throws naming the problem", () => {
  const raw = loadJson("vehicles/fsae_2026_baseline.json") as Record<string, unknown>;
  const hardware = raw["brake_hardware"] as Record<string, unknown>;
  const { master_cylinder_bore_mm: _drop, front_master_cylinder_bore_mm: _drop2, rear_master_cylinder_bore_mm: _drop3, ...rest } = hardware;
  const broken = parseBaselineConfig({ ...raw, brake_hardware: rest });

  assert.throws(() => brakeHardwareToInternal(broken.brake_hardware), /master cylinder bore/);
});

test("brakeFluidToInternal is a faithful field-for-field pass-through (to_internal as a free function)", () => {
  // Exercises the exported to_internal converter directly on a hand-built
  // Config object, not just indirectly via the parse* wrapper -- matching
  // the "to_internal() methods become free functions" porting convention.
  const internal = brakeFluidToInternal({
    name: "Test Fluid",
    dry_boiling_point_c: 300,
    wet_boiling_point_c: 200,
    bulk_modulus_pa: 1.5e9,
    density_kg_m3: 1050,
    manufacturer: "Acme",
    dot_rating: "DOT 4",
    base_fluid: true,
  });
  assert.deepEqual(internal, {
    name: "Test Fluid",
    dry_boiling_point_c: 300,
    wet_boiling_point_c: 200,
    bulk_modulus_pa: 1.5e9,
    density_kg_m3: 1050,
    manufacturer: "Acme",
    dot_rating: "DOT 4",
    base_fluid: true,
  });
});
