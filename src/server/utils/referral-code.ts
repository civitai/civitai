import { randomInt } from 'crypto';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const randomLetters = (length: number) =>
  Array.from({ length }, () => LETTERS[randomInt(LETTERS.length)]).join('');

/** `ABC-XYZ`: the first three letters of the username, or random ones when it is shorter. */
export function generateReferralCode(username?: string | null) {
  const prefix =
    username && username.length >= 3 ? username.slice(0, 3).toUpperCase() : randomLetters(3);
  return `${prefix}-${randomLetters(3)}`;
}
