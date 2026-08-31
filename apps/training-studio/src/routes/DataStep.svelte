<script module lang="ts">
  // Stand-in label seeds — not real auto-labels. Do not build on these; they're replaced by the
  // orchestrator's signal stream when per-blob upload lands (CLAUDE.md).
  const TAGSETS: string[][] = [
    ['1girl', 'solo', 'looking at viewer', 'close-up', 'detailed face', 'soft lighting'],
    ['1girl', 'portrait', 'front view', 'neutral background', 'freckles', 'smile'],
    ['1girl', 'side profile', 'long hair', 'window light', 'pensive'],
    ['1girl', 'full body', 'standing', 'casual clothes', 'outdoors', 'daylight'],
    ['1girl', 'upper body', 'dramatic lighting', 'dark background', 'serious'],
    ['1girl', 'three-quarter view', 'detailed eyes', 'studio', 'soft focus'],
    ['1girl', 'solo', 'sitting', 'indoors', 'warm light', 'relaxed'],
    ['1girl', 'close-up', 'freckles', 'blue eyes', 'natural light'],
    ['1girl', 'action pose', 'motion blur', 'dynamic', 'outdoors'],
    ['1girl', 'headshot', 'plain background', 'sharp focus', 'neutral expression'],
    ['1girl', 'full body', 'walking', 'street', 'overcast'],
    ['1girl', 'portrait', 'golden hour', 'backlight', 'smiling'],
  ];
  const CAPSETS: string[] = [
    'a close-up portrait, soft even lighting, highly detailed face, looking at the viewer',
    'a front-facing portrait, freckled skin, gentle smile, neutral studio background',
    'a side profile with long hair, soft window light, a pensive expression',
    'a full-body shot standing outdoors in casual clothes, natural daylight',
    'an upper-body portrait under dramatic lighting against a dark background',
    'a three-quarter view, detailed eyes, studio setup with soft focus',
    'sitting indoors, warm ambient light, relaxed pose',
    'a close-up with freckles and blue eyes, soft natural light',
    'an action shot mid-motion outdoors with subtle motion blur',
    'a headshot on a plain background, sharp focus, neutral expression',
    'a full-body photo walking down a street on an overcast day',
    'a golden-hour portrait, warm backlight, smiling',
  ];
  const POOL = ['1girl', '1boy', 'solo', 'looking at viewer', 'smile', 'portrait', 'full body', 'upper body', 'outdoors', 'indoors', 'detailed face', 'soft lighting', 'dramatic lighting', 'blue eyes', 'long hair', 'freckles', 'casual clothes', 'sitting', 'standing'];
</script>

