<script lang="ts">
  import { applyAction, enhance } from '$app/forms';
  import { goto, invalidateAll } from '$app/navigation';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { RadioGroup, RadioGroupItem } from '@civitai/ui/components/ui/radio-group/index.js';
  import EdgeImage from '$lib/components/EdgeImage.svelte';
  import { LINK_CLASS } from '$lib/format';
  import { QUESTIONS, type QuestionId } from '$lib/removal-label/questions';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  type Picks = Partial<Record<QuestionId, string>>;

  let picks = $state<Picks>({});
  let shownAt = $state(Date.now());
  let submitting = $state(false);

  // Reset per item, guarded on the id so an unrelated reload does not wipe half-made picks.
  let shownFor = $state<string | null>(null);
  $effect(() => {
    const id = data.item?.token ?? null;
    if (shownFor === id) return;
    shownFor = id;
    shownAt = Date.now();
    picks = data.existing ? { ...data.existing } : {};
  });

  const complete = $derived(QUESTIONS.every((q) => picks[q.id]));
  // A refusal for an item the queue has since moved past is about the previous image, and must
  // not read as being about the one on screen.
  const errorIsForThisItem = $derived(!form?.token || form.token === data.item?.token);
  const linkClass = $derived(`${LINK_CLASS} ${submitting ? 'pointer-events-none opacity-50' : ''}`);
  const linkLock = $derived(submitting ? { 'aria-disabled': true, tabindex: -1 } : {});

  function queueHref(params: Record<string, string | null>): string {
    const q = new URLSearchParams();
    if (data.skipped.length) q.set('skip', data.skipped.join(','));
    for (const [k, v] of Object.entries(params)) {
      if (v === null) q.delete(k);
      else q.set(k, v);
    }
    const s = q.toString();
    return s ? `/audit/relabel?${s}` : '/audit/relabel';
  }

  function skip() {
    if (submitting || !data.item) return;
    const next = [...data.skipped.filter((t) => t !== data.item?.token), data.item.token];
    void goto(`/audit/relabel?skip=${next.join(',')}`);
  }
</script>

<header class="page-header">
  <h1>Removal label relabel</h1>
  <p>
    Answer the four questions from the image alone. Other labels on this image are hidden on
    purpose.
  </p>
</header>

<div class="mb-4 flex flex-wrap items-center gap-3 text-xs text-dark-2">
  <span>{data.progress.mine} answered by you</span>
  <span>&middot; {data.progress.complete} of {data.progress.items} images have both labels</span>
  {#if data.skipped.length}
    <a href={queueHref({ skip: null })} class={linkClass} {...linkLock}>
      {data.skipped.length} skipped &middot; bring them back
    </a>
  {/if}
</div>

{#if data.pinned}
  <div class="mb-4 flex items-center gap-3 rounded-lg bg-dark-7 px-3 py-2 text-xs text-dark-1">
    Changing your earlier answer.
    <a href={queueHref({ item: null })} class="ml-auto {linkClass}" {...linkLock}>
      Back to the queue &rarr;
    </a>
  </div>
{:else if data.pinnedGone}
  <div class="mb-4 rounded-lg bg-dark-7 px-3 py-2 text-xs text-dark-1">
    That image can no longer be shown, so its answer cannot be changed. Here is the next one.
  </div>
{/if}

{#if form?.error}
  <p class="mb-4 rounded-lg bg-red-8/20 px-3 py-2 text-sm text-red-3">
    {errorIsForThisItem ? form.error : `Previous image: ${form.error}`}
  </p>
{/if}

{#if !data.item}
  <section class="rounded-xl border border-dark-4 bg-dark-6 p-8 text-center text-sm text-dark-2">
    {#if data.skipped.length}
      Nothing left except the {data.skipped.length} you skipped.
      <a href={queueHref({ skip: null })} class={linkClass} {...linkLock}>Bring them back</a>
    {:else}
      Nothing left for you to label.
    {/if}
  </section>
{:else}
  <section class="grid gap-4 lg:grid-cols-[1fr_24rem]">
    <div class="flex items-start justify-center rounded-xl border border-dark-4 bg-dark-6 p-3">
      <EdgeImage
        src={data.item.imageKey}
        width={1200}
        class="max-h-[80vh] w-auto rounded object-contain"
        alt="Image to label"
      />
    </div>

    <form
      method="POST"
      action="?/answer"
      class="flex flex-col gap-4"
      use:enhance={({ formData }) => {
        formData.set('durationMs', String(Date.now() - shownAt));
        submitting = true;
        // Leaving `?item=` in the URL would re-show its note above every later image.
        const leaveItem = data.pinned || data.pinnedGone;
        return async ({ result }) => {
          await applyAction(result);
          if (result.type === 'success') {
            if (leaveItem) await goto(queueHref({ item: null }), { invalidateAll: true });
            else await invalidateAll();
          } else if (result.type === 'failure') {
            await invalidateAll();
          }
          submitting = false;
        };
      }}
    >
      <input type="hidden" name="token" value={data.item.token} />

      {#each QUESTIONS as q (q.id)}
        <fieldset class="rounded-xl border border-dark-4 bg-dark-6 p-4">
          <legend class="px-1 text-sm font-medium text-dark-0">{q.prompt}</legend>
          <RadioGroup
            name={q.id}
            class="mt-2 gap-1.5"
            bind:value={() => picks[q.id] ?? '', (v) => (picks[q.id] = v)}
          >
            {#each q.options as opt (opt.value)}
              <div class="flex items-center gap-2">
                <RadioGroupItem value={opt.value} id="{q.id}-{opt.value}" />
                <Label for="{q.id}-{opt.value}" class="font-normal text-dark-1">{opt.label}</Label>
              </div>
            {/each}
          </RadioGroup>
        </fieldset>
      {/each}

      <div class="flex gap-2">
        <Button type="submit" class="flex-1" disabled={!complete || submitting}>
          {#if submitting}Saving...{:else}{data.pinned ? 'Save change' : 'Save and next'}{/if}
        </Button>
        {#if !data.pinned}
          <Button type="button" variant="secondary" disabled={submitting} onclick={skip}>
            Skip
          </Button>
        {/if}
      </div>
      {#if !data.pinned && data.lastToken}
        <a href={queueHref({ item: data.lastToken })} class="text-xs {linkClass}" {...linkLock}>
          Change my last answer
        </a>
      {/if}
    </form>
  </section>
{/if}
