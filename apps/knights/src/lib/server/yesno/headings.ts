/** What the banner calls an axis. Display text only: the axis itself, like every question id, stays on the server. */
const HEADINGS: Record<string, string> = {
  violence: 'Violence',
  sexual: 'Sexual content',
  sexual_visual: 'Sexual content in what is shown',
  sexual_text: 'Sexual content in words',
  language: 'Language',
  language_level: 'How strong the language is',
  profanity: 'Profanity',
  subject_state: 'Who or what is shown',
};

export const headingOf = (questionKey: string, prefix: string): string =>
  HEADINGS[questionKey.slice(prefix.length)] ?? 'A new line of questions';
