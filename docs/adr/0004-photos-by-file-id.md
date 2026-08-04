# 4. Photos are stored as a Telegram file_id, not as bytes

Status: accepted

Decided in `116a219` (2026-08-03), with `/rmpic` added in `7fa4821`. Written down as
an ADR on 2026-08-03, when the decisions that until then lived only in commit
messages were filed here.

## Context

A photo sent to the bot should become a note with the image attached and be
retrievable later. The image bytes have to live somewhere the bot can reach
without leaking a credential.

## Decision

Store the Telegram `file_id`, not the bytes. Telegram keeps the file
indefinitely and `file_id` is a stable handle, so the note records the handle in
the issue body and `/pic N` sends the photo back.

Rejected alternatives:

- **Put the file URL in the issue.** Telegram's file URL embeds the bot token,
  so this writes the token into the issue body.
- **Commit the image to the repo.** Needs `Contents: write` on the PAT, and the
  image only renders if the repo is public, and the task repo is deliberately
  private so notes stay private.

## Consequences

- No extra GitHub permission, no token in the stored data.
- Trade-off, stated plainly: the image does not render in the GitHub UI. The
  issue shows the caption and a `📷` marker; the picture comes back through
  `/pic N` in Telegram, where it was captured.
- If inline rendering is ever wanted, the path is `Contents: write` plus a
  public repo. A deliberate change, not a default.
