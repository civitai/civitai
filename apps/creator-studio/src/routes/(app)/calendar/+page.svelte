<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import type {
    CivitaiPostPlanner,
    PlannerBackend,
    PlannerHost,
    PlannerLocation,
    PlannerView,
  } from '@civitai/post-planner';
  import { civitaiUrl } from '$lib/model-url';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const VIEWS = new Set<PlannerView>(['day', 'week', 'month', 'agenda']);

  function isCalendarDay(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [y, m, d] = value.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
  }

  function parseLocation(params: URLSearchParams): PlannerLocation | undefined {
    const view = params.get('view');
    const anchor = params.get('anchor');
    if (!view || !anchor || !VIEWS.has(view as PlannerView) || !isCalendarDay(anchor))
      return undefined;
    const mv = params.get('mv');
    return {
      view: view as PlannerView,
      anchor,
      modelVersionId: mv && /^\d{1,12}$/.test(mv) ? Number(mv) : undefined,
    };
  }

  function hrefFor(loc: PlannerLocation): string {
    const params = new URLSearchParams({ view: loc.view, anchor: loc.anchor });
    if (loc.modelVersionId) params.set('mv', String(loc.modelVersionId));
    return `/calendar?${params}`;
  }

  async function call<T>(
    action: string,
    init:
      | { method: 'GET'; query: Record<string, string | undefined> }
      | { method: 'POST'; body: unknown }
  ): Promise<T> {
    const url =
      init.method === 'GET'
        ? `/api/planner/${action}?${new URLSearchParams(
            Object.fromEntries(
              Object.entries(init.query).filter(([, v]) => v !== undefined)
            ) as Record<string, string>
          )}`
        : `/api/planner/${action}`;
    const res = await fetch(url, {
      method: init.method,
      headers: init.method === 'POST' ? { 'content-type': 'application/json' } : undefined,
      body: init.method === 'POST' ? JSON.stringify(init.body) : undefined,
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string;
        message?: string;
      } | null;
      throw new Error(body?.error ?? body?.message ?? `Request failed (${res.status}).`);
    }
    return (await res.json()) as T;
  }

  const backend: PlannerBackend = {
    getScheduled: ({ from, to, modelVersionId }) =>
      call('scheduled', {
        method: 'GET',
        query: { from, to, modelVersionId: modelVersionId ? String(modelVersionId) : undefined },
      }),
    getPostDetail: (id) => call('detail', { method: 'GET', query: { id: String(id) } }),
    reschedule: (req) => call('schedule', { method: 'POST', body: req }),
    publishNow: (req) => call('schedule', { method: 'POST', body: { ...req, publishNow: true } }),
    unschedule: (ids) => call('unschedule', { method: 'POST', body: { ids } }),
    shift: (req) => call('shift', { method: 'POST', body: req }),
  };

  // Absolute main-app URLs on purpose: the element opens anything non-relative in a new tab, which
  // is what a creator wants when hopping from the studio to the editor.
  const makeHost = (): PlannerHost => ({
    backend,
    config: {
      userId: data.userId,
      imageLocation: data.imageLocation,
      browsingLevel: data.browsingLevel,
      showMature: data.showMature,
      composerAvailable: false,
    },
    hrefFor,
    navigate: (loc) => goto(hrefFor(loc), { keepFocus: true, noScroll: true }),
    editPostUrl: (post) => civitaiUrl(`/posts/${post.id}/edit`, post),
    viewPostUrl: (post) => civitaiUrl(`/posts/${post.id}`, post),
    modelPageUrl: ({ modelId, modelVersionId, nsfwLevel }) =>
      civitaiUrl(`/models/${modelId}?modelVersionId=${modelVersionId}`, { nsfwLevel }),
  });

  let element = $state<CivitaiPostPlanner | undefined>();
  let defined = $state(false);
  let loadError = $state<string | null>(null);
  const location = $derived(parseLocation(page.url.searchParams));

  onMount(async () => {
    try {
      await import('@civitai/post-planner/define');
      defined = true;
    } catch {
      loadError = 'The planner could not be loaded. Refresh to try again.';
    }
  });

  // `host` is set once per mount; only `location` follows the URL. Rebuilding `host` on every
  // navigation would reset the element's per-session state (the Show-mature toggle among it).
  $effect(() => {
    if (!defined || !element) return;
    element.host = untrack(() => makeHost());
  });

  $effect(() => {
    if (!defined || !element) return;
    element.location = location;
  });
</script>

<svelte:head>
  <title>Calendar · Creator Studio</title>
</svelte:head>

{#if loadError}
  <p class="text-dark-2">{loadError}</p>
{:else}
  <civitai-post-planner bind:this={element}></civitai-post-planner>
{/if}
