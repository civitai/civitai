<script lang="ts">
  import { dateTime } from '$lib/format';
  import type { MessageEdit } from '$lib/server/chat-audit.service';

  let { edits, partial }: { edits: MessageEdit[] | undefined; partial: boolean } = $props();
</script>

{#if edits?.length}
  <!-- Every superseded version, each labelled with the edit that REPLACED it — so a timestamp always
       belongs to the text beside it. The final version is the message body, so it is not repeated. -->
  <details class="mt-1 text-xs">
    <summary class="cursor-pointer text-dark-2">
      {edits.length === 1
        ? `Before this edit (${dateTime(edits[0].at)})`
        : `${edits.length} edits — every earlier version`}
    </summary>
    <ol class="mt-1 space-y-1">
      {#each edits as e, i (i)}
        <li>
          <span class="text-dark-2">
            {i === 0 ? 'As written' : `Version ${i + 1}`} — replaced {dateTime(e.at)}{e.actorRole ===
            'moderator'
              ? ' by a moderator'
              : ''}
          </span>
          <p class="wrap-break-word whitespace-pre-wrap text-amber-200/80">
            {e.oldValue}{e.truncated ? '…' : ''}
          </p>
        </li>
      {/each}
    </ol>
    {#if partial}
      <p class="mt-1 text-amber-300">
        Part of the edit history could not be read, so earlier versions may be missing.
      </p>
    {/if}
  </details>
{:else if partial}
  <p class="mt-1 text-xs text-amber-300">
    Edited — the edit history could not be read, so the original is unknown here, not absent.
  </p>
{:else}
  <p class="mt-1 text-xs text-dark-2">
    Edited — the original was not recorded, so what it said before is unrecoverable.
  </p>
{/if}
