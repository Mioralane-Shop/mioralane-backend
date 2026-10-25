/**
 * Converts a string into a URL-friendly slug.
 * Example: "Vitamin C Serum" -> "vitamin-c-serum"
 *
 * Unicode letters are preserved, not just ASCII. Bangla titles (a Bengali
 * storefront) have no `\w` characters, so the old ASCII-only rule produced an
 * empty slug. `\p{M}` keeps Bangla vowel signs, which are combining marks.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\p{M}\u200c\u200d]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}
