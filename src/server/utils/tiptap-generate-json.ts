import type { Extensions } from '@tiptap/core';
import { getSchema } from '@tiptap/core';
import type { ParseOptions } from '@tiptap/pm/model';
import { DOMParser as PMDOMParser } from '@tiptap/pm/model';
import type { IOptionalBrowserSettings } from 'happy-dom';
import { Window } from 'happy-dom';

// `generateJSON` from `@tiptap/html/server`, parsing in a window that loads nothing. Server-side
// parse must not fetch remote resources: a default happy-dom window starts loading every
// `<iframe src>` and stylesheet `<link>`, and tiptap's `close()` cancels them only after connecting.
const settings = {
  disableIframePageLoading: true,
  disableCSSFileLoading: true,
  disableJavaScriptFileLoading: true,
  disableJavaScriptEvaluation: true,
  disableComputedStyleRendering: true,
  navigation: {
    disableMainFrameNavigation: true,
    disableChildFrameNavigation: true,
    disableChildPageNavigation: true,
  },
  fetch: {
    // Answers any request a flag above misses before it reaches the network.
    interceptor: {
      beforeAsyncRequest: async ({ window }) => new window.Response(null, { status: 204 }),
    },
  },
} satisfies IOptionalBrowserSettings;

export function createParserWindow() {
  return new Window({ settings });
}

export function generateJSON(
  html: string,
  extensions: Extensions,
  options?: ParseOptions
): Record<string, any> {
  const localWindow = createParserWindow();
  try {
    const schema = getSchema(extensions);
    const doc = new localWindow.DOMParser().parseFromString(
      `<!DOCTYPE html><html><body>${html}</body></html>`,
      'text/html'
    );
    if (!doc) throw new Error('Failed to parse HTML string');
    return PMDOMParser.fromSchema(schema)
      .parse(doc.body as unknown as globalThis.Node, options)
      .toJSON();
  } finally {
    localWindow.happyDOM.abort();
    localWindow.happyDOM.close();
  }
}
