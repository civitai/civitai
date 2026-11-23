<script lang="ts">
  import '$lib/civitai-elements';
  import type { CivitaiTextarea } from '@civitai/components/civitai-textarea';
  import { IconChevronLeft, IconChevronRight, IconSparkles, IconMusic } from '@tabler/icons-svelte';
  import type { LabelType } from '$lib/data/trainingModels';
  import { canAutoLabelImage, captionTriggerHit, repeatsOf, withTags, type Img } from './trainingFlow';
  import TagEditor from './TagEditor.svelte';
  import RepeatsStepper from './RepeatsStepper.svelte';

  // `editing` is the flow's own image proxy, so mutating its tags/caption here applies live to the grid.
  // `onRelabel` runs the auto-label driver (owned by the parent); `tagVocab` is this dataset's tags for
  // autocomplete.
  let {
    open = $bindable(false),
    editing,
    labelMode,
    trigger,
    tagVocab,
    onRelabel,
    position,
    onStep,
    repeatsEnabled = false,
  }: {
    open: boolean;
    editing: Img | undefined;
    labelMode: LabelType;
    trigger: string;
    tagVocab: string[];
    /** Absent when the host has no auto-label: the Re-run buttons don't render. */
    onRelabel?: (id: number) => void;
    /** Where `editing` sits in the grid's sequence; `index` is -1 when it isn't in it. */
    position: { index: number; total: number };
    onStep: (delta: -1 | 1) => void;
    /** The selected models can train per-image repeats: show the Repeats row. */
    repeatsEnabled?: boolean;
  } = $props();

  let newTag = $state('');
  const triggerText = $derived(trigger.trim());

  // Clear the input each time the editor opens, so a half-typed tag doesn't carry into the next image.
  $effect(() => {
    if (open) newTag = '';
  });

  const canPrev = $derived(position.index > 0);
  const canNext = $derived(position.index >= 0 && position.index < position.total - 1);

  // A half-typed tag is committed rather than dropped: moving on is how a tagging pass ends an image.
  function step(delta: -1 | 1) {
    if (delta === -1 ? !canPrev : !canNext) return;
    if (editing && labelMode === 'tag') editing.tags = withTags(editing.tags, newTag);
    newTag = '';
    onStep(delta);
  }
  // Alt+arrows, so plain arrows still move the caret in the tag input and caption textarea.
  function stepKeydown(e: KeyboardEvent) {
    if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    step(e.key === 'ArrowLeft' ? -1 : 1);
  }

  function clearTags() {
    if (editing) editing.tags = [];
  }

  // Suggest tags from this dataset's own vocabulary (already frequency-ranked), filtered by what's typed
  // and not already on this image.
  const suggestions = $derived.by(() => {
    if (!editing) return [];
    const q = newTag.trim().toLowerCase();
    const have = new Set(editing.tags.map((t) => t.toLowerCase()));
    return tagVocab
      .filter((t) => !have.has(t.toLowerCase()) && (q === '' || t.toLowerCase().includes(q)))
      .slice(0, 8);
  });

  // Focus the primary field (tag input / caption textarea) on open — this is a correction surface, the
  // user came here to type. Dialog would otherwise land focus on the first chip's remove ✕.
  function autofocusInput(node: HTMLElement) {
    queueMicrotask(async () => {
      const kit = node.querySelector<CivitaiTextarea>('civitai-textarea');
      if (!kit) return node.querySelector<HTMLElement>('input, textarea')?.focus();
      // The kit field's <textarea> is in its shadow root, there once it has updated.
      await kit.updateComplete;
      kit.shadowRoot?.querySelector('textarea')?.focus();
    });
  }
</script>

