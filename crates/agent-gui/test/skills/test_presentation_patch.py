"""Scoped edits: patch one element or page, snapshot, revert, and refuse to touch neighbours."""

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
import subprocess
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[2] / "src-tauri/prompt/skills/arcforge-slides/scripts/presentation.py"
SPEC = importlib.util.spec_from_file_location("arcforge_presentation_patch", SCRIPT)
p = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = p
SPEC.loader.exec_module(p)


def page(title, body=""):
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n'
        f'  <text id="title" data-role="title" x="60" y="80" font-size="32">{title}</text>\n'
        '  <g id="cards">\n'
        '    <rect id="card-1" x="60" y="200" width="300" height="200" fill="#EEEEEE"/>\n'
        f'    <text id="kp-1" data-role="text_block" x="80" y="260" font-size="18">{body or "Body"}</text>\n'
        '  </g>\n'
        '  <text id="footer" data-role="footer" x="60" y="690" font-size="10">ArcForge</text>\n'
        '</svg>\n'
    )


class Args:
    def __init__(self, **values):
        defaults = {"template": None, "asset_cache": None, "force": False, "slide_id": None,
                    "element_id": None, "replacement": None, "edit_id": None, "revert": None}
        defaults.update(values)
        self.__dict__.update(defaults)


class PatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "design").mkdir()
        (self.root / "design" / "p-01.svg").write_text(page("Cover"), encoding="utf-8")
        (self.root / "design" / "p-02.svg").write_text(page("Growth comes from three customer types, not one channel"), encoding="utf-8")
        (self.root / "design" / "p-03.svg").write_text(page("Closing"), encoding="utf-8")
        self.spec = self.root / "deck.json"
        self.spec.write_text(json.dumps({
            "schema_version": 3, "mode": "blank", "stage": "design",
            "slides": [
                {"slide_id": "p-01", "svg": "design/p-01.svg"},
                {"slide_id": "p-02", "svg": "design/p-02.svg", "notes": "speaker"},
                {"slide_id": "p-03", "svg": "design/p-03.svg"},
            ],
        }), encoding="utf-8")
        self.output = self.root / "deck.pptx"
        p.run_create(Args(spec=str(self.spec), output=str(self.output)))

    def replacement(self, text, name="replacement.svg"):
        path = self.root / name
        path.write_text(text, encoding="utf-8")
        return str(path)

    def other_pages(self):
        return {name: (self.root / "design" / name).read_bytes() for name in ("p-01.svg", "p-03.svg")}

    def test_element_patch_changes_only_the_target_and_reports_only_that_page(self):
        others = self.other_pages()
        before_p2 = (self.root / "design" / "p-02.svg").read_text(encoding="utf-8")
        result = p.run_patch(Args(
            spec=str(self.spec), output=str(self.output), slide_id="p-02", element_id="title", edit_id="e-1",
            replacement=self.replacement('<text id="title" data-role="title" x="60" y="80" font-size="32">Growth from three types</text>'),
        ))
        self.assertEqual(result["action"], "patched")
        self.assertEqual(result["deck"]["changed_slide_ids"], ["p-02"])
        self.assertEqual(result["deck"]["patched_slide_ids"], ["p-02"])
        self.assertFalse(result["deck"]["shared_inputs_changed"])
        self.assertEqual(result["edit"]["before_text"], "Growth comes from three customer types, not one channel")
        self.assertEqual(result["edit"]["after_text"], "Growth from three types")
        self.assertEqual(self.other_pages(), others)
        after_p2 = (self.root / "design" / "p-02.svg").read_text(encoding="utf-8")
        # Only the title node changed; every other byte of the page is untouched.
        self.assertEqual(after_p2.replace("Growth from three types", "Growth comes from three customer types, not one channel"), before_p2)
        self.assertIn('<g id="cards">\n    <rect id="card-1"', after_p2)
        restored = p.Presentation(self.output)
        self.assertEqual(restored.slides[1].shapes[0].text, "Growth from three types")
        snapshot = json.loads((self.root / ".arcforge-history" / "e-1.json").read_text(encoding="utf-8"))
        self.assertEqual(snapshot["slide_id"], "p-02")
        self.assertEqual(snapshot["element_id"], "title")
        self.assertIn("not one channel", snapshot["before"])
        self.assertFalse(snapshot["reverted"])

    def test_revert_restores_the_exact_bytes_and_marks_the_snapshot(self):
        before = (self.root / "design" / "p-02.svg").read_bytes()
        p.run_patch(Args(spec=str(self.spec), output=str(self.output), slide_id="p-02", element_id="title", edit_id="e-2",
                         replacement=self.replacement('<text id="title" data-role="title" x="60" y="80">Short</text>')))
        self.assertNotEqual((self.root / "design" / "p-02.svg").read_bytes(), before)
        result = p.run_patch(Args(spec=str(self.spec), output=str(self.output), revert="e-2"))
        self.assertEqual((self.root / "design" / "p-02.svg").read_bytes(), before)
        self.assertEqual(result["deck"]["changed_slide_ids"], ["p-02"])
        self.assertTrue(result["edit"]["reverted"])
        self.assertTrue(json.loads((self.root / ".arcforge-history" / "e-2.json").read_text(encoding="utf-8"))["reverted"])
        with self.assertRaisesRegex(p.PresentationError, "already reverted"):
            p.run_patch(Args(spec=str(self.spec), output=str(self.output), revert="e-2"))

    def test_invalid_replacements_are_rejected_and_leave_files_untouched(self):
        before = (self.root / "design" / "p-02.svg").read_bytes()
        cases = (
            ('<text id="other" data-role="title" x="60" y="80">x</text>', "keep id 'title'"),
            ('<text id="title" data-role="subtitle" x="60" y="80">x</text>', "keep data-role 'title'"),
            ('<text id="title" data-role="title" x="60" y="80">x</text><rect id="extra"/>', "exactly one SVG element"),
            ('<g id="title" data-role="title"><text id="kp-1" x="60" y="80">x</text></g>', "duplicate element id"),
            ('<text id="title" data-role="title" x="60" y="80" fill="#ZZZZZZ">x</text>', "hexadecimal"),
        )
        for index, (fragment, message) in enumerate(cases):
            with self.subTest(fragment=fragment), self.assertRaisesRegex(p.PresentationError, message):
                p.run_patch(Args(spec=str(self.spec), output=str(self.output), slide_id="p-02", element_id="title",
                                 edit_id=f"bad-{index}", replacement=self.replacement(fragment)))
            self.assertEqual((self.root / "design" / "p-02.svg").read_bytes(), before)
            self.assertFalse((self.root / ".arcforge-history" / f"bad-{index}.json").exists())
        with self.assertRaisesRegex(p.PresentationError, "not on this page"):
            p.run_patch(Args(spec=str(self.spec), output=str(self.output), slide_id="p-02", element_id="missing",
                             replacement=self.replacement('<text id="missing">x</text>')))
        with self.assertRaisesRegex(p.PresentationError, "not in the manifest"):
            p.run_patch(Args(spec=str(self.spec), output=str(self.output), slide_id="p-99", element_id="title",
                             replacement=self.replacement('<text id="title">x</text>')))
        with self.assertRaisesRegex(p.PresentationError, "exactly one of"):
            p.run_patch(Args(spec=str(self.spec), output=str(self.output), slide_id="p-02"))

    def test_page_patch_replaces_the_whole_svg_and_shared_pages_trip_the_guard(self):
        others = self.other_pages()
        result = p.run_patch(Args(spec=str(self.spec), output=str(self.output), slide_id="p-02", edit_id="e-page",
                                  replacement=self.replacement(page("Whole page", "New body"))))
        self.assertEqual(result["deck"]["changed_slide_ids"], ["p-02"])
        self.assertEqual(result["edit"]["scope"], "unit")
        self.assertEqual(self.other_pages(), others)
        # Two manifest entries pointing at one file cannot be edited in isolation.
        spec = json.loads(self.spec.read_text(encoding="utf-8"))
        spec["slides"].append({"slide_id": "p-02-copy", "svg": "design/p-02.svg"})
        self.spec.write_text(json.dumps(spec), encoding="utf-8")
        p.run_create(Args(spec=str(self.spec), output=str(self.output), force=True))
        before = (self.root / "design" / "p-02.svg").read_bytes()
        with self.assertRaisesRegex(p.PresentationError, "scope_violation.*p-02-copy"):
            p.run_patch(Args(spec=str(self.spec), output=str(self.output), slide_id="p-02", element_id="title", edit_id="e-guard",
                             replacement=self.replacement('<text id="title" data-role="title" x="60" y="80">Guarded</text>')))
        self.assertEqual((self.root / "design" / "p-02.svg").read_bytes(), before)

    def test_fingerprints_separate_page_sources_from_shared_inputs(self):
        spec = json.loads(self.spec.read_text(encoding="utf-8"))
        spec["style"] = {"palette": {"accent": "#FF0000"}}
        self.spec.write_text(json.dumps(spec), encoding="utf-8")
        result = p.run_create(Args(spec=str(self.spec), output=str(self.output), force=True))
        self.assertEqual(result["deck"]["changed_slide_ids"], [])
        self.assertTrue(result["deck"]["shared_inputs_changed"])
        (self.root / "design" / "p-03.svg").write_text(page("Closing v2"), encoding="utf-8")
        result = p.run_create(Args(spec=str(self.spec), output=str(self.output), force=True))
        self.assertEqual(result["deck"]["changed_slide_ids"], ["p-03"])
        self.assertFalse(result["deck"]["shared_inputs_changed"])

    def test_selection_context_describes_element_page_and_deck(self):
        element = p.run_selection_context(Args(spec=str(self.spec), slide_id="p-02", element_id="kp-1"))
        self.assertEqual(element["replacement_kind"], "svg_element")
        self.assertEqual(element["slide"]["index"], 2)
        self.assertEqual(element["element"]["role"], "text_block")
        self.assertEqual(element["element"]["text"], "Body")
        self.assertTrue(element["element"]["snippet"].startswith('<text id="kp-1"'))
        whole = p.run_selection_context(Args(spec=str(self.spec), slide_id="p-02"))
        self.assertEqual(whole["replacement_kind"], "svg_page")
        self.assertIn('id="title"', whole["page"]["snippet"])
        deck = p.run_selection_context(Args(spec=str(self.spec)))
        self.assertEqual(deck["replacement_kind"], "deck")
        self.assertEqual(deck["slide_ids"], ["p-01", "p-02", "p-03"])
        with self.assertRaisesRegex(p.PresentationError, "not on this page"):
            p.run_selection_context(Args(spec=str(self.spec), slide_id="p-02", element_id="nope"))

    def test_element_spans_handle_self_closing_nested_and_escaped_markup(self):
        raw = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><g id="g">'
               '<rect id="r" x="1" data-label="a&gt;b"/><text id="t">hi<tspan id="s">x</tspan></text></g>'
               '<rect id="e" width="2"/></svg>').encode("utf-8")
        spans = p.svg_element_spans(raw)
        self.assertEqual(raw[slice(*spans["r"])], b'<rect id="r" x="1" data-label="a&gt;b"/>')
        self.assertEqual(raw[slice(*spans["t"])], b'<text id="t">hi<tspan id="s">x</tspan></text>')
        self.assertEqual(raw[slice(*spans["s"])], b'<tspan id="s">x</tspan>')
        self.assertEqual(raw[slice(*spans["e"])], b'<rect id="e" width="2"/>')
        self.assertEqual(raw[slice(*spans["g"])][:9], b'<g id="g"')
        self.assertTrue(raw[slice(*spans["g"])].endswith(b"</g>"))

    def edit_title(self, edit_id, text):
        return p.run_patch(Args(spec=str(self.spec), output=str(self.output), slide_id="p-02",
                               element_id="title", edit_id=edit_id,
                               replacement=self.replacement(f'<text id="title" data-role="title" x="60" y="80">{text}</text>')))

    def test_corrections_share_one_undo_and_conflicting_undo_is_refused(self):
        before = (self.root / "design/p-02.svg").read_bytes()
        self.edit_title("turn-1", "Draft")
        corrected = self.edit_title("turn-1", "Polished")
        self.assertIn("not one channel", corrected["edit"]["before_text"])
        self.edit_title("turn-2", "Newer")
        current = self.output.read_bytes()
        with self.assertRaisesRegex(p.PresentationError, "edit_conflict"):
            p.run_patch(Args(spec=str(self.spec), output=str(self.output), revert="turn-1"))
        self.assertEqual(self.output.read_bytes(), current)
        p.run_patch(Args(spec=str(self.spec), output=str(self.output), revert="turn-2"))
        p.run_patch(Args(spec=str(self.spec), output=str(self.output), revert="turn-1"))
        self.assertEqual((self.root / "design/p-02.svg").read_bytes(), before)

    def test_any_publish_failure_restores_source_deck_stamp_and_history(self):
        paths = [self.spec, self.output, self.root / "design/p-02.svg", self.root / p.BUILD_STAMP_NAME]
        for function in ("atomic_save", "write_build_stamp", "write_history"):
            before = {path: path.read_bytes() for path in paths}
            with self.subTest(function=function), patch.object(p, function, side_effect=OSError("disk fault")):
                with self.assertRaisesRegex(OSError, "disk fault"):
                    self.edit_title("failed", "Must be restored")
            self.assertEqual({path: path.read_bytes() for path in paths}, before)
            self.assertFalse((self.root / p.HISTORY_DIR_NAME / "failed.json").exists())
            self.assertFalse((self.root / p.PATCH_JOURNAL_NAME).exists())

    def test_failed_correction_preserves_the_previous_snapshot(self):
        self.edit_title("turn", "Kept")
        history = self.root / p.HISTORY_DIR_NAME / "turn.json"
        before = (history.read_bytes(), self.output.read_bytes(), (self.root / "design/p-02.svg").read_bytes())
        with patch.object(p, "write_history", side_effect=OSError("disk fault")):
            with self.assertRaises(OSError):
                self.edit_title("turn", "Failed correction")
        self.assertEqual((history.read_bytes(), self.output.read_bytes(), (self.root / "design/p-02.svg").read_bytes()), before)

    def test_process_termination_journal_recovers_the_entire_edit(self):
        paths = [self.spec, self.output, self.root / "design/p-02.svg", self.root / p.BUILD_STAMP_NAME]
        before = {path: path.read_bytes() for path in paths}
        replacement = self.replacement('<text id="title" data-role="title">Interrupted</text>')
        code = """import importlib.util, sys, os, argparse
spec = importlib.util.spec_from_file_location('interrupted_presentation', sys.argv[1])
p = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = p
spec.loader.exec_module(p)
save = p.atomic_save
def stop_after_save(*args):
    save(*args)
    os._exit(73)
p.atomic_save = stop_after_save
p.run_patch(argparse.Namespace(spec=sys.argv[2], output=sys.argv[3], replacement=sys.argv[4], slide_id='p-02', element_id='title', edit_id='killed', template=None, asset_cache=None))
"""
        result = subprocess.run([sys.executable, "-B", "-c", code, str(SCRIPT), str(self.spec), str(self.output), replacement], capture_output=True)
        self.assertEqual(result.returncode, 73, result.stderr.decode(errors="replace"))
        self.assertNotEqual(self.output.read_bytes(), before[self.output])
        p.run_recover_patch(Args(spec=str(self.spec), output=str(self.output)))
        self.assertEqual({path: path.read_bytes() for path in paths}, before)
        self.assertFalse((self.root / p.HISTORY_DIR_NAME / "killed.json").exists())

    def test_recovery_rejects_a_record_outside_the_workspace_before_writing(self):
        with tempfile.TemporaryDirectory() as external:
            target = Path(external) / "unrelated.txt"
            target.write_text("original", encoding="utf-8")
            directory = self.root / p.PATCH_JOURNAL_NAME
            directory.mkdir()
            (directory / "0.backup").write_text("overwrite", encoding="utf-8")
            (directory / "transaction.json").write_text(json.dumps({"spec": str(self.spec), "output": str(self.output),
                "files": [{"path": str(target), "backup": "0.backup", "existed": True}]}), encoding="utf-8")
            with self.assertRaisesRegex(p.PresentationError, "escapes the workspace"):
                p.run_recover_patch(Args(spec=str(self.spec), output=str(self.output), workspace=str(self.root)))
            self.assertEqual(target.read_text(encoding="utf-8"), "original")


class TemplatePatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        deck = p.Presentation()
        slide = deck.slides.add_slide(deck.slide_layouts[6])
        text = slide.shapes.add_textbox(p.Inches(1), p.Inches(1), p.Inches(5), p.Inches(1))
        text.text = "Original title"
        text.name = "headline"
        self.title_id = text.shape_id
        table = slide.shapes.add_table(2, 2, p.Inches(1), p.Inches(3), p.Inches(5), p.Inches(1))
        self.table_id = table.shape_id
        table.name = "Table 7"
        deck.save(self.root / "template.pptx")
        self.spec = self.root / "deck.json"
        self.spec.write_text(json.dumps({
            "schema_version": 3, "mode": "template", "template": "template.pptx",
            "slides": [{"slide_id": "cover", "source_slide": 1, "text_edits": [{"shape_id": self.title_id, "text": "Quarterly"}]}],
        }, indent=2), encoding="utf-8")
        self.output = self.root / "deck.pptx"
        p.run_create(Args(spec=str(self.spec), output=str(self.output)))

    def test_template_text_and_table_patches_only_touch_their_manifest_entries(self):
        replacement = self.root / "r.json"
        replacement.write_text(json.dumps({"text": "Annual"}), encoding="utf-8")
        result = p.run_patch(Args(spec=str(self.spec), output=str(self.output), slide_id="cover", element_id="headline",
                                  edit_id="t-1", replacement=str(replacement)))
        self.assertEqual(result["edit"]["kind"], "template_text")
        self.assertEqual(result["edit"]["before_text"], "Quarterly")
        self.assertEqual(result["edit"]["after_text"], "Annual")
        spec = json.loads(self.spec.read_text(encoding="utf-8"))
        self.assertEqual(spec["slides"][0]["text_edits"], [{"shape_id": self.title_id, "text": "Annual"}])
        self.assertEqual(p.Presentation(self.output).slides[0].shapes[0].text, "Annual")
        replacement.write_text(json.dumps({"rows": [["A", "B"], ["1", "2"]]}), encoding="utf-8")
        result = p.run_patch(Args(spec=str(self.spec), output=str(self.output), slide_id="cover",
                                  element_id="Table 7", edit_id="t-2", replacement=str(replacement)))
        self.assertEqual(result["edit"]["kind"], "template_table")
        spec = json.loads(self.spec.read_text(encoding="utf-8"))
        self.assertEqual(spec["slides"][0]["text_edits"], [{"shape_id": self.title_id, "text": "Annual"}])
        self.assertEqual(spec["slides"][0]["table_edits"][0]["rows"], [["A", "B"], ["1", "2"]])
        p.run_patch(Args(spec=str(self.spec), output=str(self.output), revert="t-1"))
        spec = json.loads(self.spec.read_text(encoding="utf-8"))
        self.assertEqual(spec["slides"][0]["text_edits"], [{"shape_id": self.title_id, "text": "Quarterly"}])
        self.assertEqual(spec["slides"][0]["table_edits"][0]["rows"], [["A", "B"], ["1", "2"]])
        replacement.write_text(json.dumps({"rows": [["only"]]}), encoding="utf-8")
        with self.assertRaisesRegex(p.PresentationError, "dimensions"):
            p.run_patch(Args(spec=str(self.spec), output=str(self.output), slide_id="cover",
                             element_id=f"shape-{self.table_id}", edit_id="t-3", replacement=str(replacement)))
        context = p.run_selection_context(Args(spec=str(self.spec), slide_id="cover", element_id="headline"))
        self.assertEqual(context["replacement_kind"], "template_text")
        self.assertEqual(context["element"]["template_value"], "Original title")
        self.assertEqual(context["element"]["current_edit"]["text"], "Quarterly")

    def test_template_snapshot_supports_context_patch_and_undo_after_source_cleanup(self):
        # Real-world manifest: source_slide with its template supplied only via inputPath.
        spec = json.loads(self.spec.read_text(encoding="utf-8"))
        spec.pop("mode")
        spec.pop("template")
        self.spec.write_text(json.dumps(spec), encoding="utf-8")
        template = self.root / "template.pptx"
        p.run_create(Args(spec=str(self.spec), output=str(self.output), template=str(template), force=True))
        stamp = json.loads((self.root / p.BUILD_STAMP_NAME).read_text(encoding="utf-8"))
        snapshot = Path(stamp["template_snapshot"])
        self.assertEqual(snapshot.read_bytes(), template.read_bytes())
        self.assertEqual(snapshot.parent.resolve(), (self.root / ".arcforge-sources").resolve())
        template.unlink()
        context = p.run_selection_context(Args(spec=str(self.spec), slide_id="cover", template=str(snapshot), workspace=str(self.root)))
        self.assertEqual(context["replacement_kind"], "template_page")
        self.assertEqual(context["mode"], "template")
        replacement = self.root / "r.json"
        replacement.write_text(json.dumps({"text": "Edited after cleanup"}), encoding="utf-8")
        result = p.run_patch(Args(spec=str(self.spec), output=str(self.output), template=str(snapshot),
                                  slide_id="cover", element_id="headline", edit_id="saved-template", replacement=str(replacement)))
        self.assertEqual(result["deck"]["changed_slide_ids"], ["cover"])
        self.assertFalse(result["deck"]["shared_inputs_changed"])
        self.assertEqual(p.Presentation(self.output).slides[0].shapes[0].text, "Edited after cleanup")
        p.run_patch(Args(spec=str(self.spec), output=str(self.output), template=str(snapshot), revert="saved-template"))
        self.assertEqual(p.Presentation(self.output).slides[0].shapes[0].text, "Quarterly")
        self.assertEqual(len(list(snapshot.parent.glob("*.pptx"))), 1)

    def test_missing_template_mode_is_not_reported_as_an_invalid_page_number(self):
        spec = json.loads(self.spec.read_text(encoding="utf-8"))
        spec.pop("mode")
        spec.pop("template")
        with self.assertRaisesRegex(p.PresentationError, "source_slide requires template mode"):
            p.load_deck_manifest(spec, self.root)


if __name__ == "__main__":
    unittest.main()
