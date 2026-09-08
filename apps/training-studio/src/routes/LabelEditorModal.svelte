<script lang="ts">
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { IconSparkles, IconX } from '@tabler/icons-svelte';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import * as Dialog from '@civitai/ui/components/ui/dialog/index.js';
  import type { LabelType } from '$lib/data/trainingModels';
  import { captionTriggerHit, isTriggerTag, tagsHaveTrigger, type Img } from './trainingFlow';

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
  }: {
    open: boolean;
    editing: Img | undefined;
    labelMode: LabelType;
    trigger: string;
    tagVocab: string[];
    onRelabel: (id: number) => void;
  } = $props();

  let newTag = $state('');
  const triggerText = $derived(trigger.trim());

  // Clear the input each time the editor opens, so a half-typed tag doesn't carry into the next image.
  $effect(() => {
    if (open) newTag = '';
  });

  // Accept one tag or a paste of comma/newline-separated tags; trim, drop blanks, dedupe against what's
  // already there and within the paste.
  function addTag() {
    if (!editing) return;
    const existing = editing.tags;
    const additions = [
      ...new Set(
        newTag
          .split(/[,\n]/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0 && !existing.includes(s))
      ),
    ];
    if (additions.length) editing.tags = [...existing, ...additions];
    newTag = '';
  }
  function removeTag(tag: string) {
    if (editing) editing.tags = editing.tags.filter((t) => t !== tag);
  }
  function clearTags() {
    if (editing) editing.tags = [];
  }
  // Backspace on an empty input removes the last chip — standard chip-input flow.
  function tagKeydown(e: KeyboardEvent) {
    if (e.key === 'Backspace' && newTag === '' && editing && editing.tags.length > 0) {
      e.preventDefault();
      editing.tags = editing.tags.slice(0, -1);
    }
  }

  // Suggest tags from this dataset's own vocabulary (already frequency-ranked), filtered by what's typed
  // and not already on this image.
  const suggestions = $derived.by(() => {
    if (!editing) return [];
    const q = newTag.trim().toLowerCase();
    const have = editing.tags;
    return tagVocab.filter((t) => !have.includes(t) && (q === '' || t.toLowerCase().includes(q))).slice(0, 8);
  });

  // Focus the primary field (tag input / caption textarea) on open — this is a correction surface, the
  // user came here to type. Dialog would otherwise land focus on the first chip's remove ✕.
  function autofocusInput(node: HTMLElement) {
    queueMicrotask(() => node.querySelector<HTMLElement>('input, textarea')?.focus());
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-2xl">
    {#if editing}
      <Dialog.Header>
        <Dialog.Title>{labelMode === 'tag' ? 'Edit tags' : 'Edit caption'}</Dialog.Title>
        <Dialog.Description>{editing.name}</Dialog.Description>
      </Dialog.Header>

      {#if labelMode === 'tag'}
        <div class="grid gap-4 sm:grid-cols-[200px_1fr]" use:autofocusInput>
          <img
            src={editing.previewUrl}
            alt=""
            class="max-h-48 w-full rounded border border-dark-4 object-cover sm:max-h-none"
          />
          <div>
            <div class="mb-2 flex items-center justify-between gap-2">
              <span class="font-mono text-xs uppercase tracking-wider text-dark-2">Tags</span>
              <div class="flex items-center gap-1">
                <Button variant="ghost" size="xs" onclick={() => onRelabel(editing.id)} disabled={editing.labeling}>
                  <IconSparkles size={12} stroke={2} class="mr-1 inline" />{editing.labeling
                    ? 'labeling…'
                    : 'Re-run'}
                </Button>
                {#if editing.tags.length > 0}
                  <Button variant="ghost" size="xs" onclick={clearTags}>Clear all</Button>
                {/if}
              </div>
            </div>

            {#if triggerText && !tagsHaveTrigger(trigger, editing.tags)}
              <div class="mb-2 flex items-center gap-2 text-[11px] text-dark-2">
                <span class="rounded border border-buzz/30 bg-buzz/10 px-2 py-0.5 font-mono text-buzz">
                  {triggerText}
                </span>
                <span class="font-mono">auto-prepended to every tag</span>
              </div>
            {/if}

            <div class="flex min-h-[64px] flex-wrap content-start gap-1.5 rounded border border-dark-4 bg-dark-7 p-2.5">
              {#if editing.tags.length === 0}
                <span class="self-center font-mono text-[11px] text-dark-2">
                  No tags yet — type below, paste comma-separated, or re-run auto-label.
                </span>
              {/if}
              {#each editing.tags as t (t)}
                <span
                  class="inline-flex items-center gap-0.5 rounded border py-1 pl-2 pr-1 font-mono text-xs {isTriggerTag(
                    trigger,
                    t
                  )
                    ? 'border-buzz/30 bg-buzz/10 text-buzz'
                    : 'border-dark-4 bg-dark-6 text-dark-0'}"
                >
                  {t}
                  <button
                    type="button"
                    aria-label={`Remove ${t}`}
                    onclick={() => removeTag(t)}
                    class="grid h-5 w-5 place-items-center rounded text-dark-1 hover:bg-red-500/20 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    <IconX size={12} stroke={2} />
                  </button>
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
              <Input
                bind:value={newTag}
                onkeydown={tagKeydown}
                placeholder="Add or paste tags…"
                class="min-w-0 flex-1 font-mono"
              />
              <Button type="submit" variant="outline">Add</Button>
            </form>

            {#if suggestions.length > 0}
              <div class="mt-2">
                <div class="mb-1 font-mono text-[10px] uppercase tracking-wider text-dark-2">From this dataset</div>
                <div class="flex flex-wrap gap-1">
                  {#each suggestions as s (s)}
                    <button
                      type="button"
                      onclick={() => {
                        newTag = s;
                        addTag();
                      }}
                      class="rounded border border-dark-4 bg-dark-6 px-2 py-0.5 font-mono text-[11px] text-dark-1 hover:border-primary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    >
                      + {s}
                    </button>
                  {/each}
                </div>
              </div>
            {/if}
          </div>
        </div>
      {:else}
        <div class="flex flex-col gap-3" use:autofocusInput>
          <img src={editing.previewUrl} alt="" class="max-h-72 w-full rounded border border-dark-4 object-contain" />
          <div>
            <div class="mb-2 flex items-center justify-between gap-2">
              <span class="font-mono text-xs uppercase tracking-wider text-dark-2">Caption</span>
              <Button variant="ghost" size="xs" onclick={() => onRelabel(editing.id)} disabled={editing.labeling}>
                <IconSparkles size={12} stroke={2} class="mr-1 inline" />{editing.labeling
                  ? 'labeling…'
                  : 'Re-run'}
              </Button>
            </div>
            <Textarea bind:value={editing.caption} rows={6} placeholder="Describe the image…" />
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
    {/if}
  </Dialog.Content>
</Dialog.Root>
