<script lang="ts">
  import { browser } from '$app/environment';
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { tick } from 'svelte';
  import { IconCheck, IconExternalLink, IconFlag, IconSearch, IconUser } from '@tabler/icons-svelte';
  import { formatPlaybackTime, getBrowsingLevelLabel } from '@civitai/shared';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import EdgeImage from '$lib/components/EdgeImage.svelte';
  import SongBadge from '$lib/components/SongBadge.svelte';
  import SongCard from '$lib/components/SongCard.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import TriageColumns from '$lib/components/triage/TriageColumns.svelte';
  import TriageDecisionBar from '$lib/components/triage/TriageDecisionBar.svelte';
  import TriageDetailHeader from '$lib/components/triage/TriageDetailHeader.svelte';
  import TriageKeyButton from '$lib/components/triage/TriageKeyButton.svelte';
  import {
    dismissDecision,
    reportedDecisionsEnabled,
    songDetailsUrl,
    songRemovedTitle,
    songRatingLabel,
    SONG_RATING_LEVELS,
    type CheckState,
    type ReportedSongRow,
    type SongDetails,
  } from '$lib/audio-review';
  import { entityUrl, userUrl } from '$lib/entity-url';
  import { fetchJson } from '$lib/fetch-json';
  import { dateTime, LINK_BUTTON, LINK_CLASS, plural, shortAge, shortDate, timeSince } from '$lib/format';
  import { optimisticEnhancer } from '$lib/form-action';
  import { SSR_PENDING } from '$lib/ssr-pending';
  import type { Outcome } from '$lib/triage/queue';
  import { VIOLATION_LABELS, VIOLATION_TYPES } from '$lib/violations';

  let {
    row,
    civitaiUrl,
    canAct,
    verdict,
    error,
    submit,
    actionHref,
    level,
    ratingOpen,
    onrate,
    onrated,
  }: {
    row: ReportedSongRow;
    civitaiUrl: string;
    canAct: boolean;
    verdict: string | undefined;
    error: string | undefined;
    submit: (outcome: Outcome) => SubmitFunction;
    actionHref: (action: string) => string;
    /** The song's rating, including one set on this page since it loaded. Null when withheld. */
    level: number | null;
    /** Key 4 was pressed: the next digit picks the level. */
    ratingOpen: boolean;
    onrate: () => void;
    /** A rating was sent (the level), or refused (null: back to the loaded one). */
    onrated: (level: number | null) => void;
  } = $props();

  // Client only, one read per song.
  const details = $derived(browser ? fetchJson<SongDetails>(songDetailsUrl(row.id)) : SSR_PENDING);

  const enabled = $derived(reportedDecisionsEnabled(row, canAct));
  const reportIds = $derived(row.reports.map((r) => r.id).join(','));
  const owner = $derived(row.owner);
  const songHref = $derived(entityUrl(civitaiUrl, 'image', row.id));
  const dismiss = $derived(dismissDecision(row));

  // Remove song asks for a violation type before it submits.
  let violationType = $state('');
  let violationSelect = $state<HTMLElement | null>(null);
  let problem = $state<string | null>(null);
  const removeSubmit: SubmitFunction = async (input) => {
    if (!violationType) {
      input.cancel();
      problem = 'Pick a violation type first.';
      await tick();
      violationSelect?.focus();
      return;
    }
    problem = null;
    return submit('Song removed')(input);
  };

  // A rating is a correction, not a verdict: the song stays open, its reports still to decide.
  const rate = optimisticEnhancer(({ formData }) => {
    onrated(Number(formData.get('nsfwLevel')));
    return () => onrated(null);
  });

  const CHECK_LOOK: Record<CheckState, { label: string; class: string }> = {
    passed: { label: 'passed', class: 'bg-green-500/15 text-green-300' },
    blocked: { label: 'blocked', class: 'bg-red-500/15 text-red-300' },
    held: { label: 'held', class: 'bg-amber-500/15 text-amber-300' },
    pending: { label: 'not finished', class: 'bg-dark-5 text-dark-0' },
    failed: { label: 'failed', class: 'bg-dark-5 text-dark-0' },
  };

  // The design's fact rows: a fixed label column, values left-aligned beside it.
  const FACT_ROW = 'grid grid-cols-[104px_1fr] gap-3 py-0.5';
  const SONG_FACT_ROW = 'grid grid-cols-[92px_1fr] gap-3 py-0.5';

  const COVER_STATE: Record<CheckState, string> = {
    passed: 'Scanned',
    blocked: 'Blocked',
    held: 'Held for review',
    pending: 'Scan not finished',
    failed: 'Scan failed',
  };

