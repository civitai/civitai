import { SMITES } from '../smites/config';

export type Notice = { title: string; message: string };

/** Player-facing name is "skill check"; "hidden check" stays internal. */
export const WARNING_NOTICE: Notice = {
  title: '⚠️ Skill check failed',
  message:
    'You answered a skill check incorrectly. This is your warning: additional failures will result in penalties.',
};

export const SMITE_NOTICE: Notice = {
  title: '⚡ You have been smote',
  message: `A smite penalty has been applied and cost you a heart. ${SMITES.size} right verdicts win it back.`,
};

/** Stored as the smite's reason. */
export const SMITE_REASON =
  'You failed a skill check. A smite penalty has been applied and cost you a heart.';

/** A skill-check answer one level off the known answer: neither failed nor rewarded. */
export const CLOSE_NOTICE: Notice = {
  title: '≈ Close call',
  message: 'Your skill check answer was one level off. No penalty and no reward.',
};
