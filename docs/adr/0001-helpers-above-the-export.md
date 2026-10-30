# 0001 Helpers above the export

- Status: accepted
- Date: 2026-10-31

## Context

A source file in `src/` puts its module-level constants and private helpers
first and its exports after them. `src/format/md-to-html.ts`,
`src/format/rich.ts`, `src/draft/draft-streamer.ts`, `src/bridge/send.ts`,
`src/bridge/turn-loop.ts` and the rest of `src/` follow this order. The
`kalinichenko:typescript-conventions` rule "Files are kebab-case, one entity
per file" sets the opposite order: imports, then the primary export, then the
helpers it uses.

## Options considered

- Keep the order of the code: helpers and constants above the exports.
- Follow the convention: move the primary export to the top of each file.

## Decision

We will keep the order of the code. A file in `src/` opens with its imports,
then its module-level constants and private helpers, then its exports. This
ADR replaces the intra-file order of the `typescript-conventions` rule "Files
are kebab-case, one entity per file" in this project.

## Consequences

Good: no file moves; a reader meets each helper and its rationale comment
before the code that uses it; new code has one order to follow.
Bad: a file does not open with what it is for; in a long file such as
`src/format/md-to-html.ts` the export is far down.

## Invariants

None.

## Confirmation

Review only.
