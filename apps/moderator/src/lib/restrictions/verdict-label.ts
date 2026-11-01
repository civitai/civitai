const LABELS: Record<string, string> = { Upheld: 'Mute upheld', Overturned: 'Mute removed' };

/** The label shown on a restriction once its ruling is posted, read from the verdict actually submitted. An unknown verdict gets no label rather than a wrong one. */
export const rulingLabel = (form: FormData) => LABELS[String(form.get('status'))] ?? '';
