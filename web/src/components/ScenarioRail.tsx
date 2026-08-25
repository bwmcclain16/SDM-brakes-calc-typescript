/** The scenario list: identity, above conditions.
 *
 * Comparison is a MODE, not a destination — ticking a second scenario here puts
 * whichever analysis you are already looking at into compare mode, in place. A
 * separate compare page would mean building every chart twice.
 */
import type { Dispatch } from "react";
import { useState } from "react";
import type { Action, AppState } from "../state/store.ts";
import { scenarioLabel } from "../state/store.ts";

export function ScenarioRail({ state, dispatch }: { state: AppState; dispatch: Dispatch<Action> }) {
  const [name, setName] = useState("");

  return (
    <>
      {state.scenarios.map((s) => {
        const active = s.id === state.activeId;
        const compared = state.compareIds.includes(s.id);
        return (
          <div key={s.id} className={`scenario${active ? " active" : ""}`}>
            <input
              type="checkbox"
              checked={active || compared}
              disabled={active}
              title={active ? "Active scenario is always shown" : "Compare against the active scenario"}
              onChange={(e) =>
                dispatch({
                  type: "setCompare",
                  ids: e.target.checked
                    ? [...state.compareIds, s.id]
                    : state.compareIds.filter((id) => id !== s.id),
                })
              }
              style={{ width: 13, height: 13, padding: 0 }}
            />
            <button
              className="scenario-name"
              style={{ background: "none", border: "none", padding: 0 }}
              onClick={() => dispatch({ type: "activate", id: s.id })}
            >
              {s.name}
              <div className="scenario-geo">{scenarioLabel(s).replace(`${s.name} `, "")}</div>
            </button>
          </div>
        );
      })}

      <div style={{ display: "flex", gap: 6 }}>
        <input
          placeholder="e.g. 3 mm rotor"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ flex: 1, minWidth: 0 }}
          aria-label="New scenario name"
        />
        <button
          onClick={() => {
            dispatch({ type: "duplicate", name });
            setName("");
          }}
          title="Copy the active scenario, then change something to make it differ"
        >
          +
        </button>
        <button
          disabled={state.scenarios.length <= 1}
          onClick={() => dispatch({ type: "delete", id: state.activeId })}
          title="Delete the active scenario"
        >
          −
        </button>
      </div>
    </>
  );
}
