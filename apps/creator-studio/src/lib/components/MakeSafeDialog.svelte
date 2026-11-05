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

  // The main app's draft limit: one draft per model, at most this many an hour.
  const MAX_PER_RUN = 20;

  type Draft = {
    sfwName: string;
    sfwDescription: string;
    sfwCoverImageId: number;
    coverUrl: string;
  };
  type Card =
    | { state: 'skipped'; reason: string; dispute?: boolean }
    | { state: 'waiting' | 'drafting' | 'saving' | 'saved' }
    | { state: 'ready'; draft: Draft; accepted: boolean }
    | { state: 'failed'; reason: string; draft?: Draft };

  let open = $state(false);
  // A snapshot: the page's data reloads after a save, and the run must keep reviewing what it started.
  let models = $state<CreatorModel[]>([]);
  let cards = $state<Record<number, Card>>({});
  let running = $state(false);

  function initialCard(model: CreatorModel): Card {
    if (model.lockedMature)
      return {
        state: 'skipped',
        reason: 'A moderator locked this model as mature, so it cannot be made safe.',
        dispute: true,
      };
    if (model.hasComFace) return { state: 'skipped', reason: 'Already has a civitai.com version.' };
    if (!model.nsfw) return { state: 'skipped', reason: 'Already shown on civitai.com.' };
    return { state: 'waiting' };
  }

  async function post(body: Record<string, unknown>) {
    const res = await fetch('/models/make-safe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok)
      throw Object.assign(new Error(data.error ?? `Request failed (${res.status})`), {
        status: res.status,
      });
    return data;
  }

  async function draftAll() {
    running = true;
    let budget = MAX_PER_RUN;
    for (const model of models) {
      if (!open) break;
      if (cards[model.id]?.state !== 'waiting') continue;
      if (budget-- <= 0) {
        cards[model.id] = {
          state: 'skipped',
          reason: `Only ${MAX_PER_RUN} models can be drafted an hour. Run it again later.`,
        };
        continue;
      }
      cards[model.id] = { state: 'drafting' };
      try {
        const draft = (await post({ action: 'draft', modelId: model.id })) as Draft;
        cards[model.id] = { state: 'ready', draft, accepted: false };
      } catch (e) {
        const err = e as Error & { status?: number };
        cards[model.id] = { state: 'failed', reason: err.message };
        // The hourly limit is spent: drafting the rest would only fail the same way.
        if (err.status === 429) budget = 0;
      }
    }
    running = false;
  }

  export function start(selection: CreatorModel[]) {
    if (running) return;
    models = selection;
    cards = Object.fromEntries(selection.map((model) => [model.id, initialCard(model)]));
    open = true;
    draftAll();
  }

  const accepted = $derived(
    models.filter((model) => {
      const card = cards[model.id];
      return card?.state === 'ready' && card.accepted;
    })
  );

  async function saveAccepted() {
    running = true;
    let saved = 0;
    for (const model of accepted) {
      const card = cards[model.id];
      if (card.state !== 'ready') continue;
      const { draft } = card;
      cards[model.id] = { state: 'saving' };
      try {
        await post({
          action: 'save',
          modelId: model.id,
          sfwName: draft.sfwName,
          sfwDescription: draft.sfwDescription || null,
          sfwCoverImageId: draft.sfwCoverImageId,
        });
        cards[model.id] = { state: 'saved' };
        saved++;
      } catch (e) {
        cards[model.id] = { state: 'failed', reason: (e as Error).message, draft };
      }
    }
    running = false;
    if (saved) await invalidateAll();
  }

  const stripTags = (html: string) =>
    html
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-h-[85vh] max-w-2xl overflow-y-auto" interactOutsideBehavior="ignore">
    <Dialog.Header>
      <Dialog.Title>Make safe for civitai.com</Dialog.Title>
      <Dialog.Description>
        Each model gets a civitai.com title, description and cover, drafted from its listing. Its
        civitai.red listing doesn't change. Review each one and tick the ones to keep.
      </Dialog.Description>
    </Dialog.Header>

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
            {#if card?.state === 'drafting' || card?.state === 'saving'}
              <Spinner class="size-4 text-dark-2" />
              <span class="text-xs text-dark-2"
                >{card.state === 'drafting' ? 'Drafting…' : 'Saving…'}</span
              >
            {:else if card?.state === 'waiting'}
              <span class="text-xs text-dark-2">Waiting</span>
            {:else if card?.state === 'saved'}
              <span class="text-xs text-green-5">Saved</span>
            {/if}
          </div>

          {#if card?.state === 'skipped'}
            <p class="mt-1 text-sm text-dark-2">
              {card.reason}
              {#if card.dispute}
                <a
                  href={modelUrl(model.id, model)}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="underline">Dispute it on the model page</a
                >
              {/if}
            </p>
          {:else if card?.state === 'failed'}
            <p class="mt-1 text-sm text-red-4">{card.reason}</p>
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
                disabled={running}
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
      <Button variant="outline" onclick={() => (open = false)}>Close</Button>
      <Button disabled={running || accepted.length === 0} onclick={saveAccepted}>
        Done{accepted.length ? ` (save ${accepted.length})` : ''}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
