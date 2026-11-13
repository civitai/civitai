<script lang="ts">
  import { enhance } from '$app/forms';
  import { onMount } from 'svelte';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import WarningAlert from '$lib/components/WarningAlert.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import { denied } from '$lib/permissions';
  import {
    ITEM_DEFINITION_STATUS,
    MAX_BOXES_PER_USER,
    MAX_GRANT_USERS,
    newBoxGrantId,
    parseUserIdList,
  } from '$lib/mystery-box';
  import type { BoxGrantResult } from '$lib/server/mystery-box-grant.service';

  let { boxStatus, canGrant }: { boxStatus: string; canGrant: boolean } = $props();

  let userIds = $state('');
  let count = $state<number | null>(1);
  // Minted in the browser only, so the id the form posts is the one this page holds.
  let grantId = $state('');
  onMount(() => (grantId = newBoxGrantId()));
  let last = $state<(BoxGrantResult & { count: number }) | null>(null);

  const granting = new FormState({
    onSubmit: () => (last = null),
    onSuccess: (data) => {
      const result = data as BoxGrantResult & { count: number };
      last = result;
      // Busy and failed users go back in the box under the same grant id, so granting again finishes
      // the job and cannot give anyone twice.
      const retry = [...result.busyUserIds, ...result.failedUserIds];
      userIds = retry.join(' ');
      if (!retry.length) grantId = newBoxGrantId();
    },
    reset: false,
  });

  const published = $derived(boxStatus === ITEM_DEFINITION_STATUS.published);
  const named = $derived(parseUserIdList(userIds).length);
</script>

<section class="mb-6 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="mb-1 text-base font-semibold text-white">Grant boxes</h2>
  <p class="mb-3 text-xs text-dark-2">
    Free boxes for prizes and launches: no purchase and no Buzz. Each user gets the boxes unopened,
    and opens them like a bought one. One taken back from User Lookup is gone, or what it gave, once
    opened.
  </p>
  {#if !canGrant}
    <p class="text-sm text-dark-2">{denied('items.boxes.grant')}</p>
  {:else if !published}
    <p class="text-sm text-dark-2">Only a published box can be granted.</p>
  {:else}
    <form method="POST" action="?/grant" use:enhance={granting.enhance} class="space-y-3">
      <input type="hidden" name="grantId" value={grantId} />
      <Textarea
        name="userIds"
        bind:value={userIds}
        rows={3}
        placeholder="User ids, separated by commas, spaces or new lines"
        aria-label="User ids"
      />
      <div class="flex flex-wrap items-center gap-2">
        <Input
          type="number"
          name="count"
          bind:value={count}
          min={1}
          max={MAX_BOXES_PER_USER}
          class="h-8 w-20"
          aria-label="Boxes each"
        />
        <span class="text-sm text-dark-2">each, to {named} user{named === 1 ? '' : 's'}</span>
        <Button
          type="submit"
          size="sm"
          class="ml-auto"
          disabled={granting.submitting ||
            !grantId ||
            !count ||
            named === 0 ||
            named > MAX_GRANT_USERS}
        >
          Grant
        </Button>
      </div>
      {#if named > MAX_GRANT_USERS}
        <p class="text-xs text-red-300">At most {MAX_GRANT_USERS} users at a time.</p>
      {/if}
    </form>
  {/if}
  {#if granting.error}
    <ErrorAlert class="mt-3" message={granting.error} />
  {/if}
  {#if last}
    <div class="mt-3 space-y-2 text-sm" role="status">
      <p class="text-dark-0">
        Granted {last.count} box{last.count === 1 ? '' : 'es'} each to {last.grantedUserIds.length}
        user{last.grantedUserIds.length === 1 ? '' : 's'}.
      </p>
      {#if last.alreadyGrantedUserIds.length}
        <p class="text-dark-2">
          Already granted by this form, so skipped: {last.alreadyGrantedUserIds.join(', ')}.
        </p>
      {/if}
      {#if last.busyUserIds.length}
        <WarningAlert
          message={`Skipped ${last.busyUserIds.join(', ')}: a purchase, box opening or moderator change was in progress.`}
        />
      {/if}
      {#if last.failedUserIds.length}
        <ErrorAlert message={`Nothing was given to ${last.failedUserIds.join(', ')}: their grant failed.`} />
      {/if}
      {#if last.busyUserIds.length || last.failedUserIds.length}
        <p class="text-dark-2">They are left above; grant again in a moment to finish.</p>
      {/if}
    </div>
  {/if}
</section>
