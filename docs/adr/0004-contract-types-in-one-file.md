# 0004 Contract types in one file

- Status: accepted
- Date: 2026-10-31

## Context

The kit's shared types are its contracts with the caller: the four injected
interfaces and the event and option types they exchange. They live together
in `src/bridge/interfaces.ts`, and a source file exports several related
functions and types (`src/bridge/send.ts`, `src/format/rich.ts`,
`src/draft/feed.ts`). The `kalinichenko:typescript-conventions` rules "Files
are kebab-case, one entity per file" and "A shared type is a model in
`models/`" set one entity per file and one shared type per file in a
`models/` folder.

## Options considered

- Keep the code's layout: the contract types in one file, several related
  exports per file, no `models/` folder.
- Follow the convention: one file per shared type in a `models/` folder, and
  one entity per source file.

## Decision

We will keep the code's layout. The kit's contract types stay in one file,
`src/bridge/interfaces.ts`, and a source file may export several functions
and types that do one job together. This ADR replaces the
`typescript-conventions` rules "one entity per file" and "A shared type is a
model in `models/`" in this project.

## Consequences

Good: the whole caller contract reads in one file, and the README's
"The four interfaces" section maps to it; no file split.
Bad: `src/bridge/interfaces.ts` grows with each new contract, and it sits in
`src/bridge/` although `src/draft/` uses it too (the debt of I-2).

## Invariants

None.

## Confirmation

Review only.
