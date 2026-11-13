<script lang="ts">
  import { IconArrowRight, IconRefresh, IconSparkles, IconUpload, IconWand, IconX } from '@tabler/icons-svelte';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Spinner } from '@civitai/ui/components/ui/spinner/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import { isFailed, type Img } from './trainingFlow';
  import { pairProblem, type EditPair } from './editPairs';

  let {
    pair,
    sourceLabel,
    showBefore = true,
    suggesting = false,
    suggestPrice = null,
    onInstruction,
    onRemove,
    onUploadAfter,
    onCreate,
    onSuggest,
    onRetry,
  }: {
    pair: EditPair;
    sourceLabel: string;
    /** Off in the grouped view, where the starting image heads the group instead. */
    showBefore?: boolean;
    suggesting?: boolean;
    suggestPrice?: number | null;
    onInstruction: (text: string) => void;
    onRemove: () => void;
    onUploadAfter: () => void;
    onCreate: () => void;
    onSuggest: () => void;
    onRetry: (side: 'before' | 'after') => void;
  } = $props();

  const problem = $derived(pairProblem(pair));
  const canSuggest = $derived(
    !!pair.after?.blobUrl?.startsWith('http') && !!pair.before.blobUrl?.startsWith('http')
  );
  const tile = $derived(showBefore ? 'h-28 w-28' : 'h-20 w-20');
</script>

{#snippet image(img: Img, side: 'before' | 'after')}
  <div
    class={cn(
      'relative shrink-0 overflow-hidden rounded-lg border bg-dark-7',
      tile,
      side === 'after' ? 'border-sky-700' : 'border-dark-4'
    )}
  >
    {#if img.previewUrl}
      <img src={img.previewUrl} alt="" class="h-full w-full object-cover" />
    {/if}
    {#if showBefore}
      <span
        class="absolute left-1 top-1 rounded bg-dark-8/90 px-1.5 font-mono text-[10px] uppercase tracking-wider {side ===
        'after'
          ? 'text-sky-400'
          : 'text-dark-2'}"
      >
        {side}
      </span>
    {/if}
    {#if img.status === 'uploading'}
      <div class="absolute inset-x-0 bottom-0 h-1 bg-dark-8">
        <div class="h-full bg-primary transition-[width]" style="width: {Math.round(img.progress * 100)}%"></div>
      </div>
    {:else if isFailed(img)}
      <div class="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-dark-8/85 p-1 text-center">
        <span class="text-[11px] leading-tight text-red-300" title={img.message}>
          {img.status === 'blocked' ? 'Blocked' : 'Upload failed'}
        </span>
        {#if img.status === 'error' && img.file}
          <Button variant="outline" size="xs" onclick={() => onRetry(side)}>
            <IconRefresh size={12} stroke={2} class="mr-1 inline" />Retry
          </Button>
        {/if}
      </div>
    {/if}
  </div>
{/snippet}

<article
  class={cn(
    'flex gap-3 rounded-xl border bg-dark-6 p-3',
    problem && problem !== 'uploading' ? 'border-amber-700/60' : 'border-dark-4'
  )}
>
  <div class="flex shrink-0 items-center gap-1.5">
    {#if showBefore}
      {@render image(pair.before, 'before')}
      <IconArrowRight size={16} stroke={2} class="text-dark-2" aria-hidden="true" />
    {/if}
    {#if pair.after}
      {@render image(pair.after, 'after')}
    {:else}
      <div
        class={cn(
          'flex shrink-0 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-dark-3 p-1',
          tile
        )}
      >
        {#if showBefore}<span class="text-[11px] text-dark-2">No after image</span>{/if}
        <Button variant="outline" size="xs" onclick={onUploadAfter}>
          <IconUpload size={12} stroke={2} class="mr-1 inline" />Upload
        </Button>
        <Button
          variant="outline"
          size="xs"
          onclick={onCreate}
          disabled={!pair.before.blobUrl?.startsWith('http')}
          title={pair.before.blobUrl?.startsWith('http') ? undefined : 'Available once the starting image has uploaded'}
        >
          <IconWand size={12} stroke={2} class="mr-1 inline" />Create
        </Button>
      </div>
    {/if}
  </div>

  <div class="flex min-w-0 flex-1 flex-col gap-1.5">
    <Textarea
      value={pair.instruction}
      oninput={(e) => onInstruction(e.currentTarget.value)}
      rows={showBefore ? 3 : 2}
      placeholder="Describe the edit, e.g. Turn the person 90 degrees to their left"
      aria-label="Instruction for {pair.before.name}"
      class={cn('min-h-0 flex-1 resize-none text-sm', problem === 'no-instruction' && 'border-amber-700/70')}
    />
    <div class="flex min-h-8 items-center justify-between gap-2">
      {#if problem === 'no-after'}
        <span class="text-xs text-amber-400">Needs an after image</span>
      {:else if problem === 'failed'}
        <span class="text-xs text-red-300">An image didn't upload</span>
      {:else if problem === 'no-instruction'}
        <span class="flex items-center gap-2">
          <span class="text-xs text-amber-400">Needs an instruction</span>
          {#if suggesting}
            <Spinner class="size-3.5" aria-label="Suggesting an instruction" />
          {:else if canSuggest}
            <Button
              variant="ghost"
              size="xs"
              onclick={onSuggest}
              title={suggestPrice != null ? `Costs ${suggestPrice} Buzz` : undefined}
            >
              <IconSparkles size={12} stroke={2} class="mr-1 inline" />Suggest{suggestPrice != null
                ? ` · ⚡${suggestPrice}`
                : ''}
            </Button>
          {/if}
        </span>
      {:else}
        <span class="truncate font-mono text-[11px] text-dark-2" title={pair.before.name}>
          {sourceLabel} · {pair.before.name}
        </span>
      {/if}
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Remove pair {pair.before.name}"
        onclick={onRemove}
        class="shrink-0 text-dark-2"
      >
        <IconX size={14} stroke={2} />
      </Button>
    </div>
  </div>
</article>
