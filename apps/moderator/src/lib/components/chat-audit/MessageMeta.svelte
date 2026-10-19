<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { chatAuditChatUrl, userLookupUrl } from '$lib/entity-url';

  // One chat message's byline — Chat Audit's panels and the chat report queue's transcript.
  //
  // `username` is null for ~8.5k deleted accounts — the id fallback keeps those from rendering as an
  // empty link.
  let {
    userId,
    username,
    bannedAt,
    createdAt,
    chatId = null,
    editedAt = null,
    deletedAt = null,
    chatHref = chatAuditChatUrl,
    reported = false,
  }: {
    userId: number;
    username: string | null;
    // Date from `load`, string from `/api/chat-insights` — both consumers share this row shape.
    bannedAt: Date | string | null;
    createdAt: Date | string;
    chatId?: number | null;
    editedAt?: Date | string | null;
    deletedAt?: Date | string | null;
    /** Where the chat link goes. Chat Audit passes its own, which keeps the search it is under. */
    chatHref?: (chatId: number) => string;
    /** The report queue's: this sender is the member the chat's reports are about. */
    reported?: boolean;
  } = $props();
</script>

<div class="flex flex-wrap items-baseline gap-x-2">
  <a href={userLookupUrl(userId)} class={LINK_CLASS}>{username ?? `#${userId}`}</a>
  {#if reported}<Badge variant="destructive">reported</Badge>{/if}
  {#if bannedAt}<Badge variant="destructive">banned</Badge>{/if}
  {#if chatId}<a href={chatHref(chatId)} class="text-xs {LINK_CLASS}">chat {chatId}</a>{/if}
  <span class="text-xs text-dark-2">{dateTime(createdAt)}</span>
  <!-- Neither is visible to the participants: an edited message is not what was reported. -->
  {#if editedAt}
    <Badge variant="secondary" title="Edited {dateTime(editedAt)}">edited</Badge>
  {/if}
  {#if deletedAt}
    <Badge variant="destructive" title="Deleted {dateTime(deletedAt)}">deleted</Badge>
  {/if}
</div>
