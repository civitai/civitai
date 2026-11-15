type Option = { value: string; label: string };

/** Options are numbered from 1 in the order the question lists them; only single keys, so nine at most. */
export const keyHints = (options: Option[]) =>
  options.slice(0, 9).map((option, index) => ({ key: String(index + 1), label: option.label }));

export function answerForKey(options: Option[], key: string): string | null {
  return /^[1-9]$/.test(key) ? options[Number(key) - 1]?.value ?? null : null;
}

const YES_NO_LETTERS: Record<string, string> = { y: 'yes', n: 'no' };

/** A yes/no question also takes Y and N; both kinds take the option's number. */
export function answerForKeyPress(options: Option[], key: string, yesNo: boolean): string | null {
  return (yesNo ? YES_NO_LETTERS[key.toLowerCase()] : undefined) ?? answerForKey(options, key);
}

type Screen = {
  question?: { options: Option[] } | null;
  apprentice?: { kind: string; options?: Option[] } | null;
};

/** The options the number keys answer: the queue question's, or the apprenticeship question's; none on a recap. */
export function optionsOnScreen({ question, apprentice }: Screen): Option[] | null {
  if (question) return question.options;
  return apprentice?.kind === 'question' ? apprentice.options ?? null : null;
}

/** Space skips a queue item; in the apprenticeship (no skip) it stays the browser's, pressing a focused button. */
export const spaceSkips = ({ question }: Screen): boolean => !!question;
