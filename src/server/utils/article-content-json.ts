import { generateJSON } from '~/server/utils/tiptap-generate-json';
import { tiptapExtensions } from '~/shared/tiptap/extensions';
import { boundTextStyleMarks } from '~/utils/html-sanitize-helpers';

/** The Tiptap doc an article page renders from its stored HTML. */
export function articleContentJson(content: string) {
  return boundTextStyleMarks(generateJSON(content, tiptapExtensions));
}
