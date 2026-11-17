<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import type { ChatMemberRow } from '$lib/server/chat-audit.service';

  let {
    member,
    reported = false,
    reporter = false,
  }: { member: ChatMemberRow; reported?: boolean; reporter?: boolean } = $props();
</script>

{#if member.isOwner}<Badge variant="secondary">owner</Badge>{/if}
{#if reported}<Badge variant="destructive">reported</Badge>{/if}
{#if reporter}<Badge variant="secondary">reporter</Badge>{/if}
{#if member.bannedAt}<Badge variant="destructive">banned</Badge>{/if}
{#if member.kickedAt}<Badge variant="destructive">kicked</Badge>{/if}
{#if member.leftAt}<Badge variant="secondary">left</Badge>{/if}
<span class="text-xs text-dark-2">{member.status}</span>
