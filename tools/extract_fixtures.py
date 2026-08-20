"""Record every scalar-solver call made by the Python test suite as JSON fixtures.

These fixtures are the contract the TypeScript port is held to: identical inputs
must produce identical outputs. They are captured from the REAL 304-test run
rather than hand-authored, so they carry the same inputs the physics was
validated against (including the 24-25 workbook regression anchors).

Usage:  .venv/Scripts/python.exe tools/extract_fixtures.py
Writes: ts/fixtures/<module>.json
"""
from __future__ import annotations

import dataclasses
import importlib
import inspect
import json
import math
from pathlib import Path

import numpy as np
import pytest

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
OUT_DIR = TS_REPO / "fixtures"

# Scalar solvers + the models they consume. The numpy-heavy thermal FDM modules
# are deliberately excluded: their fixtures are whole 2D fields and need a
# different (array-comparison) harness, built when those modules are ported.
TRACE_MODULES = [
    "sdm_brakes.solvers.vehicle",
    "sdm_brakes.solvers.brake_bias",
    "sdm_brakes.solvers.hydraulics",
    "sdm_brakes.solvers.pedal",
    "sdm_brakes.solvers.sizing",
    "sdm_brakes.solvers.fluid",
    "sdm_brakes.solvers.cooling_requirements",
    "sdm_brakes.solvers.combined_braking",
    "sdm_brakes.solvers.straight_line_braking",
    "sdm_brakes.solvers.repeated_events",
    "sdm_brakes.solvers.trail_braking",
    "sdm_brakes.solvers.aero",
    "sdm_brakes.solvers.bobbins",
    # These two return 1-D arrays and small point lists, so whole-value recording
    # works; only the 2-D/3-D field solvers need the digest fixtures.
    "sdm_brakes.solvers.thermal_expansion",
    "sdm_brakes.solvers.thermal_growth_geometry",
    "sdm_brakes.models.rotors",
    "sdm_brakes.models.tires",
    "sdm_brakes.models.pad_friction",
    "sdm_brakes.models.fluid",
    "sdm_brakes.models.suspension",
    "sdm_brakes.models.bobbins",
]

MAX_RECORDS_PER_FN = 40
MAX_RECORD_BYTES = 120_000

records: dict[str, list[dict]] = {}
_seen: dict[str, set[str]] = {}
signatures: dict[str, list[dict]] = {}


def capture_signature(key: str, fn) -> None:
    """Ordered parameter list + defaults.

    Python lets a caller skip an earlier optional positional and pass only a
    later one by keyword. Replaying that as `f(...args, ...values(kwargs))`
    silently lands the value in the wrong slot, so the harness needs the real
    parameter order to bind by name.
    """
    if key in signatures:
        return
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return
    out = []
    for name, prm in params.items():
        if prm.kind in (prm.VAR_POSITIONAL, prm.VAR_KEYWORD):
            continue
        entry = {"name": name, "hasDefault": prm.default is not prm.empty}
        if entry["hasDefault"]:
            try:
                entry["default"] = encode(prm.default)
            except Unserializable:
                entry["hasDefault"] = False
        out.append(entry)
    signatures[key] = out


class Unserializable(Exception):
    pass


