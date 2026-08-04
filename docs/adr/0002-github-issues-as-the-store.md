# 2. GitHub Issues are the store, and there is no second copy

Status: accepted

Decided in `d761347` (2026-08-03). Written down as an ADR on 2026-08-03, when the
decisions that until then lived only in commit messages were filed here.

## Context

The bot needs somewhere to keep notes and tasks. The options were a database, a
key-value store, or GitHub Issues.

## Decision

Store each note and task as a GitHub Issue in a private repository.

Issues are already a task database with an API, labels, search, comments and a
mobile app. The second interface, reading and editing from a phone, therefore comes
for free, and there is no second copy of the data to fall out of sync with.

Combining Issues with a KV cache was considered and deferred. Two stores of one
dataset is a synchronisation bug. The coherent version is Issues as the source
of truth with KV as a one-directional cache, and it is not worth adding until
`/list` is measurably slow.

## Consequences and measured behaviour

- **The issues list endpoint lags creation by seconds.** Measured: `POST
  /issues` returns `200` with a number, but `GET /issues` does not show the new
  issue for a few seconds; a single `GET /issues/{n}` is immediately fresh. So
  `/list` right after capture may not show the just-added item. This is not a
  bug in the bot and cannot be fixed on its side. The create response is
  authoritative, so the number echoed to the user is always correct.

- **Write access is not `repo.permissions.push`.** That field reports the
  authenticated user's role on the repository, not what the token was granted:
  a read-only fine-grained PAT on your own repo returns `push: true`. A check
  built on it reported "write: yes" and then the first task failed with `403`.
  The real probe is `POST /issues` with an empty body. GitHub evaluates the token
  permission before validating the payload, so `403` means no write and
  `422` means write with a bad body, and nothing is created either way.
