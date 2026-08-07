<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import { chatUrl } from '../url';

  // `username` is null for ~8.5k deleted accounts — the id fallback keeps those from rendering as an
  // empty link.
  let {
    userId,
    username,
    bannedAt,
    createdAt,
    chatId = null,
  }: {
    userId: number;
    username: string | null;
    // Date from `load`, string from `/api/chat-insights` — both consumers share this row shape.
    bannedAt: Date | string | null;
    createdAt: Date | string;
    chatId?: number | null;
  } = $props();
</script>

<div class="flex flex-wrap items-baseline gap-x-2">
  <a href={userLookupUrl(userId)} class={LINK_CLASS}>{username ?? `#${userId}`}</a>
  {#if bannedAt}<Badge variant="destructive">banned</Badge>{/if}
  {#if chatId}<a href={chatUrl(chatId)} class="text-xs {LINK_CLASS}">chat {chatId}</a>{/if}
  <span class="text-xs text-dark-2">{dateTime(createdAt)}</span>
</div>
