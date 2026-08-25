/** 2D axisymmetric transient rotor conduction model (spec section 21.1).
 *
 * Resolves *where* brake heat goes: the temperature field T(r, z, t) over the
 * friction ring, the peak temperature at the pad swept band, and the radial /
 * through-thickness distribution -- the spatial upgrade over the lumped models
 * in `./thermal.ts` and `./repeatedEvents.ts`.
 *
 * Discretization: vertex-centered finite volumes on an (r, z) grid, explicit
 * (FTCS) time stepping. Finite volumes make the energy bookkeeping exact up to
 * time-integration error, so the reported `energy_balance_error_fraction` is a
 * genuine self-check, not a tautology. Nodes sit exactly on the boundaries, so
 * surface temperatures are read directly.
 *
 * Model assumptions (stated per the loud-assumptions convention):
 *
 * - **Half-thickness symmetry.** Heat enters both faces equally, so only
 *   `z in [0, t/2]` is modeled with an adiabatic mid-plane. Reported fields
 *   are mirrored for display by the UI.
 * - **Circumferential smearing.** Pad heat is averaged over the full annulus.
 *   The instantaneous pad-contact flash temperature is NOT resolved;
 *   `semiInfiniteSurfaceRiseC` provides the closed-form surface-rise
 *   cross-check used to sanity-bound the FD result.
 * - **Friction-ring domain only.** The radial domain spans the hat interface
 *   (if known) or the swept-band inner edge to the OD.
 * - **Solid disc.** Convection uses the plain h on the exposed faces/edges;
 *   `vane_area_multiplier` is a lumped-model area fudge and is deliberately
 *   not applied node-locally here.
 * - `rotor_heat_fraction` scales the friction power entering the rotor
 *   (remainder to the pads); 1.0 is the conservative spec-20.1 assumption.
 *
 * Numerical fields are flat `Float64Array`s (`index = row * nCols + col`,
 * row = axial/z, col = radial/r) rather than nested arrays -- the hot loop
 * preallocates `field` and a reusable `heat` accumulator and never allocates
 * per timestep. Because the stencil computes `heat` entirely from the OLD
 * field values before mutating `field` in place (mirroring numpy's
 * `heat = np.zeros_like(field); heat[...] += ...; field += dt*heat/capacity`),
 * a single persistent buffer is sufficient -- there is no read-after-write
 * hazard that would require a ping-pong current/next pair.
 */
import { STEFAN_BOLTZMANN, ZERO_CELSIUS_K } from "../constants.ts";
import { NeedsInputError } from "../errors.ts";
import type { CoolingParameters } from "../models/internal.ts";
import type { RotorGeometry, RotorMaterial } from "../models/rotors.ts";
import { innerSweptRadiusM, outerRadiusM } from "../models/rotors.ts";
import { mmToM } from "../units.ts";

export const HEAT_PULSE_PROFILES = ["linear", "constant"] as const;
export type HeatPulseProfile = (typeof HEAT_PULSE_PROFILES)[number];

/** Braking energy into ONE rotor over one stop.
 *
 * `profile="linear"` is the constant-deceleration stop (power ramps from
 * `2E/t` to zero); `"constant"` holds `E/t` for the whole duration.
 */
export interface HeatPulse {
  energy_j: number;
  duration_s: number;
  profile: HeatPulseProfile;
}

export function makeHeatPulse(
  energyJ: number,
  durationS: number,
  profile: HeatPulseProfile = "linear",
): HeatPulse {
  if (energyJ < 0.0) throw new Error("energy_j must be >= 0");
  if (durationS <= 0.0) throw new Error("duration_s must be positive");
  if (!(HEAT_PULSE_PROFILES as readonly string[]).includes(profile)) {
    throw new Error(`profile must be one of ${JSON.stringify(HEAT_PULSE_PROFILES)}`);
  }
  return { energy_j: energyJ, duration_s: durationS, profile };
}

export function heatPulsePeakPowerW(pulse: HeatPulse): number {
  if (pulse.profile === "linear") return (2.0 * pulse.energy_j) / pulse.duration_s;
  return pulse.energy_j / pulse.duration_s;
}

export function heatPulsePowerW(pulse: HeatPulse, tS: number): number {
  if (tS < 0.0 || tS >= pulse.duration_s) return 0.0;
  if (pulse.profile === "linear") {
    return ((2.0 * pulse.energy_j) / pulse.duration_s) * (1.0 - tS / pulse.duration_s);
  }
  return pulse.energy_j / pulse.duration_s;
}

export interface RotorFdmModel {
  geometry: RotorGeometry;
  cooling: CoolingParameters;
  rotor_heat_fraction: number | null; // null -> cooling.rotor_heat_fraction
  n_radial: number;
  n_axial: number;
}

