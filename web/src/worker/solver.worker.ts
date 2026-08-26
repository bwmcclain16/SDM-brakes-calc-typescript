/** Thermal solves, off the main thread.
 *
 * A face-resolved multi-stop run takes on the order of a minute. On the main
 * thread that is not a slow page, it is a frozen tab — no scrolling, no input,
 * no way to cancel. Streamlit hid this behind a server round trip and a spinner;
 * a browser has no such luxury, so the heavy solvers run here and post results
 * back.
 *
 * All three field solvers live here — the axisymmetric annulus, the rasterized
 * cross-section, and the face-resolved plate — behind one request/response
 * shape, so the page picks a geometry and a mode without knowing which module
 * answers. Whatever the solver, the reply carries the same field payload.
 *
 * The solver core is pure and dependency-free, which is what makes this
 * possible: the worker imports exactly the same modules the main thread would
 * and needs no special build treatment.
 */
import {
  makeHeatPulse,
  makeRotorFdmModel,
  simulateEventTrain,
  simulateSingleStop,
  solveSteadyBandTemperature,
} from "@core/solvers/thermalFdm.ts";
import type {
  FdmEventTrainResult,
  FieldSnapshot,
  ThermalFieldResult,
} from "@core/solvers/thermalFdm.ts";
import {
  makeRotorSection,
  makeSectionFdmModel,
  makeSweptBand,
  simulateSectionEventTrain,
  simulateSectionSingleStop,
  solveSectionSteadyBandTemperature,
} from "@core/solvers/thermalFdmSection.ts";
import type {
  HoleBand,
  SectionEventTrainResult,
  SectionThermalResult,
} from "@core/solvers/thermalFdmSection.ts";
import {
  makeFacePlateModel,
  makeRotorFaceGeometry,
  simulateFaceEventTrain,
  simulateFaceSingleStop,
} from "@core/solvers/thermalFacePlane.ts";
import type {
  FaceEventTrainResult,
  FaceFieldResult,
} from "@core/solvers/thermalFacePlane.ts";
import type { CoolingParameters } from "@core/models/internal.ts";
import type { RotorGeometry, RotorMaterial } from "@core/models/rotors.ts";

// --- requests -----------------------------------------------------------------

export type SolveMode = "single" | "train" | "steady";

interface CommonRequest {
  id: number;
  cooling: CoolingParameters;
  mode: SolveMode;
  energyJ: number;
  durationS: number;
  coolDownS: number;
  gapS: number;
  maxEvents: number;
  /** Set to `stops + 1` for a fixed-count run, which defeats the convergence
   *  short-circuit so every requested stop is actually simulated. */
  consecutiveRequired: number | null;
  snapshots: number;
  bandTemperatureC: number | null;
}

export interface AnnulusRequest extends CommonRequest {
  kind: "annulus";
  geometry: RotorGeometry;
  nRadial: number;
  nAxial: number;
}

export interface SectionRequest extends CommonRequest {
  kind: "section";
  pointsMm: Array<[number, number]>;
  material: RotorMaterial;
  holeBands: HoleBand[];
  bandDepthMm: number;
  bandOffsetMm: number;
  nRadial: number;
  nAxial: number;
}

export interface FaceRequest extends CommonRequest {
  kind: "face";
  outerDiameterMm: number;
  innerDiameterMm: number;
  thicknessMm: number;
  material: RotorMaterial;
  innerBoundaryMm: Array<[number, number]> | null;
  holeCentersMm: Array<[number, number, number]>;
  slotLoopsMm: Array<Array<[number, number]>>;
  bandDepthMm: number;
  bandOffsetMm: number;
  nPixels: number;
}

export type SolverRequest = AnnulusRequest | SectionRequest | FaceRequest;

// --- responses ----------------------------------------------------------------

export interface TrainPayload {
  converged: boolean;
  eventsRun: number;
  peakPerEventC: number[];
  bulkPerEventC: number[];
  /** Face-resolved runs only: peak minus its own radius ring's mean. */
  hotSpotDeltasC: number[] | null;
  cyclicPeakC: number;
  cyclicHotSpotDeltaC: number | null;
  surfaceMinusBulkAtPeakC: number | null;
  totalEnergyInJ: number;
  totalConvectiveEnergyJ: number;
  totalRadiativeEnergyJ: number;
  trainTimesS: number[] | null;
  trainPeakSurfaceC: number[] | null;
  trainBulkAverageC: number[] | null;
}

