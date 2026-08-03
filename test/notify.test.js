import { test } from "node:test";
import assert from "node:assert/strict";
import * as notify from "../src/notify.js";
import { esc } from "../src/html.js";

const thread = (over = {}) => ({
  id: "1001",
  reason: "mention",
  repository: { full_name: "duckdb/community-extensions" },
  subject: {
    title: "FAISS community extension missing for DuckDB 1.5.4/1.5.5",
    url: "https://api.github.com/repos/duckdb/community-extensions/issues/2412",
    latest_comment_url: "https://api.github.com/repos/duckdb/community-extensions/issues/comments/5169620315",
    type: "Issue",
  },
  unread: true,
  ...over,
});

const comment = (over = {}) => ({
  user: { login: "JAicewizard" },
  body: "If you could bisect this, it would be great.",
  html_url: "https://github.com/duckdb/community-extensions/issues/2412#issuecomment-5169620315",
  ...over,
});

test("watch noise is dropped and participation is kept", () => {
  assert.equal(notify.isWanted(thread({ reason: "mention" })), true);
  assert.equal(notify.isWanted(thread({ reason: "author" })), true);
  assert.equal(notify.isWanted(thread({ reason: "review_requested" })), true);

  // Watching a repo would otherwise deliver every issue anyone opens.
  assert.equal(notify.isWanted(thread({ reason: "subscribed" })), false);
  // Every workflow run is a stream, not a signal, during active work.
  assert.equal(notify.isWanted(thread({ reason: "ci_activity" })), false);
});

test("the owner's own comment is not news to the owner", () => {
  assert.equal(notify.isOwnEcho(comment({ user: { login: "tempoloss" } }), "tempoloss"), true);
  // GitHub's login comparison is case-insensitive, so this one has to be too.
  assert.equal(notify.isOwnEcho(comment({ user: { login: "TempoLoss" } }), "tempoloss"), true);
  assert.equal(notify.isOwnEcho(comment(), "tempoloss"), false);
});

test("a thread with no comment is still deliverable", () => {
  // A review request carries no comment. Treating that as an echo would silence
  // exactly the notification that most needs answering.
  assert.equal(notify.isOwnEcho(null, "tempoloss"), false);
});

test("the link lands on the comment when there is one", () => {
  assert.equal(
    notify.webUrl(thread(), comment()),
    "https://github.com/duckdb/community-extensions/issues/2412#issuecomment-5169620315",
  );
});

test("a pull request url is rewritten to the form the web UI serves", () => {
  const pr = thread({
    subject: {
      title: "faiss: exclude windows",
      url: "https://api.github.com/repos/duckdb/community-extensions/pulls/2431",
      latest_comment_url: null,
      type: "PullRequest",
    },
  });
  // `pulls` is an API-only spelling. Left alone it produces a 404 link.
  assert.equal(notify.webUrl(pr, null), "https://github.com/duckdb/community-extensions/pull/2431");
});

test("the reference number comes from the subject url", () => {
  assert.equal(notify.ref(thread()), "#2412");
  assert.equal(notify.ref(thread({ subject: { url: "https://api.github.com/repos/a/b/commits/abc" } })), "");
});

test("a message names who, where and what, and carries the link", () => {
  const text = notify.format(thread(), comment(), esc, "tempoloss");

  assert.match(text, /JAicewizard/);
  assert.match(text, /ответил/);
  assert.match(text, /duckdb\/community-extensions#2412/);
  assert.match(text, /issuecomment-5169620315/);
  assert.match(text, /bisect/);
});

test("a review request says so instead of claiming someone replied", () => {
  const text = notify.format(thread({ reason: "review_requested" }), null, esc, "tempoloss");

  assert.match(text, /просит ревью/);
  assert.doesNotMatch(text, /ответил/);
});

test("html in a title or body cannot break the message", () => {
  const text = notify.format(
    thread({ subject: { ...thread().subject, title: "<b>fix</b> & <script>" } }),
    comment({ body: "compare a < b && c > d" }),
    esc,
    "tempoloss",
  );

  // Telegram would reject or mangle the raw forms; only the escaped ones appear.
  assert.match(text, /&lt;b&gt;fix&lt;\/b&gt; &amp; &lt;script&gt;/);
  assert.match(text, /a &lt; b &amp;&amp; c &gt; d/);
});

test("quoted lines are stripped because they are what he already read", () => {
  const text = notify.format(
    thread(),
    comment({ body: "> your earlier point\n> second quoted line\nActually yes, agreed." }),
    esc,
    "tempoloss",
  );

  assert.match(text, /Actually yes, agreed\./);
  assert.doesNotMatch(text, /second quoted line/);
});

test("a wall of text is trimmed so the link stays visible", () => {
  const text = notify.format(thread(), comment({ body: "x".repeat(2000) }), esc, "tempoloss");

  assert.ok(text.length < 700, `expected a trimmed message, got ${text.length} chars`);
  assert.match(text, /…/);
});

test("a comment that is only quoted text produces no body block", () => {
  const text = notify.format(thread(), comment({ body: "> nothing but a quote" }), esc, "tempoloss");

  assert.doesNotMatch(text, /<pre>/);
});

test("an unchanged poll is reported as unchanged rather than as empty news", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 304 });
  try {
    const r = await notify.fetchThreads({ GH_NOTIFY_TOKEN: "t" }, 'W/"abc"');
    assert.equal(r.unchanged, true);
    // The etag has to survive a 304 or the next poll loses the optimisation.
    assert.equal(r.etag, 'W/"abc"');
    assert.deepEqual(r.threads, []);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a failed poll raises instead of looking like an empty inbox", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("bad credentials", { status: 401 });
  try {
    await assert.rejects(
      () => notify.fetchThreads({ GH_NOTIFY_TOKEN: "t" }, null),
      /notifications 401/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a sticky mention reason does not claim a tag that is not in the body", () => {
  // GitHub keeps reason=mention for every later reply in a thread you were once
  // tagged in, so the reason alone would lie on the second and third reply.
  const plain = notify.format(thread({ reason: "mention" }), comment(), esc, "tempoloss");
  assert.match(plain, /ответил/);
  assert.doesNotMatch(plain, /упомянул/);

  const tagged = notify.format(
    thread({ reason: "mention" }),
    comment({ body: "@tempoloss could you bisect this" }),
    esc,
    "tempoloss",
  );
  assert.match(tagged, /упомянул тебя/);
});
