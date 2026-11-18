import { minorMatureImageVisibleSql } from '~/server/common/image-visibility';

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const anyParam = (escaped: string, replacement: string) =>
  escaped.replace(/\\\$\d+/g, () => replacement);

/**
 * Finds `minorMatureImageVisibleSql`'s clause in a statement's text. Built from the helper's own SQL,
 * so a rewrite of the helper moves the pattern with it. Group 1 is the parameter number of the owner
 * carve-out, when the clause has one.
 */
export function restrictedMinorClause(flags = '') {
  const plain = minorMatureImageVisibleSql({}).text;
  const owned = minorMatureImageVisibleSql({ userId: 1 }).text;
  const body = anyParam(escapeRegExp(plain.slice(0, -1)), '\\$\\d+');
  const carveOut = anyParam(escapeRegExp(owned.slice(plain.length - 1, -1)), '\\$(\\d+)');
  return new RegExp(`${body}(?:${carveOut})?\\)`, flags);
}
