/**
 * Pure command parsing. No network, no Worker globals — testable with plain
 * `node --test` and no framework.
 *
 * The central decision: plain text becomes a NOTE, not a task.
 *
 * If text became a task and notes needed a command, then at capture time you
 * would have to decide "is this a thing to do, or a thing to remember?" That is
 * a decision, and a decision at capture time is friction — the exact thing this
 * bot exists to remove. So capture is unconditional, and triage is a separate,
 * deliberate act: /task N promotes a note once you have decided it is actionable.
 */

/** @returns {{kind: string, [k: string]: any}} */
export function parse(text) {
  const raw = (text ?? "").trim();
  if (!raw) return { kind: "empty" };

  // Telegram appends @botname to commands in groups.
  const m = raw.match(/^\/([a-z]+)(?:@\w+)?\s*([\s\S]*)$/i);
  if (!m) return { kind: "note", title: raw };

  const cmd = m[1].toLowerCase();
  const rest = m[2].trim();

  switch (cmd) {
    case "start":
    case "help":
      return { kind: "help" };

    case "list":
      return { kind: "list" };

    case "notes":
      return { kind: "notes" };

    case "t":
      // Escape hatch for when you already know it is a task.
      return rest ? { kind: "task_new", title: rest }
                  : { kind: "error", message: "Пустая задача" };

    case "task": {
      const n = num(rest);
      return n === null
        ? { kind: "error", message: "Нужен номер: /task 5" }
        : { kind: "promote", number: n };
    }

    case "done": {
      const n = num(rest);
      return n === null
        ? { kind: "error", message: "Нужен номер: /done 3" }
        : { kind: "done", number: n };
    }

    case "pic": {
      const n = num(rest);
      return n === null
        ? { kind: "error", message: "Нужен номер: /pic 5" }
        : { kind: "pic", number: n };
    }

    case "rmpic": {
      const n = num(rest);
      return n === null
        ? { kind: "error", message: "Нужен номер: /rmpic 5" }
        : { kind: "rmpic", number: n };
    }

    case "c": {
      const sp = rest.indexOf(" ");
      if (sp < 0) return { kind: "error", message: "Нужен номер и текст: /c 3 текст" };
      const n = num(rest.slice(0, sp));
      const body = rest.slice(sp + 1).trim();
      if (n === null) return { kind: "error", message: "Нужен номер: /c 3 текст" };
      if (!body) return { kind: "error", message: "Пустой комментарий" };
      return { kind: "comment", number: n, body };
    }

    default:
      // An unknown slash command is far more likely a typo than a note called
      // "/lsit". Saving it silently would be worse than saying so.
      return { kind: "error", message: `Не знаю /${cmd} — посмотри /help` };
  }
}

function num(s) {
  const t = s.trim().replace(/^#/, "");
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export const HELP = [
  "🗂 <b>Как это работает</b>",
  "",
  "Пишешь что угодно — это <b>заметка</b>. Решать, дело это или мысль, не надо:",
  "сначала ловим, потом сортируем.",
  "",
  "📝 <code>любой текст</code> — заметка",
  "📷 <code>фото</code> — заметка с картинкой, вернуть: <code>/pic 5</code>",
  "🗑 <code>/rmpic 5</code> — убрать картинку из заметки",
  "",
  "⚡️ <code>/task 5</code> — повысить заметку до задачи",
  "⚡️ <code>/t текст</code> — сразу задача",
  "",
  "📋 <code>/list</code> — открытые задачи",
  "🗒 <code>/notes</code> — последние заметки",
  "✅ <code>/done 3</code> — закрыть",
  "💬 <code>/c 3 текст</code> — комментарий",
].join("\n");
