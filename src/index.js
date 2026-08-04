/**
 * Telegram webhook on Cloudflare Workers.
 *
 * Always on, never reboots, free. The rejected alternative was leaving the work
 * desktop running: it reboots for Windows updates and IT, and the bot would die
 * silently — discovered days later, when a note was needed.
 *
 * `dispatch`, `handle` and `send` are exported so local.js can drive the same
 * code path over long polling. One implementation, two transports.
 *
 * Messages use HTML parse mode rather than Markdown. Markdown breaks on any
 * stray `_` or `*` in user text, and note text is arbitrary — escaping three
 * HTML entities is reliable where escaping Markdown is not.
 */

import { parse, HELP } from "./commands.js";
import * as gh from "./github.js";
import * as notify from "./notify.js";
import { esc } from "./html.js";

const PHOTO_MARK = "tg-photo";

export default {
  async fetch(request, env) {
    // Anything that is not an authentic Telegram delivery gets the same 404 a
    // nonexistent route would give. A 403 confirms something is listening here;
    // 404 leaves a prober unable to tell this hostname from an empty one.
    if (request.method !== "POST") return notFound();

    // Telegram sends this header when the webhook is registered with
    // secret_token. Without the check, anyone who learns the URL can drive the
    // bot, and hostnames are discoverable.
    if (env.WEBHOOK_SECRET &&
        !timingSafeEqual(request.headers.get("x-telegram-bot-api-secret-token"),
                         env.WEBHOOK_SECRET)) {
      return notFound();
    }

    // Only an authenticated delivery is allowed to define the cache origin, so a
    // prober cannot point stranger-dedup keys at a zone we do not own.
    cacheOrigin ??= new URL(request.url).origin;

    let update;
    try {
      update = await request.json();
    } catch {
      return ok();
    }
    await dispatch(env, update);

    // Always 200: a non-2xx makes Telegram retry the update, duplicating a note
    // that was already created before the error.
    return ok();
  },

  async scheduled(controller, env, ctx) {
    await pollGithub(env).catch((err) => console.error(`poll failed: ${err.message}`));
  },
};

/**
 * Etag and last-poll time live at module scope on purpose.
 *
 * Both are opportunistic. When the isolate is reused the etag turns an unchanged
 * poll into a 304 and the floor absorbs cron jitter, since a trigger scheduled
 * every minute is not spaced exactly sixty seconds apart and GitHub asks for one
 * poll a minute. When the isolate is fresh both are empty and the poll simply
 * happens, which costs one request out of five thousand an hour. Neither is
 * load-bearing, so neither needs storage.
 */
let notifyEtag = null;
let lastPollAt = 0;

async function pollGithub(env) {
  if (!env.GH_NOTIFY_TOKEN || !env.OWNER_CHAT_ID) return;

  const now = Date.now();
  if (now - lastPollAt < notify.POLL_FLOOR_MS) return;
  lastPollAt = now;

  const { threads, etag } = await notify.fetchThreads(env, notifyEtag);
  notifyEtag = etag;

  // Oldest first, so a burst of replies arrives in the order it was written.
  for (const thread of threads.filter(notify.isWanted).reverse()) {
    const comment = await notify.fetchComment(env, thread);

    // His own comment is what produced the notification. Mark it read anyway,
    // otherwise it is re-examined on every poll for as long as it stays unread.
    if (notify.isOwnEcho(comment, env.GH_LOGIN)) {
      await notify.markRead(env, thread.id).catch(() => {});
      continue;
    }

    // Deliver, then mark. The other order loses the notification outright if
    // Telegram fails, while this order costs at most a duplicate.
    await send(env, env.OWNER_CHAT_ID, notify.format(thread, comment, esc, env.GH_LOGIN));
    await notify.markRead(env, thread.id);
  }
}

