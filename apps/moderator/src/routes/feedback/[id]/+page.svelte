<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import { feedbackAreaLabel, feedbackStatusBadgeClass, splitContext } from '$lib/feedback';
  import FeedbackDetail from '../FeedbackDetail.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  /**
   * 🔴 THE NO-JS REFUSAL, handed to the panel so it stays ONE banner. Without JS a refused
   * `?/triage` or `?/promote` re-renders this page with `form` populated and the panel's own
   * `FormState`s untouched, and nothing else here would say the save was refused. See
   * `FeedbackDetail`'s `formError` prop for why it is a fallback rather than its own `ErrorAlert`.
   */
  const formError = $derived(form && 'error' in form && form.error ? String(form.error) : null);

  const context = $derived(splitContext(data.row.context));
</script>

<header class="page-header">
  <h1>Report #{data.row.id}</h1>
  <p class="text-dark-2">
    <Badge variant="outline">{feedbackAreaLabel(data.row.area)}</Badge>
    · {dateTime(data.row.createdAt)}
    ·
    {#if data.row.username}
      <a href={userLookupUrl(data.row.username)} class={LINK_CLASS}>{data.row.username}</a>
    {:else}
      #{data.row.userId}
    {/if}
  </p>
</header>

<!-- ⚠️ A BARE `/feedback`, SO RETURNING DROPS THE VIEW: the status filter, the sort and the keyset
     page all ride the query string, and this link carries none of them. The cost is real and falls
     on every in-app route in: both of them — `FeedbackPromote`'s sibling links and the queue's own
     "not in this view" link — originate from a filtered queue. Accepted rather than solved, because
     the fix is threading the originating URL through a param, and that param is wrong for the entry
     points this route mainly exists for: a ticket, a message, a link pasted anywhere outside this
     app, none of which have a queue view to carry. -->
<p class="mb-4"><a class={LINK_CLASS} href="/feedback">← Feedback queue</a></p>

<!-- The status the queue shows in its own column. Repeated here because this page has no row above
     it, and the footer marks the current status only by how its button LOOKS — disabled, and the
     one `default` variant among outlines. Both are states to infer rather than a value to read, and
     the disabled half is ambiguous mid-submit, when every button is disabled. -->
<p class="mb-4">
  <Badge class={feedbackStatusBadgeClass(data.row.status)}>{data.row.status}</Badge>
</p>

<!--
  🔴 THE SAME COMPONENT THE QUEUE EXPANDS, not a second rendering of the same report. Two copies of
  this panel is two places to add a section to, and the one that gets forgotten is whichever the
  author was not looking at — the forms, the refusal banner and the concurrency guard all live in
  there and all have to behave identically on both routes.

  It is wrapped rather than styled here: on the queue it sits inside a table cell that supplies the
  panel's background, and this page has no such cell.
-->
<div class="min-w-0 rounded-xl border border-dark-4 bg-dark-6">
  <!-- 🔴 `{#key}` BECAUSE THIS ROUTE REUSES ITS COMPONENT ACROSS A PARAM CHANGE. SvelteKit keeps the
       same `FeedbackDetail` instance when `/feedback/12` becomes `/feedback/34` — Back/Forward, a
       URL edit, or a sibling link, which `FeedbackPromote` now points here — and everything the
       panel declares would come with it: a refusal raised on report A reading as a refusal of B, and
       a half-written issue title submitting against B's id. The queue does not have this, because
       its `{#if open}` sits inside a keyed `{#each}` and rebuilds the panel on every open. -->
  {#key data.row.id}
    <FeedbackDetail
      row={data.row}
      {context}
      siblings={data.siblings}
      knownIssues={data.knownIssues}
      grafanaUrl={data.grafanaUrl}
      civitaiUrl={data.civitaiUrl}
      canTriage={!!data.grants['feedback.status.set']}
      canPromote={!!data.grants['feedback.bug.promote']}
      {formError}
    />
  {/key}
</div>
