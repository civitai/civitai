<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import type {
    CivitaiPostPlanner,
    PlannerHost,
    PlannerLocation,
    PlannerView,
  } from '@civitai/post-planner';
  import { createPlannerBackend } from '@civitai/post-planner/contract';
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
    const tag = (params.get('tag') ?? '').trim().slice(0, 100);
    return {
      view: view as PlannerView,
      anchor,
      modelVersionId: mv && /^\d{1,12}$/.test(mv) ? Number(mv) : undefined,
      tag: tag || undefined,
    };
  }

  function hrefFor(loc: PlannerLocation): string {
    const params = new URLSearchParams({ view: loc.view, anchor: loc.anchor });
    if (loc.modelVersionId) params.set('mv', String(loc.modelVersionId));
    if (loc.tag) params.set('tag', loc.tag);
    return `/calendar?${params}`;
  }

  // This app's proxy over the main app's planner route; same wire shape, this app's session.
  const backend = createPlannerBackend('/api/planner');

  // Absolute main-app URLs on purpose: the element opens anything non-relative in a new tab, which
  // is what a creator wants when hopping from the studio to the editor.
  const makeHost = (): PlannerHost => {
    const composerUrl = data.composerUrl;
    return {
      backend,
      config: {
        userId: data.userId,
        imageLocation: data.imageLocation,
        browsingLevel: data.browsingLevel,
        showMature: data.showMature,
        composerAvailable: !!composerUrl,
      },
      composerUrl: ({ startAt, modelVersionId }) => {
        const params = new URLSearchParams();
        if (startAt) params.set('startAt', startAt);
        if (modelVersionId) params.set('modelVersionId', String(modelVersionId));
        const query = params.toString();
        return `${composerUrl ?? ''}${query ? `?${query}` : ''}`;
      },
      hrefFor,
      navigate: (loc) => goto(hrefFor(loc), { keepFocus: true, noScroll: true }),
      notify: ({ message, color }) =>
        color === 'error'
          ? toast.error(message)
          : color === 'success'
            ? toast.success(message)
            : toast(message),
      editPostUrl: (post) => civitaiUrl(`/posts/${post.id}/edit`, post),
      viewPostUrl: (post) => civitaiUrl(`/posts/${post.id}`, post),
      modelPageUrl: ({ modelId, modelVersionId, nsfwLevel }) =>
        civitaiUrl(`/models/${modelId}?modelVersionId=${modelVersionId}`, { nsfwLevel }),
    };
  };

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
