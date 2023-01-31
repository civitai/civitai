import truncate from 'lodash/truncate';
import slugify from 'slugify';

export function splitUppercase(value: string) {
  // if all uppercase, return as is
  if (value === value.toUpperCase()) return value;

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

// camelcase but keep all caps words as is
export function camelCase(str: string) {
  return str
    .split(/[\s_-]+/)
    .map((word, index) => {
      if (index === 0) return word.toLowerCase();
      else if (word.toUpperCase() === word) return word;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join('');
}

export function filenamize(value: string, length = 20) {
  value = value.replace(/[']/gi, '').replace(/[^a-z0-9]/gi, '_');
  // adjust length to be length + number of _ in value
  const underscoreCount = (value.match(/_/g) || []).length;
  length = length + underscoreCount;
  return camelCase(truncate(value, { length, separator: '_', omission: '' }));
}

export function replaceInsensitive(value: string, search: string, replace: string) {
  const escaped = search.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  return value.replace(new RegExp(escaped, 'gi'), replace);
}

/**
 * @see https://stackoverflow.com/a/12900504
 */
export function getFileExtension(value: string) {
  return value.slice(((value.lastIndexOf('.') - 1) >>> 0) + 2);
}

export function slugit(value: string) {
  return slugify(value, { lower: true, strict: true });
}

/**
 * @see https://www.geeksforgeeks.org/how-to-strip-out-html-tags-from-a-string-using-javascript/
 */
export function removeTags(str: string) {
  if (!str) return '';

  // Regular expression to identify HTML tags in
  // the input string. Replacing the identified
  // HTML tag with a null string.
  return str.replace(/(<([^>]+)>)/gi, '');
}

export function postgresSlugify(str: string) {
  return str
    .replace(' ', '_')
    .replace(/[^a-zA-Z0-9_]/g, '')
    .toLowerCase();
}
