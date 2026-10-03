<script lang="ts">
  import { applyAction, enhance } from '$app/forms';
  import { goto, invalidateAll } from '$app/navigation';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import EdgeImage from '$lib/components/EdgeImage.svelte';
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
    const id = data.item?.itemId ?? null;
    if (shownFor === id) return;
    shownFor = id;
    shownAt = Date.now();
    picks = data.existing ? { ...data.existing } : {};
  });

  const complete = $derived(QUESTIONS.every((q) => picks[q.id]));

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
    const next = [...data.skipped.filter((id) => id !== data.item?.itemId), data.item.itemId];
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
    <a href={queueHref({ skip: null })} class="text-blue-4 hover:text-blue-3">
      {data.skipped.length} skipped &middot; bring them back
    </a>
  {/if}
</div>

{#if data.pinned}
  <div class="mb-4 flex items-center gap-3 rounded-lg bg-dark-7 px-3 py-2 text-xs text-dark-1">
    Changing your earlier answer.
    <a href={queueHref({ item: null })} class="ml-auto text-blue-4 hover:text-blue-3">
      Back to the queue &rarr;
    </a>
  </div>
{/if}

{#if form?.error}
  <p class="mb-4 rounded-lg bg-red-8/20 px-3 py-2 text-sm text-red-3">{form.error}</p>
{/if}

{#if !data.item}
  <section class="rounded-xl border border-dark-4 bg-dark-6 p-8 text-center text-sm text-dark-2">
    Nothing left for you to label.
  </section>
{:else}
  <section class="grid gap-4 lg:grid-cols-[1fr_24rem]">
    <div class="flex items-start justify-center rounded-xl border border-dark-4 bg-dark-6 p-3">
      <EdgeImage
        src={data.item.imageKey}
        width={1200}
        class="max-h-[80vh] w-auto rounded object-contain"
        alt=""
      />
    </div>

    <form
      method="POST"
      action="?/answer"
      class="flex flex-col gap-4"
      use:enhance={({ formData }) => {
        formData.set('durationMs', String(Date.now() - shownAt));
        submitting = true;
        const wasPinned = data.pinned;
        return async ({ result }) => {
          await applyAction(result);
          if (result.type === 'success') {
            if (wasPinned) await goto(queueHref({ item: null }), { invalidateAll: true });
            else await invalidateAll();
          } else if (result.type === 'failure') {
            await invalidateAll();
          }
          submitting = false;
        };
      }}
    >
      <input type="hidden" name="itemId" value={data.item.itemId} />

      {#each QUESTIONS as q (q.id)}
        <fieldset class="rounded-xl border border-dark-4 bg-dark-6 p-4">
          <legend class="px-1 text-sm font-medium text-dark-0">{q.prompt}</legend>
          <div class="mt-2 flex flex-col gap-1.5">
            {#each q.options as opt (opt.value)}
              <label class="flex cursor-pointer items-center gap-2 text-sm text-dark-1">
                <input
                  type="radio"
                  name={q.id}
                  value={opt.value}
                  checked={picks[q.id] === opt.value}
                  onchange={() => (picks[q.id] = opt.value)}
                />
                {opt.label}
              </label>
            {/each}
          </div>
        </fieldset>
      {/each}

      <div class="flex gap-2">
        <Button type="submit" class="flex-1" disabled={!complete || submitting}>
          {data.pinned ? 'Save change' : 'Save and next'}
        </Button>
        {#if !data.pinned}
          <Button type="button" variant="secondary" disabled={submitting} onclick={skip}>
            Skip
          </Button>
        {/if}
      </div>
      {#if !data.pinned && data.lastItemId}
        <a href={queueHref({ item: data.lastItemId })} class="text-xs text-blue-4 hover:text-blue-3">
          Change my last answer
        </a>
      {/if}
    </form>
  </section>
{/if}
