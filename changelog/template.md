---
# FORMAT REFERENCE — do not edit. Copy this file to
# `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.8.x/0.8.6.md`)
# to author a new release. Set that file's H1 to `# <version> — YYYY-MM-DD`
# with a concrete date.

# Required. One-line GitHub Release-style headline. 350 character cap.
# Default short and scannable. Don't pad, don't stitch unrelated changes with
# semicolons — pick the headline. Quotes required: unquoted YAML treats `: `
# inside the value as a key separator and fails GitHub's strict parser.
summary: ""

# Set `true` when consumers must change code to upgrade: API removals,
# signature changes, config renames, behavior changes that break existing
# usage. Flagged as `Breaking` in the rollup.
breaking: false

# Set `true` ONLY for a security fix in THIS project's own source code — a
# vulnerability or hardening in code you ship. A dependency or transitive CVE
# bump is routine maintenance, NOT a security release: record it under
# `## Dependencies` (with the advisory ID) and leave this `false`. When true,
# pairs with the `## Security` section below and flags `Security` in the rollup.
security: false

# Optional free-form notes for maintenance agents processing this release.
# Not rendered in CHANGELOG — consumed by agents running `maintenance` on
# downstream servers. Use for adoption instructions that don't fit the
# human-facing sections: new files to create, fields to populate, one-time
# migration steps. Omit the field entirely when there's nothing to say.
# agent-notes: |
#   <instructions for downstream maintenance agents>
---

# <version> — YYYY-MM-DD

<!--
  AUTHORING GUIDE — applies to the new per-version file you create from this
  template.

  Audience: someone scanning release notes to decide what affects them. Lead
  each bullet with the symbol or concept name in **bold** so they can skip
  what's irrelevant and zoom in on what's not.

  Tone: terse, fact-dense, not verbose. Default to one sentence per bullet —
  name the symbol, state what changed, stop. Use a second sentence only when
  it carries weight. If a bullet feels long, it is.

  Cut: mechanism walkthroughs (those belong in JSDoc, CLAUDE.md/AGENTS.md, or the
  relevant skill), ceremonial framings ("This release introduces…",
  backwards-compat paragraphs), file-by-file test enumerations, internal
  implementation notes. Prefer code/symbol names over English re-explanations.

  Narrative intro: skip by default. Add one short sentence only when the
  release theme genuinely needs framing the bullets can't carry.

  Sections: Keep a Changelog order — Added, Changed, Deprecated, Removed,
  Fixed, Security. Include only sections with entries; delete the rest
  (including the commented-out scaffolding below). Don't ship empty headers.

  Include: every distinct fact a reader needs to adopt or audit the release —
  new exports, signatures, lint rule IDs, env vars, breaking changes, version
  bumps on shipped skills. Nothing more.

  Links: link issues, PRs, docs, or skills where they help a reader jump to
  context. Once per item per entry — don't re-link the same issue in summary,
  narrative, and bullet. Skip links for inline symbol names; code spans speak
  for themselves.

  Issue/PR URLs: use full URLs. GitHub's bare `#NN` auto-link only resolves
  inside its own UI, not in npm reads or local editors.

      [#38](https://github.com/cyanheads/mcp-ts-core/issues/38)   ← issue
      [#42](https://github.com/cyanheads/mcp-ts-core/pull/42)     ← PR

  Verify numbers exist before linking (`gh issue view NN`, `gh pr view NN`).
  Never speculate on a future number — `#42` for an upcoming PR silently
  resolves to whatever real item already owns 42, and timeline previews pull
  in that unrelated item's metadata.

  TAG ANNOTATIONS — the annotated tag body renders as the GitHub Release body
  via `gh release create --notes-from-tag`. The tag is a headline digest of this
  changelog entry, not a copy of its structure. Format:

    <theme — omit the version number, GitHub prepends v<VERSION>:>
                                                          ← blank line
    - <notable user-facing change> (#N)
    - <notable user-facing change> (#N)
    - <ONE grouped line for the minor/internal changes — build config, repo hygiene, metadata>
    - deps: `@cyanheads/mcp-ts-core` ^0.9.1 → ^0.9.6 (+ dev-dep bumps)
                                                          ← blank line
    [CHANGELOG v<version>](https://github.com/<OWNER>/<REPO>/blob/main/changelog/<major.minor>.x/<version>.md)

  Rules:

  - Flat bullets only — never Keep-a-Changelog section headers (`Added:`,
    `Changed:`, `Fixed:`, `Dependency bumps:`). Those belong in this file; a tag
    that mirrors the changelog's structure is wrong even when every line is true.
  - Complete at headline granularity — notable changes get their own bullet,
    minor and internal items share ONE compact bullet. Nothing dropped, nothing
    expanded: the changelog carries the depth, the tag carries the existence.
  - Deps: one line max, naming only what earns it. Per-package arrows live here
    in the changelog entry, not in the tag.
  - No gates line — test counts and devcheck status are changelog detail, not
    release-body material.
  - No narrative preamble, no marketing adjectives.
  - Issue backlinks `(#N)` on the bullets that address them.
  - Last line is the changelog link, with a blank line above it so it renders as
    its own paragraph.
  - Length is earned — a subject, two bullets, and the link is a fine tag for a
    small patch.

  Never a flat comma-separated string. Full reference: `skills/git-wrapup/SKILL.md`
  step 8.
-->

## Added

-

## Changed

-

<!-- ## Deprecated

- -->

<!-- ## Removed

- -->

## Fixed

-

<!-- ## Security

- -->