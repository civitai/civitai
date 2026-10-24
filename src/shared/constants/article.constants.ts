/**
 * The tag carried by exactly the articles with `Article.isOfficial`. The column is the source of
 * truth: `article.service` writes the tag from it and strips it from client input. The row is
 * seeded by SQL (`Tag.type = System`, `adminOnly = true`); the chip row looks it up by this name.
 */
export const OFFICIAL_ARTICLE_TAG = {
  name: 'civitai official',
  label: 'Civitai Official',
} as const;
