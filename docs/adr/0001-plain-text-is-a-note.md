# 0001 — Plain text is a note, not a task

## Status

Accepted.

## Context

The obvious design makes a plain message a task and puts notes behind a command.
That forces a decision at the moment of capture: *is this a thing to do, or a
thing to remember?*

A decision at capture time is friction, and friction on capture is what kills a
personal task manager. The whole reason to reach for a bot instead of an app is
that a message is cheaper than a decision.

## Decision

Any plain message is a **note**. Capture is unconditional — no command, no
category, no decision.

Triage is a separate, deliberate act: `/task N` promotes a note to a task once
it has actually been judged actionable. `/t <text>` exists as an escape hatch
for the rare case where the type is known at capture time.

Notes and tasks are the same object with different labels. A note is never
closed — it is a record, not an obligation. A task can be closed.

## Consequences

- Catch first, sort later — the model matches how a thought actually arrives.
- Two views: `/list` for open tasks, `/notes` for recent notes.
- The cost of unconditional capture is a longer note list, addressed by showing
  each item's age so rot is visible rather than silent.