export function makeRotorFdmModel(
  geometry: RotorGeometry,
  cooling: CoolingParameters,
  rotorHeatFraction: number | null = null,
  nRadial = 41,
  nAxial = 9,
): RotorFdmModel {
  if (nRadial < 3 || nAxial < 3) {
    throw new Error("n_radial and n_axial must both be >= 3");
  }
  const model: RotorFdmModel = {
    geometry,
    cooling,
    rotor_heat_fraction: rotorHeatFraction,
    n_radial: nRadial,
    n_axial: nAxial,
  };
  const frac = rotorFdmHeatFraction(model);
  if (!(frac > 0.0 && frac <= 1.0)) {
    throw new Error("rotor_heat_fraction must be in (0, 1]");
  }
  return model;
}

export function rotorFdmHeatFraction(model: RotorFdmModel): number {
  if (model.rotor_heat_fraction !== null && model.rotor_heat_fraction !== undefined) {
    return model.rotor_heat_fraction;
  }
  return model.cooling.rotor_heat_fraction ?? 1.0;
}

/** One 2-D temperature field (axial x radial), flattened row-major:
 * `data[j * nRadial + i]`, `j` = axial (z) index, `i` = radial (r) index. */
export interface FieldSnapshot {
  nAxial: number;
  nRadial: number;
  data: Float64Array;
}

export interface ThermalFieldResult {
  r_m: number[]; // (n_radial,)
  z_m: number[]; // (n_axial,) 0 = mid-plane, last = surface
  snapshot_times_s: number[];
  temperature_c: FieldSnapshot[]; // (n_snapshots,) each (n_axial, n_radial)
  surface_history_times_s: number[];
  peak_surface_history_c: number[]; // max over swept-band surface nodes
  bulk_average_history_c: number[]; // capacity-weighted mean of the field
  peak_surface_temperature_c: number;
  peak_surface_time_s: number;
  radial_surface_profile_at_peak_c: number[];
  lumped_delta_t_c: number; // same energy into the ring, lumped
  analytic_surface_rise_c: number; // semi-infinite cross-check
  dt_s: number;
  energy_balance_error_fraction: number;
  // Energy accounting (J). Cumulative histories share surface_history_times_s.
  // Zero / null for prescribed-temperature solves, where no event energy exists.
  energy_in_j: number;
  stored_energy_j: number;
  convective_energy_j: number;
  radiative_energy_j: number;
  energy_in_history_j: number[] | null;
  convective_energy_history_j: number[] | null;
  radiative_energy_history_j: number[] | null;
}

export interface FdmEventTrainResult {
  converged: boolean;
  events_run: number;
  peak_surface_temperatures_c: number[];
  peak_bulk_temperatures_c: number[];
  cyclic_peak_surface_c: number;
  surface_minus_bulk_at_peak_c: number;
  final_field: ThermalFieldResult;
  limit_exceeded: boolean;
  // Totals summed over every event run (J).
  total_energy_in_j: number;
  total_convective_energy_j: number;
  total_radiative_energy_j: number;
  // CONTINUOUS history across the WHOLE train (every stop and every gap), with
  // each event's clock offset by the elapsed time before it.
  train_times_s: number[] | null;
  train_peak_surface_c: number[] | null;
  train_bulk_average_c: number[] | null;
  // Field snapshots spanning the whole train, for animating heat spread.
  train_snapshot_times_s: number[] | null;
  train_snapshots_c: FieldSnapshot[] | null;
}

function requireMaterial(material: RotorMaterial): { k: number; rho: number; cp: number } {
  if (material.thermal_conductivity_w_mk === null || material.thermal_conductivity_w_mk === undefined) {
    throw new NeedsInputError(`rotor_material[${material.name}].thermal_conductivity_w_mk`);
  }
  if (material.density_kg_m3 === null || material.density_kg_m3 === undefined) {
    throw new NeedsInputError(`rotor_material[${material.name}].density_kg_m3`);
  }
  if (material.specific_heat_j_kgk === null || material.specific_heat_j_kgk === undefined) {
    throw new NeedsInputError(`rotor_material[${material.name}].specific_heat_j_kgk`);
  }
  return {
    k: material.thermal_conductivity_w_mk,
    rho: material.density_kg_m3,
    cp: material.specific_heat_j_kgk,
  };
}

/** Explicit-scheme stability limit `dt <= safety / (2 alpha (1/dr^2 + 1/dz^2))`. */
export function stableTimeStepS(
  material: RotorMaterial,
  drM: number,
  dzM: number,
  safety = 0.5,
): number {
  const { k, rho, cp } = requireMaterial(material);
  const alpha = k / (rho * cp);
  return safety / (2.0 * alpha * (1.0 / drM ** 2 + 1.0 / dzM ** 2));
}

/** Closed-form surface rise of a semi-infinite solid under constant flux.
 *
 * `dT = 2 q'' sqrt(alpha t / pi) / k` -- the standard Carslaw & Jaeger result,
 * used as an order-of-magnitude cross-check on the FD swept-band surface
 * temperature.
 */
