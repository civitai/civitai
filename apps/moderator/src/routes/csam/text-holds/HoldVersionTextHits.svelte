<script lang="ts">
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import type { VersionTextHit, VersionTextHitText } from '$lib/csam-holds/version-text-hits';
  import { LINK_CLASS } from '$lib/format';
  import { fetchHoldVersionTexts } from './hold-version-text';

  let {
    holdId,
    hits,
    modelHref,
  }: { holdId: number; hits: VersionTextHit[]; modelHref: string | null } = $props();

  // Nothing is fetched until the moderator asks; "Try again" bumps the attempt.
  let attempt = $state(0);
  const texts = $derived.by((): Promise<VersionTextHitText[]> | null => {
    if (!attempt) return null;
    return fetchHoldVersionTexts(holdId);
  });

  const where = (hit: VersionTextHit) =>
    hit.field === 'name' ? 'version name' : `trigger word ${hit.index + 1}`;
  const versionHref = (versionId: number) =>
    modelHref ? `${modelHref}?modelVersionId=${versionId}` : null;
</script>

{#snippet place(hit: VersionTextHit)}
  {@const href = versionHref(hit.versionId)}
  {#if href}
    <a {href} target="_blank" rel="noreferrer" class={LINK_CLASS}>Version #{hit.versionId}</a>
  {:else}
    Version #{hit.versionId}
  {/if}
  <span class="text-dark-2">· {where(hit)}</span>
{/snippet}

<TriageCard dense title="Flagged in">
  {#if texts === null}
    <ul class="m-0 list-none space-y-1 p-0 text-[13px]">
      {#each hits as hit, i (i)}
        <li>{@render place(hit)}</li>
      {/each}
    </ul>
    <Button size="sm" variant="outline" class="mt-2" onclick={() => (attempt += 1)}>
      Show text
    </Button>
  {:else}
    {#await texts}
      <p class="m-0 text-dark-2" role="status">Loading the flagged text…</p>
    {:then loaded}
      <ul class="m-0 list-none space-y-2 p-0 text-[13px]">
        {#each loaded as hit, i (i)}
          <li>
            <div>{@render place(hit)}</div>
            {#if hit.text === null}
              <p class="m-0 text-dark-2">No longer on this version.</p>
            {:else}
              <p class="m-0 whitespace-pre-wrap break-words text-dark-0">{hit.text}</p>
              {#if !hit.inHeldText}
                <p class="m-0 text-[11px] text-dark-2">Edited since the hold: not in the held text.</p>
              {/if}
            {/if}
          </li>
        {/each}
      </ul>
    {:catch}
      <p class="m-0 text-dark-2">Could not load the flagged text.</p>
      <Button size="sm" variant="outline" class="mt-2" onclick={() => (attempt += 1)}>
        Try again
      </Button>
    {/await}
  {/if}
</TriageCard>
