<script lang="ts">
  import TrainingAssetGrid from '$lib/components/TrainingAssetGrid.svelte';
  import { LINK_CLASS } from '$lib/format';
  import type { TrainingAsset } from '$lib/training-media';
  import type {
    DatasetItemState,
    WorkflowDatasetItem,
  } from '$lib/server/training-moderation.service';

  let {
    workflowId,
    items,
    itemStates,
  }: {
    workflowId: string;
    items: WorkflowDatasetItem[];
    itemStates: Promise<Record<number, DatasetItemState>>;
  } = $props();

  // Items are served by position through this app, never from a URL the workflow carries.
  const itemUrl = (index: number) =>
    `/api/training-workflow-blob/${encodeURIComponent(workflowId)}/${index}`;
  const label = (item: WorkflowDatasetItem) => `Item ${item.index + 1}`;

  const stored = $derived(items.filter((item) => item.blobKey));
  const unserved = $derived(items.length - stored.length);

  /** The grid tiles for every stored, renderable item whose state is not in `hide`. */
  const assetsExcept = (states: Record<number, DatasetItemState>, hide: DatasetItemState[]) =>
    stored.flatMap((item): TrainingAsset[] =>
      item.media && !hide.includes(states[item.index])
        ? [{ url: itemUrl(item.index), name: label(item), ...item.media, caption: item.caption }]
        : []
    );
</script>

<p class="mb-3 text-xs text-dark-2">
  {items.length} items{unserved
    ? `, ${unserved} of which are not stored uploads and cannot be shown`
    : ''}.
</p>

{#await itemStates}
  <p class="text-sm text-dark-2">Checking which dataset items can be viewed…</p>
{:then states}
  {@const blocked = stored.filter((item) => states[item.index] === 'blocked')}
  {@const unavailable = stored.filter((item) => states[item.index] === 'unavailable')}
  {@const unchecked = stored.filter((item) => states[item.index] === 'unchecked')}
  {@const assets = assetsExcept(states, ['blocked', 'unavailable'])}
  {@const other = stored.filter(
    (item) => !item.media && states[item.index] !== 'blocked' && states[item.index] !== 'unavailable'
  )}

  {#if blocked.length}
    <div
      class="mb-4 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
    >
      <p>
        {blocked.length} of these items were <strong>blocked at upload — not viewable here</strong>.
        A dataset carrying blocked items weighs toward <strong>Deny</strong>: approving trains on
        material nobody here has seen.
      </p>
      <ul class="mt-2 flex flex-col gap-1">
        {#each blocked as item (item.index)}
          <li>
            {label(item)} — blocked at upload — not viewable here
            <span class="text-dark-2"> · {item.caption ?? '(no caption)'}</span>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
  {#if unavailable.length}
    <p class="mb-3 text-sm text-amber-200">
      {unavailable.length} items could not be served (missing, or not yet scanned):
      {unavailable.map(label).join(', ')}.
    </p>
  {/if}
  {#if unchecked.length}
    <p class="mb-3 text-sm text-amber-200">
      {unchecked.length} items did not answer in time and are shown unchecked — reload to check them.
    </p>
  {/if}

  {#if assets.length || !other.length}
    <TrainingAssetGrid {assets} preload="none" columns="grid-cols-2 sm:grid-cols-3 lg:grid-cols-5" />
  {/if}
  {#if other.length}
    <ul class="mt-3 flex flex-col gap-1 text-sm">
      {#each other as item (item.index)}
        <li>
          <a href={itemUrl(item.index)} target="_blank" rel="noreferrer" class={LINK_CLASS}>
            {label(item)} (not previewable — open) ↗
          </a>
          <span class="text-dark-2"> — {item.caption ?? '(no caption)'}</span>
        </li>
      {/each}
    </ul>
  {/if}
{:catch}
  <p class="mb-3 text-sm text-amber-200">
    Could not check which items were blocked at upload, so any blocked item below shows as a broken
    tile — treat one as blocked, which weighs toward Deny.
  </p>
  <TrainingAssetGrid
    assets={assetsExcept({}, [])}
    preload="none"
    columns="grid-cols-2 sm:grid-cols-3 lg:grid-cols-5"
  />
{/await}
