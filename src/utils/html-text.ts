/**
 * Vikunja rich text → plain text.
 *
 * Vikunja stores descriptions and comments as HTML. This renders them as
 * compact plain text for display, and is also how a write can tell "Vikunja
 * normalised my markup" (same text, different tags) from "Vikunja dropped my
 * content" (different text).
 *
 * It is deliberately LOSSY and one-way: anchors collapse to `text (url)`, list
 * items to `- `, entities are decoded. Never write its output back to a task —
 * that stores the stripped form. `vikunja_task_crud get` with `raw: true` is
 * the round-trippable read.
 */

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

/**
 * Convert Vikunja's HTML rich text to compact plain text.
 * Unwraps anchors (keeping the URL, and link text only when it differs),
 * turns block/list markup into newlines/bullets, strips remaining tags,
 * decodes common entities, and drops zero-width artifacts.
 */
export function htmlToPlainText(html: string): string {
  return html
    // Anchors → "text (url)", or just "url" when text is empty/equal
    .replace(/<a\b[^>]*?href="([^"]*)"[^>]*>(.*?)<\/a>/gi, (_m, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, '').trim();
      return !label || label === href ? href : `${label} (${href})`;
    })
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|h[1-6]|ul|ol|li|tr|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;|&lt;|&gt;|&quot;|&#39;|&nbsp;/g, (m) => ENTITIES[m] ?? m)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}
