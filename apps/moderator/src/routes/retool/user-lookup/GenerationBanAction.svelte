<script lang="ts">
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import BanConfirmForm from '$lib/components/BanConfirmForm.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { FormState } from '$lib/form-state.svelte';

  /**
   * Ban the account from the generated-media panel's header.
   *
   * Account-level, not per generation: a ban answers a pattern across an account's output, so a
   * control on one workflow would name a single row as the reason it happened.
   */
  let {
    userId,
    username,
    onSuccess,
  }: {
    userId: number;
    username: string | null;
    onSuccess: () => void;
  } = $props();

  let confirming = $state(false);

  // `reload: true` because a ban changes `identity`, which comes from `load`. Without it the header
  // keeps this button armed against a stale `bannedAt`, and `/api/mod/ban-user` TOGGLES — the next
  // click unbans.
  const form = new FormState({
    reload: true,
    onSuccess: () => {
      confirming = false;
      onSuccess();
    },
  });

  const open = () => {
    form.error = null;
    confirming = true;
  };
</script>

{#if confirming}
  <!-- The slot right-aligns a button; the form is not a button and takes the full width. -->
  <div class="w-full text-left">
    {#if form.error}
      <ErrorAlert message={form.error} class="mb-2" />
    {/if}
    <BanConfirmForm
      {userId}
      {username}
      action="?/setBanned"
      enhancer={form.enhance}
      busy={form.submitting}
      onCancel={() => (confirming = false)}
    >
      {#snippet prompt()}
        <p class="mb-2 text-sm text-white">
          A ban does not delete anything in the orchestrator. The options below reach only what this
          account published to the site.
        </p>
      {/snippet}
      {#snippet hidden()}
        <input type="hidden" name="userId" value={userId} />
        <input type="hidden" name="ban" value="true" />
      {/snippet}
    </BanConfirmForm>
  </div>
{:else}
  <Button size="xs" variant="destructive" onclick={open}>Ban account</Button>
{/if}
