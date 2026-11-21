import { useComputedColorScheme } from '@mantine/core';
import { useRouter } from 'next/router';
import { useEffect, useRef } from 'react';
import { openLoginHere } from '~/components/Login/requireLogin';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type {
  FeaturePageVoteInput,
  FeaturePageMineInput,
} from '~/server/schema/feature-pages.schema';
import { trpc } from '~/utils/trpc';
import { createFeaturePageMessageHandler, FEATURE_PAGE_SANDBOX } from './featurePageHostLogic';

export function FeaturePageHost({
  src,
  origin,
  feature,
}: {
  src: string;
  origin: string;
  feature: string;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const router = useRouter();
  const currentUser = useCurrentUser();
  const theme = useComputedColorScheme('dark');
  const utils = trpc.useUtils();
  const { mutateAsync: vote } = trpc.featurePages.vote.useMutation();

  const signedIn = !!currentUser;

  useEffect(() => {
    const handler = createFeaturePageMessageHandler({
      embedOrigin: origin,
      feature,
      frameWindow: () => iframeRef.current?.contentWindow,
      theme,
      signedIn,
      openLogin: () => openLoginHere('perform-action'),
      // The server validates both inputs; the frame's values are passed through unread.
      vote: (input) => vote(input as FeaturePageVoteInput),
      mine: (input) =>
        utils.featurePages.mine.fetch(input as FeaturePageMineInput, { staleTime: 0 }),
      navigate: (req) => {
        if (req.target === 'new_tab') window.open(req.href, '_blank', 'noopener');
        else void router.push(req.href);
      },
    });
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [origin, feature, theme, signedIn, router, utils, vote]);

  return (
    <iframe
      ref={iframeRef}
      src={src}
      title="Feature"
      sandbox={FEATURE_PAGE_SANDBOX}
      referrerPolicy="no-referrer"
      className="block w-full border-0"
      style={{ height: 'calc(100dvh - var(--header-height, 60px))', minHeight: 640 }}
    />
  );
}
