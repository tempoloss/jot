# jot

A Telegram bot that captures notes and tasks as GitHub Issues. Zero
dependencies, runs on Cloudflare Workers.

[Русская версия](README.ru.md)

```
buy a charger          a note
photo + caption        a note with an image, /pic 5 sends it back
/task 5                promote note 5 to a task
/t text                a task straight away
/list                  open tasks, with age
/notes                 recent notes
/done 3                close it
/c 3 text              comment
```

## Catch first, sort later

Any plain message is a **note**. There is no decision to make when you send it —
not "is this a task or a note", not a category, nothing. Capture is
unconditional, because a decision at capture time is friction, and friction on
capture is what kills a personal task manager.

Triage is separate: `/task N` promotes a note once you have decided it is
actionable. A note is a record and is never closed; a task can be. See
[ADR 0001](docs/adr/0001-plain-text-is-a-note.md).

## Why these choices

| decision | why | detail |
|---|---|---|
| Notes, not tasks, by default | no decision at capture time | [ADR 0001](docs/adr/0001-plain-text-is-a-note.md) |
| GitHub Issues as the store | already a task DB with an API and a mobile app | [ADR 0002](docs/adr/0002-github-issues-as-the-store.md) |
| Cloudflare Workers, not a desktop | always on, never reboots, free | [ADR 0003](docs/adr/0003-cloudflare-workers-not-a-desktop.md) |
| Photos by Telegram `file_id` | no extra scope, no token leak | [ADR 0004](docs/adr/0004-photos-by-file-id.md) |

## Setup

**1. Two private repositories.** One for this code, one — separate — for the
task store. Point the store at a public repo and every personal note becomes
public.

**2. Fine-grained PAT** with **Issues: Read and write**, scoped to the store
repo only. Repository access and Permissions are two separate sections, and the
Update token button at the bottom is easy to miss.

**3. Telegram chat id.** Message the bot first — `getUpdates` returns nothing
until you do — then read `result[0].message.chat.id` from
`https://api.telegram.org/bot<TOKEN>/getUpdates`.

**4. Deploy:**

```bash
npm i -g wrangler
wrangler login
wrangler secret put TELEGRAM_TOKEN
wrangler secret put GH_PAT
wrangler secret put WEBHOOK_SECRET     # any random string
wrangler secret put OWNER_CHAT_ID
wrangler secret put TASK_REPO          # owner/tasks
wrangler deploy
```

**5. Register the webhook** with the same secret:

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://jot.<subdomain>.workers.dev" \
  -d "secret_token=<WEBHOOK_SECRET>"
```

`secret_token` is mandatory. Without it, anyone who learns the URL can drive the
bot, and Worker URLs are guessable.

## Local testing

Copy `.dev.vars.example` to `.dev.vars`, fill it in, then:

```bash
npm run check    # verify config, start nothing
npm run local    # long-poll, no deploy needed
```

`local.js` is for testing only. It dies on reboot and dies silently — the exact
failure Workers avoid. It imports the same `dispatch` the Worker uses, so the
two cannot drift.

## Tests

```bash
npm test
```

The parser splits into `fetch` (impure) and `parse` (pure), so every parse path
is covered with no network. The load-bearing test is that an unknown command is
an error, never a silently saved note.

## Layout

```
src/commands.js   parse a message into an intent — pure, all the logic
src/github.js     Issues API: create, list, close, promote, comment
src/index.js      webhook: secret check, owner check, dispatch, reply
local.js          long-poll runner for testing
docs/adr/         why each load-bearing decision was made
```

## Security note on the token

The Telegram token lives in Cloudflare secrets, never in the repo. GitHub
secret-scans public repositories, reports leaked Telegram tokens upstream, and
Telegram revokes them — so a committed token yields a silently dead bot. This is
a reliability argument as much as a security one.
