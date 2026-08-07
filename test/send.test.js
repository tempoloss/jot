import { test } from "node:test";
import assert from "node:assert/strict";
import { chunk, esc, TG_LIMIT } from "../src/html.js";
import { dispatch } from "../src/index.js";

const env = { OWNER_CHAT_ID: "1", TELEGRAM_TOKEN: "t", TASK_REPO: "o/r", GH_PAT: "p" };

/**
 * Telegram is the only party that enforces the length, so the fake has to
 * enforce it too. A stub that answers 200 to everything would have passed
 * before the fix and proved nothing.
 */
function record() {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").pop();
    const body = init?.body ? JSON.parse(init.body) : {};
    calls.push({ method, body });
    if (method === "sendMessage" && body.text.length > TG_LIMIT) {
      return new Response(
        '{"ok":false,"error_code":400,"description":"Bad Request: message is too long"}',
        { status: 400 });
    }
    return new Response(JSON.stringify({ ok: true, number: 7, title: body.title ?? "", result: {} }),
      { status: 200 });
  };
  return calls;
}

const note = (text) => ({ message: { chat: { id: 1 }, from: { id: 1 }, text } });

test("a note past the Telegram limit is confirmed, not answered with an error", async () => {
  const calls = record();
  await dispatch(env, note("э".repeat(9000)));

  const sent = calls.filter((c) => c.method === "sendMessage");
  assert.ok(sent.length, "the owner must be told the note landed");
  for (const c of sent) assert.ok(c.body.text.length <= TG_LIMIT, `${c.body.text.length} chars`);
  assert.doesNotMatch(sent[0].body.text, /message is too long/);
  assert.match(sent[0].body.text, /#7/);
});

test("the echo confirms the note without replaying it", async () => {
  const calls = record();
  await dispatch(env, note("э".repeat(9000)));

  // The issue title is what GitHub actually stored. Echoing the typed text back
  // says nothing the sender does not already have.
  const sent = calls.filter((c) => c.method === "sendMessage");
  assert.equal(sent.length, 1);
  assert.ok(sent[0].body.text.length < 300, `echo was ${sent[0].body.text.length} chars`);
});

test("a reply that genuinely is long arrives in pieces", () => {
  const parts = chunk(Array.from({ length: 400 }, (_, i) => `⬜️ <b>#${i}</b> задача`).join("\n"));
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= TG_LIMIT);
  assert.equal(parts.join("\n").split("\n").length, 400);
});

test("a piece never ends inside a tag or an entity", () => {
  const line = `<b>${esc("<&>".repeat(3000))}</b>`;
  for (const p of chunk(line)) {
    assert.ok(p.length <= TG_LIMIT);
    // An unterminated `<` or `&` is what Telegram rejects as unparsable.
    assert.doesNotMatch(p, /<[^>]*$/);
    assert.doesNotMatch(p, /&[^;]*$/);
  }
});

test("text that fits is sent unchanged", () => {
  assert.deepEqual(chunk("📝 <b>#7</b> купить зарядку"), ["📝 <b>#7</b> купить зарядку"]);
});
