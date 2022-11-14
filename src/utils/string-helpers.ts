import camelCase from 'lodash/camelCase';
import truncate from 'lodash/truncate';

export function splitUppercase(value: string) {
  return value
    .trim()
    .split(/(?=[A-Z])/)
    .map((word) => word.trim())
    .join(' ');
}

export function getInitials(value: string) {
  return value
    .match(/(^\S\S?|\b\S)?/g)
    ?.join('')
    .match(/(^\S|\S$)?/g)
    ?.join('')
    .toUpperCase();
}

const tokenCharacters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const tokenCharactersLength = tokenCharacters.length;
export function generateToken(length: number) {
  let result = '';
  for (let i = 0; i < length; i++)
    result += tokenCharacters.charAt(Math.floor(Math.random() * tokenCharactersLength));
  return result;
}

export function filenamize(value: string, length = 20) {
  return truncate(camelCase(value.replace(/[^a-z0-9]/gi, '_')), { length });
}
