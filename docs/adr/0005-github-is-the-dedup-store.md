# 5. GitHub's read flag is the dedup store for notifications

Status: accepted

Decided in `f9993a7` (2026-08-04), pinned by the etag and failed-poll tests in
`test/notify.test.js`. The same rule was already load-bearing for stranger greetings
in `92beb2b`.

## Context

Maintainer replies were going unread for hours, because GitHub is a place you
have to remember to visit and Telegram is not. A scheduled poll can forward them,
but polling needs to know what has already been sent, or every run resends
everything.

That is a state problem, and this bot has deliberately avoided having any state
of its own (see [ADR 0002](0002-github-issues-as-the-store.md)).

## Decision

Fetch unread notifications only, and mark each thread read after it has been
delivered. GitHub's own read/unread flag is the record of what has been sent, so
there is nothing to store here.

The order is load-bearing: **deliver first, mark second.** Marking first and then
failing to send loses the notification permanently, with GitHub asserting it was
seen. Sending first and then failing to mark costs a duplicate on the next poll.
A duplicate is recoverable and silence is not, so delivery is at-least-once.

Rejected alternatives:

- **Workers KV.** A second copy of the truth that has to be kept in step with
  GitHub, which is the synchronisation bug this project already refused once. It
  is also not exact for the case that matters: KV reads are eventually
  consistent, so a burst inside one minute can slip through anyway.
- **The Cache API.** Free and needs no binding, but it is per-colocation, so it
  is best-effort rather than exact. Acceptable for suppressing a stranger's
  repeated `/start`; not acceptable for deciding whether a maintainer's reply has
  been delivered.
- **A Durable Object.** Exact, and far more machinery than a read flag GitHub is
  already maintaining.

## Consequences

- No storage, no binding, and dedup is exact rather than probabilistic.
- The bot clears the GitHub notification bell. For a user who does not read it
  this is a gain, but it is a real side effect on shared state and not reversible
  per notification.
- The token has to be a **classic PAT** with the `notifications` scope. GitHub's
  REST documentation states that these endpoints accept classic tokens only, so
  the fine-grained `GH_PAT` cannot be reused however narrowly it is scoped. The
  `notifications` scope grants the notification list and nothing else, which is
  why this is not the blanket `repo` token the project rejected earlier.
- Comment bodies are read with the existing fine-grained token, which reaches
  public repositories. A comment in a private repository outside its scope simply
  arrives without an excerpt rather than failing.
- `reason` is not trusted to describe the latest comment. GitHub keeps a thread
  at `reason=mention` permanently once you have been tagged in it, so the second
  and third reply would both claim a tag. The comment body is checked for the
  login instead.
- Polling is 59 times an hour, not 60. `X-Poll-Interval` is 60 seconds and cron
  fires on the minute rather than exactly every 60 seconds, so sitting on the
  limit would cross it on jitter alone.
