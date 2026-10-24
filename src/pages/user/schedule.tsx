import { useRouter } from 'next/router';
import type { ParsedUrlQuery } from 'querystring';
import type { FC, Ref } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PlannerHost, PlannerLocation, PlannerView } from '@civitai/post-planner/host';
import { createPlannerBackend, PLANNER_REST_PATH } from '@civitai/post-planner/contract';
import { NotFound } from '~/components/AppLayout/NotFound';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import { Page } from '~/components/AppLayout/Page';
import { env } from '~/env/client';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';

const VIEWS = new Set<PlannerView>(['day', 'week', 'month', 'agenda']);

const PlannerTag = 'civitai-post-planner' as unknown as FC<{ ref: Ref<HTMLElement> }>;

type PlannerElement = HTMLElement & { host?: PlannerHost; location?: PlannerLocation };

function hrefFor(loc: PlannerLocation): string {
  const params = new URLSearchParams({ view: loc.view, anchor: loc.anchor });
  if (loc.modelVersionId) params.set('mv', String(loc.modelVersionId));
  if (loc.tag) params.set('tag', loc.tag);
  return `/user/schedule?${params}`;
}

function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

/** The query is the source of truth; an incomplete one lets the element pick its own default. */
function locationFromQuery(query: ParsedUrlQuery): PlannerLocation | undefined {
  const view = typeof query.view === 'string' ? query.view : '';
  const anchor = typeof query.anchor === 'string' ? query.anchor : '';
  if (!VIEWS.has(view as PlannerView) || !isCalendarDay(anchor)) return undefined;
  const mv =
    typeof query.mv === 'string' && /^\d{1,12}$/.test(query.mv) ? Number(query.mv) : undefined;
  const tag = typeof query.tag === 'string' ? query.tag.trim().slice(0, 100) : '';
  return { view: view as PlannerView, anchor, modelVersionId: mv, tag: tag || undefined };
}

/** Mantine's CSS keys off the `data-mantine-color-scheme` attribute on `<html>`; mirroring that
 *  attribute keeps the element on the palette the page actually shows, whatever the manager holds. */
function useDocumentColorScheme(): 'dark' | 'light' {
  const [scheme, setScheme] = useState<'dark' | 'light'>('dark');
  useEffect(() => {
    const read = () =>
      setScheme(
        document.documentElement.getAttribute('data-mantine-color-scheme') === 'light'
          ? 'light'
          : 'dark'
      );
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-mantine-color-scheme'],
    });
    return () => observer.disconnect();
  }, []);
  return scheme;
}

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, features, ctx }) => {
    if (!session)
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl, reason: 'post-images' }),
          permanent: false,
        },
      };
    if (!features?.postPlanner) return { notFound: true };
  },
});

function SchedulePage() {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const router = useRouter();
  const ref = useRef<PlannerElement | null>(null);
  const [defined, setDefined] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const location = useMemo(() => locationFromQuery(router.query), [router.query]);

  useEffect(() => {
    let cancelled = false;
    import('@civitai/post-planner/define')
      .then(() => {
        if (!cancelled) setDefined(true);
      })
      .catch(() => {
        if (!cancelled) setLoadError('The planner could not be loaded. Refresh to try again.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const composerAvailable = !!features.batchPostScheduling;
  const userId = currentUser?.id;
  const browsingLevel = useBrowsingLevelDebounced();
  const showMature = useBrowsingSettings((x) => x.showNsfw && !x.blurNsfw);

  // Same-origin REST, so the session cookie rides along and every relative URL stays in this tab.
  useEffect(() => {
    const el = ref.current;
    if (!defined || !el) return;
    const host: PlannerHost = {
      backend: createPlannerBackend(PLANNER_REST_PATH),
      config: {
        userId,
        imageLocation: env.NEXT_PUBLIC_IMAGE_LOCATION,
        browsingLevel,
        showMature,
        composerAvailable,
      },
      hrefFor,
      notify: ({ message, color }) =>
        color === 'error'
          ? showErrorNotification({ error: new Error(message) })
          : showSuccessNotification({ message }),
      navigate: async (loc) => {
        await router.push(hrefFor(loc), undefined, { shallow: true, scroll: false });
      },
      editPostUrl: (post) =>
        `/posts/${post.id}/edit?returnUrl=${encodeURIComponent('/user/schedule')}`,
      viewPostUrl: (post) => `/posts/${post.id}`,
      modelPageUrl: ({ modelId, modelVersionId }) =>
        `/models/${modelId}?modelVersionId=${modelVersionId}`,
      composerUrl: ({ startAt, modelVersionId }) => {
        const params = new URLSearchParams();
        if (startAt) params.set('startAt', startAt);
        if (modelVersionId) params.set('modelVersionId', String(modelVersionId));
        const query = params.toString();
        return `/posts/batch${query ? `?${query}` : ''}`;
      },
    };
    el.host = host;
  }, [defined, userId, browsingLevel, showMature, composerAvailable]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = ref.current;
    if (!defined || !el) return;
    el.location = location;
  }, [defined, location]);

  const colorScheme = useDocumentColorScheme();

  if (!features.postPlanner) return <NotFound />;

  return (
    <div data-theme={colorScheme} className="mx-auto max-w-[1400px] px-4 py-6">
      {loadError ? <p>{loadError}</p> : <PlannerTag ref={ref} />}
    </div>
  );
}

export default Page(SchedulePage, { features: (features) => features.postPlanner });
