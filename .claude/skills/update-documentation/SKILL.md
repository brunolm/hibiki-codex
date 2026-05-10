---
name: update-documentation
description: Use this skill when the user asks to check, audit, or update the project's documentation, or says things like "update docs", "are the docs current", "check documentation", "sync docs with code", "outdated documentation", or any phrasing that pairs "docs" / "documentation" / "README" / "landing page" with verbs like update / check / audit / sync / verify. Audits README.md, docs/index.html, resources/whisper/README.md, and any other tracked doc against the current source — flags drift, then offers to fix it.
---

# Update / audit project documentation

Goal: surface any drift between the project's docs and the actual code, and let the user accept fixes before any file is written. **Never edit docs without first showing what's drifted and getting confirmation.**

## 1. Inventory the docs

Tracked documentation files in this project:

- `README.md` — top-level: tagline, architecture tree, setup-with-AI prompt, manual setup, Settings tables, Topbar section, run commands.
- `docs/index.html` — public landing page (hibikicodex.com). Hero tagline + meta description + Requires callout + Setup `<pre>` + cards.
- `resources/whisper/README.md` — what the bundled-VAD folder holds.
- `.github/workflows/release.yml` description in commit history / cut-release skill — secondary, only check if release process actually changed.

Read all of them. Note which sections enumerate concrete code state (settings fields, file names, IPC handlers, package.json scripts, etc.) — those are where drift hurts most.

## 2. Build the "current state" picture from code

Walk the source so you can compare without trusting the docs:

- **Settings shape** — read `src/main/settings.ts`. Each field in the `Settings` type and `defaults` object is a candidate for inclusion in the README's Settings tables. Note new fields and new defaults (e.g. `whisperLanguage` default, new `transcribeMaxLanes`, `alwaysOnTop`, `windowBounds`).
- **Architecture tree** — list every `.ts` file under `src/main/` (depth 1). The README's tree should match. Flag missing entries and stale ones.
- **Scripts** — read `package.json` `scripts`. The README's Run / Setup blocks should reference the same script names.
- **Topbar / window features** — grep `src/renderer/src/App.tsx` and `src/main/index.ts` for visible features (pin-on-top, window bounds restore, splash, install panels). The README's Topbar section should mention them.
- **Modals / downloaders** — check `src/main/whisperRuntimeCatalog.ts`, `src/main/whisperCatalog.ts`, and `src/renderer/src/components/*DownloadModal.tsx`. The README should mention what gets downloaded and where it lands.
- **Recent git history** — `git log <last-docs-commit>..HEAD --oneline -- src/ scripts/ package.json` is a fast prefilter. Anything that touched code paths the docs describe is a drift candidate.

If the user asked about a specific area ("are the settings docs current?"), narrow the scan to that area.

## 3. Produce a drift report

Group findings by file. For each item:

- **What** is out of sync (one line).
- **Why** it matters (one line — e.g. "users won't know the field exists" / "command no longer works").
- **Proposed fix** — concrete edit, ideally a diff snippet or a paragraph of replacement text. Reuse the doc's existing tone and table format.

Group findings into:

- **High priority** — wrong instructions a user would follow (broken setup commands, missing required fields, removed scripts referenced).
- **Medium priority** — missing features in the Settings tables / topbar section / architecture tree.
- **Low priority** — stale phrasing, outdated examples, tagline drift.

If everything is current, say so plainly. Don't invent work.

## 4. Confirm before editing

Print the drift report and ask the user which items to apply. Offer:

1. **All** — apply every proposed fix.
2. **Pick** — let the user choose by number.
3. **None** — exit, leave docs untouched.

**Do not edit before the user picks.** This is the whole point of the skill — it's an audit, not an autopilot.

## 5. Apply fixes

For each accepted item:

- Use `Edit` on a single anchor (or `Write` only for a full rewrite the user explicitly approved).
- Preserve existing tone and table/list shape — match the doc's voice, don't introduce a new style.
- Don't add emojis unless the file already uses them.
- Don't reorder unrelated sections.
- For tables: append rows in the order fields appear in `Settings` type, not alphabetically — the existing tables follow source order.

After editing, run `bun run typecheck` only if a code/doc round-trip is in question (rare — typecheck shouldn't be needed for doc-only edits). Don't run it gratuitously.

## 6. Report

Tell the user:

- Which items were applied vs. skipped.
- Which files changed (paths only, not diffs — the user can `git diff`).
- Suggest a commit message if and only if they ask, in the existing project style (`docs: <summary>` lowercase, terse, **Why:** body if non-obvious).

**Do not commit on your own.** Match the rest of this project — commits happen when the user says "commit".

## Constraints

- **Never** invent features in the docs that don't exist in the code.
- **Never** silently rewrite a doc — every change goes through the confirmation step.
- **Never** delete sections without proposing the deletion in the drift report first.
- **Never** touch `node_modules/`, `release/`, `.local.*` files, or any other gitignored doc-like content.
- **Always** read the *current* file state with the `Read` tool before proposing edits. Don't rely on memory from a previous skill run.
- **Always** include a "Why" line for each fix so the user can decide whether the priority is right.
