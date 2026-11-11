"""Verify eager/on-demand accounting and reject misleading comparisons."""

import json
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import yaml


SCRIPT = Path(__file__).with_name("prompt-inventory.py")


class InventoryTest(unittest.TestCase):
    def test_source_accounting_and_baseline(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            skill = root / "skills" / "office"
            skill.mkdir(parents=True)
            source = skill / "SKILL.md"
            source.write_text('---\nname: office\ndescription: >-\n  abcd\n  中文\n---\n' + "body" * 1000, encoding="utf-8")
            (skill / "reference.md").write_text("reference", encoding="utf-8")
            instructions = root / "CLAUDE.md"
            instructions.write_text("中文abcd", encoding="utf-8")
            command = [sys.executable, str(SCRIPT), "--skills", str(root / "skills"), "--instructions", str(instructions)]
            first = subprocess.run(command, capture_output=True, text=True, check=True)
            before = json.loads(first.stdout)
            self.assertEqual(before["skills"][0]["description"], "abcd 中文")
            self.assertEqual(before["eager_total"], {"characters": 13, "estimated_tokens": 7})
            self.assertEqual(before["skills"][0]["on_demand_body"]["characters"], 4000)
            self.assertEqual(before["support_files"], [{"file": "office/reference.md", "bytes": 9}])
            baseline = root / "baseline.json"
            baseline.write_text(first.stdout, encoding="utf-8")
            source.write_text('---\nname: office\ndescription: 中文\n---\nbody', encoding="utf-8")
            second = subprocess.run(command + ["--baseline", str(baseline)], capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(second.stdout)["comparison"], {
                "before_characters": 13, "after_characters": 8, "reduction_percent": 38.46,
            })
            source.write_text('---\nname: renamed\ndescription: 中文\n---\nbody', encoding="utf-8")
            renamed = subprocess.run(command + ["--baseline", str(baseline)], capture_output=True, text=True)
            self.assertNotEqual(renamed.returncode, 0)
            self.assertIn("Skill inventory changed", renamed.stderr)
            source.unlink()
            removed = subprocess.run(command + ["--baseline", str(baseline)], capture_output=True, text=True)
            self.assertNotEqual(removed.returncode, 0)
            source.write_text('---\nname: office\ndescription: [not, text]\n---\nbody', encoding="utf-8")
            malformed = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(malformed.returncode, 0)
            self.assertIn("Missing text description", malformed.stderr)


class CompactionTest(unittest.TestCase):
    def test_preserves_scope_metadata_body_references_and_unknown_skills(self):
        spec = importlib.util.spec_from_file_location(
            'compact', SCRIPT.parents[1] / 'image/bin/wp-compact-skills.py')
        compact = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(compact)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            skill = root / 'skills/office'
            skill.mkdir(parents=True)
            original = 'Use for reports, letters, Word documents and any .docx input or output.'
            body = '\r\n# Office\r\n\r\nRead [reference](reference.md) before editing.\r\n'
            source = skill / 'SKILL.md'
            source.write_bytes(('---\r\nname: office\r\ndescription: >-\r\n  ' + original
                                + '\r\nmetadata:\r\n  requires:\r\n    bins: [officecli]\r\n---\r\n' + body).encode())
            reference = skill / 'reference.md'
            reference.write_bytes(b'Original reference\r\n')
            unknown = root / 'skills/unknown'
            unknown.mkdir()
            unknown_source = b'---\nname: unknown\ndescription: New upstream skill\n---\nBody\n'
            (unknown / 'SKILL.md').write_bytes(unknown_source)
            mapping = root / 'descriptions.json'
            mapping.write_text(json.dumps({'office': 'Use for Word/.docx input or output.'}))
            compact.compact(root / 'skills', mapping)
            result = source.read_bytes()
            metadata = yaml.safe_load(result.decode().split('---', 2)[1])
            self.assertEqual(metadata['name'], 'office')
            self.assertEqual(metadata['metadata'], {'requires': {'bins': ['officecli']}})
            self.assertIn(original.encode(), result.split(b'---', 2)[2])
            self.assertTrue(result.endswith(body.encode()))
            self.assertEqual(reference.read_bytes(), b'Original reference\r\n')
            self.assertEqual((unknown / 'SKILL.md').read_bytes(), unknown_source)
            compact.compact(root / 'skills', mapping)
            self.assertEqual(source.read_bytes(), result)

    def test_catalog_uses_display_names_without_repeating_descriptions(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            skill = root / 'skills/office'
            skill.mkdir(parents=True)
            (skill / 'SKILL.md').write_text('---\nname: office\ndescription: UNIQUE_TRIGGER\n---\nbody')
            template = root / 'CLAUDE.md'
            template.write_text('Personal preface\n<!-- workpartner:company-instructions:begin -->\n'
                                '<!-- workpartner:skills:begin -->\n<!-- workpartner:skills:end -->\n'
                                '<!-- workpartner:company-instructions:end -->\nPersonal suffix\n')
            translations = root / 'translations.json'
            translations.write_text(json.dumps({'office': {'name': '办公文件',
                                                          'description': 'DUPLICATE_DESCRIPTION',
                                                          'example': 'DUPLICATE_EXAMPLE'}}))
            command = ['node', str(SCRIPT.parents[1] / 'image/bin/wp-skill-catalog.mjs'),
                       str(root / 'skills'), str(translations), str(template)]
            subprocess.run(command, check=True, capture_output=True)
            result = template.read_bytes()
            self.assertIn('办公文件（office）'.encode(), result)
            for duplicate in (b'UNIQUE_TRIGGER', b'DUPLICATE_DESCRIPTION', b'DUPLICATE_EXAMPLE'):
                self.assertNotIn(duplicate, result)
            self.assertTrue(result.startswith(b'Personal preface\n'))
            self.assertTrue(result.endswith(b'Personal suffix\n'))
            subprocess.run(command, check=True, capture_output=True)
            self.assertEqual(template.read_bytes(), result)


if __name__ == "__main__":
    unittest.main()
