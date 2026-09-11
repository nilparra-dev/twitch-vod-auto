# Agent working agreement

This repository contains a TypeScript CLI (`cli/`, published as the
`twitch-vod-m3u8` npm package) and a standalone replay player (`frontend/`).

## Always apply the skill

Before touching code, load and apply the `professional-coding` skill. It is the
working contract for design, comments, compatibility, verification and the
final handoff. If that skill is unavailable in the current environment, follow
the same principles from memory and say so.

## Before editing

- Read the implementation, its callers, the nearby tests and the build or lint
  configuration. Inspect enough to understand the consequence of the change.
- Identify the contract: observable result, valid inputs, ordering, side
  effects, failure behavior, and what existing callers or stored data rely on.
- Reuse existing helpers, modules and dependencies before creating new ones.
- If a decision changes a public contract or a consequential rule and the
  evidence does not resolve it, ask a focused question and continue with the
  independent work.

## While editing

- Keep the normal path easy to follow. Fix causes, not symptoms: no broad
  catches, silent defaults, disabled checks or unsafe casts.
- Keep changes coherent and reviewable. Do not mix mechanical rewrites with
  behavior changes. Leave unrelated edits out.
- Treat untrusted input, persistent state and external effects as part of the
  design. Enforce host allowlists, size limits, timeouts, cancellation and
  bounded concurrency where the code touches the network or the filesystem.
- Preserve compatibility for serialized state and existing command output
  unless the change explicitly breaks it.
- The persisted chat contract lives in `cli/src/protocol.ts` and is shared with
  the player through the `@chat-protocol` alias. Keep it dependency-free and
  treat any change to it as a versioned contract change.
- Write comments and documentation in English, in the repository's tone.
  Explain decisions, constraints and invariants. Do not narrate the session.

## Verification

Run the checks that match the risk of the change. From the repository root:

```bash
npm run typecheck     # CLI type checking
npm test              # compile and run the CLI tests
npm run test:package  # rebuild, pack and smoke test the npm artifact
```

From `frontend/`:

```bash
npm run lint
npm run typecheck
npm test
npm run test:browser  # needs Chromium: npx playwright install chromium
```

- A bug fix needs a regression test that fails before the fix when reproducing
  the failure is feasible. Derive the expected result from the contract.
- Never weaken, skip or delete a check to make a change pass.
- State exactly what ran and passed, what was only inspected, and what could
  not be verified. Distinguish measurements from estimates.

## Handoff

Report the resulting behavior, the reason for the design choice, the checks
that actually ran, and any remaining limitation. Keep it short and factual.