/** Shared by the webhook and by local polling. */
export async function dispatch(env, update) {
  const msg = update.message ?? update.edited_message;
  const chatId = msg?.chat?.id;

  // Single-user bot. Everyone else is handled by greetStranger, which is silent
  // unless STRANGER_PHOTO is configured.
  if (!chatId || String(chatId) !== String(env.OWNER_CHAT_ID)) {
    await greetStranger(env, chatId, msg)
      .catch((err) => console.error(`greet failed: ${err.message}`));
    return;
  }

  try {
    // A photo arrives as a `photo` array with an optional caption, not as text.
    if (msg.photo?.length) {
      await handlePhoto(env, chatId, msg);
      return;
    }
    // Voice, stickers, documents and the rest carry no text. Without this the
    // owner sends a voice note and gets nothing back, which is indistinguishable
    // from the bot being down.
    if (msg.text === undefined) {
      await send(env, chatId, "🤷 умею только текст и фото");
      return;
    }
    const reply = await handle(env, parse(msg.text));
    if (reply) await send(env, chatId, reply);
  } catch (err) {
    // Log AND reply. Replying only sent failures to Telegram, where they were
    // invisible while debugging: the console showed a clean run while notes
    // silently failed to save. In the Worker this surfaces under `wrangler tail`.
    console.error(`handle failed: ${err.message}`);
    await send(env, chatId, `⚠️ ${esc(err.message)}`).catch(() => {});
  }
}

/**
 * A stranger is interesting exactly once.
 *
 * Repeat /start is noise by definition, and it is also the cheapest way to burn
 * the daily quota and fill the owner's phone: nine deliveries inside one minute
 * from a single account is what prompted this.
 *
 * Two layers, because neither is complete alone:
 *   - `greeted`, a module-scope Map, is per-isolate and stops a rapid burst with
 *     no I/O at all. That is the case actually observed, since consecutive
 *     deliveries land in the same isolate.
 *   - the Cache API survives isolate recycling within a colo.
 *
 * Neither is globally exact, and KV would not be either — its reads are
 * eventually consistent, so a nine-message burst would slip through it too.
 * Exactness would take a Durable Object, which is far more machinery than "do
 * not buzz my phone twice" is worth.
 */
const greeted = new Map();
const GREET_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Per-user dedup does nothing against a raid by many distinct accounts, so the
 * outbound side is also capped. Crossing the cap silences the bot rather than
 * degrading it: an outsider can then still spend Worker requests, which is
 * unavoidable because Telegram delivers regardless, but not Telegram API calls.
 */
const ALERTS_PER_HOUR = 20;
let windowStart = 0;
let windowCount = 0;

/**
 * Cache API keys have to sit inside the zone or the write is silently dropped,
 * so the origin is taken from a real request rather than hardcoded. Under local
 * polling there is no request, and the Map is the only layer.
 */
let cacheOrigin = null;

async function firstContact(id) {
  const now = Date.now();

  const seenAt = greeted.get(id);
  if (seenAt !== undefined && now - seenAt < GREET_TTL_MS) return false;
  greeted.set(id, now);

  // A long-lived isolate would otherwise hold one entry per visitor forever.
  if (greeted.size > 500) {
    for (const [key, at] of greeted) if (now - at > GREET_TTL_MS) greeted.delete(key);
  }

  if (!cacheOrigin || typeof caches === "undefined") return true;
  const key = new Request(`${cacheOrigin}/__greeted/${id}`);
  if (await caches.default.match(key)) return false;
  await caches.default.put(key, new Response("1", {
    headers: { "cache-control": `max-age=${Math.floor(GREET_TTL_MS / 1000)}` },
  }));
  return true;
}

/** Returns how many alerts have been spent this hour, counting this one. */
function spendAlert() {
  const now = Date.now();
  if (now - windowStart > 60 * 60 * 1000) {
    windowStart = now;
    windowCount = 0;
  }
  return ++windowCount;
}

/**
 * Everyone who is not the owner.
 *
 * Silent by default: with no STRANGER_PHOTO configured the bot does not confirm
 * it exists, which is the stronger position. Setting the photo trades that away
 * for personality.
 *
 * It answers only /start, and only the first one per account per day.
 */
