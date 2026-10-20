import { dbWrite } from '~/server/db/client';

/**
 * Of these tag names, the ones no Tag row has yet: the only ones a write would create.
 *
 * Writers scan these and nothing else. Attaching an EXISTING tag is not new text, and scanning it
 * would leave every post or model carrying a stored tag that now trips a list unsavable. Absence
 * from the table is the test, not a missing id: a tag sent by name alone can still be one that
 * exists. Read from the primary, so a tag created a moment ago counts as existing.
 */
export async function newTagNames(names: Array<string | null | undefined> | null | undefined) {
  const wanted = [
    ...new Set(
      (names ?? [])
        .filter((name): name is string => typeof name === 'string')
        .map((name) => name.toLowerCase().trim())
        .filter(Boolean)
    ),
  ];
  if (!wanted.length) return [];

  const existing = await dbWrite.tag.findMany({
    where: { name: { in: wanted } },
    select: { name: true },
  });
  const stored = new Set(existing.map((tag) => tag.name.toLowerCase()));
  return wanted.filter((name) => !stored.has(name));
}