export function semiInfiniteSurfaceRiseC(
  peakFluxWM2: number,
  material: RotorMaterial,
  durationS: number,
): number {
  const { k, rho, cp } = requireMaterial(material);
  const alpha = k / (rho * cp);
  return (2.0 * peakFluxWM2 * Math.sqrt((alpha * durationS) / Math.PI)) / k;
}

// --- small numpy-semantics helpers ------------------------------------------

/** np.linspace(start, stop, num) -- endpoint inclusive, exact. */
function linspace(start: number, stop: number, num: number): Float64Array {
  const n = Math.max(num, 0);
  const out = new Float64Array(n);
  if (n === 0) return out;
  if (n === 1) {
    out[0] = start;
    return out;
  }
  const step = (stop - start) / (n - 1);
  for (let i = 0; i < n; i++) out[i] = i === n - 1 ? stop : start + i * step;
  return out;
}

/** np.round / Python round(): round-half-to-even. */
function npRound(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** np.unique on an already-rounded array: sorted, deduplicated. */
function uniqueSorted(xs: Float64Array): number[] {
  const arr = Array.from(xs);
  arr.sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of arr) {
    if (out.length === 0 || out[out.length - 1] !== v) out.push(v);
  }
  return out;
}

function sumAll(arr: Float64Array): number {
  let s = 0.0;
  for (let idx = 0; idx < arr.length; idx++) s += arr[idx]!;
  return s;
}

function weightedSum(capacity: Float64Array, field: Float64Array): number {
  let s = 0.0;
  for (let idx = 0; idx < capacity.length; idx++) s += capacity[idx]! * field[idx]!;
  return s;
}

function arrMax(arr: number[]): number {
  let m = -Infinity;
  for (const v of arr) if (v > m) m = v;
  return m;
}

/** max over the swept-band columns of the surface (last axial) row. */
function bandPeak(field: Float64Array, nR: number, nZ: number, sweptMask: boolean[]): number {
  const rowStart = (nZ - 1) * nR;
  let m = -Infinity;
  for (let i = 0; i < nR; i++) {
    if (sweptMask[i]) {
      const v = field[rowStart + i]!;
      if (v > m) m = v;
    }
  }
  return m;
}

// --- mesh --------------------------------------------------------------------

interface Mesh {
  r: Float64Array; // (nR,)
  z: Float64Array; // (nZ,)
  dr: number;
  dz: number;
  material: RotorMaterial;
  capacity: Float64Array; // flat (nZ*nR,); idx = j*nR + i
  gAxial: Float64Array; // (nR,) between rows j, j+1
  gRadial: Float64Array; // flat (nZ*(nR-1)); idx = j*(nR-1) + kk
  aFlux: Float64Array; // (nR,) area getting pad flux
  aFace: Float64Array; // (nR,) == a_ann
  aEdgeInner: Float64Array; // (nZ,)
  aEdgeOuter: Float64Array; // (nZ,)
  sweptMask: boolean[]; // (nR,)
  aSweptTotal: number;
  nR: number;
  nZ: number;
}

