---
name: release
description: >-
  Cut and publish a new npm release of telegram-agent-kit. Use this WHENEVER the
  user wants to release, publish, ship a new version, bump the version, cut a
  tag, or generate a changelog entry for this package — even if they only say
  "release it" or "let's publish". Drives the whole local side of the release:
  derive the next semver version from the commit history, write the CHANGELOG
  section, sync package.json, run the full verification suite, commit, push, and
  (only after explicit confirmation) tag — the tag push triggers the GitHub Actions
  npm-publish workflow. Then open a draft GitHub Release with friendly notes and
  publish it once CI confirms the npm publish succeeded.
---

# Releasing telegram-agent-kit

## How releasing works here

Publishing is **tag-driven and runs in CI**, not locally. The
`.github/workflows/release.yml` workflow fires on any `v*` tag push and runs
`npm ci → npm run build → npm publish --provenance --access public`, authing with
the `NPM_TOKEN` repo secret.

The workflow publishes **exactly the `version` in `package.json`** — it does not
derive the version from the tag. So the one invariant this skill exists to protect
is: **`package.json` version === the tag name without the leading `v`.** If they
ever drift, you publish the wrong version.

Your job is everything around that CI publish: pick the version, write the
changelog, sync `package.json`, prove the build is green, commit, push, and — after
an explicit confirmation, because pushing the tag publishes to npm and **an npm
version can't be unpublished, only deprecated** — push the tag. You also own the
GitHub Release: create it as a **draft** right after tagging, then **publish the
draft only once CI confirms the npm publish succeeded**. That ordering means a
failed publish never leaves a public GitHub Release pointing at a version nobody can
install.

## Preconditions — check before doing anything

Run these and stop with a clear message if any fails. Releasing from a dirty or
stale tree produces a release that doesn't match what's reviewed.

```sh
git rev-parse --abbrev-ref HEAD     # must be main
git status --porcelain              # must be empty (clean tree)
git fetch --tags origin             # so the "last tag" below is accurate
```

- **Not on `main`** → ask the user to switch or confirm they really want to release
  from this branch.
- **Dirty tree** → stop. Uncommitted work must be committed or stashed first; the
  release commit should contain only the version bump + changelog.
- It's fine if `dist/` shows as modified after a build later — that's gitignored.

## Step 1 — Gather state

```sh
node -p "require('./package.json').version"   # current version
git describe --tags --abbrev=0 2>/dev/null    # last release tag (may be absent)
```

Then collect the commits since the last tag. If there is **no** prior tag, use the
whole history (`git log --oneline`) — this is the first release.

```sh
git log <last-tag>..HEAD --pretty=format:'%s%n%b' --no-merges
```

If there are **zero** commits since the last tag, stop — there's nothing to release.

## Step 2 — Propose the version (and let the user confirm)

Classify the commits by their conventional-commit prefix and propose a bump. Always
**show your reasoning** ("3 feat, 1 fix, no breaking → minor → 0.2.0") and let the
user override — you're proposing, not deciding.

