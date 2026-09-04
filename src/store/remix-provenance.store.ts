/**
 * Remix Provenance Store
 *
 * Holds the server-minted provenance token for a source image the user picked
 * through a remix entry point, keyed by the URL that image currently has in the
 * generation form.
 *
 * Why a token and not the image id: `sourceImageIds` gates the FREE remix-gallery
 * submission and the `derivedFromHost` badge (`remix-gallery.service.ts`), so a
 * plain id in the request body would be the submitter asserting the thing that
 * gate exists to check. The token is AES-GCM sealed with a server key and bound
 * to the user, so holding one is proof the server issued it for that image.
 *
 * Why keyed by URL, and why it has to move: the generation form re-uploads any
 * source that is not already an orchestrator URL — resized and re-encoded to
 * JPEG — so the `image.civitai.com` URL a remix seeds is gone by submit time.
 * That is exactly why deriving provenance from the submitted URL fails for the
 * remix flow. `uploadOrchestratorImage` calls `transfer` so the token follows the
 * image across that swap.
 *
 * sessionStorage, mirroring `source-metadata.store`: a token is only useful
 * between picking a source and pressing Generate, and it must not outlive the
 * tab. The server re-checks the 30-day expiry regardless.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * Same ceiling as `source-metadata.store`. A user cannot have meaningfully more
 * live source images than this in one session, and the cap stops a long session
 * filling sessionStorage with tokens for images it will never submit.
 */
const MAX_ENTRIES = 50;

type Entry = {
  /** The sealed token. Opaque here — only the server can read it. */
  token: string;
  /** For eviction ordering. */
  storedAt: number;
};

interface RemixProvenanceState {
  tokensByUrl: Record<string, Entry>;
  setToken: (url: string, token: string) => void;
  getToken: (url: string) => string | undefined;
  /**
   * Move a token from the URL it was minted against to the URL that replaced it.
   * No-op when there is nothing to move, so the upload path can call it
   * unconditionally.
   */
  transfer: (fromUrl: string, toUrl: string) => void;
  removeToken: (url: string) => void;
  clearAll: () => void;
}

export const useRemixProvenanceStore = create<RemixProvenanceState>()(
  persist(
    (set, get) => ({
      tokensByUrl: {},

      setToken: (url, token) => {
        set((state) => {
          const updated = { ...state.tokensByUrl, [url]: { token, storedAt: Date.now() } };
          const entries = Object.entries(updated);
          if (entries.length > MAX_ENTRIES) {
            entries.sort((a, b) => a[1].storedAt - b[1].storedAt);
            entries.splice(0, entries.length - MAX_ENTRIES);
            return { tokensByUrl: Object.fromEntries(entries) };
          }
          return { tokensByUrl: updated };
        });
      },

      getToken: (url) => get().tokensByUrl[url]?.token,

      transfer: (fromUrl, toUrl) => {
        set((state) => {
          const existing = state.tokensByUrl[fromUrl];
          if (!existing) return state;
          const { [fromUrl]: _dropped, ...rest } = state.tokensByUrl;
          return { tokensByUrl: { ...rest, [toUrl]: existing } };
        });
      },

      removeToken: (url) => {
        set((state) => {
          const { [url]: _dropped, ...rest } = state.tokensByUrl;
          return { tokensByUrl: rest };
        });
      },

      clearAll: () => set({ tokensByUrl: {} }),
    }),
    {
      name: 'remix-provenance',
      storage: createJSONStorage(() => sessionStorage),
      version: 1,
    }
  )
);

/** Standalone accessor for use outside React components. */
export const remixProvenanceStore = {
  setToken: (url: string, token: string) => useRemixProvenanceStore.getState().setToken(url, token),
  getToken: (url: string) => useRemixProvenanceStore.getState().getToken(url),
  transfer: (fromUrl: string, toUrl: string) =>
    useRemixProvenanceStore.getState().transfer(fromUrl, toUrl),
  removeToken: (url: string) => useRemixProvenanceStore.getState().removeToken(url),
  clearAll: () => useRemixProvenanceStore.getState().clearAll(),
};
