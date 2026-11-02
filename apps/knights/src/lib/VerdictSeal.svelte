<script lang="ts">
  import Icon from './Icon.svelte';

  type Status = 'pending' | 'correct' | 'wrong' | 'inconclusive' | 'forfeited';
  let { status, label }: { status: Status; label: string } = $props();

  const ICONS = {
    correct: 'check',
    wrong: 'x',
    pending: 'hourglass',
    inconclusive: 'minus',
    forfeited: 'ban',
  } as const;
</script>

<span class="verdict {status}">
  <span class="seal" aria-hidden="true"><Icon name={ICONS[status]} size={status === 'forfeited' ? 22 : 18} /></span>
  <span class="label">{label}</span>
</span>

<style>
  .verdict {
    display: inline-flex;
    align-items: center;
    gap: 0.75rem;
    font: 500 1rem/1.3 var(--io-font-ui);
  }
  .seal {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 2.75rem;
    height: 2.75rem;
    border-radius: 50%;
    color: var(--io-parchment);
    box-shadow: inset 0 0 0 3px color-mix(in srgb, var(--io-bg) 55%, transparent);
  }
  .correct .seal {
    background: var(--io-verdigris);
  }
  .correct {
    color: var(--io-verdigris);
  }
  .wrong .seal {
    background: var(--io-crimson);
  }
  .wrong {
    color: var(--io-crimson-text);
  }
  .pending .seal {
    background: var(--io-gold-muted);
    color: var(--io-gold);
  }
  .pending {
    color: var(--io-gold);
  }
  .inconclusive .seal {
    background: #b8ac92;
    color: var(--io-bg);
  }
  .inconclusive {
    color: #b8ac92;
  }
  /* A forfeited judgment is not a verdict: no seal, just the label. */
  .forfeited .seal {
    width: auto;
    height: auto;
    background: none;
    box-shadow: none;
    color: var(--io-parchment-muted);
  }
  .forfeited {
    gap: 0.6rem;
    color: var(--io-parchment-muted);
    font-weight: 400;
  }
</style>
