<script lang="ts">
  import { IconCheck, IconPhoto } from '@tabler/icons-svelte';
  import { getBrowsingLevelLabel, NsfwLevel } from '@civitai/shared';
  import EdgeImage from '$lib/components/EdgeImage.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import type { CheckState, SongDetails } from '$lib/audio-review';
  import { userUrl } from '$lib/entity-url';
  import { LINK_CLASS, plural, timeSince } from '$lib/format';
  import { removedCovers } from '$lib/music/removed-covers';

  // The open song's side cards on Audio review, under its reports or its appeal: the cover, the
  // automated checks, the generation details and the owner (`SongDetails`).
  let {
    details: d,
    civitaiUrl,
    coverNote,
  }: {
    details: SongDetails;
    civitaiUrl: string;
    /** A line under the cover card, e.g. that a cover is appealed on its own. */
    coverNote?: string;
  } = $props();

  // Removed on this page since the details were read (`removedCovers`): the placeholder now shows.
  const coverRemoved = $derived(!!d.cover && removedCovers.has(d.cover.id));

  const CHECK_LOOK: Record<CheckState, { label: string; class: string }> = {
    passed: { label: 'passed', class: 'bg-green-500/15 text-green-300' },
    blocked: { label: 'blocked', class: 'bg-red-500/15 text-red-300' },
    held: { label: 'held', class: 'bg-amber-500/15 text-amber-300' },
    pending: { label: 'not finished', class: 'bg-dark-5 text-dark-0' },
    failed: { label: 'failed', class: 'bg-dark-5 text-dark-0' },
  };

  const COVER_STATE: Record<CheckState, string> = {
    passed: 'Scanned',
    blocked: 'Blocked',
    held: 'Held for review',
    pending: 'Scan not finished',
    failed: 'Scan failed',
  };

  // The design's fact rows: a fixed label column, values left-aligned beside it.
  const FACT_ROW = 'grid grid-cols-[104px_1fr] gap-3 py-0.5';
</script>

{#snippet chip(text: string, tone = 'bg-dark-5 text-dark-0')}
  <span class="rounded px-1.5 py-px text-[11px] font-medium {tone}">{text}</span>
{/snippet}

{#snippet fact(label: string, value: string | null | undefined)}
  <div class={FACT_ROW}>
    <span class="text-dark-2">{label}</span>
    <span class="min-w-0 wrap-anywhere text-white">{value || '—'}</span>
  </div>
{/snippet}

<TriageCard title="Cover" dense>
  {#if d.cover}
    <div class="flex items-center gap-3">
      <div class="size-14 shrink-0 overflow-hidden rounded-md border border-dark-4 bg-dark-6">
        {#if d.cover.url && !coverRemoved}
          <EdgeImage src={d.cover.url} width={160} alt="" class="size-full object-cover" />
        {:else}
          <div class="flex size-full items-center justify-center text-dark-2">
            <IconPhoto size={20} aria-label="No cover shown" />
          </div>
        {/if}
      </div>
      <div class="min-w-0 space-y-1">
        <p class="m-0 font-medium text-white">Cover of this song</p>
        <div class="flex flex-wrap gap-1">
          <!-- A Blocked level says what the scan chip already says. -->
          {#if !coverRemoved && d.cover.nsfwLevel !== NsfwLevel.Blocked}
            {@render chip(d.cover.nsfwLevel ? getBrowsingLevelLabel(d.cover.nsfwLevel) : 'Not rated')}
          {/if}
          {#if d.checks.cover}
            <span
              class="inline-flex items-center gap-1 rounded px-1.5 py-px text-[11px] font-medium {CHECK_LOOK[
                d.checks.cover
              ].class}"
            >
              {#if d.checks.cover === 'passed'}<IconCheck size={11} aria-hidden="true" />{/if}
              {COVER_STATE[d.checks.cover]}
            </span>
          {/if}
          {#if coverRemoved}
            {@render chip('Removed', 'bg-red-500/15 text-red-300')}
          {:else if !d.cover.shown}
            {@render chip('Placeholder shown')}
          {/if}
        </div>
      </div>
    </div>
  {:else}
    <p class="m-0 text-dark-2">No cover: the player shows the placeholder.</p>
  {/if}
  {#if coverNote}<p class="m-0 mt-2 text-xs text-dark-2">{coverNote}</p>{/if}
</TriageCard>

<TriageCard title="Automated checks" dense>
  <div class="flex flex-wrap gap-1.5">
    {@render chip(`Song scan: ${CHECK_LOOK[d.checks.song].label}`, CHECK_LOOK[d.checks.song].class)}
    {#if d.checks.cover}
      {@render chip(
        `Cover scan: ${CHECK_LOOK[d.checks.cover].label}`,
        CHECK_LOOK[d.checks.cover].class
      )}
    {/if}
  </div>
</TriageCard>

<TriageCard title="Generation details" dense>
  {@render fact('Model', d.generation.model)}
  {@render fact('Seed', d.generation.seed)}
  {#if d.generation.prompt}{@render fact('Prompt', d.generation.prompt)}{/if}
  {@render fact('Music description', d.generation.musicDescription)}
  {@render fact('Lyrics source', d.generation.lyricsSource ?? 'No lyrics')}
</TriageCard>

{#if d.owner}
  <TriageCard title="Owner" dense>
    {#if d.owner.username}
      <div class={FACT_ROW}>
        <span class="text-dark-2">Username</span>
        <a
          href={userUrl(civitaiUrl, d.owner.username)}
          target="_blank"
          rel="noreferrer"
          class={LINK_CLASS}>{d.owner.username}</a
        >
      </div>
    {:else}
      {@render fact('User', `#${d.owner.id}`)}
    {/if}
    {@render fact('Account age', timeSince(d.owner.createdAt))}
    {@render fact('Removed songs', String(d.owner.removedSongs))}
    {@render fact('Strikes', String(d.owner.strikes))}
    {@render fact('Other reported', plural(d.owner.otherReported, 'song'))}
  </TriageCard>
{/if}
