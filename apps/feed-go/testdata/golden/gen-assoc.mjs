// Generates the golden fixtures in model-assoc/ (see README.md, "model-assoc").
//
//   TZ=UTC node --import tsx apps/feed-go/testdata/golden/gen-assoc.mjs
//
// Everything here is SYNTHETIC: invented ids, names and hosts.
//
// What a fixture's EXPECTED answer is comes from the Node code path, never from feed-go:
//   - the pure steps are the REAL Node functions, imported from the repo through tsx: the input
//     schemas (getAssociatedResourcesSchema, getAllModelsSchema), the tRPC level middleware
//     (stripBlockedForNonModerator, clampRequestBrowsingLevels), the browsing-settings addons, the
//     .com face, the version flags, isMatureRestricted, isModelWithheld, canViewPoiModel, the
//     per-viewer image filter, heldGalleryLevel, the minor content rule, metric privacy,
//     isGenerationEligible, isBaseModelGenerationDisabled, the gate rule schema and its
//     applicableRulesFor / canGenerateBlockedTargets / isTargetedBy, fromJson, superjson;
//   - the orchestration that reads the database and the caches is transcribed below from
//     getAssociatedResourcesCardDataHandler and associatedCardImages
//     (src/server/controllers/model.controller.ts), modelVisibleToViewer (model.router.ts),
//     getModelsRaw, holdShowcaseImages and getShowcaseHeldLevels (src/server/services/model.service.ts),
//     getImagesForModelVersion (src/server/services/image.service.ts, its WHERE clauses evaluated over
//     the world's image rows), resolveCanGenerateForVersions and getResourceCanGenerate
//     (src/server/services/generation/generation.service.ts), getSponsoredModel
//     (promotion.service.ts) and the hidden-user caches (user-preferences.service.ts).
// The page query and the image query are external systems here: the fixture records the rows each
// returned and the values Node bound for them (`binds`), which the Go harness requires feed-go to
// bind. The SQL itself is pinned by internal/modelfeed's unit tests.
process.env.TZ = 'UTC';

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importDep } from './pack.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = process.cwd();
if (!existsSync(join(REPO, 'src/server/controllers/model.controller.ts')))
  throw new Error('run from the repo root');
const superjson = (await importDep('superjson')).default;
async function repo(path) {
  const m = await import(join(REPO, path));
  return { ...(m.default ?? {}), ...m };
}
const schemas = await repo('src/server/schema/model.schema.ts');
const levelMw = await repo('src/server/utils/browsing-level.ts');
const { resolveBrowsingSettingsAddons } = await repo(
  'src/shared/constants/browsing-settings-addons.ts'
);
const face = await repo('src/shared/utils/model-sfw-face.ts');
const { toPublicApiVersionFlags, isGenerationDisabled } = await repo(
  'packages/civitai-shared/src/model-version-flags.constants.ts'
);
const { isMatureRestricted } = await repo('src/shared/constants/basemodel.constants.ts');
const { isBaseModelGenerationDisabled } = await repo(
  'packages/civitai-shared/src/basemodel.constants.ts'
);
const { isGenerationEligible } = await repo(
  'packages/civitai-shared/src/generation-eligibility.ts'
);
const { isModelWithheld } = await repo('src/shared/utils/model-withhold.ts');
const { canViewPoiModel } = await repo('src/server/utils/poi-model-visibility.ts');
const { filterImagesForViewer } = await repo('src/server/utils/model-getall-images.ts');
const levels = await repo('src/shared/constants/browsingLevel.constants.ts');
const { isMinorContentRestricted } = await repo(
  'packages/civitai-shared/src/minor-content-gate.ts'
);
const privacy = await repo('src/server/utils/model-metric-privacy.ts');
const gates = await repo('src/shared/generation/gates.ts');
const { fromJson } = await repo('src/utils/json-helpers.ts');
const { fluxUltraAir, ponyV7Air } = await repo('src/shared/constants/generation.constants.ts');
const { Flags } = await repo('src/shared/utils/flags.ts');

const explicitCoveredIds = [fluxUltraAir, ponyV7Air].map((air) => Number(air.split('@')[1]));
const NOW = new Date('2026-06-15T12:00:00.000Z');
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const day = (d) => new Date(Date.UTC(2026, 5, d, 10, 0, 0));

// ---------------------------------------------------------------------------------------------
// The synthetic world
// ---------------------------------------------------------------------------------------------
const USERS = {
  1001: { username: 'artist_one', image: uuid(901), deletedAt: null },
  1002: { username: 'artist_two', image: null, deletedAt: null },
  1003: { username: 'viewer_three', image: null, deletedAt: null },
};
const VIEWERS = {
  anon: null,
  viewer: { id: 1003, username: 'viewer_three', isModerator: false },
  owner1001: { id: 1001, username: 'artist_one', isModerator: false },
  owner1002: { id: 1002, username: 'artist_two', isModerator: false },
  mod: { id: 1004, username: 'mod_four', isModerator: true },
};

