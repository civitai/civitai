<script lang="ts">
  import { browser } from '$app/environment';
  import { IconFileCheck } from '@tabler/icons-svelte';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { dateTime, num } from '$lib/format';
  import { effectiveSource } from '$lib/minor-flags/appeal-filters';
  import { ago, modelUrl, shortHash, yearMonth } from '$lib/minor-flags/appeal-row';
  import { fetchHashDetail } from '$lib/minor-flags/hash-detail';
  import type { MinorFlagAppealRow, MinorHashReviewRow } from '$lib/server/minor-hash.service';

  type SharedFileRow = Pick<MinorFlagAppealRow, 'modelId' | 'modelName' | 'userId' | 'username'> &
    Partial<
      Pick<MinorFlagAppealRow, 'flagSource' | 'flagConfirmedFrom'> &
        Pick<
          MinorHashReviewRow,
          'modelVersionId' | 'hash' | 'minorModelId' | 'minorModelName' | 'minorModelVersionId'
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
  <!-- Same box for both, `object-contain`: the two covers are here to be COMPARED, and cropping to
       fill the box can hide the thing being judged. -->
  <div
    class="flex h-[90px] w-full items-center justify-center overflow-hidden rounded-md border border-dark-4 bg-dark-6"
  >
    {#if url}
      <EdgeMedia
        src={url}
        type={(type ?? 'image') as 'image' | 'video'}
        width={450}
        class="h-full w-auto max-w-full object-contain"
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

<TriageCard dense title="Shared file, side by side">
  {#if request}
    {#await request}
      <p class="m-0 text-dark-2">Loading detail…</p>
    {:then payload}
      {#if payload.detail}
        {@const d = payload.detail}
        {@const m = payload.match}
        {@const ownVersion = row.modelVersionId ?? m?.modelVersionId ?? null}
        {@const seedId = minorModelId ?? m?.minorModelId ?? null}
        {@const seedName = row.minorModelName ?? m?.minorModelName ?? null}
        {@const seedVersion = row.minorModelVersionId ?? m?.minorModelVersionId ?? null}
        {@const hash = row.hash ?? m?.hash ?? null}
        <div class="space-y-2">
          <div class="grid grid-cols-2 gap-3">
            <div class="flex min-w-0 flex-col gap-1.5">
              {@render cover(d.modelCoverUrl, d.modelCoverType)}
              {@render heading(row.modelName, 'this model', modelUrl(civitaiUrl, modelId, ownVersion))}
              <span class="text-[11px] text-dark-1">
                {row.username ?? `user #${row.userId}`} · {num(d.uploaderModelCount)}
                {d.uploaderModelCount === 1 ? 'model' : 'models'}{#if d.uploaderJoinedAt}
                  · joined {yearMonth(d.uploaderJoinedAt)}{/if}
              </span>
              {#if d.modelCreatedAt}
                <span class="text-[11px] text-dark-2" title={dateTime(d.modelCreatedAt)}>
                  uploaded {ago(d.modelCreatedAt)}
                </span>
              {/if}
              <div><MetaChip tone={status.tone}>{status.label}</MetaChip></div>
            </div>

            {#if seedId}
              <div class="flex min-w-0 flex-col gap-1.5">
                {@render cover(d.minorModelCoverUrl, d.minorModelCoverType)}
                {@render heading(
                  seedName ?? `#${seedId}`,
                  'seed',
                  modelUrl(civitaiUrl, seedId, seedVersion)
                )}
                <span class="text-[11px] text-dark-1">{d.minorUsername ?? 'unknown uploader'}</span>
                <!-- Most minor-locked models have no setMinor ModActivity row, so the date is often
                     missing; "by a moderator" still holds, since only a human flag seeds a match. -->
                <span
                  class="text-[11px] text-dark-2"
                  title={d.minorFlaggedAt ? dateTime(d.minorFlaggedAt) : undefined}
                >
                  flagged minor by {d.minorFlaggedByUsername ?? 'a moderator'}{d.minorFlaggedAt
                    ? `, ${yearMonth(d.minorFlaggedAt)}`
                    : ''}
                </span>
                <!-- The GAP between this and the copy's upload is the evidence; "deleted" alone does
                     not show they happened minutes apart. -->
                {#if d.minorModelDeletedAt}
                  <span class="text-[11px] text-dark-2">
                    deleted {dateTime(d.minorModelDeletedAt)}
                  </span>
                {/if}
                <div><MetaChip tone="red">minor, confirmed</MetaChip></div>
              </div>
            {:else if effectiveSource(row.flagSource ?? null, row.flagConfirmedFrom ?? null) === 'moderator'}
              <p class="m-0 rounded-md border border-blue-500/30 bg-blue-500/10 p-2.5 text-xs text-blue-200">
                A moderator flagged this model directly, so there is no matched model to show.
              </p>
            {:else}
              <p
                class="m-0 rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-200"
              >
                Nothing a moderator flagged minor still shares a file with this model: the match is
                resolved live, so that model was unflagged or its hashes were deleted. Check before
                you keep the flag.
              </p>
            {/if}
          </div>

          {#if hash && seedId}
            <p class="m-0 flex items-center gap-2 text-xs text-dark-0" title={hash}>
              <IconFileCheck size={13} class="shrink-0 text-emerald-400" />
              SHA256 {shortHash(hash)} identical in both
            </p>
          {/if}
        </div>
      {:else}
        <p class="m-0 text-dark-2">No detail for this model.</p>
      {/if}
    {:catch}
      <p class="m-0 text-red-300">Could not load the detail for this model.</p>
    {/await}
  {:else}
    <p class="m-0 text-dark-2">Loading detail…</p>
  {/if}
</TriageCard>
