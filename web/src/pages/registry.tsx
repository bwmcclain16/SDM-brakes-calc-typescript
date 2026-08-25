/** The nine destinations.
 *
 * Down from fifteen in the Streamlit app, grouped by the question each answers.
 * Every page receives the same props, so a page is a pure view over the active
 * scenario plus whatever else is selected for comparison — it never reaches for
 * global state and never holds configuration of its own.
 *
 * Curved and Trail are deliberately separate destinations. They look mergeable
 * (both are "braking while turning") but Trail is the time-domain corner entry a
 * lap sim would feed, and Thermal's event train wants that same real gap
 * sequence. Merging them would bury the seam the lap-sim integration plugs into.
 */
import type { Dispatch, JSX } from "react";
import type { Action, Scenario } from "../state/store.ts";

export interface PageProps {
  scenario: Scenario;
  compared: Scenario[];
  comparing: boolean;
  dispatch: Dispatch<Action>;
}

export type PageId =
  | "setup"
  | "straight-line"
  | "curved"
  | "trail"
  | "hydraulics"
  | "thermal"
  | "bobbins"
  | "compare"
  | "report";

export interface PageEntry {
  title: string;
  blurb?: string;
  Component: (props: PageProps) => JSX.Element;
}

/** Placeholder until the real page lands, so the shell is runnable throughout
 *  the port rather than only at the end. */
function pending(what: string) {
  return function Pending() {
    return (
      <div className="panel" style={{ padding: 18 }}>
        <p style={{ margin: 0, color: "var(--dim)" }}>
          {what} is not ported yet. The shell, scenario store and conditions bar are live —
          this page is the remaining work.
        </p>
      </div>
    );
  };
}

export const PAGES: Record<PageId, PageEntry> = {
  setup: {
    title: "Setup",
    blurb:
      "The car itself: mass and geometry, brake hardware, rotor, materials, suspension and aero. " +
      "Set once per configuration — the stop conditions live in the bar above.",
    Component: pending("Setup"),
  },
  "straight-line": {
    title: "Straight-Line Braking",
    blurb: "Parameterised sweep over speed, driver mass, deceleration and front pressure bias.",
    Component: pending("Straight-line braking"),
  },
  curved: {
    title: "Curved Braking",
    blurb: "Steady-state combined braking and cornering: per-wheel friction ellipse and lock margin.",
    Component: pending("Curved braking"),
  },
  trail: {
    title: "Trail Braking",
    blurb: "Quasi-static time history through corner entry. The natural landing point for a lap-sim trace.",
    Component: pending("Trail braking"),
  },
  hydraulics: {
    title: "Hydraulics & Fluid",
    blurb: "Dual master-cylinder line pressures, caliper area adequacy, pedal travel and fluid boiling margins.",
    Component: pending("Hydraulics"),
  },
  thermal: {
    title: "Thermal",
    blurb: "Rotor temperature at two fidelities: lumped quick sizing, or the finite-difference field.",
    Component: pending("Thermal"),
  },
  bobbins: {
    title: "Bobbins",
    blurb: "Floating-rotor drive buttons: shear, bearing and mount-force checks.",
    Component: pending("Bobbin optimisation"),
  },
  compare: {
    title: "Compare",
    blurb: "Scenarios side by side — configuration differences and headline metrics.",
    Component: pending("Compare"),
  },
  report: {
    title: "Report",
    blurb: "Export the current configuration and results as HTML, CSV, or print to PDF.",
    Component: pending("Report"),
  },
};

export const PAGE_GROUPS: Array<{ label: string; pages: PageId[] }> = [
  { label: "", pages: ["setup"] },
  { label: "Braking", pages: ["straight-line", "curved", "trail", "hydraulics"] },
  { label: "Thermal", pages: ["thermal", "bobbins"] },
  { label: "Review", pages: ["compare", "report"] },
];
