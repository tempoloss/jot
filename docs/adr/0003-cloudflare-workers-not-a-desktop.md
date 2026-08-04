# 3. The bot runs on Workers, not on a desktop that reboots

Status: accepted

Decided in `116a219` (2026-08-03). Written down as an ADR on 2026-08-03, when the
decisions that until then lived only in commit messages were filed here.

## Context

An interactive bot has to be reachable the moment a message arrives, from
anywhere, since the whole point is capture away from a desk. The candidates were
a self-hosted process on an always-on machine, and a serverless webhook.

## Decision

Run as a Telegram webhook on Cloudflare Workers. Always on, free, and it never
reboots.

Leaving a desktop running was offered and rejected on **reliability** first: a
desktop reboots for OS updates and IT, and the bot would die silently, discovered
days later when a note was needed. That is the exact silent-failure
class the design otherwise avoids. It also cannot be restarted from away, which
defeats the purpose.

`repository_dispatch` and a KV-only store were also rejected: the first needs a
token in every watched repo, the second is a second store for no benefit.

## Consequences

- No server to run, patch or pay for.
- `local.js` exists only for testing before deploy. It is explicitly not the
  host: it dies on reboot and dies silently, which is the failure Workers avoid.
  It imports the same `dispatch` the Worker uses, so the two cannot drift.
- The webhook is guarded twice: a `secret_token` header rejects forged requests,
  and an owner-chat-id check ignores everyone else. Silently, so the bot does not
  confirm it exists.