/** One solved field, whichever solver produced it.
 *
 * Axes are metres because that is what the expansion solver wants; the page
 * scales to mm for display. Fields ride as one flat Float64Array
 * (`snap * rows * cols + row * cols + col`) and are TRANSFERRED rather than
 * cloned — a face train's stack is tens of megabytes and copying it would
 * stall the main thread for exactly as long as the solve saved.
 */
export interface SolverOk {
  id: number;
  ok: true;
  kind: "annulus" | "section" | "face";
  /** r (annulus, section) or x (face). */
  colAxisM: number[];
  /** z (annulus, section, mid-plane at 0) or y (face). */
  rowAxisM: number[];
  nRows: number;
  nCols: number;
  /** Display timeline: the WHOLE train when there is one, else the single run. */
  snapTimesS: number[];
  snapData: Float64Array;
  /** Whether snapTimesS spans a multi-event run or a single stop. */
  snapSpan: "run" | "stop";
  /** 1 inside the modeled metal, 0 outside. Null for the annulus (all solid). */
  activeMask: Uint8Array | null;

  peakC: number;
  peakTimeS: number;
  lumpedDeltaTC: number;
  analyticSurfaceRiseC: number | null;
  energyBalanceErrorFraction: number;
  sectionMassKg: number | null;
  fluxAreaM2: number | null;
  sweptRBoundsM: [number, number] | null;
  coolestMetalC: number;

  // Face-resolved extras.
  peakLocationMm: [number, number] | null;
  hotSpotDeltaC: number | null;
  radialBinsM: number[] | null;
  radialMaxC: number[] | null;
  radialMeanC: number[] | null;
  radialMinC: number[] | null;

  historyTimesS: number[];
  peakHistoryC: number[];
  bulkHistoryC: number[];
  energyInHistoryJ: number[] | null;
  convectiveEnergyHistoryJ: number[] | null;
  radiativeEnergyHistoryJ: number[] | null;

  energyInJ: number;
  storedEnergyJ: number;
  convectiveEnergyJ: number;
  radiativeEnergyJ: number;

  train: TrainPayload | null;
}

export interface SolverErr {
  id: number;
  ok: false;
  message: string;
}

export type SolverResponse = SolverOk | SolverErr;

// --- packing ------------------------------------------------------------------

/** Flatten a snapshot stack into one buffer for a zero-copy transfer. */
function packSnapshots(snapshots: readonly FieldSnapshot[]): {
  data: Float64Array;
  nRows: number;
  nCols: number;
} {
  const first = snapshots[0];
  if (!first) return { data: new Float64Array(0), nRows: 0, nCols: 0 };
  const nRows = first.nAxial;
  const nCols = first.nRadial;
  const stride = nRows * nCols;
  const data = new Float64Array(snapshots.length * stride);
  snapshots.forEach((snap, i) => data.set(snap.data, i * stride));
  return { data, nRows, nCols };
}

function packMask(mask: FieldSnapshot): Uint8Array {
  const out = new Uint8Array(mask.data.length);
  for (let i = 0; i < mask.data.length; i++) out[i] = mask.data[i]! > 0.5 ? 1 : 0;
  return out;
}

/** Minimum over the finite entries of the last snapshot — the coldest modeled
 *  metal, which for a steady solve is the number the inboard edge settles at. */
function coldestFinite(snapshots: readonly FieldSnapshot[]): number {
  const last = snapshots[snapshots.length - 1];
  if (!last) return NaN;
  let min = Infinity;
  for (const v of last.data) if (Number.isFinite(v) && v < min) min = v;
  return Number.isFinite(min) ? min : NaN;
}

// --- shaping, one per solver ---------------------------------------------------

