import { useComputedColorScheme } from '@mantine/core';
import { useRouter } from 'next/router';
import { useEffect, useMemo, useRef } from 'react';
import { openLoginHere } from '~/components/Login/requireLogin';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type {
  FeaturePageVoteInput,
  FeaturePageMineInput,
} from '~/server/schema/feature-pages.schema';
import { trpc } from '~/utils/trpc';
import type { FeaturePageHostDeps } from './featurePageHostLogic';
import { createFeaturePageHost, FEATURE_PAGE_SANDBOX } from './featurePageHostLogic';

type FrameDeps = Omit<FeaturePageHostDeps, 'embedOrigin' | 'frameWindow'>;

export function FeaturePageHost({
  src,
  origin,
  feature,
}: {
  src: string;
  origin: string;
  feature: string;
}) {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const theme = useComputedColorScheme('dark');
  const utils = trpc.useUtils();
  const { mutateAsync: vote } = trpc.featurePages.vote.useMutation();
  const signedIn = !!currentUser;

  const deps = useMemo<FrameDeps>(
    () => ({
      feature,
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
    }),
    [feature, theme, signedIn, router, utils, vote]
  );

  return <FeaturePageFrame src={src} origin={origin} deps={deps} />;
}

export function FeaturePageFrame({
  src,
  origin,
  deps,
}: {
  src: string;
  origin: string;
  deps: FrameDeps;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const sendInitRef = useRef<() => void>(undefined);

  useEffect(() => {
    const host = createFeaturePageHost({
      ...deps,
      embedOrigin: origin,
      frameWindow: () => iframeRef.current?.contentWindow,
    });
    window.addEventListener('message', host.onMessage);
    sendInitRef.current = host.sendInit;
    host.sendInit();
    return () => window.removeEventListener('message', host.onMessage);
  }, [origin, deps]);

  return (
    <iframe
      ref={iframeRef}
      onLoad={() => sendInitRef.current?.()}
      src={src}
      title="Feature"
      sandbox={FEATURE_PAGE_SANDBOX}
      referrerPolicy="no-referrer"
      className="block w-full border-0"
      style={{ height: 'calc(100dvh - var(--header-height, 60px))', minHeight: 640 }}
    />
  );
}
