import { useCallback, useRef } from 'react';
import { Button, Text, ThemeIcon } from '@mantine/core';
import {
  IconArrowLeft,
  IconArrowRight,
  IconArrowsShuffle,
  IconBolt,
  IconClock,
  IconEyeOff,
  IconKey,
  IconPepper,
  IconUserCheck,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useHasClientHistory } from '~/store/ClientHistoryStore';
import {
  hasPublicBrowsingLevel,
  hasSafeBrowsingLevel,
} from '~/shared/constants/browsingLevel.constants';
import { useSession } from 'next-auth/react';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { requireLogin } from '~/components/Login/requireLogin';
import { useServerDomains } from '~/providers/AppProvider';
import { syncAccount } from '~/utils/sync-account';
import { outerCardStyle } from '~/components/Buzz/CryptoDeposit/crypto-deposit.constants';

export function SensitiveShield({
  children,
  nsfw,
  contentNsfwLevel,
  isLoading,
  bypassRating,
}: {
  children: React.ReactNode;
  nsfw?: boolean;
  contentNsfwLevel: number;
  isLoading?: boolean;
  bypassRating?: boolean;
}) {
  const currentUser = useCurrentUser();
  const router = useRouter();
  const { canViewNsfw } = useFeatureFlags();
  const { status } = useSession();
  const redDomain = useServerDomains().red;

  if (!hasSafeBrowsingLevel(contentNsfwLevel) && status === 'loading') return null;

  // content hasn't been rated yet — only block on the SFW site
  // owners/mods bypass so they can preview their own drafts before publishing
  if (!canViewNsfw && contentNsfwLevel === 0 && !bypassRating) {
    if (isLoading) return <PageLoader />;

    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <UnratedContent />
      </div>
    );
  }

  // this content is not available on this site — redirect to red
  // owners/mods previewing still-unrated content (level 0) bypass the redirect too
  const isUnratedOwnerPreview = bypassRating && contentNsfwLevel === 0;
  if (
    !canViewNsfw &&
    (nsfw || !hasPublicBrowsingLevel(contentNsfwLevel)) &&
    !isUnratedOwnerPreview
  ) {
    if (isLoading) return <PageLoader />;

    const redUrl = syncAccount(`//${redDomain}${router.asPath}`);

    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <MatureContentRedirect redUrl={redUrl} />
      </div>
    );
  }
  if (!currentUser && !hasSafeBrowsingLevel(contentNsfwLevel)) {
    if (isLoading) return <PageLoader />;

    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="flex flex-col items-center gap-2 p-3">
          <IconEyeOff size={56} />
          <Text size="xl" fw={500}>
            Sensitive Content
          </Text>
          <Text>This content has been marked as NSFW</Text>
          <Button
            leftSection={<IconKey />}
            onClick={(e: React.MouseEvent) =>
              requireLogin({
                uiEvent: e,
                reason: 'blur-toggle',
                returnUrl: router.asPath,
                cb: () => undefined,
              })
            }
          >
            Log in to view
          </Button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

function MatureContentRedirect({ redUrl }: { redUrl: string }) {
  const spotlightRef = useRef<HTMLDivElement>(null);
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = spotlightRef.current;
    if (!el) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    el.style.background = `radial-gradient(250px circle at ${x}px ${y}px, rgba(239,68,68,0.12), transparent 70%)`;
    el.style.opacity = '1';
  }, []);
  const handleMouseLeave = useCallback(() => {
    const el = spotlightRef.current;
    if (el) el.style.opacity = '0';
  }, []);

  return (
    <div
      className="flex w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-dark-4 md:flex-row"
      style={outerCardStyle}
    >
      {/* Left panel — visual anchor with spotlight */}
      <div
        className="relative flex w-full flex-col items-center justify-center gap-4 overflow-hidden bg-gradient-to-b from-red-9/30 via-red-9/15 to-red-9/5 px-10 py-12 md:w-2/5 md:bg-gradient-to-br"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        <div
          ref={spotlightRef}
          className="pointer-events-none absolute inset-0 transition-opacity duration-500"
          style={{ opacity: 0 }}
        />
        <div className="pointer-events-none absolute -bottom-16 -left-16 size-48 rounded-full bg-red-9/10 blur-3xl" />
        <div className="bg-orange-9/8 pointer-events-none absolute -right-12 -top-12 size-36 rounded-full blur-3xl" />

        <ThemeIcon
          variant="filled"
          color="red"
          size={72}
          radius="xl"
          className="relative shadow-lg shadow-red-9/40"
        >
          <IconPepper size={36} />
        </ThemeIcon>

        <Text
          fw={800}
          className="font-display relative text-center text-2xl leading-tight tracking-tight text-gray-0"
        >
          This content
          <br />
          has a new home
        </Text>
      </div>

      {/* Right panel — information and CTA */}
      <div className="flex w-full flex-1 flex-col gap-6 border-t border-gray-200 px-8 py-10 md:border-l md:border-t-0 md:px-10 dark:border-white/5">
        <div className="flex flex-col gap-1">
          <Text size="lg" fw={600} className="text-gray-1">
            Mature content now lives on{' '}
            <Text component="span" inherit fw={700} className="text-red-4">
              civitai.red
            </Text>
          </Text>
          <Text size="sm" className="text-dimmed">
            We split things up so everyone gets a better experience. The page you are looking for is
            waiting for you on our mature-content site.
          </Text>
        </div>

        <div className="flex flex-col gap-3">
          <FeatureRow icon={<IconUserCheck size={18} />} text="Same account" />
          <FeatureRow icon={<IconBolt size={18} />} text="Your Yellow Buzz carries over" />
          <FeatureRow icon={<IconArrowsShuffle size={18} />} text="Switch between sites any time" />
        </div>

        <Button
          component="a"
          href={redUrl}
          rel="noreferrer nofollow"
          color="red"
          size="lg"
          radius="md"
          rightSection={<IconArrowRight size={18} />}
          className="mt-1 w-full shadow-md shadow-red-9/25 md:w-auto md:self-start"
        >
          Continue on civitai.red
        </Button>
      </div>
    </div>
  );
}

