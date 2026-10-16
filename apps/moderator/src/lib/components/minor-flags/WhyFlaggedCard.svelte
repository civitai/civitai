<script lang="ts">
  import { browser } from '$app/environment';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { effectiveSource, sourceLabel } from '$lib/minor-flags/appeal-filters';
  import { ago, modelUrl } from '$lib/minor-flags/appeal-row';
  import { fetchHashDetail } from '$lib/minor-flags/hash-detail';
  import {
    latestScanDisagrees,
    openVerdicts,
    scanVerdictProvenance,
    scanVerdictText,
    type FlagLabel,
  } from '$lib/minor-flags/text-scan-verdicts';
  import type { MinorFlagAppealRow } from '$lib/server/minor-hash.service';

  let {
    row,
    civitaiUrl,
    canUphold,
  }: { row: MinorFlagAppealRow; civitaiUrl: string; canUphold: boolean } = $props();

  const verdicts = $derived(openVerdicts(row.textScanFlags));
  const scan = $derived(row.latestScan);
  const scanLabels = $derived(
    (['minor', 'poi'] as const).flatMap((label) => {
      const value = scan?.[label];
      return value ? [{ label, value }] : [];
    })
  );
  const labelName = (label: FlagLabel) => (label === 'poi' ? 'real person' : 'minor');

  // Primitives first, so a reload that hands back an equal row doesn't rebuild the promise.
  const modelId = $derived(row.modelId);
  const isHash = $derived(effectiveSource(row.flagSource, row.flagConfirmedFrom) === 'hash');
  // Derived, not an effect: the parent keys the detail per appeal, so a late response can't land on another one.
  const hashDetail = $derived(browser && isHash ? fetchHashDetail(modelId) : null);
</script>

<TriageCard title="Why it was flagged">
  <div class="space-y-2 text-base text-dark-0">
    <p class="m-0">{sourceLabel(row.flagSource, row.flagConfirmedFrom)}</p>

    {#if row.flaggedAt}
      <p class="m-0 text-sm" title={dateTime(row.flaggedAt)}>Flagged {ago(row.flaggedAt)}</p>
    {/if}
    {#if row.flaggedByUsername}
      <p class="m-0 text-sm">
        Set by <span class="font-medium text-white">{row.flaggedByUsername}</span>
        {#if row.flaggedByAt}
          <span title={dateTime(row.flaggedByAt)}>{ago(row.flaggedByAt)}</span>
        {/if}
      </p>
    {/if}

    {#each verdicts as { label, flag } (label)}
      <div class="rounded-md bg-dark-6 p-3 text-sm">
        <p class="m-0 font-medium text-white">
          Text scan: {labelName(label)}
          {#if flag.at}
            <span class="font-normal text-dark-2" title={dateTime(flag.at)}>
              · flagged {ago(flag.at)}
            </span>
          {/if}
        </p>
        {#if flag.reason}<p class="m-0 mt-1">{flag.reason}</p>{/if}
        {#if flag.names?.length}
          <p class="m-0 mt-1">Names: {flag.names.join(', ')}</p>
        {/if}
        {#if latestScanDisagrees(scan, label)}
          <p
            class="m-0 mt-2 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-amber-200"
          >
            Latest scan: not detected — flag kept (sticky)
          </p>
        {/if}
      </div>
    {/each}

    {#if verdicts.length || scanLabels.length}
      <div class="rounded-md bg-dark-6 p-3 text-sm">
        <p class="m-0 font-medium text-white">Latest scan</p>
        {#each scanLabels as { label, value } (label)}
          {@const provenance = scanVerdictProvenance(value)}
          <p class="m-0 mt-1">
            <span class="text-white">{labelName(label)}:</span>
            {scanVerdictText(value)}
          </p>
          <p class="m-0 text-dark-2">
            {provenance.source} ·
            {#if provenance.note}
              <span title={dateTime(value.updatedAt)}>{provenance.note}</span>
            {:else}
              <span title={dateTime(value.updatedAt)}>{ago(value.updatedAt)}</span>
            {/if}
          </p>
        {:else}
          <p class="m-0 text-sm text-dark-2">No text scan on record.</p>
        {/each}
      </div>
    {/if}

    {#if hashDetail}
      {#await hashDetail}
        <p class="m-0 text-sm text-dark-2">Looking up the matched model…</p>
      {:then payload}
        {#if payload.match}
          {@const m = payload.match}
          {@const d = payload.detail}
          <div class="rounded-md bg-dark-6 p-3 text-sm">
            <p class="m-0">
              Shares a file with
              <a
                href={modelUrl(civitaiUrl, m.minorModelId, m.minorModelVersionId)}
                target="_blank"
                rel="noreferrer"
                class={LINK_CLASS}
              >
                {m.minorModelName ?? `#${m.minorModelId}`} ↗
              </a>
              {#if d?.minorUsername}by {d.minorUsername}{/if}
              {#if d?.minorModelStatus}({d.minorModelStatus}){/if}
            </p>
            {#if d?.minorModelDeletedAt}
              <p class="m-0 mt-1">Deleted {dateTime(d.minorModelDeletedAt)}</p>
            {/if}
            <p class="m-0 mt-1 text-xs break-all text-dark-2">SHA256 <code>{m.hash}</code></p>
          </div>
        {:else}
          <p
            class="m-0 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200"
          >
            No flagged model shares a file with this one any more. The match is resolved live, so
            the model it matched was unflagged or its hashes were deleted. Check before you keep
            the flag.
          </p>
        {/if}
      {:catch}
        <p class="m-0 text-sm text-red-300">Could not load the matched model.</p>
      {/await}
    {/if}

    {#if row.prevNsfw != null || row.prevGalleryLevel != null}
      <p class="m-0 text-sm">
        Before the flag: NSFW {row.prevNsfw ? 'on' : 'off'}{row.prevGalleryLevel != null
          ? `, gallery level ${row.prevGalleryLevel}`
          : ''}
      </p>
    {/if}

    {#if !canUphold}
      <p class="m-0 text-sm text-emerald-300">
        The flag is already lifted, so upholding has nothing left to keep.
      </p>
    {/if}
  </div>
</TriageCard>
