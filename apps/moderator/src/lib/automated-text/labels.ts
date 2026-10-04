/**
 * The answer a labeler gives for one (report, tag) pair. STORED values, also in schema.sql's CHECK:
 * renaming one orphans every recorded answer.
 */
export const TEXT_LABELS = [
  {
    value: 'clear_violation',
    label: 'Clear violation',
    hint: 'States or promotes what the tag names',
  },
  { value: 'borderline', label: 'Borderline', hint: 'Could reasonably be read either way' },
  {
    value: 'false_positive',
    label: 'False positive',
    hint: 'Matches a keyword but is benign: quoting, reporting, a joke, a model name',
  },
  {
    value: 'cannot_tell',
    label: 'Cannot tell',
    hint: 'Too short, or missing the context to judge',
  },
] as const;

export type TextLabel = (typeof TEXT_LABELS)[number]['value'];

const LABEL_VALUES: ReadonlySet<string> = new Set(TEXT_LABELS.map((l) => l.value));

export const parseTextLabel = (raw: unknown): TextLabel | null =>
  typeof raw === 'string' && LABEL_VALUES.has(raw) ? (raw as TextLabel) : null;

export const MAX_NOTE_LENGTH = 1000;

/** A clear violation on one of these is a live case, not only a label: the page hands it off. */
export const HAND_OFF_TAGS: ReadonlySet<string> = new Set(['CSAM', 'Grooming']);

export const needsHandOff = (tag: string, label: TextLabel): boolean =>
  label === 'clear_violation' && HAND_OFF_TAGS.has(tag);

const SPEAKER = String.raw`\[(\d+)\]:\s`;

/** A chat transcript, recognised by its shape when its report row no longer says it was a chat. */
export const looksLikeChatTranscript = (text: string): boolean =>
  new RegExp(`^${SPEAKER}`).test(text);

/**
 * `entity-moderation` sends Clavata a chat as `[<userId>]: <message> | [<userId>]: ...`. The ids say
 * who wrote it, which the labeler must not see; turn order survives as Speaker A, B, ...
 */
export function maskChatSpeakers(text: string): string {
  const speakers = new Map<string, string>();
  return text.replace(new RegExp(`(^|\\s\\|\\s)${SPEAKER}`, 'g'), (_, lead: string, id: string) => {
    if (!speakers.has(id)) speakers.set(id, `Speaker ${speakerName(speakers.size)}`);
    return `${lead}[${speakers.get(id)}]: `;
  });
}

const speakerName = (i: number): string =>
  i < 26
    ? String.fromCharCode(65 + i)
    : `${speakerName(Math.floor(i / 26) - 1)}${speakerName(i % 26)}`;
