<script lang="ts">
  import { browser } from '$app/environment';
  import { IconFileCheck } from '@tabler/icons-svelte';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { LINK_CLASS, bytes, dateTime } from '$lib/format';
  import { effectiveSource } from '$lib/minor-flags/appeal-filters';
  import { ago, modelUrl, shortHash, yearMonth } from '$lib/minor-flags/appeal-row';
  import { fetchHashDetail, seedOutcome } from '$lib/minor-flags/hash-detail';
  import { modelUnpublishReasonLabel } from '$lib/model-unpublish-reasons';
  import type { MinorFlagAppealRow, MinorHashReviewRow } from '$lib/server/minor-hash.service';

  type SharedFileRow = Pick<MinorFlagAppealRow, 'modelId' | 'modelName' | 'userId' | 'username'> &
    Partial<
      Pick<MinorFlagAppealRow, 'flagSource' | 'flagConfirmedFrom'> &
        Pick<
          MinorHashReviewRow,
          | 'modelVersionId'
          | 'hash'
          | 'fileName'
          | 'fileSizeKB'
          | 'minorModelId'
          | 'minorModelName'
          | 'minorModelVersionId'
        >
    >;

  let {
    row,
    civitaiUrl,
    status,
  }: {
    row: SharedFileRow;
    civitaiUrl: string;
    /** Where this model stands in the queue showing it ("under review", "not flagged"). */
    status: { label: string; tone: 'blue' | 'green' };
  } = $props();

  // Primitives first, so a reload that hands back an equal row doesn't rebuild the promise.
  const modelId = $derived(row.modelId);
  const minorModelId = $derived(row.minorModelId ?? null);
  const request = $derived(browser ? fetchHashDetail(modelId, minorModelId) : null);
</script>

