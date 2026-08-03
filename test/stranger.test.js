import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../src/index.js";

/**
 * Dedup state lives at module scope, so every test uses ids of its own and the
 * hourly alert budget is shared across this file. Tests stay under it.
 */
const env = { OWNER_CHAT_ID: "1", TELEGRAM_TOKEN: "t", STRANGER_PHOTO: "photo-id" };

/** Collects what would have gone to Telegram. */
function record() {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({
      method: String(url).split("/").pop(),
      body: init?.body ? JSON.parse(init.body) : {},
    });
    return new Response('{"ok":true,"result":{}}', { status: 200 });
  };
  return calls;
}

const start = (id, username) => ({
  message: { chat: { id }, from: { id, username }, text: "/start" },
});

test("a stranger is greeted once, no matter how many times they knock", async () => {
  const calls = record();
  for (let n = 0; n < 9; n++) await dispatch(env, start(9001, "spammer"));

  // One photo out, one alert in. Nine deliveries used to cost eighteen calls.
  assert.equal(calls.length, 2);
  assert.equal(calls.filter((c) => c.method === "sendPhoto").length, 1);
  assert.equal(calls.filter((c) => c.method === "sendMessage").length, 1);
});

test("dedup is per account, so a second visitor still gets through", async () => {
  const calls = record();
  await dispatch(env, start(9002, "first"));
  await dispatch(env, start(9003, "second"));

  assert.equal(calls.filter((c) => c.method === "sendPhoto").length, 2);
  const alerts = calls.filter((c) => c.method === "sendMessage");
  assert.match(alerts[0].body.text, /@first/);
  assert.match(alerts[1].body.text, /@second/);
});

test("a repeat visitor costs zero Telegram calls, not just zero alerts", async () => {
  await dispatch(env, start(9004, "returning"));
  const calls = record();
  await dispatch(env, start(9004, "returning"));

  assert.equal(calls.length, 0);
});

test("anything other than /start is silent even on first contact", async () => {
  const calls = record();
  await dispatch(env, { message: { chat: { id: 9005 }, from: { id: 9005 }, text: "привет" } });

  assert.equal(calls.length, 0);
});

test("with no STRANGER_PHOTO the bot does not confirm it exists", async () => {
  const calls = record();
  await dispatch({ ...env, STRANGER_PHOTO: undefined }, start(9006, "curious"));

  assert.equal(calls.length, 0);
});

test("an account with no username gets no link and the message says why", async () => {
  const calls = record();
  await dispatch(env, {
    message: { chat: { id: 9007 }, from: { id: 9007, first_name: "Alef" }, text: "/start" },
  });

  const alert = calls.find((c) => c.method === "sendMessage").body.text;
  assert.doesNotMatch(alert, /t\.me/);
  assert.match(alert, /юзернейма нет/);
  assert.match(alert, /<code>9007<\/code>/);
});

test("the owner's own messages never reach the stranger path", async () => {
  const calls = record();
  await dispatch(env, {
    message: { chat: { id: Number(env.OWNER_CHAT_ID) }, from: { id: 1 }, text: "/start" },
  });

  // The owner gets the help text, not a photo of themselves.
  assert.equal(calls.filter((c) => c.method === "sendPhoto").length, 0);
});

test("a failed photo still tells the owner someone knocked", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").pop();
    calls.push({ method, body: init?.body ? JSON.parse(init.body) : {} });
    // Exactly what Telegram answers for a chat that does not exist, or one that
    // has blocked the bot.
    if (method === "sendPhoto") {
      return new Response('{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}',
        { status: 400 });
    }
    return new Response('{"ok":true,"result":{}}', { status: 200 });
  };

  await dispatch(env, start(9300, "blocked"));

  const alert = calls.find((c) => c.method === "sendMessage");
  assert.ok(alert, "the owner must be told even though the photo failed");
  assert.match(alert.body.text, /@blocked/);
  assert.match(alert.body.text, /картинку не доставил/);
});

/**
 * Last on purpose. The hourly budget is module state, so exhausting it here
 * would starve any test that ran after this one — which is exactly how the
 * photo-failure test above first failed.
 */
test("a raid of distinct accounts is capped instead of relaying every one", async () => {
  const calls = record();
  for (let n = 0; n < 40; n++) await dispatch(env, start(9100 + n, `raid${n}`));

  const alerts = calls.filter((c) => c.method === "sendMessage").length;
  assert.ok(alerts < 20, `expected the cap to bite, got ${alerts} alerts`);
  assert.ok(alerts > 0, "expected the cap to allow some through");
});
