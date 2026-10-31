<script lang="ts" generics="T">
  import type { Snippet } from 'svelte';
  import { portalProps } from '$lib/host';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Spinner } from '@civitai/ui/components/ui/spinner/index.js';
  import * as Dialog from '@civitai/ui/components/ui/dialog/index.js';

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

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-3xl" portalProps={portalProps()}>
    <Dialog.Header>
      <Dialog.Title>{title}</Dialog.Title>
      <Dialog.Description>{description}</Dialog.Description>
    </Dialog.Header>

    {#if items}
      {#await items}
        <div class="flex items-center justify-center gap-2 py-16 text-sm text-dark-2">
          <Spinner class="size-4" /> {loadingText}
        </div>
      {:then list}
        {#if list.length === 0}
          <div class="py-16 text-center text-sm text-dark-2">{emptyText}</div>
        {:else}
          {@render children(list)}
        {/if}

        <Dialog.Footer>
          <Dialog.Close>
            {#snippet child({ props })}
              <Button {...props} variant="ghost">Cancel</Button>
            {/snippet}
          </Dialog.Close>
          <Button
            onclick={() => {
              onConfirm(list);
              open = false;
            }}
            disabled={!canAdd}
          >
            {addLabel}
          </Button>
        </Dialog.Footer>
      {:catch err}
        <div class="py-16 text-center text-sm text-red-400">
          {err instanceof Error ? err.message : failedText}
        </div>
      {/await}
    {/if}
  </Dialog.Content>
</Dialog.Root>