const ver = (id, baseModel, extra = {}) => ({
  id,
  name: `v${id}`,
  baseModel,
  status: 'Published',
  availability: 'Public',
  nsfwLevel: 1,
  flags: 0,
  covered: true,
  coveredNext: true,
  ...extra,
});
const model = (id, userId, extra = {}) => ({
  id,
  name: `Model ${id}`,
  sfwName: null,
  coverImageId: null,
  sfwCoverImageId: null,
  type: 'Checkpoint',
  minor: false,
  sfwOnly: false,
  poi: false,
  nsfw: false,
  nsfwLevel: 1,
  status: 'Published',
  createdAt: day(1),
  lastVersionAt: day(2),
  publishedAt: day(2),
  locked: false,
  meta: null,
  mode: null,
  availability: 'Public',
  userId,
  rank: {
    downloadCount: 10,
    thumbsUpCount: 20,
    thumbsDownCount: 1,
    commentCount: 2,
    collectedCount: 3,
    tippedAmountCount: 4,
  },
  tagIds: [],
  hashes: [],
  versions: [],
  ...extra,
});
const MODELS = [
  model(5001, 1001, {
    hashes: ['ABC123'],
    tagIds: [11],
    versions: [ver(6001, 'SDXL 1.0', { flags: 32 })],
    rank: {
      downloadCount: 50,
      thumbsUpCount: 90,
      thumbsDownCount: 0,
      commentCount: 1,
      collectedCount: 7,
      tippedAmountCount: 0,
    },
  }),
  model(5002, 1002, {
    type: 'LORA',
    nsfwLevel: 5,
    versions: [ver(6002, 'Pony', { nsfwLevel: 5 })],
  }),
  model(5003, 1001, {
    type: 'TextualInversion',
    versions: [ver(6003, 'SDXL 1.0', { availability: 'Private' })],
  }),
  model(5005, 1001, { status: 'Unpublished', versions: [ver(6005, 'SDXL 1.0')] }),
  model(5006, 1002, {
    minor: true,
    nsfwLevel: 5,
    versions: [ver(6006, 'SDXL 1.0', { nsfwLevel: 5 })],
  }),
  model(5007, 1002, { mode: 'TakenDown', versions: [ver(6007, 'SDXL 1.0')] }),
  model(5008, 1001, { type: 'Wildcards', versions: [ver(6008, 'SDXL 1.0')] }),
  model(5009, 1001, {
    nsfw: true,
    nsfwLevel: 28,
    meta: { metricVisibility: { downloads: 'hide' } },
    versions: [ver(6009, 'Pony', { nsfwLevel: 28, covered: false, coveredNext: false })],
  }),
  model(5010, 1001, {
    sfwOnly: true,
    nsfwLevel: 5,
    versions: [ver(6010, 'SDXL 1.0', { nsfwLevel: 5 })],
  }),
  model(5011, 1002, { poi: true, versions: [ver(6011, 'SDXL 1.0')] }),
  model(5012, 1001, {
    sfwName: 'Safe Twelve',
    sfwCoverImageId: 8120,
    nsfwLevel: 5,
    nsfw: true,
    versions: [ver(6012, 'SDXL 1.0', { nsfwLevel: 5, description: 'red' })],
  }),
];
// Image rows (the columns getImagesForModelVersion selects, plus what its WHERE reads).
const img = (id, userId, versionId, nsfwLevel, extra = {}) => ({
  id,
  userId,
  name: null,
  url: uuid(id),
  nsfwLevel,
  width: 512,
  height: 768,
  hash: `h${id}`,
  type: 'image',
  metadata: { width: 512, height: 768 },
  minor: false,
  poi: false,
  modelVersionId: versionId,
  availability: 'Public',
  hasMeta: true,
  hasPositivePrompt: true,
  onSite: false,
  remixOfId: null,
  // WHERE inputs (not selected)
  postId: id,
  index: 0,
  published: true,
  tosViolation: false,
  needsReview: null,
  acceptableMinor: false,
  blockedFor: null,
  ingestion: 'Scanned',
  modelRestricted: false,
  postUserId: userId,
  tags: [],
  ...extra,
});
const IMAGES = [
  img(8001, 1001, 6001, 1),
  img(8020, 1002, 6002, 4, { postId: 1 }), // R first in post order
  img(8021, 1002, 6002, 1, { postId: 2, tags: [77] }),
  img(8003, 1001, 6003, 1),
  img(8005, 1001, 6005, 1),
  img(8060, 1002, 6006, 4, { postId: 1, minor: true }), // the minor content rule restricts it
  img(8061, 1002, 6006, 1, { postId: 2, minor: true }),
  img(8007, 1002, 6007, 1),
  img(8008, 1001, 6008, 1),
  img(8009, 1001, 6009, 8, { remixOfId: 31 }),
  img(8100, 1001, 6010, 4, { postId: 1 }),
  img(8101, 1001, 6010, 1, { postId: 2 }),
  img(8011, 1002, 6011, 1, { poi: true }),
  img(8120, 1001, 6012, 1),
  img(8200, 1003, 6001, 1, { postId: 0 }), // another user's post: never a showcase image
];
const GALLERY = { 5010: { sfwHeld: false }, 5006: { sfwHeld: false } };

