<script lang="ts">
  import Icon from '$lib/Icon.svelte';
  import SettingSwitch from './SettingSwitch.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  type Status = { kind: 'saved'; text: string } | { kind: 'error'; text: string } | null;
  let questionsStatus = $state<Status>(null);
  let groupsStatus = $state<Status>(null);
</script>

<svelte:head>
  <title>Settings · Knights of New Order</title>
</svelte:head>

{#snippet status(current: Status)}
  <p class="status" class:idle={!current} role="status">
    {#if current?.kind === 'error'}
      <span class="error">{current.text}</span>
    {:else if current}
      <Icon name="check" size={13} />{current.text}
    {/if}
  </p>
{/snippet}

<div class="settings">
  <header>
    <p class="eyebrow">Knights of New Order</p>
    <h1 class="page-title">Settings</h1>
    <p class="lede">Choose what Knights serves you. Changes apply from your next image.</p>
  </header>

  <section aria-labelledby="questions-title">
    <h2 id="questions-title">Questions</h2>
    <div class="rows">
      <div class="row">
        <div class="text">
          <p class="label">
            <span id="questions-label">Yes/no questions</span>
            <span class="beta">Beta</span>
          </p>
          {#if data.questions.available}
            <p class="description" id="questions-description">
              Between ratings, some images ask a yes or no question. Turn this off to rate only.
            </p>
            <p class="note">
              <Icon name="info" size={13} />Available while Knights is in beta. Questions may become part
              of every Watch later.
            </p>
          {:else}
            <p class="description">
              Acolytes answer practice questions as part of their training. You can turn yes/no questions
              off once you are a Knight.
            </p>
          {/if}
        </div>
        {#if data.questions.available}
          <SettingSwitch
            action="?/questions"
            field="questions"
            on={data.questions.on}
            labelledby="questions-label"
            describedby="questions-description"
            onsaved={(on) =>
              (questionsStatus = {
                kind: 'saved',
                text: `Saved. Questions are ${on ? 'on' : 'off'} from your next image.`,
              })}
            onerror={(text) => (questionsStatus = { kind: 'error', text })}
          />
        {/if}
      </div>
    </div>
    {@render status(questionsStatus)}
  </section>

  {#if data.tagGroups.available}
    <section aria-labelledby="groups-title">
      <h2 id="groups-title">Hide content</h2>
      <p class="description" id="groups-description">
        Images tagged with a group you hide are not served to you. Your hidden tags on Civitai don't
        apply here.
      </p>
      <div class="rows">
        {#each data.tagGroups.groups as group (group.key)}
          <div class="row">
            <div class="text">
              <p class="label"><span id="group-{group.key}-label">{group.label}</span></p>
              <p class="description" id="group-{group.key}-description">{group.description}</p>
            </div>
            <SettingSwitch
              action="?/tagGroup"
              field="hidden"
              fields={{ key: group.key }}
              on={group.hidden}
              labelledby="group-{group.key}-label"
              describedby="group-{group.key}-description groups-description"
              onsaved={(hidden) =>
                (groupsStatus = {
                  kind: 'saved',
                  text: `Saved. ${group.label} images are ${hidden ? 'hidden' : 'shown'} from your next image.`,
                })}
              onerror={(text) => (groupsStatus = { kind: 'error', text })}
            />
          </div>
        {/each}
      </div>
      {@render status(groupsStatus)}
    </section>
  {/if}
</div>

<style>
  .settings {
    display: flex;
    flex-direction: column;
    gap: 2rem;
    max-width: 45rem;
    margin: 0 auto;
    padding-top: 1rem;
  }

  /* B12: the lede sits 10px under the title, and the page gap alone parts it from the first section. */
  header .page-title {
    margin-bottom: 0.625rem;
  }
  header .lede {
    margin: 0;
  }

  section {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
  }

  h2 {
    margin: 0;
    color: var(--io-gold);
    font: 700 0.875rem/1.3 var(--io-font-display);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .rows {
    border: 1px solid color-mix(in srgb, var(--io-gold-muted) 55%, transparent);
    border-radius: 8px;
    background: var(--io-surface);
  }

  .row + .row {
    border-top: 1px solid color-mix(in srgb, var(--io-gold-muted) 30%, transparent);
  }

  .row {
    display: flex;
    gap: 1rem;
    align-items: center;
    padding: 1rem 1.125rem;
  }

  .text {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }

  .label {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin: 0;
    color: var(--io-parchment);
    font: 600 0.95rem/1.3 var(--io-font-ui);
  }

  .beta {
    padding: 0.125rem 0.5rem;
    border: 1px solid var(--io-gold-muted);
    border-radius: 999px;
    background: color-mix(in srgb, var(--io-gold) 14%, transparent);
    color: var(--io-gold);
    font: 600 0.625rem/1.3 var(--io-font-ui);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .description {
    margin: 0;
    color: var(--io-parchment-muted);
    font: 1rem/1.35 var(--io-font-body);
  }

  .note {
    display: flex;
    gap: 0.375rem;
    align-items: center;
    margin: 0.25rem 0 0;
    color: var(--io-parchment-muted);
    font: 0.75rem/1.4 var(--io-font-ui);
  }

  .note :global(svg) {
    flex: none;
    color: var(--io-gold-muted);
  }

  .status {
    display: flex;
    gap: 0.375rem;
    align-items: center;
    min-height: 1.1rem;
    margin: 0;
    color: var(--io-parchment-muted);
    font: 0.75rem/1.4 var(--io-font-ui);
  }

  /* An empty live region stays in the page for screen readers but takes no space, so it opens no gap. */
  .status.idle {
    min-height: 0;
    margin-top: -0.875rem;
  }

  .status :global(svg) {
    color: var(--io-verdigris);
  }

  .error {
    color: var(--io-crimson-text);
  }
</style>
