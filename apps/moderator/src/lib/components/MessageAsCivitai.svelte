<script lang="ts">
  import { enhance } from '$app/forms';
  import { FormState } from '$lib/form-state.svelte';
  import { MESSAGE_AS_CIVITAI_MAX_LENGTH } from '$lib/message-as-civitai';
  import { denied } from '$lib/permissions';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';

  let {
    userId,
    canAct,
    action,
    reportId,
    onSent,
  }: {
    userId: number;
    /** The `user.message.asCivitai` action grant. */
    canAct: boolean;
    /** The form action that sends, e.g. `?/messageAsCivitai`. */
    action: string;
    reportId?: number;
    onSent?: () => void;
  } = $props();

  let composing = $state(false);
  let sentChatId = $state<number | null>(null);
  // One key per composed message: a double submit or a retry after a lost response sends it once.
  let idempotencyKey = $state(crypto.randomUUID());

  const form = new FormState({
    onSuccess: (data) => {
      sentChatId = typeof data?.chatId === 'number' ? data.chatId : null;
      idempotencyKey = crypto.randomUUID();
      composing = false;
      onSent?.();
    },
  });
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <div class="mb-1 flex items-baseline justify-between gap-3">
    <h3 class="text-sm font-semibold text-white">Message as Civitai Moderation</h3>
    {#if canAct && !composing}
      <Button size="sm" onclick={() => (composing = true)}>Compose</Button>
    {/if}
  </div>
  <p class="mb-3 text-xs text-dark-2">
    A chat message from the shared Civitai Moderation account. The user sees only that account and can
    reply; replies land in <a class="underline" href="/messages">Messages</a>. You are recorded as the
    sender.
  </p>

  {#if form.error}
    <ErrorAlert class="mb-3" message={form.error} />
  {/if}
  {#if sentChatId !== null && !composing}
    <p class="mb-3 text-sm text-green-300">
      Sent. <a class="underline" href={`/messages/${userId}`}>Open the thread</a>
    </p>
  {/if}

  {#if !canAct}
    <p class="text-sm text-dark-2">{denied('user.message.asCivitai')}</p>
  {:else if composing}
    <form method="POST" {action} use:enhance={form.enhance}>
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      {#if reportId !== undefined}
        <input type="hidden" name="reportId" value={reportId} />
      {/if}
      <Textarea
        name="message"
        rows={4}
        maxlength={MESSAGE_AS_CIVITAI_MAX_LENGTH}
        placeholder="Your message, as Civitai Moderation"
        required
      />
      <div class="mt-2 flex gap-2">
        <Button type="submit" size="sm" disabled={form.submitting}>
          {form.submitting ? 'Sending…' : 'Send'}
        </Button>
        <Button type="button" size="sm" variant="outline" onclick={() => (composing = false)}>
          Cancel
        </Button>
      </div>
    </form>
  {/if}
</section>
