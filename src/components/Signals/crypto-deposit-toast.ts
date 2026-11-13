const IN_PROGRESS_STATUSES = ['confirming', 'confirmed', 'sending'];

/** The toast for a deposit status update, or null when the update deserves none. */
export function cryptoDepositToast(
  status: string,
  currencyDisplay: string,
  outcomeAmount?: number
): { title: string; message: string; color: string } | null {
  if (status === 'finished') {
    const buzzAmount = outcomeAmount ? Math.floor(outcomeAmount * 1000) : null;
    return {
      title: 'Crypto Deposit Complete',
      message: buzzAmount
        ? `You received ${buzzAmount.toLocaleString()} Buzz from your ${currencyDisplay} deposit.`
        : `Your ${currencyDisplay} deposit has been processed.`,
      color: 'green',
    };
  }
  if (IN_PROGRESS_STATUSES.includes(status)) {
    return {
      title: 'Crypto Deposit Detected',
      message: `Your ${currencyDisplay} deposit is being confirmed on-chain.`,
      color: 'blue',
    };
  }
  return null;
}
