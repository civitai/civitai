import { ModelType } from '@prisma/client';
import he from 'he';
import { truncate } from 'lodash-es';
import slugify from 'slugify';
import { BaseModel, baseModelSets } from '~/server/common/constants';

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
  ClubMembership: 'Club Memebership',
  Redeemable: 'Redeemed Code',
};

export function getDisplayName(value: string, options?: { splitNumbers?: boolean }) {
  const { splitNumbers = true } = options ?? {};
  if (!value) return '';

  return nameOverrides[value] ?? splitUppercase(value, { splitNumbers });
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

export function normalizeText(input?: string): string {
  if (!input) return '';
  return he
    .decode(input)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

const regex =
  /^(?:urn:)?(?:air:)?(?:(?<ecosystem>[a-zA-Z0-9_\-\/]+):)?(?:(?<type>[a-zA-Z0-9_\-\/]+):)?(?<source>[a-zA-Z0-9_\-\/]+):(?<id>[a-zA-Z0-9_\-\/]+)(?:@(?<version>[a-zA-Z0-9_\-]+))?(?:\.(?<format>[a-zA-Z0-9_\-]+))?$/i;

export function parseAIR(identifier: string) {
  const match = regex.exec(identifier);
  if (!match) {
    throw new Error(`Invalid identifier: ${identifier}`);
  }

  const { ecosystem, type, source, id, version, format } = match.groups!;
  return {
    ecosystem,
    type,
    source,
    model: Number(id),
    version: Number(version),
    format,
  };
}

const typeUrnMap: Partial<Record<ModelType, string>> = {
  [ModelType.AestheticGradient]: 'ag',
  [ModelType.Checkpoint]: 'checkpoint',
  [ModelType.Hypernetwork]: 'hypernet',
  [ModelType.TextualInversion]: 'embedding',
  [ModelType.MotionModule]: 'motion',
  [ModelType.Upscaler]: 'upscaler',
  [ModelType.VAE]: 'vae',
  [ModelType.LORA]: 'lora',
  [ModelType.DoRA]: 'dora',
  [ModelType.LoCon]: 'lycoris',
  [ModelType.Controlnet]: 'controlnet',
};

export function stringifyAIR({
  baseModel,
  type,
  modelId,
  id,
  source = 'civitai',
}: {
  baseModel: BaseModel | string;
  type: ModelType;
  modelId: number;
  id?: number;
  source?: string;
}) {
  const ecosystem = (
    Object.entries(baseModelSets).find(([, value]) =>
      value.includes(baseModel as BaseModel)
    )?.[0] ?? 'multi'
  ).toLowerCase();
  const urnType = typeUrnMap[type] ?? 'unknown';
  if (!urnType) return null;

  return `urn:air:${ecosystem}:${urnType}:${source}:${modelId}${id ? `@${id}` : ''}`;
}

export function toBase64(str: string) {
  return Buffer.from(str).toString('base64');
}

export function safeDecodeURIComponent(str: string) {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}
