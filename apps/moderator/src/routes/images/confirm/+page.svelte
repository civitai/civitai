<script lang="ts">
  import { applyAction, enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { browsingLevels, getBrowsingLevelLabel } from '@civitai/shared';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { getEdgeUrl, getVideoUrls } from '$lib/media/edge-url';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  let submitting = $state(false);
  let serverError = $state<string | null>(null);

  const WIDTH = 1200;
  const image = $derived(
    data.card && data.card.type !== 'video'
      ? getEdgeUrl(data.card.url, {
          width: WIDTH,
          fit: 'scale-down',
          anim: true,
          type: 'image',
          name: data.card.name,
        })
      : null
  );
  const video = $derived(
    data.card && data.card.type === 'video'
      ? getVideoUrls(data.card.url, { width: WIDTH, fit: 'scale-down', name: data.card.name })
      : null
  );

  const submit: SubmitFunction = () => {
    submitting = true;
    serverError = null;
    return async ({ result }) => {
      try {
        if (result.type === 'error') {
          serverError = 'Your rating was not recorded. Try again.';
          return;
        }
        await applyAction(result);
        // Invalidate on a refusal too: the reload claims the next item.
        await invalidateAll();
      } finally {
        submitting = false;
      }
    };
  };
</script>

<div class="mx-auto flex max-w-5xl flex-col gap-4">
  <header>
    <h1 class="text-xl font-semibold text-white">Rating confirmation</h1>
    <p class="text-sm text-dark-2">
      Rate this image as you see it. Agreeing ratings become Knights training data.
    </p>
  </header>

  {#if serverError}
    <ErrorAlert message={serverError} />
  {:else if form?.error}
    <ErrorAlert message={form.error} />
  {/if}

  {#if data.card}
    {#key data.card.token}
      <section
        class="flex flex-col gap-4 rounded-xl border border-dark-4 bg-dark-6 p-5 transition-opacity"
        class:opacity-50={submitting}
      >
        <div class="flex justify-center">
          {#if video}
            <video
              class="max-h-[75vh] w-auto max-w-full rounded-lg object-contain"
              poster={video.poster}
              autoplay
              muted
              loop
              playsinline
              preload="metadata"
            >
              <source src={video.webm} type="video/webm" />
              <source src={video.mp4} type="video/mp4" />
            </video>
          {:else if image}
            <img
              src={image}
              alt="Under review"
              width={data.card.width ?? undefined}
              height={data.card.height ?? undefined}
              decoding="async"
              class="max-h-[75vh] w-auto max-w-full rounded-lg object-contain"
            />
          {/if}
        </div>
        <form method="POST" action="?/answer" use:enhance={submit} class="flex flex-wrap gap-2">
          <input type="hidden" name="token" value={data.card.token} />
          {#each browsingLevels as level (level)}
            <Button type="submit" name="level" value={level} variant="outline" disabled={submitting}>
              {getBrowsingLevelLabel(level)}
            </Button>
          {/each}
        </form>
      </section>
    {/key}
  {:else}
    <section class="rounded-xl border border-dark-4 bg-dark-6 p-5 text-center text-sm text-dark-2">
      Nothing left for you right now. Other moderators may hold the remaining ones for a couple of
      minutes; check back.
    </section>
  {/if}
</div>
