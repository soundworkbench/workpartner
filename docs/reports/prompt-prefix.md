# Generated prompt source inventory

Baseline: `a342f86` (before this change). Inputs: OfficeCLI **1.0.160** plus the two official skill archives pinned in `image/third-party.lock.json`; their downloaded SHA-256 values were verified before execution/unpacking. No engine version or skill selection changes.

The primary profile installs `officecli`, `pptx`, `word`, `excel` and the official Feishu skills. The extended profile also installs every other Office skill available in this pinned release. Both use the public instruction template and translations, with the capability catalog generated **before** measurement. Organization overrides and personal skills/instructions are outside these results.

## Accounting

Characters are Unicode code points in the parsed YAML description or the complete generated instruction file, including whitespace. Estimated tokens are `ceil(non-ASCII characters + ASCII characters / 4)` for each source, then summed. These are deterministic source estimates, not model tokenizer counts or serialized request sizes. One generation per profile/side; repeated compaction and catalog generation produced byte-identical output.

Only skill descriptions and the one shared instruction file enter the reduction denominator. Skill names/paths/other metadata are unchanged; engine framing, built-in system prompts and native tool schemas are excluded. The bundled engine configurations contain no additional MCP server/tool definitions. OfficeCLI command schemas are CLI help/on-demand skill text, not separately injected tool definitions. No `AGENTS.md` or `CLAUDE.md` exists under the generated skills directory. Other skill bodies, references, assets, licenses and the Feishu grouping manifest are inventoried as on-demand/support files, not counted as eager text. `CLAUDE.md` and its `AGENTS.md` alias represent the same shared source, not two independent source files.

## Results

| Profile | Skills before → after | Characters before | Characters after | Reduction | Estimated tokens before | Estimated tokens after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Primary Office + official skills | 34 → 34 | 8,506 | 3,882 | 54.36% | 4,876 | 2,126 |
| All available Office + official skills | 41 → 41 | 17,804 | 5,466 | 69.3% | 7,300 | 2,531 |

Every generated skill description follows. A † marks an optional Office skill outside the primary profile; unchanged aliases retain their explicit-only trigger. Original descriptions for changed skills are preserved verbatim in their bodies, along with every original body and reference.

| Skill | Characters before | Characters after | Estimated tokens before | Estimated tokens after |
| --- | ---: | ---: | ---: | ---: |
| feishu | 45 | 45 | 45 | 45 |
| lark-approval | 128 | 63 | 119 | 54 |
| lark-apps | 619 | 252 | 427 | 141 |
| lark-attendance | 18 | 18 | 18 | 18 |
| lark-base | 241 | 160 | 142 | 81 |
| lark-calendar | 136 | 62 | 116 | 44 |
| lark-contact | 194 | 85 | 136 | 67 |
| lark-doc | 241 | 117 | 160 | 57 |
| lark-drive | 419 | 140 | 248 | 85 |
| lark-event | 561 | 223 | 141 | 56 |
| lark-im | 224 | 77 | 191 | 56 |
| lark-mail | 209 | 55 | 106 | 50 |
| lark-markdown | 164 | 71 | 123 | 50 |
| lark-meeting | 209 | 150 | 140 | 87 |
| lark-minutes | 58 | 58 | 37 | 37 |
| lark-note | 55 | 55 | 37 | 37 |
| lark-okr | 137 | 52 | 110 | 46 |
| lark-openapi-explorer | 123 | 57 | 77 | 33 |
| lark-shared | 214 | 150 | 54 | 38 |
| lark-sheets | 464 | 148 | 351 | 90 |
| lark-skill-maker | 73 | 41 | 49 | 30 |
| lark-slides | 265 | 94 | 195 | 49 |
| lark-task | 178 | 50 | 178 | 46 |
| lark-vc | 53 | 53 | 36 | 36 |
| lark-vc-agent | 59 | 59 | 38 | 38 |
| lark-whiteboard | 153 | 45 | 120 | 40 |
| lark-wiki | 303 | 103 | 222 | 65 |
| lark-workflow-meeting-summary | 68 | 34 | 68 | 34 |
| lark-workflow-standup-report | 83 | 35 | 54 | 34 |
| meegle | 351 | 70 | 150 | 52 |
| morph-ppt † | 715 | 201 | 182 | 51 |
| morph-ppt-3d † | 139 | 105 | 36 | 27 |
| officecli | 222 | 128 | 56 | 32 |
| officecli-academic-paper † | 576 | 211 | 144 | 53 |
| officecli-data-dashboard † | 665 | 234 | 168 | 59 |
| officecli-docx | 477 | 190 | 120 | 48 |
| officecli-financial-model † | 832 | 245 | 211 | 62 |
| officecli-pitch-deck † | 628 | 206 | 160 | 52 |
| officecli-pptx | 467 | 163 | 117 | 41 |
| officecli-word-form † | 898 | 242 | 226 | 61 |
| officecli-xlsx | 521 | 190 | 131 | 48 |
| Generated instructions (primary) | 774 | 589 | 564 | 361 |
| Generated instructions (extended) | 5619 | 729 | 1861 | 401 |

