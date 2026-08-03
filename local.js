/**
 * Long-polling runner. FOR TESTING ONLY.
 *
 * Exists so the bot can be proven end to end before touching Cloudflare. It
 * imports the same `dispatch` the Worker uses, so this is not a second
 * implementation that could drift.
 *
 * Do not leave this as the permanent host. It dies when the machine reboots or
 * the terminal closes, and it dies SILENTLY — the exact failure the Worker
 * exists to avoid. Testing here is fine; living here is not.
 *
 *   npm run check    verify config, start nothing
 *   npm run local    listen
 *
 * Config comes from .dev.vars via node --env-file-if-exists, so no shell syntax
 * is involved and no secret lands in shell history. The same file is read by
 * `wrangler dev`.
 */

import { existsSync } from "node:fs";
import { dispatch } from "./src/index.js";

const GH = "https://api.github.com";

/**
 * Non-destructive write probe.
 *
 * POST /issues with an empty body: GitHub checks the token's permission BEFORE
 * validating the payload, so 403 means no write access while 422 means write
 * access with an invalid body — and nothing is created either way. Verified
 * against a read-only and a writable repo.
 *
 * The obvious check, `repo.permissions.push`, is WRONG and silently so: it
 * reports the authenticated user's role on the repository, not what the token
 * was granted. A read-only fine-grained PAT on your own repo returns push=true.
 */
async function canWriteIssues(repo, pat) {
  const res = await fetch(`${GH}/repos/${repo}/issues`, {
    method: "POST",
    headers: { authorization: `Bearer ${pat}`, "user-agent": "jot",
               accept: "application/vnd.github+json", "content-type": "application/json" },
    body: "{}",
  });
  if (res.status === 422) return true;   // permitted, payload rejected
  if (res.status === 403) return false;  // not permitted
  throw new Error(`неожиданный ответ пробы записи: ${res.status}`);
}

// Startup checks return a message rather than calling process.exit, because
// exiting with a fetch in flight trips a libuv assertion on Windows and buries
// the real error under a stack trace.
async function preflight() {
  if (!existsSync(new URL(".dev.vars", import.meta.url))) {
    return "нет файла .dev.vars\n\n  cp .dev.vars.example .dev.vars\n" +
           "  затем впиши TELEGRAM_TOKEN, GH_PAT, TASK_REPO, OWNER_CHAT_ID";
  }

  const env = {};
  for (const name of ["TELEGRAM_TOKEN", "GH_PAT", "TASK_REPO", "OWNER_CHAT_ID"]) {
    const v = (process.env[name] ?? "").trim();
    if (!v) return `в .dev.vars не заполнено: ${name}`;
    env[name] = v;
  }

  const api = `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}`;

  // A registered webhook and getUpdates are mutually exclusive, so clear it.
  // Keeps local.js runnable even after the Worker has been deployed.
  const del = await fetch(`${api}/deleteWebhook`);
  if (!del.ok) return `Telegram отклонил токен: ${del.status}. Проверь TELEGRAM_TOKEN.`;

  const probe = await fetch(`${GH}/repos/${env.TASK_REPO}`, {
    headers: { authorization: `Bearer ${env.GH_PAT}`, "user-agent": "jot" },
  });
  if (probe.status === 404) {
    return `GitHub 404 на ${env.TASK_REPO}.\n\n` +
           `Для приватного репозитория 404 при валидном токене означает НЕТ ПРАВ, ` +
           `а не «не существует» — GitHub не различает их специально.\n` +
           `У PAT: Repository access -> Only select repositories -> ` +
           `${env.TASK_REPO.split("/")[1]}`;
  }
  if (!probe.ok) return `GitHub ${probe.status} на ${env.TASK_REPO}`;
  const repo = await probe.json();

  // Reading is not writing, and writing is the whole point. Check it for real.
  if (!(await canWriteIssues(env.TASK_REPO, env.GH_PAT))) {
    return `у PAT есть чтение ${env.TASK_REPO}, но НЕТ ЗАПИСИ issues.\n\n` +
           `Permissions -> Repository permissions -> Issues -> Read and write\n` +
           `(сейчас стоит Read-only), затем кнопка Update token внизу страницы.`;
  }

  return { env, repo, api };
}

const CHECK_ONLY = process.argv.includes("--check");
const result = await preflight();

if (typeof result === "string") {
  console.error(result);
  process.exitCode = 1;
} else if (CHECK_ONLY) {
  const { env, repo } = result;
  console.log("OK");
  console.log(`  репо      ${repo.full_name} (${repo.private ? "приватный" : "ПУБЛИЧНЫЙ"})`);
  console.log(`  запись    да (проверено пробой, ничего не создано)`);
  console.log(`  владелец  ${env.OWNER_CHAT_ID}`);
  console.log("\nвсё готово -> npm run local");
} else {
  const { env, repo, api } = result;
  console.log(`репо: ${repo.full_name} (${repo.private ? "приватный" : "ПУБЛИЧНЫЙ — задачи будут видны всем"})`);
  console.log(`владелец: ${env.OWNER_CHAT_ID}`);
  console.log("слушаю. ctrl-c чтобы остановить.\n");

  let offset = 0;
  for (;;) {
    try {
      const res = await fetch(`${api}/getUpdates?timeout=25&offset=${offset}`);
      const body = await res.json();
      if (!body.ok) throw new Error(JSON.stringify(body));
      for (const update of body.result) {
        offset = update.update_id + 1;
        const text = (update.message ?? update.edited_message)?.text;
        console.log(`<- ${JSON.stringify(text)}`);
        await dispatch(env, update);
      }
    } catch (err) {
      console.error("ошибка опроса:", err.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
