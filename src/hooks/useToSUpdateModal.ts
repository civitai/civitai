import dynamic from 'next/dynamic';
import { useEffect, useRef } from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useAppContext } from '~/providers/AppProvider';
import { trpc } from '~/utils/trpc';

const TosModal = dynamic(() => import('~/components/ToSModal/TosModal'), {
  ssr: false,
});

export function useToSUpdateModal() {
  const currentUser = useCurrentUser();
  // Static per-domain ToS metadata (current body hash + rollout baseline + field
  // keys), delivered via SSR pageProps — no tRPC query. ToS content only changes
  // on a deploy, so this is constant for the tab's lifetime; the modal can
  // therefore only ever appear on a fresh load / new tab, never mid-session.
  const { tosMeta } = useAppContext();
  // The user's accepted-state side of the comparison. SSR-seeded in AppProvider,
  // and patched by the accept flow's `setSettings` — so accepting closes the modal
  // (hasUpdate recomputes to false) without any extra cache plumbing here.
  const { data: settings } = trpc.user.getSettings.useQuery(undefined, {
    enabled: !!currentUser,
  });
  // Dedup key: the content hash a modal was last shown for. Prevents re-triggering
  // on re-render while the (forced, un-dismissable) modal is already open.
  const shownForHash = useRef<string | null>(null);

  useEffect(() => {
    if (!currentUser || !tosMeta || !settings) return;

    const { hash, baselineHash, fieldKey, hashFieldKey } = tosMeta;
    const storedHashRaw = settings[hashFieldKey];
    const storedHash = typeof storedHashRaw === 'string' ? storedHashRaw : undefined;

    // Pure-hash trigger: re-prompt iff the current body hash differs from what the
    // user accepted. Users with no stored hash default to the rollout baseline, so
    // existing users are treated as having accepted the rollout text (no backfill,
    // no mass re-prompt) and are only prompted once the body changes from it. Their
    // first accept records a real hash. No date is consulted — a stray `lastmod`
    // bump can't trigger, and a body change with no `lastmod` bump can't be missed.
    const hasUpdate = (storedHash ?? baselineHash) !== hash;

    if (!hasUpdate || shownForHash.current === hash) return;
    shownForHash.current = hash;

    dialogStore.trigger({
      component: TosModal,
      props: {
        slug: 'tos',
        fieldKey,
        hashFieldKey,
        contentHash: hash,
        showBackButton: false,
        onAccepted: async () => {
          await currentUser.refresh();
        },
      },
    });
  }, [currentUser, tosMeta, settings]);

  return { tosMeta };
}