async function greetStranger(env, chatId, msg) {
  if (!env.STRANGER_PHOTO || !chatId) return;
  if (msg?.text !== "/start") return;

  const from = msg.from ?? {};
  const id = from.id ?? chatId;

  // A returning visitor costs zero Telegram calls. This is the whole fix.
  if (!(await firstContact(id))) return;

  const spent = spendAlert();
  if (spent > ALERTS_PER_HOUR) return;

  // The alert is the half that matters, so a failed photo must not take it down
  // with it. Measured against a chat that does not exist: sendPhoto threw, the
  // throw propagated, and the owner was never told anyone had knocked. A stranger
  // who blocks the bot produces exactly that, and silence is the wrong answer to
  // the one outside event this bot ever sees.
  const delivered = await send(env, chatId, { photo: env.STRANGER_PHOTO })
    .then(() => true)
    .catch((err) => {
      console.error(`greet photo failed: ${err.message}`);
      return false;
    });

  // Tell the owner who knocked. A stranger reaching the bot is the only outside
  // event it ever sees, so it is worth surfacing rather than logging where it
  // will not be read.
  //
  // Linking by t.me/<username>, NOT by tg://user?id=. Measured: a tg://user link
  // to a stranger is silently dropped — the reply came back with only italic and
  // code entities and no text_mention — while the same link to a chat the bot
  // already knows does resolve. Telegram will not turn an arbitrary id into a
  // mention, so t.me is the form that always works.
  //
  // With no username there is no reachable link at all. The id is rendered as
  // code so it can be copied, and nothing pretends to be tappable.
  const name = esc([from.first_name, from.last_name].filter(Boolean).join(" "));
  const who = from.username
    ? `<a href="https://t.me/${esc(from.username)}">@${esc(from.username)}</a>`
    : (name || "без имени");
  const tail = spent === ALERTS_PER_HOUR
    ? `\n<i>— это ${ALERTS_PER_HOUR}-й за час, дальше молчу до конца часа</i>`
    : "";
  await send(env, env.OWNER_CHAT_ID,
    `👀 <b>${who}</b> постучался в бота\n` +
    `<i>id</i> <code>${id}</code>` +
    `${from.username ? "" : " <i>— юзернейма нет, ссылку не сделать</i>"}` +
    `${delivered ? "" : "\n<i>— картинку не доставил, он закрыт для бота</i>"}${tail}`);
}

/**
 * Photos are stored by Telegram `file_id`, not by uploading the bytes anywhere.
 *
 * Telegram keeps the file indefinitely and file_id is a stable handle, so this
 * needs no extra GitHub permission and leaks no token. The alternative — putting
 * the file URL in the issue — embeds the bot token in the issue body, and
 * committing the image would need Contents: write plus a public repo for it to
 * render at all.
 */
async function handlePhoto(env, chatId, msg) {
  const largest = msg.photo[msg.photo.length - 1];   // sizes ascend
  const caption = (msg.caption ?? "").trim() || "📷 фото без подписи";
  const issue = await gh.create(env, caption, [gh.NOTE],
    `<!-- ${PHOTO_MARK}: ${largest.file_id} -->`);
  await send(env, chatId,
    `📷 <b>#${issue.number}</b> — ${esc(caption)}\n<i>вернуть:</i> <code>/pic ${issue.number}</code>`);
}

