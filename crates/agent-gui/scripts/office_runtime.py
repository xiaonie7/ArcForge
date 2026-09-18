#!/usr/bin/env python3
"""Single entry point for ArcForge's bundled Office runtime."""

from __future__ import annotations

import importlib.metadata
import json
import sys
from pathlib import Path
from typing import Optional, Sequence


RUNTIME_VERSION = "0.3.0"


def _configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="replace")


def _add_source_script_paths() -> None:
    if getattr(sys, "frozen", False):
        return
    gui_root = Path(__file__).resolve().parent.parent
    script_dirs = (
        gui_root
        / "src-tauri"
        / "prompt"
        / "skills"
        / "arcforge-spreadsheets"
        / "scripts",
        gui_root
        / "src-tauri"
        / "prompt"
        / "skills"
        / "arcforge-slides"
        / "scripts",
    )
    for script_dir in reversed(script_dirs):
        sys.path.insert(0, str(script_dir))


def _package_version(distribution: str) -> Optional[str]:
    try:
        return importlib.metadata.version(distribution)
    except importlib.metadata.PackageNotFoundError:
        return None


def runtime_info() -> dict[str, object]:
    return {
        "runtime": "arcforge-office-runtime",
        "version": RUNTIME_VERSION,
        "python": sys.version.split()[0],
        "frozen": bool(getattr(sys, "frozen", False)),
        "dependencies": {
            "openpyxl": _package_version("openpyxl"),
            "python-pptx": _package_version("python-pptx"),
            "Pillow": _package_version("Pillow"),
        },
    }


def print_help() -> None:
    print(
        "Usage:\n"
        "  arcforge-office-runtime doctor\n"
        "  arcforge-office-runtime spreadsheet <create|patch|code|inspect> [options]\n"
        "  arcforge-office-runtime presentation <create|patch|validate|inspect|render|render-png|prepare-preview|selection-context> [options]"
    )


def main(argv: Optional[Sequence[str]] = None) -> int:
    _configure_stdio()
    _add_source_script_paths()
    arguments = list(sys.argv[1:] if argv is None else argv)
    if not arguments or arguments[0] in {"-h", "--help"}:
        print_help()
        return 0
    if arguments[0] in {"doctor", "--version"}:
        print(json.dumps(runtime_info(), ensure_ascii=False, indent=2))
        return 0

    domain = arguments.pop(0).strip().lower()
    if domain == "spreadsheet":
        import spreadsheet

        return spreadsheet.main(arguments)
    if domain == "presentation":
        import presentation

        return presentation.main(arguments)

    print("error: unsupported Office runtime domain: " + domain, file=sys.stderr)
    print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
