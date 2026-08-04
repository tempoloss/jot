# jot

A Telegram bot that captures notes and tasks as GitHub Issues. Zero
dependencies, runs on Cloudflare Workers.

[Русская версия](README.ru.md)

```
buy a charger          a note
photo + caption        a note with an image, /pic 5 sends it back
/rmpic 5               unlink the image from note 5
/task 5                promote note 5 to a task
/t text                a task straight away
/list                  open tasks, with age
/notes                 recent notes
/done 3                close it
/c 3 text              comment
```

It also pushes GitHub notifications the other way. When somebody replies to an
issue or pull request you are in, the reply arrives in Telegram within a minute,
linked to the comment itself:

```
JAicewizard replied in duckdb/community-extensions#2431
faiss: exclude windows_amd64 and windows_amd64_mingw

  `_rtools` is the old name for `_mingw`, this looks good to me
```

## Anyone who is not you

The bot is single-user. By default it says nothing at all to a stranger, so it
does not even confirm it exists.

Set `STRANGER_PHOTO` to a Telegram `file_id` and `/start` from anyone else gets
that picture, once per account per day, and you get told who knocked. That trades
the silence for personality, which is a choice rather than a default.

```bash
wrangler secret put STRANGER_PHOTO     # optional, a Telegram file_id
```

Repeat `/start` from the same account costs no API calls at all: nine deliveries
in one minute is what prompted that, and it used to cost eighteen. Alerts are also
capped per hour, because per-account dedup does nothing against a crowd. If the
picture cannot be delivered, because the stranger has blocked the bot, you are
still told they knocked. Losing the one outside event this bot ever sees to a
failed decoration would be the wrong way round.

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
| GitHub's read flag as the dedup store | no second copy of the truth, exact dedup | [ADR 0005](docs/adr/0005-github-is-the-dedup-store.md) |

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
  -d "url=https://<your-host>" \
  -d "secret_token=<WEBHOOK_SECRET>"
```

`secret_token` is mandatory. Without it, anyone who learns the URL can drive the
bot, and hostnames are discoverable. Anything that fails the check gets a 404, so
a prober cannot tell the host from an empty one.

`wrangler.toml` sets a custom domain and turns `workers_dev` and `preview_urls`
off, because the `workers.dev` hostname is derived from the account and publishes
the account email's local part in a URL anyone can read. Use whichever host you
configure there.

**6. GitHub notifications, optional.** A **classic** PAT with the
`notifications` scope and nothing else:

```bash
wrangler secret put GH_NOTIFY_TOKEN
wrangler deploy                        # registers the cron trigger
```

Fine-grained tokens are rejected by these endpoints, so this cannot reuse
`GH_PAT`. Set `GH_LOGIN` in `wrangler.toml` to your GitHub login. Leave the
secret unset and the schedule does nothing.

The first run is quiet: the poll takes unread threads only, so it starts from the
next real event rather than replaying history. It marks each thread read after
delivering, which means the bot clears your GitHub bell. That is the trade for
needing no storage. See [ADR 0005](docs/adr/0005-github-is-the-dedup-store.md).

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

45 tests, no network. Everything is split so the impure half is a thin shell
around a pure one: `fetch` around `parse` for commands, and the GitHub call
around `format` for notifications. The load-bearing tests are the ones that pin
behaviour a plausible change would break: an unknown command is an error and
never a silently saved note, a stranger is greeted once however often they knock,
a failed photo still reports that somebody knocked, and a sticky
`reason=mention` does not claim a tag that is not in the comment body.

## Layout

```
src/commands.js   parse a message into an intent — pure, all the logic
src/github.js     Issues API: create, list, close, promote, comment
src/notify.js     GitHub notifications: fetch, filter, format, mark read
src/html.js       escaping shared by both message paths
src/index.js      webhook and cron: checks, dispatch, poll, reply
local.js          long-poll runner for testing
docs/adr/         why each load-bearing decision was made
```

## Security note on the token

The Telegram token lives in Cloudflare secrets, never in the repo. GitHub
secret-scans public repositories, reports leaked Telegram tokens upstream, and
Telegram revokes them — so a committed token yields a silently dead bot. This is
a reliability argument as much as a security one.
