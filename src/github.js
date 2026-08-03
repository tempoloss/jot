/**
 * GitHub Issues as the store. Issues are the source of truth; nothing here
 * caches, so there is no second copy to fall out of sync with.
 *
 * Labels carry the note/task distinction: `note` is captured, `task` is
 * triaged. A note is never closed — it is a record, not an obligation.
 */

const API = "https://api.github.com";

export const NOTE = "note";
export const TASK = "task";

async function call(env, path, init = {}) {
  const res = await fetch(`${API}/repos/${env.TASK_REPO}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.GH_PAT}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "jot",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    // Surface the real reason. A silent failure means a note the user believes
    // is saved does not exist.
    throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

/** Telegram has no title/body split, so the line is the title; long ones spill. */
function split(text) {
  const short = text.length > 120 ? text.slice(0, 117) + "..." : text;
  return { title: short, body: text.length > 120 ? text : undefined };
}

export async function create(env, text, labels, extraBody) {
  const { title, body } = split(text);
  const parts = [body, extraBody].filter(Boolean);
  return call(env, "/issues", {
    method: "POST",
    body: JSON.stringify({ title, body: parts.join("\n\n") || undefined, labels }),
  });
}

export async function get(env, number) {
  // A single issue GET is immediately consistent, unlike the list endpoint.
  return call(env, `/issues/${number}`);
}

export async function listByLabel(env, label, state) {
  return call(env, `/issues?labels=${label}&state=${state}&per_page=50&sort=created&direction=desc`);
}

export async function close(env, number) {
  return call(env, `/issues/${number}`, {
    method: "PATCH",
    body: JSON.stringify({ state: "closed" }),
  });
}

/** Promote a note to a task: add the label, keep everything else. */
export async function promote(env, number) {
  const issue = await get(env, number);
  const labels = new Set((issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)));
  if (labels.has(TASK)) return { issue, already: true };
  labels.add(TASK);
  const updated = await call(env, `/issues/${number}`, {
    method: "PATCH",
    body: JSON.stringify({ labels: [...labels] }),
  });
  return { issue: updated, already: false };
}

export async function comment(env, number, body) {
  return call(env, `/issues/${number}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

/** Replace an issue body. Used to strip a photo reference out of a note. */
export async function setBody(env, number, body) {
  return call(env, `/issues/${number}`, {
    method: "PATCH",
    body: JSON.stringify({ body }),
  });
}