function shapeAnnulus(
  id: number,
  result: ThermalFieldResult,
  train: FdmEventTrainResult | null,
): SolverOk {
  const useTrainFrames = train?.train_snapshots_c != null && train.train_snapshot_times_s != null;
  const frames = useTrainFrames ? train!.train_snapshots_c! : result.temperature_c;
  const times = useTrainFrames ? train!.train_snapshot_times_s! : result.snapshot_times_s;
  const packed = packSnapshots(frames);
  return {
    id,
    ok: true,
    kind: "annulus",
    colAxisM: result.r_m,
    rowAxisM: result.z_m,
    nRows: packed.nRows,
    nCols: packed.nCols,
    snapTimesS: times,
    snapData: packed.data,
    snapSpan: useTrainFrames ? "run" : "stop",
    activeMask: null,
    peakC: result.peak_surface_temperature_c,
    peakTimeS: result.peak_surface_time_s,
    lumpedDeltaTC: result.lumped_delta_t_c,
    analyticSurfaceRiseC: result.analytic_surface_rise_c,
    energyBalanceErrorFraction: result.energy_balance_error_fraction,
    sectionMassKg: null,
    fluxAreaM2: null,
    sweptRBoundsM: null,
    coolestMetalC: coldestFinite(result.temperature_c),
    peakLocationMm: null,
    hotSpotDeltaC: null,
    radialBinsM: null,
    radialMaxC: null,
    radialMeanC: null,
    radialMinC: null,
    historyTimesS: result.surface_history_times_s,
    peakHistoryC: result.peak_surface_history_c,
    bulkHistoryC: result.bulk_average_history_c,
    energyInHistoryJ: result.energy_in_history_j,
    convectiveEnergyHistoryJ: result.convective_energy_history_j,
    radiativeEnergyHistoryJ: result.radiative_energy_history_j,
    energyInJ: result.energy_in_j,
    storedEnergyJ: result.stored_energy_j,
    convectiveEnergyJ: result.convective_energy_j,
    radiativeEnergyJ: result.radiative_energy_j,
    train: train
      ? {
          converged: train.converged,
          eventsRun: train.events_run,
          peakPerEventC: train.peak_surface_temperatures_c,
          bulkPerEventC: train.peak_bulk_temperatures_c,
          hotSpotDeltasC: null,
          cyclicPeakC: train.cyclic_peak_surface_c,
          cyclicHotSpotDeltaC: null,
          surfaceMinusBulkAtPeakC: train.surface_minus_bulk_at_peak_c,
          totalEnergyInJ: train.total_energy_in_j,
          totalConvectiveEnergyJ: train.total_convective_energy_j,
          totalRadiativeEnergyJ: train.total_radiative_energy_j,
          trainTimesS: train.train_times_s,
          trainPeakSurfaceC: train.train_peak_surface_c,
          trainBulkAverageC: train.train_bulk_average_c,
        }
      : null,
  };
}

function shapeSection(
  id: number,
  result: SectionThermalResult,
  train: SectionEventTrainResult | null,
): SolverOk {
  const useTrainFrames = train?.train_snapshots_c != null && train.train_snapshot_times_s != null;
  const frames = useTrainFrames ? train!.train_snapshots_c! : result.temperature_c;
  const times = useTrainFrames ? train!.train_snapshot_times_s! : result.snapshot_times_s;
  const packed = packSnapshots(frames);
  return {
    id,
    ok: true,
    kind: "section",
    colAxisM: result.r_m,
    rowAxisM: result.z_m,
    nRows: packed.nRows,
    nCols: packed.nCols,
    snapTimesS: times,
    snapData: packed.data,
    snapSpan: useTrainFrames ? "run" : "stop",
    activeMask: packMask(result.active_mask),
    peakC: result.peak_surface_temperature_c,
    peakTimeS: result.peak_surface_time_s,
    lumpedDeltaTC: result.lumped_delta_t_c,
    analyticSurfaceRiseC: result.analytic_surface_rise_c,
    energyBalanceErrorFraction: result.energy_balance_error_fraction,
    sectionMassKg: result.section_mass_kg,
    fluxAreaM2: result.flux_area_m2,
    sweptRBoundsM: result.swept_r_bounds_m,
    coolestMetalC: coldestFinite(result.temperature_c),
    peakLocationMm: null,
    hotSpotDeltaC: null,
    radialBinsM: null,
    radialMaxC: null,
    radialMeanC: null,
    radialMinC: null,
    historyTimesS: result.surface_history_times_s,
    peakHistoryC: result.peak_surface_history_c,
    bulkHistoryC: result.bulk_average_history_c,
    energyInHistoryJ: result.energy_in_history_j,
    convectiveEnergyHistoryJ: result.convective_energy_history_j,
    radiativeEnergyHistoryJ: result.radiative_energy_history_j,
    energyInJ: result.energy_in_j,
    storedEnergyJ: result.stored_energy_j,
    convectiveEnergyJ: result.convective_energy_j,
    radiativeEnergyJ: result.radiative_energy_j,
    train: train
      ? {
          converged: train.converged,
          eventsRun: train.events_run,
          peakPerEventC: train.peak_surface_temperatures_c,
          bulkPerEventC: train.peak_bulk_temperatures_c,
          hotSpotDeltasC: null,
          cyclicPeakC: train.cyclic_peak_surface_c,
          cyclicHotSpotDeltaC: null,
          surfaceMinusBulkAtPeakC: train.surface_minus_bulk_at_peak_c,
          totalEnergyInJ: train.total_energy_in_j,
          totalConvectiveEnergyJ: train.total_convective_energy_j,
          totalRadiativeEnergyJ: train.total_radiative_energy_j,
          trainTimesS: train.train_times_s,
          trainPeakSurfaceC: train.train_peak_surface_c,
          trainBulkAverageC: train.train_bulk_average_c,
        }
      : null,
  };
}

