<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import type { Snippet } from 'svelte';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import { LINK_CLASS, dateTime, shortAge } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import type { MinorFlagAppealRow } from '$lib/server/minor-hash.service';
  import { sourceLabel } from '$lib/minor-flags/appeal-filters';
  import { clipList, pastAppealsText, shouldBlurThumbnail } from '$lib/minor-flags/appeal-row';
  import { isOpenVerdict, flagsOf, openVerdicts } from '$lib/minor-flags/text-scan-verdicts';

  let {
    row,
    civitaiUrl,
    verdict,
    canExpand,
    expanded,
    ontoggle,
    submit,
    detail,
  }: {
    row: MinorFlagAppealRow;
    civitaiUrl: string;
    /** The outcome already chosen for this row, shown in place of the actions. */
    verdict: string | undefined;
    canExpand: boolean;
    expanded: boolean;
    ontoggle: () => void;
    submit: (modelId: number, verdict: string) => SubmitFunction;
    detail: Snippet;
  } = $props();

  const modelHref = $derived(`${civitaiUrl}/models/${row.modelId}?view=basic`);
  const poiOpen = $derived(row.poi && isOpenVerdict(flagsOf(row.textScanFlags)?.poi));
  const tags = $derived(clipList(row.tags, 8));
  const words = $derived(clipList(row.trainedWords, 6));
  const ago = (value: Date | string) => `${shortAge(value)} ago`;
</script>

<li
  class={cn(
    'rounded-lg border border-dark-4 bg-dark-6 p-4 transition-opacity',
    verdict && 'opacity-50'
  )}
