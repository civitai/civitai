import { VERIFIED_BOT_HEADER } from '~/server/utils/bot-detection/header';
import { BOT_CACHE_REQ_KEY } from '~/shared/constants/bot-cache.constants';
import {
  SSR_PREFETCH_COHORT_REQ_KEY,
  SSR_PREFETCH_ROUTE_REQ_KEY,
} from '~/shared/constants/ssr-prefetch-cohort.constants';

/**
 * Shared by the `ssrSignedInSkipPrefetch*` getServerSideProps tests of the image, post and profile
 * pages (the model page's own is `models/model-page-skip-prefetch.test.ts`). Each test replaces
 * `createServerSideProps` with one that hands back the page's resolver and drives it with
 * `recordingSsg`, so every assertion is over exactly the calls the resolver makes and exactly what
 * it returns.
 */

/**
 * An `ssg` helper that records `<method> <router>.<procedure>` for every call. `fetch` answers from
 * `answers` (a throw there is a failed lookup), `null` otherwise.
 */
export function recordingSsg(calls: string[], answers: Record<string, () => unknown> = {}) {
  return new Proxy(
    {},
    {
      get: (_t, router: string) =>
        new Proxy(
          {},
          {
            get: (_t2, proc: string) => {
              const path = `${router}.${proc}`;
              return {
                fetch: async () => {
                  calls.push(`fetch ${path}`);
                  return answers[path] ? answers[path]() : null;
                },
                prefetch: async () => {
                  calls.push(`prefetch ${path}`);
                },
                prefetchInfinite: async () => {
                  calls.push(`prefetchInfinite ${path}`);
                },
              };
            },
          }
        ),
    }
  );
}

export const SIGNED_IN = { user: { id: 5, username: 'lantern-viewer', isModerator: false } };

/**
 * Requests outside the trial even when signed in with the flag on: what each changes on the
 * request `_app` hands getServerSideProps.
 */
export const OUTSIDE_TRIAL: {
  name: string;
  headers?: Record<string, string>;
  marks?: Record<string, unknown>;
  url?: string;
}[] = [
  { name: 'a verified bot', headers: { [VERIFIED_BOT_HEADER]: 'googlebot' } },
  { name: 'a bot-cache candidate', marks: { [BOT_CACHE_REQ_KEY]: 'route' } },
  { name: 'a /_next/data request', url: '/_next/data/build-id/page.json' },
];

/** The request a resolver is driven with, and the trial marks it carries afterwards. */
export function trialRequest({
  url,
  headers = {},
  marks = {},
}: {
  url: string;
  headers?: Record<string, string>;
  marks?: Record<string, unknown>;
}) {
  const req: Record<string, unknown> = { url, headers, ...marks };
  return {
    req,
    cohort: () => req[SSR_PREFETCH_COHORT_REQ_KEY],
    route: () => req[SSR_PREFETCH_ROUTE_REQ_KEY],
  };
}
