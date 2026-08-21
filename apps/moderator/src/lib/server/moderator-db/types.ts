import type { ColumnType } from 'kysely';
export type Generated<T> = T extends ColumnType<infer S, infer I, infer U>
  ? ColumnType<S, I | undefined, U>
  : ColumnType<T, T | undefined, T>;
export type Timestamp = ColumnType<Date, Date | string, Date | string>;

import type {
  action_enum_7d6c4187,
  package_enum_a2d24e36,
  status_enum_120e0323,
  status_enum_b63b87f7,
  status_enum_da2164f6,
  task_enum_0648e184,
  type_enum_cf5f15bb,
} from './enums';

export type AutomatedWeeklyStats = {
  id: Generated<number>;
  runDate: Generated<Timestamp | null>;
  TotalReviews: Generated<number | null>;
  ReviewsWeek: Generated<number | null>;
  TotalModels: Generated<number | null>;
  NewModelsWeek: Generated<number | null>;
  TotalComments: Generated<number | null>;
  CommentsWeek: Generated<number | null>;
  TotalPosts: Generated<number | null>;
  CreatorsWeek: Generated<number | null>;
  TotalCreators: Generated<number | null>;
  TotalImages: Generated<number | null>;
  ImagesWeek: Generated<number | null>;
  TotalImgReactions: Generated<number | null>;
  ImgReactionsWeek: Generated<number | null>;
  TotalCollectionItems: Generated<number | null>;
  CollectionItemsWeek: Generated<number | null>;
  TotalCollections: Generated<number | null>;
  CollectionsWeek: Generated<number | null>;
  TotalArticles: Generated<number | null>;
  ArticlesWeek: Generated<number | null>;
  TotalUsers: Generated<number | null>;
  UsersWeek: Generated<number | null>;
  TBDownloadedWeek: Generated<number | null>;
  PostsWeek: Generated<number | null>;
  TotalDownloadCountWeek: Generated<number | null>;
  PersonalizedHomepages: Generated<number | null>;
};
export type BuzzCodes = {
  id: Generated<number>;
  createdBy: string;
  code: string | null;
};
export type CivBot_Review = {
  requires_escalation: Generated<boolean | null>;
  mod_status: Generated<string | null>;
  id: Generated<number>;
  mod_reviewed_at: Timestamp | null;
  mod_notes: string | null;
  user_conversation_uuid: string | null;
  issue_category: string | null;
  user_session_uuid: string | null;
  raised_clickup: Generated<boolean | null>;
  clickup_task_link: string | null;
};
export type CivBot_SourcesList = {
  id: Generated<number>;
  created_at: string | null;
  file_name: string | null;
  file_size: Generated<number | null>;
  meta_json: string | null;
  modified_at: string | null;
  status: string | null;
  title: string | null;
  tokens: Generated<number | null>;
  type: string | null;
  uuid: string | null;
};
export type CivBot_TemporaryContext = {
  id: Generated<number>;
  context_name: string | null;
  context_question: string | null;
  context_response: string | null;
  active: Generated<boolean | null>;
};
export type CivBot_UserConversations = {
  created_at: string | null;
  modified_at: string | null;
  id: Generated<number>;
  finish_reason: string | null;
  cite_data_json: string | null;
  query: string | null;
  uuid: string | null;
  meta_json: string | null;
  response: string | null;
  usersession_uuid: string | null;
};
export type CivBot_UserSessions = {
  uuid: string | null;
  created_at: string | null;
  modified_at: string | null;
  id: Generated<number>;
  user_id: string | null;
  username: string | null;
  email: string | null;
};
export type CollectionContestWinners = {
  id: Generated<number>;
  imageId: Generated<number>;
  username: string | null;
  collectionId: Generated<number>;
  tagId: Generated<number | null>;
  tagName: string | null;
  createdAt: Generated<Timestamp | null>;
  userId: Generated<number>;
  collectionName: string | null;
  url: string;
};
export type Community_DailyTaskLog = {
  id: Generated<number>;
  date_updated: Generated<Timestamp | null>;
  missive: Generated<string | null>;
  featurebase: Generated<string | null>;
  civbot: Generated<string | null>;
  dms_discord: Generated<string | null>;
  dms_onsite: Generated<string | null>;
  reddit: Generated<string | null>;
  metabase: Generated<string | null>;
  model_train_status: Generated<string | null>;
  site_showcase_form: Generated<string | null>;
  site_press_form: Generated<string | null>;
  site_advertiser_form: Generated<string | null>;
  site_appeals_form: Generated<string | null>;
  site_DMCA_form: Generated<string | null>;
  site_likeness_form: Generated<string | null>;
  site_CSAM_submissions: Generated<string | null>;
  date: Generated<Timestamp | null>;
  missive_clearedby: string | null;
  featurebase_clearedby: string | null;
  civbot_clearedby: string | null;
  dms_discord_clearedby: string | null;
  dms_onsite_clearedby: string | null;
  reddit_clearedby: string | null;
  metabase_clearedby: string | null;
  model_train_status_clearedby: string | null;
  site_showcase_form_clearedby: string | null;
  site_press_form_clearedby: string | null;
  site_advertiser_form_clearedby: string | null;
  site_appeals_form_clearedby: string | null;
  site_dmca_form_clearedby: string | null;
  site_likeness_form_clearedby: string | null;
  site_csam_submissions_clearedby: string | null;
  missive_note: string | null;
  featurebase_note: string | null;
  civbot_note: string | null;
  dms_discord_note: string | null;
  dms_onsite_note: string | null;
  reddit_note: string | null;
  metabase_note: string | null;
  model_train_status_note: string | null;
  site_showcase_form_note: string | null;
  site_press_form_note: string | null;
  site_advertiser_form_note: string | null;
  site_appeals_form_note: string | null;
  site_DMCA_form_note: string | null;
  site_likeness_form_note: string | null;
  site_CSAM_submissions_note: string | null;
  curation: Generated<string | null>;
  curation_note: string | null;
  curation_clearedby: string | null;
};
export type communityDevForm = {
  toolExperience: Generated<unknown | null>;
  openSourceExperience: string | null;
  motivation: string | null;
  toImprove: string | null;
  featureWishlist: string | null;
  familiar: string | null;
  username: string | null;
  github: string | null;
  discord: string | null;
  devExperience: string | null;
  status: Generated<status_enum_120e0323 | null>;
  preferredRole: string | null;
  availablity: string | null;
  communityExperience: string | null;
  notes: string | null;
  createdAt: Generated<Timestamp | null>;
  id: Generated<number>;
};
export type eval_result = {
  id: Generated<string>;
  run_id: string;
  sample_id: string;
  score: number | null;
  predicted: boolean | null;
  expected: boolean;
  bucket: string | null;
  reason: string | null;
  error: string | null;
};
export type eval_run = {
  id: Generated<string>;
  label: string;
  policy_id: string | null;
  policy_label: string;
  threshold: number;
  batch: string | null;
  status: Generated<string>;
  total: Generated<number>;
  scored: Generated<number>;
  errors: Generated<number>;
  tp: Generated<number>;
  fp: Generated<number>;
  tn: Generated<number>;
  fn: Generated<number>;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  note: string | null;
  started_at: Generated<Timestamp>;
  finished_at: Timestamp | null;
};
export type FeatureRequests = {
  id: Generated<number>;
  userId: number;
  url: string;
  createdAt: Generated<Timestamp>;
  preferedTime: Generated<Timestamp>;
  statusSetBy: string | null;
  statusSetAt: Timestamp | null;
  status: Generated<status_enum_b63b87f7 | null>;
  package: package_enum_a2d24e36 | null;
  details: string | null;
};
export type FrontPageTimers = {
  id: Generated<number>;
  nsfw: string | null;
  lastCheckedAt: Timestamp | null;
  username: string | null;
  buttonPressedTime: Generated<Timestamp | null>;
  numberOfImages: Generated<number | null>;
};
export type FrontPageTimers_catchup = {
  id: Generated<number>;
  nsfw: string | null;
  lastCheckedAt: Generated<Timestamp | null>;
  buttonPressedTime: Generated<Timestamp | null>;
  username: string | null;
  numberOfImages: Generated<number | null>;
};
export type HivePromptDefinitions = {
  id: Generated<number>;
  name: string;
  createdAt: Generated<Timestamp>;
  createdBy: string;
};
export type HivePromptVersions = {
  id: Generated<number>;
  promptId: number;
  prompt: string | null;
  createdAt: Generated<Timestamp>;
  createdBy: string;
  versionTag: string | null;
  changeNote: string | null;
};
export type human_judgement = {
  id: Generated<string>;
  sample_id: string;
  label: string;
  reviewed_judgement_id: string | null;
  agreed: boolean | null;
  verdict: boolean;
  note: string | null;
  reviewer_id: number;
  duration_ms: number | null;
  created_at: Generated<Timestamp>;
  excluded_reason: string | null;
};
export type label_def = {
  name: string;
  description: string;
  status: Generated<string>;
  created_at: Generated<Timestamp>;
};
export type label_policy = {
  id: Generated<string>;
  label: string;
  version: number;
  policy: string;
  threshold: number;
  action: Generated<string>;
  note: string | null;
  created_at: Generated<Timestamp>;
};
export type label_term = {
  id: Generated<string>;
  label: string;
  term: string;
  kind: string;
  note: string | null;
  created_at: Generated<Timestamp>;
};
export type machine_judgement = {
  id: Generated<string>;
  sample_id: string;
  label: string;
  source: string;
  model: string | null;
  score: number | null;
  verdict: boolean;
  reason: string | null;
  highlights: unknown | null;
  policy_id: string | null;
  created_at: Generated<Timestamp>;
};
export type mobile_app_sample_data = {
  id: string;
  name: string | null;
  email: string | null;
  sales: string | null;
  image: string | null;
};
export type ModBot_Review = {
  id: Generated<number>;
  mod_status: Generated<string | null>;
  mod_notes: string | null;
  mod_reviewed_at: Timestamp | null;
  requires_escalation: Generated<boolean | null>;
  user_conversation_uuid: string | null;
};
export type ModBot_SourcesList = {
  file_name: string | null;
  modified_at: string | null;
  meta_json: string | null;
  id: Generated<number>;
  title: string | null;
  tokens: Generated<number | null>;
  file_size: Generated<number | null>;
  status: string | null;
  created_at: string | null;
  type: string | null;
  uuid: string | null;
};
export type ModBot_UserConversations = {
  id: Generated<number>;
  uuid: string | null;
  created_at: string | null;
  modified_at: string | null;
  finish_reason: string | null;
  cite_data_json: string | null;
  meta_json: string | null;
  query: string | null;
  response: string | null;
  usersession_uuid: string | null;
};
export type ModBot_UserSessions = {
  id: Generated<number>;
  created_at: string | null;
  modified_at: string | null;
  uuid: string | null;
};
export type ModelNotes = {
  id: Generated<number>;
  modelId: Generated<number>;
  createdBy: string;
  createdAt: Generated<Timestamp>;
  content: string;
};
export type ModerationImageHelp = {
  id: Generated<number>;
  createdBy: string;
  imageIds: Generated<unknown>;
  type: type_enum_cf5f15bb | null;
  createdAt: Generated<Timestamp>;
  isHandled: Generated<boolean | null>;
  handledBy: Generated<string>;
  handledAt: Timestamp | null;
};
export type ModerationQueueMetrics = {
  id: Generated<number>;
  Minor: Generated<number | null>;
  PoI: Generated<number | null>;
  ImageReport: Generated<number | null>;
  TagReview: Generated<number | null>;
  Model: Generated<number | null>;
  Comment: Generated<number | null>;
  CommentV2: Generated<number | null>;
  Review: Generated<number | null>;
  Article: Generated<number | null>;
  Post: Generated<number | null>;
  User: Generated<number | null>;
  Collection: Generated<number | null>;
  Bounty: Generated<number | null>;
  BountyEntry: Generated<number | null>;
  Chat: Generated<number | null>;
  ModelReview: Generated<number | null>;
  FrontPageSafe: Generated<number | null>;
  Mutes: Generated<number | null>;
  createdAt: Generated<Timestamp>;
};
export type ModerationSHA = {
  id: Generated<number>;
  SHA256: string | null;
  ModelVersionId: Generated<number | null>;
};
export type ModerationWorkloadMetrics = {
  id: Generated<number>;
  createdAt: Generated<Timestamp>;
  FrontPageSfw: Generated<string>;
  MinorPoI: Generated<string>;
  TagReview: Generated<string>;
  Mutes: Generated<string>;
  Collection: Generated<string>;
  Image: Generated<string>;
  Comment: Generated<string>;
  User: Generated<string>;
  Post: Generated<string>;
  Article: Generated<string>;
  Review: Generated<string>;
  Model: Generated<string>;
  BountyEntry: Generated<string>;
  Bounty: Generated<string>;
  Chat: Generated<string>;
};
export type ModNotes = {
  id: Generated<number>;
  createdBy: string | null;
  createdAt: Generated<Timestamp | null>;
  updatedAt: Generated<Timestamp | null>;
  userId: string | null;
  userName: string | null;
  modelId: string | null;
  imageId: string | null;
  commentId: string | null;
  modNotes: string | null;
};
export type Mods_TaskTimers = {
  id: Generated<number>;
  lastUpdateBy: string | null;
  lastUpdate: Generated<Timestamp | null>;
  task: task_enum_0648e184 | null;
};
export type products = {
  id: string;
  name: string | null;
  quantity: number | null;
  unit_price_cents: number | null;
  created_at: Timestamp | null;
  updated_at: Timestamp | null;
  image_url: string | null;
  part_number: string | null;
};
export type RatingChanges = {
  id: Generated<number>;
  imageId: Generated<number | null>;
  createdAt: Generated<Timestamp | null>;
  updatedBy: string | null;
  rating: Generated<number | null>;
  originalRating: Generated<number>;
};
export type ReToolActions = {
  id: Generated<number>;
  Event: Generated<Timestamp>;
  User: string | null;
  App: string | null;
  ActionType: string | null;
};
export type sample = {
  id: Generated<string>;
  prompt_hash: string | null;
  source: Generated<string>;
  batch: string;
  user_id: number | null;
  positive_prompt: string;
  negative_prompt: string | null;
  live_scores: unknown | null;
  prompt_created_at: Timestamp | null;
  created_at: Generated<Timestamp>;
};
export type sample_orders = {
  id: Generated<number>;
  name: string | null;
  email: string | null;
  product_id: string | null;
  quantity: number | null;
  order_requested: Timestamp | null;
  order_completed: Timestamp | null;
  received_payment: boolean | null;
};
export type sample_users = {
  id: Generated<number>;
  name: string | null;
  email: string | null;
  signup_date: Timestamp | null;
  role: string | null;
  enabled: boolean | null;
};
export type Temp_AllRefundsGreater500 = {
  id: Generated<number>;
  LeftAccountId: string | null;
  TransactionDate: string | null;
  TransactionId: string | null;
  Amount: string | null;
  RightAccountId: string | null;
};
export type Temp_FailedLoRATrain = {
  id: Generated<number>;
  username: string | null;
  userId: string | null;
  modelId: string | null;
  start_time: string | null;
  end_time: string | null;
};
export type test_import = {
  id: Generated<number>;
  task_name: string | null;
  status: status_enum_b63b87f7 | null;
  package_drop_down: string | null;
  model_url: string | null;
  due_date: string | null;
  date_created: string | null;
};
export type testForm = {
  id: Generated<number>;
};
export type TimedMutes = {
  id: Generated<number>;
  userId: string | null;
  muteStart: Generated<Timestamp | null>;
  muteEnd: Generated<Timestamp | null>;
  createdBy: string | null;
  createdAt: Generated<Timestamp | null>;
  muteReason: string | null;
  isMuted: Generated<boolean | null>;
};
export type TrainingDataReview = {
  id: Generated<number>;
  modelId: Generated<number | null>;
  modelVersionId: Generated<number | null>;
  reviewedBy: string | null;
  reviewedAt: Generated<Timestamp | null>;
  createdAt: Generated<Timestamp | null>;
  action: action_enum_7d6c4187 | null;
};
export type User = {
  id: Generated<number>;
  deservedMute: Generated<boolean | null>;
  spamWhitelist: Generated<boolean | null>;
  userId: number;
};
export type UserNotes = {
  id: Generated<number>;
  userId: Generated<number | null>;
  notes: string | null;
  lastUpdate: Generated<Timestamp | null>;
  lastUpdateBy: string | null;
  spamWhitelist: Generated<boolean | null>;
  deservedMute: Generated<boolean | null>;
};
export type users = {
  id: Generated<number>;
  FirstName: string | null;
  LastName: string | null;
  CivitUserId: Generated<number | null>;
  Username: string | null;
};
export type UserStrikes = {
  id: Generated<number>;
  userId: Generated<number>;
  createdAt: Generated<Timestamp>;
  createdBy: string;
  reason: string;
};
export type VigilanteNameChangeTest = {
  id: Generated<number>;
  userid: Generated<number | null>;
  username: string | null;
  count: Generated<number | null>;
};
export type DB = {
  AutomatedWeeklyStats: AutomatedWeeklyStats;
  BuzzCodes: BuzzCodes;
  CivBot_Review: CivBot_Review;
  CivBot_SourcesList: CivBot_SourcesList;
  CivBot_TemporaryContext: CivBot_TemporaryContext;
  CivBot_UserConversations: CivBot_UserConversations;
  CivBot_UserSessions: CivBot_UserSessions;
  CollectionContestWinners: CollectionContestWinners;
  Community_DailyTaskLog: Community_DailyTaskLog;
  communityDevForm: communityDevForm;
  eval_result: eval_result;
  eval_run: eval_run;
  FeatureRequests: FeatureRequests;
  FrontPageTimers: FrontPageTimers;
  FrontPageTimers_catchup: FrontPageTimers_catchup;
  HivePromptDefinitions: HivePromptDefinitions;
  HivePromptVersions: HivePromptVersions;
  human_judgement: human_judgement;
  label_def: label_def;
  label_policy: label_policy;
  label_term: label_term;
  machine_judgement: machine_judgement;
  mobile_app_sample_data: mobile_app_sample_data;
  ModBot_Review: ModBot_Review;
  ModBot_SourcesList: ModBot_SourcesList;
  ModBot_UserConversations: ModBot_UserConversations;
  ModBot_UserSessions: ModBot_UserSessions;
  ModelNotes: ModelNotes;
  ModerationImageHelp: ModerationImageHelp;
  ModerationQueueMetrics: ModerationQueueMetrics;
  ModerationSHA: ModerationSHA;
  ModerationWorkloadMetrics: ModerationWorkloadMetrics;
  ModNotes: ModNotes;
  Mods_TaskTimers: Mods_TaskTimers;
  products: products;
  RatingChanges: RatingChanges;
  ReToolActions: ReToolActions;
  sample: sample;
  sample_orders: sample_orders;
  sample_users: sample_users;
  Temp_AllRefundsGreater500: Temp_AllRefundsGreater500;
  Temp_FailedLoRATrain: Temp_FailedLoRATrain;
  test_import: test_import;
  testForm: testForm;
  TimedMutes: TimedMutes;
  TrainingDataReview: TrainingDataReview;
  User: User;
  UserNotes: UserNotes;
  users: users;
  UserStrikes: UserStrikes;
  VigilanteNameChangeTest: VigilanteNameChangeTest;
};
