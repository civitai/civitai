<script lang="ts">
  import { browser } from '$app/environment';
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { tick } from 'svelte';
  import { IconExternalLink, IconMusic, IconUser } from '@tabler/icons-svelte';
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
    reportedDecisionsEnabled,
    songDetailsUrl,
    songRatingLabel,
    SONG_RATING_LEVELS,
    type CheckState,
    type ReportedSongRow,
    type SongDetails,
  } from '$lib/audio-review';
  import { entityUrl, userUrl } from '$lib/entity-url';
  import { fetchJson } from '$lib/fetch-json';
  import { dateTime, LINK_BUTTON, LINK_CLASS, plural, shortAge } from '$lib/format';
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
    ratingOpen,
    onrate,
    oncloserating,
  }: {
    row: ReportedSongRow;
    civitaiUrl: string;
    canAct: boolean;
    verdict: string | undefined;
    error: string | undefined;
    submit: (outcome: Outcome) => SubmitFunction;
    actionHref: (action: string) => string;
    /** Key 4 was pressed: the next digit picks the level. */
    ratingOpen: boolean;
    onrate: () => void;
    oncloserating: () => void;
  } = $props();

  // Client only: the shell remounts this per song, so each song reads its own details once. The
  // player stays mounted while they load; only its line under the title waits for them.
  let loaded = $state<SongDetails | null>(null);
  const details = $derived(
    browser
      ? fetchJson<SongDetails>(songDetailsUrl(row.id)).then((d) => (loaded = d))
      : SSR_PENDING
  );

  const enabled = $derived(reportedDecisionsEnabled(row, canAct));
  const reportIds = $derived(row.reports.map((r) => r.id).join(','));
  const owner = $derived(row.owner);
  const songHref = $derived(entityUrl(civitaiUrl, 'image', row.id));
  const removed = $derived(row.ingestion === 'Blocked');

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
  let ratedLevel = $state<number | null>(null);
  const level = $derived(ratedLevel ?? row.nsfwLevel);
  const rate = optimisticEnhancer(({ formData }) => {
    const previous = ratedLevel;
    ratedLevel = Number(formData.get('nsfwLevel'));
    oncloserating();
    return () => (ratedLevel = previous);
  });

  const CHECK_LOOK: Record<CheckState, { label: string; class: string }> = {
    passed: { label: 'passed', class: 'bg-green-500/15 text-green-300' },
    blocked: { label: 'blocked', class: 'bg-red-500/15 text-red-300' },
    held: { label: 'held', class: 'bg-amber-500/15 text-amber-300' },
    pending: { label: 'not finished', class: 'bg-dark-5 text-dark-0' },
    failed: { label: 'failed', class: 'bg-dark-5 text-dark-0' },
  };

  const factsLine = (d: SongDetails | null) =>
    [
      d?.facts.durationSec ? formatPlaybackTime(d.facts.durationSec) : null,
      d?.facts.genre,
      d?.facts.postedAt ? `posted ${new Date(d.facts.postedAt).toLocaleDateString()}` : null,
    ]
      .filter(Boolean)
      .join(' · ');

  const accountAge = (createdAt: Date | string | null) =>
    createdAt ? shortAge(createdAt) : 'unknown';
</script>

