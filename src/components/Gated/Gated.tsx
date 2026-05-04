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
import type { MediaType } from '~/shared/utils/prisma/enums';
import { Meta, type MetaProps } from '~/components/Meta/Meta';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { requireLogin } from '~/components/Login/requireLogin';
import { useAppContext, useServerDomains } from '~/providers/AppProvider';
import { syncAccount } from '~/utils/sync-account';
import { outerCardStyle } from '~/components/Buzz/CryptoDeposit/crypto-deposit.constants';

const PAYWALL_SELECTOR_CLASS = 'paywalled-content';

const PAYWALL_HAS_PART = {
  '@type': 'WebPageElement' as const,
  isAccessibleForFree: false,
  cssSelector: `.${PAYWALL_SELECTOR_CLASS}`,
};

/**
 * Which view `Gated` will render given the current request.
 *
 *   - `loading`  — session is still resolving for non-safe content; render nothing yet
 *   - `page`     — full content visible (children render). May be a verified-bot
 *                  bypass of an otherwise-gated page; check `isPaywalled` to know
 *   - `unrated`  — content hasn't been moderation-rated yet (SFW site only)
 *   - `login`    — login required (PG13 on SFW or non-safe on .red, logged-out)
 *   - `redirect` — content moved to civitai.red, redirect prompt shown
 */
export type GatedState = 'loading' | 'page' | 'unrated' | 'login' | 'redirect';

export interface UseGatedResult {
  state: GatedState;
  /**
   * True when `state === 'page'` only because a verified search-engine
   * crawler bypassed what would have otherwise been a login gate. Triggers
   * paywall structured-data augmentation in `Gated` and the `.paywalled-content`
   * wrapper around children.
   */
  isPaywalled: boolean;
}

/**
 * Computes which view `Gated` would render for the current request. Pure
 * decision — does not call routing or DOM APIs, only reads state from
 * existing providers (session, feature flags, AppContext). Safe to call
 * directly when you need the gate decision without rendering the gate UI.
 */
export function useGated({
  contentNsfwLevel,
  nsfw,
  bypassRating,
}: {
  contentNsfwLevel: number;
  nsfw?: boolean;
  bypassRating?: boolean;
}): UseGatedResult {
  const currentUser = useCurrentUser();
  const { canViewNsfw } = useFeatureFlags();
  const { data, status } = useSession();
  const verifiedBot = useAppContext().verifiedBot;

  // Defer the decision while session is loading and we have no cached data.
  if (!hasSafeBrowsingLevel(contentNsfwLevel) && status === 'loading' && !data) {
    return { state: 'loading', isPaywalled: false };
  }

  // Unrated content — only block on the SFW site. Owners/mods bypass so
  // they can preview their own drafts before publishing.
  if (!canViewNsfw && contentNsfwLevel === 0 && !bypassRating) {
    return { state: 'unrated', isPaywalled: false };
  }

  const isUnratedOwnerPreview = bypassRating && contentNsfwLevel === 0;
  const isPG13Only =
    hasSafeBrowsingLevel(contentNsfwLevel) && !hasPublicBrowsingLevel(contentNsfwLevel);

  // PG13 on the SFW site requires login. Verified bots aren't a special
  // case here — civitai.com is strictly SFW even for crawlers, so a bot
  // hitting a PG13 page sees the same login gate any anonymous user would.
  if (!canViewNsfw && !currentUser && !nsfw && isPG13Only && !isUnratedOwnerPreview) {
    return { state: 'login', isPaywalled: false };
  }

  const meetsAllowedLevel = currentUser
    ? hasSafeBrowsingLevel(contentNsfwLevel)
    : hasPublicBrowsingLevel(contentNsfwLevel);

  // SFW site, NSFW content — redirect to civitai.red.
  if (!canViewNsfw && (nsfw || !meetsAllowedLevel) && !isUnratedOwnerPreview) {
    return { state: 'redirect', isPaywalled: false };
  }

  // Logged-out on civitai.red hitting non-safe content. Verified bots
  // bypass: they see the page with paywall structured data so the URL is
  // indexable. Humans get the login gate.
  if (!currentUser && !hasSafeBrowsingLevel(contentNsfwLevel)) {
    if (verifiedBot) return { state: 'page', isPaywalled: true };
    return { state: 'login', isPaywalled: false };
  }

  return { state: 'page', isPaywalled: false };
}

