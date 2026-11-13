<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import TranscriptPanel from '$lib/components/chat-audit/TranscriptPanel.svelte';
  import { LINK_CLASS } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import type { EntityEvidence } from '$lib/server/entity-queue-load';

  // A reported chat: who is in it, who filed the report and who it is about, and — for a moderator
  // who can read Chat Audit — what was said. A chat report carries no message id, so the whole
  // transcript is the evidence, with the reported member's messages marked.
  let {
    evidence,
    chatId,
    subjectIds,
    reporterIds,
  }: {
    evidence: Extract<EntityEvidence, { kind: 'chat' }>;
    chatId: number;
    /** `chatSubject`, worked out by the page over the reports it lists. */
    subjectIds: number[];
    reporterIds: number[];
  } = $props();

  const reported = $derived(new Set(subjectIds));
  const reporters = $derived(new Set(reporterIds));
</script>

{#if evidence.transcript}
  <TranscriptPanel
    {chatId}
    transcript={evidence.transcript}
    members={evidence.members}
    reportedIds={subjectIds}
    {reporterIds}
  />
{:else}
  <!-- Members only: the transcript is private messages, read through Chat Audit's own grant. Naming
       the missing page is what tells a moderator this is a permission, not an empty chat. -->
  <p class="mb-3 text-sm text-muted-foreground">
    The messages need access to Chat Audit (<code>/retool/chat-audit</code>), granted on
    <a href="/admin" class={LINK_CLASS}><code>/admin</code></a>. Who is in the chat is below.
  </p>
  <h3 class="mb-2 text-sm font-semibold">Members ({evidence.members.length})</h3>
  <ul class="m-0 flex list-none flex-col gap-1.5 p-0 text-sm">
    {#each evidence.members as m (m.userId)}
      <li class="flex flex-wrap items-baseline gap-x-2">
        <a href={userLookupUrl(m.userId)} class={LINK_CLASS}>{m.username ?? `#${m.userId}`}</a>
        {#if reported.has(m.userId)}<Badge variant="destructive">reported</Badge>{/if}
        {#if reporters.has(m.userId)}<Badge variant="secondary">reporter</Badge>{/if}
        {#if m.isOwner}<Badge variant="secondary">owner</Badge>{/if}
        {#if m.bannedAt}<Badge variant="destructive">banned</Badge>{/if}
        {#if m.kickedAt}<Badge variant="destructive">kicked</Badge>{/if}
        {#if m.leftAt}<Badge variant="secondary">left</Badge>{/if}
        <span class="text-xs text-muted-foreground">{m.status}</span>
      </li>
    {/each}
  </ul>
{/if}
