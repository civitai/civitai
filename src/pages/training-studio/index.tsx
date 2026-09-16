import type { FC, Ref } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ParsedUrlQuery } from 'querystring';
import { useComputedColorScheme } from '@mantine/core';
import { useRouter } from 'next/router';
import { env } from '~/env/client';
import { env as serverEnv } from '~/env/server';
import { Page } from '~/components/AppLayout/Page';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

/**
 * The Training Studio embedded in the main app (docs/training-studio-web-component.md), behind the
 * user-toggleable `trainingStudioUi` flag. This page is the HOST: it loads the
 * <civitai-training-studio> element from the studio origin and implements the host contract —
 * token minting via /api/training-studio/host, and the URL space. Every view renders inside the
 * element; navigation is shallow query-state on THIS route (?view=new, ?run=<id>), never a hop to
 * the studio origin.
 */

const STUDIO_URL =
  process.env.NODE_ENV === 'development'
    ? 'http://localhost:5174'
    : env.NEXT_PUBLIC_TRAINING_STUDIO_URL;

type StudioLocation = { view: 'home' } | { view: 'new' } | { view: 'run'; workflowId: string };

const StudioTag = 'civitai-training-studio' as unknown as FC<{ ref: Ref<HTMLElement> }>;

const hrefFor = (loc: StudioLocation) =>
  loc.view === 'home'
    ? '/training-studio'
    : loc.view === 'new'
    ? '/training-studio?view=new'
    : `/training-studio?run=${encodeURIComponent(loc.workflowId)}`;

const locationFromQuery = (query: ParsedUrlQuery): StudioLocation => {
  if (typeof query.run === 'string' && query.run) return { view: 'run', workflowId: query.run };
  if (query.view === 'new') return { view: 'new' };
  return { view: 'home' };
};

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session }) => {
    if (!session) return { redirect: { destination: '/login', permanent: false } };
    if (session.user?.bannedAt) return { redirect: { destination: '/', permanent: false } };
    return {
      props: {
        session,
        // Config rides in as props so el.host can be set the moment the element upgrades — a
        // config fetch on the critical path put ~600ms of "Waiting for a host context…" on every
        // mount. Tokens still mint per-call through /api/training-studio/host.
        //
        // 🔴 The orchestrator URL is deliberately NOT among these props. It is read from the CLIENT
        // env below instead, because the element calls the orchestrator from the BROWSER. Passing
        // `serverEnv.ORCHESTRATOR_ENDPOINT` here is what broke the embed: that value is the
        // in-cluster address, so the browser got a mixed-content warning and ERR_NAME_NOT_RESOLVED.
        // Sourcing it from the client env makes the mistake unavailable rather than merely fixed —
        // there is no server-only value in scope to pass.
        orchestratorMode:
          serverEnv.ORCHESTRATOR_MODE === 'dev' ? ('dev' as const) : ('prod' as const),
      },
    };
  },
});

function TrainingStudioEmbed({ orchestratorMode }: { orchestratorMode: 'dev' | 'prod' }) {
  // Browser-facing, so the PUBLIC origin — never the server's in-cluster `ORCHESTRATOR_ENDPOINT`.
  const orchestratorEndpoint = env.NEXT_PUBLIC_ORCHESTRATOR_ENDPOINT;
  const ref = useRef<HTMLElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [elReady, setElReady] = useState(false);
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;

  const run = typeof router.query.run === 'string' ? router.query.run : null;
  const isNew = router.query.view === 'new';
  const studioLocation = useMemo<StudioLocation>(
    () => (run ? { view: 'run', workflowId: run } : isNew ? { view: 'new' } : { view: 'home' }),
    [run, isNew]
  );
  const locationRef = useRef(studioLocation);
  locationRef.current = studioLocation;

  useEffect(() => {
    // Dev-only cache-buster: the element bundle is rebuilt in place, and a cached stylesheet from a
    // previous build renders the studio with stale styling that reads as a theming bug. Prod URLs
    // stay stable for real caching.
    const bust = process.env.NODE_ENV === 'development' ? `?v=${Date.now()}` : '';
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `${STUDIO_URL}/element/civitai-training-studio.css${bust}`;
    document.head.appendChild(link);

    // Reuse an already-injected module script and never remove it on cleanup: removing a module
    // <script> does not un-execute it, and re-appending under a fresh cache-busted URL re-runs the
    // module on every remount. The element entry guards its define, but one script per document is
    // the contract.
    if (!document.head.querySelector('script[data-civitai-training-studio]')) {
      const script = document.createElement('script');
      script.type = 'module';
      script.dataset.civitaiTrainingStudio = '';
      script.src = `${STUDIO_URL}/element/civitai-training-studio.js${bust}`;
      script.onerror = () => {
        // A failed tag would satisfy the reuse lookup forever; drop it so a later mount retries.
        script.remove();
        setError('The Training Studio is unavailable right now.');
      };
      document.head.appendChild(script);
    }

    let cancelled = false;
    (async () => {
      await customElements.whenDefined('civitai-training-studio');
      if (cancelled || !ref.current) return;

      // Set AFTER upgrade: a property assigned pre-upgrade would shadow the element's accessor.
      const el = ref.current as HTMLElement & { host?: unknown; location?: StudioLocation };
      el.host = {
        getOrchestratorToken: async () => {
          const r = await fetch('/api/training-studio/host');
          if (!r.ok) throw new Error(`token mint failed (${r.status})`);
          return (await r.json()).token as string;
        },
        config: { orchestratorEndpoint, orchestratorMode },
        hrefFor,
        navigate: async (loc: StudioLocation) => {
          await routerRef.current.push(hrefFor(loc), undefined, { shallow: true });
        },
      };
      el.location = locationRef.current;
      setElReady(true);
    })().catch(() => {
      if (!cancelled) setError('Could not start the Training Studio session.');
    });

    return () => {
      cancelled = true;
      link.remove();
    };
  }, [orchestratorEndpoint, orchestratorMode]);

  // Browser navigation (and the element's own host.navigate round-trip) drives the view: the query
  // is the source of truth, pushed into the element as a property whenever it changes.
  useEffect(() => {
    if (!elReady || !ref.current) return;
    (ref.current as HTMLElement & { location?: StudioLocation }).location = studioLocation;
  }, [elReady, studioLocation]);

  // The element follows the host's scheme: a `light` class on the tag flips its palette (the
  // element CSS maps dark styles onto :not(.light)); no class = dark. Root stays transparent
  // either way, so the host background shows through.
  const colorScheme = useComputedColorScheme('dark');
  useEffect(() => {
    ref.current?.classList.toggle('light', colorScheme === 'light');
  }, [elReady, colorScheme]);

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: 24 }}>
      {error ? <p>{error}</p> : <StudioTag ref={ref} />}
    </div>
  );
}

export default Page(TrainingStudioEmbed, {
  features: (features) => features.trainingStudioUi,
});