// ---------------------------------------------------------------------------------------------
// The mirror
// ---------------------------------------------------------------------------------------------

function pageQuery(world, input, viewer) {
  const isMod = !!viewer?.isModerator;
  const userId = viewer?.id;
  const rows = world.models.filter((m) => {
    if (!input.ids.includes(m.id)) return false;
    if (m.mode === 'Archived') return false;
    if (!isMod && m.mode === 'TakenDown' && !(userId && m.userId === userId)) return false;
    if (input.disablePoi && m.poi && m.userId !== userId) return false;
    if (input.disableMinor && m.minor && m.userId !== userId) return false;
    if (
      input.excludedTagIds?.length &&
      m.tagIds.some((t) => input.excludedTagIds.includes(t)) &&
      m.userId !== userId
    )
      return false;
    if (m.status !== 'Published') return false;
    if (!isMod && m.availability === 'Private') return false;
    if ((m.nsfwLevel & input.browsingLevel) === 0) return false;
    return true;
  });
  // Highest Rated: thumbsUpCount DESC, downloadCount DESC, modelId.
  rows.sort(
    (a, b) =>
      b.rank.thumbsUpCount - a.rank.thumbsUpCount ||
      b.rank.downloadCount - a.rank.downloadCount ||
      a.id - b.id
  );
  return rows.slice(0, 101);
}

function imageQuery(world, { modelVersionIds, excludedTagIds, user, browsingLevel }) {
  const userId = user?.id;
  const isModerator = !!user?.isModerator;
  let level = browsingLevel;
  if (level) level = levels.onlySelectableLevels(level);
  level = level || levels.allBrowsingLevelsFlag;
  const out = [];
  for (const versionId of modelVersionIds) {
    const owner = world.models.find((m) => m.versions.some((v) => v.id === versionId))?.userId;
    const hit = world.images
      .filter((i) => i.modelVersionId === versionId)
      .filter((i) => i.postUserId === owner)
      .filter((i) => i.published && !i.tosViolation)
      .filter((i) =>
        excludedTagIds?.length
          ? (i.nsfwLevel !== 0 && !i.tags.some((t) => excludedTagIds.includes(t))) ||
            (userId && i.userId === userId)
          : true
      )
      .filter((i) => isModerator || i.blockedFor == null || (userId && i.userId === userId))
      .filter((i) => i.needsReview == null && !i.acceptableMinor && (i.nsfwLevel & level) !== 0)
      .filter((i) => i.ingestion === 'Scanned')
      .filter(
        (i) =>
          isModerator ||
          !isMinorContentRestricted({ minor: i.minor, nsfwLevel: i.nsfwLevel }) ||
          (userId && i.userId === userId)
      )
      .filter(
        (i) =>
          (i.nsfwLevel & levels.nsfwBrowsingLevelsFlag) === 0 ||
          !i.modelRestricted ||
          (userId > 0 && i.userId === userId)
      )
      .sort((a, b) => a.postId - b.postId || a.index - b.index || a.id - b.id)
      .slice(0, 1);
    out.push(...hit);
  }
  return out.sort((a, b) => a.postId - b.postId || a.index - b.index || a.id - b.id);
}

const SELECTED = [
  'id',
  'userId',
  'name',
  'url',
  'nsfwLevel',
  'width',
  'height',
  'hash',
  'type',
  'metadata',
  'minor',
  'poi',
  'modelVersionId',
  'availability',
  'hasMeta',
  'hasPositivePrompt',
  'onSite',
  'remixOfId',
];
const selected = (i) => Object.fromEntries(SELECTED.map((k) => [k, i[k]]));

