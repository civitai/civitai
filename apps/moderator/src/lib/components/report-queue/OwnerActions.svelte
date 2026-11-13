<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import CannedReasonPicker from '$lib/components/CannedReasonPicker.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { STRIKE_REASONS } from '$lib/moderation-reasons';
  import { FormState } from '$lib/form-state.svelte';
  import { userLookupUrl } from '$lib/entity-url';
  import { page } from '$app/state';
  import MessageAsCivitai from '$lib/components/MessageAsCivitai.svelte';

  /**
   * A strike or a notification for the account a reported item belongs to, posting to the shared
   * `?/strike` and `?/notify` report actions. The post queue and every shared-layout queue; the user
   * queue has the full account panel instead.
   *
   * One FormState per action, so a refusal shows in the row that was refused. Holds what is open, so
   * the page renders it inside `{#key}` on the item.
   */
  let {
    userId,
    heading = 'Act on the owner',
    reportId,
  }: {
    userId: number;
    heading?: string;
    reportId?: number;
  } = $props();

  let open = $state<'strike' | 'notify' | null>(null);
  let strikeReason = $state('');
  const strikeForm = new FormState({
    reload: true,
    onSuccess: () => {
      open = null;
      strikeReason = '';
    },
  });
  const notifyForm = new FormState({ reload: true, onSuccess: () => (open = null) });
</script>

<section aria-labelledby="owner-heading" class="flex flex-col gap-2">
  <h3 id="owner-heading" class="m-0 text-sm font-semibold">{heading}</h3>
  <div class="divide-y rounded-lg border">
    <div class="flex flex-col gap-2 p-3">
      <div>
        <p class="m-0 text-sm font-medium">Strike</p>
        <p class="m-0 text-xs text-muted-foreground">
          Records a strike with the reason the user is shown, and notifies them.
        </p>
      </div>
      {#if open === 'strike'}
        <form method="POST" action="?/strike" use:enhance={strikeForm.enhance} class="flex flex-col gap-2">
          <input type="hidden" name="userId" value={userId} />
          {#if strikeForm.error}<ErrorAlert message={strikeForm.error} />{/if}
          <CannedReasonPicker reasons={STRIKE_REASONS} idPrefix="strike" bind:value={strikeReason} />
          <div class="flex flex-wrap gap-2">
            <Button type="submit" size="sm" variant="destructive" disabled={strikeForm.submitting}>
              {strikeForm.submitting ? 'Working…' : 'Issue strike'}
            </Button>
            <Button type="button" size="sm" variant="ghost" onclick={() => (open = null)}>Cancel</Button>
          </div>
        </form>
      {:else}
        <div><Button size="sm" variant="outline" onclick={() => (open = 'strike')}>Strike</Button></div>
      {/if}
    </div>

    <div class="flex flex-col gap-2 p-3">
      <div>
        <p class="m-0 text-sm font-medium">Notify</p>
        <p class="m-0 text-xs text-muted-foreground">Sends the user a message from the moderators.</p>
      </div>
      {#if open === 'notify'}
        <form method="POST" action="?/notify" use:enhance={notifyForm.enhance} class="flex flex-col gap-2">
          <input type="hidden" name="userId" value={userId} />
          {#if notifyForm.error}<ErrorAlert message={notifyForm.error} />{/if}
          <Textarea
            name="message"
            rows={3}
            aria-label="Message to the user"
            placeholder="What should this user be told?"
            required
          />
          <div class="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={notifyForm.submitting}>Send</Button>
            <Button type="button" size="sm" variant="ghost" onclick={() => (open = null)}>Cancel</Button>
          </div>
        </form>
      {:else}
        <div><Button size="sm" variant="outline" onclick={() => (open = 'notify')}>Notify</Button></div>
      {/if}
    </div>
  </div>
  <MessageAsCivitai
    {userId}
    {reportId}
    canAct={!!page.data.grants?.['user.message.asCivitai']}
    action="?/messageAsCivitai"
  />
  <p class="m-0 text-xs text-muted-foreground">
    Muting, banning and the rest are in
    <a href={userLookupUrl(userId)} class="link">User Lookup</a>.
  </p>
</section>
