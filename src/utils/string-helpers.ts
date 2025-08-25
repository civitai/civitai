import { Air } from '@civitai/client';
import { truncate } from 'lodash-es';
import slugify from 'slugify';

import allowedUrls from '~/utils/allowed-third-party-urls.json';
import { toJson } from '~/utils/json-helpers';

function getUrlDomain(url: string) {
  // convert url string into a URL object and extract just the domain, avoiding subdomains
  // e.g. https://www.google.com/ -> google.com
  return new URL(url).hostname.split('.').slice(-2).join('.');
}

export function splitUppercase(value: string, options?: { splitNumbers?: boolean }) {
  return value
    .trim()
    .split(options?.splitNumbers ? /([A-Z][a-z]+|[0-9]+)/ : /([A-Z][a-z]+)/)
    .map((word) => word.trim())
    .filter(Boolean)
    .join(' ');
}

const stripeCurrencyMap: Record<string, [string, number]> = {
  usd: ['$', 100],
  aud: ['$', 100],
  cad: ['$', 100],
  eur: ['€', 100],
  gbp: ['£', 100],
  jpy: ['¥', 1],
  krw: ['₩', 1],
};

export function getStripeCurrencyDisplay(unitAmount: number, currency: string) {
  const [symbol, divisor] = stripeCurrencyMap[currency.toLowerCase()] ?? ['$', 100];

  const hasDecimals = (unitAmount / divisor).toFixed(2).split('.')[1] !== '00';

  return (
    symbol +
    (unitAmount / divisor).toLocaleString(undefined, { minimumFractionDigits: hasDecimals ? 2 : 0 })
  );
}

const nameOverrides: Record<string, string> = {
  LoCon: 'LyCORIS',
  LORA: 'LoRA',
  DoRA: 'DoRA',
  scheduler: 'Sampler',
  TextualInversion: 'Embedding',
  MotionModule: 'Motion',
  BenefactorsOnly: 'Supporters Only',
  ModelVersion: 'Model Version',
  ClubMembership: 'Club Membership',
  Redeemable: 'Redeemed Code',
  'PixArt E': 'PixArt Σ',
  'PixArt a': 'PixArt α',
  ProfileDecoration: 'Avatar Decoration',
  CogVideoX: 'CogVideoX',
  minimax: 'Hailou by MiniMax',
  NoobAI: 'NoobAI',
  InternalValue: 'Internal Value',
  ACH: 'ACH',
  HiDream: 'HiDream',
  'Wan Video': 'WAN Video',
  commentV2: 'Comment',
  CommentV2: 'Comment',
};

export function getDisplayName(
  value: string,
  options?: { splitNumbers?: boolean; overwrites?: Record<string, string> }
) {
  const { splitNumbers = true } = options ?? {};
  if (!value) return '';

  return (
    options?.overwrites?.[value] ?? nameOverrides[value] ?? splitUppercase(value, { splitNumbers })
  );
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

export function stripLeadingWhitespace(str: string) {
  return str.replace(/^[ \t]+/gm, '');
}

export function postgresSlugify(str?: string) {
  if (!str) return '';

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

export function hashify(str: string) {
  let hash = 0;
  for (let i = 0, len = str.length; i < len; i++) {
    const chr = str.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0; // Convert to 32bit integer
  }
  return hash;
}

export function hashifyObject(obj: any) {
  if (!obj) return '';
  const str = toJson(obj);
  return hashify(str);
}

export function trimNonAlphanumeric(str: string | null | undefined) {
  return str?.replace(/^[^\w]+|[^\w]+$/g, '');
}

type CivitaiAir = {
  source: 'civitai';
  version: number;
  model: number;
};

type OrchestratorAir = {
  source: 'orchestrator';
  jobId: string;
  fileName: string;
};

type AIR = {
  ecosystem: string;
  type: string;
  format?: string | undefined;
} & (CivitaiAir | OrchestratorAir);

export function parseAIR(identifier: string) {
  const { id, version, ...value } = Air.parse(identifier);
  return { ...value, model: Number(id), version: Number(version) };
}

export function parseAIRSafe(identifier: string | undefined) {
  if (identifier === undefined) return identifier;
  const match = Air.parseSafe(identifier);
  if (!match) return match;

  const { id, version, ...value } = match;
  return { ...value, model: Number(id), version: Number(version) };
}

export function isAir(identifier: string) {
  return Air.isAir(identifier);
}

export function getAirModelLink(identifier: string) {
  const parsed = parseAIRSafe(identifier);
  if (!parsed) return '/';
  return `/models/${parsed.model}?modelVersionId=${parsed.version}`;
}

export function safeDecodeURIComponent(str: string) {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

export function getRandomId() {
  return Math.random().toString(36).substring(2, 11);
}

export function toPascalCase(str: string) {
  // Split the string by any sequence of non-alphanumeric characters
  const words = str.split(/[^a-zA-Z0-9]+/);

  // Capitalize the first letter of each word
  const pascalCaseWords = words.map((word) => {
    if (!isNaN(parseInt(word[0]))) {
      // If the word starts with a digit, keep the entire word as is
      return word.toUpperCase();
    }
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });

  // Join the words back together with a space
  return pascalCaseWords.join(' ');
}

export function capitalize(str: string) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