function getModelsRaw(world, input, user) {
  // enforceBlockedBrowsingTagsForModels: no tag filter; the addons onto the input (in place).
  const lvl =
    levels.onlySelectableLevels(input.browsingLevel || levels.publicBrowsingLevelsFlag) ||
    levels.publicBrowsingLevelsFlag;
  const resolved = resolveBrowsingSettingsAddons(world.addons, lvl, {
    isModerator: user?.isModerator,
  });
  input.disablePoi = input.disablePoi || resolved.disablePoi;
  input.disableMinor = input.disableMinor || resolved.disableMinor;
  if (resolved.excludedTagIds.length)
    input.excludedTagIds = [
      ...new Set([...(input.excludedTagIds ?? []), ...resolved.excludedTagIds]),
    ];
  const rows = pageQuery(world, input, user);
  const showSfwFace = face.showsSfwFace(input.browsingLevel);
  const items = [];
  for (const m of rows) {
    const { rank, meta, tagIds, hashes, versions, ...rawModel0 } = m;
    const rawModel = { ...rawModel0, earlyAccessDeadline: null, hasActivePaidAccess: false };
    const mdl = {
      ...face.resolveModelFace(rawModel, showSfwFace),
      hasSfwFace: face.hasCompleteSfwFace(rawModel),
    };
    const publicVersions = versions.map((v) => ({ ...v, flags: toPublicApiVersionFlags(v.flags) }));
    let mvs =
      showSfwFace && rawModel.sfwName != null
        ? publicVersions.map((v) => ({ ...v, description: '' }))
        : publicVersions;
    mvs = mvs.filter((v) => v.status === 'Published');
    mvs = mvs.filter(
      (v) =>
        !(
          (v.nsfwLevel & levels.nsfwBrowsingLevelsFlag) !== 0 &&
          isMatureRestricted(v.baseModel, 'models')
        )
    );
    const allBaseModels = [...new Set(mvs.map((v) => v.baseModel))];
    if (!mvs.length) continue;
    mvs = mvs.slice(0, 1);
    if (input.excludedTagIds?.length && tagIds.some((t) => input.excludedTagIds.includes(t)))
      continue;
    items.push({
      ...mdl,
      rank: Object.fromEntries(Object.entries(rank).map(([k, v]) => [`${k}AllTime`, v])),
      modelVersions: mvs,
      baseModels: allBaseModels,
      hashes,
      tagsOnModels: tagIds.map((tagId) => ({ tagId })),
      user: {
        id: m.userId,
        username: USERS[m.userId]?.username ?? null,
        deletedAt: USERS[m.userId]?.deletedAt ?? null,
        image: USERS[m.userId]?.image ?? null,
        profilePicture: null,
        cosmetics: [],
      },
      cosmetic: null,
      eventDecoration: null,
      metricPrivacy: privacy.pickMetaMetricPrivacy(meta),
    });
  }
  return { items, rows };
}

function holdShowcaseImages(world, images, models) {
  const levelOf = new Map();
  for (const m of models) {
    if (!m.minor && !m.sfwOnly) continue;
    const g = world.gallery[m.id];
    if (g === undefined) throw new Error(`fixture: gallery settings for ${m.id} missing`);
    levelOf.set(
      m.id,
      g?.sfwHeld
        ? g.level
        : levels.heldGalleryLevel(undefined, { minor: m.minor, sfwOnly: m.sfwOnly })
    );
  }
  return images.filter((i) => {
    const m = models.find((x) => x.modelVersions.some((v) => v.id === i.modelVersionId));
    const level = levelOf.get(m.id);
    return level === undefined || Flags.intersects(level, i.nsfwLevel);
  });
}

