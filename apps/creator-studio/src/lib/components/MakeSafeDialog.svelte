<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import * as Dialog from '@civitai/ui/components/ui/dialog/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { Spinner } from '@civitai/ui/components/ui/spinner/index.js';
  import EdgeImage from '$lib/components/EdgeImage.svelte';
  import { modelUrl } from '$lib/model-url';
  import type { CreatorModel } from '$lib/server/models';

  type Draft = {
    sfwName: string;
    sfwDescription: string;
    sfwCoverImageId: number;
    coverUrl: string;
  };
  type Card =
    | { state: 'skipped'; reason: string }
    | { state: 'waiting' | 'drafting' | 'saving' }
    | { state: 'ready'; draft: Draft; accepted: boolean }
    | { state: 'saved'; listedOnCom: boolean }
    | { state: 'failed'; reason: string; draft?: Draft };

  let open = $state(false);
  // A snapshot: the page reloads after a save, and the run keeps reviewing what it started with.
  let models = $state.raw<CreatorModel[]>([]);
  let offPage = $state(0);
  let cards = $state<Record<number, Card>>({});
  let drafting = $state(false);
  let saving = $state(false);
  let controller: AbortController | null = null;

  function initialCard(model: CreatorModel): Card {
    if (!model.nsfw)
      return {
        state: 'skipped',
        reason:
          'Not marked mature: where it is listed follows its images, not a civitai.com version.',
      };
    if (model.listing.com) return { state: 'skipped', reason: 'Already listed on civitai.com.' };
    if (model.hasComFace)
      return {
        state: 'skipped',
        reason: 'Already has a civitai.com version. Edit it in the model editor.',
      };
    return { state: 'waiting' };
  }

  async function post(body: Record<string, unknown>, signal: AbortSignal | null = null) {
    const res = await fetch('/models/make-safe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok)
      throw Object.assign(new Error(data.error ?? `Request failed (${res.status})`), {
        status: res.status,
      });
    return data;
  }

  async function draftOne(model: CreatorModel, signal: AbortSignal) {
    cards[model.id] = { state: 'drafting' };
    try {
      const draft = (await post({ action: 'draft', modelId: model.id }, signal)) as Draft;
      cards[model.id] = { state: 'ready', draft, accepted: false };
      return true;
    } catch (e) {
      if (signal.aborted) {
        cards[model.id] = { state: 'waiting' };
        return false;
      }
      const err = e as Error & { status?: number };
      // Every 409 from com-face is a skip, not a failure.
      if (err.status === 409) {
        cards[model.id] = { state: 'skipped', reason: err.message };
        return true;
      }
      cards[model.id] = { state: 'failed', reason: err.message };
      // The hourly draft limit is spent: the rest would only fail the same way.
      if (err.status === 429) {
        for (const other of models)
          if (cards[other.id]?.state === 'waiting')
            cards[other.id] = { state: 'failed', reason: err.message };
        return false;
      }
      return true;
    }
  }

  async function draftWaiting() {
    controller = new AbortController();
    const { signal } = controller;
    drafting = true;
    // Re-scanned each turn, so a card retried mid-run is picked up too.
    let next: CreatorModel | undefined;
    while (
      !signal.aborted &&
      (next = models.find((model) => cards[model.id]?.state === 'waiting'))
    ) {
      if (!(await draftOne(next, signal))) break;
    }
    drafting = false;
  }

  /** Opens the review for these models; `skipped` counts selected models it could not include. */
  export function start(selection: CreatorModel[], skipped = 0) {
    controller?.abort();
    models = selection;
    offPage = skipped;
    cards = Object.fromEntries(selection.map((model) => [model.id, initialCard(model)]));
    open = true;
    draftWaiting();
  }

  function retry(model: CreatorModel) {
    const card = cards[model.id];
    if (card.state !== 'failed') return;
    if (card.draft) cards[model.id] = { state: 'ready', draft: card.draft, accepted: true };
    else {
      cards[model.id] = { state: 'waiting' };
      if (!drafting) draftWaiting();
    }
  }

  function setOpen(next: boolean) {
    // Saves are not cancelled mid-way: closing would hide which ones landed.
    if (!next && saving) return;
    if (!next) controller?.abort();
    open = next;
  }

  const accepted = $derived(
    models.filter((model) => {
      const card = cards[model.id];
      return card?.state === 'ready' && card.accepted;
    })
  );

  async function saveAccepted() {
    saving = true;
    let saved = 0;
    for (const model of accepted) {
      const card = cards[model.id];
      if (card.state !== 'ready') continue;
      const { draft } = card;
      cards[model.id] = { state: 'saving' };
      try {
        const result = (await post({
          action: 'save',
          modelId: model.id,
          sfwName: draft.sfwName,
          sfwDescription: draft.sfwDescription || null,
          sfwCoverImageId: draft.sfwCoverImageId,
        })) as { listedOnCom: boolean };
        cards[model.id] = { state: 'saved', listedOnCom: result.listedOnCom };
        saved++;
      } catch (e) {
        cards[model.id] = { state: 'failed', reason: (e as Error).message, draft };
      }
    }
    saving = false;
    if (saved) await invalidateAll();
  }

  const stripTags = (html: string) =>
    html
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
</script>

<Dialog.Root bind:open={() => open, setOpen}>
  <Dialog.Content class="max-h-[85vh] max-w-2xl overflow-y-auto" interactOutsideBehavior="ignore">
    <Dialog.Header>
      <Dialog.Title>Customize for civitai.com</Dialog.Title>
      <Dialog.Description>
        Each model gets a civitai.com title, description and cover, drafted from its listing. Its
        civitai.red listing doesn't change. Tick the ones to keep, then save them.
      </Dialog.Description>
    </Dialog.Header>

    {#if offPage > 0}
      <p class="text-sm text-dark-2">
        {offPage} selected {offPage === 1 ? 'version is' : 'versions are'} on other pages and not included.
        Open those pages to include them.
      </p>
    {/if}

    {#if models.length === 0}
      <p class="text-sm text-dark-2">None of the selected models are on this page.</p>
    {/if}

    <ul class="flex flex-col gap-3">
      {#each models as model (model.id)}
        {@const card = cards[model.id]}
        <li class="rounded-lg border border-dark-4 bg-dark-6 p-3">
          <div class="flex items-center gap-2">
            <a
              href={modelUrl(model.id, model)}
              target="_blank"
              rel="noopener noreferrer"
              class="min-w-0 flex-1 truncate font-medium text-white hover:underline">{model.name}</a
            >
            <span class="flex items-center gap-1.5 text-xs text-dark-2" aria-live="polite">
              {#if card?.state === 'drafting' || card?.state === 'saving'}
                <Spinner class="size-4" />
                {card.state === 'drafting' ? 'Drafting…' : 'Saving…'}
              {:else if card?.state === 'waiting'}
                Waiting
              {:else if card?.state === 'saved'}
                <span class="text-green-5">Saved</span>
              {/if}
            </span>
          </div>

          {#if card?.state === 'skipped'}
            <p class="mt-1 text-sm text-dark-2">{card.reason}</p>
          {:else if card?.state === 'saved' && !card.listedOnCom}
            <p class="mt-1 text-sm text-dark-2">
              Saved, but not on civitai.com yet: its cover doesn't count until that image is
              published and reviewed. Pick another cover in the model editor if it stays off.
            </p>
          {:else if card?.state === 'failed'}
            <div class="mt-1 flex items-center gap-2">
              <p class="flex-1 text-sm text-red-4">{card.reason}</p>
              <Button variant="outline" size="sm" disabled={saving} onclick={() => retry(model)}>
                Try again
              </Button>
            </div>
          {:else if card?.state === 'ready'}
            {@const id = `accept-${model.id}`}
            <div class="mt-2 flex gap-3">
              <div class="size-20 shrink-0 overflow-hidden rounded-md bg-dark-7">
                <EdgeImage
                  src={card.draft.coverUrl}
                  width={160}
                  alt=""
                  class="size-full object-cover"
                />
              </div>
              <div class="min-w-0 flex-1">
                <p class="text-sm font-medium text-white">{card.draft.sfwName}</p>
                <p class="line-clamp-3 text-xs text-dark-2">
                  {stripTags(card.draft.sfwDescription)}
                </p>
              </div>
            </div>
            <div class="mt-2 flex items-center gap-2">
              <Checkbox
                {id}
                disabled={saving}
                bind:checked={
                  () => card.accepted, (v) => (cards[model.id] = { ...card, accepted: !!v })
                }
              />
              <Label for={id} class="cursor-pointer font-normal">Use this on civitai.com</Label>
            </div>
          {/if}
        </li>
      {/each}
    </ul>

    <Dialog.Footer>
      <Button variant="outline" disabled={saving} onclick={() => setOpen(false)}>Close</Button>
      <Button disabled={saving || accepted.length === 0} onclick={saveAccepted}>
        {accepted.length ? `Save ${accepted.length}` : 'Save'}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
