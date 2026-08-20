"""Golden fixtures for the numpy thermal core (2D FDM conduction models).

The scalar-solver tracer records whole return values, which does not work here:
these solvers return temperature FIELDS of shape (snapshots, axial, radial) --
tens of thousands of floats per call. So this records a differential digest
instead:

  * every scalar output in full (peak temperature, times, energy balance, ...)
  * every 1-D array in full (radii, axial stations, histories, radial profiles)
  * the FINAL temperature field in full, so the converged state is pinned exactly
  * a per-snapshot digest (min/max/mean/sum) across the whole time stack, so drift
    at ANY moment in the run is caught without shipping the entire 3-D array

A TypeScript port that diverges anywhere in the time integration fails the digest
even when its final state happens to look right.

Usage:  .venv/Scripts/python.exe tools/extract_thermal_fixtures.py
Writes: ts/fixtures/thermal.<scenario>.json
"""
from __future__ import annotations

import dataclasses
import json
import math
from pathlib import Path

import numpy as np

from sdm_brakes.models.internal import CoolingParameters
from sdm_brakes.models.rotors import RotorGeometry, RotorMaterial
from sdm_brakes.solvers.thermal_fdm import (
    HeatPulse,
    RotorFdmModel,
    semi_infinite_surface_rise_c,
    simulate_event_train,
    simulate_single_stop,
    solve_steady_band_temperature,
    stable_time_step_s,
)

import os

#: This repo holds only the TypeScript port. The extractors still need the
#: Python source of truth to trace, so it is located next door by default and
#: overridable for anyone whose checkout sits elsewhere.
TS_REPO = Path(__file__).resolve().parents[1]
PY_REPO = Path(os.environ.get("SDM_BRAKES_PY_REPO", TS_REPO.parent / "SDM-brakes-calc-2"))
if not (PY_REPO / "src" / "sdm_brakes").is_dir():
    raise SystemExit(
        "Python source repo not found at " + str(PY_REPO)
        + ". Set SDM_BRAKES_PY_REPO to the SDM-brakes-calc-2 checkout, and run"
        + " this with that repo venv interpreter (it needs sdm_brakes importable)."
    )
ROOT = PY_REPO
OUT = TS_REPO / "fixtures"

STEEL_1020 = RotorMaterial(
    name="1020 steel", density_kg_m3=7870.0, specific_heat_j_kgk=486.0,
    thermal_conductivity_w_mk=51.9,
)
FRONT_RING = RotorGeometry(
    outer_diameter_mm=183.0, inner_swept_diameter_mm=148.0, thickness_mm=4.0,
    material=STEEL_1020,
)
ADIABATIC = CoolingParameters(
    convection_coefficient_w_m2k=0.0, emissivity=0.0,
    ambient_temperature_c=35.0, allowable_rotor_temperature_c=500.0,
)
BASELINE = CoolingParameters(
    convection_coefficient_w_m2k=60.0, emissivity=0.55,
    ambient_temperature_c=35.0, allowable_rotor_temperature_c=500.0,
)


def num(x) -> object:
    f = float(x)
    if math.isnan(f):
        return {"__float__": "nan"}
    if math.isinf(f):
        return {"__float__": "inf" if f > 0 else "-inf"}
    return f


def digest(a: np.ndarray) -> dict:
    """Shape-preserving summary of an array of any rank."""
    flat = np.asarray(a, dtype=float).ravel()
    finite = flat[np.isfinite(flat)]
    return {
        "shape": list(np.asarray(a).shape),
        "min": num(finite.min()) if finite.size else None,
        "max": num(finite.max()) if finite.size else None,
        "mean": num(finite.mean()) if finite.size else None,
        "sum": num(finite.sum()) if finite.size else None,
        "nonFinite": int(flat.size - finite.size),
    }


def encode_result(result) -> dict:
    """Scalars in full, 1-D arrays in full, big arrays as digests (+ final field)."""
    out: dict = {}
    for f in dataclasses.fields(result):
        v = getattr(result, f.name)
        if v is None:
            out[f.name] = None
        elif isinstance(v, np.ndarray):
            if v.ndim == 1:
                out[f.name] = [num(x) for x in v.tolist()]
            else:
                out[f.name] = {"__digest__": digest(v)}
                if v.ndim == 3:      # (snapshots, axial, radial)
                    out[f.name]["perSnapshot"] = [digest(s) for s in v]
                    out[f.name]["final"] = [[num(x) for x in row] for row in v[-1]]
                elif v.ndim == 2:
                    out[f.name]["final"] = [[num(x) for x in row] for row in v]
        elif isinstance(v, (int, float, np.floating, np.integer)):
            out[f.name] = num(v) if not isinstance(v, bool) else v
        elif isinstance(v, (bool, str)) or v is None:
            out[f.name] = v
        elif isinstance(v, (list, tuple)):
            try:
                out[f.name] = [num(x) for x in v]
            except (TypeError, ValueError):
                pass
    return out


