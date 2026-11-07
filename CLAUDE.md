# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`telegram-agent-kit` is a published npm library (ESM-only) that wires LLM agents to
Telegram. Its modules, layers, patterns and invariants are in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Its product decisions — the
direction, what it will not do, the PDRs — are in
[`docs/PRODUCT.md`](docs/PRODUCT.md). The user guides are in `docs/guides/`.

Before a spec, a plan or the first edit of a new feature, read
`docs/ARCHITECTURE.md`. At the start of a new feature, and for a decision, load
`craft:architecture`.

## Commands and conventions

The commands, the "build before test" rule for `/deepagents`, the check before a
PR, and the code and commit rules are in `CONTRIBUTING.md`. This file imports it,
so it keeps no copy of them:

@CONTRIBUTING.md
