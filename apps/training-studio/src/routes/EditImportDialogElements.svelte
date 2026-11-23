<script lang="ts">
  import { untrack } from 'svelte';
  import { browser } from '$lib/host';
  import '$lib/civitai-elements';
  import type { CivitaiTextInput } from '@civitai/components/civitai-text-input';
  import { readEditZip, type ImportedPair } from './editPairs';
  import { plural } from './trainingFlow';

  let {
    open = $bindable(false),
    file,
    knownStarts,
    onImport,
  }: {
    open: boolean;
    file: File | null;
    /** `sha:` start keys already in the dataset, so a shared starting image is reported up front. */
    knownStarts: ReadonlySet<string>;
    onImport: (pairs: ImportedPair[], defaultInstruction: string) => void;
  } = $props();

  const reading = $derived(browser && file ? readEditZip(file) : null);
  let defaultInstruction = $state('');
  $effect(() => {
    // A new file starts with an empty default, never the previous zip's.
    void file;
    untrack(() => (defaultInstruction = ''));
  });

  function summary(pairs: ImportedPair[]) {
    const seen = new Set<string>();
    let shared = 0;
    for (const p of pairs) {
      if (!p.beforeHash) continue;
      if (knownStarts.has(`sha:${p.beforeHash}`) || seen.has(p.beforeHash)) shared += 1;
      seen.add(p.beforeHash);
    }
    return {
      complete: pairs.filter((p) => p.after).length,
      shared,
      noAfter: pairs.filter((p) => !p.after),
      noInstruction: pairs.filter((p) => !p.instruction).length,
    };
  }

  function confirm(pairs: ImportedPair[]) {
    onImport(pairs, defaultInstruction.trim());
    open = false;
  }
</script>

{#snippet row(tone: 'ok' | 'join' | 'warn' | 'skip', mark: string, title: string, detail: string)}
  <div class="flex items-start gap-3 border-t border-dark-4 py-2.5 first:border-t-0">
    <span
      class="grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold
        {tone === 'ok'
        ? 'bg-emerald-500/15 text-emerald-400'
        : tone === 'join'
          ? 'bg-sky-500/15 text-sky-400'
          : tone === 'warn'
            ? 'bg-amber-500/15 text-amber-400'
            : 'bg-dark-5 text-dark-2'}"
      aria-hidden="true">{mark}</span
    >
    <div class="min-w-0">
      <div class="text-sm font-semibold text-dark-0">{title}</div>
      <div class="text-sm text-dark-2">{detail}</div>
    </div>
  </div>
{/snippet}

<civitai-modal
  size="lg"
  {open}
  heading="Import {file?.name ?? 'dataset'}"
  with-close-button
  closeOnOverlayClick={false}
  close-label="Close"
  onclose={() => (open = false)}
>
  <p class="m-0 mb-3 text-sm text-dark-2">Here is how its pairs join your dataset.</p>

  {#if reading}
    {#await reading}
      <div class="flex items-center justify-center gap-2 py-12 text-sm text-dark-2">
        <civitai-loader size="sm"></civitai-loader> Reading the zip…
      </div>
    {:then read}
      {#if !read || read.pairs.length === 0}
        <div class="flex flex-col gap-3 py-4 text-sm text-dark-2">
          <p class="m-0">
            This zip has no before/after folders, so there are no pairs to import. A dataset zip
            looks like this:
          </p>
          {@render layout()}
        </div>
        <div class="mt-4 flex justify-end">
          <civitai-button variant="subtle" onclick={() => (open = false)}>Close</civitai-button>
        </div>
      {:else}
        {@const s = summary(read.pairs)}
        <div class="flex flex-col">
          {#if s.complete}
            {@render row('ok', '✓', plural(s.complete, 'new pair'), 'Added to your list next to the pairs you uploaded, tagged as coming from this zip.')}
          {/if}
          {#if s.shared}
            {@render row(
              'join',
              '=',
              `${plural(s.shared, 'pair')} share a starting image with another pair`,
              'Both are kept, and show together in Group by starting image.'
            )}
          {/if}
          {#if s.noAfter.length}
            {@render row(
              'warn',
              '!',
              `${plural(s.noAfter.length, 'starting image')} without an after image`,
              `${s.noAfter
                .slice(0, 3)
                .map((p) => p.before.name)
                .join(', ')}${s.noAfter.length > 3 ? '…' : ''} — added and flagged, so you can upload or create the after image.`
            )}
          {/if}
          {#if read.orphanAfters.length}
            {@render row(
              'skip',
              '–',
              `${plural(read.orphanAfters.length, 'after image')} with no starting image`,
              `${read.orphanAfters
                .slice(0, 3)
                .map((p) => p.split('/').pop())
                .join(', ')} — skipped. Rename to match a starting image and import again.`
            )}
          {/if}
          {#if read.ignored.length}
            {@render row(
              'skip',
              '–',
              `${plural(read.ignored.length, 'image')} outside the before/after folders`,
              'Skipped — each pair has one starting image and one result.'
            )}
          {/if}
        </div>

        {#if s.noInstruction}
          <civitai-text-input
            class="mt-3 block"
            label="Instruction for pairs without a .txt"
            description="Applies to {plural(s.noInstruction, 'pair')}. Each stays editable on its card."
            placeholder="e.g. Put the logo on the product"
            value={defaultInstruction}
            oninput={(e: Event) => (defaultInstruction = (e.currentTarget as CivitaiTextInput).value)}
          ></civitai-text-input>
        {/if}

        <details class="mt-3 rounded-md border border-dark-4 px-3 py-2">
          <summary class="text-sm text-dark-2">What a dataset zip looks like</summary>
          <div class="mt-2">{@render layout()}</div>
        </details>

        <div class="mt-4 flex flex-wrap justify-end gap-2">
          <civitai-button variant="subtle" onclick={() => (open = false)}>Cancel</civitai-button>
          <civitai-button onclick={() => confirm(read.pairs)}>Add {read.pairs.length} to dataset</civitai-button>
        </div>
      {/if}
    {:catch}
      <div class="py-12 text-center text-sm text-red-400">
        Couldn't read that file. Is it a .zip?
      </div>
    {/await}
  {/if}
</civitai-modal>

{#snippet layout()}
  <pre class="m-0 font-mono text-xs leading-relaxed text-dark-0">control_1/  starting images
main/       after images, same file names
main/*.txt  instructions, same file names</pre>
{/snippet}
