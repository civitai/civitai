import { useEffect, useRef } from 'react';
import { trpc } from '~/utils/trpc';

/**
 * "Opening clears the hide" (`openingClearsHide` in `~/shared/utils/my-apps-hidden.ts`): the
 * run page mounts this ONLY when the server found the app in the signed-in viewer's
 * "Remove from My apps" hides, and it clears that one hide once, after mount. That brings the
 * app back on every device's home — the recently-opened `openedAt` that also counts as a use
 * lives in this browser only.
 *
 * Exactly one call per slug per mount: the ref holds the slug already sent, so a re-render (or
 * a fresh `mutate` identity) does not repeat the write. Best-effort and silent — a failure
 * leaves the hide in place (the server keeps dropping the row; this browser's home still shows
 * the app as a recents-only tile), which is not worth interrupting the app just opened.
 */
export function ReopenClearsHide({ slug }: { slug: string }) {
  const utils = trpc.useUtils();
  const { mutate } = trpc.appListings.unhideMyApp.useMutation({
    onSuccess: () => utils.appListings.listMyApps.invalidate(),
    onError: () => undefined,
  });
  const sentFor = useRef<string | null>(null);
  useEffect(() => {
    if (sentFor.current === slug) return;
    sentFor.current = slug;
    mutate({ slug });
  }, [slug, mutate]);
  return null;
}
