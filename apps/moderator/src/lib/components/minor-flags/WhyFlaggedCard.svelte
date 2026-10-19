<script lang="ts">
  import { browser } from '$app/environment';
  import FlagVerdictBlock from '$lib/components/minor-flags/FlagVerdictBlock.svelte';
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';
  import ScanProvenance from '$lib/components/minor-flags/ScanProvenance.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { dateTime } from '$lib/format';
  import { effectiveSource, sourceLabel } from '$lib/minor-flags/appeal-filters';
  import { ago } from '$lib/minor-flags/appeal-row';
  import { fetchHashDetail } from '$lib/minor-flags/hash-detail';
  import {
    HASH_FLAG_REASON,
    flagPromptId,
    flagScanSource,
    hashSweepText,
    type ModelFlagDetail,
  } from '$lib/minor-flags/model-detail';
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
    canUphold,
    detail,
  }: {
    row: MinorFlagAppealRow;
    canUphold: boolean;
    detail: Promise<ModelFlagDetail>;
  } = $props();

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

  // A minor flag no text-scan verdict explains (hash, a moderator, or no record) gets its own block, so
  // every label in force reads the same way: label, Flagged chip, reason, where it came from.
  const minorBlock = $derived.by(() => {
    if (!row.minor || verdicts.some((v) => v.label === 'minor')) return null;
    const source = effectiveSource(row.flagSource, row.flagConfirmedFrom);
    if (source === 'hash')
      return { reason: HASH_FLAG_REASON, provenance: hashSweepText(row.flaggedAt, null) };
    const at = row.flaggedAt ? `, ${ago(row.flaggedAt)}` : '';
    return source === 'moderator'
      ? { reason: 'A moderator set this model as minor.', provenance: `set as minor${at}` }
      : {
          reason: 'Nothing stored says what set this flag.',
          provenance: `${sourceLabel(row.flagSource, row.flagConfirmedFrom).toLowerCase()}${at}`,
        };
  });
</script>

<TriageCard dense title="Why it was flagged">
  <div class="space-y-2 text-dark-0">
    {#if minorBlock}
      <FlagVerdictBlock label="minor" reason={minorBlock.reason}>
        {#snippet provenance()}
          <span title={row.flaggedAt ? dateTime(row.flaggedAt) : undefined}>{minorBlock.provenance}</span
          >{#if row.flaggedByUsername}{' · '}set by {row.flaggedByUsername}{#if row.flaggedByAt}{' '}<span
                title={dateTime(row.flaggedByAt)}>{ago(row.flaggedByAt)}</span
              >{/if}{/if}
        {/snippet}
      </FlagVerdictBlock>
    {/if}

    {#each verdicts as { label, flag } (label)}
      <FlagVerdictBlock {label} reason={flag.reason}>
        {#snippet provenance()}
          <ScanProvenance
            at={flag.at}
            source={flagScanSource(flag.workflowId, row.scanRows)}
            promptId={flagPromptId(flag.promptIds, label)}
            {detail}
          />
        {/snippet}
        {#if flag.names?.length}
          <div class="flex flex-wrap gap-1.5 pt-1">
            {#each flag.names as name, i (i)}<MetaChip tone="red">{name}</MetaChip>{/each}
          </div>
        {/if}
        {#if latestScanDisagrees(scan, label)}
          <p
            class="m-0 mt-1.5 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-200"
          >
            Latest scan: not detected. The flag stays until a moderator rules.
          </p>
        {/if}
      </FlagVerdictBlock>
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

    <!-- The matched model is not shown here (the design has no shared-file box on an appeal); only a
         match that no longer resolves is called out, since it changes whether to keep the flag. -->
    {#if hashDetail}
      {#await hashDetail then payload}
        {#if !payload.match}
          <p
            class="m-0 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200"
          >
            No flagged model shares a file with this one any more. The match is resolved live, so
            the model it matched was unflagged or its hashes were deleted. Check before you keep
            the flag.
          </p>
        {/if}
      {:catch}
        <p class="m-0 text-xs text-red-300">Could not check the matched model.</p>
      {/await}
    {/if}

    {#if !canUphold}
      <p class="m-0 text-sm text-emerald-300">
        The flag is already lifted, so upholding has nothing left to keep.
      </p>
    {/if}
  </div>
</TriageCard>