function handler(world, spec) {
  const viewer = VIEWERS[spec.viewer];
  // What Node bound so far: a fallback after the page query carries it, so the harness can answer
  // the same queries before it reaches the fallback.
  let binds = null;
  const fallback = (reason) => ({ fallback: reason, binds });
  // publicProcedure: applyDomainFeature on the raw input, then the schema.
  const raw = structuredClone(spec.input);
  levelMw.stripBlockedForNonModerator(raw, viewer?.isModerator);
  if (spec.cap) levelMw.clampRequestBrowsingLevels(raw, spec.cap);
  const parsed = schemas.getAssociatedResourcesSchema.safeParse(raw);
  if (!parsed.success) return fallback('input-invalid');
  const { fromId, type, ...userPreferences } = parsed.data;
  // associationSourceVisible
  if (
    fromId &&
    !viewer?.isModerator &&
    world.source &&
    !canViewPoiModel(world.source.poi, world.source.userId, viewer)
  )
    return fallback('model-assoc-source-hidden');
  const resourcesIds = world.associations.map(([toModelId, toArticleId]) =>
    toModelId
      ? { id: toModelId, resourceType: 'model' }
      : { id: toArticleId, resourceType: 'article' }
  );
  if (type === 'Suggested' && world.promotions > 0) return fallback('model-assoc-sponsored');
  if (!resourcesIds.length) return { result: [], binds: null };
  if (resourcesIds.some((r) => r.resourceType === 'article'))
    return fallback('model-assoc-articles');
  const modelResources = resourcesIds.map((r) => r.id);
  const { cursor, ...modelInput } = schemas.getAllModelsSchema.parse({
    ...userPreferences,
    ids: modelResources,
    period: 'AllTime',
  });
  const { items: models, rows } = getModelsRaw(world, modelInput, viewer);
  binds = {
    pageIds: [...new Set(modelResources)],
    pageLevel: modelInput.browsingLevel,
    rows: rows.map((r) => r.id),
  };
  const modelVersionIds = models.flatMap((m) => m.modelVersions).map((v) => v.id);
  const images = modelVersionIds.length
    ? imageQuery(world, {
        modelVersionIds,
        excludedTagIds: modelInput.excludedTagIds,
        user: viewer,
        browsingLevel: modelInput.browsingLevel,
      })
    : [];
  binds.imageVersionIds = modelVersionIds;
  binds.imageRows = images.map((i) => i.id);
  // associatedCardImages (exempt: a session)
  let shown = images.map(selected);
  if (!viewer?.isModerator) {
    const own = new Set(
      models
        .filter((m) => viewer && m.user.id === viewer.id)
        .flatMap((m) => m.modelVersions.map((v) => v.id))
    );
    const held = holdShowcaseImages(world, shown, models);
    shown = shown.filter((i) => own.has(i.modelVersionId) || held.includes(i));
  }
  shown = filterImagesForViewer(shown, {
    browsingLevel: levels.allBrowsingLevelsFlag,
    disablePoi: modelInput.disablePoi,
    disableMinor: modelInput.disableMinor,
    viewer: viewer ?? undefined,
  });
  // metric privacy
  const isMod = !!viewer?.isModerator;
  const ownerSettings = new Map(
    Object.entries(world.privacyDefaults).map(([k, v]) => [Number(k), v])
  );
  const membership = new Map();
  for (const m of models) {
    const ownerId = m.user.id;
    if (isMod || ownerId === viewer?.id) continue;
    const defHidden = privacy.getUserMetricPrivacyDefaults(ownerSettings.get(ownerId));
    if (
      privacy.anyMetricHidden(privacy.getMetaMetricPrivacy(m.metricPrivacy)) ||
      privacy.anyMetricHidden(defHidden)
    )
      membership.set(ownerId, world.memberships.includes(ownerId));
  }
  // resolveCanGenerateForVersions
  const rules = world.gateRules.migrated
    ? world.gateRules.entries
        .map((e) => gates.gateRuleSchema.safeParse(fromJson(e)))
        .filter((r) => r.success)
        .map((r) => r.data)
    : null;
  const canGenerateOf = (m) => {
    const v = m.modelVersions[0];
    if (m.type === 'Wildcards') return 'wildcards';
    const covered = (world.coverageNext ? v.coveredNext : v.covered) ?? false;
    const coveredLive = v.covered ?? false;
    const isOwned = !!viewer?.id && viewer.id === m.user.id;
    const coveredR =
      (covered || explicitCoveredIds.includes(v.id)) && !isGenerationDisabled(v.flags);
    const validStatus =
      ['Draft', 'Training', 'Published'].includes(v.status) || (v.status === 'Scheduled' && isMod);
    const isPrivate = v.availability === 'Private' || ['Draft', 'Training'].includes(v.status);
    let can = !!(coveredR && validStatus && (!isPrivate || isOwned || isMod));
    if (isBaseModelGenerationDisabled(v.baseModel)) can = false;
    // `getResourceCanGenerate(...) && isGenerationEligible(...)`: the gate rules only turn a true
    // false, so taking eligibility first changes no answer; it is what feed-go reads the rules for.
    can =
      can &&
      isGenerationEligible({
        covered,
        coveredLive,
        baseModel: v.baseModel,
        modelType: m.type,
        flags: v.flags,
      });
    if (can) {
      if (!rules) return 'unmigrated';
      const subject = { id: v.id, baseModel: v.baseModel };
      const hasTestingAccess = isMod ? true : viewer?.id ? null : false;
      // feed-go's fallback: a hidden testers rule (testing access is a per-user Flipt answer there)
      // that names this version, by id or through its base model's ecosystem.
      const testers = rules.filter(
        (r) => r.availableTo === 'testers' && r.presentation === 'hidden'
      );
      if (
        hasTestingAccess === null &&
        testers.some((r) =>
          gates.isTargetedBy(subject, {
            ecosystems: new Set(r.ecosystems),
            versionIds: new Set(r.modelVersionIds),
          })
        )
      )
        return 'testers';
      const applicable = gates.applicableRulesFor(rules, {
        isModerator: isMod,
        isMember: true,
        hasTestingAccess: !!hasTestingAccess,
      });
      const hiddenTargets = gates.canGenerateBlockedTargets(gates.toGateRuleViews(applicable));
      if (gates.isTargetedBy(subject, hiddenTargets)) can = false;
    }
    return can;
  };
  const completeModels = models
    .map(({ hashes, modelVersions, rank, tagsOnModels, metricPrivacy, ...m }) => {
      const [version] = modelVersions;
      const versionImages = shown.filter((i) => i.modelVersionId === version.id);
      if (!versionImages.length) return null;
      const isOwner = isMod || m.user.id === viewer?.id;
      const hiddenMetrics = privacy.resolveModelHiddenMetrics({
        modelMeta: metricPrivacy,
        userSettings: ownerSettings.get(m.user.id),
        isOwnerOrModerator: isOwner,
        hasValidMembership: membership.get(m.user.id) ?? false,
      });
      return {
        ...m,
        tags: tagsOnModels.map(({ tagId }) => tagId),
        hashes: hashes.map((h) => h.toLowerCase()),
        hiddenMetrics,
        rank: {
          downloadCount: hiddenMetrics.downloads ? null : rank?.downloadCountAllTime ?? 0,
          thumbsUpCount: rank?.thumbsUpCountAllTime ?? 0,
          thumbsDownCount: rank?.thumbsDownCountAllTime ?? 0,
          commentCount: rank?.commentCountAllTime ?? 0,
          collectedCount: rank?.collectedCountAllTime ?? 0,
          tippedAmountCount: hiddenMetrics.buzz ? null : rank?.tippedAmountCountAllTime ?? 0,
        },
        images: !isModelWithheld(m) ? versionImages : [],
        canGenerate: { modelVersions, type: m.type, user: m.user },
        version,
      };
    })
    .filter(Boolean);
  if (world.hiddenPrefs === null) return fallback('model-assoc-hidden-prefs-miss');
  const excludedUserIds = [...new Set(world.hiddenPrefs)];
  const result = [];
  for (const { id } of resourcesIds) {
    const m = completeModels.find((x) => x.id === id);
    if (!m) continue;
    if (excludedUserIds.includes(m.user.id)) continue;
    result.push(m);
  }
  for (const m of result) {
    const can = canGenerateOf(m.canGenerate);
    if (can === 'wildcards') return fallback('model-assoc-wildcards');
    if (can === 'testers') return fallback('gate-rules-testers');
    if (can === 'unmigrated') return fallback('gate-rules-unmigrated');
  }
  return {
    result: result.map((m) => {
      const { canGenerate, ...rest } = m;
      const out = {
        resourceType: 'model',
        ...rest,
        canGenerate: canGenerateOf(canGenerate),
        sponsored: false,
      };
      // key order as the handler builds it: canGenerate before version
      const { version, sponsored, ...head } = out;
      return { ...head, version, sponsored };
    }),
    binds,
  };
}