The capability catalog now supplies translated display names only; the engines already receive the skill descriptions. It still instructs the assistant to answer capability questions from the available skill list and to distinguish skills from permissions. The seven behavioral rules remain in the instruction template. The YAML rewrite preserves names, versions, prerequisites and all other metadata; new upstream/custom skills without a matching replacement keep their original description.

## Reproduce

Use a review environment with Python 3 + PyYAML and Node.js + the existing system `js-yaml` dependency (`/usr/share/nodejs/js-yaml`, as in the user image). Do not use an existing personal skills directory. Obtain the three relevant inputs from the lock file, verify their SHA-256 digests, then:

```sh
# PKG contains the verified officecli and both pinned official archives.
# REVIEW is a fresh temporary directory; run from this checkout.
mkdir -p "$REVIEW/before/.claude/skills"
for skill in officecli pptx word excel; do
  if [ "$skill" = officecli ]; then
    HOME="$REVIEW/before" "$PKG/officecli" skills claude
  else
    HOME="$REVIEW/before" "$PKG/officecli" skills install "$skill" claude
  fi
done
# For the extended profile, also install:
# academic-paper data-dashboard financial-model morph-ppt morph-ppt-3d pitch-deck word-form
python3 image/bin/wp-feishu-skills.py --pack "$PKG/lark-skills.tar.gz" \
  "$PKG/meegle-skills.tar.gz" "$REVIEW/official-skills.tar.gz"
python3 image/bin/wp-feishu-skills.py "$REVIEW/official-skills.tar.gz" "$REVIEW/before/.claude/skills"
git show a342f86:image/home/CLAUDE.md > "$REVIEW/before/CLAUDE.md"
git show a342f86:image/bin/wp-skill-catalog.mjs > "$REVIEW/baseline-catalog.mjs"
node "$REVIEW/baseline-catalog.mjs" "$REVIEW/before/.claude/skills" \
  image/skills-zh.json "$REVIEW/before/CLAUDE.md"
cp -a "$REVIEW/before" "$REVIEW/after"
python3 image/bin/wp-compact-skills.py "$REVIEW/after/.claude/skills" image/skill-descriptions.json
cp image/home/CLAUDE.md "$REVIEW/after/CLAUDE.md"
node image/bin/wp-skill-catalog.mjs "$REVIEW/after/.claude/skills" \
  image/skills-zh.json "$REVIEW/after/CLAUDE.md"
python3 tools/prompt-inventory.py --skills "$REVIEW/before/.claude/skills" \
  --instructions "$REVIEW/before/CLAUDE.md" > "$REVIEW/before.json"
python3 tools/prompt-inventory.py --skills "$REVIEW/after/.claude/skills" \
  --instructions "$REVIEW/after/CLAUDE.md" --baseline "$REVIEW/before.json" > "$REVIEW/after.json"
python3 tools/prompt-inventory.test.py
```

## Validation and remaining acceptance

- Generated all 41 skills from the verified pinned inputs; parsed every before/after frontmatter successfully.
- Compared every generated file: skill paths, names, non-description metadata, original bodies and support files retained. Changed descriptions remain verbatim on demand. The second compaction changed zero files; the second catalog generation was byte-identical.
- Focused tests cover folded YAML accounting, token estimates, missing/renamed skills, malformed descriptions, metadata/body/reference retention, unknown upstream skills, catalog display names and repeatability.
- Python and JavaScript syntax checks and `git diff --check` pass.
- Full image build and deployment verification remain with maintainers; this worker does not build images or run the full test suite. This report does not claim either passed.
- On deployment, verify both engines can select Office and Feishu skills for representative requests, capability answers retain translated names, and personalized instructions survive synchronization. Maintainers measure first-token latency on the running deployment using the baseline method; no latency improvement is claimed here.
