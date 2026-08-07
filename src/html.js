/**
 * Telegram's HTML parse mode needs exactly these three escaped, per its docs.
 *
 * Shared rather than duplicated because both the command replies and the GitHub
 * notifications render untrusted text: an issue title or a comment body can
 * contain `<` and would otherwise break the message or, worse, be swallowed.
 */
export function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Telegram rejects a longer message outright, before parsing it. */
export const TG_LIMIT = 4096;

/**
 * Break text into messages Telegram will accept.
 *
 * Splits on newlines: every tag this bot emits opens and closes on one line.
 * The one exception is the `<pre>` block in a notification, trimmed to 400
 * characters upstream, so it never reaches the limit and never gets cut.
 */
export function chunk(text, limit = TG_LIMIT) {
  const out = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push(buf);
    buf = "";
  };

  for (const line of String(text).split("\n")) {
    let rest = line;
    while (rest.length > limit) {
      flush();
      const at = safeCut(rest, limit);
      out.push(rest.slice(0, at));
      rest = rest.slice(at);
    }
    if (buf && buf.length + 1 + rest.length > limit) flush();
    buf = buf ? `${buf}\n${rest}` : rest;
  }
  flush();

  return out.length ? out : [String(text)];
}

/**
 * A cut inside `<b>` or `&amp;` produces a fragment Telegram cannot parse, and
 * it answers 400 for that too - same failure, different message.
 */
function safeCut(s, limit) {
  let end = limit;
  // Two passes, because pulling the cut back off an entity can drop it inside a
  // tag that the first pass had already cleared.
  for (let again = true; again; ) {
    again = false;
    for (const [open, close] of [["<", ">"], ["&", ";"]]) {
      const start = s.lastIndexOf(open, end - 1);
      if (start === -1) continue;
      const shut = s.indexOf(close, start);
      if (shut === -1 || shut >= end) {
        end = start;
        again = true;
      }
    }
  }
  return end > 0 ? end : limit;
}
