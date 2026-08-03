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
