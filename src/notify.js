/**
 * GitHub notifications, pushed to Telegram.
 *
 * The problem this solves: maintainer replies were being missed for hours
 * because GitHub is a place you have to remember to visit. Telegram is not.
 *
 * Two decisions worth knowing before reading:
 *
 * GitHub is the dedup store. The list is fetched unread-only and each thread is
 * marked read after delivery, so nothing has to be remembered on this side. No
 * KV, no second copy of the truth, and dedup is exact rather than best-effort.
 * The order is deliberate: deliver first, mark second. Marking first and then
 * failing to send would lose the notification permanently, which is the same
 * rule shipwatch is built around.
 *
 * The token has to be a classic PAT. GitHub's notification endpoints do not
 * accept fine-grained tokens at all, which the REST docs state outright. The
 * `notifications` scope alone is enough and grants nothing else, so this is not
 * the blanket `repo` token that was rejected earlier. Comment bodies are read
 * with the existing fine-grained GH_PAT, which reaches public repositories.
 */

const API = "https://api.github.com";

/** GitHub asks for one poll a minute via X-Poll-Interval and means it. */
export const POLL_FLOOR_MS = 60_000;

/**
 * Reasons worth a phone buzz. `subscribed` is watch noise and `ci_activity` is
 * every workflow run, which during active work is a stream rather than a signal.
 */
const WANTED = new Set([
  "mention",
  "team_mention",
  "review_requested",
  "assign",
  "author",
  "comment",
  "approval_requested",
]);

function headers(token) {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "jot",
    "x-github-api-version": "2022-11-28",
  };
}

/**
 * Unread, participating-only threads.
 *
 * `participating=true` drops everything the user is merely watching, on GitHub's
 * side, so the filtering that matters costs nothing here. An etag turns an
 * unchanged poll into a 304, which per the docs does not consume rate limit.
 */
export async function fetchThreads(env, etag) {
  const h = headers(env.GH_NOTIFY_TOKEN);
  if (etag) h["if-none-match"] = etag;

  const res = await fetch(`${API}/notifications?participating=true&per_page=20`, { headers: h });
  if (res.status === 304) return { threads: [], etag, unchanged: true };
  if (!res.ok) {
    throw new Error(`notifications ${res.status}: ${(await res.text()).slice(0, 160)}`);
  }
  return { threads: await res.json(), etag: res.headers.get("etag"), unchanged: false };
}

/**
 * A thread the owner's own activity produced is not news to the owner.
 *
 * `reason` alone cannot decide this: commenting on your own issue leaves the
 * reason as `author`, which is exactly the reason a maintainer's reply also
 * carries. The author of the latest comment is what separates them.
 */
export function isOwnEcho(comment, login) {
  if (!comment || !login) return false;
  return String(comment.user?.login ?? "").toLowerCase() === String(login).toLowerCase();
}

export function isWanted(thread) {
  return WANTED.has(thread.reason);
}

/**
 * The comment that caused the notification, or null.
 *
 * Null is normal rather than an error: a review request or a state change has no
 * comment, and a private repository outside the fine-grained token's scope will
 * refuse. Both cases still deserve a message, just without the excerpt.
 */
export async function fetchComment(env, thread) {
  const url = thread.subject?.latest_comment_url;
  if (!url || !env.GH_PAT) return null;
  try {
    const res = await fetch(url, { headers: headers(env.GH_PAT) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Turns an API url into the one a human can open.
 *
 * The comment's own html_url lands on the comment. Without a comment the subject
 * url has to be rewritten, and `pulls` is `pull` in the web UI, which is the
 * kind of detail that silently produces a 404 link.
 */
export function webUrl(thread, comment) {
  if (comment?.html_url) return comment.html_url;
  const api = thread.subject?.url ?? "";
  return api
    .replace(`${API}/repos/`, "https://github.com/")
    .replace("/pulls/", "/pull/");
}

/** `.../issues/2412` -> `#2412`. Empty for a thread that is not numbered. */
export function ref(thread) {
  const m = String(thread.subject?.url ?? "").match(/\/(\d+)$/);
  return m ? `#${m[1]}` : "";
}

/** Reasons that have no comment attached, so the reason itself is the news. */
const VERB = {
  review_requested: "просит ревью",
  assign: "назначил тебя",
  team_mention: "упомянул твою команду",
  approval_requested: "просит подтвердить деплой",
};

/**
 * `reason` cannot be trusted to describe the latest comment.
 *
 * Per GitHub's docs the reason is sticky: once a thread has been a `mention` it
 * stays `mention` for every later notification whether or not you were mentioned
 * again. So a second and third reply would both claim you were tagged. The body
 * is the only thing that actually knows, and it is already fetched.
 */
function verbFor(thread, comment, login) {
  if (!comment) return VERB[thread.reason] ?? "изменение";
  const tagged = login && new RegExp(`@${login}\\b`, "i").test(comment.body ?? "");
  return tagged ? "упомянул тебя" : "ответил";
}

/**
 * One message per thread. Body excerpt is trimmed because a long maintainer
 * comment should be readable in a notification without opening it, but a wall of
 * quoted log output should not push the link off screen.
 */
export function format(thread, comment, esc, login) {
  const who = comment?.user?.login ?? "";
  const verb = verbFor(thread, comment, login);
  const where = `${thread.repository?.full_name ?? "?"}${ref(thread)}`;
  const url = webUrl(thread, comment);

  const head = who
    ? `<b>${esc(who)}</b> ${verb} в <a href="${url}">${esc(where)}</a>`
    : `<a href="${url}">${esc(where)}</a> · ${verb}`;

  const lines = [head, `<i>${esc(thread.subject?.title ?? "")}</i>`];

  const body = (comment?.body ?? "")
    .replace(/\r/g, "")
    .split("\n")
    .filter((l) => !l.startsWith(">"))   // quoted text is what he already read
    .join("\n")
    .trim();
  if (body) {
    const cut = body.length > 400 ? `${body.slice(0, 400).trimEnd()}…` : body;
    lines.push("", `<pre>${esc(cut)}</pre>`);
  }
  return lines.join("\n");
}

/**
 * Marking read is what keeps the next poll from resending, so a failure here
 * means a duplicate rather than a loss. That is the right way round.
 */
export async function markRead(env, threadId) {
  const res = await fetch(`${API}/notifications/threads/${threadId}`, {
    method: "PATCH",
    headers: headers(env.GH_NOTIFY_TOKEN),
  });
  if (!res.ok && res.status !== 205) {
    throw new Error(`mark read ${threadId}: ${res.status}`);
  }
}