{#snippet cover(url: string | null | undefined, type: string | null | undefined)}
  <!-- Same box for both, filled per the design; cropped from the top, where a subject's face usually
       is. -->
  <div class="aspect-[4/5] w-full overflow-hidden rounded-md border border-dark-4 bg-dark-6">
    {#if url}
      <EdgeMedia
        src={url}
        type={(type ?? 'image') as 'image' | 'video'}
        width={450}
        class="h-full w-full object-cover object-top"
      />
    {/if}
  </div>
{/snippet}

{#snippet heading(name: string, role: string, href: string)}
  <a
    {href}
    target="_blank"
    rel="noreferrer"
    class="text-xs leading-[1.45] font-semibold text-white hover:underline"
  >
    {name} · {role}
  </a>
{/snippet}

{#snippet notice(title: string, text: string, tone = 'text-dark-2')}
  <TriageCard dense {title}><p class="m-0 {tone}">{text}</p></TriageCard>
{/snippet}

<!-- The title says what the card can actually show. The match is resolved live (the flag records no
     seed), so once the seed is gone there is nothing left to call "the same file". -->
{#if !request}
  {@render notice('Shared file', 'Loading detail…')}
{:else}
  {#await request}
    {@render notice('Shared file', 'Loading detail…')}
  {:then payload}
    {#if !payload.detail}
      {@render notice('Shared file', 'No detail for this model.')}
    {:else}
      {@const d = payload.detail}
      {@const m = payload.match}
      {@const ownVersion = row.modelVersionId ?? m?.modelVersionId ?? null}
      {@const seedId = minorModelId ?? m?.minorModelId ?? null}
      {@const seedName = row.minorModelName ?? m?.minorModelName ?? null}
      {@const seedVersion = row.minorModelVersionId ?? m?.minorModelVersionId ?? null}
      {@const hash = row.hash ?? m?.hash ?? null}
      {@const fileName = row.fileName ?? m?.fileName ?? null}
      {@const fileSizeKB = row.fileSizeKB ?? m?.fileSizeKB ?? null}
      {@const outcome = seedOutcome(d)}
      {#if seedId}
        <TriageCard dense title="Same file as a flagged model">
          <div class="space-y-3">
            <div class="space-y-1.5 rounded-md border border-red-500/40 bg-red-500/10 p-3">
              <p class="m-0 flex items-center gap-1.5 font-semibold text-white">
                <IconFileCheck size={15} class="shrink-0 text-red-300" aria-hidden="true" />
                Identical file
              </p>
              <p class="m-0 text-dark-0">
                {#if fileName}<span class="font-mono text-xs break-all">{fileName}</span>{:else}This
                  model's file{/if}{#if fileSizeKB != null}&nbsp;({bytes(fileSizeKB)}){/if} is byte for
                byte the same file as one in
                <a
                  href={modelUrl(civitaiUrl, seedId, seedVersion)}
                  target="_blank"
                  rel="noreferrer"
                  class={LINK_CLASS}>{seedName ?? `model #${seedId}`}</a
                >.
              </p>
              <p class="m-0 text-dark-0">
                That model was flagged as depicting a minor by {d.minorFlaggedByUsername ??
                  'a moderator'}{d.minorFlaggedAt ? ` in ${yearMonth(d.minorFlaggedAt)}` : ''}, and was
                <span class="font-semibold {outcome.tone === 'down' ? 'text-red-200' : 'text-amber-200'}"
                  >{outcome.text}</span
                >{#if outcome.at}&nbsp;<span title={dateTime(outcome.at)}>{ago(outcome.at)}</span
                  >{/if}{#if outcome.reason}&nbsp;({modelUnpublishReasonLabel(outcome.reason)}){/if}.
              </p>
              {#if hash}
                <p class="m-0 text-[11px] text-dark-2" title={hash}>SHA256 {shortHash(hash)}</p>
              {/if}
            </div>

            <div class="grid grid-cols-2 gap-3">
              <div class="flex min-w-0 flex-col gap-1.5">
                {@render cover(d.modelCoverUrl, d.modelCoverType)}
                {@render heading(row.modelName, 'this model', modelUrl(civitaiUrl, modelId, ownVersion))}
                <span class="text-[11px] text-dark-1">{row.username ?? `user #${row.userId}`}</span>
                {#if d.modelCreatedAt}
                  <span class="text-[11px] text-dark-2" title={dateTime(d.modelCreatedAt)}>
                    uploaded {ago(d.modelCreatedAt)}
                  </span>
                {/if}
                <div><MetaChip tone={status.tone}>{status.label}</MetaChip></div>
              </div>

              <div class="flex min-w-0 flex-col gap-1.5">
                {@render cover(d.minorModelCoverUrl, d.minorModelCoverType)}
                {@render heading(
                  seedName ?? `#${seedId}`,
                  'earlier model',
                  modelUrl(civitaiUrl, seedId, seedVersion)
                )}
                <span class="text-[11px] text-dark-1">{d.minorUsername ?? 'unknown uploader'}</span>
                <!-- The exact time is shown because the gap to the copy's upload is the evidence. -->
                {#if outcome.at}
                  <span class="text-[11px] text-dark-2">
                    {outcome.text} {dateTime(outcome.at)}
                  </span>
                {/if}
                <div class="flex flex-wrap gap-1">
                  <MetaChip tone="red">minor, confirmed</MetaChip>
                  {#if outcome.tone === 'down'}<MetaChip tone="red">{outcome.text}</MetaChip>{/if}
                </div>
              </div>
            </div>
          </div>
        </TriageCard>
      {:else if effectiveSource(row.flagSource ?? null, row.flagConfirmedFrom ?? null) === 'moderator'}
        {@render notice(
          'Flagged by a moderator',
          'A moderator flagged this model directly, so there is no matched model to show.',
          'text-dark-0'
        )}
      {:else}
        <TriageCard dense accent="amber" title="Hash match can't be verified">
          <div class="space-y-2 text-dark-0">
            <p class="m-0">
              The hash sweep flagged this model because its file matched a model a moderator had
              flagged as minor. No flagged model shares that file any more: the model it matched was
              unflagged, or its files or hashes were removed.
            </p>
            <p class="m-0">
              Which model it matched was not recorded when the flag was applied, so there is nothing
              left to compare. Judge the model on what it shows.
            </p>
          </div>
        </TriageCard>
      {/if}
    {/if}
  {:catch}
    {@render notice('Shared file', 'Could not load the detail for this model.', 'text-red-300')}
  {/await}
{/if}