<!-- The preview adapts to the media: an image, a playable <video>, or an <audio> player for audio clips —
     so captioning an audio/video dataset lets you actually see/hear what you're labeling. -->
{#snippet mediaPreview(img: Img, cls: string)}
  {#if img.mediaType === 'audio'}
    <div
      class="flex flex-col items-center justify-center gap-3 rounded border border-dark-4 bg-dark-7 p-4 {cls}"
    >
      <IconMusic size={28} stroke={2} class="text-dark-2" />
      <div class="w-full break-all text-center font-mono text-xs text-dark-2">{img.name}</div>
      <audio src={img.previewUrl} controls preload="metadata" class="w-full"></audio>
    </div>
  {:else if img.mediaType === 'video'}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video src={img.previewUrl} controls class="rounded border border-dark-4 {cls}"></video>
  {:else}
    <img src={img.previewUrl} alt="" class="rounded border border-dark-4 {cls}" />
  {/if}
{/snippet}

<!-- The scroll box's max-h budgets for the heading, Previous/Next and Repeats rows, so those and the
     close ✕ stay on screen; if it's too tall the whole dialog scrolls instead. dvh, not vh: mobile
     browser chrome makes vh taller than the visible area. -->
<civitai-modal
  class="[&::part(panel)]:max-w-4xl"
  {open}
  heading={labelMode === 'tag' ? 'Edit tags' : 'Edit caption'}
  with-close-button
  close-label="Close"
  onclose={() => (open = false)}
  onkeydown={stepKeydown}
>
    <!-- Gated on `open`: the kit modal keeps its slot mounted while closed, so a playing clip would keep
         playing and reopening the same image wouldn't re-run the input's autofocus. -->
    {#if open && editing}
      <p class="m-0 mb-3 truncate font-mono text-xs text-dark-2" title={editing.name}>{editing.name}</p>
      {#if position.total > 1 && position.index >= 0}
        <div class="flex items-center justify-between gap-2">
          <civitai-button variant="outline" size="sm" onclick={() => step(-1)} disabled={!canPrev} title="Previous (Alt+←)">
            <span slot="left"><IconChevronLeft size={13} stroke={2} /></span>Previous
          </civitai-button>
          <span class="font-mono text-xs text-dark-2" aria-live="polite">
            {position.index + 1} / {position.total}
          </span>
          <civitai-button variant="outline" size="sm" onclick={() => step(1)} disabled={!canNext} title="Next (Alt+→)">
            Next<span slot="right"><IconChevronRight size={13} stroke={2} /></span>
          </civitai-button>
        </div>
      {/if}
      <!-- -m-1 p-1 keeps the inputs' focus rings from being clipped by the scroll box. -->
      <div class="-m-1 mt-3 max-h-[calc(100dvh-14rem)] min-h-0 overflow-y-auto p-1">
        {#key editing.id}
          {#if labelMode === 'tag'}
            <div class="grid gap-4 sm:grid-cols-2" use:autofocusInput>
              {@render mediaPreview(editing, 'max-h-[60dvh] w-full object-contain')}
              <div>
                <div class="mb-2 flex items-center justify-between gap-2">
                  <span class="font-mono text-xs uppercase tracking-wider text-dark-2">Tags</span>
                  <div class="flex items-center gap-1">
                    {#if onRelabel && canAutoLabelImage(editing)}
                    <civitai-button variant="subtle" size="sm" loading={editing.labeling} onclick={() => onRelabel(editing.id)} disabled={editing.labeling}>
                      <span slot="left"><IconSparkles size={12} stroke={2} /></span>Re-run
                    </civitai-button>
                    {/if}
                    {#if editing.tags.length > 0}
                      <civitai-button variant="subtle" size="sm" onclick={clearTags}>Clear all</civitai-button>
                    {/if}
                  </div>
                </div>

                <TagEditor
                  tags={editing.tags}
                  onchange={(tags) => (editing.tags = tags)}
                  name={editing.name}
                  {trigger}
                  bind:draft={newTag}
                />

                {#if suggestions.length > 0}
                  <div class="mt-2">
                    <div class="mb-1 font-mono text-xs uppercase tracking-wider text-dark-2">From this dataset</div>
                    <div class="flex flex-wrap gap-1">
                      {#each suggestions as s (s)}
                        <civitai-button
                          variant="outline"
                          size="sm"
                          onclick={() => {
                            editing.tags = withTags(editing.tags, s);
                            newTag = '';
                          }}
                        >
                          + {s}
                        </civitai-button>
                      {/each}
                    </div>
                  </div>
                {/if}
              </div>
            </div>
          {:else}
            <div class="flex flex-col gap-3" use:autofocusInput>
              {@render mediaPreview(editing, 'max-h-[50dvh] w-full object-contain')}
              <div>
                <div class="mb-2 flex items-center justify-end gap-2">
                  {#if onRelabel && canAutoLabelImage(editing)}
                  <civitai-button variant="subtle" size="sm" loading={editing.labeling} onclick={() => onRelabel(editing.id)} disabled={editing.labeling}>
                    <span slot="left"><IconSparkles size={12} stroke={2} /></span>Re-run
                  </civitai-button>
                  {/if}
                </div>
                <civitai-textarea
                  label="Caption"
                  rows={6}
                  placeholder="Describe the image…"
                  value={editing.caption}
                  oninput={(e: Event) => (editing!.caption = (e.currentTarget as CivitaiTextarea).value)}
                ></civitai-textarea>
                <p class="mt-2 text-xs text-dark-2">
                  {#if !triggerText}
                    No trigger word set.
                  {:else if captionTriggerHit(trigger, editing.caption)}
                    Trigger <span class="text-buzz">{triggerText}</span> is highlighted where it appears.
                  {:else}
                    Trigger <span class="text-buzz">{triggerText}</span> is prepended automatically.
                  {/if}
                </p>
              </div>
            </div>
          {/if}
        {/key}
      </div>
      {#if repeatsEnabled}
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-dark-4 pt-3">
          <span class="font-mono text-xs uppercase tracking-wider text-dark-2">Repeats</span>
          <RepeatsStepper
            label="Repeats for {editing.name}"
            bind:value={() => repeatsOf(editing!), (v) => (editing!.repeats = v > 1 ? v : undefined)}
          />
          <span class="text-xs text-dark-2">
            Train this image more often than the rest. Total steps stay the same.
          </span>
        </div>
      {/if}
    {/if}
</civitai-modal>