// ---------------------------------------------------------------------------------------------
// The specs
// ---------------------------------------------------------------------------------------------
const baseWorld = () => ({
  source: { poi: false, userId: 1001 },
  associations: [
    [5001, null],
    [5002, null],
    [5004, null],
    [5005, null],
    [5009, null],
    [5003, null],
    [5001, null],
  ],
  promotions: 0,
  models: MODELS,
  images: IMAGES,
  gallery: GALLERY,
  addons: [],
  privacyDefaults: {},
  memberships: [1001],
  hiddenPrefs: [],
  coverageNext: true,
  gateRules: {
    migrated: true,
    entries: [
      JSON.stringify({
        id: 'r1',
        name: 'mods only',
        availableTo: 'moderators',
        presentation: 'hidden',
        modelVersionIds: [6002],
      }),
      JSON.stringify({
        id: 'r2',
        availableTo: 'nobody',
        presentation: 'disabled',
        modelVersionIds: [6001],
      }),
      '{not json',
    ],
  },
});
const input = (extra = {}) => ({ fromId: 9001, type: 'Suggested', ...extra });
const GATE = (rules) => ({ migrated: true, entries: rules.map((r) => JSON.stringify(r)) });
const specs = [
  { name: 'signed-out-capped-to-pg', viewer: 'anon', cap: 1, input: input({ browsingLevel: 31 }) },
  { name: 'signed-out-level-absent', viewer: 'anon', cap: 1, input: input() },
  { name: 'signed-in-every-level', viewer: 'viewer', cap: 0, input: input({ browsingLevel: 31 }) },
  { name: 'signed-in-level-absent-uncapped', viewer: 'viewer', cap: 0, input: input() },
  { name: 'signed-in-sfw-domain', viewer: 'viewer', cap: 3, input: input({ browsingLevel: 31 }) },
  {
    name: 'signed-in-hides-a-creator',
    viewer: 'viewer',
    cap: 0,
    input: input({ browsingLevel: 31 }),
    world: { hiddenPrefs: [1002, 1002] },
  },
  {
    name: 'owner-sees-private-and-minor',
    viewer: 'owner1002',
    cap: 0,
    input: input({ browsingLevel: 31 }),
    world: {
      associations: [
        [5006, null],
        [5007, null],
        [5011, null],
        [5002, null],
      ],
    },
  },
  {
    name: 'stranger-minor-and-taken-down',
    viewer: 'viewer',
    cap: 0,
    input: input({ browsingLevel: 31 }),
    world: {
      associations: [
        [5006, null],
        [5007, null],
        [5011, null],
        [5002, null],
      ],
    },
  },
  {
    name: 'owner-private-version-generates',
    viewer: 'owner1001',
    cap: 0,
    input: input({ browsingLevel: 31 }),
  },
  {
    name: 'moderator-blocked-bit-kept',
    viewer: 'mod',
    cap: 0,
    input: input({ browsingLevel: 63 }),
    world: {
      associations: [
        [5002, null],
        [5007, null],
        [5006, null],
        [5010, null],
      ],
    },
  },
  {
    name: 'sfw-only-model-held',
    viewer: 'viewer',
    cap: 0,
    input: input({ browsingLevel: 31 }),
    world: {
      associations: [
        [5010, null],
        [5001, null],
      ],
    },
  },
  {
    name: 'sfw-only-model-held-setting',
    viewer: 'viewer',
    cap: 0,
    input: input({ browsingLevel: 31 }),
    world: {
      associations: [
        [5010, null],
        [5001, null],
      ],
      gallery: { ...GALLERY, 5010: { sfwHeld: true, level: 4 } },
    },
  },
  {
    name: 'com-face-at-sfw-level',
    viewer: 'anon',
    cap: 1,
    input: input({ browsingLevel: 1 }),
    world: {
      associations: [
        [5012, null],
        [5001, null],
      ],
    },
  },
  {
    name: 'addons-disable-poi-and-tags',
    viewer: 'anon',
    cap: 1,
    input: input({ browsingLevel: 1 }),
    world: {
      associations: [
        [5011, null],
        [5002, null],
        [5001, null],
      ],
      addons: [{ type: 'some', nsfwLevels: [1], disablePoi: true, excludedTagIds: [77] }],
    },
  },
  {
    name: 'metric-privacy-member',
    viewer: 'viewer',
    cap: 0,
    input: input({ browsingLevel: 31 }),
    world: {
      associations: [
        [5009, null],
        [5001, null],
      ],
      privacyDefaults: { 1001: { hideModelBuzz: true } },
    },
  },
  {
    name: 'coverage-flag-off',
    viewer: 'viewer',
    cap: 0,
    input: input({ browsingLevel: 31 }),
    world: {
      coverageNext: false,
      models: MODELS.map((m) =>
        m.id === 5001 ? { ...m, versions: [ver(6001, 'SDXL 1.0', { coveredNext: false })] } : m
      ),
    },
  },
  {
    name: 'no-associations',
    viewer: 'anon',
    cap: 1,
    input: input({ browsingLevel: 1 }),
    world: { associations: [] },
  },
  {
    name: 'source-poi-owner-sees',
    viewer: 'owner1001',
    cap: 0,
    input: input({ browsingLevel: 31 }),
    world: { source: { poi: true, userId: 1001 }, associations: [[5001, null]] },
  },
  // Fallbacks.
  {
    name: 'fallback-source-poi',
    viewer: 'anon',
    cap: 1,
    input: input({ browsingLevel: 1 }),
    world: { source: { poi: true, userId: 1001 } },
  },
  {
    name: 'fallback-articles',
    viewer: 'anon',
    cap: 1,
    input: input({ browsingLevel: 1 }),
    world: {
      associations: [
        [5001, null],
        [null, 70],
      ],
    },
  },
  {
    name: 'fallback-sponsored',
    viewer: 'anon',
    cap: 1,
    input: input({ browsingLevel: 1 }),
    world: { promotions: 1 },
    promotions: 'unknown',
  },
  {
    name: 'fallback-wildcards',
    viewer: 'anon',
    cap: 1,
    input: input({ browsingLevel: 1 }),
    world: { associations: [[5008, null]] },
  },
  {
    name: 'fallback-hidden-prefs-miss',
    viewer: 'viewer',
    cap: 0,
    input: input({ browsingLevel: 31 }),
    world: { hiddenPrefs: null },
  },
  {
    name: 'fallback-gate-testers',
    viewer: 'viewer',
    cap: 0,
    input: input({ browsingLevel: 31 }),
    world: {
      gateRules: {
        migrated: true,
        entries: [
          JSON.stringify({
            id: 't',
            availableTo: 'testers',
            presentation: 'hidden',
            modelVersionIds: [6001],
          }),
        ],
      },
    },
  },
  // The ecosystem gate: a hidden rule's ecosystem target reaches a version through its base model's
  // own ecosystem key (isTargetedBy), never a parent's.
  {
    name: 'gate-ecosystem-hidden',
    viewer: 'viewer',
    cap: 0,
    input: input({ browsingLevel: 31 }),
    world: {
      gateRules: GATE([
        { id: 'e', availableTo: 'nobody', presentation: 'hidden', ecosystems: ['SDXL'] },
      ]),
    },
  },
  {
    name: 'gate-ecosystem-child-only',
    viewer: 'viewer',
    cap: 0,
    input: input({ browsingLevel: 31 }),
    world: {
      gateRules: GATE([
        { id: 'e', availableTo: 'nobody', presentation: 'hidden', ecosystems: ['Pony'] },
      ]),
    },
  },
  {
    name: 'gate-ecosystem-moderator-exempt',
    viewer: 'mod',
    cap: 0,
    input: input({ browsingLevel: 31 }),
    world: {
      gateRules: GATE([
        {
          id: 'e',
          availableTo: 'moderators',
          presentation: 'hidden',
          ecosystems: ['SDXL', 'Pony'],
        },
      ]),
    },
  },
  {
    name: 'gate-ecosystem-disabled-keeps',
    viewer: 'viewer',
    cap: 0,
    input: input({ browsingLevel: 31 }),
    world: {
      gateRules: GATE([
        { id: 'e', availableTo: 'nobody', presentation: 'disabled', ecosystems: ['SDXL', 'Pony'] },
        { id: 'x', availableTo: 'nobody', presentation: 'experimental', ecosystems: ['SDXL'] },
      ]),
    },
  },
  {
    // A base model the tables do not hold, and a deprecated (disabled) one, next to an SDXL one, every
    // ecosystem they could be in hidden.
    name: 'gate-ecosystem-unknown-and-deprecated',
    viewer: 'viewer',
    cap: 0,
    input: input({ browsingLevel: 31 }),
    world: {
      associations: [
        [5013, null],
        [5014, null],
        [5001, null],
      ],
      models: [
        ...MODELS,
        model(5013, 1001, { versions: [ver(6013, 'Not A Base Model')] }),
        model(5014, 1002, { versions: [ver(6014, 'SD 3')] }),
      ],
      images: [...IMAGES, img(8130, 1001, 6013, 1), img(8140, 1002, 6014, 1)],
      gateRules: GATE([
        { id: 'e', availableTo: 'nobody', presentation: 'hidden', ecosystems: ['SD3', 'Other'] },
      ]),
    },
  },
  {
    name: 'gate-ecosystem-testers-signed-out',
    viewer: 'anon',
    cap: 1,
    input: input({ browsingLevel: 1 }),
    world: {
      gateRules: GATE([
        { id: 't', availableTo: 'testers', presentation: 'hidden', ecosystems: ['SDXL'] },
      ]),
    },
  },
  {
    name: 'gate-ecosystem-testers-other-ecosystem',
    viewer: 'viewer',
    cap: 0,
    input: input({ browsingLevel: 31 }),
    world: {
      gateRules: GATE([
        { id: 't', availableTo: 'testers', presentation: 'hidden', ecosystems: ['Flux1'] },
      ]),
    },
  },
  {
    name: 'fallback-gate-testers-ecosystem',
    viewer: 'viewer',
    cap: 0,
    input: input({ browsingLevel: 31 }),
    world: {
      gateRules: GATE([
        { id: 't', availableTo: 'testers', presentation: 'hidden', ecosystems: ['SDXL'] },
      ]),
    },
  },
  {
    name: 'fallback-gate-unmigrated',
    viewer: 'viewer',
    cap: 0,
    input: input({ browsingLevel: 31 }),
    world: { gateRules: { migrated: false, entries: [] } },
  },
];

