<script lang="ts">
  import { enhance } from '$app/forms';
  import { page } from '$app/state';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import type { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS, shortAge } from '$lib/format';
  import { issuesUrl } from '$lib/entity-url';
  import { clearPaging } from '$lib/paging';
  import { feedbackOpenHref } from '$lib/feedback-tabs';
  import type { FeedbackPromoteDraft } from '$lib/feedback-drafts';
  import type { FeedbackRow, FeedbackSibling } from '$lib/server/feedback.service';

  let {
    row,
    siblings,
    civitaiUrl,
    canPromote,
    form: promoteForm,
    draft,
  }: {
    row: FeedbackRow;
    siblings: FeedbackSibling[];
    civitaiUrl: string;
    canPromote: boolean;
    /**
     * 🔴 CONSTRUCTED BY `FeedbackDetail`, NOT HERE, and it must stay that way. This section now sits
     * behind a tab, so a refusal rendered inside it can land on a panel the operator is not looking
     * at. The panel renders one banner above the tab strip for both forms, and it can only do that
     * if it can see this state. It is still `reset: false` — this form carries hidden `id` and `mode`
     * inputs, and Svelte writes their `value` rather than `defaultValue`, so a reset would leave a
     * form posting neither.
     */
    form: FormState;
    /**
     * 🔴 ALSO CONSTRUCTED BY `FeedbackDetail`, FOR THE SAME REASON AS `form` — and it must stay
     * there. A tab click is a NAVIGATION, and this whole section sits inside the panel's
     * `{:else if activeTab === 'issue'}` branch, so the branch is DESTROYED and rebuilt whenever the
     * operator looks at another tab. State declared in this file dies with it: a half-written issue
     * title was gone the moment anyone flipped to Context and back, with no warning and nothing to
     * undo. `FeedbackDetail` survives that navigation (the row's `{#if open}` never goes false), so
     * the draft lives there and is handed down.
     *
     * It is MUTATED IN PLACE, never reassigned: it is a `$state` proxy, so writing `draft.title`
     * here is what the parent sees. Replacing the object with a fresh one would write a prop the
     * parent does not read back, which is the same defect wearing a different shape.
     */
    draft: FeedbackPromoteDraft;
  } = $props();

  /**
   * A sibling can sit on an earlier keyset page, where carrying this page's `?cursor=` lands the
   * operator on "not in this view" for a row that plainly exists.
   *
   * 🔴 IT GOES THROUGH `feedbackOpenHref`, which deletes `?tab=`. These links only exist ON the
   * Issue tab, so writing `open` by hand here is the sticky-tab bug at its sharpest: every sibling
   * link would open the next report onto ITS Issue tab — the one panel that shows the issue this
   * report is already attached to and none of what the reporter wrote. The operator clicked a
   * sibling to read what THAT person said.
   */
  function siblingHref(id: number) {
    const next = new URL(page.url);
    clearPaging(next.searchParams);
    return feedbackOpenHref(next, id);
  }
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
              <a href={siblingHref(sibling.id)} class={LINK_CLASS}>
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
      <input type="hidden" name="mode" value={draft.attachMode ? 'attach' : 'create'} />

      <!-- 🔴 EVERY BOX IS `bind:value`-d TO THE PARENT-OWNED DRAFT, not left uncontrolled. An
           uncontrolled input keeps what was typed in the DOM node, and the DOM node dies with this
           branch on the next tab click. -->
      {#if draft.attachMode}
        <div class="flex flex-col gap-1">
          <Label for={`bug-${row.id}`} class="text-xs text-dark-2">Existing issue number</Label>
          <Input
            id={`bug-${row.id}`}
            name="bugId"
            inputmode="numeric"
            class="w-40"
            bind:value={draft.bugId}
          />
        </div>
      {:else}
        <div class="flex flex-col gap-1">
          <Label for={`title-${row.id}`} class="text-xs text-dark-2">
            Issue title — a summary, not the complaint
          </Label>
          <Input id={`title-${row.id}`} name="title" bind:value={draft.title} />
        </div>
        <div class="flex flex-col gap-1">
          <Label for={`summary-${row.id}`} class="text-xs text-dark-2">
            Summary — what the issue board shows
          </Label>
          <Textarea id={`summary-${row.id}`} name="summary" rows={2} bind:value={draft.summary} />
        </div>
      {/if}

      <div class="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={promoteForm.submitting}>
          {draft.attachMode ? 'Attach to issue' : 'Create issue'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onclick={() => {
            draft.attachMode = !draft.attachMode;
            promoteForm.error = null;
          }}
        >
          {draft.attachMode ? 'Create a new issue instead' : 'Attach to an existing issue instead'}
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

  <!-- 🔴 THE REFUSAL FOR THIS FORM IS RENDERED BY `FeedbackDetail`, ABOVE THE TAB STRIP. Do not add
       a second `ErrorAlert` here: this section only mounts when the Issue tab is selected, so an
       in-section banner is invisible for exactly the refusal that matters — one raised while the
       operator has moved to another tab. `+page.svelte`'s `pageError` still covers the no-JS path
       and only that; the two remain disjoint. -->
</section>