function shapeFace(
  id: number,
  result: FaceFieldResult,
  train: FaceEventTrainResult | null,
): SolverOk {
  const useTrainFrames = train?.train_snapshots_c != null && train.train_snapshot_times_s != null;
  const frames = useTrainFrames ? train!.train_snapshots_c! : result.temperature_c;
  const times = useTrainFrames ? train!.train_snapshot_times_s! : result.snapshot_times_s;
  const packed = packSnapshots(frames);
  return {
    id,
    ok: true,
    kind: "face",
    colAxisM: result.x_m,
    rowAxisM: result.y_m,
    nRows: packed.nRows,
    nCols: packed.nCols,
    snapTimesS: times,
    snapData: packed.data,
    snapSpan: useTrainFrames ? "run" : "stop",
    activeMask: packMask(result.active_mask),
    peakC: result.peak_temperature_c,
    peakTimeS: result.peak_time_s,
    lumpedDeltaTC: result.lumped_delta_t_c,
    analyticSurfaceRiseC: null,
    energyBalanceErrorFraction: result.energy_balance_error_fraction,
    sectionMassKg: result.section_mass_kg,
    fluxAreaM2: result.contact_area_m2,
    sweptRBoundsM: null,
    coolestMetalC: coldestFinite(result.temperature_c),
    peakLocationMm: result.peak_location_mm,
    hotSpotDeltaC: result.hot_spot_delta_c,
    radialBinsM: result.radial_bins_m,
    radialMaxC: result.radial_max_c,
    radialMeanC: result.radial_mean_c,
    radialMinC: result.radial_min_c,
    historyTimesS: result.history_times_s,
    peakHistoryC: result.peak_band_history_c,
    bulkHistoryC: result.bulk_average_history_c,
    energyInHistoryJ: result.energy_in_history_j,
    convectiveEnergyHistoryJ: result.convective_energy_history_j,
    radiativeEnergyHistoryJ: result.radiative_energy_history_j,
    energyInJ: result.energy_in_j,
    storedEnergyJ: result.stored_energy_j,
    convectiveEnergyJ: result.convective_energy_j,
    radiativeEnergyJ: result.radiative_energy_j,
    train: train
      ? {
          converged: train.converged,
          eventsRun: train.events_run,
          peakPerEventC: train.peak_temperatures_c,
          bulkPerEventC: train.peak_bulk_temperatures_c,
          hotSpotDeltasC: train.hot_spot_deltas_c,
          cyclicPeakC: train.cyclic_peak_c,
          cyclicHotSpotDeltaC: train.cyclic_hot_spot_delta_c,
          surfaceMinusBulkAtPeakC: null,
          totalEnergyInJ: train.total_energy_in_j,
          totalConvectiveEnergyJ: train.total_convective_energy_j,
          totalRadiativeEnergyJ: train.total_radiative_energy_j,
          trainTimesS: train.train_times_s,
          trainPeakSurfaceC: train.train_peak_surface_c,
          trainBulkAverageC: train.train_bulk_average_c,
        }
      : null,
  };
}

// --- dispatch -----------------------------------------------------------------

