import { SMITES } from '../smites/config';

export type Notice = { title: string; message: string };

// Players meet the Order's ruling, never the mechanism: "hidden check" is the internal name and is never shown.

/** `reference` and `given` are the answer labels; an unknown reference reads as "otherwise". */
export const warningNotice = (reference: string | null, given: string): Notice => ({
  title: '⚠️ The Order disagrees',
  message: `The Order judged this image ${
    reference ?? 'otherwise'
  }; you judged ${given}. Take this as a warning: another false judgment will cost a heart.`,
});

export const SMITE_NOTICE: Notice = {
  title: '⚡ You have been smote',
  message: `The Order found your judgment false. A heart is lost; ${SMITES.size} true verdicts win it back.`,
};

/** One level off the Order's answer: neither failed nor rewarded. */
export const closeNotice = (reference: string | null): Notice => ({
  title: '≈ A near judgment',
  message: `The Order judged this image ${
    reference ?? 'otherwise'
  }; you were one step off. No reward, no penalty.`,
});

/**
 * Stored as the smite's reason. Smites issued before 2026-11-17 carry the earlier reason text (see the hidden checks doc);
 * anything that matches these smites by reason must match both.
 */
export const SMITE_REASON = 'The Order found a judgment false.';