>
  <div class="flex gap-4">
    {#if row.coverImages.length}
      <div class="flex shrink-0 gap-1">
        {#each row.coverImages as image (image.id)}
          <a
            href={modelHref}
            target="_blank"
            rel="noreferrer"
            class="block h-20 w-20 overflow-hidden rounded-md border border-dark-4 bg-dark-7"
          >
            <EdgeMedia
              src={image.url}
              type="image"
              width={96}
              blur={shouldBlurThumbnail(image.nsfwLevel) ? 40 : undefined}
              class="h-full w-full object-cover"
            />
          </a>
        {/each}
      </div>
    {/if}

    <div class="min-w-0 flex-1">
      <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <a href={modelHref} target="_blank" rel="noreferrer" class="font-medium {LINK_CLASS}">
          {row.modelName}
        </a>
        <code class="text-xs text-dark-2">#{row.modelId}</code>
        <Badge variant="secondary">{row.status}</Badge>
        {#if row.minor}<Badge variant="destructive">Minor</Badge>{/if}
        {#if row.poi}<Badge variant="destructive">Real person</Badge>{/if}
        {#if !row.minor && !row.poi}
          <!-- Reverting from the Auto-flagged tab leaves the appeal open; the row has to say the
               flag is already gone or a moderator upholds against nothing. -->
          <Badge variant="outline">No longer flagged</Badge>
        {/if}
        <Badge variant="outline">{sourceLabel(row.flagSource, row.flagConfirmedFrom)}</Badge>
      </div>

      <p class="mt-1 text-xs text-dark-2">
        <span title={dateTime(row.appealCreatedAt)}>Appealed {ago(row.appealCreatedAt)}</span>
        {#if row.flaggedAt}
          · <span title={dateTime(row.flaggedAt)}>flagged {ago(row.flaggedAt)}</span>
        {/if}
        {#if row.flagSource === 'manual' && row.flaggedByUsername}
          · set by {row.flaggedByUsername}
          {#if row.flaggedByAt}<span title={dateTime(row.flaggedByAt)}>
              {ago(row.flaggedByAt)}</span
            >{/if}
        {/if}
      </p>

      <p class="mt-1 text-xs text-dark-2">
        {row.modelType}{row.baseModel ? ` · ${row.baseModel}` : ''} ·
        <span title={dateTime(row.modelCreatedAt)}>uploaded {ago(row.modelCreatedAt)}</span>
      </p>

      {#if tags.shown.length}
        <p class="mt-1 flex flex-wrap gap-1">
          {#each tags.shown as tag (tag)}
            <Badge variant="secondary" class="max-w-40 truncate">{tag}</Badge>
          {/each}
          {#if tags.more}<span class="text-xs text-dark-2">+{tags.more}</span>{/if}
        </p>
      {/if}
      {#if words.shown.length}
        <p class="mt-1 line-clamp-1 text-xs break-all text-dark-2">
          Trigger words: {words.shown.join(', ')}{words.more ? ` +${words.more}` : ''}
        </p>
      {/if}

      <p class="mt-1 text-xs text-dark-2">
        {#if row.username}
          <a href={userLookupUrl(row.userId)} class={LINK_CLASS}>{row.username}</a>
        {:else}
          user #{row.userId}
        {/if}
        · {row.otherFlaggedModels} other flagged model{row.otherFlaggedModels === 1 ? '' : 's'}
        · past appeals: {pastAppealsText(row.pastAppeals)}
      </p>
    </div>
  </div>

  {#if row.appealMessage}
    <p class="mt-2 rounded-md bg-dark-7 p-2 text-sm text-dark-0">{row.appealMessage}</p>
  {/if}

  {#each openVerdicts(row.textScanFlags) as { label, flag } (label)}
    {#if flag.reason}
      <p class="mt-2 text-xs text-dark-2">
        <Badge variant="outline">text scan · {label === 'poi' ? 'real person' : 'minor'}</Badge>
        {flag.reason}
        {#if flag.names?.length}
          — {flag.names.join(', ')}
        {/if}
      </p>
    {/if}
  {/each}

  {#if row.prevNsfw != null || row.prevGalleryLevel != null}
    <p class="mt-1 text-xs text-dark-2">
      Before the flag: NSFW {row.prevNsfw ? 'on' : 'off'}{row.prevGalleryLevel != null
        ? `, gallery level ${row.prevGalleryLevel}`
        : ''}
    </p>
  {/if}

  <div class="mt-3 flex flex-wrap items-center gap-2">
    {#if canExpand}
      <Button size="xs" variant="outline" onclick={ontoggle}>
        {expanded ? 'Hide detail' : 'Detail'}
      </Button>
    {/if}

    {#if verdict}
      <span class="text-sm text-dark-2">{verdict}</span>
    {:else}
      <form method="POST" action="?/upholdAppeal" use:enhance={submit(row.modelId, 'Appeal rejected')}>
        <input type="hidden" name="modelId" value={row.modelId} />
        <Button type="submit" size="xs">Uphold flag</Button>
      </form>
      <form
        method="POST"
        action="?/overturnAppeal"
        use:enhance={submit(row.modelId, 'Appeal approved')}
      >
        <input type="hidden" name="modelId" value={row.modelId} />
        <Button type="submit" size="xs" variant="destructive">Overturn</Button>
      </form>
      {#if row.minor && poiOpen}
        <form
          method="POST"
          action="?/splitAppeal"
          use:enhance={submit(row.modelId, 'Kept minor, lifted real person')}
        >
          <input type="hidden" name="modelId" value={row.modelId} />
          <input type="hidden" name="minor" value="uphold" />
          <input type="hidden" name="poi" value="overturn" />
          <Button type="submit" size="xs" variant="outline">Keep minor, lift real person</Button>
        </form>
        <form
          method="POST"
          action="?/splitAppeal"
          use:enhance={submit(row.modelId, 'Lifted minor, kept real person')}
        >
          <input type="hidden" name="modelId" value={row.modelId} />
          <input type="hidden" name="minor" value="overturn" />
          <input type="hidden" name="poi" value="uphold" />
          <Button type="submit" size="xs" variant="outline">Lift minor, keep real person</Button>
        </form>
      {/if}
    {/if}
  </div>

  {#if expanded}
    {@render detail()}
  {/if}
</li>