</script>

{#snippet chip(text: string, tone = 'bg-dark-5 text-dark-0')}
  <span class="rounded px-1.5 py-px text-[11px] font-medium {tone}">{text}</span>
{/snippet}

{#snippet fact(label: string, value: string | null | undefined, row = FACT_ROW)}
  <div class={row}>
    <span class="text-dark-2">{label}</span>
    <span class="min-w-0 wrap-anywhere text-white">{value || '—'}</span>
  </div>
{/snippet}

{#snippet decision()}
  <form
    method="POST"
    action={actionHref('dismiss')}
    data-triage-action="dismiss"
    id="dismiss-{row.id}"
    use:enhance={submit(dismiss.outcome)}
  >
    <input type="hidden" name="imageId" value={row.id} />
    <input type="hidden" name="reportIds" value={reportIds} />
  </form>
  <form
    method="POST"
    action={actionHref('remove')}
    data-triage-action="remove"
    id="remove-{row.id}"
    use:enhance={removeSubmit}
  >
    <input type="hidden" name="imageId" value={row.id} />
    <input type="hidden" name="reportIds" value={reportIds} />
    <input type="hidden" name="violationType" value={violationType} />
  </form>
  <TriageDecisionBar
    compact
    {problem}
    hint={ratingOpen
      ? 'Rating: 1 to 5 picks the level · Esc cancels. A rating leaves the reports open.'
      : `J/K to move · 1 to 4 decide. Remove song asks for a violation type. ${dismiss.label} closes ${plural(row.reports.length, 'report')}.`}
  >
    {#snippet buttons()}
      <!-- Dimmed while the rating picker owns the digits. -->
      <TriageKeyButton
        key={1}
        type="submit"
        form="dismiss-{row.id}"
        disabled={!enabled[0]}
        class={cn(ratingOpen && 'opacity-50')}
        title={row.removed ? songRemovedTitle(row) : undefined}
      >
        {dismiss.label}
      </TriageKeyButton>
      <TriageKeyButton
        key={2}
        primary
        type="submit"
        form="remove-{row.id}"
        disabled={!enabled[1]}
        class={cn(ratingOpen && 'opacity-50')}
      >
        Remove song
      </TriageKeyButton>
      <TriageKeyButton
        key={3}
        type="button"
        disabled
        title="Removing only the cover is not on this page yet"
      >
        Remove cover
      </TriageKeyButton>
      <TriageKeyButton
        key={4}
        type="button"
        tone={ratingOpen ? 'blue' : undefined}
        disabled={!enabled[3]}
        onclick={onrate}
      >
        Set rating
      </TriageKeyButton>
    {/snippet}
    {#snippet picker()}
      <form
        method="POST"
        action={actionHref('setRating')}
        data-rating-form
        use:enhance={rate}
        class="flex flex-nowrap items-center gap-1.5 {ratingOpen ? '' : 'opacity-80'}"
      >
        <input type="hidden" name="imageId" value={row.id} />
        <span class="mr-0.5 text-xs text-dark-2">Rating</span>
        {#each SONG_RATING_LEVELS as option, i (option)}
          <TriageKeyButton
            type="submit"
            key={i + 1}
            name="nsfwLevel"
            value={option}
            selected={level === option}
            disabled={!enabled[3] || level === option}
            title={level === option ? 'Its current rating' : undefined}
            class="h-[23px] gap-1.5 px-2 text-xs"
          >
            {songRatingLabel(option)}
          </TriageKeyButton>
        {/each}
      </form>
    {/snippet}
    {#snippet fields()}
      <Select.Root type="single" bind:value={violationType}>
        <Select.Trigger
          bind:ref={violationSelect}
          aria-label="Violation type"
          class="h-[30px] w-[140px] flex-none justify-between border-dark-4 bg-dark-7 text-[13px] text-dark-0 dark:bg-dark-7"
        >
          <span class="truncate">
            {violationType
              ? VIOLATION_LABELS[violationType as keyof typeof VIOLATION_LABELS]
              : 'Violation type'}
          </span>
        </Select.Trigger>
        <Select.Content>
          {#each VIOLATION_TYPES as v (v)}
            <Select.Item value={v} label={VIOLATION_LABELS[v]}>{VIOLATION_LABELS[v]}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
      <Input
        name="violationDetails"
        form="remove-{row.id}"
        maxlength={1000}
        aria-label="Note for the owner"
        placeholder="Note for the owner (optional)"
        class="h-[30px] min-w-0 flex-1 basis-0 border-dark-4 bg-dark-7 text-[13px] placeholder:text-dark-2 dark:bg-dark-7"
      />
    {/snippet}
  </TriageDecisionBar>
{/snippet}

<TriageColumns {verdict} {error} decision={row.withheld ? undefined : decision}>
  {#snippet header()}
    <TriageDetailHeader
      title={row.withheld ? `Withheld song #${row.id}` : row.title || 'Untitled song'}
      reference="#{row.id}"
    >
      {#snippet chips()}
        <SongBadge class="h-[17px] px-1.5 text-[11px]" />
        {@render chip('Reported', 'bg-amber-500/15 text-amber-300')}
        {#if level !== null}{@render chip(getBrowsingLevelLabel(level))}{/if}
        <span
          class="inline-flex items-center gap-1 rounded bg-red-500/20 px-1.5 py-px text-[11px] font-medium text-red-300"
        >
          <IconFlag size={11} aria-hidden="true" />{plural(row.reportCount, 'report')}
        </span>
        {#if row.removed}
          <span title={songRemovedTitle(row)}>{@render chip('Removed')}</span>
        {/if}
      {/snippet}
      {#snippet links()}
        {#if !row.withheld}
          {#if songHref}
            <Button
              variant="outline"
              size="sm"
              class={LINK_BUTTON}
              href={songHref}
              target="_blank"
              rel="noreferrer"
            >
              <IconExternalLink aria-hidden="true" /> Open song
            </Button>
          {/if}
          {#if owner?.username}
            <Button
              variant="outline"
              size="sm"
              class={LINK_BUTTON}
              href={userUrl(civitaiUrl, owner.username)}
              target="_blank"
              rel="noreferrer"
            >
              <IconUser aria-hidden="true" /> Owner
            </Button>
            <Button
              variant="outline"
              size="sm"
              class={LINK_BUTTON}
              href={userUrl(civitaiUrl, owner.username, 'music')}
              target="_blank"
              rel="noreferrer"
            >
              <IconSearch aria-hidden="true" /> Owner's songs
            </Button>
          {/if}
        {/if}
      {/snippet}
    </TriageDetailHeader>
  {/snippet}

  {#snippet evidence()}
    <div class="space-y-3">
      {#if row.withheld}
        <div class="space-y-2 rounded-lg border border-dark-4 bg-dark-7 p-3.5 text-sm text-dark-0">
          <p class="m-0">
            This song is withheld from you: its audio, lyrics, cover and owner are not shown here.
          </p>
          <a href="/csam/text-holds?status=all&q={row.id}" class={LINK_CLASS}>Open in CSAM holds</a>
        </div>
      {:else if !row.url}
        <p class="m-0 text-sm text-dark-2">No audio file.</p>
      {:else}
        <SongCard item={{ id: row.id, url: row.url }} variant="detail" />
      {/if}
      {#if !row.withheld}
        <!-- The one place a failed read is reported; the sidebar's cards just stay away. -->
        {#await details}
          <p class="m-0 text-sm text-dark-2">Loading the song's details…</p>
        {:then d}
          <TriageCard title="Song" dense>
            {@render fact('Genre', d.facts.genre, SONG_FACT_ROW)}
            <div class={SONG_FACT_ROW}>
              <span class="text-dark-2">Posted</span>
              <span class="text-white">
                {d.facts.postedAt ? shortDate(d.facts.postedAt) : 'Not posted'}
                {#if d.facts.postId}
                  · <a
                    href={entityUrl(civitaiUrl, 'post', d.facts.postId)}
                    target="_blank"
                    rel="noreferrer"
                    class={LINK_CLASS}>Open post</a
                  >
                {/if}
              </span>
            </div>
            {@render fact('Remix', d.facts.allowRemix ? 'Allowed' : 'Not allowed', SONG_FACT_ROW)}
          </TriageCard>
        {:catch}
          <p class="m-0 text-sm text-dark-2">
            Couldn't load this song's facts, cover, checks, generation details and owner.
          </p>
        {/await}
      {/if}
    </div>
  {/snippet}

  {#snippet info()}
    <TriageCard title="Reports · {row.reportCount}" dense accent="red">
      <ul class="m-0 list-none space-y-3 p-0">
        {#each row.reports as report (report.id)}
          <li class="space-y-1">
            <div class="flex flex-wrap items-center gap-1.5">
              {#if report.label}{@render chip(report.label, 'bg-red-500/15 text-red-300')}{/if}
              {#if report.timeSec != null}
                {@render chip(formatPlaybackTime(report.timeSec), 'bg-blue-500/15 text-blue-300')}
              {/if}
              {#if report.also}{@render chip(`+${report.also} others`)}{/if}
              <span class="text-xs text-dark-2" title={dateTime(report.createdAt)}>
                {report.reporter.username ?? (row.withheld ? 'Reporter' : `User #${report.reporter.id}`)}
                · {shortAge(report.createdAt)} ago
              </span>
            </div>
            {#if report.comment}
              <p class="m-0 wrap-anywhere whitespace-pre-wrap text-dark-0">{report.comment}</p>
            {/if}
          </li>
        {/each}
      </ul>
    </TriageCard>

    {#if !row.withheld}
      <!-- A failed read is reported once, in the middle column. -->
      {#await details}
        <p class="m-0 text-sm text-dark-2">Loading the cover, checks and owner…</p>
      {:then d}
        <TriageCard title="Cover" dense>
          {#if d.cover}
            <div class="flex items-center gap-3">
              <div class="size-14 shrink-0 overflow-hidden rounded-md border border-dark-4 bg-dark-6">
                {#if d.cover.url}
                  <EdgeImage src={d.cover.url} width={160} alt="" class="size-full object-cover" />
                {/if}
              </div>
              <div class="min-w-0 space-y-1">
                <p class="m-0 font-medium text-white">Cover of this song</p>
                <div class="flex flex-wrap gap-1">
                  {@render chip(d.cover.nsfwLevel ? getBrowsingLevelLabel(d.cover.nsfwLevel) : 'Not rated')}
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
                  {#if !d.cover.shown}{@render chip('Placeholder shown')}{/if}
                </div>
              </div>
            </div>
          {:else}
            <p class="m-0 text-dark-2">No cover: the player shows the placeholder.</p>
          {/if}
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
      {:catch}
        <!-- Reported in the middle column. -->
      {/await}
    {/if}
  {/snippet}
</TriageColumns>