Bump rules depend on whether the package is pre-1.0, because semver treats `0.x`
specially (anything may change in `0.x`, so breaking changes don't force a major):

**Pre-1.0 (current `0.x.y`):**
- breaking change (`feat!`, `fix!`, or a `BREAKING CHANGE:` footer) → **minor** (`0.1.0 → 0.2.0`)
- `feat:` → **minor** (`0.1.0 → 0.2.0`)
- only `fix` / `perf` / `refactor` / `docs` / `chore` → **patch** (`0.1.0 → 0.1.1`)

**Post-1.0 (`>=1.0.0`):**
- breaking → **major**
- `feat:` → **minor**
- everything else → **patch**

State the proposed new version explicitly and get a yes (or an override) before
editing files. This is the only judgement call in the flow — don't skip the confirm.

## Step 3 — Generate the CHANGELOG section

Generate the section automatically from the commits; you don't need to ask the user
to hand-write it. Match the **existing style** in `CHANGELOG.md` exactly — read the
top of the file first to mirror it. The established shape is:

```markdown
## <version> — <YYYY-MM-DD>

- <grouped, human-readable bullets>
```

Conventions to follow:
- Heading format is `## X.Y.Z — YYYY-MM-DD` with an em dash. Get today's date from
  `date +%Y-%m-%d` (don't guess it).
- Group related commits into readable bullets rather than dumping raw commit
  subjects. Drop noise (`chore: release …`, formatting-only, CI tweaks) unless it's
  user-visible. The reader is a library consumer deciding whether to upgrade —
  write for them, not for git.
- Prefer the project's domain vocabulary (the layer names "Formatting", "Draft
  engine", "Turn-loop bridge", "/deepagents") over commit hashes.
- Insert the new section directly under the `# Changelog` title, above the previous
  version's section.

## Step 4 — Apply the edits

1. Bump `version` in `package.json` to the agreed value.
2. Prepend the new section to `CHANGELOG.md`.

Re-read `package.json` after editing and confirm `version` is exactly the agreed
string — this is the value CI will publish.

## Step 5 — Verify (this gate must be green before anything is committed)

Run the **same checks CI runs, in the same order**. The ordering is load-bearing:
`build` must run before `test` because `test/deepagents/no-peers.test.ts` greps the
built `dist/deepagents/index.js` to prove the bundle carries no runtime peer import,
and it silently skips when `dist/` is absent (see CLAUDE.md).

```sh
npm run lint
npm run typecheck
npm run build      # before test — the /deepagents dist-grep test needs dist/
npm test
```

If **any** step fails, **abort the release**: report which step failed with its
output, and do not commit, push, or tag. A red build must never become a tag,
because the tag is the publish trigger. Revert the version/changelog edits or leave
them for the user to fix — say which you did.

## Step 6 — Commit and push the branch

```sh
git add package.json CHANGELOG.md
git commit -m "chore: release v<version>"
git push origin main
```

Only `package.json` and `CHANGELOG.md` should be in this commit. `dist/` is
gitignored and must not be staged.

## Step 7 — Tag, then open a DRAFT GitHub Release (explicit confirmation required)

This is the irreversible step. **Before tagging, ask the user to confirm in plain
terms**, e.g.: "Ready to publish `v<version>` to npm? Pushing the tag triggers the
release workflow and the version cannot be unpublished — only deprecated. Proceed?"

Only after an explicit yes, push the tag:

```sh
git tag v<version>
git push origin v<version>      # ← triggers release.yml → npm publish
```

Double-check the tag matches `package.json` before pushing: `v` + the version you
just committed. If they don't match, stop — fix the mismatch first.

Then immediately create the GitHub Release **as a draft**. It stays a draft until
the npm publish actually succeeds (Step 8), so a failed publish never leaves a
public release pointing at a version that isn't on npm.

```sh
gh release create v<version> --draft --title "v<version>" --notes "<release notes>"
```

`gh` uses the local user's auth (scope `repo`), so no workflow permission changes
are needed. The tag already exists on the remote, so the release attaches to it.

### Writing the release notes

These notes are **for humans skimming the Releases page**, not for the changelog
reader. Keep them warm and high-level — **minimise technical detail**:

- Open with one or two sentences on what this release gives the user / what changed.
- Then a short bullet list of the headline, user-facing changes in plain language.
- **Leave out** internals: no test names, file paths, commit hashes, CI/build/lint
  notes, or refactors that don't change behaviour. If it wouldn't matter to someone
  installing the package, drop it.
- For a first release, frame it as an introduction ("what this package does")
  rather than a diff.
- End with a pointer to the full changelog, e.g. `See CHANGELOG.md for full detail.`

Derive the substance from the same commits, but rewrite — don't paste the CHANGELOG
section. The changelog is the precise record; the release note is the friendly pitch.

## Step 8 — Watch CI, then publish the release

Watch the publish workflow (the tag push started it; the run may take a few seconds
to appear, so retry the list once if it's empty):

```sh
gh run watch --exit-status $(gh run list --workflow=release.yml --limit=1 --json databaseId -q '.[0].databaseId')
```

**On success** — confirm the version is live, then flip the draft to published:

```sh
npm view telegram-agent-kit version          # should print <version>
gh release edit v<version> --draft=false      # publish the GitHub Release
```

Report the published version plus the npm and GitHub Release URLs.

**On failure** — leave the GitHub Release as a draft (do not publish it) and surface
the failing log. Common causes: a `403` means `NPM_TOKEN` is missing/expired; a
`--provenance` error usually means the `repository` field is missing from
`package.json`. The tag is already pushed, so the fix is to address the cause and
cut the **next** patch — never retag the same version. The lingering draft is
harmless; delete it (`gh release delete v<version>`) or keep it to publish once a
re-cut succeeds.
