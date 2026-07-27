from __future__ import annotations

import sys
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path


GUI_ROOT = Path(__file__).resolve().parents[2]
SPREADSHEET_SCRIPTS = (
    GUI_ROOT
    / "src-tauri"
    / "prompt"
    / "skills"
    / "arcforge-spreadsheets"
    / "scripts"
)
SMOKE_CREATE_SCRIPT = Path(__file__).resolve().parent / "fixtures" / "smoke_create.py"
sys.path.insert(0, str(SPREADSHEET_SCRIPTS))

import spreadsheet  # noqa: E402


class SpreadsheetCodeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_directory = tempfile.TemporaryDirectory(
            prefix="arcforge-spreadsheet-code-test-"
        )
        self.root = Path(self.temp_directory.name)

    def tearDown(self) -> None:
        self.temp_directory.cleanup()

    def write_script(self, name: str, source: str) -> Path:
        path = self.root / name
        path.write_text(source, encoding="utf-8")
        return path

    def run_code(
        self, script: Path, output: Path, input_path: Path | None = None
    ) -> dict[str, object]:
        return spreadsheet.run_code(
            Namespace(
                input=str(input_path) if input_path is not None else None,
                script=str(script),
                output=str(output),
                force=False,
            )
        )

    def test_creates_new_workbook_and_returns_script_evidence(self) -> None:
        output = self.root / "created.xlsx"

        result = self.run_code(SMOKE_CREATE_SCRIPT, output)

        self.assertEqual(result["action"], "code_executed")
        self.assertIsNone(result["input"])
        self.assertRegex(result["script"]["sha256"], r"^[0-9a-f]{64}$")
        self.assertGreater(result["script"]["ast_nodes"], 0)
        self.assertEqual(result["workbook"]["sheet_count"], 1)
        workbook = spreadsheet.load_workbook(output, data_only=False)
        try:
            self.assertEqual(workbook.sheetnames, ["Runtime Smoke"])
            self.assertEqual(workbook["Runtime Smoke"]["D4"].value, "=B4-C4")
            self.assertTrue(workbook["Runtime Smoke"]["A1"].font.bold)
            self.assertEqual(len(workbook["Runtime Smoke"]._charts), 1)
        finally:
            workbook.close()

    def test_modifies_existing_workbook_without_changing_source(self) -> None:
        input_path = self.root / "input.xlsx"
        source_workbook = spreadsheet.Workbook()
        source_sheet = source_workbook.active
        source_sheet.title = "Data"
        source_sheet.append(["Value"])
        source_sheet.append([7])
        source_workbook.save(input_path)
        source_workbook.close()
        script = self.write_script(
            "modify.py",
            """
sheet = workbook["Data"]
sheet["B1"] = "Double"
sheet["B2"] = "=A2*2"
""".strip(),
        )
        output = self.root / "modified.xlsx"

        result = self.run_code(script, output, input_path)

        self.assertEqual(result["input"], str(input_path.resolve()))
        original = spreadsheet.load_workbook(input_path, data_only=False)
        modified = spreadsheet.load_workbook(output, data_only=False)
        try:
            self.assertIsNone(original["Data"]["B1"].value)
            self.assertEqual(modified["Data"]["B1"].value, "Double")
            self.assertEqual(modified["Data"]["B2"].value, "=A2*2")
        finally:
            original.close()
            modified.close()

    def test_supports_wb_as_workbook_alias(self) -> None:
        script = self.write_script(
            "wb_alias.py",
            """
sheet = wb.active
sheet.title = "Alias Works"
sheet["A1"] = "created through wb"
""".strip(),
        )
        output = self.root / "wb-alias.xlsx"

        self.run_code(script, output)

        workbook = spreadsheet.load_workbook(output, data_only=False)
        try:
            self.assertEqual(workbook.sheetnames, ["Alias Works"])
            self.assertEqual(workbook["Alias Works"]["A1"].value, "created through wb")
        finally:
            workbook.close()

    def test_rejects_imports_filesystem_builtins_and_direct_save(self) -> None:
        cases = {
            "import.py": ("import os", "cannot use Import"),
            "open.py": ('open("outside.txt", "w")', "cannot access name 'open'"),
            "save.py": ('workbook.save("outside.xlsx")', "cannot access attribute 'save'"),
            "private.py": ("workbook._archive", "cannot access attribute '_archive'"),
            "rebind_wb.py": ("wb = workbook", "cannot rebind protected name 'wb'"),
        }
        for name, (source, message) in cases.items():
            with self.subTest(name=name):
                script = self.write_script(name, source)
                with self.assertRaisesRegex(spreadsheet.SpreadsheetError, message):
                    spreadsheet.load_spreadsheet_code(script)


if __name__ == "__main__":
    unittest.main()
