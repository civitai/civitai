<script lang="ts">
  import { enhance } from '$app/forms';
  import { page } from '$app/state';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import {
    Combobox,
    type ComboboxOption,
  } from '@civitai/ui/components/ui/combobox/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import type { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS, shortAge } from '$lib/format';
  import { issuesUrl } from '$lib/entity-url';
  import { clearPaging } from '$lib/paging';
  import { feedbackOpenHref } from '$lib/feedback-tabs';
  import type { FeedbackPromoteDraft } from '$lib/feedback-drafts';
  import type {
    FeedbackRow,
    FeedbackSibling,
    KnownIssueOption,
  } from '$lib/server/feedback.service';

  let {
    row,
    siblings,
    knownIssues,
    civitaiUrl,
    canPromote,
    form: promoteForm,
    draft = $bindable(),
  }: {
    row: FeedbackRow;
    siblings: FeedbackSibling[];
    /** Non-disabled issues, newest first — `getKnownIssues`. Empty when the picker cannot be shown
     *  (no grant, or the row is already linked), in which case only the number box renders. */
    knownIssues: KnownIssueOption[];
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
     * undo. `FeedbackDetail` survives that navigation — `feedbackTabHref` preserves `?open=`, so the
     * row's `{#if open}` in `+page.svelte` stays true across a tab click — and the draft lives there
     * and is handed down. (It is NOT true that the `{#if}` can never go false; see the precondition
     * paragraph in `FeedbackDetail.svelte` for the case that destroys the panel outright.)
     *
     * 🔴 `$bindable`, AND THE PARENT MUST PASS IT WITH `bind:draft=`. This section MUTATES the
     * draft — four `bind:value={draft.…}` boxes plus the mode toggle — and Svelte's dev-only
     * ownership validator treats a mutation of a prop the parent did not BIND as a defect:
     * `create_ownership_validator`'s `is_bound_or_unset`
     * (`svelte@5.56.3/src/internal/client/dev/ownership.js:71-80`) looks for a SETTER on the props
     * descriptor, a plain prop has only a getter, so every keystroke into title/summary/bugId/clickupUrl
     * raised `ownership_invalid_mutation`. Measured in a compiled two-component repro of exactly
     * this shape: two keystrokes → 2 warnings as a plain prop, 0 with `$bindable` + `bind:draft`.
     * Production was never affected (`DEV` is false there) — the cost was a dev console nobody
     * could read, and the fix is the shape Svelte documents rather than the one it discourages.
     *
     * ⚠️ Binding is what LICENSES the mutation, not what performs it: the draft is still a `$state`
     * proxy mutated IN PLACE, and writing `draft.title` is still what the parent sees. What the
     * binding changes is the failure mode of the OTHER shape — reassigning `draft` wholesale now
     * propagates to the parent.
     *
     * ⚠️ THAT SENTENCE USED TO SAY THE UNBOUND REASSIGNMENT WAS "SILENTLY DROPPED", AND IT IS NOT.
     * Under a plain prop the child's write lands in a child-local OVERRIDE, which Svelte discards
     * only when the parent yields a DIFFERENT value — so parent and child diverge and stay diverged
     * until something upstream happens to move. That is the same mechanism `Lightbox.svelte` records
     * about bits-ui's `open`, and "dropped" is the wrong word for it in both places: a dropped write
     * is inert, a stale override is a second source of truth.
     *
     * Mutate in place anyway; a wholesale replacement would swap the object the parent's own `bind:`
     * and any future consumer are holding, for no gain.
     */
    draft: FeedbackPromoteDraft;
  } = $props();

  /**
   * 🔴 `keywords` CARRIES THE TITLE, AND WITHOUT IT THIS PICKER IS SEARCHABLE BY DIGITS ONLY.
   * Command filters on an item's `value` — which has to be the id, since that is what gets posted —
   * so typing a word from the issue's title would match nothing. The status rides along in the
   * keywords too: a moderator looking for the open one can type "open".
   */
  const issueOptions = $derived(
    knownIssues.map(
      (issue): ComboboxOption => ({
        value: String(issue.id),
        // `closed` is the SERVICE's verdict, not a re-reading of the status string here.
        label: `#${issue.id} — ${issue.title} (${issue.status}${issue.closed ? ', closed' : ''})`,
        keywords: [issue.title, issue.status, issue.closed ? 'closed' : 'open'],
      })
    )
  );

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
          <Label for={`bug-${row.id}`} class="text-xs text-dark-2">Existing issue</Label>
          <!--
            🔴 THE PICKER AND THE NUMBER BOX WRITE ONE VALUE — `draft.bugId` — AND ONLY THE BOX IS
            POSTED. The combobox is a `<button>`, so it submits nothing on its own; giving it a
            `name` would post a SECOND `bugId` and `Object.fromEntries` keeps the last, which is
            whichever the DOM happens to order later. One named input, and the picker writes into it.

            🔴 THE NUMBER BOX IS NOT A FALLBACK FOR STYLE. `getKnownIssues` is bounded and excludes
            disabled issues, so an issue that is old enough, or retired, is reachable by number and
            by nothing else. Removing the box would make those unattachable.
          -->
          {#if issueOptions.length}
            <!-- A function binding, not `value=`: `Combobox` declares `value` as `$bindable` and
                 writes to it on select, so a plain prop would latch a child-local override the
                 number box below could then disagree with. -->
            <Combobox
              options={issueOptions}
              bind:value={() => draft.bugId, (v: string) => (draft.bugId = v)}
              placeholder="Search issues…"
              searchPlaceholder="Title or number…"
              emptyText="No issue matches."
              class="w-full max-w-md"
              contentClass="w-[28rem]"
            />
          {/if}
          <Input
            id={`bug-${row.id}`}
            name="bugId"
            inputmode="numeric"
            class="w-40"
            bind:value={draft.bugId}
          />
          <!-- 🔴 BOTH BRANCHES SAY SOMETHING. An empty list here means "no non-disabled issues
               exist" — `load` populates `knownIssues` on exactly the condition that renders this
               form — and without the second branch the picker and its help line simply vanish,
               leaving a bare number box that reads as a control that failed to load. `emptyText`
               covers a search that matches nothing, which is a different state. -->
          <p class="text-xs text-dark-2">
            {#if issueOptions.length}
              Pick one, or type the number — the box is what gets submitted.
            {:else}
              <!-- 🔴 NOT "no OPEN issues". `getKnownIssues` deliberately does not filter to open
                   ones — its docstring carries the measurement and is the one place it lives. An
                   empty list here means no non-disabled issues exist AT ALL, and the open-only
                   wording is what someone would cite when re-adding the filter. -->
              No issues to pick from yet — type the number of an existing one.
            {/if}
          </p>
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
        <div class="flex flex-col gap-1">
          <Label for={`clickup-${row.id}`} class="text-xs text-dark-2">
            ClickUp task URL — optional
          </Label>
          <Input id={`clickup-${row.id}`} name="clickupUrl" bind:value={draft.clickupUrl} />
          <!-- 🔴 WHAT THIS BOX BUYS, stated because an empty optional box otherwise reads as
               decoration. The ClickUp webhook closes a board entry by looking up the entry whose
               `clickupUrl` holds the id of the task that completed. An entry created here with the
               box left blank has no link to match, so it never auto-closes and someone has to
               notice by hand — which is the state every issue promoted from a report has been in
               until now.

               🔴 THE COPY NAMES THE SYNCED LIST, AND MUST KEEP NAMING IT. The webhook subscription
               is scoped to ONE ClickUp list, so a well-formed task URL from any other list stores
               fine and still never auto-closes. An unconditional "paste it and it closes itself"
               is FALSE for every task outside that list, and no server-side guard can catch it —
               checking list membership needs a ClickUp API token this app does not have. For THIS
               non-closure — the wrong-list one — the sentence is the only protection there is;
               other shapes are caught by the input gate, so do not read it as a claim about all
               of them.

               🔴 "NEXT completed" IS LOAD-BEARING, AND THE PRECISE CLAIM IS NARROWER THAN "ALREADY
               COMPLETE NEVER CLOSES" — an earlier draft of this comment said that, and it is wrong
               in the direction that costs the operator the link. The subscription is
               `taskStatusUpdated` and nothing backfills, so the completion that ALREADY HAPPENED
               cannot close anything. But `clickupDoneStatusFromPayload` has no "was already done"
               guard: any later status move whose new status is done-typed — Complete → Closed, or a
               reopen and re-complete — fires and DOES close the entry. So the honest statement is
               "not retroactively", never "never".

               That distinction matters because of the sentence below: told "it will not auto-close",
               a moderator leaves the box blank, and 21 of 24 of them can never add the link
               afterwards. Over-claiming here spends the one chance they get.

               Of the non-closures listed here, the custom-id URL (`DEV-1234`) is the one the input
               gate catches, because deliveries carry ClickUp's internal id. It is NOT the only
               thing that gate refuses — it also refuses sub-tab and view-embedded URLs, whose last
               path segment is not the task id; see `isClickupTaskUrl`. Scoped deliberately: an
               earlier draft called it "the one non-closure the gate actually catches", which reads
               as an absolute and would have a maintainer believing those URLs reach storage.
               Source for the custom-id limit is the integration's own shipping record — ClickUp
               task `868ktfupv`, not anything in this repo; its documented backstop is
               `check-known-issues-sync.mjs` in the support-agent repo.

               🔴 AND THE FALLBACK IS NOT UNIVERSAL — MEASURED, DO NOT SOFTEN IT BACK. Editing the
               link on the issue board afterwards needs `bugsEdit`, which is a per-user grant and
               NOT conferred by `isModerator`: 3 of 24 moderators hold it. For the other 21 this
               box is the only chance to link the task, ever, which is why the sentence says "may
               not be able to" rather than offering the board as a general second chance. -->
          <p class="text-xs text-dark-2">
            If the task is on the synced team list, pasting its URL lets the issue close itself the
            <em>next</em> time the task moves to a done status — a completion that already happened
            will not close it retroactively, and a task on another list will not close it at all.
            Paste it anyway if in doubt: leaving it blank means the issue never auto-closes, and
            unless you have issue-board edit access you may not be able to add the link later.
          </p>
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
      <!-- 🔴 THIS PARAGRAPH RENDERS IN BOTH MODES, so it must read correctly with no ClickUp box on
           screen — the box is on the create branch only. Hence "nothing here creates one" rather
           than a sentence pointing at a field that is not always there. -->
      <p class="text-xs text-dark-2">
        The issue lands unpublished, so nothing reaches the public board until someone publishes it
        there. The ClickUp task is still made by hand — nothing here creates one.
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