<script lang="ts">
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import * as Dialog from '@civitai/ui/components/ui/dialog/index.js';
  import * as Tooltip from '@civitai/ui/components/ui/tooltip/index.js';
  import { loraTypeById } from '$lib/data/trainingModels';
  import GradientTile from '$lib/components/GradientTile.svelte';
  import { labelNoun, runCard, type Img, type Selection } from './trainingFlow';

  // images + trigger are owned by the flow (TrainingFlow) so they survive Back/Continue.
  let {
    selection,
    images = $bindable([]),
    trigger = $bindable(''),
    onContinue,
    onBack,
  }: {
    selection: Selection;
    images: Img[];
    trigger: string;
    onContinue: () => void;
    onBack: () => void;
  } = $props();

  const type = $derived(loraTypeById(selection.loraType));
  // A dataset has one label type; SelectStep's label-type lock guarantees every run in a
  // multi-run selection shares run[0]'s, so run[0] is representative of the whole dataset.
  const primaryCard = $derived(runCard(selection.runs[0]!));
  const labelMode = $derived(primaryCard.label);
  const noun = $derived(labelNoun(primaryCard));

  let editorOpen = $state(false);
  let editorIdx = $state(0);
  let newTag = $state('');

  const labeled = $derived(images.filter((i) => i.done).length);
  const canContinue = $derived(images.length > 0 && labeled === images.length);
  const enough = $derived(images.length >= type.minImg);

  function addDataset() {
    if (images.length > 0) return;
    images = TAGSETS.map((tags, i) => ({ id: i, tags: [...tags], caption: CAPSETS[i]!, done: false }));
    // TODO(orchestrator): upload each blob individually, scan on upload, and append the auto-label
    // returned over signals. This setTimeout stands in for that stream.
    images.forEach((_, i) => setTimeout(() => (images[i]!.done = true), 500 + i * 150));
  }

  function relabelOne(i: number) {
    images[i]!.done = false;
    setTimeout(() => (images[i]!.done = true), 600);
  }

  function openEditor(i: number) {
    editorIdx = i;
    newTag = '';
    editorOpen = true;
  }
  function editStep(d: number) {
    editorIdx = (editorIdx + d + images.length) % images.length;
    newTag = '';
  }
  function addTag() {
    const v = newTag.trim();
    if (v && !images[editorIdx]!.tags.includes(v)) {
      images[editorIdx]!.tags = [...images[editorIdx]!.tags, v];
    }
    newTag = '';
  }
  function removeTag(k: number) {
    images[editorIdx]!.tags = images[editorIdx]!.tags.filter((_, x) => x !== k);
  }
  function suggestions(img: Img) {
    return POOL.filter((p) => !img.tags.includes(p)).slice(0, 10);
  }
</script>

