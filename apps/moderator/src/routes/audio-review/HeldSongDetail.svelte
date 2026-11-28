<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { IconExternalLink, IconFlag, IconLock, IconSearch, IconUser } from '@tabler/icons-svelte';
  import { getBrowsingLevelLabel } from '@civitai/shared';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import CdnOrRetractedMedia from '$lib/components/image-queue/CdnOrRetractedMedia.svelte';
  import SongBadge from '$lib/components/SongBadge.svelte';
  import SongCard from '$lib/components/SongCard.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import TriageColumns from '$lib/components/triage/TriageColumns.svelte';
  import TriageDecisionBar from '$lib/components/triage/TriageDecisionBar.svelte';
  import TriageDetailHeader from '$lib/components/triage/TriageDetailHeader.svelte';
  import TriageKeyButton from '$lib/components/triage/TriageKeyButton.svelte';
  import {
    HELD_DECISION_LABELS,
    heldDecisions,
    heldDecisionsEnabled,
    lyricsHoldHref,
    songRatingLabel,
    SONG_RATING_LEVELS,
    songTitle,
    type HeldSongRow,
  } from '$lib/audio-review';
  import { entityUrl, userUrl } from '$lib/entity-url';
  import { dateTime, LINK_BUTTON, LINK_CLASS, shortAge, shortDate } from '$lib/format';
  import { optimisticEnhancer } from '$lib/form-action';
  import { reviewReasonText } from '$lib/image-review';
  import { removedCovers } from '$lib/music/removed-covers';
  import { songDetails } from '$lib/music/song-details.svelte';
  import type { Outcome } from '$lib/triage/queue';
  import SongSideCards from './SongSideCards.svelte';
  import SongWithheldNotice from './SongWithheldNotice.svelte';
  import { createViolationGate } from './violation-gate.svelte';
  import ViolationPicker, { violationInputs } from './ViolationPicker.svelte';

  // A lyrics hold shows nothing of its song: it is decided in CSAM holds.
  let {
    row,
    civitaiUrl,
    canAct,
    canOpenHolds,
    verdict,
    error,
    submit,
    actionHref,
    level,
    ratingOpen,
    onrate,
    onrated,
  }: {
    row: HeldSongRow;
    civitaiUrl: string;
    canAct: boolean;
    /** May open CSAM holds: its page grant and `csam.report.file`. */
    canOpenHolds: boolean;
    verdict: string | undefined;
    error: string | undefined;
    submit: (outcome: Outcome) => SubmitFunction;
    actionHref: (action: string) => string;
    /** The song's rating, including one set on this page since it loaded. */
    level: number | null;
    /** Set rating was pressed: the next digit picks the level. */
    ratingOpen: boolean;
    onrate: () => void;
    /** A rating was sent (the level), or refused (null: back to the loaded one). */
    onrated: (level: number | null) => void;
  } = $props();

  const isLyrics = $derived(row.kind === 'lyrics');
  const open = $derived(!row.withheld);
  const details = songDetails(() => (open ? row.id : null), 'held');
  const actions = $derived(heldDecisions(row.kind));
  const enabled = $derived(heldDecisionsEnabled(row, canAct, canOpenHolds));
  const on = (action: string) => enabled[actions.indexOf(action)] ?? false;
  const keyOf = (action: string) => actions.indexOf(action) + 1;
  const owner = $derived(row.owner);
  const songHref = $derived(entityUrl(civitaiUrl, 'image', row.id));
  const coverRemoved = $derived(!!row.cover && removedCovers.has(row.cover.id));
  const flag = $derived(row.kind === 'cover' ? row.cover?.flag ?? null : row.flag);

  const KIND_CHIP = { lyrics: 'Lyrics held', cover: 'Cover flagged', song: 'Song flagged' };
  const why = $derived(
    isLyrics
      ? 'The lyrics were held for child safety review. What was found is only shown in CSAM holds.'
      : row.kind === 'cover'
      ? `The cover is held for review: ${flag ? reviewReasonText(flag) : 'flagged.'} The song is not.`
      : `The song is held for review: ${flag ? reviewReasonText(flag) : 'flagged.'}`
  );

  const violation = createViolationGate();
  const removeSongSubmit: SubmitFunction = async (input) => {
    if (await violation.gate(input)) return submit('Song removed')(input);
  };
  // Not a verdict on a song row (its flag is still to decide), so the row stays open there; on a
  // cover row removing the cover settles what held it.
  const removeCoverSubmit: SubmitFunction = async (input) => {
    if (!(await violation.gate(input))) return;
    if (row.kind === 'cover') return submit('Cover removed')(input);
    return async ({ result, update }) => {
      if (result.type === 'success') {
        const held = result.data?.held;
        if (typeof held === 'string') violation.problem = held;
        else if (typeof result.data?.coverId === 'number') removedCovers.add(result.data.coverId);
      }
      await update({ invalidateAll: false });
    };
  };

  // A rating is a correction, not a verdict: the song stays open, its hold still to decide.
  const rate = optimisticEnhancer(({ formData }) => {
    onrated(Number(formData.get('nsfwLevel')));
    return () => onrated(null);
  });

  const FACT_ROW = 'grid grid-cols-[92px_1fr] gap-3 py-0.5';
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