{#snippet chip(text: string, tone = 'bg-dark-5 text-dark-0')}
  <span class="rounded px-1.5 py-px text-[11px] font-medium {tone}">{text}</span>
{/snippet}

{#snippet fact(label: string, value: string | null | undefined)}
  <div class="flex justify-between gap-3 py-0.5">
    <span class="shrink-0 text-dark-2">{label}</span>
    <span class="min-w-0 text-right wrap-anywhere text-dark-0">{value || '—'}</span>
  </div>
{/snippet}

{#snippet decision()}
  <form
    method="POST"
    action={actionHref('dismiss')}
    data-triage-action="dismiss"
    id="dismiss-{row.id}"
    use:enhance={submit('Reports dismissed')}
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
    hint="J / K next and previous · 1 to 4 decide. Remove song asks for a violation type. Dismiss closes all {plural(
      row.reports.length,
      'report'
    )}."
  >
    {#snippet buttons()}
      <TriageKeyButton key={1} type="submit" form="dismiss-{row.id}" disabled={!enabled[0]}>
        Dismiss reports
      </TriageKeyButton>
      <TriageKeyButton
        key={2}
        primary
        type="submit"
        form="remove-{row.id}"
        disabled={!enabled[1]}
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
        class="flex flex-wrap items-center gap-1.5"
      >
        <input type="hidden" name="imageId" value={row.id} />
        <span class="mr-1 text-xs text-dark-2">Rating</span>
        {#each SONG_RATING_LEVELS as option, i (option)}
          <button
            type="submit"
            name="nsfwLevel"
            value={option}
            disabled={!enabled[3] || level === option}
            class={cn(
              'rounded border px-2 py-0.5 text-xs font-semibold disabled:cursor-default',
              level === option
                ? 'border-blue-500 bg-blue-600 text-white'
                : 'border-dark-4 text-dark-0 hover:border-dark-2'
            )}
          >
            {#if ratingOpen}<span class="mr-1 text-dark-2">{i + 1}</span>{/if}{songRatingLabel(option)}
          </button>
        {/each}
        {#if ratingOpen}<span class="text-[11px] text-dark-2">1 to 5 picks · Esc cancels</span>{/if}
      </form>
    {/snippet}
    {#snippet fields()}
      <Select.Root type="single" bind:value={violationType}>
        <Select.Trigger
          bind:ref={violationSelect}
          aria-label="Violation type"
          class="h-[30px] w-auto min-w-0 flex-1 basis-0 justify-between border-dark-4 bg-dark-7 text-[13px] text-dark-0 dark:bg-dark-7"
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
        {@render chip('Reported', 'bg-red-500/15 text-red-300')}
        {#if !row.withheld}{@render chip(getBrowsingLevelLabel(level))}{/if}
        {@render chip(plural(row.reportCount, 'report'))}
        {#if removed}{@render chip('Removed')}{/if}
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
              <IconMusic aria-hidden="true" /> Owner's songs
            </Button>
          {/if}
        {/if}
      {/snippet}
    </TriageDetailHeader>
  {/snippet}

  {#snippet evidence()}
    <div class="space-y-3">
    {#if row.withheld || !row.url}
      <div class="space-y-2 rounded-lg border border-dark-4 bg-dark-7 p-3.5 text-sm text-dark-0">
        <p class="m-0">
          This song is withheld from you: its audio, lyrics, cover and owner are not shown here.
        </p>
        <a href="/csam/text-holds?status=all&q={row.id}" class={LINK_CLASS}>Open in CSAM holds</a>
      </div>
    {:else}
      <SongCard item={{ id: row.id, url: row.url }} variant="detail" meta={factsLine(loaded)} />
      {#await details then d}
        <TriageCard title="Song" dense>
          {@render fact(
            'Length',
            d.facts.durationSec ? formatPlaybackTime(d.facts.durationSec) : null
          )}
          {@render fact('Genre', d.facts.genre)}
          <div class="flex justify-between gap-3 py-0.5">
            <span class="text-dark-2">Posted</span>
            <span class="text-dark-0">
              {d.facts.postedAt ? new Date(d.facts.postedAt).toLocaleDateString() : 'Not posted'}
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
          {@render fact('Rating', getBrowsingLevelLabel(level))}
          {@render fact('Remix', d.facts.allowRemix ? 'Allowed' : 'Not allowed')}
        </TriageCard>
      {:catch}
        <p class="m-0 text-sm text-dark-2">Couldn't load this song's details.</p>
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
      {#await details}
        <p class="m-0 text-sm text-dark-2">Loading the song's details…</p>
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
                    {@render chip(CHECK_LOOK[d.checks.cover].label, CHECK_LOOK[d.checks.cover].class)}
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
              <div class="flex justify-between gap-3 py-0.5">
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
            {@render fact('Account age', accountAge(d.owner.createdAt))}
            {@render fact('Removed songs', String(d.owner.removedSongs))}
            {@render fact('Active strikes', String(d.owner.strikes))}
            {@render fact('Other reported songs', String(d.owner.otherReported))}
          </TriageCard>
        {/if}
      {:catch}
        <p class="m-0 text-sm text-dark-2">Couldn't load the cover, checks and owner.</p>
      {/await}
    {/if}
  {/snippet}
</TriageColumns>
