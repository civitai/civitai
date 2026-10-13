import { randomInt } from 'crypto';

const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const codePart = () =>
  Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');

/** A `PREFIX-XXXX-XXXX` redeem code drawn from `crypto.randomInt`. */
export function generateRedeemCode(prefix: 'MB' | 'CS') {
  return `${prefix}-${codePart()}-${codePart()}`;
}