{#snippet lyricsDecision()}
  <div class="flex w-full flex-col gap-2">
    {#if !canOpenHolds}
      <p
        role="note"
        class="m-0 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
      >
        You don't have access to CSAM holds. Ask a team lead for the grant.
      </p>
    {/if}
    {#if canOpenHolds}
      <TriageKeyButton key={1} tone="blue" href={lyricsHoldHref(row.id)} class="w-full justify-center">
        <IconLock size={14} aria-hidden="true" /> Open in CSAM holds
      </TriageKeyButton>
    {:else}
      <TriageKeyButton key={1} tone="blue" type="button" disabled class="w-full justify-center">
        <IconLock size={14} aria-hidden="true" /> Open in CSAM holds
      </TriageKeyButton>
    {/if}
    <p class="m-0 line-clamp-2 text-[11px] text-dark-2">
      J/K next and previous. A lyrics hold is decided in CSAM holds. Nothing you do here changes this
      song.
    </p>
  </div>
{/snippet}

{#snippet approveButton(action: 'approveCover' | 'approveSong')}
  <TriageKeyButton
    key={keyOf(action)}
    tone="blue"
    type="submit"
    form="{action}-{row.id}"
    disabled={!on(action)}
    class={cn(ratingOpen && 'opacity-50')}
  >
    {action === 'approveCover' ? 'Approve cover' : 'Approve song'}
  </TriageKeyButton>
{/snippet}

{#snippet removeCoverButton()}
  <TriageKeyButton
    key={keyOf('removeCover')}
    type="submit"
    form="remove-cover-{row.id}"
    tone="red-outline"
    disabled={!on('removeCover')}
    class={cn(ratingOpen && 'opacity-50')}
    title={on('removeCover')
      ? 'Removes only the cover: the song stays up with the placeholder'
      : 'No cover to remove'}
  >
    Remove cover
  </TriageKeyButton>
{/snippet}

{#snippet removeSongButton()}
  <TriageKeyButton
    key={keyOf('removeSong')}
    primary
    type="submit"
    form="remove-song-{row.id}"
    disabled={!on('removeSong')}
    class={cn(ratingOpen && 'opacity-50')}
  >
    Remove song
  </TriageKeyButton>
{/snippet}

{#snippet decision()}
  <!-- `contents`: the hidden forms take no room in the column; their buttons post through `form=`. -->
  {#each ['approveCover', 'approveSong'] as action (action)}
    <form
      class="contents"
      method="POST"
      action={actionHref(action)}
      data-triage-action={action}
      id="{action}-{row.id}"
      use:enhance={submit(action === 'approveCover' ? 'Cover approved' : 'Song approved')}
    >
      <input type="hidden" name="imageId" value={row.id} />
      <input type="hidden" name="needsReview" value={flag ?? ''} />
      {#if action === 'approveCover' && row.cover}
        <input type="hidden" name="coverId" value={row.cover.id} />
      {/if}
    </form>
  {/each}
  <form
    class="contents"
    method="POST"
    action={actionHref('removeSong')}
    data-triage-action="removeSong"
    id="remove-song-{row.id}"
    use:enhance={removeSongSubmit}
  >
    <input type="hidden" name="imageId" value={row.id} />
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
      ? 'Rating: 1 to 5 picks the level · Esc cancels.'
      : row.kind === 'cover'
      ? 'J/K next and previous · 1 to 4 decide. Approve cover lets its cover go public.'
      : 'J/K next and previous · 1 to 4 decide. Remove song and Remove cover ask for a violation type.'}
  >
    {#snippet buttons()}
      {#if row.kind === 'cover'}
        {@render approveButton('approveCover')}
        {@render removeCoverButton()}
        {@render removeSongButton()}
      {:else}
        {@render approveButton('approveSong')}
        {@render removeSongButton()}
        {@render removeCoverButton()}
      {/if}
      <TriageKeyButton
        key={keyOf('rate')}
        type="button"
        tone={ratingOpen ? 'blue' : undefined}
        disabled={!on('rate')}
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
            disabled={!on('rate') || level === option}
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

<TriageColumns
  {verdict}
  {error}
  decision={isLyrics ? lyricsDecision : open && !row.resolved ? decision : undefined}
>
  {#snippet header()}
    <TriageDetailHeader title={songTitle(row)} reference="#{row.id}">
      {#snippet chips()}
        <SongBadge class="h-[17px] px-1.5 text-[11px]" />
        {#if row.resolved}
          {@render chip(
            row.decision
              ? `Resolved: ${HELD_DECISION_LABELS[row.decision.decision] ?? row.decision.decision}`
              : 'Resolved'
          )}
        {:else}
          {@render chip('Held', 'bg-amber-500/15 text-amber-300')}
        {/if}
        <span
          class="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-px text-[11px] font-medium text-amber-300"
        >
          {#if isLyrics}<IconLock size={11} aria-hidden="true" />{:else}<IconFlag
              size={11}
              aria-hidden="true"
            />{/if}{KIND_CHIP[row.kind]}
        </span>
        {#if open && level !== null}{@render chip(getBrowsingLevelLabel(level))}{/if}
        {#if row.removed}{@render chip('Removed')}{/if}
      {/snippet}
      {#snippet links()}
        {#if open}
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
    {#if row.decision}
      <p class="m-0 mt-1 text-[13px] text-dark-2" title={dateTime(row.decision.at)}>
        {HELD_DECISION_LABELS[row.decision.decision] ?? row.decision.decision}
        {row.decision.by ? `by ${row.decision.by}` : ''} · {shortDate(row.decision.at)} · flag
        {row.decision.flag || 'unknown'}
      </p>
    {/if}
  {/snippet}

  {#snippet evidence()}
    <div class="space-y-3">
      {#if isLyrics}
        <div
          class="flex flex-col items-center gap-2 rounded-lg border border-dark-4 bg-dark-7 px-5 py-6 text-center"
        >
          <IconLock class="size-7 text-dark-0" aria-hidden="true" />
          <p class="m-0 text-base font-semibold text-white">Song withheld</p>
          <p class="m-0 text-sm text-dark-0">
            The lyrics are held for child safety review. The audio, cover and lyrics are not shown
            here. They are reviewed in CSAM holds, which needs its own access.
          </p>
        </div>
        <TriageCard title="Song" dense>
          {@render fact('Held since', `${shortDate(row.waitingSince)} · ${shortAge(row.waitingSince)} ago`)}
        </TriageCard>
      {:else if row.withheld}
        <SongWithheldNotice
          subject="song or its cover"
          hidden="its audio, lyrics, cover and owner"
        />
      {:else}
        {#if row.cover}
          <TriageCard title="Cover under review" dense>
            {#if coverRemoved}
              <p class="m-0 text-dark-2">Removed: the song shows the placeholder.</p>
            {:else}
              <div class="overflow-hidden rounded-md border border-dark-4 bg-dark-6">
                <CdnOrRetractedMedia
                  item={{ id: row.cover.id, url: row.cover.url, type: 'image' }}
                  width={640}
                  class="max-h-[320px] w-full object-contain"
                />
              </div>
              <div class="mt-2 flex flex-wrap gap-1.5">
                {@render chip('Cover scan: held', 'bg-amber-500/15 text-amber-300')}
                {@render chip('Not public until reviewed')}
              </div>
            {/if}
          </TriageCard>
        {/if}
        {#if row.url}
          <SongCard item={{ id: row.id, url: row.url }} variant="detail" />
        {:else}
          <p class="m-0 text-sm text-dark-2">No audio file.</p>
        {/if}
        <!-- The one place a failed read is reported; the sidebar's cards just stay away. -->
        {#await details.current}
          <p class="m-0 text-sm text-dark-2">Loading the song's details…</p>
        {:then d}
          <TriageCard title="Song" dense>
            {@render fact('Genre', d.facts.genre)}
            <div class={FACT_ROW}>
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
            {@render fact('Remix', d.facts.allowRemix ? 'Allowed' : 'Not allowed')}
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
    <TriageCard title="Why it is held" dense accent="amber">
      <p class="m-0 text-dark-0" title={dateTime(row.waitingSince)}>{why}</p>
    </TriageCard>
    {#if isLyrics}
      <TriageCard title="Owner" dense>
        <p class="m-0 text-dark-0">Owner details are shown in CSAM holds.</p>
      </TriageCard>
    {:else if open}
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
