#!/usr/bin/env python3
"""Inventory bundled prompt sources, not an engine's serialized model request.

Requires PyYAML on the review machine. No engine, network, or user data is used.
Descriptions and instructions are eager text; skill bodies are on-demand text.
Token estimates use ceil(non-ASCII characters + ASCII characters / 4), not a
model tokenizer. Engine framing, built-in prompts/tools and user skills are
outside this source inventory and must be measured from engine requests.
"""

import argparse
import json
import math
from pathlib import Path

import yaml


def counts(text):
    """Count Unicode code points and provide an explicitly approximate token count."""
    ascii_chars = sum(ord(char) < 128 for char in text)
    return {
        "characters": len(text),
        "estimated_tokens": math.ceil(len(text) - ascii_chars + ascii_chars / 4),
    }


def inventory(skills, instructions):
    """Read every SKILL.md and list other files without counting them as eager text."""
    if not skills.is_dir():
        raise ValueError(f"Missing skill directory: {skills}")
    skill_files = sorted(skills.rglob("SKILL.md"))
    if not skill_files:
        raise ValueError(f"No SKILL.md files in {skills}")
    rows = []
    names = set()
    for path in skill_files:
        text = path.read_text(encoding="utf-8")
        lines = text.splitlines(keepends=True)
        if not lines or lines[0].strip() != "---":
            raise ValueError(f"Missing frontmatter: {path}")
        end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
        if end is None:
            raise ValueError(f"Unclosed frontmatter: {path}")
        meta = yaml.safe_load("".join(lines[1:end]))
        if not isinstance(meta, dict):
            raise ValueError(f"Frontmatter must be a mapping: {path}")
        for key in ("name", "description"):
            if not isinstance(meta.get(key), str) or not meta[key].strip():
                raise ValueError(f"Missing text {key}: {path}")
        if meta["name"] in names:
            raise ValueError(f"Duplicate skill name: {meta['name']}")
        names.add(meta["name"])
        rows.append({
            "file": path.relative_to(skills).as_posix(),
            "name": meta["name"],
            "description": meta["description"],
            "eager": counts(meta["description"]),
            "on_demand_body": counts("".join(lines[end + 1:])),
            "whole_file": counts(text),
        })
    instruction_text = instructions.read_text(encoding="utf-8")
    eager = [row["eager"] for row in rows] + [counts(instruction_text)]
    return {
        "scope": "Bundled skill descriptions + one shared instruction file; excludes engine framing/tools and user skills",
        "token_estimate": "ceil(non_ASCII_characters + ASCII_characters / 4), per source; not tokenizer output",
        "skills": rows,
        "instructions": {"file": instructions.name, **counts(instruction_text)},
        "support_files": [
            {"file": path.relative_to(skills).as_posix(), "bytes": path.stat().st_size}
            for path in sorted(skills.rglob("*")) if path.is_file() and path not in skill_files
        ],
        "eager_total": {key: sum(item[key] for item in eager) for key in eager[0]},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skills", required=True, type=Path)
    parser.add_argument("--instructions", required=True, type=Path)
    parser.add_argument("--baseline", type=Path, help="Earlier JSON inventory of the same sources")
    args = parser.parse_args()
    result = inventory(args.skills, args.instructions)
    if args.baseline:
        before = json.loads(args.baseline.read_text(encoding="utf-8"))
        if [(r["file"], r["name"]) for r in before["skills"]] != [(r["file"], r["name"]) for r in result["skills"]]:
            raise ValueError("Skill inventory changed; comparison would hide removed or renamed skills")
        old, new = before["eager_total"]["characters"], result["eager_total"]["characters"]
        result["comparison"] = {
            "before_characters": old, "after_characters": new,
            "reduction_percent": round(100 * (old - new) / old, 2),
        }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
