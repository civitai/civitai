<script lang="ts" generics="T">
  import type { Snippet } from 'svelte';
  import '$lib/civitai-elements';

  let {
    open = $bindable(false),
    title,
    description,
    items,
    loadingText,
    emptyText,
    failedText,
    addLabel,
    canAdd,
    onConfirm,
    children,
  }: {
    open: boolean;
    title: string;
    description: string;
    items: Promise<T[]> | null;
    loadingText: string;
    emptyText: string;
    failedText: string;
    addLabel: string;
    canAdd: boolean;
    onConfirm: (items: T[]) => void;
    /** The selectable grid, once there is something to pick. */
    children: Snippet<[T[]]>;
  } = $props();
</script>

<civitai-modal
  class="[&::part(panel)]:max-w-3xl"
  {open}
  heading={title}
  with-close-button
  close-label="Cancel"
  onclose={() => (open = false)}
>
  <p class="m-0 mb-3 text-sm text-dark-2">{description}</p>

  {#if items}
    {#await items}
      <div class="flex items-center justify-center gap-2 py-16 text-sm text-dark-2">
        <civitai-loader size="sm"></civitai-loader>
        {loadingText}
      </div>
    {:then list}
      {#if list.length === 0}
        <div class="py-16 text-center text-sm text-dark-2">{emptyText}</div>
      {:else}
        {@render children(list)}
      {/if}

      <div class="mt-4 flex flex-wrap justify-end gap-2">
        <civitai-button variant="subtle" onclick={() => (open = false)}>Cancel</civitai-button>
        <civitai-button
          onclick={() => {
            onConfirm(list);
            open = false;
          }}
          disabled={!canAdd}
        >
          {addLabel}
        </civitai-button>
      </div>
    {:catch err}
      <div class="py-16 text-center text-sm text-red-400">
        {err instanceof Error ? err.message : failedText}
      </div>
    {/await}
  {/if}
</civitai-modal>