const OUT = join(HERE, 'model-assoc');
if (existsSync(OUT)) for (const f of readdirSync(OUT)) rmSync(join(OUT, f));
mkdirSync(OUT, { recursive: true });
const rowOf = (m) => {
  const { tagIds, hashes, versions, ...row } = m;
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    lastVersionAt: row.lastVersionAt.toISOString(),
    publishedAt: row.publishedAt.toISOString(),
  };
};
for (const spec of specs) {
  const world = { ...baseWorld(), ...(spec.world ?? {}) };
  const out = handler(world, spec);
  const byId = new Map(world.models.map((m) => [m.id, m]));
  const fixture = {
    name: spec.name,
    request: {
      input: JSON.stringify(superjson.serialize(spec.input)),
      viewer: VIEWERS[spec.viewer],
      cap: spec.cap,
    },
    config: { coverageNext: world.coverageNext, promotions: spec.promotions ?? 'off' },
    world: {
      source: world.source,
      associations: world.associations,
      promotions: world.promotions,
      addons: world.addons,
      gallery: world.gallery,
      privacyDefaults: world.privacyDefaults,
      memberships: world.memberships,
      hiddenPrefs: world.hiddenPrefs,
      gateRules: world.gateRules,
      users: USERS,
      modelRows: out.binds ? out.binds.rows.map((id) => rowOf(byId.get(id))) : [],
      modelData: Object.fromEntries(
        world.models.map((m) => [
          m.id,
          { hashes: m.hashes, tagIds: m.tagIds, versions: m.versions },
        ])
      ),
      imageRows: out.binds?.imageRows
        ? out.binds.imageRows.map((id) => {
            const i = world.images.find((x) => x.id === id);
            return SELECTED.map((k) =>
              k === 'metadata' || k === 'remixOfId'
                ? i[k] == null
                  ? null
                  : JSON.stringify(i[k])
                : i[k]
            );
          })
        : [],
    },
    binds: out.binds
      ? {
          pageIds: out.binds.pageIds,
          pageLevel: out.binds.pageLevel,
          imageVersionIds: out.binds.imageVersionIds,
        }
      : null,
    expect: out.fallback
      ? { fallback: out.fallback }
      : { envelope: superjson.serialize(out.result) },
  };
  writeFileSync(join(OUT, `${spec.name}.json`), JSON.stringify(fixture, null, 2) + '\n');
}
console.log(`wrote ${specs.length} fixtures to ${OUT}`);
