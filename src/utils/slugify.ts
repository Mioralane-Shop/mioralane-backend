/**
 * Converts a string into a URL-friendly slug.
 * Example: "Vitamin C Serum" -> "vitamin-c-serum"
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
