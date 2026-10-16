<script lang="ts">
  import { browser } from '$app/environment';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import { effectiveSource } from '$lib/minor-flags/appeal-filters';
  import { modelUrl } from '$lib/minor-flags/appeal-row';
  import { fetchHashDetail } from '$lib/minor-flags/hash-detail';

  let {
    row,
    civitaiUrl,
  }: {
    row: {
      modelId: number;
      userId: number;
      username: string | null;
      status: string;
      modelVersionId?: number | null;
      hash?: string | null;
      minorModelId?: number | null;
      minorModelVersionId?: number | null;
      flagSource?: string | null;
      flagConfirmedFrom?: string | null;
    };
    civitaiUrl: string;
  } = $props();

  // Primitives first, so a reload that hands back an equal row doesn't rebuild the promise.
  const modelId = $derived(row.modelId);
  const minorModelId = $derived(row.minorModelId ?? null);
  const request = $derived(browser ? fetchHashDetail(modelId, minorModelId) : null);
</script>

<TriageCard title="Shared file">
  {#if request}
  {#await request}
    <p class="m-0 text-sm text-dark-2">Loading detail…</p>
  {:then payload}
    {#if payload.detail}
      {@const d = payload.detail}
      {@const m = payload.match}
      {@const ownVersion = row.modelVersionId ?? m?.modelVersionId ?? null}
      {@const seedId = minorModelId ?? m?.minorModelId ?? null}
      {@const seedVersion = row.minorModelVersionId ?? m?.minorModelVersionId ?? null}
      {@const hash = row.hash ?? m?.hash ?? null}
      <div class="grid gap-4 sm:grid-cols-2">
        <div>
          <h4 class="mb-1 text-xs tracking-wide text-dark-2 uppercase">This model</h4>
          {#if d.modelCoverUrl}
            <!-- Fixed box, `object-contain`: the two covers are here to be COMPARED, so they need the
                 same frame, and cropping to fill it can hide the thing being judged. -->
            <div
              class="mb-2 flex h-48 w-fit max-w-full items-center justify-center overflow-hidden rounded-md border border-dark-4 bg-dark-7"
            >
              <EdgeMedia
                src={d.modelCoverUrl}
                type={(d.modelCoverType ?? 'image') as 'image' | 'video'}
                width={450}
                class="h-full w-auto max-w-full object-contain"
              />
            </div>
          {/if}
          <p class="m-0 text-xs text-dark-2">Uploaded {dateTime(d.modelCreatedAt)} · {row.status}</p>
          <p class="m-0 text-xs text-dark-2">
            {row.username ?? row.userId} · {num(d.uploaderModelCount)} model{d.uploaderModelCount === 1
              ? ''
              : 's'} · joined {dateTime(d.uploaderJoinedAt)}
          </p>
          <a
            href={modelUrl(civitaiUrl, modelId, ownVersion)}
            target="_blank"
            rel="noreferrer"
            class="mt-1 inline-block text-xs {LINK_CLASS}"
          >
            Open model ↗
          </a>
        </div>

        {#if seedId}
          <div>
            <h4 class="mb-1 text-xs tracking-wide text-dark-2 uppercase">The flagged source</h4>
            {#if d.minorModelCoverUrl}
              <div
                class="mb-2 flex h-48 w-fit max-w-full items-center justify-center overflow-hidden rounded-md border border-dark-4 bg-dark-7"
              >
                <EdgeMedia
                  src={d.minorModelCoverUrl}
                  type={(d.minorModelCoverType ?? 'image') as 'image' | 'video'}
                  width={450}
                  class="h-full w-auto max-w-full object-contain"
                />
              </div>
            {/if}
            <p class="m-0 text-xs text-dark-2">
              {d.minorUsername ?? 'unknown'} · {d.minorModelStatus ?? 'unknown'}
            </p>
            <!-- The GAP between this and the copy's upload date is the evidence; a "deleted" badge
                 alone does not show they happened minutes apart. -->
            {#if d.minorModelDeletedAt}
              <p class="m-0 text-xs text-dark-2">Deleted {dateTime(d.minorModelDeletedAt)}</p>
            {/if}
            <!-- Most minor-locked models have no setMinor ModActivity row, so a placeholder would
                 read as missing data on nearly every row. -->
            {#if d.minorFlaggedAt}
              <p class="m-0 text-xs text-dark-2">
                Set minor {dateTime(d.minorFlaggedAt)}{d.minorFlaggedByUsername
                  ? ` by ${d.minorFlaggedByUsername}`
                  : ''}
              </p>
            {/if}
            <a
              href={modelUrl(civitaiUrl, seedId, seedVersion)}
              target="_blank"
              rel="noreferrer"
              class="mt-1 inline-block text-xs {LINK_CLASS}"
            >
              Open flagged model ↗
            </a>
          </div>
        {:else if effectiveSource(row.flagSource ?? null, row.flagConfirmedFrom ?? null) === 'moderator'}
          <div class="rounded-md border border-blue-500/30 bg-blue-500/10 p-3 text-sm text-blue-200">
            <strong class="block">No hash match</strong>
            A moderator flagged this model directly rather than the automation matching it against a
            known minor model, so there is no match to show — nothing is missing here.
          </div>
        {:else}
          <div
            class="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200"
          >
            <strong class="block">No matching flagged model</strong>
            Nothing a moderator has flagged minor still shares a file with this model. The match is
            resolved live, so the model it matched has since been unflagged or its hashes were
            deleted — worth checking before you keep the flag.
          </div>
        {/if}
      </div>

      {#if hash}
        <div class="mt-3">
          <h4 class="m-0 text-xs font-semibold text-dark-2">Shared SHA256</h4>
          <code class="text-xs break-all text-dark-0">{hash}</code>
        </div>
      {/if}
    {:else}
      <p class="m-0 text-sm text-dark-2">No detail for this model.</p>
    {/if}
  {:catch}
    <p class="m-0 text-sm text-red-300">Could not load the detail for this model.</p>
  {/await}
  {/if}
</TriageCard>
