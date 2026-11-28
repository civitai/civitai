<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import {
    IconExternalLink,
    IconFlag,
    IconPlayerPlay,
    IconSearch,
    IconUser,
  } from '@tabler/icons-svelte';
  import { formatPlaybackTime, getBrowsingLevelLabel } from '@civitai/shared';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { cn } from '@civitai/ui/utils.js';
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
    songActivityText,
    songRemovedTitle,
    songRatingLabel,
    SONG_RATING_LEVELS,
    type ReportedSongRow,
  } from '$lib/audio-review';
  import { entityUrl, userUrl } from '$lib/entity-url';
  import { dateTime, LINK_BUTTON, LINK_CLASS, plural, shortAge, shortDate } from '$lib/format';
  import { optimisticEnhancer } from '$lib/form-action';
  import type { Outcome } from '$lib/triage/queue';
  import { removedCovers } from '$lib/music/removed-covers';
  import { songDetails } from '$lib/music/song-details.svelte';
  import { playSongAt } from '$lib/music/song-player';
  import SongSideCards from './SongSideCards.svelte';
  import SongWithheldNotice from './SongWithheldNotice.svelte';
  import { createViolationGate } from './violation-gate.svelte';
  import ViolationPicker, { violationInputs } from './ViolationPicker.svelte';

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

  const details = songDetails(() => (row.withheld ? null : row.id), 'reported');

  const enabled = $derived(reportedDecisionsEnabled(row, canAct));
  const reportIds = $derived(row.reports.map((r) => r.id).join(','));
  const owner = $derived(row.owner);
  const songHref = $derived(entityUrl(civitaiUrl, 'image', row.id));
  const dismiss = $derived(dismissDecision(row));
  const playable = $derived(!row.withheld && !!row.url);

  const violation = createViolationGate();
  const removeSubmit: SubmitFunction = async (input) => {
    if (await violation.gate(input)) return submit('Song removed')(input);
  };

  // Not a verdict on the song, whose reports stay open, so the song stays open too. A held removal
  // leaves the cover up.
  const removeCoverSubmit: SubmitFunction = async (input) => {
    if (!(await violation.gate(input))) return;
    return async ({ result, update }) => {
      if (result.type === 'success') {
        const held = result.data?.held;
        if (typeof held === 'string') violation.problem = held;
        else if (typeof result.data?.coverId === 'number') removedCovers.add(result.data.coverId);
      }
      await update({ invalidateAll: false });
    };
  };

  // A rating is a correction, not a verdict: the song stays open, its reports still to decide.
  const rate = optimisticEnhancer(({ formData }) => {
    onrated(Number(formData.get('nsfwLevel')));
    return () => onrated(null);
  });

  const FACT_ROW = 'grid grid-cols-[104px_1fr] gap-3 py-0.5';
  const SONG_FACT_ROW = 'grid grid-cols-[92px_1fr] gap-3 py-0.5';

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
  <!-- `contents`: the hidden forms take no room in the column; their buttons post through `form=`. -->
  <form
    class="contents"
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
    class="contents"
    method="POST"
    action={actionHref('remove')}
    data-triage-action="remove"
    id="remove-{row.id}"
    use:enhance={removeSubmit}
  >
    <input type="hidden" name="imageId" value={row.id} />
    <input type="hidden" name="reportIds" value={reportIds} />
    {@render violationInputs(violation)}
  </form>
  <form
    class="contents"
    method="POST"
    action={actionHref('removeCover')}
    data-triage-action="removeCover"
    id="remove-cover-{row.id}"
    use:enhance={removeCoverSubmit}
  >
    <input type="hidden" name="imageId" value={row.id} />
    <input type="hidden" name="coverId" value={row.removableCoverId ?? ''} />
    {@render violationInputs(violation)}
  </form>
  <TriageDecisionBar
    compact
    problem={violation.problem}
    hint={ratingOpen
      ? 'Rating: 1 to 5 picks the level · Esc cancels. A rating leaves the reports open.'
      : 'J/K to move · 1 to 4 decide. Remove song and Remove cover ask for a violation type; ' +
        'Remove cover leaves the reports open.'}
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
        type="submit"
        form="remove-cover-{row.id}"
        tone="red-outline"
        disabled={!enabled[2]}
        class={cn(ratingOpen && 'opacity-50')}
        title={enabled[2]
          ? 'Removes only the cover: the song stays up with the placeholder'
          : 'No cover to remove'}
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
      <ViolationPicker gate={violation} />
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
        <SongWithheldNotice subject="song" hidden="its audio, lyrics, cover and owner" />
      {:else if !row.url}
        <p class="m-0 text-sm text-dark-2">No audio file.</p>
      {:else}
        <SongCard item={{ id: row.id, url: row.url }} variant="detail" reports={row.reports} />
      {/if}
      {#if !row.withheld}
        <!-- The one place a failed read is reported; the sidebar's cards just stay away. -->
        {#await details.current}
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
            {#if d.activity}
              {@render fact('Activity', songActivityText(d.activity), SONG_FACT_ROW)}
            {/if}
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
              {#if report.timeSec != null && playable}
                {@const at = report.timeSec}
                <button
                  type="button"
                  class="inline-flex items-center gap-0.5 rounded bg-blue-500/15 px-1.5 py-px text-[11px] font-medium text-blue-300 hover:bg-blue-500/25"
                  title="Play from {formatPlaybackTime(at)}"
                  onclick={() => playSongAt(row.id, at)}
                >
                  <IconPlayerPlay size={11} aria-hidden="true" />{formatPlaybackTime(at)}
                </button>
              {:else if report.timeSec != null}
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
      {#await details.current}
        <p class="m-0 text-sm text-dark-2">Loading the cover, checks and owner…</p>
      {:then d}
        <SongSideCards details={d} {civitaiUrl} />
      {:catch}
        <!-- Reported in the middle column. -->
      {/await}
    {/if}
  {/snippet}
</TriageColumns>