export async function handle(env, cmd) {
  switch (cmd.kind) {
    case "empty":
      return null;

    case "help":
      return HELP;

    case "error":
      return `🤔 ${esc(cmd.message)}`;

    case "note": {
      const issue = await gh.create(env, cmd.title, [gh.NOTE]);
      return `📝 <b>#${issue.number}</b> ${esc(cmd.title)}`;
    }

    case "task_new": {
      const issue = await gh.create(env, cmd.title, [gh.NOTE, gh.TASK]);
      return `⚡️ <b>#${issue.number}</b> ${esc(cmd.title)}\n<i>задача</i>`;
    }

    case "promote": {
      const { issue, already } = await gh.promote(env, cmd.number);
      return already
        ? `⚡️ <b>#${issue.number}</b> и так задача`
        : `⚡️ <b>#${issue.number}</b> ${esc(issue.title)}\n<i>теперь задача</i>`;
    }

    case "list": {
      const open = (await gh.listByLabel(env, gh.TASK, "open")).filter((i) => !i.pull_request);
      if (!open.length) return "🎉 Ни одной открытой задачи.";
      const lines = open.map((i) => `⬜️ <b>#${i.number}</b> ${esc(i.title)} · <i>${age(i.created_at)}</i>`);
      return `📋 <b>Задачи</b> · ${open.length}\n\n${lines.join("\n")}`;
    }

    case "notes": {
      const all = (await gh.listByLabel(env, gh.NOTE, "all")).filter((i) => !i.pull_request);
      if (!all.length) return "🗒 Пока пусто.";
      const lines = all.slice(0, 20).map((i) => {
        const isTask = (i.labels ?? []).some((l) => (l.name ?? l) === gh.TASK);
        const cam = (i.body ?? "").includes(PHOTO_MARK) ? "📷 " : "";
        return `${isTask ? "⚡️" : "·"} <b>#${i.number}</b> ${cam}${esc(i.title)} · <i>${age(i.created_at)}</i>`;
      });
      return `🗒 <b>Заметки</b> · последние ${lines.length}\n\n${lines.join("\n")}`;
    }

    case "done": {
      const issue = await gh.close(env, cmd.number);
      return `✅ <b>#${issue.number}</b> ${esc(issue.title)}`;
    }

    case "comment": {
      await gh.comment(env, cmd.number, cmd.body);
      return `💬 дописал к <b>#${cmd.number}</b>`;
    }

    case "pic": {
      const issue = await gh.get(env, cmd.number);
      const found = (issue.body ?? "").match(new RegExp(`<!-- ${PHOTO_MARK}: (\\S+) -->`));
      if (!found) return `🤷 у <b>#${cmd.number}</b> нет фото`;
      return { photo: found[1], caption: `📷 <b>#${issue.number}</b> ${esc(issue.title)}` };
    }

    case "rmpic": {
      const issue = await gh.get(env, cmd.number);
      const body = issue.body ?? "";
      const mark = new RegExp(`\\n*<!-- ${PHOTO_MARK}: \\S+ -->`, "g");
      if (!mark.test(body)) return `🤷 у <b>#${cmd.number}</b> и так нет фото`;
      // Only the reference is dropped. Telegram keeps the file itself and the
      // Bot API cannot delete it, so this un-links rather than erases — worth
      // saying rather than implying the image is gone.
      await gh.setBody(env, cmd.number, body.replace(mark, "").trim());
      return `🗑 картинка снята с <b>#${cmd.number}</b>\n<i>сам файл остаётся у telegram — бот его удалить не может</i>`;
    }

    case "rm": {
      const issue = await gh.get(env, cmd.number);
      if (!cmd.confirmed) {
        // Show what would go before it goes. Cheap, and the alternative is a
        // typo of /rmpic destroying a note with nothing to restore from.
        return `🗑 удалить <b>#${issue.number}</b> ${esc(issue.title)}?\n<i>это навсегда — подтверди:</i> <code>/rm ${issue.number}!</code>`;
      }
      await gh.remove(env, cmd.number);
      return `🗑 <b>#${issue.number}</b> ${esc(issue.title)} — удалено`;
    }

    default:
      return null;
  }
}

/** "3 дня", "2 часа" — a note's age is what shows rot that is otherwise invisible. */
function age(iso) {
  const mins = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 60) return `${mins} мин`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ч`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days} дн` : `${Math.floor(days / 30)} мес`;
}

export async function send(env, chatId, reply) {
  // handle() may return a photo instruction instead of text.
  const isPhoto = typeof reply === "object" && reply.photo;
  const method = isPhoto ? "sendPhoto" : "sendMessage";
  const payload = isPhoto
    ? { chat_id: chatId, photo: reply.photo, caption: reply.caption, parse_mode: "HTML" }
    : { chat_id: chatId, text: reply, parse_mode: "HTML", disable_web_page_preview: true };

  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`telegram ${method} ${res.status}: ${(await res.text()).slice(0, 160)}`);
}

function ok() {
  return new Response("ok", { status: 200 });
}

/** Indistinguishable from a hostname serving nothing. */
function notFound() {
  return new Response("not found", { status: 404 });
}

/**
 * Constant-time string compare.
 *
 * `!==` returns as soon as two bytes differ, so how long the answer takes leaks
 * how much of the secret was guessed. Remotely that signal is buried under
 * network jitter and is not a practical attack here — but the fix is four lines,
 * and a comparison that leaks nothing costs nothing to keep.
 */
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
