/** Scenario comparison: what actually differs.
 *
 * A configuration delta table across the compared scenarios, plus a couple of
 * computed headline metrics so the page answers "what actually differs" rather
 * than just "what did I type differently" — two scenarios can carry identical
 * hardware numbers and still land at a different front torque split if, say,
 * one has a different target deceleration.
 *
 * The first (baseline) column is always the active scenario — that ordering
 * comes straight from `comparedScenarios` in the store, not chosen here.
 */
import type { Scenario } from "../state/store.ts";
import { scenarioLabel } from "../state/store.ts";
import { frontAxleTorqueDistribution } from "@core/solvers/brakeBias.ts";
import { idealFrontBrakeFraction } from "@core/solvers/vehicle.ts";
import { NeedsInputError } from "@core/errors.ts";
import type { PageProps } from "./registry.tsx";

/** A row's value, per scenario. `null` means the computation needs an input
 *  the scenario doesn't carry (e.g. no pad swept diameters) — shown as
 *  "needs input" with a dashed delta, not silently dropped. */
type CellValue = number | string | null;

interface Row {
  label: string;
  digits: number;
  suffix: string;
  value: (s: Scenario) => CellValue;
}

const CONFIG_ROWS: Row[] = [
  { label: "Front rotor OD", digits: 1, suffix: " mm", value: (s) => s.brakes.front.rotor_outer_diameter_mm },
  { label: "Front rotor thickness", digits: 1, suffix: " mm", value: (s) => s.brakes.front.rotor_thickness_mm },
  { label: "Rear rotor OD", digits: 1, suffix: " mm", value: (s) => s.brakes.rear.rotor_outer_diameter_mm },
  { label: "Rear rotor thickness", digits: 1, suffix: " mm", value: (s) => s.brakes.rear.rotor_thickness_mm },
  { label: "Front pressure bias", digits: 1, suffix: " %", value: (s) => s.brakes.front_pressure_fraction * 100 },
  { label: "Pedal ratio", digits: 2, suffix: "", value: (s) => s.brakes.pedal_ratio },
  { label: "Driver mass", digits: 1, suffix: " kg", value: (s) => s.conditions.driver_mass_kg },
  { label: "Target deceleration", digits: 2, suffix: " g", value: (s) => s.conditions.target_deceleration_g },
  // Non-numeric on purpose: a pad name has no meaningful delta.
  { label: "Pad compound", digits: 0, suffix: "", value: (s) => s.conditions.pad_label },
];

/** `frontAxleTorqueDistribution` throws `NeedsInputError` when a scenario is
 *  missing the pad swept band (the uniform-pressure method needs it) — caught
 *  here rather than propagating, so one under-specified scenario doesn't blow
 *  up the whole comparison. */
function safeFrontTorqueSplitPct(s: Scenario): number | null {
  try {
    return frontAxleTorqueDistribution(s.brakes) * 100;
  } catch (err) {
    if (err instanceof NeedsInputError) return null;
    throw err;
  }
}

const COMPUTED_ROWS: Row[] = [
  { label: "Front torque split", digits: 1, suffix: " %", value: safeFrontTorqueSplitPct },
  {
    label: "Ideal bias @ target decel",
    digits: 1,
    suffix: " %",
    value: (s) => idealFrontBrakeFraction(s.vehicle, s.conditions.target_deceleration_g) * 100,
  },
];

function fmtValue(v: CellValue, digits: number, suffix: string): string {
  if (v == null) return "needs input";
  if (typeof v === "string") return v;
  return `${v.toFixed(digits)}${suffix}`;
}

function fmtDelta(base: CellValue, v: CellValue, digits: number, suffix: string): string {
  if (typeof base !== "number" || typeof v !== "number") return "—"; // em dash: no meaningful delta
  const d = v - base;
  if (d === 0) return `0${suffix}`;
  return `${d > 0 ? "+" : ""}${d.toFixed(digits)}${suffix}`;
}

function DeltaTable({ rows, compared }: { rows: Row[]; compared: Scenario[] }) {
  const baseline = compared[0]!;
  return (
    <div className="scroll-x">
      <table>
        <thead>
          <tr>
            <th></th>
            {compared.map((s) => (
              <th key={s.id}>{scenarioLabel(s)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const baseVal = row.value(baseline);
            return (
              <tr key={row.label}>
                <td>{row.label}</td>
                {compared.map((s, i) => {
                  const val = row.value(s);
                  return (
                    <td className={typeof val === "number" ? "num" : undefined} key={s.id}>
                      {fmtValue(val, row.digits, row.suffix)}
                      {i > 0 && (
                        <div className="metric-delta">{fmtDelta(baseVal, val, row.digits, row.suffix)}</div>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function Compare({ compared }: PageProps) {
  if (compared.length < 2) {
    return (
      <div className="panel" style={{ padding: 18 }}>
        <p style={{ margin: 0, color: "var(--dim)" }}>
          Only one scenario is selected, so there is nothing to compare yet. Duplicate the active
          scenario in the rail (the “+” button under Scenarios) and change something, or tick the
          checkbox on an existing scenario to bring it into the comparison.
        </p>
      </div>
    );
  }

  return (
    <>
      <section>
        <h2>Configuration</h2>
        <DeltaTable rows={CONFIG_ROWS} compared={compared} />
      </section>

      <section style={{ marginTop: 24 }}>
        <h2>Headline metrics</h2>
        <DeltaTable rows={COMPUTED_ROWS} compared={compared} />
        <p className="note">
          Front torque split is the production uniform-pressure effective-radius method
          (frontAxleTorqueDistribution) and needs each scenario's pad swept band; a scenario
          without it reads "needs input" rather than a silently wrong number. Ideal bias is the
          static-plus-load-transfer target at each scenario's own target deceleration — it moving
          against the configured pressure bias above is the bias error at that g level, not a bug.
        </p>
      </section>
    </>
  );
}
