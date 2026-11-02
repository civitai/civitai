<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { chatAuditChatUrl, userLookupUrl } from '$lib/entity-url';

  // One chat message's byline — Chat Audit's panels, the chat report queue's transcript and the CSAM holds conversation.
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
    judged = false,
    sender = false,
    sentBy = null,
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
    /** The CSAM holds conversation: the scan judged this message. */
    judged?: boolean;
    /** The CSAM holds conversation: this is the member whose messages were held. */
    sender?: boolean;
    /** Civitai Moderation messages: the moderator who wrote it. */
    sentBy?: string | null;
  } = $props();
</script>

<div class="flex flex-wrap items-baseline gap-x-2">
  <a href={userLookupUrl(userId)} class={LINK_CLASS}>{username ?? `#${userId}`}</a>
  {#if sentBy}<span class="text-xs text-dark-2">sent by {sentBy}</span>{/if}
  {#if sender}<Badge variant="secondary">sender</Badge>{/if}
  {#if judged}<Badge variant="destructive">judged</Badge>{/if}
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
