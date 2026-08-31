export const ENTITY_CHANGE_TRACKING_FLAG = 'entity-change-tracking';

// Single source of truth for which fields the entity-change audit log watches,
// per entity type. Adding an entity = add an entry here + call diffEntityChanges
// from its mutation path — no ClickHouse DDL changes needed.
// Dotted names (e.g. 'hash.SHA256') are literal field keys; JSON-object fields
// (paidAccess, monetization) are expanded to dotted leaf paths by the
// diff helper.
export const watchedEntityFields = {
  Model: [
    'name',
    'description',
    'nsfw',
    'poi',
    'minor',
    'sfwOnly',
    'availability',
    'mode',
    'lockedProperties',
    'allowNoCredit',
    'allowCommercialUse',
    'allowDerivatives',
    'allowDifferentLicense',
  ],
  ModelVersion: [
    'description',
    'status',
    'baseModel',
    'paidAccess',
    'monetization',
    'usageControl',
    'flags',
    'trainedWords',
    'licensingFee',
    // Decides who is paid per image and by whom: a derivative inherits its root's fee, charged to the
    // derivative's users and settled to the ROOT's owner. It was writable with no trail at all until
    // CU 868kwf2fd — 160 versions carried a value nobody could account for, and the one that reached
    // support had been charging the reporter twice per image for a month.
    'licensingSourceVersionId',
  ],
  ModelFile: ['hash.SHA256'],
} as const;

export type WatchedEntityType = keyof typeof watchedEntityFields;

export type EntityChangeActorRole = 'owner' | 'moderator' | 'system';

// One row per changed field. userId/ip/userAgent are stamped by the Tracker;
// `via` (provenance) is merged in by Tracker.entityChanges.
export type EntityChangeRow = {
  entityType: WatchedEntityType;
  entityId: number;
  ownerId: number;
  field: string;
  oldValue: string;
  newValue: string;
  truncated: 0 | 1;
  actorRole: EntityChangeActorRole;
  reason: string;
  batchId: string;
};
