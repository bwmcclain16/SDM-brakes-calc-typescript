# SDM Brakes — TypeScript core

TypeScript port of the SDM Brakes calculator's solver core. Framework-agnostic
and dependency-free, so it runs unchanged in a browser, a Web Worker, or Node.

The Python original lives in a **separate repo** (`SDM-brakes-calc-2`) and is
untouched by this one. The two run side by side until the port is complete.

## Status

| | |
|---|---|
| 18 scalar solver/model modules | 658/658 golden cases at 1e-12 |
| `thermal_fdm` (2D axisymmetric FDM) | 4 scenarios at 1e-12 |
| `thermal_fdm_section` | not ported |
| `thermal_face_plane` | not ported |
| `thermal_expansion` | not ported |
| `thermal_growth_geometry` | not ported |

## Running the tests

Node 22+ strips TypeScript types natively, so there is **no build step and no
`npm install`**:

```
node --test --experimental-strip-types "test/**/*.test.ts"
```

`test/coverage.test.ts` is the guard that matters: it walks every fixture,
resolves the module it belongs to, and fails if one is unported or missing an
export. Per-module tests can only fail for modules that *have* a test — a
module nobody ported is invisible to them, and not to that one.

## How correctness is established

The port is not hand-checked against the Python. `tools/extract_fixtures.py`
instruments the Python suite and records **every call it makes** to a traced
module — real inputs, real outputs, including the 24-25 workbook regression
anchors and the bobbin hand-calc anchors. `test/harness.ts` replays those
recordings against the TypeScript at 1e-12 relative tolerance.

The numpy thermal solvers return temperature fields too large to record whole,
so `tools/extract_thermal_fixtures.py` writes a differential digest instead:
scalars and 1-D arrays in full, the final 2-D field in full, plus a
**per-snapshot digest** across the whole time stack — so a port that drifts
mid-run fails even when its converged state looks right.

That harness has been mutation-tested, not assumed: perturbing a single radial
conduction flux term by one part in 1e9 fails 2 of 4 thermal scenarios.

## Regenerating fixtures

Needs the Python repo and its venv (the extractors import `sdm_brakes` and run
its pytest suite). By default the Python repo is expected next door at
`../SDM-brakes-calc-2`; override with `SDM_BRAKES_PY_REPO`.

```
../SDM-brakes-calc-2/.venv/Scripts/python.exe tools/extract_fixtures.py
../SDM-brakes-calc-2/.venv/Scripts/python.exe tools/extract_thermal_fixtures.py
```

## Conventions

Chosen so recorded fixtures decode straight into the ported shapes:

- Interface **field** names keep Python's `snake_case` — they carry unit
  suffixes (`cg_height_m`, `pad_swept_outer_diameter_mm`) that are the point.
- **Functions** are idiomatic `camelCase`, resolved from the Python name by the
  harness, so there is no hand-maintained name registry to drift.
- Frozen dataclasses become interfaces; methods become free functions taking
  the object first, matching how fixtures record `self` as argument 0.
- `NeedsInputError` / `PadTemperatureLimitExceeded` stay thrown errors rather
  than becoming Result types, keeping call sites 1:1 with the validated Python.
- **Zero runtime dependencies** in `src/`. This is load-bearing, not taste: the
  core has to run in a Web Worker without a bundler's help.
