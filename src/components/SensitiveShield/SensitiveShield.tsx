import { useCallback, useRef } from 'react';
import { Button, Text, ThemeIcon } from '@mantine/core';
import {
  IconArrowLeft,
  IconArrowRight,
  IconArrowsShuffle,
  IconBolt,
  IconClock,
  IconKey,
  IconLock,
  IconPepper,
  IconSparkles,
  IconUserCheck,
} from '@tabler/icons-react';
import Head from 'next/head';
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
import { useAppContext, useServerDomains } from '~/providers/AppProvider';
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
  const verifiedBot = useAppContext().verifiedBot;

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
  // logged-out sees PG only; logged-in also sees PG13
  const isUnratedOwnerPreview = bypassRating && contentNsfwLevel === 0;
  const isPG13Only =
    hasSafeBrowsingLevel(contentNsfwLevel) && !hasPublicBrowsingLevel(contentNsfwLevel);

  // PG13 on the SFW site requires login — prompt instead of redirecting to red.
  // Verified search-engine crawlers bypass: they get full content + paywall
  // structured data so the URL is indexable. Humans still get the gate.
  if (!canViewNsfw && !currentUser && !nsfw && isPG13Only && !isUnratedOwnerPreview) {
    if (isLoading) return <PageLoader />;
    if (verifiedBot) return <BotIndexableContent>{children}</BotIndexableContent>;

    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <LoginRequiredCard returnUrl={router.asPath} />
      </div>
    );
  }

  const meetsAllowedLevel = currentUser
    ? hasSafeBrowsingLevel(contentNsfwLevel)
    : hasPublicBrowsingLevel(contentNsfwLevel);
  if (!canViewNsfw && (nsfw || !meetsAllowedLevel) && !isUnratedOwnerPreview) {
    if (isLoading) return <PageLoader />;

    const redUrl = syncAccount(`//${redDomain}${router.asPath}`);

    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <MatureContentRedirect redUrl={redUrl} />
      </div>
    );
  }
  // Logged-out on civitai.red hitting non-safe content. Same bot bypass as
  // above: crawlers get full content with paywall structured data; humans
  // get the login gate.
  if (!currentUser && !hasSafeBrowsingLevel(contentNsfwLevel)) {
    if (isLoading) return <PageLoader />;
    if (verifiedBot) return <BotIndexableContent>{children}</BotIndexableContent>;

    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <LoginRequiredCard returnUrl={router.asPath} />
      </div>
    );
  }

  return <>{children}</>;
}

const PAYWALL_SELECTOR_CLASS = 'paywalled-content';
const PAYWALL_SCHEMA = {
  '@context': 'https://schema.org',
  '@type': 'WebPage',
  isAccessibleForFree: false,
  hasPart: {
    '@type': 'WebPageElement',
    isAccessibleForFree: false,
    cssSelector: `.${PAYWALL_SELECTOR_CLASS}`,
  },
};

/**
 * Wraps a gated subtree for verified search-engine crawlers: emits
 * schema.org paywall structured data and tags the wrapper with the
 * cssSelector that the schema points at. This is Google's sanctioned
 * pattern for serving full content to bots while gating it for humans —
 * the structured data is the contract that makes it not-cloaking.
 *
 * `display: contents` on the wrapper keeps it transparent for layout, so
 * the gated content renders identically to the non-gated path.
 */
function BotIndexableContent({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(PAYWALL_SCHEMA) }}
          key="paywall-schema"
        />
      </Head>
      <div className={PAYWALL_SELECTOR_CLASS} style={{ display: 'contents' }}>
        {children}
      </div>
    </>
  );
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
    <>
      <Head>
        <meta name="robots" content="noindex,nofollow" />
      </Head>
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
              We split things up so everyone gets a better experience. The page you are looking for
              is waiting for you on our mature-content site.
            </Text>
          </div>

          <div className="flex flex-col gap-3">
            <FeatureRow icon={<IconUserCheck size={18} />} text="Same account" />
            <FeatureRow icon={<IconBolt size={18} />} text="Your Yellow Buzz carries over" />
            <FeatureRow
              icon={<IconArrowsShuffle size={18} />}
              text="Switch between sites any time"
            />
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
    </>
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