function runAnnulus(request: AnnulusRequest): SolverOk {
  const model = makeRotorFdmModel(
    request.geometry,
    request.cooling,
    null,
    request.nRadial,
    request.nAxial,
  );
  if (request.mode === "steady") {
    return shapeAnnulus(request.id, solveSteadyBandTemperature(model, request.bandTemperatureC!), null);
  }
  const pulse = makeHeatPulse(request.energyJ, request.durationS);
  if (request.mode === "train") {
    const train = simulateEventTrain(
      model,
      pulse,
      request.gapS,
      request.maxEvents,
      2.0,
      0.01,
      request.consecutiveRequired ?? 3,
      request.snapshots,
    );
    return shapeAnnulus(request.id, train.final_field, train);
  }
  return shapeAnnulus(
    request.id,
    simulateSingleStop(model, pulse, null, request.coolDownS, request.snapshots),
    null,
  );
}

function runSection(request: SectionRequest): SolverOk {
  const model = makeSectionFdmModel(
    makeRotorSection(request.pointsMm, request.material, request.holeBands),
    request.cooling,
    makeSweptBand(request.bandDepthMm, request.bandOffsetMm),
    null,
    request.nRadial,
    request.nAxial,
  );
  if (request.mode === "steady") {
    return shapeSection(
      request.id,
      solveSectionSteadyBandTemperature(model, request.bandTemperatureC!),
      null,
    );
  }
  const pulse = makeHeatPulse(request.energyJ, request.durationS);
  if (request.mode === "train") {
    const train = simulateSectionEventTrain(
      model,
      pulse,
      request.gapS,
      request.maxEvents,
      2.0,
      0.01,
      request.consecutiveRequired ?? 3,
      request.snapshots,
    );
    return shapeSection(request.id, train.final_field, train);
  }
  return shapeSection(
    request.id,
    simulateSectionSingleStop(model, pulse, null, request.coolDownS, request.snapshots),
    null,
  );
}

function runFace(request: FaceRequest): SolverOk {
  const model = makeFacePlateModel(
    makeRotorFaceGeometry(
      request.outerDiameterMm,
      request.innerDiameterMm,
      request.thicknessMm,
      request.material,
      request.innerBoundaryMm,
      request.holeCentersMm,
      request.slotLoopsMm,
    ),
    request.cooling,
    makeSweptBand(request.bandDepthMm, request.bandOffsetMm),
    null,
    request.nPixels,
  );
  // The plate model is transient-only — a held band temperature is a steady
  // Dirichlet solve only the axisymmetric models offer, so the page never
  // sends "steady" here.
  const pulse = makeHeatPulse(request.energyJ, request.durationS);
  if (request.mode === "train") {
    const train = simulateFaceEventTrain(
      model,
      pulse,
      request.gapS,
      request.maxEvents,
      2.0,
      0.01,
      request.consecutiveRequired ?? 3,
      request.snapshots,
    );
    return shapeFace(request.id, train.final_field, train);
  }
  return shapeFace(
    request.id,
    simulateFaceSingleStop(model, pulse, null, request.coolDownS, request.snapshots),
    null,
  );
}

function run(request: SolverRequest): SolverOk {
  switch (request.kind) {
    case "annulus":
      return runAnnulus(request);
    case "section":
      return runSection(request);
    case "face":
      return runFace(request);
  }
}

/** The worker's own global.
 *
 * `self` types as a Window under the DOM lib, whose `postMessage` takes a
 * target origin rather than a transfer list — so it is narrowed here rather
 * than pulling the whole webworker lib into a project that is otherwise DOM. */
const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<SolverRequest>) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};

ctx.onmessage = (event: MessageEvent<SolverRequest>) => {
  const request = event.data;
  try {
    const response = run(request);
    // Transfer the field stack rather than cloning it: a face train is tens of
    // megabytes and a structured clone would cost the main thread as long as
    // the worker just saved it.
    const transfer: Transferable[] = [response.snapData.buffer as ArrayBuffer];
    if (response.activeMask) transfer.push(response.activeMask.buffer as ArrayBuffer);
    ctx.postMessage(response, transfer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A solver ValueError (rotor heat fraction > 1, impossible geometry) is a
    // user-facing message, not a crash — surface it rather than letting the
    // worker die silently and leave the UI spinning forever.
    ctx.postMessage({ id: request.id, ok: false, message } satisfies SolverErr);
  }
};
