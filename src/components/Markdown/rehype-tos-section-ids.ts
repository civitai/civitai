/**
 * FALLBACK for the ToS's prohibited-content anchor. The id normally lives in the ToS body itself, so
 * an editor can see that something depends on that section; this re-derives it for a document that has
 * lost it — or never had one, like content served from Redis rather than `static-content`.
 *
 * Editing a ToS file changes its content hash, which is what `useToSUpdateModal` compares, so adding
 * the anchor there required an alias in `tosHashOverrideMap` to keep every user's acceptance valid.
 * This plugin needs no such coordination, which is why it is the safety net rather than the mechanism.
 *
 * Both ToS variants number this section 9.6, so one id works on every domain. The lettered clauses
 * inside it do NOT line up (green inserts an adult-content clause at (a) and pushes the rest down),
 * which is why this anchors the section and not a specific bullet.
 */
export const TOS_PROHIBITED_CONTENT_ID = 'tos-prohibited-content';

/** Matches the list item that opens 9.6 — "9.6 **Content Moderation.** …". */
const SECTION_PATTERN = /^\s*9\.6[\s.]/;

/**
 * The sentence introducing the prohibited list, as a fallback. Deliberately short: matched
 * case-insensitively on a fragment rather than the whole sentence, so a punctuation edit does not
 * silently drop the anchor.
 */
const INTRO_FRAGMENT = 'expressly prohibited';

const hasId = (node: any, id: string): boolean =>
  node?.properties?.id === id || (node?.children ?? []).some((c: any) => hasId(c, id));

const textOf = (node: any): string => {
  if (!node) return '';
  if (node.type === 'text') return node.value ?? '';
  const children = node.children;
  return Array.isArray(children) ? children.map(textOf).join('') : '';
};

/**
 * Tags the first element matching 9.6. Returns nothing and changes nothing when the ToS has been
 * renumbered — the modal then opens at the top, which is the correct failure: a missing anchor must
 * never block the accept path. `__tests__/rehype-tos-section-ids.test.ts` is what notices the drift.
 */
export function rehypeTosSectionIds() {
  return (tree: any) => {
    // The document already names the section — leave it alone rather than tagging a second element.
    if (hasId(tree, TOS_PROHIBITED_CONTENT_ID)) return;

    let tagged = false;

    const walk = (node: any) => {
      if (tagged || !node) return;
      if (Array.isArray(node.children)) {
        for (const child of node.children) {
          if (tagged) return;
          if (child.type === 'element' && SECTION_PATTERN.test(textOf(child))) {
            child.properties = { ...child.properties, id: TOS_PROHIBITED_CONTENT_ID };
            tagged = true;
            return;
          }
          walk(child);
        }
      }
    };
    walk(tree);

    if (tagged) return;

    // Fallback: the numbering changed but the list is still introduced the same way.
    const walkIntro = (node: any) => {
      if (tagged || !node) return;
      if (Array.isArray(node.children)) {
        for (const child of node.children) {
          if (tagged) return;
          if (
            child.type === 'element' &&
            textOf(child).toLowerCase().includes(INTRO_FRAGMENT) &&
            textOf(child).length < 400
          ) {
            child.properties = { ...child.properties, id: TOS_PROHIBITED_CONTENT_ID };
            tagged = true;
            return;
          }
          walkIntro(child);
        }
      }
    };
    walkIntro(tree);
  };
}
