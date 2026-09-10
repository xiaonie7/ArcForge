"""Executable round-trip checks for the SVG → PPTX review metadata contract."""

import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / "src-tauri/prompt/skills/arcforge-slides/scripts/presentation.py"
SPEC = importlib.util.spec_from_file_location("arcforge_presentation", SCRIPT)
presentation = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = presentation
SPEC.loader.exec_module(presentation)


class SemanticBlocksTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)

    def create(self, body, assets=None):
        (self.directory / "slide.svg").write_text(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">' + body + '</svg>',
            encoding="utf-8",
        )
        return presentation.create_svg_deck({
            "schema_version": 3,
            "mode": "blank",
            "stage": "design",
            "assets": assets or {},
            "slides": [{"slide_id": "slide_5", "svg": "slide.svg"}],
        }, self.directory)[0]

    def test_all_roles_survive_roundtrip_and_semantic_group_is_atomic(self):
        presentation.Image.new("RGB", (40, 20), "white").save(self.directory / "hero.png")
        body = ''.join(
            f'<text id="{role}" data-role="{role}" x="60" y="{80 + index * 70}" font-size="24">{role}</text>'
            for index, role in enumerate(("title", "subtitle", "text_block", "footer"))
        )
        body += '<image id="hero" data-role="image" data-asset="hero" x="800" y="60" width="200" height="100"/>'
        body += '''<rect id="sales" data-role="chart" data-arcforge="chart" x="60" y="400" width="400" height="200" data-chart='{"type":"column","categories":["A"],"series":[{"name":"Sales","values":[10]}]}'/>'''
        body += '<g id="metrics" data-role="table"><rect id="card" x="600" y="400" width="500" height="100" fill="#eeeeee"/><text id="row" x="620" y="450" font-size="24">Revenue 10</text></g>'
        deck = self.create(body, {"hero": "hero.png"})
        deck.save(self.directory / "deck.pptx")
        restored = presentation.Presentation(self.directory / "deck.pptx")
        shapes = list(restored.slides[0].shapes)
        self.assertEqual(len(shapes), 7)
        roles = set()
        for shape in shapes:
            properties = shape._element.xpath("./*/p:cNvPr")[0]
            roles.add(properties.get("descr").removeprefix("arcforge:role="))
        self.assertEqual(roles, set(presentation.SvgSlideConverter.SEMANTIC_ROLES))
        group = next(shape for shape in shapes if shape.name == "metrics")
        self.assertEqual([shape.name for shape in group.shapes], ["card", "row"])
        # The default 13.333 in slide is 12191695 EMU wide, so canvas px scale by 0.99997.
        self.assertAlmostEqual(group.left, 600 * presentation.EMU_PER_PX, delta=presentation.EMU_PER_PX)
        self.assertGreater(group.width, 0)
        self.assertEqual(restored.slides[0].name, "slide_5")

    def test_id_validation_covers_containers_and_non_walked_nodes(self):
        for body in (
            '<g id="same"><text id="same" x="10" y="20">x</text></g>',
            '<text id="same" x="10" y="20"><tspan id="same">x</tspan></text>',
            '<defs><linearGradient id="same"><stop offset="0"/><stop offset="1"/></linearGradient></defs><rect id="same" width="20" height="20"/>',
        ):
            with self.subTest(body=body), self.assertRaisesRegex(presentation.PresentationError, "duplicate element id"):
                self.create(body)

    def test_invalid_roles_cannot_silently_disappear(self):
        cases = (
            ('<g data-role="table"><text x="10" y="20">x</text></g>', 'must also have an id'),
            ('<g id="g" data-role="unknown"/>', 'data-role must be one of'),
            ('<text id="t" data-role="" x="10" y="20"/>', 'data-role must be one of'),
            ('<g id="g" data-role="table"/>', 'has no rendered elements'),
            ('<text id="t" x="10" y="20"><tspan id="s" data-role="title">x</tspan></text>', 'rendered element or group'),
            ('<rect id="bg" data-role="image" data-arcforge="background" width="1280" height="720"/>', 'background cannot'),
        )
        for body, message in cases:
            with self.subTest(body=body), self.assertRaisesRegex(presentation.PresentationError, message):
                self.create(body)

    def test_ids_survive_rebuild_and_unmarked_groups_stay_flat(self):
        template = '<g id="layout"><text id="title" data-role="title" x="10" y="40">{}</text></g>'
        before = self.create(template.format("Before"))
        after = self.create(template.format("After"))
        self.assertEqual([shape.name for shape in before.slides[0].shapes], ["title"])
        self.assertEqual([shape.name for shape in after.slides[0].shapes], ["title"])


if __name__ == "__main__":
    unittest.main()