SCENARIOS: dict[str, dict] = {}


def add(name: str, inputs: dict, result) -> None:
    SCENARIOS[name] = {"inputs": inputs, "result": encode_result(result)}
    print(f"  {name:<42} ok")


def geom_inputs(geom, cooling, n_radial, n_axial) -> dict:
    return {
        "geometry": dataclasses.asdict(geom),
        "cooling": dataclasses.asdict(cooling),
        "n_radial": n_radial, "n_axial": n_axial,
    }


if __name__ == "__main__":
    os.chdir(PY_REPO)  # tests open data/ by relative path
    print("thermal_fdm (annulus) scenarios:")

    # 1. Adiabatic single stop — must reproduce the lumped rise, field stays uniform.
    m = RotorFdmModel(geometry=FRONT_RING, cooling=ADIABATIC, n_radial=41, n_axial=9)
    r = simulate_single_stop(m, HeatPulse(energy_j=34_200.0, duration_s=2.5), cool_down_s=0.0)
    add("annulus_adiabatic_single_stop",
        {**geom_inputs(FRONT_RING, ADIABATIC, 41, 9),
         "pulse": {"energy_j": 34_200.0, "duration_s": 2.5}, "cool_down_s": 0.0}, r)

    # 2. Baseline cooling single stop + cool-down — the everyday case.
    m = RotorFdmModel(geometry=FRONT_RING, cooling=BASELINE, n_radial=41, n_axial=9)
    r = simulate_single_stop(m, HeatPulse(energy_j=34_200.0, duration_s=2.5), cool_down_s=8.0)
    add("annulus_baseline_single_stop",
        {**geom_inputs(FRONT_RING, BASELINE, 41, 9),
         "pulse": {"energy_j": 34_200.0, "duration_s": 2.5}, "cool_down_s": 8.0}, r)

    # 3. Repeated-event train — exercises cyclic convergence, the delicate part.
    r = simulate_event_train(m, HeatPulse(energy_j=34_200.0, duration_s=2.5), gap_s=8.0)
    add("annulus_event_train",
        {**geom_inputs(FRONT_RING, BASELINE, 41, 9),
         "pulse": {"energy_j": 34_200.0, "duration_s": 2.5}, "gap_s": 8.0}, r)

    # 4. Steady fixed-band solve — the Dirichlet path.
    geom = RotorGeometry(outer_diameter_mm=183.0, inner_swept_diameter_mm=148.0,
                         thickness_mm=4.0, material=STEEL_1020,
                         hat_interface_diameter_mm=100.0)
    m = RotorFdmModel(geometry=geom, cooling=BASELINE, n_radial=41, n_axial=7)
    add("annulus_steady_band_450c",
        {**geom_inputs(geom, BASELINE, 41, 7), "band_temperature_c": 450.0},
        solve_steady_band_temperature(m, 450.0))

    # 5 & 6. Standalone helpers, exact scalars.
    scalars = {
        "stable_time_step_s": {
            "cases": [
                {"args": [dr, dz, safety],
                 "value": num(stable_time_step_s(STEEL_1020, dr, dz, safety))}
                for dr, dz, safety in [
                    (0.4375e-3, 0.25e-3, 0.5), (1.0e-3, 0.5e-3, 0.5), (0.5e-3, 0.5e-3, 0.9),
                ]
            ],
            "material": dataclasses.asdict(STEEL_1020),
        },
        "semi_infinite_surface_rise_c": {
            "cases": [
                {"args": [q, t],
                 "value": num(semi_infinite_surface_rise_c(q, STEEL_1020, t))}
                for q, t in [(1.4e6, 2.5), (5.0e5, 1.0), (2.0e6, 0.5)]
            ],
            "material": dataclasses.asdict(STEEL_1020),
        },
    }

    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / "thermal.annulus.json"
    # Compact: fixtures are machine-read, and pretty-printing tripled the file.
    path.write_text(json.dumps(
        {"module": "sdm_brakes.solvers.thermal_fdm",
         "scenarios": SCENARIOS, "scalars": scalars},
        separators=(",", ":"), sort_keys=True), encoding="utf-8")
    kb = path.stat().st_size / 1024
    print(f"\n{len(SCENARIOS)} scenarios + {len(scalars)} scalar groups -> {path.name} ({kb:.0f} KB)")
