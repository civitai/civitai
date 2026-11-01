<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { articleUnpublishReasonLabel } from '$lib/article-unpublish-reasons';
  import { articleLookupUrl, modelLookupUrl, userLookupUrl } from '$lib/entity-url';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { modelUnpublishReasonLabel } from '$lib/model-unpublish-reasons';
  import type { SiteAppealRow } from '$lib/server/site-appeals.service';

  let { row, civitaiUrl }: { row: SiteAppealRow; civitaiUrl: string } = $props();

  const subject = $derived(row.subject);
  const atFiling = $derived(row.context?.restriction);
</script>

{#if subject.kind === 'account'}
  <TriageCard title="The account now">
    <div class="space-y-2 text-base text-dark-0">
      <div class="flex flex-wrap gap-1.5">
        {#if subject.bannedAt}<Badge variant="destructive">Banned</Badge>{/if}
        {#if subject.muted}<Badge variant="secondary">Muted</Badge>{/if}
        {#if !subject.bannedAt && !subject.muted}<Badge variant="outline">Not restricted</Badge>{/if}
      </div>
      {#if subject.bannedAt}
        <p class="m-0 text-sm">
          Banned {dateTime(subject.bannedAt)}{subject.banReason ? ` · ${subject.banReason}` : ''}
        </p>
        {#if subject.banDetailsExternal}
          <p class="m-0 text-sm">Told them: {subject.banDetailsExternal}</p>
        {/if}
        {#if subject.banDetailsInternal}
          <p class="m-0 text-sm text-dark-2">Internal: {subject.banDetailsInternal}</p>
        {/if}
      {/if}
      {#if subject.muted}
        <p class="m-0 text-sm">
          Muted{subject.muteExpiresAt ? ` until ${dateTime(subject.muteExpiresAt)}` : ''}{subject.muteReason
            ? ` · ${subject.muteReason}`
            : ''}
        </p>
      {/if}
      {#if atFiling}
        <p class="m-0 text-sm text-dark-2">
          When filed: {[atFiling.banned && 'banned', atFiling.muted && 'muted']
            .filter(Boolean)
            .join(' and ') || 'not restricted'}
        </p>
      {/if}
      <a href={userLookupUrl(row.userId)} class="text-sm {LINK_CLASS}">Open in User Lookup</a>
    </div>
  </TriageCard>
{:else if subject.kind === 'article' || subject.kind === 'model'}
  {@const isModel = subject.kind === 'model'}
  {@const reasonLabel = subject.unpublishedReason
    ? isModel
      ? modelUnpublishReasonLabel(subject.unpublishedReason)
      : articleUnpublishReasonLabel(subject.unpublishedReason)
    : null}
  <TriageCard title={isModel ? 'The model now' : 'The article now'}>
    <div class="space-y-2 text-base text-dark-0">
      {#if subject.status && !(subject.kind === 'model' && subject.deleted)}
        <p class="m-0">
          <a
            href="{civitaiUrl}/{isModel ? 'models' : 'articles'}/{row.entityId}"
            target="_blank"
            rel="noreferrer"
            class={LINK_CLASS}
          >
            {(subject.kind === 'model' ? subject.name : subject.title) ?? `#${row.entityId}`} ↗
          </a>
          <Badge variant="secondary" class="ml-1">{subject.status}</Badge>
        </p>
      {:else}
        <p class="m-0">#{row.entityId} no longer exists.</p>
      {/if}
      {#if reasonLabel}
        <p class="m-0 text-sm">
          Unpublished for: {reasonLabel}
          {#if subject.unpublishedAt}
            <span class="text-dark-2">· {dateTime(subject.unpublishedAt)}</span>
          {/if}
        </p>
      {/if}
      {#if subject.customMessage}
        <p class="m-0 text-sm whitespace-pre-wrap">Message: {subject.customMessage}</p>
      {/if}
      <a
        href={isModel ? modelLookupUrl(row.entityId) : articleLookupUrl(row.entityId)}
        class="text-sm {LINK_CLASS}"
      >
        Open in {isModel ? 'Model' : 'Article'} Lookup
      </a>
    </div>
  </TriageCard>
{/if}
