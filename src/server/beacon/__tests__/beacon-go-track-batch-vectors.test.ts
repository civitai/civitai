/**
 * beacon-go reproduces POST /api/track/batch's search and action events with COPIES of the constants
 * the action arms import (apps/beacon-go/internal/beacon/trackbatch_arms.go). Its own test pins those
 * copies against `trackBatch` in apps/beacon-go/testdata/golden/vectors.json, which
 * apps/beacon-go/testdata/golden/gen.ts writes from the Node code. This test closes the loop: the
 * recording must equal the LIVE Node values, so a change to any of them fails here until gen.ts is
 * re-run and the Go copy follows (in the same PR, as ports/README.md asks of a ported endpoint).
 *
 * Re-generate from the repo root:
 *   pnpm exec tsx --tsconfig tsconfig.json apps/beacon-go/testdata/golden/gen.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { hashToUnit } from '~/server/clickhouse/sampled-row-buffer';
import { events } from '~/server/events';
import { eventPointsWindow } from '~/server/events/points/keys';
import {
  FEED_EVENTS_SAMPLE_RATE_FLAG,
  parseSampleRate,
} from '~/server/services/feed-events.service';
import {
  FEED_EVENT_FEEDS,
  FEED_EVENT_INDEX_MAX,
  FEED_EVENT_TYPES,
} from '~/shared/constants/feed-events.constants';
import { ACTOR_META_FREE_ACTION_TYPES } from '~/server/clickhouse/tracker';
import {
  IMPRESSION_ENTITIES_MAX,
  IMPRESSION_ENTITY_TYPES,
  IMPRESSION_SURFACES,
  PUSH_PROMPT_ACTIONS,
  PUSH_PROMPT_SURFACES,
  PUSH_PROMPT_VARIANTS,
  TRACK_BATCH_MAX,
  TRACK_FREEFORM_MAX_CHARS,
  trackActionSchema,
  trackFeedSchema,
  trackImpressionSchema,
  trackSearchSchema,
} from '~/server/schema/track.schema';
import { trackedReasons } from '~/utils/login-helpers';
import { USER_MENU_ITEM_IDS } from '~/shared/constants/user-menu.constants';
import {
  USER_MENU_GROUP_IDS,
  USER_MENU_HEADER_GROUP,
} from '~/shared/constants/user-menu-groups.constants';
import {
  EXPERIMENT_SURFACES,
  HAT_TURF_CLIENT_ACTIONS,
  HAT_TURF_EVENTS,
} from '~/shared/constants/experiments.constants';
import {
  APP_STORE_ACTIONS,
  APP_STORE_LISTING_ID_RE,
  APP_STORE_POSITION_MAX,
  APP_STORE_QUERY_LENGTH_BUCKETS,
  APP_SURFACES,
} from '~/shared/utils/app-store-telemetry';
import { listingSortSchema } from '~/server/schema/blocks/app-listing-read.schema';
import { MARKETPLACE_CATEGORIES } from '~/server/services/blocks/marketplace-categories.constants';
import {
  APP_ERROR_STAGES,
  APP_SESSION_HOSTS,
  APP_SESSION_MAX_COUNT,
  APP_SESSION_MAX_DURATION_MS,
  APP_SUBMIT_FAILURE_REASONS,
  APP_TELEMETRY_APP_BLOCK_ID_RE,
} from '~/shared/constants/app-telemetry.constants';

const vectors = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../../apps/beacon-go/testdata/golden/vectors.json'),
    'utf8'
  )
) as {
  trackBatch: Record<string, unknown>;
  trackBatchSinks: {
    hashToUnit: { in: string; out: number }[];
    parseSampleRate: { in: string; out: number }[];
    [k: string]: unknown;
  };
};

// gen.ts's JSON Schema of a zod schema, as it records it.
const jsonSchema = (s: z.ZodType) => {
  const { $schema: _, ...rest } = z.toJSONSchema(s, {
    io: 'input',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
  return rest;
};

describe('beacon-go track-batch vectors are the live Node values', () => {
  it('matches every constant the Go action arms copy', () => {
    expect(vectors.trackBatch).toEqual({
      trackBatchMax: TRACK_BATCH_MAX,
      freeformMaxChars: TRACK_FREEFORM_MAX_CHARS,
      actionTypes: trackActionSchema.options.map((o) => o.shape.type.value).sort(),
      actorMetaFree: [...ACTOR_META_FREE_ACTION_TYPES].sort(),
      enums: {
        trackedReasons: [...trackedReasons],
        userMenuItemIds: [...USER_MENU_ITEM_IDS],
        userMenuGroupIds: [...USER_MENU_GROUP_IDS],
        userMenuHeaderGroup: [USER_MENU_HEADER_GROUP],
        pushPromptActions: [...PUSH_PROMPT_ACTIONS],
        pushPromptSurfaces: [...PUSH_PROMPT_SURFACES],
        pushPromptVariants: [...PUSH_PROMPT_VARIANTS],
        experimentSurfaces: [...EXPERIMENT_SURFACES],
        hatTurfClientActions: [...HAT_TURF_CLIENT_ACTIONS],
        hatTurfEvents: [...HAT_TURF_EVENTS],
        appStoreActions: [...APP_STORE_ACTIONS],
        appStoreQueryLengthBuckets: [...APP_STORE_QUERY_LENGTH_BUCKETS],
        appSurfaces: [...APP_SURFACES],
        listingSorts: [...listingSortSchema.options],
        marketplaceCategories: [...MARKETPLACE_CATEGORIES],
        appSubmitFailureReasons: [...APP_SUBMIT_FAILURE_REASONS],
        appErrorStages: [...APP_ERROR_STAGES],
        appSessionHosts: [...APP_SESSION_HOSTS],
      },
      patterns: {
        appStoreListingId: APP_STORE_LISTING_ID_RE.source,
        appBlockId: APP_TELEMETRY_APP_BLOCK_ID_RE.source,
      },
      numbers: {
        appStorePositionMax: APP_STORE_POSITION_MAX,
        appSessionMaxDurationMs: APP_SESSION_MAX_DURATION_MS,
        appSessionMaxCount: APP_SESSION_MAX_COUNT,
      },
    });
  });

  it('records literal anchors (a positive control: the recording is the shape this test reads)', () => {
    expect(vectors.trackBatch.trackBatchMax).toBe(100);
    expect(vectors.trackBatch.actorMetaFree).toEqual([
      'AppStore_Action',
      'App_Error',
      'App_Session',
      'Experiment_Exposure',
      'HatTurf_Action',
    ]);
    // The regexes are copied by source: a flag would change what they match.
    expect(APP_STORE_LISTING_ID_RE.flags).toBe('');
    expect(APP_TELEMETRY_APP_BLOCK_ID_RE.flags).toBe('');
  });

  // The impression and feed sinks' copies (internal/beacon/trackbatch_sinks.go) and the schemas the Go
  // side pins its parsers to (TestTrackBatchSchemas). POINT_ENTITY_TYPES is pinned by behaviour in
  // src/server/events/points/__tests__/hooks.test.ts.
  it('matches every constant and schema the Go impression and feed sinks copy', () => {
    const { hashToUnit: hashes, parseSampleRate: rates, ...rest } = vectors.trackBatchSinks;
    const { pointEntityTypes: _, ...pinnedHere } = rest;
    expect(pinnedHere).toEqual({
      impressionEntityTypes: [...IMPRESSION_ENTITY_TYPES],
      impressionSurfaces: [...IMPRESSION_SURFACES],
      impressionEntitiesMax: IMPRESSION_ENTITIES_MAX,
      feedEventTypes: [...FEED_EVENT_TYPES],
      feedEventFeeds: [...FEED_EVENT_FEEDS],
      feedEventIndexMax: FEED_EVENT_INDEX_MAX,
      scoredEvents: events
        .filter((e) => e.scoring)
        .map((e) => {
          const w = eventPointsWindow({ ...e, scoring: e.scoring! });
          return { name: e.name, from: w.from.getTime(), to: w.to.getTime() };
        }),
      feedEventsSampleRateFlag: FEED_EVENTS_SAMPLE_RATE_FLAG,
      schemas: {
        search: jsonSchema(trackSearchSchema),
        action: jsonSchema(trackActionSchema),
        impression: jsonSchema(trackImpressionSchema),
        feed: jsonSchema(trackFeedSchema),
      },
    });
    expect(hashes.length).toBeGreaterThanOrEqual(8);
    for (const h of hashes) expect(hashToUnit(h.in)).toBe(h.out);
    expect(rates.length).toBeGreaterThanOrEqual(8);
    for (const r of rates) expect(parseSampleRate(r.in)).toBe(r.out);
    // Literal anchors.
    expect(hashToUnit('k1')).toBe(0.594688460463658);
    expect(vectors.trackBatchSinks.feedEventsSampleRateFlag).toBe('feed-events-sample-rate');
  });
});
