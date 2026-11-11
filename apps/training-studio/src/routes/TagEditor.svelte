<script lang="ts">
  import { IconX } from '@tabler/icons-svelte';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { autoLabelAvailable } from '$lib/host';
  import { isTriggerTag, tagsHaveTrigger, withTags } from './trainingFlow';

  // `draft` is bindable so the label editor can commit a half-typed tag when it steps to the next image.
  let {
    tags,
    onchange,
    name,
    trigger,
    draft = $bindable(''),
    compact = false,
  }: {
    tags: string[];
    onchange: (tags: string[]) => void;
    /** The file name, for the input's accessible label. */
    name: string;
    trigger: string;
    draft?: string;
    /** The inline grid-card variant: shorter chip box, no Add button, commits on blur. */
    compact?: boolean;
  } = $props();

  const triggerText = $derived(trigger.trim());
  const triggerMissing = $derived(!!triggerText && !tagsHaveTrigger(trigger, tags));

  function commit() {
    if (draft.trim()) onchange(withTags(tags, draft));
    draft = '';
  }
  function removeTag(tag: string) {
    onchange(tags.filter((t) => t !== tag));
  }
  function keydown(e: KeyboardEvent) {
    if (e.key === 'Backspace' && draft === '' && tags.length > 0) {
      e.preventDefault();
      onchange(tags.slice(0, -1));
    }
  }
</script>

{#if triggerMissing && !compact}
  <div class="mb-2 flex items-center gap-2 text-xs text-dark-2">
    <span class="rounded border border-buzz/30 bg-buzz/10 px-2 py-0.5 font-mono text-buzz">{triggerText}</span>
    <span class="font-mono">auto-prepended to every tag</span>
  </div>
{/if}

<div
  class="flex flex-wrap content-start overflow-y-auto rounded border border-dark-4 bg-dark-7 {compact
    ? 'max-h-32 gap-1 p-1.5'
    : 'max-h-[40dvh] min-h-[64px] gap-1.5 p-2.5'}"
>
  {#if triggerMissing && compact && tags.length > 0}
    <span
      class="rounded border border-buzz/30 bg-buzz/10 px-1.5 py-0.5 font-mono text-xs text-buzz"
      title="Auto-prepended to every tag"
    >
      {triggerText}
    </span>
  {/if}
  {#if tags.length === 0}
    <span class="self-center font-mono text-xs text-dark-2">
      {compact
        ? 'No tags yet'
        : autoLabelAvailable()
          ? 'No tags yet — type below, paste comma-separated, or re-run auto-label.'
          : 'No tags yet — type below or paste comma-separated.'}
    </span>
  {/if}
  {#each tags as t (t)}
    <span
      class="inline-flex items-center gap-0.5 rounded border font-mono text-xs {compact
        ? 'py-0.5 pl-1.5 pr-0.5'
        : 'py-1 pl-2 pr-1'} {isTriggerTag(trigger, t)
        ? 'border-buzz/30 bg-buzz/10 text-buzz'
        : 'border-dark-4 bg-dark-6 text-dark-0'}"
    >
      {t}
      <button
        type="button"
        aria-label={`Remove ${t}`}
        onclick={() => removeTag(t)}
        class="grid place-items-center rounded text-dark-1 hover:bg-red-500/20 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary {compact
          ? 'h-4 w-4'
          : 'h-5 w-5'}"
      >
        <IconX size={compact ? 10 : 12} stroke={2} />
      </button>
    </span>
  {/each}
</div>

<form
  class="mt-2 flex gap-2"
  onsubmit={(e) => {
    e.preventDefault();
    commit();
  }}
>
  <Input
    bind:value={draft}
    onkeydown={keydown}
    onblur={compact ? commit : undefined}
    placeholder={compact ? 'Add tags…' : 'Add or paste tags…'}
    aria-label={`Add tags to ${name}`}
    class="min-w-0 flex-1 font-mono {compact ? 'h-7 px-2 text-xs' : ''}"
  />
  {#if !compact}
    <Button type="submit" variant="outline">Add</Button>
  {/if}
</form>
