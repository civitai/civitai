<script lang="ts">
  import { untrack } from 'svelte';
  import { IconBoltFilled, IconCheck } from '@tabler/icons-svelte';
  import { backend, browser } from '$lib/host';
  import { buzzMode } from '$lib/buzz-mode.svelte';
  import { isAbort } from '$lib/upload';
  import { EDIT_IMAGE_OPTIONS, type EditImageOption } from '$lib/edit-helpers-core';
  import BlueFirstNote from '$lib/components/BlueFirstNote.svelte';
  import '$lib/civitai-elements';
  import type { CivitaiTextInput } from '@civitai/components/civitai-text-input';
  import { pollUntilDone, type EditPair } from './editPairs';

  let {
    open = $bindable(false),
    pair,
    onUse,
  }: {
    open: boolean;
    pair: EditPair | null;
    /** `workflowId` is the run that made it — the authenticated way back to its bytes. */
    onUse: (option: EditImageOption, prompt: string, workflowId: string) => void;
  } = $props();

  let prompt = $state('');
  let running = $state(false);
  let options = $state<EditImageOption[]>([]);
  let picked = $state<string | null>(null);
  let failure = $state('');
  let runId = '';
  let controller: AbortController | null = null;

  // Each opening starts from the pair's own instruction and no previous results.
  $effect(() => {
    if (!open) return;
    untrack(() => {
      prompt = pair?.instruction ?? '';
      options = [];
      picked = null;
      failure = '';
      runId = '';
    });
    return () => {
      controller?.abort();
      controller = null;
      running = false;
    };
  });

  const imageUrl = $derived(pair?.before.blobUrl?.startsWith('http') ? pair.before.blobUrl : null);
  // Generate stays disabled until this resolves to a price, as Review does for a training run.
  const price = $derived(open && browser && imageUrl ? backend().editImageQuote(imageUrl) : null);

  async function generate() {
    if (!imageUrl || running || !prompt.trim()) return;
    controller?.abort();
    const ctrl = new AbortController();
    controller = ctrl;
    running = true;
    failure = '';
    options = [];
    picked = null;
    try {
      const { workflowId } = await backend().editImageSubmit({
        imageUrl,
        prompt: prompt.trim(),
        currencies: buzzMode.currencies,
      });
      runId = workflowId;
      const result = await pollUntilDone((signal) => backend().editImagePoll(workflowId, signal), ctrl.signal);
      options = result.options;
      picked = result.options[0]?.blobId ?? null;
      if (result.options.length === 0) failure = 'No usable image came back. Try a different description.';
    } catch (err) {
      if (!isAbort(err) && !ctrl.signal.aborted)
        failure = err instanceof Error ? err.message : 'The image could not be created.';
    } finally {
      if (controller === ctrl) {
        controller = null;
        running = false;
      }
    }
  }

  function use() {
    const option = options.find((o) => o.blobId === picked);
    if (!option) return;
    onUse(option, prompt.trim(), runId);
    open = false;
  }
</script>

{#snippet generateButton(cost: number | null)}
  <civitai-button
    class="self-start"
    loading={running}
    onclick={generate}
    disabled={cost == null || !imageUrl || running || !prompt.trim()}
  >
    {#if !running}<span slot="left"><IconBoltFilled size={14} class="text-buzz" /></span>{/if}
    Generate {EDIT_IMAGE_OPTIONS} options{cost != null ? ` · ${cost.toLocaleString()}` : ''}
  </civitai-button>
{/snippet}

<!-- Overlay clicks don't close it: a drag that ends past the panel lands as an overlay click, and closing
     mid-generation loses options already paid for. -->
<civitai-modal
  size="lg"
  {open}
  heading="Create the after image"
  with-close-button
  closeOnOverlayClick={false}
  close-label="Close"
  onclose={() => (open = false)}
>
  <p class="m-0 mb-3 text-sm text-dark-2">
    Describe the edit. An edit model makes {EDIT_IMAGE_OPTIONS} options from
    <span class="font-mono">{pair?.before.name ?? 'the starting image'}</span>; keep the right one.
    Your description becomes the instruction if the pair has none.
  </p>

  <div class="flex flex-wrap items-end gap-3">
    {#if pair?.before.previewUrl}
      <img
        src={pair.before.previewUrl}
        alt=""
        class="h-28 w-28 shrink-0 rounded-lg border border-dark-4 object-cover"
      />
    {/if}
    <div class="flex min-w-60 flex-1 flex-col gap-1.5">
      <civitai-text-input
        label="Edit"
        placeholder="e.g. Put the logo on the bag"
        value={prompt}
        oninput={(e: Event) => (prompt = (e.currentTarget as CivitaiTextInput).value)}
      ></civitai-text-input>
      {#if price}
        {#await price}
          {@render generateButton(null)}
          <span class="text-xs text-dark-2">Checking the price…</span>
        {:then cost}
          {@render generateButton(cost)}
          {#if cost != null}
            <span class="text-xs text-dark-2">
              Costs <IconBoltFilled size={11} class="inline text-buzz" />{cost.toLocaleString()} Buzz for
              {EDIT_IMAGE_OPTIONS} options, charged when you generate.
            </span>
          {:else}
            <span class="text-xs text-amber-400">Couldn't price this right now — try again in a moment.</span>
          {/if}
        {:catch}
          {@render generateButton(null)}
          <span class="text-xs text-amber-400">Couldn't price this right now — try again in a moment.</span>
        {/await}
      {:else}
        {@render generateButton(null)}
      {/if}
      <BlueFirstNote />
    </div>
  </div>

  {#if running}
    <div class="mt-3 flex items-center gap-2 text-sm text-dark-2" role="status">
      <civitai-loader size="sm"></civitai-loader> Generating… this takes about a minute. It's already paid for, so
      closing now loses the options without refunding them.
    </div>
  {/if}
  {#if failure}
    <p class="m-0 text-sm text-red-400" role="alert">{failure}</p>
  {/if}

  {#if options.length}
    <div class="mt-3 font-mono text-xs uppercase tracking-wider text-dark-2">Pick one</div>
    <div class="grid grid-cols-3 gap-2.5" role="radiogroup" aria-label="Generated options">
      {#each options as option, i (option.blobId)}
        <button
          type="button"
          role="radio"
          aria-checked={picked === option.blobId}
          aria-label="Option {i + 1}"
          onclick={() => (picked = option.blobId)}
          class="relative aspect-square overflow-hidden rounded-lg border-2 {picked === option.blobId
            ? 'border-primary'
            : 'border-transparent hover:border-dark-3'}"
        >
          <img src={option.url} alt="" class="h-full w-full object-cover" />
          {#if picked === option.blobId}
            <span class="absolute right-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-primary text-primary-foreground">
              <IconCheck size={12} stroke={3} />
            </span>
          {/if}
        </button>
      {/each}
    </div>
  {/if}

  <div class="mt-4 flex flex-wrap justify-end gap-2">
    <civitai-button variant="subtle" onclick={() => (open = false)}>Cancel</civitai-button>
    <civitai-button onclick={use} disabled={!picked || running}>Use this image</civitai-button>
  </div>
</civitai-modal>
