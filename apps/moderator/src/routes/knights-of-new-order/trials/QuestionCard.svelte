<script lang="ts">
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { imageLookupUrl } from '$lib/entity-url';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS } from '$lib/format';
  import { YESNO_PROMPT_MAX } from '$lib/knights/trials-limits';
  import type { YesNoQuestionItem } from '$lib/server/knights/yesno-question.service';

  let { item }: { item: YesNoQuestionItem } = $props();

  const NOTE_MAX = 500;
  const isOpen = $derived(item.status === 'Open');
  const retired = $derived(item.status === 'Closed' && item.reason === 'moderator-retired');

  type Mode = 'retire' | 'reword' | null;
  let mode = $state<Mode>(null);
  let note = $state('');
  let ask = $state<string | null>(null);

  const done = (message: string) => () => {
    mode = null;
    note = '';
    ask = null;
    toast.success(message);
  };
  const retire = new FormState({ reload: true, reset: false, onSuccess: done('Question retired') });
  const reword = new FormState({ reload: true, reset: false, onSuccess: done('Question reworded') });
  const restore = new FormState({ reload: true, onSuccess: () => toast.success('Question restored') });
</script>

<article
  class="flex flex-col gap-4 rounded-xl border border-dark-4 bg-dark-6 p-5 md:flex-row {isOpen
    ? ''
    : 'opacity-70'}"
  data-testid="question-card"
>
  <a href={imageLookupUrl(item.imageId)} class="shrink-0 self-start">
    <EdgeMedia
      src={item.imageKey}
      name={item.imageName}
      width={240}
      alt="Image {item.imageId}"
      class="max-h-64 rounded-md"
    />
  </a>

  <div class="flex min-w-0 flex-1 flex-col gap-2">
    <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <a href={imageLookupUrl(item.imageId)} class="font-medium {LINK_CLASS}">Image #{item.imageId}</a>
      <Badge variant={isOpen ? 'default' : 'secondary'}>{item.status}</Badge>
      {#if item.reason}<Badge variant="outline">{item.reason}</Badge>{/if}
      <span class="text-sm text-dark-2">{item.voteCount} answered</span>
    </div>
    <p class="text-sm text-dark-0">{item.prompt}</p>
    <p class="text-xs text-dark-2">
      {item.questionKey}{item.externalId ? ` · ${item.externalId}` : ''}
      {#if item.rewordOf}· reworded from {item.rewordOf}{/if}
    </p>
    {#if item.moderation}
      <p class="text-xs text-dark-2">
        Moderator #{item.moderation.by} {item.moderation.action}: {item.moderation.note || 'no note'}
      </p>
    {/if}

    {#if restore.error}<ErrorAlert message={restore.error} />{/if}

    {#if mode === 'retire'}
      {#if retire.error}<ErrorAlert message={retire.error} />{/if}
      <form
        method="POST"
        action="?/retireQuestion"
        use:enhance={retire.enhance}
        class="flex flex-col gap-2"
      >
        <input type="hidden" name="id" value={item.id} />
        <Input
          name="note"
          required
          maxlength={NOTE_MAX}
          placeholder="Why retire it? e.g. watermark is illegible"
          bind:value={note}
        />
        <p class="text-xs text-dark-2">
          Players stop seeing it. Answers already given are marked inconclusive and cost the player only
          their pending gold.
        </p>
        <div class="flex gap-2">
          <Button
            type="submit"
            size="sm"
            variant="destructive"
            disabled={retire.submitting || !note.trim()}>Retire</Button
          >
          <Button type="button" size="sm" variant="ghost" onclick={() => (mode = null)}>Cancel</Button>
        </div>
      </form>
    {:else if mode === 'reword'}
      {#if reword.error}<ErrorAlert message={reword.error} />{/if}
      <form
        method="POST"
        action="?/rewordQuestion"
        use:enhance={reword.enhance}
        class="flex flex-col gap-2"
      >
        <input type="hidden" name="id" value={item.id} />
        <Input
          name="prompt"
          required
          maxlength={YESNO_PROMPT_MAX}
          value={ask ?? item.prompt}
          oninput={(e) => (ask = e.currentTarget.value)}
        />
        <Input
          name="note"
          required
          maxlength={NOTE_MAX}
          placeholder="Why reword it?"
          bind:value={note}
        />
        <p class="text-xs text-dark-2">
          {item.voteCount === 0
            ? 'Nobody has answered it, so the words change in place.'
            : 'Players have answered it, so this question is retired and a new one with the new words opens for the same image.'}
        </p>
        <div class="flex gap-2">
          <Button type="submit" size="sm" disabled={reword.submitting || !note.trim()}>Reword</Button>
          <Button type="button" size="sm" variant="ghost" onclick={() => (mode = null)}>Cancel</Button>
        </div>
      </form>
    {:else}
      <div class="flex flex-wrap gap-2">
        {#if isOpen}
          <Button size="sm" variant="outline" onclick={() => (mode = 'reword')}>Reword</Button>
          <Button size="sm" variant="outline" onclick={() => (mode = 'retire')}>Retire</Button>
        {:else if retired}
          <form method="POST" action="?/unretireQuestion" use:enhance={restore.enhance}>
            <input type="hidden" name="id" value={item.id} />
            <Button
              type="submit"
              size="sm"
              variant="outline"
              disabled={restore.submitting || item.voteCount > 0}
              title={item.voteCount > 0 ? 'Players answered it, so it stays retired' : undefined}
              >Restore</Button
            >
          </form>
        {/if}
      </div>
    {/if}
  </div>
</article>