function FeatureRow({
  icon,
  text,
  color = 'red',
}: {
  icon: React.ReactNode;
  text: string;
  color?: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <ThemeIcon variant="light" color={color} size="md" radius="xl" className="shrink-0">
        {icon}
      </ThemeIcon>
      <Text size="sm" className="text-gray-3">
        {text}
      </Text>
    </div>
  );
}

function LoginRequiredCard({ returnUrl }: { returnUrl: string }) {
  const spotlightRef = useRef<HTMLDivElement>(null);
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = spotlightRef.current;
    if (!el) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    el.style.background = `radial-gradient(250px circle at ${x}px ${y}px, rgba(59,130,246,0.14), transparent 70%)`;
    el.style.opacity = '1';
  }, []);
  const handleMouseLeave = useCallback(() => {
    const el = spotlightRef.current;
    if (el) el.style.opacity = '0';
  }, []);

  return (
    <>
      <Head>
        <meta name="robots" content="noindex,nofollow" />
      </Head>
      <div
        className="flex w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-dark-4 md:flex-row"
        style={outerCardStyle}
      >
        {/* Left panel — visual anchor with spotlight */}
        <div
          className="relative flex w-full flex-col items-center justify-center gap-4 overflow-hidden bg-gradient-to-b from-blue-9/30 via-blue-9/15 to-blue-9/5 px-10 py-12 md:w-2/5 md:bg-gradient-to-br"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        >
          <div
            ref={spotlightRef}
            className="pointer-events-none absolute inset-0 transition-opacity duration-500"
            style={{ opacity: 0 }}
          />
          <div className="pointer-events-none absolute -bottom-16 -left-16 size-48 rounded-full bg-blue-9/10 blur-3xl" />
          <div className="bg-indigo-9/10 pointer-events-none absolute -right-12 -top-12 size-36 rounded-full blur-3xl" />

          <ThemeIcon
            variant="filled"
            color="blue"
            size={72}
            radius="xl"
            className="relative shadow-lg shadow-blue-9/40"
          >
            <IconLock size={36} />
          </ThemeIcon>

          <Text
            fw={800}
            className="font-display relative text-center text-2xl leading-tight tracking-tight text-gray-0"
          >
            Log in to
            <br />
            continue
          </Text>
        </div>

        {/* Right panel — information and CTA */}
        <div className="flex w-full flex-1 flex-col gap-6 border-t border-gray-200 px-8 py-10 md:border-l md:border-t-0 md:px-10 dark:border-white/5">
          <div className="flex flex-col gap-1">
            <Text size="lg" fw={600} className="text-gray-1">
              This content requires an account
            </Text>
            <Text size="sm" className="text-dimmed">
              Sign in to keep exploring. It only takes a moment, and your account unlocks more of
              the site right away.
            </Text>
          </div>

          <div className="flex flex-col gap-3">
            <FeatureRow color="blue" icon={<IconUserCheck size={18} />} text="Free account" />
            <FeatureRow color="blue" icon={<IconSparkles size={18} />} text="Unlock more content" />
            <FeatureRow color="blue" icon={<IconBolt size={18} />} text="Earn and spend Buzz" />
          </div>

          <Button
            color="blue"
            size="lg"
            radius="md"
            leftSection={<IconKey size={18} />}
            rightSection={<IconArrowRight size={18} />}
            className="mt-1 w-full shadow-md shadow-blue-9/25 md:w-auto md:self-start"
            onClick={(e: React.MouseEvent) =>
              requireLogin({
                uiEvent: e,
                reason: 'view-content',
                returnUrl,
                cb: () => undefined,
              })
            }
          >
            Log in to view
          </Button>
        </div>
      </div>
    </>
  );
}
