/** Thermal solves, off the main thread.
 *
 * The face-resolved multi-stop run takes on the order of a minute. On the main
 * thread that is not a slow page, it is a frozen tab — no scrolling, no input,
 * no way to cancel. Streamlit hid this behind a server round trip and a spinner;
 * a browser has no such luxury, so the heavy solvers run here and post results
 * back.
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
import type { FieldSnapshot, ThermalFieldResult } from "@core/solvers/thermalFdm.ts";
import type { CoolingParameters } from "@core/models/internal.ts";
import type { RotorGeometry, RotorMaterial } from "@core/models/rotors.ts";

export interface AnnulusRequest {
  kind: "annulus";
  id: number;
  geometry: RotorGeometry;
  cooling: CoolingParameters;
  nRadial: number;
  nAxial: number;
  energyJ: number;
  durationS: number;
  coolDownS: number;
  /** > 0 switches to a repeated-event train with this gap. */
  gapS?: number;
  maxEvents?: number;
  /** Set instead of energy to hold the swept band at a fixed temperature. */
  bandTemperatureC?: number;
}

export type SolverRequest = AnnulusRequest;

export interface SolverOk {
  id: number;
  ok: true;
  /** Scalars and 1-D arrays only. A full (snapshots, axial, radial) field would
   *  be tens of MB across the postMessage boundary for a view that only ever
   *  renders the final frame plus histories. */
  peakSurfaceTemperatureC: number;
  peakSurfaceTimeS: number;
  lumpedDeltaTC: number;
  analyticSurfaceRiseC: number;
  energyBalanceErrorFraction: number;
  rMm: number[];
  zMm: number[];
  finalField: number[][];
  historyTimesS: number[];
  peakSurfaceHistoryC: number[];
  bulkAverageHistoryC: number[];
  eventsRun?: number;
  converged?: boolean;
  cyclicPeakSurfaceC?: number;
}

export interface SolverErr {
  id: number;
  ok: false;
  message: string;
}

export type SolverResponse = SolverOk | SolverErr;

function run(request: AnnulusRequest): SolverOk {
  const model = makeRotorFdmModel(
    request.geometry,
    request.cooling,
    null,
    request.nRadial,
    request.nAxial,
  );

  if (request.bandTemperatureC != null) {
    return shape(request.id, solveSteadyBandTemperature(model, request.bandTemperatureC));
  }

  const pulse = makeHeatPulse(request.energyJ, request.durationS);
  if (request.gapS != null && request.gapS > 0) {
    const train = simulateEventTrain(model, pulse, request.gapS, request.maxEvents ?? 60);
    return {
      ...shape(request.id, train.final_field),
      eventsRun: train.events_run,
      converged: train.converged,
      cyclicPeakSurfaceC: train.cyclic_peak_surface_c,
    };
  }
  return shape(request.id, simulateSingleStop(model, pulse, null, request.coolDownS));
}

/** Unpack a FieldSnapshot's flat Float64Array into rows for transfer.
 *
 * The core stores fields flat (idx = axial * nRadial + radial) because that is
 * what an explicit FD stencil wants; the UI wants rows. Only the FINAL snapshot
 * crosses the postMessage boundary — the whole stack would be tens of megabytes
 * for a view that renders one frame plus the histories. */
function snapshotRows(snapshot: FieldSnapshot | undefined): number[][] {
  if (!snapshot) return [];
  const { nAxial, nRadial, data } = snapshot;
  return Array.from({ length: nAxial }, (_, j) =>
    Array.from(data.subarray(j * nRadial, (j + 1) * nRadial)),
  );
}

function shape(id: number, result: ThermalFieldResult): SolverOk {
  return {
    id,
    ok: true,
    peakSurfaceTemperatureC: result.peak_surface_temperature_c,
    peakSurfaceTimeS: result.peak_surface_time_s,
    lumpedDeltaTC: result.lumped_delta_t_c,
    analyticSurfaceRiseC: result.analytic_surface_rise_c,
    energyBalanceErrorFraction: result.energy_balance_error_fraction,
    rMm: result.r_m.map((v) => v * 1000),
    zMm: result.z_m.map((v) => v * 1000),
    finalField: snapshotRows(result.temperature_c[result.temperature_c.length - 1]),
    historyTimesS: [...result.surface_history_times_s],
    peakSurfaceHistoryC: [...result.peak_surface_history_c],
    bulkAverageHistoryC: [...result.bulk_average_history_c],
  };
}

self.onmessage = (event: MessageEvent<SolverRequest>) => {
  const request = event.data;
  try {
    const response: SolverResponse = run(request);
    self.postMessage(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A solver ValueError (rotor heat fraction > 1, impossible geometry) is a
    // user-facing message, not a crash — surface it rather than letting the
    // worker die silently and leave the UI spinning forever.
    self.postMessage({ id: request.id, ok: false, message } satisfies SolverErr);
  }
};
