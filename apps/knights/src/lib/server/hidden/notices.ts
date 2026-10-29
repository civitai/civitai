export type Notice = { title: string; message: string };

/** The original game's sanity-check wording, shown on the next page after the answer. */
export const WARNING_NOTICE: Notice = {
  title: '⚠️ Sanity check failed',
  message:
    'You rated a validation image incorrectly. This is your warning: additional failures will result in penalties.',
};

export const SMITE_NOTICE: Notice = {
  title: '⚡ You have been smote',
  message: 'A smite penalty has been applied, reducing your vote weight.',
};

/** Stored as the smite's reason. */
export const SMITE_REASON =
  'You failed a sanity check. A smite penalty has been applied, reducing your vote weight.';