function buildMesh(model: RotorFdmModel): Mesh {
  const geom = model.geometry;
  const { k, rho, cp } = requireMaterial(geom.material);

  const rOuter = outerRadiusM(geom);
  const rSweptInner = innerSweptRadiusM(geom);
  const rInner =
    geom.hat_interface_diameter_mm !== null && geom.hat_interface_diameter_mm !== undefined
      ? mmToM(geom.hat_interface_diameter_mm) / 2.0
      : rSweptInner;
  if (!(rInner > 0.0 && rInner < rOuter)) {
    throw new Error("rotor inner radius must be positive and inside the OD");
  }

  const nR = model.n_radial;
  const nZ = model.n_axial;
  const halfThickness = mmToM(geom.thickness_mm) / 2.0;
  const r = linspace(rInner, rOuter, nR);
  const z = linspace(0.0, halfThickness, nZ);
  const dr = r[1]! - r[0]!;
  const dz = z[1]! - z[0]!;

  // Control-volume faces (clamped at the domain edges).
  const rFace = new Float64Array(nR + 1);
  rFace[0] = rInner;
  for (let i = 0; i < nR - 1; i++) rFace[i + 1] = 0.5 * (r[i]! + r[i + 1]!);
  rFace[nR] = rOuter;

  // Annular plan-view area of each radial control volume (exact).
  const aAnn = new Float64Array(nR);
  for (let i = 0; i < nR; i++) aAnn[i] = Math.PI * (rFace[i + 1]! ** 2 - rFace[i]! ** 2);

  const wZ = new Float64Array(nZ).fill(dz);
  wZ[0] = dz / 2.0;
  wZ[nZ - 1] = dz / 2.0;

  // Node heat capacities: rho*cp*V, V = A_ann * w_z.
  const capacity = new Float64Array(nZ * nR);
  for (let j = 0; j < nZ; j++) {
    for (let i = 0; i < nR; i++) {
      capacity[j * nR + i] = rho * cp * aAnn[i]! * wZ[j]!;
    }
  }

  // Interface conduction conductances (W/K).
  const gAxial = new Float64Array(nR);
  for (let i = 0; i < nR; i++) gAxial[i] = (k * aAnn[i]!) / dz;

  const gRadial = new Float64Array(nZ * (nR - 1));
  for (let j = 0; j < nZ; j++) {
    for (let kk = 0; kk < nR - 1; kk++) {
      gRadial[j * (nR - 1) + kk] = (k * 2.0 * Math.PI * rFace[kk + 1]! * wZ[j]!) / dr;
    }
  }

  // Swept-band flux: fraction of each surface control area inside the band.
  const aFlux = new Float64Array(nR);
  const sweptMask = new Array<boolean>(nR);
  for (let i = 0; i < nR; i++) {
    const lo = Math.max(rFace[i]!, rSweptInner);
    const hi = Math.min(rFace[i + 1]!, rOuter);
    let overlap = Math.PI * (hi ** 2 - lo ** 2);
    if (overlap < 0.0) overlap = 0.0; // np.clip(..., 0.0, None)
    if (hi <= lo) overlap = 0.0; // overlap[hi <= lo] = 0.0
    aFlux[i] = overlap;
    sweptMask[i] = overlap > 0.5 * aAnn[i]!;
  }

  // Cooling areas: exposed face (top) plus inner/outer cylindrical edges of
  // the half-domain. Mid-plane is the symmetry boundary (adiabatic).
  const aEdgeInner = new Float64Array(nZ);
  const aEdgeOuter = new Float64Array(nZ);
  for (let j = 0; j < nZ; j++) {
    aEdgeInner[j] = 2.0 * Math.PI * rInner * wZ[j]!;
    aEdgeOuter[j] = 2.0 * Math.PI * rOuter * wZ[j]!;
  }

  const aSweptTotal = Math.PI * (rOuter ** 2 - rSweptInner ** 2);

  return {
    r,
    z,
    dr,
    dz,
    material: geom.material,
    capacity,
    gAxial,
    gRadial,
    aFlux,
    aFace: aAnn,
    aEdgeInner,
    aEdgeOuter,
    sweptMask,
    aSweptTotal,
    nR,
    nZ,
  };
}

// --- core time stepping -------------------------------------------------------

interface RunOutput {
  result: ThermalFieldResult;
  field: Float64Array<ArrayBuffer>; // final flat field (nZ*nR), for event-train chaining
}

