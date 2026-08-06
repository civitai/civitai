<script lang="ts">
  import { browser } from '$app/environment';
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import type { PageData } from './$types';
  import { LINK_CLASS, dateTime } from './format';

  type Identity = NonNullable<PageData['result']>['identity'];
  type TimedMute = {
    id: number;
    muteStart: string | null;
    muteEnd: string | null;
    createdBy: string | null;
    muteReason: string | null;
    isMuted: boolean | null;
  };
  type Support = {
    timedMutes: TimedMute[];
    freshdesk: { id: number; name: string | null; email: string | null; url: string } | null;
  };

  let { identity, canAct }: { identity: Identity; canAct: boolean } = $props();

  let version = $state(0);
  let confirming = $state<'ban' | 'unban' | null>(null);
  let showTimedMute = $state(false);

  const support = $derived(
    browser
      ? fetch(`/api/user-support/${identity.id}?v=${version}`).then((r): Promise<Support> => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json();
        })
      : null
  );

  // The ban endpoint answers before it finishes its work, so re-read rather than trusting the response.
  const afterAction = () => async ({ result }: { result: { type: string } }) => {
    if (result.type === 'success') {
      confirming = null;
      showTimedMute = false;
      version += 1;
    }
    await invalidateAll();
  };
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-1 text-sm font-semibold text-white">Account actions</h3>
  {#if !canAct}
    <p class="text-sm text-dark-2">
      You can view this account but not act on it. Enforcement requires the Users permission.
    </p>
  {:else}
    <p class="mb-3 text-xs text-dark-2">
      Every action is recorded against your account. Banning also purges media and models and notifies
      the user.
    </p>

    <div class="flex flex-wrap gap-2">
      <form method="POST" action="?/setMuted" use:enhance={afterAction}>
        <input type="hidden" name="userId" value={identity.id} />
        <input type="hidden" name="muted" value={identity.muted ? 'false' : 'true'} />
        <Button type="submit" size="sm" variant={identity.muted ? 'default' : 'outline'}>
          {identity.muted ? 'Unmute' : 'Mute'}
        </Button>
      </form>

      <form method="POST" action="?/forceLogout" use:enhance={afterAction}>
        <input type="hidden" name="userId" value={identity.id} />
        <Button type="submit" size="sm" variant="outline">Force logout</Button>
      </form>

      <Button size="sm" variant="outline" onclick={() => (showTimedMute = !showTimedMute)}>
        Timed mute
      </Button>

      {#if identity.bannedAt}
        <Button size="sm" variant="outline" onclick={() => (confirming = 'unban')}>Unban</Button>
      {:else}
        <Button size="sm" variant="destructive" onclick={() => (confirming = 'ban')}>Ban</Button>
      {/if}
    </div>

    {#if showTimedMute}
      <form method="POST" action="?/addTimedMute" use:enhance={afterAction} class="mt-4">
        <input type="hidden" name="userId" value={identity.id} />
        <div class="flex flex-wrap items-end gap-2">
          <label class="text-xs text-dark-2">
            Hours
            <Input name="hours" type="number" min="1" value="24" class="mt-1 w-24" required />
          </label>
          <label class="flex-1 text-xs text-dark-2">
            Reason
            <Input name="reason" placeholder="Why is this mute being applied?" class="mt-1" required />
          </label>
          <Button type="submit" size="sm">Apply</Button>
        </div>
      </form>
    {/if}

    {#if confirming}
      <form method="POST" action="?/setBanned" use:enhance={afterAction} class="mt-4">
        <input type="hidden" name="userId" value={identity.id} />
        <input type="hidden" name="ban" value={confirming === 'ban' ? 'true' : 'false'} />
        <div
          class="rounded-md border p-3 {confirming === 'ban'
            ? 'border-red-500/40 bg-red-500/10'
            : 'border-dark-4 bg-dark-7'}"
        >
          <p class="mb-2 text-sm text-white">
            {#if confirming === 'ban'}
              Ban <strong>{identity.username ?? identity.id}</strong>? This removes their media and
              models and notifies them.
            {:else}
              Unban <strong>{identity.username ?? identity.id}</strong>?
            {/if}
          </p>
          {#if confirming === 'ban'}
            <Input name="reasonCode" placeholder="Reason code (optional)" class="mb-2" />
            <Textarea name="detailsInternal" rows={2} placeholder="Internal notes (optional)" />
          {/if}
          <div class="mt-2 flex gap-2">
            <Button type="submit" size="sm" variant={confirming === 'ban' ? 'destructive' : 'default'}>
              Confirm {confirming}
            </Button>
            <Button type="button" size="sm" variant="outline" onclick={() => (confirming = null)}>
              Cancel
            </Button>
          </div>
        </div>
      </form>
    {/if}
  {/if}

  {#await support then result}
    {#if result}
      <div class="mt-5 grid gap-5 lg:grid-cols-2">
        <div>
          <h4 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">
            Timed mutes ({result.timedMutes.length})
          </h4>
          {#if result.timedMutes.length === 0}
            <p class="text-sm text-dark-2">None.</p>
          {:else}
            <ul class="space-y-1 text-sm">
              {#each result.timedMutes as m (m.id)}
                <li class="flex flex-wrap items-baseline gap-x-2">
                  {#if m.isMuted}<Badge variant="destructive">active</Badge>{:else}<Badge
                      variant="secondary">ended</Badge
                    >{/if}
                  <span class="text-dark-0">until {dateTime(m.muteEnd)}</span>
                  <span class="text-xs text-dark-2">{m.createdBy ?? 'unknown'}</span>
                  {#if m.isMuted && canAct}
                    <form method="POST" action="?/revokeTimedMute" use:enhance={afterAction}>
                      <input type="hidden" name="id" value={m.id} />
                      <input type="hidden" name="userId" value={identity.id} />
                      <button type="submit" class="text-xs {LINK_CLASS}">revoke</button>
                    </form>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </div>

        <div>
          <h4 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">Support</h4>
          {#if !result.freshdesk}
            <p class="text-sm text-dark-2">No Freshdesk contact found.</p>
          {:else}
            <a href={result.freshdesk.url} target="_blank" rel="noreferrer" class="text-sm {LINK_CLASS}">
              {result.freshdesk.name ?? result.freshdesk.email ?? `contact ${result.freshdesk.id}`}
            </a>
          {/if}
        </div>
      </div>
    {/if}
  {/await}
</section>