<div class="flex flex-col gap-5">
  <div>
    <h2 class="m-0 text-xl font-semibold text-white">Add your data</h2>
    <p class="mt-1 text-sm text-dark-2">
      Build a dataset from any of these — mix and match freely. Everything is auto-labeled as
      <strong class="text-dark-0">{noun}</strong> for you, for free.
    </p>
  </div>

  <div class="flex flex-wrap gap-2.5">
    <Button variant="outline" onclick={addDataset}>⬆ Upload files</Button>
    <Button variant="outline" onclick={addDataset}>🖼 From my generations</Button>
    <Button variant="outline" onclick={addDataset}>♻ Reuse a dataset</Button>
  </div>

  {#if images.length === 0}
    <button
      type="button"
      onclick={addDataset}
      class="rounded-md border-2 border-dashed border-dark-4 bg-dark-6 p-9 text-center transition hover:border-primary"
    >
      <div class="text-3xl">📁</div>
      <div class="mt-2 text-base font-semibold text-dark-0">Drop images, video, or audio</div>
      <div class="mt-2 font-mono text-xs text-dark-2">
        JPG · PNG · WEBP · MP4 · WEBM · MP3 · media type auto-detected
      </div>
      <div class="mt-1.5 font-mono text-xs text-dark-2">
        Already labeled? Drop a .zip with matching .txt files and we'll use those.
      </div>
      <div class="mt-2.5 font-mono text-xs text-[#f59f00]">▸ Click to add a sample dataset</div>
    </button>
  {:else}
    <div class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div class="min-w-0">
        <div class="mb-4 flex items-center gap-3 rounded-md border border-dark-4 bg-dark-6 px-4 py-3">
          <span class="grid h-8 w-8 place-items-center rounded bg-primary/15 text-base">
            {labelMode === 'tag' ? '🏷️' : '📝'}
          </span>
          <div>
            <div class="text-sm font-bold text-dark-0">
              Auto-labeled as {noun} · free
            </div>
            <div class="font-mono text-[11px] text-dark-2">
              {labelMode === 'tag'
                ? `${primaryCard.name} trains on booru-style tags`
                : `${primaryCard.name} learns from natural-language captions`} — chosen automatically
            </div>
          </div>
        </div>

        <div
          class="mb-4 flex items-center gap-2 rounded-md border px-4 py-2.5 text-sm
            {enough
            ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-400'
            : 'border-[#f59f00]/30 bg-[#f59f00]/10 text-[#f59f00]'}"
        >
          {#if enough}
            ✓ {images.length} images — good for a {type.name.toLowerCase()} (we recommend ≥{type.minImg}).
          {:else}
            ⚠️ Only {images.length} images. We recommend at least {type.minImg} for a
            {type.name.toLowerCase()} — results may be weak.
          {/if}
        </div>

        <div class="mb-3 flex items-center justify-between">
          <b class="text-dark-0">{images.length} images · {labeled} labeled</b>
          <span class="font-mono text-xs text-dark-2">✎ edit · ↻ relabel one</span>
        </div>

        <div class="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
          {#each images as img, i (img.id)}
            <div class="overflow-hidden rounded-md border border-dark-4 bg-dark-6">
              <GradientTile index={i} class="relative rounded-none">
                {#if !img.done}
                  <div class="absolute inset-0 grid place-items-center bg-black/40">
                    <span class="font-mono text-[11px] text-white">✨ labeling…</span>
                  </div>
                {/if}
                <div class="absolute right-1.5 top-1.5 flex gap-1">
                  <button
                    type="button"
                    aria-label="Relabel"
                    onclick={() => relabelOne(i)}
                    class="grid h-6 w-6 place-items-center rounded-md bg-black/60 text-xs text-white hover:bg-primary"
                  >
                    ↻
                  </button>
                  <button
                    type="button"
                    aria-label="Edit label"
                    onclick={() => openEditor(i)}
                    class="grid h-6 w-6 place-items-center rounded-md bg-black/60 text-xs text-white hover:bg-primary"
                  >
                    ✎
                  </button>
                </div>
              </GradientTile>
              <div class="min-h-[56px] p-2.5">
                {#if !img.done}
                  <div class="font-mono text-[11px] text-dark-2">✨ labeling…</div>
                {:else if labelMode === 'tag'}
                  <div class="flex flex-wrap gap-1">
                    {#if trigger}
                      <span class="rounded border border-[#f59f00]/30 bg-[#f59f00]/10 px-1.5 py-0.5 font-mono text-[10px] text-[#f59f00]">
                        {trigger}
                      </span>
                    {/if}
                    {#each img.tags.slice(0, 4) as t (t)}
                      <span class="rounded border border-dark-4 bg-dark-7 px-1.5 py-0.5 font-mono text-[10px] text-dark-2">
                        {t}
                      </span>
                    {/each}
                    {#if img.tags.length > 4}
                      <span class="rounded px-1.5 py-0.5 font-mono text-[10px] text-dark-2">
                        +{img.tags.length - 4}
                      </span>
                    {/if}
                  </div>
                {:else}
                  <div class="line-clamp-3 text-[11px] leading-snug text-dark-2">
                    {#if trigger}<span class="font-semibold text-[#f59f00]">{trigger}</span>, {/if}{img.caption}
                  </div>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </div>

      <aside class="sticky top-4 h-fit max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-md border border-dark-4 bg-dark-6 p-5">
        <div class="flex items-center gap-1.5">
          <h3 class="m-0 font-mono text-xs uppercase tracking-widest text-dark-2">Trigger word</h3>
          <Tooltip.Provider>
            <Tooltip.Root>
              <Tooltip.Trigger
                class="grid h-4 w-4 place-items-center rounded-full border border-dark-4 font-mono text-[10px] text-dark-2"
              >
                ?
              </Tooltip.Trigger>
              <Tooltip.Content class="max-w-[240px] text-xs">
                An optional word prepended to every label. The model learns to associate it with your
                subject, so you type it in prompts to summon the LoRA. Less essential on modern caption
                models; handy for characters. Some large/video models can't train it (no-op).
              </Tooltip.Content>
            </Tooltip.Root>
          </Tooltip.Provider>
        </div>
        <Input bind:value={trigger} placeholder="optional, e.g. my_character" class="mt-2 font-mono" />
        <p class="mt-2 text-[12px] leading-snug text-dark-2">
          Prepended &amp; <span class="text-[#f59f00]">highlighted</span> in every label. Leave blank to
          skip.
        </p>
      </aside>
    </div>
  {/if}

  <div class="flex items-center justify-between gap-3 border-t border-dark-4 pt-5">
    <Button variant="outline" onclick={onBack}>← Back</Button>
    <Button disabled={!canContinue} onclick={onContinue}>Continue to Review →</Button>
  </div>
</div>

<!-- label editor -->
<Dialog.Root bind:open={editorOpen}>
  <Dialog.Content class="max-w-3xl">
    {#if images[editorIdx]}
      {@const img = images[editorIdx]}
      <Dialog.Header>
        <Dialog.Title>{labelMode === 'tag' ? 'Edit tags' : 'Edit caption'}</Dialog.Title>
        <Dialog.Description>image {editorIdx + 1} / {images.length}</Dialog.Description>
      </Dialog.Header>

      {#if labelMode === 'tag'}
        <div class="grid gap-4 sm:grid-cols-[220px_1fr]">
          <GradientTile index={editorIdx} class="border border-dark-4" />
          <div>
            <div class="mb-2 font-mono text-xs uppercase tracking-wider text-dark-2">
              Tags {#if trigger}· <span class="text-[#f59f00]">{trigger}</span> pinned first{/if}
            </div>
            <div class="flex min-h-[64px] flex-wrap content-start gap-1.5 rounded border border-dark-4 bg-dark-7 p-2.5">
              {#if trigger}
                <span class="rounded border border-[#f59f00]/30 bg-[#f59f00]/10 px-2 py-1 font-mono text-xs text-[#f59f00]">
                  {trigger}
                </span>
              {/if}
              {#each img.tags as t, k (t)}
                <span class="inline-flex items-center gap-1.5 rounded border border-dark-4 bg-dark-6 px-2 py-1 font-mono text-xs text-dark-0">
                  {t}
                  <button type="button" aria-label={`Remove ${t}`} onclick={() => removeTag(k)} class="text-dark-2 hover:text-red-400">✕</button>
                </span>
              {/each}
            </div>
            <form
              class="mt-2 flex gap-2"
              onsubmit={(e) => {
                e.preventDefault();
                addTag();
              }}
            >
              <Input bind:value={newTag} placeholder="Add a tag and press Enter" class="font-mono" />
              <Button type="submit" variant="outline">Add</Button>
            </form>
            <div class="mt-3">
              <div class="mb-1.5 font-mono text-[11px] uppercase tracking-wider text-dark-2">Suggested</div>
              <div class="flex flex-wrap gap-1.5">
                {#each suggestions(img) as p (p)}
                  <Button
                    variant="outline"
                    size="xs"
                    class="font-mono"
                    onclick={() => !img.tags.includes(p) && (img.tags = [...img.tags, p])}
                  >
                    + {p}
                  </Button>
                {/each}
              </div>
            </div>
          </div>
        </div>
      {:else}
        <div class="flex flex-col gap-3">
          <GradientTile index={editorIdx} class="aspect-auto h-44 w-full border border-dark-4" />
          <div>
            <div class="mb-2 font-mono text-xs uppercase tracking-wider text-dark-2">Caption</div>
            <Textarea bind:value={img.caption} rows={6} />
            <p class="mt-2 text-xs text-dark-2">
              Trigger <span class="text-[#f59f00]">{trigger || '(none)'}</span> is prepended automatically.
            </p>
          </div>
        </div>
      {/if}

      <Dialog.Footer>
        <Button variant="outline" onclick={() => editStep(-1)}>← Prev</Button>
        <Button variant="outline" onclick={() => editStep(1)}>Next →</Button>
        <Button onclick={() => (editorOpen = false)}>Done</Button>
      </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>