function runCore(
  model: RotorFdmModel,
  mesh: Mesh,
  pulse: HeatPulse,
  tFieldInit: Float64Array,
  coolDownS: number,
  snapshotsIn: number,
): RunOutput {
  const cooling = model.cooling;
  const frac = rotorFdmHeatFraction(model);
  const h = cooling.convection_coefficient_w_m2k;
  const eps = cooling.emissivity;
  const tInf = cooling.ambient_temperature_c;
  const tInfK4 = (tInf + ZERO_CELSIUS_K) ** 4;
  const sigma = STEFAN_BOLTZMANN;

  const nR = mesh.nR;
  const nZ = mesh.nZ;
  const nCells = nZ * nR;
  const surfRow = (nZ - 1) * nR;

  const totalTime = pulse.duration_s + coolDownS;
  let dt = stableTimeStepS(mesh.material, mesh.dr, mesh.dz);
  const nSteps = Math.max(1, Math.ceil(totalTime / dt));
  dt = totalTime / nSteps;

  const field = tFieldInit.slice();
  const capacity = mesh.capacity;
  const totalCapacity = sumAll(capacity);

  const snapshots = Math.max(2, snapshotsIn);
  const snapStepsArr = linspace(0, nSteps, snapshots).map((v) => npRound(v));
  const snapSteps = new Set<number>(uniqueSorted(snapStepsArr));
  const recordEvery = Math.max(1, Math.floor(nSteps / 1500));

  const snapFields: FieldSnapshot[] = [{ nAxial: nZ, nRadial: nR, data: field.slice() }];
  const snapTimes: number[] = [0.0];
  const histTimes: number[] = [0.0];
  const histPeak: number[] = [bandPeak(field, nR, nZ, mesh.sweptMask)];
  const histBulk: number[] = [weightedSum(capacity, field) / totalCapacity];

  let peakC = histPeak[0]!;
  let peakT = 0.0;
  let energyIn = 0.0;
  let energyConv = 0.0;
  let energyRad = 0.0;
  const histIn: number[] = [0.0];
  const histConv: number[] = [0.0];
  const histRad: number[] = [0.0];
  const storedStart = weightedSum(capacity, field);

  const qScale = frac / (2.0 * mesh.aSweptTotal); // power -> per-face flux

  const heat = new Float64Array(nCells);

  for (let step = 1; step <= nSteps; step++) {
    const tMid = (step - 0.5) * dt;
    heat.fill(0.0);

    // Axial conduction between rows j and j+1: heat[:-1,:] += qz; heat[1:,:] -= qz
    for (let j = 0; j < nZ - 1; j++) {
      for (let i = 0; i < nR; i++) {
        const qz = mesh.gAxial[i]! * (field[(j + 1) * nR + i]! - field[j * nR + i]!);
        heat[j * nR + i]! += qz;
      }
    }
    for (let j = 0; j < nZ - 1; j++) {
      for (let i = 0; i < nR; i++) {
        const qz = mesh.gAxial[i]! * (field[(j + 1) * nR + i]! - field[j * nR + i]!);
        heat[(j + 1) * nR + i]! -= qz;
      }
    }

    // Radial conduction between columns kk and kk+1: heat[:,:-1]+=qr; heat[:,1:]-=qr
    for (let j = 0; j < nZ; j++) {
      for (let kk = 0; kk < nR - 1; kk++) {
        const qr = mesh.gRadial[j * (nR - 1) + kk]! * (field[j * nR + kk + 1]! - field[j * nR + kk]!);
        heat[j * nR + kk]! += qr;
      }
    }
    for (let j = 0; j < nZ; j++) {
      for (let kk = 0; kk < nR - 1; kk++) {
        const qr = mesh.gRadial[j * (nR - 1) + kk]! * (field[j * nR + kk + 1]! - field[j * nR + kk]!);
        heat[j * nR + kk + 1]! -= qr;
      }
    }

    // Pad heat into the swept band (top surface row).
    const qFlux = qScale * heatPulsePowerW(pulse, tMid);
    let qInSum = 0.0;
    for (let i = 0; i < nR; i++) {
      const qIn = qFlux * mesh.aFlux[i]!;
      heat[surfRow + i]! += qIn;
      qInSum += qIn;
    }
    energyIn += qInSum * dt;

    // Convection + radiation losses: exposed face + both cylindrical edges,
    // kept as separate terms so the dissipation split is reported, not just
    // its sum.
    let sumConvFace = 0.0;
    let sumRadFace = 0.0;
    for (let i = 0; i < nR; i++) {
      const surf = field[surfRow + i]!;
      const convFace = h * mesh.aFace[i]! * (surf - tInf);
      const radFace = eps * sigma * mesh.aFace[i]! * ((surf + ZERO_CELSIUS_K) ** 4 - tInfK4);
      heat[surfRow + i]! -= convFace + radFace;
      sumConvFace += convFace;
      sumRadFace += radFace;
    }
    let sumConvInner = 0.0;
    let sumRadInner = 0.0;
    for (let j = 0; j < nZ; j++) {
      const inner = field[j * nR]!;
      const convInner = h * mesh.aEdgeInner[j]! * (inner - tInf);
      const radInner = eps * sigma * mesh.aEdgeInner[j]! * ((inner + ZERO_CELSIUS_K) ** 4 - tInfK4);
      heat[j * nR]! -= convInner + radInner;
      sumConvInner += convInner;
      sumRadInner += radInner;
    }
    let sumConvOuter = 0.0;
    let sumRadOuter = 0.0;
    for (let j = 0; j < nZ; j++) {
      const outer = field[j * nR + nR - 1]!;
      const convOuter = h * mesh.aEdgeOuter[j]! * (outer - tInf);
      const radOuter = eps * sigma * mesh.aEdgeOuter[j]! * ((outer + ZERO_CELSIUS_K) ** 4 - tInfK4);
      heat[j * nR + nR - 1]! -= convOuter + radOuter;
      sumConvOuter += convOuter;
      sumRadOuter += radOuter;
    }
    energyConv += (sumConvFace + sumConvInner + sumConvOuter) * dt;
    energyRad += (sumRadFace + sumRadInner + sumRadOuter) * dt;

    for (let idx = 0; idx < nCells; idx++) {
      field[idx]! += (dt * heat[idx]!) / capacity[idx]!;
    }

    const peak = bandPeak(field, nR, nZ, mesh.sweptMask);
    if (peak > peakC) {
      peakC = peak;
      peakT = step * dt;
    }
    if (step % recordEvery === 0 || step === nSteps) {
      histTimes.push(step * dt);
      histPeak.push(peak);
      histBulk.push(weightedSum(capacity, field) / totalCapacity);
      histIn.push(energyIn);
      histConv.push(energyConv);
      histRad.push(energyRad);
    }
    if (snapSteps.has(step)) {
      snapFields.push({ nAxial: nZ, nRadial: nR, data: field.slice() });
      snapTimes.push(step * dt);
    }
  }

  const stored = weightedSum(capacity, field) - storedStart;
  const energyLoss = energyConv + energyRad;
  const denom = Math.max(energyIn, 1e-9);
  const balanceError = (stored + energyLoss - energyIn) / denom;

  // Surface profile at (nearest recorded snapshot to) the peak time.
  let peakSnap = 0;
  let bestDiff = Math.abs(snapTimes[0]! - peakT);
  for (let kk = 1; kk < snapTimes.length; kk++) {
    const diff = Math.abs(snapTimes[kk]! - peakT);
    if (diff < bestDiff) {
      bestDiff = diff;
      peakSnap = kk;
    }
  }
  const radialProfile = new Array<number>(nR);
  {
    const data = snapFields[peakSnap]!.data;
    for (let i = 0; i < nR; i++) radialProfile[i] = data[surfRow + i]!;
  }

  const lumpedDelta = (frac * pulse.energy_j) / 2.0 / totalCapacity;
  const analytic = semiInfiniteSurfaceRiseC(
    qScale * heatPulsePeakPowerW(pulse),
    mesh.material,
    pulse.duration_s,
  );

  const result: ThermalFieldResult = {
    r_m: Array.from(mesh.r),
    z_m: Array.from(mesh.z),
    snapshot_times_s: snapTimes,
    temperature_c: snapFields,
    surface_history_times_s: histTimes,
    peak_surface_history_c: histPeak,
    bulk_average_history_c: histBulk,
    peak_surface_temperature_c: peakC,
    peak_surface_time_s: peakT,
    radial_surface_profile_at_peak_c: radialProfile,
    lumped_delta_t_c: lumpedDelta,
    analytic_surface_rise_c: analytic,
    dt_s: dt,
    energy_balance_error_fraction: balanceError,
    // The mesh is the symmetric half-thickness; double every energy so the
    // report covers the whole rotor (exact by symmetry).
    energy_in_j: 2.0 * energyIn,
    stored_energy_j: 2.0 * stored,
    convective_energy_j: 2.0 * energyConv,
    radiative_energy_j: 2.0 * energyRad,
    energy_in_history_j: histIn.map((v) => 2.0 * v),
    convective_energy_history_j: histConv.map((v) => 2.0 * v),
    radiative_energy_history_j: histRad.map((v) => 2.0 * v),
  };
  return { result, field };
}

