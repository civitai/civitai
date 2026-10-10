<script lang="ts">
  import { applyAction, enhance } from '$app/forms';
  import { goto, invalidateAll } from '$app/navigation';
  import { Alert, AlertDescription, AlertTitle } from '@civitai/ui/components/ui/alert/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { RadioGroup, RadioGroupItem } from '@civitai/ui/components/ui/radio-group/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { dateTime, LINK_CLASS } from '$lib/format';
  import { HAND_OFF_TAGS, MAX_NOTE_LENGTH, TEXT_LABELS } from '$lib/automated-text/labels';
  import type { ResolvedHandOff } from '$lib/automated-text/hand-off';
  import HandOffCase from './HandOffCase.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  let label = $state('');
  let note = $state('');
  let shownAt = $state(Date.now());
  let submitting = $state(false);
  // Held here, not read from `form`: a save from a pinned item navigates, and navigation clears `form`.
  let handedOff = $state<ResolvedHandOff | null>(null);

  // Reset per item, guarded on the token so an unrelated reload does not wipe a half-made answer.
  let shownFor = $state<string | null>(null);
  $effect(() => {
    const id = data.item?.token ?? null;
    if (shownFor === id) return;
    shownFor = id;
    shownAt = Date.now();
    label = data.existing?.label ?? '';
    note = data.existing?.note ?? '';
  });

  // A refusal for an item the queue has since moved past is about the previous text.
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
    return s ? `/audit/text-relabel?${s}` : '/audit/text-relabel';
  }

  function skip() {
    if (submitting || !data.item) return;
    const next = [...data.skipped.filter((t) => t !== data.item?.token), data.item.token];
    void goto(queueHref({ skip: next.join(',') }));
  }
</script>

<header class="page-header">
  <h1>Automated text relabel</h1>
  <p>
    Judge the text against the one tag shown. Clavata's confidence and any other label are hidden on
    purpose.
  </p>
</header>

<div class="mb-4 flex flex-wrap items-center gap-3 text-xs text-dark-2">
  <span>{data.progress.mine} answered by you</span>
  <span>&middot; {data.progress.waveOneDone} of {data.progress.waveOne} in the first set labelled</span>
  {#if data.skipped.length}
    <a href={queueHref({ skip: null })} class={linkClass} {...linkLock}>
      {data.skipped.length} skipped &middot; bring them back
    </a>
  {/if}
</div>

{#if handedOff}
  <Alert variant="destructive" class="mb-4">
    <AlertTitle>Needs action</AlertTitle>
    <AlertDescription>
      <p>You marked that {handedOff.tag} text a clear violation. It needs action, not only a label.</p>
      <HandOffCase handOff={handedOff} locked={submitting} />
    </AlertDescription>
  </Alert>
{/if}

{#if data.pinned}
  <div class="mb-4 flex items-center gap-3 rounded-lg bg-dark-7 px-3 py-2 text-xs text-dark-2">
    Changing your earlier answer.
    <a href={queueHref({ item: null })} class="ml-auto {linkClass}" {...linkLock}>
      Back to the queue &rarr;
    </a>
  </div>
{:else if data.pinnedGone}
  <div class="mb-4 rounded-lg bg-dark-7 px-3 py-2 text-xs text-dark-2">
    That text has been purged, so its answer cannot be changed. Here is the next one.
  </div>
{/if}

{#if form?.error}
  <Alert variant="destructive" class="mb-4">
    <AlertDescription>
      {errorIsForThisItem ? form.error : `Previous text: ${form.error}`}
    </AlertDescription>
  </Alert>
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
    <div class="flex flex-col gap-2 rounded-xl border border-dark-4 bg-dark-6 p-5">
      <div class="flex flex-wrap gap-3 text-xs text-dark-2">
        <span>Tag: <span class="font-medium text-dark-0">{data.item.tag}</span></span>
        {#if data.item.entityLabel}<span>&middot; From: {data.item.entityLabel}</span>{/if}
      </div>
      <p class="whitespace-pre-wrap break-words text-sm text-dark-0">{data.item.text}</p>
    </div>

    <form
      method="POST"
      action="?/answer"
      class="flex flex-col gap-4"
      use:enhance={({ formData }) => {
        formData.set('durationMs', String(Date.now() - shownAt));
        submitting = true;
        handedOff = null;
        const leaveItem = data.pinned || data.pinnedGone;
        return async ({ result }) => {
          await applyAction(result);
          if (result.type === 'success') {
            handedOff = (result.data as Extract<ActionData, { handOff: unknown }>)?.handOff ?? null;
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

      <fieldset class="rounded-xl border border-dark-4 bg-dark-6 p-5">
        <legend class="px-1 text-sm font-medium text-dark-0">
          Read in its context, this text, for "{data.item.tag}", is:
        </legend>
        <RadioGroup name="label" class="mt-2 gap-2" bind:value={label}>
          {#each TEXT_LABELS as opt (opt.value)}
            <div class="flex items-start gap-2">
              <RadioGroupItem value={opt.value} id="label-{opt.value}" class="mt-0.5" />
              <Label for="label-{opt.value}" class="flex flex-col font-normal text-dark-2">
                <span class="text-dark-0">{opt.label}</span>
                <span class="text-xs">{opt.hint}</span>
              </Label>
            </div>
          {/each}
        </RadioGroup>
      </fieldset>

      <div class="flex flex-col gap-1">
        <Label for="note" class="text-xs text-dark-2">Note (optional)</Label>
        <Textarea id="note" name="note" rows={3} maxlength={MAX_NOTE_LENGTH} bind:value={note} />
      </div>

      <div class="flex gap-2">
        <Button type="submit" class="flex-1" disabled={!label || submitting}>
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

<section class="mt-8 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="mb-2 text-sm font-medium text-white">Your clear violations that need action</h2>
  {#if data.handOffs.length}
    <ul class="flex flex-col gap-2 text-xs text-dark-2">
      {#each data.handOffs as h (h.token)}
        <li class="rounded-lg bg-dark-7 px-3 py-2">
          <div class="mb-1 flex flex-wrap gap-3">
            <span class="font-medium text-dark-0">{h.tag}</span>
            <span>{dateTime(h.answeredAt)}</span>
          </div>
          <HandOffCase handOff={h} locked={submitting} />
        </li>
      {/each}
    </ul>
  {:else}
    <p class="text-xs text-dark-2">
      None yet. A clear violation on a {[...HAND_OFF_TAGS].join(' or ')} text is listed here with its
      report.
    </p>
  {/if}
</section>
