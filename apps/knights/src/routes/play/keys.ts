type Option = { value: string; label: string };

/** Options are numbered from 1 in the order the question lists them; only single keys, so nine at most. */
export const keyHints = (options: Option[]) =>
  options.slice(0, 9).map((option, index) => ({ key: String(index + 1), label: option.label }));

export function answerForKey(options: Option[], key: string): string | null {
  return /^[1-9]$/.test(key) ? options[Number(key) - 1]?.value ?? null : null;
}
