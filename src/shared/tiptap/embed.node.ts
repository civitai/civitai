import { Node } from '@tiptap/core';
import type { EmbedProvider } from '~/shared/utils/embed-providers';
import {
  EMBED_HEIGHTS,
  embedRenderAttrs,
  embedRenderSrc,
  isAllowedPlayerUrl,
} from '~/shared/utils/embed-providers';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    embed: {
      /** Insert a third-party player. `src` must already be a player URL (see parseEmbedUrl). */
      setEmbed: (options: { src: string }) => ReturnType;
    };
  }
}

/**
 * Player iframe for the providers in embed-providers (Bandcamp, SoundCloud, Spotify, Vimeo,
 * Twitch, Hugging Face Spaces). Stored as `<div data-type="embed" data-provider><iframe>`. The
 * provider is always re-derived from `src`, never trusted from the attribute, and a src that is
 * not an allowed player URL renders no iframe at all.
 *
 * Must stay registered in all three extension lists (shared `tiptapExtensions`, RenderRichText,
 * the editor): article contentJson is built from the shared list, and a node missing from it is
 * dropped without an error.
 */
export const EmbedNode = Node.create({
  name: 'embed',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      src: {
        default: null,
        parseHTML: (element) => element.querySelector('iframe')?.getAttribute('src') ?? null,
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="embed"]' }];
  },

  addCommands() {
    return {
      setEmbed:
        ({ src }) =>
        ({ commands }) => {
          if (!isAllowedPlayerUrl(src)) return false;
          return commands.insertContent({ type: this.name, attrs: { src } });
        },
    };
  },

  renderHTML({ node }) {
    const src = node.attrs.src as string | null;
    const provider = isAllowedPlayerUrl(src);
    if (!src || !provider) return ['div', { 'data-type': 'embed' }];
    return [
      'div',
      { 'data-type': 'embed', 'data-provider': provider },
      ['iframe', embedIframeAttrs(provider, src, currentHost())],
    ];
  },
});

export function embedIframeAttrs(provider: EmbedProvider, src: string, host?: string | null) {
  return {
    src: embedRenderSrc(provider, src, host),
    width: '100%',
    height: String(EMBED_HEIGHTS[provider]),
    allowfullscreen: 'true',
    ...embedRenderAttrs(provider),
  };
}

// The editor has no request context; Twitch only needs `parent` to match the page it is on.
// Whatever lands in stored HTML is overwritten at render from the request host.
function currentHost() {
  return typeof window !== 'undefined' ? window.location.hostname : undefined;
}
