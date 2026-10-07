/** Whether a refused mutation should open the Terms: only when the server offers it, and only once. */
export function shouldPromptTosReacceptance(error: unknown, alreadyAccepted: boolean) {
  const data = (error as { data?: { tosReacceptRequired?: boolean } } | null)?.data;
  return !!data?.tosReacceptRequired && !alreadyAccepted;
}

/**
 * What the prompt does once the user accepts. Acceptance never lifts a mute, so the notice says the
 * account stays restricted; a failed acceptance shows nothing and leaves the prompt armed.
 */
export function tosAcceptanceOutcome(result: { accepted?: boolean } | undefined) {
  if (!result?.accepted) return { accepted: false as const, notice: null };
  return {
    accepted: true as const,
    notice: {
      title: 'Your account is still restricted',
      message:
        'Thanks for accepting. The restriction lifts automatically once your strike points drop, or when a moderator lifts it.',
    },
  };
}