// --- public API ----------------------------------------------------------------

/** One braking event (plus optional cool-down) from a uniform start field. */
export function simulateSingleStop(
  model: RotorFdmModel,
  pulse: HeatPulse,
  initialTemperatureC: number | null = null,
  coolDownS = 0.0,
  snapshots = 25,
): ThermalFieldResult {
  const mesh = buildMesh(model);
  const start =
    initialTemperatureC === null || initialTemperatureC === undefined
      ? model.cooling.ambient_temperature_c
      : initialTemperatureC;
  const tInit = new Float64Array(mesh.nZ * mesh.nR).fill(start);
  const { result } = runCore(model, mesh, pulse, tInit, coolDownS, snapshots);
  return result;
}

/** Repeated identical events to cyclic convergence (mirrors spec 20.8).
 *
 * Convergence semantics match `simulateRepeatedEvents` in `./repeatedEvents.ts`:
 * the per-event peak change must be under `convergenceTolC` absolute AND
 * `relativeTol` of the rise over ambient, `consecutiveRequired` events in a
 * row.
 *
 * Each event is one braking pulse followed by `gapS` of cooling, so
 * stitching the per-event histories together (offsetting each by the time
 * already elapsed) yields one continuous temperature trace over the whole
 * train. `captureAnimation` additionally keeps the field snapshots from
 * every event so the heat spread can be animated.
 */
