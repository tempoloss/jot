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
};

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
 * Everyone who is not the owner.
 *
 * Silent by default: with no STRANGER_PHOTO configured the bot does not confirm
 * it exists, which is the stronger position. Setting the photo trades that away
 * for personality — a deliberate choice, since nobody is attacking a personal
 * note bot and the realistic visitor is a curious friend.
 *
 * It answers only /start, i.e. a first contact. Replying to every message would
 * double the request cost of anyone spamming the bot, and the free Workers quota
 * is the only thing an outsider can actually exhaust here.
 */
async function greetStranger(env, chatId, msg) {
  if (!env.STRANGER_PHOTO || !chatId) return;
  if (msg?.text !== "/start") return;

  await send(env, chatId, { photo: env.STRANGER_PHOTO });

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
  const from = msg.from ?? {};
  const id = from.id ?? chatId;
  const name = esc([from.first_name, from.last_name].filter(Boolean).join(" "));
  const who = from.username
    ? `<a href="https://t.me/${esc(from.username)}">@${esc(from.username)}</a>`
    : (name || "без имени");
  await send(env, env.OWNER_CHAT_ID,
    `👀 <b>${who}</b> постучался в бота\n` +
    `<i>id</i> <code>${id}</code>${from.username ? "" : " <i>— юзернейма нет, ссылку не сделать</i>"}`);
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

/** HTML parse mode needs exactly these three escaped, per Telegram's docs. */
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