def encode(value, depth: int = 0):
    """JSON-safe encoding that preserves numeric identity exactly."""
    if depth > 12:
        raise Unserializable("too deep")
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, (int, np.integer)):
        return int(value)
    if isinstance(value, (float, np.floating)):
        f = float(value)
        if math.isnan(f):
            return {"__float__": "nan"}
        if math.isinf(f):
            return {"__float__": "inf" if f > 0 else "-inf"}
        return f
    if isinstance(value, np.ndarray):
        return {"__ndarray__": True, "shape": list(value.shape),
                "data": [encode(v, depth + 1) for v in value.ravel().tolist()]}
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {"__dataclass__": type(value).__name__,
                **{f.name: encode(getattr(value, f.name), depth + 1)
                   for f in dataclasses.fields(value)}}
    if isinstance(value, dict):
        return {str(k): encode(v, depth + 1) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [encode(v, depth + 1) for v in value]
    if type(value).__name__ == "DataFrame":
        return {"__dataframe__": True,
                "columns": [str(c) for c in value.columns],
                "records": [encode(r, depth + 1) for r in value.to_dict(orient="records")]}
    if type(value).__name__ == "Series":
        return {"__series__": True,
                **{str(k): encode(v, depth + 1) for k, v in value.to_dict().items()}}
    if isinstance(value, type) or callable(value):
        raise Unserializable("callable")
    raise Unserializable(f"unsupported type {type(value).__name__}")


def wrap(module_name: str, fn_name: str, fn):
    key = f"{module_name}.{fn_name}"

    def wrapper(*a, **kw):
        capture_signature(key, fn)
        try:
            result = fn(*a, **kw)
        except Exception as exc:                      # noqa: BLE001 - recording
            _record(key, a, kw, {"__raises__": type(exc).__name__})
            raise
        _record(key, a, kw, result, ok=True)
        return result

    wrapper.__wrapped__ = fn
    wrapper.__name__ = fn_name
    return wrapper


def _record(key, a, kw, result, ok: bool = False):
    bucket = records.setdefault(key, [])
    if len(bucket) >= MAX_RECORDS_PER_FN:
        return
    try:
        entry = {
            "args": [encode(v) for v in a],
            "kwargs": {k: encode(v) for k, v in kw.items()},
            "result": encode(result) if ok else result,
            "ok": ok,
        }
    except Unserializable:
        return
    blob = json.dumps(entry, sort_keys=True)
    if len(blob) > MAX_RECORD_BYTES:
        return
    seen = _seen.setdefault(key, set())
    sig = json.dumps({"a": entry["args"], "k": entry["kwargs"]}, sort_keys=True)
    if sig in seen:
        return
    seen.add(sig)
    bucket.append(entry)


def install():
    count = 0
    for module_name in TRACE_MODULES:
        try:
            module = importlib.import_module(module_name)
        except ImportError:
            print(f"  ! could not import {module_name}")
            continue
        for fn_name, fn in list(vars(module).items()):
            if fn_name.startswith("_") or not inspect.isfunction(fn):
                continue
            if getattr(fn, "__module__", None) != module_name:
                continue      # imported symbol, traced at its own module
            setattr(module, fn_name, wrap(module_name, fn_name, fn))
            count += 1
        # Model classes carry their physics as METHODS (PadFrictionModel.mu_at,
        # LoadSensitiveTire.mu_at); those need anchoring just as much.
        for cls_name, cls in list(vars(module).items()):
            if cls_name.startswith("_") or not inspect.isclass(cls):
                continue
            if getattr(cls, "__module__", None) != module_name:
                continue
            for meth_name, meth in list(vars(cls).items()):
                if meth_name.startswith("_") or not inspect.isfunction(meth):
                    continue
                setattr(cls, meth_name, wrap(module_name, f"{cls_name}.{meth_name}", meth))
                count += 1
    return count


if __name__ == "__main__":
    os.chdir(PY_REPO)  # tests open data/ by relative path
    traced = install()
    print(f"instrumented {traced} functions across {len(TRACE_MODULES)} modules")
    code = pytest.main(["-q", "--no-header", "-p", "no:cacheprovider", str(ROOT / "tests")])
    print(f"pytest exit={code}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    by_module: dict[str, dict[str, list]] = {}
    for key, entries in records.items():
        module_name, fn_name = key.split(".sdm_brakes.")[0], key
        for cand in TRACE_MODULES:
            if key.startswith(cand + "."):
                module_name, fn_name = cand, key[len(cand) + 1:]
                break
        by_module.setdefault(module_name, {})[fn_name] = entries

    total = 0
    for module_name, fns in sorted(by_module.items()):
        short = module_name.split(".")[-1]
        area = module_name.split(".")[-2]
        path = OUT_DIR / f"{area}.{short}.json"
        sigs = {}
        for full_key, params in signatures.items():
            if full_key.startswith(module_name + "."):
                sigs[full_key[len(module_name) + 1:]] = params
        path.write_text(json.dumps(
            {"module": module_name, "functions": fns, "signatures": sigs},
            indent=1, sort_keys=True), encoding="utf-8")
        n = sum(len(v) for v in fns.values())
        total += n
        print(f"  {path.name:<44} {len(fns):>3} fns  {n:>4} cases")
    print(f"TOTAL {total} recorded cases -> {OUT_DIR}")