type GatedProps<TImage extends { nsfwLevel: number; url: string; type?: MediaType }> = {
  contentNsfwLevel: number;
  nsfw?: boolean;
  bypassRating?: boolean;
  /**
   * Meta props for `<head>` tags. Required so the schema (when augmented
   * with paywall properties for verified bots) and the `.paywalled-content`
   * wrapper are always emitted from the same component — the cssSelector
   * in the schema can never point at non-existent DOM.
   */
  meta: MetaProps<TImage>;
  children: React.ReactNode;
};

/**
 * Combined NSFW-gating + Meta wrapper for content-detail pages. Replaces
 * the prior pattern of using `<Meta>` and `<SensitiveShield>` as siblings.
 *
 * The pairing is mechanically enforced: when the gate is in the bot-bypass
 * state, both the schema augmentation (via `<Meta>`) and the
 * `.paywalled-content` wrapper around children come from the same render.
 * They cannot drift, and the cssSelector always points at real DOM.
 *
 * Pages that do not gate content (no NSFW levels involved) should keep
 * using `<Meta>` directly — `Gated` is for the seven entity-detail
 * surfaces where SensitiveShield was previously paired with Meta.
 */
export function Gated<TImage extends { nsfwLevel: number; url: string; type?: MediaType }>({
  contentNsfwLevel,
  nsfw,
  bypassRating,
  meta,
  children,
}: GatedProps<TImage>) {
  const { state, isPaywalled } = useGated({ contentNsfwLevel, nsfw, bypassRating });

  // Co-emit paywall structured data with the `.paywalled-content` wrapper
  // when we're rendering for a verified bot:
  //   - If the page provided an entity schema → augment it with paywall props
  //     (canonical pattern: `Product`, `Article`, etc. with isAccessibleForFree)
  //   - If no entity schema → emit a standalone WebPage paywall schema so the
  //     cssSelector → DOM contract still has a structured-data declaration
  const finalMeta: MetaProps<TImage> = isPaywalled
    ? {
        ...meta,
        schema: meta.schema
          ? {
              ...meta.schema,
              isAccessibleForFree: false,
              hasPart: PAYWALL_HAS_PART,
            }
          : {
              '@context': 'https://schema.org',
              '@type': 'WebPage',
              isAccessibleForFree: false,
              hasPart: PAYWALL_HAS_PART,
            },
      }
    : meta;

  return (
    <>
      <Meta {...finalMeta} />
      {state === 'loading' && <PageLoader />}
      {state === 'page' &&
        (isPaywalled ? (
          <div className={PAYWALL_SELECTOR_CLASS} style={{ display: 'contents' }}>
            {children}
          </div>
        ) : (
          children
        ))}
      {state === 'unrated' && (
        <div className="absolute inset-0 flex items-center justify-center">
          <UnratedContent />
        </div>
      )}
      {state === 'login' && (
        <div className="absolute inset-0 flex items-center justify-center">
          <LoginRequiredCard />
        </div>
      )}
      {state === 'redirect' && (
        <div className="absolute inset-0 flex items-center justify-center">
          <MatureContentRedirect />
        </div>
      )}
    </>
  );
}

function MatureContentRedirect() {
  const router = useRouter();
  const redDomain = useServerDomains().red;
  const redUrl = syncAccount(`//${redDomain}${router.asPath}`);
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

function LoginRequiredCard() {
  const router = useRouter();
  const returnUrl = router.asPath;
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
