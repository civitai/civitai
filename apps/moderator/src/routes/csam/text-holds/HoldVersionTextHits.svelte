<script lang="ts">
  import { browser } from '$app/environment';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import {
    versionTextHitKey,
    type VersionTextHit,
    type VersionTextHitState,
  } from '$lib/csam-holds/version-text-hits';
  import { modelVersionUrl } from '$lib/entity-url';
  import { LINK_CLASS } from '$lib/format';
  import { fetchHoldVersionTexts, type HoldVersionTexts } from './hold-version-text';

  let {
    holdId,
    modelId,
    hits,
    civitaiUrl,
  }: { holdId: number; modelId: number; hits: VersionTextHit[]; civitaiUrl: string } = $props();

  // Nothing is fetched until the moderator asks; "Try again" asks again.
  let attempt = $state(0);
  const texts = $derived.by((): Promise<HoldVersionTexts> | null => {
    if (!attempt) return null;
    // Client only: a relative fetch during server rendering throws.
    return browser ? fetchHoldVersionTexts(holdId) : new Promise<never>(() => {});
  });

  const STATE_NOTES: Record<Exclude<VersionTextHitState, 'gone'>, string> = {
    unchanged: 'Current value, unchanged since the hold.',
    edited: 'Current value, edited since the hold.',
    'in-held-text': 'Current value, also in the held text.',
    'not-in-held-text': 'Current value, not in the held text: edited since the hold.',
  };

  const where = (hit: VersionTextHit) =>
    hit.field === 'name' ? 'version name' : `trigger word ${hit.index + 1}`;
</script>

{#snippet place(hit: VersionTextHit)}
  <a
    href={modelVersionUrl(civitaiUrl, modelId, hit.versionId)}
    target="_blank"
    rel="noreferrer"
    class={LINK_CLASS}>Version #{hit.versionId}</a
  >
  <span class="text-dark-2">· {where(hit)}</span>
{/snippet}

<TriageCard dense title="Flagged in">
  {#if texts === null}
    <ul class="m-0 list-none space-y-1 p-0 text-[13px]">
      {#each hits as hit (versionTextHitKey(hit))}
        <li>{@render place(hit)}</li>
      {/each}
    </ul>
    <Button
      size="sm"
      variant="outline"
      class="mt-2"
      aria-label="Show the flagged version text"
      onclick={() => (attempt += 1)}
    >
      Show text
    </Button>
  {:else}
    {#await texts}
      <p class="m-0 text-dark-2" role="status">Loading the flagged text…</p>
    {:then loaded}
      {#if 'gone' in loaded}
        <p class="m-0 text-dark-2">This hold no longer names flagged version text.</p>
      {:else if 'stale' in loaded}
        <p class="m-0 text-dark-2">The flagged positions were for held text that has since been replaced.</p>
      {:else}
        <ul class="m-0 list-none space-y-2 p-0 text-[13px]">
          {#each loaded.hits as hit (versionTextHitKey(hit))}
            <li>
              <div>{@render place(hit)}</div>
              {#if hit.state === 'gone' || hit.text === null}
                <p class="m-0 text-dark-2">No longer on this version.</p>
              {:else}
                <p class="m-0 whitespace-pre-wrap break-words text-dark-0">{hit.text}</p>
                <p class="m-0 text-[11px] text-dark-2">{STATE_NOTES[hit.state]}</p>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {:catch}
      <p class="m-0 text-dark-2" role="alert">Could not load the flagged text.</p>
      <button
        type="button"
        class={LINK_CLASS}
        aria-label="Try loading the flagged version text again"
        onclick={() => (attempt += 1)}>Try again</button
      >
    {/await}
  {/if}
</TriageCard>
