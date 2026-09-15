"""Regression checks for complete, ordered PNG page selections and contact sheets."""
import argparse
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / "src-tauri/prompt/skills/arcforge-slides/scripts/presentation.py"
SPEC = importlib.util.spec_from_file_location("png_presentation", SCRIPT)
p = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = p
SPEC.loader.exec_module(p)


class PngPreviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_page_ranges_preserve_requested_order_and_reject_ambiguous_selections(self):
        self.assertEqual(p.parse_preview_pages("3,1-2,5", 6), [3, 1, 2, 5])
        for value in ("", "0", "1,1", "1-3,2", "4-2", "7", "1;2", "-1", "1-999999999"):
            with self.subTest(value=value), self.assertRaises(p.PresentationError):
                p.parse_preview_pages(value, 6)
        with self.assertRaisesRegex(p.PresentationError, "at most"):
            p.parse_preview_pages("1-51", 100)

    def test_contact_sheet_contains_all_pages_in_order_and_preserves_aspect(self):
        colors = ["red", "green", "blue", "yellow", "cyan", "magenta"]
        paths = []
        for index, color in enumerate(colors):
            path = self.root / f"{index}.png"
            p.Image.new("RGB", (160, 90), color).save(path)
            paths.append(path)
        grid = p.compose_preview_pages(paths, True)
        self.addCleanup(grid.close)
        self.assertEqual(grid.size, (504, 192))
        for index, color in enumerate(colors):
            self.assertEqual(grid.getpixel(((index % 3) * 172 + 80, (index // 3) * 102 + 45)),
                             p.Image.new("RGB", (1, 1), color).getpixel((0, 0)))
        vertical = p.compose_preview_pages(paths[:3], False)
        self.addCleanup(vertical.close)
        self.assertEqual(vertical.size, (160, 294))
        self.assertEqual(vertical.getpixel((80, 249)), (0, 0, 255))
        # A portrait image is letterboxed, not stretched to fill a landscape cell.
        portrait = self.root / "portrait.png"
        p.Image.new("RGB", (40, 90), "black").save(portrait)
        mixed = p.compose_preview_pages([paths[0], portrait], True)
        self.addCleanup(mixed.close)
        self.assertEqual(mixed.getpixel((173, 45)), (226, 232, 240))
        self.assertEqual(mixed.getpixel((252, 45)), (0, 0, 0))

    def test_pixel_budget_is_applied_before_allocating_the_contact_sheet(self):
        path = self.root / "page.png"
        p.Image.new("RGB", (160, 90), "blue").save(path)
        with patch.object(p, "PNG_PREVIEW_MAX_PIXELS", 10_000), patch.object(p, "PNG_PREVIEW_MAX_EDGE", 200):
            contact = p.compose_preview_pages([path] * 6, False)
        self.addCleanup(contact.close)
        self.assertLessEqual(contact.width * contact.height, 10_000)
        self.assertLessEqual(max(contact.size), 200)

    def test_render_invokes_each_selected_page_and_does_not_publish_partial_output(self):
        deck = p.Presentation()
        for _ in range(3):
            deck.slides.add_slide(deck.slide_layouts[6])
        source = self.root / "deck.pptx"
        deck.save(source)
        original = source.read_bytes()
        output = self.root / "out.png"
        officecli = self.root / "officecli.exe"
        officecli.write_bytes(b"test renderer")
        args = argparse.Namespace(input=str(source), output=str(output), officecli=str(officecli),
                                  pages="3,1-2", grid=True, force=False)
        called = []

        def screenshot(command, **options):
            page = int(command[command.index("--page") + 1])
            called.append(page)
            self.assertNotIn("--grid", command)
            self.assertEqual(options["env"]["OFFICECLI_NO_AUTO_INSTALL"], "1")
            p.Image.new("RGB", (160, 90), {1: "red", 2: "green", 3: "blue"}[page]).save(command[command.index("-o") + 1])
            return argparse.Namespace(returncode=0)

        with patch.object(p.subprocess, "run", side_effect=screenshot):
            result = p.run_render_png(args)
        self.assertEqual(called, [3, 1, 2])
        self.assertEqual(result["page_count"], 3)
        self.assertEqual(source.read_bytes(), original)
        with p.Image.open(output) as contact:
            self.assertEqual(contact.getpixel((80, 45)), (0, 0, 255))
            self.assertEqual(contact.getpixel((252, 45)), (255, 0, 0))
            self.assertEqual(contact.getpixel((80, 147)), (0, 128, 0))
        previous = output.read_bytes()
        args.force = True
        with patch.object(p.subprocess, "run", side_effect=p.subprocess.TimeoutExpired("officecli", 60)):
            with self.assertRaisesRegex(p.PresentationError, "page 3"):
                p.run_render_png(args)
        self.assertEqual(output.read_bytes(), previous, "a failed page must preserve the existing complete preview")


if __name__ == "__main__":
    unittest.main()
