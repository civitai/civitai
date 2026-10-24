<script lang="ts">
  import { LINK_CLASS } from '$lib/format';
  import { permissionById, type PermissionId } from '$lib/permissions';
  import type { ReportActionGrants } from '$lib/report-queue';

  /**
   * What a report queue is withholding and why: ruling on a report needs only the queue, but acting on
   * its images or its owner is an action grant. Said once, above the item, naming each missing grant
   * in `/admin`'s own words — a moderator who sees missing buttons and no reason files a bug. Renders
   * nothing when nothing is withheld.
   */
  let {
    can,
    images = true,
    owner = true,
  }: {
    can: ReportActionGrants;
    /** False where the item has no images, so the image grant is not named for nothing. */
    images?: boolean;
    /** False where the item has no owner panel, so the strike grant is not named for nothing. */
    owner?: boolean;
  } = $props();

  const missing = $derived(
    [
      images && !can.images && 'image.moderate',
      owner && !can.strike && 'user.strike',
    ].filter((id): id is PermissionId => !!id)
  );
</script>

{#if missing.length}
  <p class="m-0 text-xs text-muted-foreground">
    Some actions are hidden: they need the action {missing.length === 1 ? 'grant' : 'grants'}
    {#each missing as id, i (id)}{i > 0 ? ' and ' : ''}“{permissionById(id).label}”
      (<code>{id}</code>){/each}, given on
    <a href="/admin" class={LINK_CLASS}><code>/admin</code></a>.
  </p>
{/if}
