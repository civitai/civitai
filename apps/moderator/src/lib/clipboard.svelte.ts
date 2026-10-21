type Outcome = { key: string; ok: boolean };

/** Copy-to-clipboard feedback for several buttons that share one owner; `key` names the button. */
export function clipboardFeedback(resetMs = 1500) {
  let outcome = $state<Outcome | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const show = (next: Outcome) => {
    clearTimeout(timer);
    outcome = next;
    timer = setTimeout(() => (outcome = null), resetMs);
  };

  return {
    copied: (key: string) => outcome?.key === key && outcome.ok,
    failed: (key: string) => outcome?.key === key && !outcome.ok,
    async copy(text: string, key: string) {
      try {
        await navigator.clipboard.writeText(text);
        show({ key, ok: true });
      } catch {
        show({ key, ok: false });
      }
    },
  };
}