export function simulateEventTrain(
  model: RotorFdmModel,
  pulse: HeatPulse,
  gapS: number,
  maxEvents = 100,
  convergenceTolC = 2.0,
  relativeTol = 0.01,
  consecutiveRequired = 3,
  snapshots = 25,
  captureAnimation = true,
): FdmEventTrainResult {
  if (gapS < 0.0) throw new Error("gap_s must be >= 0");
  const mesh = buildMesh(model);
  const tInf = model.cooling.ambient_temperature_c;
  let field = new Float64Array(mesh.nZ * mesh.nR).fill(tInf);

  const peaksSurface: number[] = [];
  const peaksBulk: number[] = [];
  let consecutive = 0;
  let converged = false;
  let lastResult: ThermalFieldResult | null = null;
  let totalIn = 0.0;
  let totalConv = 0.0;
  let totalRad = 0.0;

  // Whole-train accumulators. Each event's clock restarts at 0, so shift by
  // the elapsed time and drop the duplicated boundary sample when joining.
  const eventPeriodS = pulse.duration_s + gapS;
  const trainTimes: number[][] = [];
  const trainPeak: number[][] = [];
  const trainBulk: number[][] = [];
  const snapTimesList: number[][] = [];
  const snapFieldsList: FieldSnapshot[][] = [];

  for (let eventIdx = 1; eventIdx <= maxEvents; eventIdx++) {
    const { result, field: nextField } = runCore(model, mesh, pulse, field, gapS, snapshots);
    field = nextField;
    lastResult = result;
    peaksSurface.push(result.peak_surface_temperature_c);
    peaksBulk.push(arrMax(result.bulk_average_history_c));
    totalIn += result.energy_in_j;
    totalConv += result.convective_energy_j;
    totalRad += result.radiative_energy_j;

    const offset = (peaksSurface.length - 1) * eventPeriodS;
    const first = trainTimes.length > 0 ? 1 : 0; // skip the repeated joint sample
    trainTimes.push(result.surface_history_times_s.slice(first).map((t) => t + offset));
    trainPeak.push(result.peak_surface_history_c.slice(first));
    trainBulk.push(result.bulk_average_history_c.slice(first));
    if (captureAnimation) {
      const snapFirst = snapTimesList.length > 0 ? 1 : 0;
      snapTimesList.push(result.snapshot_times_s.slice(snapFirst).map((t) => t + offset));
      snapFieldsList.push(result.temperature_c.slice(snapFirst));
    }

    if (peaksSurface.length >= 2) {
      const diff = Math.abs(peaksSurface[peaksSurface.length - 1]! - peaksSurface[peaksSurface.length - 2]!);
      const rel = diff / Math.max(peaksSurface[peaksSurface.length - 1]! - tInf, 1e-9);
      if (diff < convergenceTolC && rel < relativeTol) {
        consecutive += 1;
      } else {
        consecutive = 0;
      }
      if (consecutive >= consecutiveRequired) {
        converged = true;
        break;
      }
    }
  }

  if (lastResult === null) throw new Error("max_events must be >= 1"); // maxEvents >= 1
  const cyclicPeak = peaksSurface[peaksSurface.length - 1]!;
  return {
    converged,
    events_run: peaksSurface.length,
    peak_surface_temperatures_c: peaksSurface,
    peak_bulk_temperatures_c: peaksBulk,
    cyclic_peak_surface_c: cyclicPeak,
    surface_minus_bulk_at_peak_c: cyclicPeak - peaksBulk[peaksBulk.length - 1]!,
    final_field: lastResult,
    limit_exceeded: cyclicPeak > model.cooling.allowable_rotor_temperature_c,
    total_energy_in_j: totalIn,
    total_convective_energy_j: totalConv,
    total_radiative_energy_j: totalRad,
    train_times_s: trainTimes.flat(),
    train_peak_surface_c: trainPeak.flat(),
    train_bulk_average_c: trainBulk.flat(),
    train_snapshot_times_s: snapFieldsList.length ? snapTimesList.flat() : null,
    train_snapshots_c: snapFieldsList.length ? snapFieldsList.flat() : null,
  };
}

/** Steady-state field with the pad swept band HELD at a set temperature.
 *
 * The swept-band surface nodes are clamped (Dirichlet) at `bandTemperatureC`;
 * the rest of the rotor conducts and cools by convection + radiation until
 * the field stops changing (max change over one simulated second below
 * `toleranceC`). Energy-accounting fields of the result are zeroed -- they
 * have no meaning for a prescribed-temperature boundary.
 */
