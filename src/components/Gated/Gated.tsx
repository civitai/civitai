import { Button, Text, ThemeIcon } from '@mantine/core';
import { useSyncAccount } from '~/hooks/useSyncAccount';
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
import { useRouter } from 'next/router';
import React, { useEffect } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useSpotlight } from '~/hooks/useSpotlight';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useHasClientHistory } from '~/store/ClientHistoryStore';
import { hasSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import {
  decideGatedState,
  type GatedState,
  type UseGatedResult,
} from '~/components/Gated/gated-state';
import { useSession, useSessionDiagnostics } from '~/providers/SessionProvider';
import { shellPageDataStatus } from '~/components/Shell/shell-page-data';
import { reportLoginGateWithAuthCookie, type LoginGateSignal } from '~/utils/faro/loginGate';
import type { MediaType } from '~/shared/utils/prisma/enums';
import { Meta, type MetaProps } from '~/components/Meta/Meta';
import { ownDomainCanonical } from '~/components/Meta/canonical';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { requireLogin } from '~/components/Login/requireLogin';
import { useAdGate, useSetAdPageNsfwLevel } from '~/components/Ads/AdsProvider';
import { useAppContext, useServerDomains } from '~/providers/AppProvider';
import { isAdGatedContent } from '~/shared/utils/ad-gating';
import { outerCardStyle } from '~/components/Buzz/CryptoDeposit/crypto-deposit.constants';

const PAYWALL_SELECTOR_CLASS = 'paywalled-content';

const PAYWALL_HAS_PART = {
  '@type': 'WebPageElement' as const,
  isAccessibleForFree: false,
  cssSelector: `.${PAYWALL_SELECTOR_CLASS}`,
};

export type { GatedState, UseGatedResult } from '~/components/Gated/gated-state';

/**
 * Computes which view `Gated` would render for the current request. Pure
 * decision — does not call routing or DOM APIs, only reads state from
 * existing providers (session, feature flags, AppContext). Safe to call
 * directly when you need the gate decision without rendering the gate UI.
 * The decision itself is `decideGatedState`, shared with code outside React.
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
  const features = useFeatureFlags();
  const { data, status } = useSession();
  const verifiedBot = useAppContext().verifiedBot;

  return decideGatedState({
    contentNsfwLevel,
    nsfw,
    bypassRating,
    canViewNsfw: !!features.canViewNsfw,
    signedIn: !!currentUser,
    sessionLoading: status === 'loading' && !data,
    verifiedBot: !!verifiedBot,
  });
}

// Faro may initialise after the first login render (its flag can arrive with a shell's page data).
const LOGIN_GATE_REPORT_RETRY_MS = 5000;

/**
 * Diagnostic only (`~/utils/faro/loginGate`): when the gate shows the login card to a viewer whose
 * hard load carried a session cookie, report how the session got there — once per page load.
 * Renders nothing and changes nothing.
 */
export function useLoginGateDiagnostic(state: GatedState, contentNsfwLevel: number) {
  const diagnostics = useSessionDiagnostics();
  useEffect(() => {
    if (state !== 'login' || !diagnostics?.authCookieAtLoad) return;
    // Snapshot now: a retry must describe the moment the gate showed, not a later one.
    const signal: LoginGateSignal = {
      diagnostics: {
        ...diagnostics,
        history: [...diagnostics.history],
        lastFetch: diagnostics.lastFetch && { ...diagnostics.lastFetch },
      },
      contentNsfwLevel,
      shellPageDataStatus: shellPageDataStatus(),
      msSinceNavStart: performance.now(),
    };
    if (reportLoginGateWithAuthCookie(signal) !== 'no-faro') return;
    // Not cleared on unmount or a state change: a gate that showed is worth reporting even once
    // it has gone, and the report touches no component state.
    setTimeout(() => reportLoginGateWithAuthCookie(signal), LOGIN_GATE_REPORT_RETRY_MS);
  }, [state, contentNsfwLevel, diagnostics]);
}

type GatedProps<TImage extends { nsfwLevel: number; url: string; type?: MediaType }> = {
  contentNsfwLevel: number;
  nsfw?: boolean;
  bypassRating?: boolean;
  /** Suppress ads for a reason unrelated to content rating — e.g. an unpublished model,
   *  visible only to its owner and moderators, so there is no audience to monetize. */
  suppressAds?: boolean;
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
  suppressAds,
  meta,
  children,
}: GatedProps<TImage>) {
  const { state, isPaywalled } = useGated({ contentNsfwLevel, nsfw, bypassRating });
  useLoginGateDiagnostic(state, contentNsfwLevel);
  const { allowMatureContent, domain, serverDomains } = useAppContext();

  // Rating, not `state` — a PG13 page still serves ads while showing a login gate.
  useAdGate(!!suppressAds || isAdGatedContent({ contentNsfwLevel, nsfw }));
  // Ad requests report this page's rating rather than the viewer's browsing level
  useSetAdPageNsfwLevel(contentNsfwLevel);

  // Whether the content is canonically SFW for the purpose of the deindex
  // decision. Some entities (e.g. `Model`) carry a coarse `nsfw` boolean
  // override — when truthy, force-treat the content as NSFW regardless of
  // its bitwise level. Otherwise the bitwise `nsfwLevel` is the source of
  // truth.
  const isSafeForCanonical = nsfw !== true && hasSafeBrowsingLevel(contentNsfwLevel);

  // Default deindex decision per gate state.
  //   - redirect / login / unrated  → no real content visible to crawlers
  //   - page on a non-green host, content is SFW → green is the canonical
  //     for SFW; red shouldn't compete in search results.
  // The bot-bypass case (`state === 'page' && isPaywalled`) only fires for
  // non-safe content (R+), so `isSafeForCanonical` is false there and the URL
  // stays indexable with paywall structured data.
  const shouldDefaultDeIndex =
    state === 'redirect' ||
    state === 'login' ||
    state === 'unrated' ||
    (state === 'page' && allowMatureContent && isSafeForCanonical);

  // Co-emit paywall structured data with the `.paywalled-content` wrapper
  // when we're rendering for a verified bot:
  //   - If the page provided an entity schema → augment it with paywall props
  //     (canonical pattern: `Product`, `Article`, etc. with isAccessibleForFree)
  //   - If no entity schema → emit a standalone WebPage paywall schema so the
  //     cssSelector → DOM contract still has a structured-data declaration
  // Use `||` (not `??`) so the Gated default fires whenever the caller's
  // expression is also falsy. Most callers pass `deIndex: <some boolean
  // expression>` that resolves to `false` for the common "published &
  // searchable" case — `??` would let that `false` mask the default.
  const finalMeta: MetaProps<TImage> = {
    ...meta,
    deIndex: meta.deIndex || shouldDefaultDeIndex,
    canonical:
      meta.canonical && allowMatureContent && !isSafeForCanonical
        ? ownDomainCanonical(meta.canonical, domain, serverDomains)
        : meta.canonical,
    schema: isPaywalled
      ? meta.schema
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
          }
      : meta.schema,
  };

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

export function MatureContentRedirect() {
  const router = useRouter();
  const redDomain = useServerDomains().red;
  const syncAccount = useSyncAccount();
  const redUrl = syncAccount(`//${redDomain}${router.asPath}`);
  const { spotlightRef, handleMouseMove, handleMouseLeave } = useSpotlight({
    size: 250,
    color: 'rgba(239,68,68,0.12)',
  });

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
  const { spotlightRef, handleMouseMove, handleMouseLeave } = useSpotlight({
    size: 250,
    color: 'rgba(234,179,8,0.12)',
  });

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
  const { spotlightRef, handleMouseMove, handleMouseLeave } = useSpotlight({
    size: 250,
    color: 'rgba(59,130,246,0.14)',
  });

  return (
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
            Sign in to keep exploring. It only takes a moment, and your account unlocks more of the
            site right away.
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
  );
}
