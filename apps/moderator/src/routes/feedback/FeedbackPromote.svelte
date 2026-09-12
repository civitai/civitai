<script lang="ts">
  import { enhance } from '$app/forms';
  import { page } from '$app/state';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS, shortAge } from '$lib/format';
  import { issuesUrl } from '$lib/entity-url';
  import { urlWith } from '$lib/url';
  import type { FeedbackRow, FeedbackSibling } from '$lib/server/feedback.service';

  let {
    row,
    siblings,
    civitaiUrl,
    canPromote,
  }: {
    row: FeedbackRow;
    siblings: FeedbackSibling[];
    civitaiUrl: string;
    canPromote: boolean;
  } = $props();

  const promoteForm = new FormState({ onSuccess: null, reload: true });

  let attachMode = $state(false);
</script>

<section class="flex flex-col gap-3">
  <h3 class="text-xs tracking-wide text-dark-2 uppercase">Known issue</h3>

  {#if row.bugId}
    <p class="text-sm">
      Linked to issue
      <a href={issuesUrl(civitaiUrl)} target="_blank" rel="noreferrer" class={LINK_CLASS}>
        #{row.bugId}
      </a>
      — {row.bugTitle ?? 'untitled'}
      <span class="text-dark-2">({row.bugStatus ?? 'unknown status'})</span>
    </p>
    {#if siblings.length}
      <div class="flex flex-col gap-1">
        <p class="text-sm text-dark-2">
          {siblings.length} other report{siblings.length === 1 ? '' : 's'} linked to this issue
        </p>
        <ul class="flex flex-col gap-1 text-sm">
          {#each siblings as sibling (sibling.id)}
            <li>
              <a href={urlWith(page.url, { open: sibling.id })} class={LINK_CLASS}>
                {shortAge(sibling.createdAt)} · {sibling.area}
              </a>
              <span class="text-dark-2"> — {sibling.message.split('\n')[0]}</span>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  {:else if canPromote}
    <form method="POST" action="?/promote" use:enhance={promoteForm.enhance} class="flex flex-col gap-3">
      <input type="hidden" name="id" value={row.id} />
      <!-- 🔴 The mode is POSTED, never inferred server-side from whether the number box is blank:
           inferring it sends an empty box down the create-an-issue branch, which then refuses with
           a message naming fields this form is not showing. -->
      <input type="hidden" name="mode" value={attachMode ? 'attach' : 'create'} />

      {#if attachMode}
        <div class="flex flex-col gap-1">
          <Label for={`bug-${row.id}`} class="text-xs text-dark-2">Existing issue number</Label>
          <Input id={`bug-${row.id}`} name="bugId" inputmode="numeric" class="w-40" />
        </div>
      {:else}
        <div class="flex flex-col gap-1">
          <Label for={`title-${row.id}`} class="text-xs text-dark-2">
            Issue title — a summary, not the complaint
          </Label>
          <Input id={`title-${row.id}`} name="title" />
        </div>
        <div class="flex flex-col gap-1">
          <Label for={`summary-${row.id}`} class="text-xs text-dark-2">
            Summary — what the issue board shows
          </Label>
          <Textarea id={`summary-${row.id}`} name="summary" rows={2} />
        </div>
      {/if}

      <div class="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={promoteForm.submitting}>
          {attachMode ? 'Attach to issue' : 'Create issue'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onclick={() => {
            attachMode = !attachMode;
            promoteForm.error = null;
          }}
        >
          {attachMode ? 'Create a new issue instead' : 'Attach to an existing issue instead'}
        </Button>
      </div>
      <p class="text-xs text-dark-2">
        The issue lands unpublished, so nothing reaches the public board until someone publishes it
        there. The ClickUp task is still made by hand.
      </p>
    </form>
  {:else}
    <p class="text-sm text-dark-2">
      Not linked to an issue. Promoting needs the “Promote feedback to a Known Issue” permission.
    </p>
  {/if}

  <!-- 🔴 OUTSIDE the branch chain above, not inside the form's arm. A 409 "already linked" means the
       row gained a `bugId`, and the reload that precedes the message being assigned flips this
       section to the linked view — so an alert nested in the form's arm is unmounted before it can
       render, and the operator sees the panel silently swap with their typed title gone. -->
  {#if promoteForm.error}
    <ErrorAlert message={promoteForm.error} />
  {/if}
</section>
