import { useComputedColorScheme } from '@mantine/core';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useMemo, useRef } from 'react';
import { openLoginHere } from '~/components/Login/requireLogin';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type {
  FeaturePageCommentEditInput,
  FeaturePageCommentInput,
  FeaturePageCommentReportInput,
  FeaturePageCommentRetractInput,
  FeaturePageVoteInput,
  FeaturePageMineInput,
} from '~/server/schema/feature-pages.schema';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { FEATURE_PAGES_SET_USERNAME_MESSAGE } from '~/shared/constants/feature-pages.constants';
import { getSettingHref } from '~/components/Account/setting-links';
import type { FeaturePageHostDeps } from './featurePageHostLogic';
import { createFeaturePageHost, FEATURE_PAGE_SANDBOX } from './featurePageHostLogic';

type FrameDeps = Omit<FeaturePageHostDeps, 'embedOrigin' | 'frameWindow'>;

export function FeaturePageHost({
  src,
  origin,
  feature,
  viewerAuthor,
}: {
  src: string;
  origin: string;
  feature: string;
  viewerAuthor: string | null;
}) {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const theme = useComputedColorScheme('dark');
  const utils = trpc.useUtils();
  const { mutateAsync: vote } = trpc.featurePages.vote.useMutation();
  const { mutateAsync: comment } = trpc.featurePages.comment.useMutation();
  const { mutateAsync: editComment } = trpc.featurePages.edit.useMutation();
  const { mutateAsync: retractComment } = trpc.featurePages.retract.useMutation();
  const { mutateAsync: reportComment } = trpc.featurePages.report.useMutation();
  // The site masks profanity for viewers who blur mature content (RenderHtml does the same).
  const maskProfanity = useBrowsingSettings((state) => state.blurNsfw);
  const signedIn = !!currentUser;
  const discussion = useFeatureFlags().featurePagesDiscussion;

  const deps = useMemo<FrameDeps>(
    () => ({
      feature,
      theme,
      signedIn,
      maskProfanity,
      discussion,
      viewerAuthor,
      openLogin: () => openLoginHere('perform-action'),
      vote: (input) => vote(input as FeaturePageVoteInput),
      comment: (input) => comment(input as FeaturePageCommentInput),
      onNeedsUsername: () =>
        showErrorNotification({
          title: 'Username needed',
          error: { message: FEATURE_PAGES_SET_USERNAME_MESSAGE },
          reason: (
            <>
              {FEATURE_PAGES_SET_USERNAME_MESSAGE}{' '}
              <Link href={getSettingHref('account-info')} className="underline">
                Set your username
              </Link>
            </>
          ),
        }),
      editComment: (input) => editComment(input as FeaturePageCommentEditInput),
      retractComment: (input) => retractComment(input as FeaturePageCommentRetractInput),
      reportComment: (input) => reportComment(input as FeaturePageCommentReportInput),
      mine: (input) =>
        utils.featurePages.mine.fetch(input as FeaturePageMineInput, { staleTime: 0 }),
      navigate: (req) => {
        if (req.target === 'new_tab') window.open(req.href, '_blank', 'noopener');
        else void router.push(req.href);
      },
    }),
    [
      feature,
      theme,
      signedIn,
      maskProfanity,
      discussion,
      viewerAuthor,
      router,
      utils,
      vote,
      comment,
      editComment,
      retractComment,
      reportComment,
    ]
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
  const sendInitRef = useRef<(() => void) | undefined>(undefined);

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
