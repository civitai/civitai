<script lang="ts">
  import type { ModeratorDbStatus } from '$lib/moderator-db-status';

  /** Why `/decisions` cannot read or record rulings here. Renders nothing when it can. */
  let { status }: { status: ModeratorDbStatus } = $props();
</script>

{#if status === 'no-schema'}
  <p class="text-dark-2 mb-4">
    Rulings cannot be read or recorded yet — the <code>decision_resolution</code> table does not
    exist. It is applied by hand: run <code>apps/moderator/decisions/schema.sql</code> against
    <code>MODERATOR_DATABASE_URL</code> as the application role. Everything else still reads.
  </p>
{:else if status === 'no-grant'}
  <p class="text-dark-2 mb-4">
    <code>decision_resolution</code> exists but this app's database role cannot read it — it was most
    likely created by another role. Transfer its ownership to the application role (see the header of
    <code>apps/moderator/decisions/schema.sql</code>). Everything else still reads.
  </p>
{:else if status === 'not-configured'}
  <p class="text-dark-2 mb-4">
    <code>MODERATOR_DATABASE_URL</code> is not configured for this environment, so rulings cannot be
    read or recorded. Everything else still reads.
  </p>
{:else if status === 'unreachable'}
  <p class="text-dark-2 mb-4">
    Could not read rulings — the moderator database did not answer. The server log has the error.
  </p>
{/if}
