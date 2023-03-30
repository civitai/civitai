import truncate from 'lodash/truncate';
import slugify from 'slugify';

import allowedUrls from '~/utils/allowed-third-party-urls.json';

function getUrlDomain(url: string) {
  // convert url string into a URL object and extract just the domain, avoiding subdomains
  // e.g. https://www.google.com/ -> google.com
  return new URL(url).hostname.split('.').slice(-2).join('.');
}

export function splitUppercase(value: string) {
  return value
    .trim()
    .split(/([A-Z][a-z]+|[0-9]+)/)
    .map((word) => word.trim())
    .join(' ');
}

const nameOverrides: Record<string, string> = {
  LoCon: 'LyCORIS',
  LORA: 'LoRA',
};
export function getDisplayName(value: string) {
  return nameOverrides[value] ?? splitUppercase(value);
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

  // Replace all HTML tags with a single space
  const stringWithoutTags = str.replace(/<[^>]*>/g, ' ');

  // Replace multiple spaces with a single space
  const stringWithoutExtraSpaces = stringWithoutTags.replace(/\s+/g, ' ');

  // Trim the resulting string to remove leading/trailing spaces
  return stringWithoutExtraSpaces.trim();
}

export function postgresSlugify(str: string) {
  return str
    .replace(' ', '_')
    .replace(/[^a-zA-Z0-9_]/g, '')
    .toLowerCase();
}

export function titleCase(val: string) {
  return val[0].toUpperCase() + val.slice(1).toLowerCase();
}

export function isUUID(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export const validateThirdPartyUrl = (url: string) => {
  const toValidate = getUrlDomain(url);
  return allowedUrls.map(getUrlDomain).includes(toValidate);
};
