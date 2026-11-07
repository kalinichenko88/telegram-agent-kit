# Contributing

This file has the setup, the commands, and the rules for a pull request.

## Before a feature

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the modules, the layers,
the patterns and the invariants. Read [`docs/PRODUCT.md`](docs/PRODUCT.md) for the
direction of the kit and what it will not do.

## Setup

You need Node 20 or later.

```sh
git clone https://github.com/kalinichenko88/telegram-agent-kit.git
cd telegram-agent-kit
npm ci
```

## Commands

```sh
npm run build       # tsup → dist/ (ESM + .d.ts) for both entry points
npm run typecheck   # tsc --noEmit
npm test            # vitest run (whole suite)
npm run lint        # biome check .
npm run format      # biome format --write .
```

Run a single test file or test by name:

```sh
npx vitest run test/format/md-to-html.test.ts          # one file
npx vitest run -t "nests bold and italic"              # by test name
npx vitest                                             # watch mode
```

**Build before test if you touch `/deepagents`.** `test/deepagents/no-peers.test.ts`
greps `dist/deepagents/index.js` to prove the built bundle carries no runtime import of
the optional peers; it silently skips when `dist/` is absent. CI runs `build` before
`test` for exactly this reason — replicate that ordering locally when you verify the
peer-isolation guarantee.

## The check before a pull request

CI runs these steps in this order on Node 20, 22 and 24
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)). Run them in the same order:

```sh
npm run lint
npm run typecheck
npm run build       # before test
npm test
```

CI also builds and runs the tests on Bun.

## Code rules

- **`strict` TypeScript**, ESM only (`"type": "module"`).
- **Comment the *why*, heavily.** The format/rich modules carry long doc-comments
  explaining each invariant (flanking rules, code-region tracking, fence anchoring).
  When you change behavior there, update the rationale comment too — those comments are
  the spec.
- Formatting: Biome, 2-space indent, single quotes (`biome.json`). Run `npm run format`
  before committing.
- `dist/` and `node_modules/` are gitignored; only `dist/` is published (`files` in
  `package.json`).

## Commits and pull requests

- A commit subject and a PR title are `type: sentence` or `type(scope): sentence`,
  in the imperative mood: `fix(format): keep text chunking moving`. The types are
  `feat`, `fix`, `refactor`, `docs`, `test`, `ci` and `chore`.
- A breaking change adds `!` after the type, as `feat!: …`, or a
  `BREAKING CHANGE:` footer. The release reads these markers to choose the
  version.
- A pull request merges as one squash commit. Give the PR title the same shape
  as a commit subject: the squash commit takes one of them as its subject.
- Write everything on GitHub in English: commits, pull requests, issues and comments.
