<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import { feedbackStatusBadgeClass, splitContext } from '$lib/feedback';
  import FeedbackDetail from '../FeedbackDetail.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const context = $derived(splitContext(data.row.context));
</script>

<header class="page-header">
  <h1>Report #{data.row.id}</h1>
  <p class="text-dark-2">
    <Badge variant="outline">{data.row.area}</Badge>
    · {dateTime(data.row.createdAt)}
    ·
    {#if data.row.username}
      <a href={userLookupUrl(data.row.username)} class={LINK_CLASS}>{data.row.username}</a>
    {:else}
      #{data.row.userId}
    {/if}
  </p>
</header>

<p class="mb-4"><a class={LINK_CLASS} href="/feedback">← Feedback queue</a></p>

<!-- The status the queue shows in its own column. Repeated here because this page has no row above
     it, and the footer's buttons render "Save (<status>)" rather than announcing the current one. -->
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
  <FeedbackDetail
    row={data.row}
    {context}
    siblings={data.siblings}
    knownIssues={data.knownIssues}
    grafanaUrl={data.grafanaUrl}
    civitaiUrl={data.civitaiUrl}
    canTriage={!!data.grants['feedback.status.set']}
    canPromote={!!data.grants['feedback.bug.promote']}
  />
</div>
