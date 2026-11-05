export type Notice = { title: string; message: string };

/** Players know these as skill checks (the original game called them sanity checks). Shown on the next page after the answer. */
export const WARNING_NOTICE: Notice = {
  title: '⚠️ Skill check failed',
  message:
    'You answered a skill check incorrectly. This is your warning: additional failures will result in penalties.',
};

export const SMITE_NOTICE: Notice = {
  title: '⚡ You have been smote',
  message: 'A smite penalty has been applied, reducing your vote weight.',
};

/** Stored as the smite's reason. */
export const SMITE_REASON =
  'You failed a skill check. A smite penalty has been applied, reducing your vote weight.';
