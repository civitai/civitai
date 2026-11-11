export type Notice = { title: string; message: string };

/** Player-facing name is "skill check"; "hidden check" stays internal. */
export const WARNING_NOTICE: Notice = {
  title: '⚠️ Skill check failed',
  message:
    'You answered a skill check incorrectly. This is your warning: additional failures will result in penalties.',
};

export const SMITE_NOTICE: Notice = {
  title: '⚡ You have been smote',
  message: 'A smite penalty has been applied and cost you a heart.',
};

/** Stored as the smite's reason. */
export const SMITE_REASON =
  'You failed a skill check. A smite penalty has been applied and cost you a heart.';
