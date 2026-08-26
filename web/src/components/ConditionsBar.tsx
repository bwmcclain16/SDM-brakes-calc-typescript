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
import { MANUAL_PAD, PAD_MODELS, PAD_NAMES } from "../state/materials.ts";
import {
  maxCharacterizedTemperatureC,
  minCharacterizedTemperatureC,
} from "@core/models/padFriction.ts";

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
      {/* The pad compound is an operating condition, not hardware: it decides
          mu, and a characterized compound also decides how mu moves with rotor
          temperature. Picking one attaches its mu(T) curve to every solver that
          can use it; "Constant mu" detaches the curve and takes the number. */}
      <div className="field">
        <label htmlFor="cond-pad">Brake pad compound</label>
        <select
          id="cond-pad"
          style={{ width: 190 }}
          value={scenario.conditions.pad_label}
          onChange={(e) => {
            const label = e.target.value;
            const model = PAD_MODELS[label];
            dispatch({
              type: "patchConditions",
              patch: {
                pad_label: label,
                // A characterized compound brings its own design mu; manual
                // keeps whatever was last entered.
                ...(model?.design_mu != null ? { pad_mu: model.design_mu } : {}),
              },
            });
          }}
        >
          {PAD_NAMES.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
          <option value={MANUAL_PAD}>{MANUAL_PAD}</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="cond-mu" title={padTooltip(scenario.conditions.pad_label)}>
          Pad μ{PAD_MODELS[scenario.conditions.pad_label] ? " (design)" : ""}
        </label>
        <input
          id="cond-mu"
          type="number"
          step={0.01}
          value={scenario.conditions.pad_mu}
          onChange={(e) => {
            const value = Number(e.target.value);
            if (!Number.isNaN(value)) dispatch({ type: "patchConditions", patch: { pad_mu: value } });
          }}
        />
      </div>
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

/** What the selected compound's curve actually covers — the design μ alone
 *  says nothing about where μ(T) stops being measured and starts being
 *  extrapolated. */
function padTooltip(label: string): string {
  const model = PAD_MODELS[label];
  if (!model) return "Temperature-independent μ, used everywhere.";
  return (
    `μ(T) curve characterized ${minCharacterizedTemperatureC(model).toFixed(0)}` +
    `–${maxCharacterizedTemperatureC(model).toFixed(0)} °C · design μ used for the ` +
    "static bias and line-pressure checks."
  );
}
