/** Operating conditions — the STOP, not the car.
 *
 * These describe what the vehicle is doing and apply to every analysis. They sit
 * here, once, because when they were declared per-page the same quantity could
 * hold different values at the same time.
 *
 * Sweep bounds are deliberately absent: they describe what a single analysis
 * explores, and hoisting them here would be the same mistake inverted.
 */
import type { Dispatch } from "react";
import type { Action, Scenario } from "../state/store.ts";

interface FieldSpec {
  key: keyof Scenario["conditions"];
  label: string;
  step: number;
}

const FIELDS: FieldSpec[] = [
  { key: "driver_mass_kg", label: "Driver mass, kg", step: 1 },
  { key: "target_deceleration_g", label: "Target decel, g", step: 0.05 },
  { key: "ambient_temperature_c", label: "Ambient, °C", step: 1 },
  { key: "allowable_rotor_temperature_c", label: "Allowable, °C", step: 10 },
  { key: "event_gap_s", label: "Event gap, s", step: 1 },
  { key: "pedal_force_n", label: "Pedal force, N", step: 5 },
];

export function ConditionsBar({
  scenario,
  dispatch,
}: {
  scenario: Scenario;
  dispatch: Dispatch<Action>;
}) {
  return (
    <div className="conditions">
      {FIELDS.map(({ key, label, step }) => (
        <div className="field" key={key}>
          <label htmlFor={`cond-${key}`}>{label}</label>
          <input
            id={`cond-${key}`}
            type="number"
            step={step}
            value={scenario.conditions[key] as number}
            onChange={(e) => {
              const value = Number(e.target.value);
              // Unbounded by design, matching the Python app: physically
              // impossible values are caught at the solver with a clear error
              // rather than clamped silently in the UI.
              if (!Number.isNaN(value)) dispatch({ type: "patchConditions", patch: { [key]: value } });
            }}
          />
        </div>
      ))}
      <div className="field">
        <label htmlFor="cond-aero">Aero</label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
          <input
            id="cond-aero"
            type="checkbox"
            checked={scenario.conditions.include_aero}
            onChange={(e) =>
              dispatch({ type: "patchConditions", patch: { include_aero: e.target.checked } })
            }
            style={{ width: 13, height: 13, padding: 0 }}
          />
          <span style={{ color: "var(--text)" }}>downforce</span>
        </label>
      </div>
    </div>
  );
}
