/** The three-zone shell.
 *
 * Nine destinations, down from the fifteen the Streamlit app carried, grouped by
 * the question each answers rather than by which file it lives in. Setup absorbs
 * the five pages that between them held 33 inputs describing one car; Curved and
 * Trail stay separate because Trail is the time-domain corner entry a lap sim
 * would feed, and burying it would hide that seam.
 */
import { useMemo, useReducer, useState } from "react";
import { ScenarioRail } from "./components/ScenarioRail.tsx";
import { ConditionsBar } from "./components/ConditionsBar.tsx";
import { initialState } from "./state/bootstrap.ts";
import { activeScenario, comparedScenarios, isComparing, reduce } from "./state/store.ts";
import type { PageId } from "./pages/registry.tsx";
import { PAGES, PAGE_GROUPS } from "./pages/registry.tsx";

export default function App() {
  const [state, dispatch] = useReducer(reduce, undefined, initialState);
  const [page, setPage] = useState<PageId>("straight-line");

  const active = activeScenario(state);
  const compared = useMemo(() => comparedScenarios(state), [state]);
  const comparing = isComparing(state);
  const entry = PAGES[page];

  return (
    <div className="shell">
      <nav className="rail">
        <div className="rail-section">
          <span className="eyebrow">Scenarios</span>
          <ScenarioRail state={state} dispatch={dispatch} />
        </div>

        <div className="rail-section">
          <span className="eyebrow">Analyses</span>
          {PAGE_GROUPS.map((group) => (
            <div key={group.label || "root"} className={group.label ? "nav-group" : undefined}>
              {group.label && <span className="eyebrow">{group.label}</span>}
              <div className="nav">
                {group.pages.map((id) => (
                  <button
                    key={id}
                    className={`nav-item${id === page ? " active" : ""}`}
                    onClick={() => setPage(id)}
                    aria-current={id === page ? "page" : undefined}
                  >
                    {PAGES[id].title}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </nav>

      <div className="work">
        <ConditionsBar scenario={active} dispatch={dispatch} />
        <main className="page">
          <div className="page-head">
            <h1>{entry.title}</h1>
          </div>
          {entry.blurb && <p className="page-sub">{entry.blurb}</p>}

          {comparing && (
            <div className="compare-banner">
              Comparing <strong>{compared.map((s) => s.name).join(", ")}</strong>. Charts that can
              overlay show every scenario; field views repeat once per scenario.
            </div>
          )}

          <entry.Component scenario={active} compared={compared} comparing={comparing} dispatch={dispatch} />
        </main>
      </div>
    </div>
  );
}
