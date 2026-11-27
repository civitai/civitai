/**
 * What the Knights app's database role may touch in production, as the harness grants it (`createQueueDb`). Read back
 * from production's catalog (`has_table_privilege` and friends), minus the tables the role must reach only through
 * "KnightsImageGate": a query that needs anything else fails here as it would in production. A new table the app reads
 * needs a grant in production first, then a line here.
 */
export const KNIGHTS_APP_ROLE = 'knights_app';

type Privilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

/** Tables and views, by name in "public" or as "schema.name". */
export const KNIGHTS_APP_GRANTS: Readonly<Record<string, readonly Privilege[]>> = {
  Cosmetic: ['SELECT'],
  CosmeticShopItem: ['SELECT'],
  CustomerSubscription: ['SELECT'],
  Feedback: ['SELECT', 'INSERT'],
  Image: ['SELECT'],
  ImageReport: ['SELECT'],
  KnightsAcolyteLevelGold: ['SELECT', 'INSERT'],
  KnightsApprenticeAnswer: ['SELECT', 'INSERT', 'UPDATE'],
  KnightsGoldConversion: ['SELECT', 'INSERT', 'UPDATE'],
  KnightsHarvestCursor: ['SELECT', 'INSERT', 'UPDATE'],
  KnightsImagePull: ['SELECT', 'INSERT'],
  KnightsInquisitorReview: ['SELECT', 'INSERT', 'UPDATE'],
  KnightsInquisitorVote: ['SELECT', 'INSERT'],
  KnightsLegacyPlayerDay: ['SELECT'],
  KnightsNotificationSend: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  KnightsPlayer: ['SELECT', 'INSERT', 'UPDATE'],
  KnightsPlayerDay: ['SELECT', 'INSERT', 'UPDATE'],
  KnightsQuestion: ['SELECT', 'INSERT'],
  KnightsQuestionReport: ['SELECT', 'INSERT'],
  KnightsQueueItem: ['SELECT', 'INSERT', 'UPDATE'],
  KnightsRatingGuideItem: ['SELECT'],
  KnightsReferenceImage: ['SELECT', 'INSERT', 'UPDATE'],
  KnightsShopItem: ['SELECT'],
  KnightsShopPurchase: ['SELECT', 'INSERT', 'UPDATE'],
  KnightsUnsure: ['SELECT', 'INSERT'],
  KnightsVote: ['SELECT', 'INSERT', 'UPDATE'],
  KnightsYesNoReference: ['SELECT', 'UPDATE'],
  ModActivity: ['SELECT'],
  NewOrderPlayer: ['SELECT', 'INSERT', 'UPDATE'],
  NewOrderSmite: ['SELECT', 'INSERT', 'UPDATE'],
  Post: ['SELECT'],
  Product: ['SELECT'],
  Report: ['SELECT'],
  Tag: ['SELECT'],
  TagsOnImageDetails: ['SELECT'],
  TagsOnImageNew: ['SELECT'],
  User: ['SELECT'],
  UserCosmetic: ['SELECT', 'INSERT'],
  UserEngagement: ['SELECT'],
  UserNotificationSettings: ['SELECT'],
  'label_store.label': ['SELECT'],
  'label_store.record_failure': ['SELECT'],
  'label_store.rule': ['SELECT', 'INSERT'],
};

/** Column-level UPDATE grants, on top of `KNIGHTS_APP_GRANTS`: the role may set only these columns. */
export const KNIGHTS_APP_COLUMN_UPDATES: Readonly<Record<string, readonly string[]>> = {
  KnightsImagePull: ['reportId'],
};

/** Schemas besides "public" the role may use. */
export const KNIGHTS_APP_SCHEMAS: readonly string[] = ['label_store'];

/** Functions the role may execute where PUBLIC may not, as "schema.name" (every overload). */
export const KNIGHTS_APP_FUNCTIONS: readonly string[] = [
  'label_store.note_failure',
  'label_store.person_hash',
  'label_store.record_label',
  'label_store.text_hash',
];

/** Sequences the role draws ids from when it inserts. */
export const KNIGHTS_APP_SEQUENCES: readonly string[] = [
  'Feedback_id_seq',
  'KnightsApprenticeAnswer_id_seq',
  'KnightsGoldConversion_id_seq',
  'KnightsImagePull_id_seq',
  'KnightsInquisitorReview_id_seq',
  'KnightsQuestionReport_id_seq',
  'KnightsQueueItem_id_seq',
  'KnightsReferenceImage_id_seq',
  'KnightsShopPurchase_id_seq',
  'KnightsUnsure_id_seq',
  'NewOrderSmite_id_seq',
];