function UnratedContent() {
  const hasHistory = useHasClientHistory();
  const spotlightRef = useRef<HTMLDivElement>(null);
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = spotlightRef.current;
    if (!el) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    el.style.background = `radial-gradient(250px circle at ${x}px ${y}px, rgba(234,179,8,0.12), transparent 70%)`;
    el.style.opacity = '1';
  }, []);
  const handleMouseLeave = useCallback(() => {
    const el = spotlightRef.current;
    if (el) el.style.opacity = '0';
  }, []);

  return (
    <div
      className="flex w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-dark-4 md:flex-row"
      style={outerCardStyle}
    >
      {/* Left panel */}
      <div
        className="relative flex w-full flex-col items-center justify-center gap-4 overflow-hidden bg-gradient-to-b from-yellow-9/30 via-yellow-9/15 to-yellow-9/5 px-10 py-12 md:w-2/5 md:bg-gradient-to-br"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        <div
          ref={spotlightRef}
          className="pointer-events-none absolute inset-0 transition-opacity duration-500"
          style={{ opacity: 0 }}
        />
        <div className="pointer-events-none absolute -bottom-16 -left-16 size-48 rounded-full bg-yellow-9/10 blur-3xl" />
        <div className="bg-orange-9/8 pointer-events-none absolute -right-12 -top-12 size-36 rounded-full blur-3xl" />

        <ThemeIcon
          variant="filled"
          color="yellow"
          size={72}
          radius="xl"
          className="relative shadow-lg shadow-yellow-9/40"
        >
          <IconClock size={36} />
        </ThemeIcon>

        <Text
          fw={800}
          className="font-display relative text-center text-2xl leading-tight tracking-tight text-gray-0"
        >
          Pending
          <br />
          review
        </Text>
      </div>

      {/* Right panel */}
      <div className="flex w-full flex-1 flex-col gap-6 border-t border-gray-200 px-8 py-10 md:border-l md:border-t-0 md:px-10 dark:border-white/5">
        <div className="flex flex-col gap-1">
          <Text size="lg" fw={600} className="text-gray-1">
            This content hasn&apos;t been rated yet
          </Text>
          <Text size="sm" className="text-dimmed">
            New content goes through a rating process before it becomes available. This usually
            doesn&apos;t take long — check back soon.
          </Text>
        </div>

        {hasHistory ? (
          <Button
            onClick={() => history.go(-1)}
            variant="light"
            color="yellow"
            size="lg"
            radius="md"
            leftSection={<IconArrowLeft size={18} />}
            className="mt-1 w-full md:w-auto md:self-start"
          >
            Go back
          </Button>
        ) : (
          <Button
            component="a"
            href="/"
            variant="light"
            color="yellow"
            size="lg"
            radius="md"
            leftSection={<IconArrowLeft size={18} />}
            className="mt-1 w-full md:w-auto md:self-start"
          >
            Go to home page
          </Button>
        )}
      </div>
    </div>
  );
}

function FeatureRow({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-3">
      <ThemeIcon variant="light" color="red" size="md" radius="xl" className="shrink-0">
        {icon}
      </ThemeIcon>
      <Text size="sm" className="text-gray-3">
        {text}
      </Text>
    </div>
  );
}
