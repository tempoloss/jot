# 6. Deleting asks first, because there is no undo

## Status

Accepted

Introduced in `/rm`, pinned by the parse tests in `test/commands.test.js`. Written
down as an ADR the same day, when the decisions that until then lived only in
commit messages were filed here.

## Context

Capture in this bot is unconditional. Anything you type is a note, and no
decision is required at the moment you write it — that is the point of [ADR
0001](0001-plain-text-is-a-note.md). Notes are records, so `/done`
closes tasks and a note is never closed at all.

That leaves nowhere to put a note that should not exist. A duplicate, a message
meant for another chat, a line of nonsense typed at three in the morning — all of
it stays in the list forever, and `/notes` shows the twenty most recent, so
garbage crowds out signal.

Two facts make deletion sharper than it looks:

- The store is GitHub Issues and there is no second copy of the truth
  ([ADR 0002](0002-github-issues-as-the-store.md)). Nothing to restore from.
- REST has no delete-issue endpoint at all. Deletion exists only as the GraphQL
  `deleteIssue` mutation, and it needs admin or maintain on the repository
  rather than the `Issues: write` the rest of the bot runs on.

And one fact makes it dangerous: `/rm` sits three characters from `/rmpic`.
`/rmpic 5` unlinks a photo and is harmless. A typo landing on `/rm 5` would
destroy the note instead, permanently, with a single keystroke of difference.

## Decision

`/rm 5` shows the title and asks. `/rm 5!` performs the deletion.

The bang is not a preference setting or a confirmation dialog with buttons. It is
one character, typed deliberately, in the same message shape as the command it
guards.

Failures are reported as token problems, not as mysteries: GraphQL answers `200`
with an `errors` array, so the status code alone proves nothing and the response
body is checked.

## Alternatives rejected

- **Delete immediately, no confirmation.** Consistent with the friction-free
  capture rule, but capture and destruction are not the same act. Removing
  friction from writing is the product; removing it from deleting is a footgun.
- **Name it `/delete` so it cannot be a typo of `/rmpic`.** Fixes the collision
  and nothing else. The irreversibility remains, and the longer name reads as if
  the danger were the spelling.
- **Close the issue instead of deleting.** Already exists as `/done`, and it
  contradicts the model: a note is a record, not an obligation, so closing one
  says nothing about it.
- **Redact the body and keep the issue.** Leaves a numbered ghost in `/notes`
  forever, which is the problem being solved.

## Consequences

Deleting a note takes two messages. That is the intended cost.

The token now needs admin or maintain on the task repository, not just
`Issues: write` — one more permission than the README's setup section asked for
before this. Everything else in the bot still works on the narrower scope, so a
token without it degrades to exactly one broken command with a clear reason,
rather than a silent no-op.
