import type { Mark } from '@tiptap/core';
import { WITHHELD_HREF_ATTRIBUTE } from '~/shared/constants/withheld-media.constants';

/**
 * The link mark, keeping the ref the article edit form gives a link in place of an href it may not
 * show, so a save can put the stored href back.
 */
export function withWithheldHref<Options>(link: Mark<Options>) {
  return link.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        withheldHref: {
          default: null,
          parseHTML: (element) => element.getAttribute(WITHHELD_HREF_ATTRIBUTE),
          renderHTML: (attributes) =>
            attributes.withheldHref == null
              ? {}
              : { [WITHHELD_HREF_ATTRIBUTE]: attributes.withheldHref },
        },
      };
    },
    parseHTML() {
      return [...(this.parent?.() ?? []), { tag: `a[${WITHHELD_HREF_ATTRIBUTE}]` }];
    },
  });
}
