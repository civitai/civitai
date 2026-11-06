/**
 * The model pages `bot-lean-models-parity.test.ts` renders both ways: what the page's resolver
 * reads for each (`getDefaultModelVersion`, and the `model.getById`, `user.getCreator`,
 * `model.getCollectionShowcase`, `common.getEntityAccess`, `image.getInfinite` and
 * `hiddenPreferences.getHidden` prefetches), the URL and request headers, and which path the lean
 * hook must take: `lean`, a fallback reason, or `none` (the request never reaches the hook — a
 * redirect or 404 from the resolver, or a request that is not a bot-cache render at all).
 *
 * Built on `model-page-fixture.ts`, the shape the model page's other server-render tests use, so a
 * change to `model.getById` that breaks those breaks these the same way.
 */
import type { BotLeanFallback } from '~/server/bot-cache/bot-lean';
import * as F from '~/tests/pages/models/model-page-fixture';

type Row = Record<string, unknown>;

export type ModelFixture = {
  label: string;
  url: string;
  /** `undefined`: `model.getById` answers NOT_FOUND. */
  model?: Row;
  /** `null`: `getDefaultModelVersion` finds none. */
  defaultVersion: Row | null;
  images: Row[];
  creator: Row | null;
  showcase: Row | null;
  headers?: Record<string, string>;
  expect: 'lean' | 'none' | BotLeanFallback;
};

export const SLUG = 'lantern-glow-portrait-lora';
const PATH = `/models/${F.MODEL_ID}/${SLUG}`;
// Fixed, not `Date.now()`: the parity test pins the clock.
const FUTURE = new Date(Date.UTC(2026, 11, 24));

const clone = <T>(value: T): T => structuredClone(value);
const baseModel = () => clone(F.MODEL) as unknown as Row & { modelVersions: Row[] };
const withModel = (overrides: Row) => ({ ...baseModel(), ...overrides });

const defaultVersion = (id: number = F.VERSION_IDS[0], model: Row = {}) => ({
  id,
  status: 'Published',
  publishedAt: new Date(Date.UTC(2026, 8, 1)),
  availability: 'Public',
  trainingStatus: null,
  model: {
    id: F.MODEL_ID,
    userId: F.CREATOR_ID,
    availability: 'Public',
    status: 'Published',
    ...model,
  },
});

const common = {
  images: clone(F.IMAGES) as unknown as Row[],
  creator: clone(F.CREATOR) as unknown as Row,
  showcase: null,
};

const earlyAccessModel = () => {
  const model = baseModel();
  model.modelVersions = model.modelVersions.map((v) => ({
    ...v,
    earlyAccessDeadline: FUTURE,
    earlyAccessConfig: { timeframe: 7, chargeForDownload: true, downloadPrice: 500 },
  }));
  return model;
};

export const FIXTURES: ModelFixture[] = [
  {
    label: 'a published LoRA, three versions, tags, creator and carousel',
    url: PATH,
    model: baseModel(),
    defaultVersion: defaultVersion(),
    ...common,
    expect: 'lean',
  },
  {
    label: 'another version selected by ?modelVersionId',
    url: `${PATH}?modelVersionId=${F.VERSION_IDS[1]}`,
    model: baseModel(),
    defaultVersion: defaultVersion(F.VERSION_IDS[1]),
    ...common,
    expect: 'lean',
  },
  {
    label: 'no description, one version, no carousel images',
    url: PATH,
    model: (() => {
      const model = withModel({ description: null, tagsOnModels: [] });
      model.modelVersions = model.modelVersions.slice(0, 1).map((v) => ({
        ...v,
        description: null,
        trainedWords: [],
      }));
      return model;
    })(),
    defaultVersion: defaultVersion(),
    ...common,
    images: [],
    expect: 'lean',
  },
  {
    label: 'mature model with a complete .com face (shown on green)',
    url: PATH,
    model: withModel({ nsfw: true, hasSfwFace: true, nsfwLevel: 1 | 4 }),
    defaultVersion: defaultVersion(),
    ...common,
    expect: 'lean',
  },
  {
    label: 'bare id: canonical slug redirect (308)',
    url: `/models/${F.MODEL_ID}`,
    model: baseModel(),
    defaultVersion: defaultVersion(),
    ...common,
    expect: 'none',
  },
  {
    label: 'wrong slug with a query: redirect (307)',
    url: `/models/${F.MODEL_ID}/old-name?modelVersionId=${F.VERSION_IDS[1]}`,
    model: baseModel(),
    defaultVersion: defaultVersion(F.VERSION_IDS[1]),
    ...common,
    expect: 'none',
  },
  {
    label: 'model.getById NOT_FOUND (404)',
    url: PATH,
    model: undefined,
    defaultVersion: defaultVersion(),
    ...common,
    expect: 'none',
  },
  {
    label: 'no default version for the anonymous viewer (404)',
    url: PATH,
    model: baseModel(),
    defaultVersion: null,
    ...common,
    expect: 'none',
  },
  {
    label: 'deleted by its owner',
    url: PATH,
    model: withModel({ status: 'Deleted', deletedAt: new Date(Date.UTC(2026, 9, 2)) }),
    defaultVersion: defaultVersion(),
    ...common,
    expect: 'not-found',
  },
  {
    label: 'unpublished',
    url: PATH,
    model: withModel({ status: 'Unpublished' }),
    defaultVersion: defaultVersion(),
    ...common,
    expect: 'not-found',
  },
  {
    label: 'every version in early access',
    url: PATH,
    model: earlyAccessModel(),
    defaultVersion: defaultVersion(),
    ...common,
    expect: 'unsupported',
  },
  {
    label: 'PG-13 for the anonymous crawler viewer (login gate)',
    url: PATH,
    model: withModel({ nsfwLevel: 2 }),
    defaultVersion: defaultVersion(),
    ...common,
    expect: 'gated',
  },
  {
    label: 'mature model without a .com face on green (moved-to-red gate)',
    url: PATH,
    model: withModel({ nsfw: true, hasSfwFace: false, nsfwLevel: 4 }),
    defaultVersion: defaultVersion(),
    ...common,
    expect: 'gated',
  },
  {
    label: 'a crawler from a blocked region: not a bot-cache render',
    url: PATH,
    model: baseModel(),
    defaultVersion: defaultVersion(),
    ...common,
    headers: { 'cf-ipcountry': 'GB' },
    expect: 'none',
  },
];
