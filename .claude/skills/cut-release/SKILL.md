---
name: cut-release
description: Use this skill when the user asks to cut, publish, or tag a new release of Hibiki Codex, or says things like "release", "cut a release", "release v0.2.0", "tag a release", "release patch/minor/major", or "publish a new version". Bumps the version in package.json, creates an annotated git tag, pushes both, and triggers the GitHub Actions release workflow that builds the Windows installer + portable exe and publishes a GitHub Release.
---

# Cut a release

Releases are gated on an annotated git tag matching `v*`. Pushing the tag fires `.github/workflows/release.yml`, which builds the Windows installer + portable exe via electron-builder and publishes them as a GitHub Release.

This skill walks the user through a clean release: precondition checks, version bump, commit, annotated tag, push, and a link to the workflow run.

## 1. Verify preconditions

Before doing anything, confirm:

- **Working tree is clean** — `git status --porcelain` must return no output. If dirty, stop and tell the user to commit/stash first.
- **On the `main` branch** — `git rev-parse --abbrev-ref HEAD` must return `main`. If not, ask the user whether they really want to release from a different branch (it will work, but it's almost always a mistake).
- **In sync with `origin/main`** — run `git fetch origin main` and check that `HEAD` is at or ahead of `origin/main`. If behind, stop and tell the user to pull first.
- **Has commits since the last tag** — `git log <last-tag>..HEAD --oneline` must be non-empty. If empty, ask whether the user really wants to retag the same code.

If any check fails, stop and report the exact issue. Do not work around it.

## 2. Determine the new version

- Read the current version from the latest tag.
- Decide the new version based on the user's intent:
  - If they said an explicit version (e.g. "release v0.2.0", "release 1.0.0"), use exactly that. Strip a leading `v` if they included one — store the bare semver in `package.json`, prepend `v` only for the tag.
  - If they said `patch` / `minor` / `major`, bump that segment of the current version.
  - If unspecified, ASK the user with the four common choices: patch / minor / major / custom — show what the new version would be for each.

The version must be valid semver (`MAJOR.MINOR.PATCH`, optionally with a `-prerelease` suffix). Validate before continuing.

## 3. Preview before changing anything

Print:

- `current → new` version
- A short list of commits since the previous tag: `git log <prev-tag>..HEAD --oneline`
- The exact actions about to happen:
  1. Update `package.json` `version` to `<new-version>`
  2. `git add package.json && git commit -m "Release v<new-version>"`
  3. `git tag -a v<new-version> -m "Release v<new-version>"`
  4. `git push origin main`
  5. `git push origin v<new-version>`

Ask the user to confirm. **Do not proceed without explicit confirmation** — this is a destructive action that touches origin and triggers a real GitHub Release.

## 4. Apply the bump and tag

Once confirmed:

1. Edit `package.json` and update the `version` field to `<new-version>` (preserve formatting and trailing newline).
2. `git add package.json` then commit:
   ```bash
   git commit -m "Release v<new-version>"
   ```
3. Create an annotated tag (always `-a`, never lightweight):
   ```bash
   git tag -a v<new-version> -m "Release v<new-version>"
   ```

## 5. Push

Push commit and tag separately so the failure point is unambiguous:

```bash
git push origin main
git push origin v<new-version>
```

If the tag push is rejected (because the tag already exists upstream), STOP — do not force-push. Tell the user the tag exists and let them decide.

## 6. Report

Tell the user:

- The new tag was pushed (`v<new-version>`).
- The release workflow has fired. Show the URL: `https://github.com/brunolm/hibiki-codex/actions/workflows/release.yml`.
- The release page (where assets will appear in ~10 min): `https://github.com/brunolm/hibiki-codex/releases/tag/v<new-version>`.
- Once the build completes, two files will be attached: `Hibiki Codex Setup <new-version>.exe` and `Hibiki Codex-<new-version>-portable.exe`.

## Constraints

- **Never** force-push tags or branches.
- **Never** skip the user confirmation step.
- **Never** work around a dirty working tree, wrong branch, or out-of-sync state — surface the issue and stop.
- **Always** use annotated tags (`-a`), not lightweight.
- **Always** prefix tags with `v` (the workflow trigger is `v*`).