export function solveSteadyBandTemperature(
  model: RotorFdmModel,
  bandTemperatureC: number,
  toleranceC = 0.1,
  maxTimeS = 600.0,
): ThermalFieldResult {
  const mesh = buildMesh(model);
  const cooling = model.cooling;
  const h = cooling.convection_coefficient_w_m2k;
  const eps = cooling.emissivity;
  const tInf = cooling.ambient_temperature_c;
  const tInfK4 = (tInf + ZERO_CELSIUS_K) ** 4;
  const sigma = STEFAN_BOLTZMANN;

  const dt = stableTimeStepS(mesh.material, mesh.dr, mesh.dz);
  const nSteps = Math.max(2, Math.ceil(maxTimeS / dt));
  const checkEvery = Math.max(1, npRound(1.0 / dt));

  const nR = mesh.nR;
  const nZ = mesh.nZ;
  const nCells = nZ * nR;
  const surfRow = (nZ - 1) * nR;

  const field = new Float64Array(nCells).fill(tInf);
  for (let i = 0; i < nR; i++) {
    if (mesh.sweptMask[i]) field[surfRow + i] = bandTemperatureC;
  }
  const capacity = mesh.capacity;
  const totalCapacity = sumAll(capacity);

  const snapFields: FieldSnapshot[] = [{ nAxial: nZ, nRadial: nR, data: field.slice() }];
  const snapTimes: number[] = [0.0];
  const histTimes: number[] = [0.0];
  const histPeak: number[] = [bandTemperatureC];
  const histBulk: number[] = [weightedSum(capacity, field) / totalCapacity];
  const recordEvery = Math.max(1, Math.floor(nSteps / 1500));
  let reference = field.slice();
  let finalStep = nSteps;

  const heat = new Float64Array(nCells);

  for (let step = 1; step <= nSteps; step++) {
    heat.fill(0.0);

    for (let j = 0; j < nZ - 1; j++) {
      for (let i = 0; i < nR; i++) {
        const qz = mesh.gAxial[i]! * (field[(j + 1) * nR + i]! - field[j * nR + i]!);
        heat[j * nR + i]! += qz;
      }
    }
    for (let j = 0; j < nZ - 1; j++) {
      for (let i = 0; i < nR; i++) {
        const qz = mesh.gAxial[i]! * (field[(j + 1) * nR + i]! - field[j * nR + i]!);
        heat[(j + 1) * nR + i]! -= qz;
      }
    }
    for (let j = 0; j < nZ; j++) {
      for (let kk = 0; kk < nR - 1; kk++) {
        const qr = mesh.gRadial[j * (nR - 1) + kk]! * (field[j * nR + kk + 1]! - field[j * nR + kk]!);
        heat[j * nR + kk]! += qr;
      }
    }
    for (let j = 0; j < nZ; j++) {
      for (let kk = 0; kk < nR - 1; kk++) {
        const qr = mesh.gRadial[j * (nR - 1) + kk]! * (field[j * nR + kk + 1]! - field[j * nR + kk]!);
        heat[j * nR + kk + 1]! -= qr;
      }
    }

    for (let i = 0; i < nR; i++) {
      const surf = field[surfRow + i]!;
      const loss =
        h * mesh.aFace[i]! * (surf - tInf) +
        eps * sigma * mesh.aFace[i]! * ((surf + ZERO_CELSIUS_K) ** 4 - tInfK4);
      heat[surfRow + i]! -= loss;
    }
    for (let j = 0; j < nZ; j++) {
      const inner = field[j * nR]!;
      const loss =
        h * mesh.aEdgeInner[j]! * (inner - tInf) +
        eps * sigma * mesh.aEdgeInner[j]! * ((inner + ZERO_CELSIUS_K) ** 4 - tInfK4);
      heat[j * nR]! -= loss;
    }
    for (let j = 0; j < nZ; j++) {
      const outer = field[j * nR + nR - 1]!;
      const loss =
        h * mesh.aEdgeOuter[j]! * (outer - tInf) +
        eps * sigma * mesh.aEdgeOuter[j]! * ((outer + ZERO_CELSIUS_K) ** 4 - tInfK4);
      heat[j * nR + nR - 1]! -= loss;
    }

    for (let idx = 0; idx < nCells; idx++) {
      field[idx]! += (dt * heat[idx]!) / capacity[idx]!;
    }
    for (let i = 0; i < nR; i++) {
      if (mesh.sweptMask[i]) field[surfRow + i] = bandTemperatureC; // Dirichlet clamp
    }

    if (step % recordEvery === 0) {
      histTimes.push(step * dt);
      histPeak.push(bandPeak(field, nR, nZ, mesh.sweptMask));
      histBulk.push(weightedSum(capacity, field) / totalCapacity);
    }
    if (step % checkEvery === 0) {
      let maxDiff = 0.0;
      for (let idx = 0; idx < nCells; idx++) {
        const d = Math.abs(field[idx]! - reference[idx]!);
        if (d > maxDiff) maxDiff = d;
      }
      if (maxDiff < toleranceC) {
        finalStep = step;
        break;
      }
      reference = field.slice();
    }
  }

  snapFields.push({ nAxial: nZ, nRadial: nR, data: field.slice() });
  snapTimes.push(finalStep * dt);
  histTimes.push(finalStep * dt);
  histPeak.push(bandPeak(field, nR, nZ, mesh.sweptMask));
  histBulk.push(weightedSum(capacity, field) / totalCapacity);

  let peakSurfaceAll = -Infinity;
  for (let i = 0; i < nR; i++) {
    const v = field[surfRow + i]!;
    if (v > peakSurfaceAll) peakSurfaceAll = v;
  }
  const radialProfile = new Array<number>(nR);
  for (let i = 0; i < nR; i++) radialProfile[i] = field[surfRow + i]!;

  return {
    r_m: Array.from(mesh.r),
    z_m: Array.from(mesh.z),
    snapshot_times_s: snapTimes,
    temperature_c: snapFields,
    surface_history_times_s: histTimes,
    peak_surface_history_c: histPeak,
    bulk_average_history_c: histBulk,
    peak_surface_temperature_c: peakSurfaceAll,
    peak_surface_time_s: finalStep * dt,
    radial_surface_profile_at_peak_c: radialProfile,
    lumped_delta_t_c: 0.0,
    analytic_surface_rise_c: 0.0,
    dt_s: dt,
    energy_balance_error_fraction: 0.0,
    energy_in_j: 0.0,
    stored_energy_j: 0.0,
    convective_energy_j: 0.0,
    radiative_energy_j: 0.0,
    energy_in_history_j: null,
    convective_energy_history_j: null,
    radiative_energy_history_j: null,
  };
}
