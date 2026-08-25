"""Convert the Python project's YAML data files to JSON for the browser build.

The browser app is a static site: bundling a YAML parser to read files that
never change at runtime is a dependency for nothing. Converting at port time
keeps the core dependency-free and lets the bundler tree-shake the data.

Round-trips through the SAME loaders the Python app uses, so anything the
schema rejects fails here rather than silently shipping malformed data.

Usage:  <py-repo>/.venv/Scripts/python.exe tools/convert_data.py
"""
from __future__ import annotations

import datetime as _dt
import json
import os
from pathlib import Path

import yaml

TS_REPO = Path(__file__).resolve().parents[1]
PY_REPO = Path(os.environ.get("SDM_BRAKES_PY_REPO", TS_REPO.parent / "SDM-brakes-calc-2"))
if not (PY_REPO / "data").is_dir():
    raise SystemExit(
        "Python data directory not found at " + str(PY_REPO / "data")
        + ". Set SDM_BRAKES_PY_REPO to the SDM-brakes-calc-2 checkout."
    )
OUT = TS_REPO / "data"

def _encode(value):
    """Dates round-trip as ISO strings: YAML parses `date_accessed: 2026-05-31`
    into a date object, which JSON has no representation for."""
    if isinstance(value, (_dt.date, _dt.datetime)):
        return value.isoformat()
    raise TypeError(f"unserializable {type(value).__name__} in source data")


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    written = []
    for source in sorted((PY_REPO / "data").rglob("*.yaml")):
        relative = source.relative_to(PY_REPO / "data")
        target = OUT / relative.with_suffix(".json")
        target.parent.mkdir(parents=True, exist_ok=True)
        with source.open("r", encoding="utf-8") as handle:
            payload = yaml.safe_load(handle)
        target.write_text(
            json.dumps(payload, indent=1, sort_keys=False, ensure_ascii=False, default=_encode),
            encoding="utf-8",
        )
        written.append((str(relative).replace("\\", "/"), target.stat().st_size))

    # Also carry the CSV templates the aero map importer accepts.
    for source in sorted((PY_REPO / "data").rglob("*.csv")):
        relative = source.relative_to(PY_REPO / "data")
        target = OUT / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(source.read_text(encoding="utf-8"), encoding="utf-8")
        written.append((str(relative).replace("\\", "/"), target.stat().st_size))

    for name, size in written:
        print(f"  {name:<52} {size:>7,} B")
    print(f"{len(written)} files -> {OUT}")
