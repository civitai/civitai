// Generated for the catch-all API routes preview (hq:b_serve_api_gm8f). Do not edit by hand.
import type { NextApiHandler } from 'next';
import h0 from './application-error';
import h1 from './health';
import h2 from './live';
import h3 from './metrics';
import h4 from './og';
import h5 from './ready';
import h6 from './readyz';
import h7 from './region-status';
import h8 from './restricted';
import h9 from './test';
import h10 from './upload/index';
import h11 from './.well-known/openid-configuration';
import h12 from './admin/add-manual-assignments';
import h13 from './admin/apps-storage-backfill';
import h14 from './admin/backfill-membership-badges';
import h15 from './admin/banking-change-notice';
import h16 from './admin/cache-check';
import h17 from './admin/cancel-subscription';
import h18 from './admin/clean-up-old-notifications';
import h19 from './admin/clear-cache-by-pattern';
import h20 from './admin/create-system-account';
import h21 from './admin/creation-blocked-tags';
import h22 from './admin/creator-comp-payout';
import h23 from './admin/creator-program-payout-hold';
import h24 from './admin/creator-program-payout-review';
import h25 from './admin/creator-shop-fees';
import h26 from './admin/delete-images';
import h27 from './admin/deliver-prepaid-buzz';
import h28 from './admin/fetch-cache-by-pattern';
import h29 from './admin/grant-subscription';
import h30 from './admin/header-check';
import h31 from './admin/huggingface-import';
import h32 from './admin/klein9b-notice';
import h33 from './admin/manage-sanity-checks';
import h34 from './admin/migrate-likes-models';
import h35 from './admin/migrate-likes';
import h36 from './admin/migrate-model-metrics';
import h37 from './admin/model-file-options';
import h38 from './admin/nc-earnings-notice';
import h39 from './admin/pay-daily-challenge-users';
import h40 from './admin/permission';
import h41 from './admin/provider-download-token';
import h42 from './admin/purge-cache-tag';
import h43 from './admin/reaction-abuse';
import h44 from './admin/refresh-sessions';
import h45 from './admin/refresh-user-sessions';
import h46 from './admin/rescan-images';
import h47 from './admin/send-discount';
import h48 from './admin/system-account-api-key';
import h49 from './admin/system-account-profile';
import h50 from './admin/test';
import h51 from './admin/unlock-prepaid-tokens';
import h52 from './admin/unpublish-all-models';
import h53 from './admin/update-freshdesk-customer';
import h54 from './admin/users';
import h55 from './auth/accounts';
import h56 from './auth/authorize';
import h57 from './auth/callback';
import h58 from './auth/connect';
import h59 from './auth/freshdesk';
import h60 from './auth/impersonate';
import h61 from './auth/jwks';
import h62 from './auth/linked';
import h63 from './auth/login-popup';
import h64 from './auth/logout';
import h65 from './auth/post-login';
import h66 from './auth/session';
import h67 from './auth/switch';
import h68 from './auth/user-from-token';
import h69 from './blocks/manifest-schema';
import h70 from './generation/data';
import h71 from './generation/history/index';
import h72 from './generation/resources';
import h73 from './image/ingestion-results';
import h74 from './internal/bundle-budget';
import h75 from './internal/dev-tunnel-gate';
import h76 from './internal/essential-objects';
import h77 from './internal/freshdesk-service-tier-refresh';
import h78 from './internal/get-jobs';
import h79 from './internal/get-presigned-url';
import h80 from './internal/heap-dump';
import h81 from './internal/kono-finalize';
import h82 from './internal/longest-running-query';
import h83 from './internal/mod-gate';
import h84 from './internal/ping';
import h85 from './internal/pulse';
import h86 from './internal/redis-sys-usage';
import h87 from './internal/redis-usage';
import h88 from './internal/restore-models';
import h89 from './internal/search-index-update';
import h90 from './internal/test-model-feed-filters';
import h91 from './mod/action-report';
import h92 from './mod/adjust-tag-level';
import h93 from './mod/ban-user';
import h94 from './mod/clean-up';
import h95 from './mod/compute-tags';
import h96 from './mod/custom-challenge';
import h97 from './mod/delete-user-images';
import h98 from './mod/enable-stripe-connect';
import h99 from './mod/enable-tipalti';
import h100 from './mod/flip-phases';
import h101 from './mod/mod-rules';
import h102 from './mod/mute-user-pending-review';
import h103 from './mod/openapi.json';
import h104 from './mod/overturn-user-mute';
import h105 from './mod/queue-model-metric-update';
import h106 from './mod/reconcile-nowpayments';
import h107 from './mod/remove-all-content';
import h108 from './mod/remove-images';
import h109 from './mod/remove-placement';
import h110 from './mod/reprocess-buzz-purchases';
import h111 from './mod/reprocess-order';
import h112 from './mod/reprocess-scan';
import h113 from './mod/requeue-training-data-scans';
import h114 from './mod/reset-bank';
import h115 from './mod/reset-user-subscription-caches';
import h116 from './mod/reset-vault';
import h117 from './mod/resource-training-v2';
import h118 from './mod/restore-images';
import h119 from './mod/review-batches';
import h120 from './mod/search-query-rule-dry-run';
import h121 from './mod/send-mod-notification';
import h122 from './mod/set-image-nsfw-level';
import h123 from './mod/set-rewards-eligibility';
import h124 from './mod/tipalti-resync-payee';
import h125 from './mod/unblock-images';
import h126 from './mod/unequip-event-cosmetics';
import h127 from './mod/update-image-flag';
import h128 from './mod/update-index';
import h129 from './mod/whoami';
import h130 from './mod/withdraw-from-bank';
import h131 from './notification/getDetails';
import h132 from './notifications/email-unsubscribe';
import h133 from './orchestrator/blobRatings';
import h134 from './orchestrator/getConsumerBlobUploadUrl';
import h135 from './orchestrator/refreshBlobs';
import h136 from './push/resubscribe';
import h137 from './signal-server/get-token';
import h138 from './testing/backfill-lora-hashes';
import h139 from './testing/backfill-stale-nsfw-rollups';
import h140 from './testing/blocks';
import h141 from './testing/blue-buzz-paid-access';
import h142 from './testing/chat-completion-scan';
import h143 from './testing/daily-challenge';
import h144 from './testing/eventloop-stall';
import h145 from './testing/fee-allowance-boost';
import h146 from './testing/generator-loaded';
import h147 from './testing/gift-membership';
import h148 from './testing/model-file-scan';
import h149 from './testing/model3d-seed';
import h150 from './testing/new-order';
import h151 from './testing/orchestrator-loaded';
import h152 from './testing/redis-cluster';
import h153 from './testing/referrals';
import h154 from './testing/rewards-config';
import h155 from './testing/settings-trace';
import h156 from './testing/strikes';
import h157 from './testing/xguard-test';
import h158 from './track/batch';
import h159 from './track/block-message';
import h160 from './track/block-render';
import h161 from './training-studio/access';
import h162 from './training-studio/host';
import h163 from './training-studio/model-status';
import h164 from './upload/abort';
import h165 from './upload/complete';
import h166 from './upload/sign-part';
import h167 from './user/getHiddenPreferences';
import h168 from './user/orchestrator-key';
import h169 from './user/settings';
import h170 from './v1/announcements/index';
import h171 from './v1/apps/index';
import h172 from './v1/bugs';
import h173 from './v1/creators';
import h174 from './v1/enums';
import h175 from './v1/image-upload/index';
import h176 from './v1/me';
import h177 from './v1/tags';
import h178 from './v1/users/index';
import h179 from './webhooks/audio-scan-result';
import h180 from './webhooks/freshdesk';
import h181 from './webhooks/image-scan-result';
import h182 from './webhooks/model-file-scan-result';
import h183 from './webhooks/model-scan-result';
import h184 from './webhooks/resource-availability';
import h185 from './webhooks/resource-training';
import h186 from './webhooks/scanner-policy-result';
import h187 from './webhooks/text-moderation-result';
import h188 from './webhooks/text-scan-result';
import h189 from './webhooks/twitch';
import h190 from './webhooks/youtube-upload';
import h191 from './run/[modelVersionId]';
import h192 from './admin/temp/apply-models-index-displayed-attributes';
import h193 from './admin/temp/apply-models-index-filterable-attributes';
import h194 from './admin/temp/apply-models-index-ranking-rules';
import h195 from './admin/temp/archive-held-user-comments';
import h196 from './admin/temp/article-category-backfill';
import h197 from './admin/temp/backfill-b2-file-locations';
import h198 from './admin/temp/backfill-base-model-hot-score';
import h199 from './admin/temp/backfill-block-image-blurhash';
import h200 from './admin/temp/backfill-creator-milestones';
import h201 from './admin/temp/backfill-generation-counts';
import h202 from './admin/temp/backfill-image-meta-flags';
import h203 from './admin/temp/backfill-image-scores';
import h204 from './admin/temp/backfill-metric-agg';
import h205 from './admin/temp/backfill-model-permission-snapshots';
import h206 from './admin/temp/backfill-post-metrics';
import h207 from './admin/temp/backfill-removal-score-exemptions';
import h208 from './admin/temp/backfill-scheduled-challenge-themes';
import h209 from './admin/temp/backfill-swept-trained-models';
import h210 from './admin/temp/backfill-trained-model-permissions';
import h211 from './admin/temp/backfill-unique-generators';
import h212 from './admin/temp/backfill-user-downloads';
import h213 from './admin/temp/backfill-video-blurhash';
import h214 from './admin/temp/challenge-reconcile-backfill';
import h215 from './admin/temp/child-label-reindex';
import h216 from './admin/temp/clamp-publishedat-bumps';
import h217 from './admin/temp/cleanup-orphaned-images-search';
import h218 from './admin/temp/cleanup-poi-tag-mismatches';
import h219 from './admin/temp/convert-model-rules';
import h220 from './admin/temp/dedupe-official-files';
import h221 from './admin/temp/delete-deleted-users';
import h222 from './admin/temp/fix-cross-posted-images';
import h223 from './admin/temp/grant-banked-blessed-buzz';
import h224 from './admin/temp/membership-buzz-backfill';
import h225 from './admin/temp/merge-moss-image-base';
import h226 from './admin/temp/migrate-article-images';
import h227 from './admin/temp/migrate-challenges';
import h228 from './admin/temp/migrate-hidden-gallery-images';
import h229 from './admin/temp/migrate-nsfwLevels';
import h230 from './admin/temp/migrate-profanity-nsfw';
import h231 from './admin/temp/minor-hash-sweep';
import h232 from './admin/temp/model-text-moderation-backfill';
import h233 from './admin/temp/new-order-consensus-backfill';
import h234 from './admin/temp/perma-delete-poi-models';
import h235 from './admin/temp/prepaid-product-repoint';
import h236 from './admin/temp/queue-accelerator-models-reindex';
import h237 from './admin/temp/queue-held-cover-collections-reindex';
import h238 from './admin/temp/queue-held-showcase-models-reindex';
import h239 from './admin/temp/queue-legacy-cover-collections-reindex';
import h240 from './admin/temp/queue-paid-models-reindex';
import h241 from './admin/temp/queue-takendown-models-reindex';
import h242 from './admin/temp/reclaim-membership-buzz';
import h243 from './admin/temp/recompute-removal-scores';
import h244 from './admin/temp/recompute-self-activity';
import h245 from './admin/temp/reconcile-detected-image-resources';
import h246 from './admin/temp/remove-deprecated-base-models';
import h247 from './admin/temp/repair-post-unpublished-stamp';
import h248 from './admin/temp/reprocess-exempt-blocked-images';
import h249 from './admin/temp/republish-orphaned-drafts';
import h250 from './admin/temp/rescan-images';
import h251 from './admin/temp/rescan-judge-collection-images';
import h252 from './admin/temp/reset-training-model';
import h253 from './admin/temp/text-scan-clavata-cutover';
import h254 from './admin/temp/text-scan-rescan';
import h255 from './apps/assistant/activity';
import h256 from './apps/assistant/preview';
import h257 from './apps/assistant/run-grant';
import h258 from './apps/assistant/runner-viewer-token';
import h259 from './apps/assistant/source-save';
import h260 from './apps/assistant/token';
import h261 from './apps/dev/entry-url';
import h262 from './apps/dev/preview-errors';
import h263 from './generation/history/callback';
import h264 from './internal/app-assistant/app-activity';
import h265 from './internal/app-assistant/runner-token';
import h266 from './internal/app-assistant/sleeping-apps';
import h267 from './internal/app-assistant/source-save';
import h268 from './internal/app-assistant/wake-seed';
import h269 from './internal/notifications/render-push';
import h270 from './internal/notifications/send-email';
import h271 from './mod/apps/refund-workflows';
import h272 from './mod/apps/workflow-charges';
import h273 from './mod/audit/change-history';
import h274 from './mod/bounty-entry-file/clear-check';
import h275 from './mod/bounty-entry-file/reblock-check';
import h276 from './mod/bounty-poi/resolve-appeal';
import h277 from './mod/bounty-unpaid-award/resolve';
import h278 from './mod/collection/set-item-tag';
import h279 from './mod/comment/bulk-delete';
import h280 from './mod/comment/remove-as-tos';
import h281 from './mod/comment/restore-from-tos';
import h282 from './mod/cosmetic/assign-by-target';
import h283 from './mod/cosmetic/create';
import h284 from './mod/cosmetic/delete';
import h285 from './mod/cosmetic/holdings-removed';
import h286 from './mod/cosmetic/refund-box-purchase';
import h287 from './mod/cosmetic/unassign';
import h288 from './mod/cosmetic/update';
import h289 from './mod/creator-services/deal-file-url';
import h290 from './mod/creator-services/deal-files';
import h291 from './mod/creator-services/dispute-evidence';
import h292 from './mod/creator-services/dispute-review';
import h293 from './mod/creator-services/disputes';
import h294 from './mod/creator-services/resolve-dispute';
import h295 from './mod/csam/training-data-report';
import h296 from './mod/daily-challenge/cycle';
import h297 from './mod/feedback/ticket-bug';
import h298 from './mod/feedback/triage';
import h299 from './mod/homeblock/create';
import h300 from './mod/homeblock/delete';
import h301 from './mod/homeblock/reorder';
import h302 from './mod/homeblock/update';
import h303 from './mod/image/kono-set-nsfw-level';
import h304 from './mod/image/report-csam';
import h305 from './mod/image/set-nsfw-level';
import h306 from './mod/image/tag-vote';
import h307 from './mod/knights/enqueue';
import h308 from './mod/knights/notification-types';
import h309 from './mod/knights/reset-player';
import h310 from './mod/label-store/predictions';
import h311 from './mod/membership-gift/refund-unfulfilled';
import h312 from './mod/membership-gift/revoke-unpaid';
import h313 from './mod/messages/claim';
import h314 from './mod/messages/inbox';
import h315 from './mod/messages/release';
import h316 from './mod/messages/thread';
import h317 from './mod/minor-flag/confirm';
import h318 from './mod/minor-flag/dismiss';
import h319 from './mod/minor-flag/resolve-appeal';
import h320 from './mod/minor-flag/resolve-redetection';
import h321 from './mod/minor-flag/revert';
import h322 from './mod/minor-flag/rule';
import h323 from './mod/minor-flag/set-minor';
import h324 from './mod/model/bring-back';
import h325 from './mod/model/bump';
import h326 from './mod/model/republish';
import h327 from './mod/model/resolve-lock-review';
import h328 from './mod/model/resolve-restricted-nsfw-verdict';
import h329 from './mod/model/set-poi';
import h330 from './mod/model/set-sfw-only';
import h331 from './mod/model/take-down';
import h332 from './mod/model/unpublish';
import h333 from './mod/new-order/manage-queue';
import h334 from './mod/new-order/rate-limit-config';
import h335 from './mod/nowpayments/credit-deposit';
import h336 from './mod/nowpayments/open-deposits';
import h337 from './mod/poi-flag/confirm';
import h338 from './mod/poi-flag/dismiss';
import h339 from './mod/poi-flag/flag-match';
import h340 from './mod/poi-flag/revert';
import h341 from './mod/post-text/moderate';
import h342 from './mod/restriction/resolve';
import h343 from './mod/review/delete';
import h344 from './mod/review/set-exclude';
import h345 from './mod/scanner-policies/export-dataset';
import h346 from './mod/search/articles-update';
import h347 from './mod/search/models-update';
import h348 from './mod/storyline/lift-title-takedown';
import h349 from './mod/storyline/resolve-title-appeal';
import h350 from './mod/strike/create';
import h351 from './mod/strike/get-user-strikes';
import h352 from './mod/strike/void';
import h353 from './mod/training-data/resolve';
import h354 from './mod/user/buzz-membership-end';
import h355 from './mod/user/cancel-pending-workflows';
import h356 from './mod/user/clear-profile';
import h357 from './mod/user/creator-program-ban';
import h358 from './mod/user/creator-score-grant-revoke';
import h359 from './mod/user/creator-score-grant';
import h360 from './mod/user/delete';
import h361 from './mod/user/expire-generation-credentials';
import h362 from './mod/user/force-logout';
import h363 from './mod/user/legal-hold';
import h364 from './mod/user/membership-cancel-preview';
import h365 from './mod/user/membership-cancel';
import h366 from './mod/user/membership-code-revoke';
import h367 from './mod/user/membership-code';
import h368 from './mod/user/membership-extend-preview';
import h369 from './mod/user/membership-extend';
import h370 from './mod/user/membership-resync-preview';
import h371 from './mod/user/membership-resync';
import h372 from './mod/user/message-as-civitai';
import h373 from './mod/user/mute';
import h374 from './mod/user/personal-data-export-release';
import h375 from './mod/user/reactions';
import h376 from './mod/user/remove-reactions';
import h377 from './mod/user/toggle-moderator';
import h378 from './mod/user/unmute';
import h379 from './mod/user/update-identity';
import h380 from './v1/block-tokens/jwks';
import h381 from './v1/blocks/buzz';
import h382 from './v1/blocks/entitlements';
import h383 from './v1/blocks/gated-images';
import h384 from './v1/blocks/generation-resources';
import h385 from './v1/blocks/generation-samplers';
import h386 from './v1/blocks/me';
import h387 from './v1/blocks/models';
import h388 from './v1/blocks/resource-intent';
import h389 from './v1/blocks/tip-allowance';
import h390 from './v1/blocks/workflow-media';
import h391 from './v1/catalog/items/index';
import h392 from './v1/creator-program/join';
import h393 from './v1/creator/engagement';
import h394 from './v1/image-upload/multipart/index';
import h395 from './v1/me/limits';
import h396 from './v1/model-versions/bust-cache';
import h397 from './v1/model-versions/by-hash/index';
import h398 from './v1/model-versions/early-access';
import h399 from './v1/model-versions/gifts/index';
import h400 from './v1/models/com-face';
import h401 from './v1/partners/generate-token';
import h402 from './v1/permissions/check';
import h403 from './v1/vault/all';
import h404 from './v1/vault/check-vault';
import h405 from './v1/vault/get';
import h406 from './v1/vault/toggle-version';
import h407 from './internal/image-delivery/[id]';
import h408 from './media/ingest/[mediaId]';
import h409 from './page-data/images/[imageId]';
import h410 from './testing/email/[template]';
import h411 from './v1/apps/[slug]';
import h412 from './v1/articles/[id]';
import h413 from './v1/bugs/[id]';
import h414 from './v1/collections/[id]';
import h415 from './v1/download-links/[linkId]';
import h416 from './v1/model-versions/[id]';
import h417 from './v1/models/[id]';
import h418 from './v1/posts/[id]';
import h419 from './v1/users/[userId]';
import h420 from './webhooks/resource-training-v2/[modelVersionId]';
import h421 from './image/[entityType]/[entityId]';
import h422 from './internal/app-assistant/app-feedback/review';
import h423 from './internal/app-assistant/app-feedback/user';
import h424 from './internal/app-assistant/cover/listing';
import h425 from './internal/app-assistant/dev-tunnel/keepalive';
import h426 from './internal/app-assistant/dev-tunnel/start';
import h427 from './internal/app-assistant/dev-tunnel/stop';
import h428 from './mod/knights/shop/cosmetics';
import h429 from './mod/knights/shop/membership';
import h430 from './mod/text-scan/csam-hold/resolve';
import h431 from './mod/text-scan/model-rules-hold/resolve';
import h432 from './v1/blocks/sub-listings/mine';
import h433 from './v1/blocks/user-checkpoint/set';
import h434 from './v1/model-versions/by-hash/ids';
import h435 from './v1/model-versions/gifts/claim';
import h436 from './v1/blocks/media/[ticket]';
import h437 from './v1/model-versions/by-hash/[hash]';
import h438 from './v1/model-versions/mini/[id]';
import h439 from './v1/posts/planner/[action]';
import h440 from './generation/workflows/[workflowId]/status-update';
import h441 from './service-deals/files/[fileId]/download';
import h442 from './v1/model-files/[id]/tensor-metadata';
import h443 from './v1/model-versions/[id]/gifts/index';
import h444 from './blocks/screenshot/[appBlockId]/[file]';
import h445 from './v1/model-versions/[id]/gifts/link';
import h446 from './v1/model-versions/[id]/gifts/[giftId]';
import h447 from './v1/model-versions/[id]/gifts/batch/[batchId]';
import h448 from './v1/model-versions/[id]/gifts/[giftId]/claims';
import h449 from './v1/model-versions/[id]/gifts/batch/[batchId]/claims';
import h450 from './v1/model-versions/[id]/gifts/[giftId]/claims/[userId]';

export type ApiRoute = { segments: string[]; handler: NextApiHandler };

export const apiRoutes: ApiRoute[] = [
  { segments: ["application-error"], handler: h0 as NextApiHandler },
  { segments: ["health"], handler: h1 as NextApiHandler },
  { segments: ["live"], handler: h2 as NextApiHandler },
  { segments: ["metrics"], handler: h3 as NextApiHandler },
  { segments: ["og"], handler: h4 as NextApiHandler },
  { segments: ["ready"], handler: h5 as NextApiHandler },
  { segments: ["readyz"], handler: h6 as NextApiHandler },
  { segments: ["region-status"], handler: h7 as NextApiHandler },
  { segments: ["restricted"], handler: h8 as NextApiHandler },
  { segments: ["test"], handler: h9 as NextApiHandler },
  { segments: ["upload"], handler: h10 as NextApiHandler },
  { segments: [".well-known","openid-configuration"], handler: h11 as NextApiHandler },
  { segments: ["admin","add-manual-assignments"], handler: h12 as NextApiHandler },
  { segments: ["admin","apps-storage-backfill"], handler: h13 as NextApiHandler },
  { segments: ["admin","backfill-membership-badges"], handler: h14 as NextApiHandler },
  { segments: ["admin","banking-change-notice"], handler: h15 as NextApiHandler },
  { segments: ["admin","cache-check"], handler: h16 as NextApiHandler },
  { segments: ["admin","cancel-subscription"], handler: h17 as NextApiHandler },
  { segments: ["admin","clean-up-old-notifications"], handler: h18 as NextApiHandler },
  { segments: ["admin","clear-cache-by-pattern"], handler: h19 as NextApiHandler },
  { segments: ["admin","create-system-account"], handler: h20 as NextApiHandler },
  { segments: ["admin","creation-blocked-tags"], handler: h21 as NextApiHandler },
  { segments: ["admin","creator-comp-payout"], handler: h22 as NextApiHandler },
  { segments: ["admin","creator-program-payout-hold"], handler: h23 as NextApiHandler },
  { segments: ["admin","creator-program-payout-review"], handler: h24 as NextApiHandler },
  { segments: ["admin","creator-shop-fees"], handler: h25 as NextApiHandler },
  { segments: ["admin","delete-images"], handler: h26 as NextApiHandler },
  { segments: ["admin","deliver-prepaid-buzz"], handler: h27 as NextApiHandler },
  { segments: ["admin","fetch-cache-by-pattern"], handler: h28 as NextApiHandler },
  { segments: ["admin","grant-subscription"], handler: h29 as NextApiHandler },
  { segments: ["admin","header-check"], handler: h30 as NextApiHandler },
  { segments: ["admin","huggingface-import"], handler: h31 as NextApiHandler },
  { segments: ["admin","klein9b-notice"], handler: h32 as NextApiHandler },
  { segments: ["admin","manage-sanity-checks"], handler: h33 as NextApiHandler },
  { segments: ["admin","migrate-likes-models"], handler: h34 as NextApiHandler },
  { segments: ["admin","migrate-likes"], handler: h35 as NextApiHandler },
  { segments: ["admin","migrate-model-metrics"], handler: h36 as NextApiHandler },
  { segments: ["admin","model-file-options"], handler: h37 as NextApiHandler },
  { segments: ["admin","nc-earnings-notice"], handler: h38 as NextApiHandler },
  { segments: ["admin","pay-daily-challenge-users"], handler: h39 as NextApiHandler },
  { segments: ["admin","permission"], handler: h40 as NextApiHandler },
  { segments: ["admin","provider-download-token"], handler: h41 as NextApiHandler },
  { segments: ["admin","purge-cache-tag"], handler: h42 as NextApiHandler },
  { segments: ["admin","reaction-abuse"], handler: h43 as NextApiHandler },
  { segments: ["admin","refresh-sessions"], handler: h44 as NextApiHandler },
  { segments: ["admin","refresh-user-sessions"], handler: h45 as NextApiHandler },
  { segments: ["admin","rescan-images"], handler: h46 as NextApiHandler },
  { segments: ["admin","send-discount"], handler: h47 as NextApiHandler },
  { segments: ["admin","system-account-api-key"], handler: h48 as NextApiHandler },
  { segments: ["admin","system-account-profile"], handler: h49 as NextApiHandler },
  { segments: ["admin","test"], handler: h50 as NextApiHandler },
  { segments: ["admin","unlock-prepaid-tokens"], handler: h51 as NextApiHandler },
  { segments: ["admin","unpublish-all-models"], handler: h52 as NextApiHandler },
  { segments: ["admin","update-freshdesk-customer"], handler: h53 as NextApiHandler },
  { segments: ["admin","users"], handler: h54 as NextApiHandler },
  { segments: ["auth","accounts"], handler: h55 as NextApiHandler },
  { segments: ["auth","authorize"], handler: h56 as NextApiHandler },
  { segments: ["auth","callback"], handler: h57 as NextApiHandler },
  { segments: ["auth","connect"], handler: h58 as NextApiHandler },
  { segments: ["auth","freshdesk"], handler: h59 as NextApiHandler },
  { segments: ["auth","impersonate"], handler: h60 as NextApiHandler },
  { segments: ["auth","jwks"], handler: h61 as NextApiHandler },
  { segments: ["auth","linked"], handler: h62 as NextApiHandler },
  { segments: ["auth","login-popup"], handler: h63 as NextApiHandler },
  { segments: ["auth","logout"], handler: h64 as NextApiHandler },
  { segments: ["auth","post-login"], handler: h65 as NextApiHandler },
  { segments: ["auth","session"], handler: h66 as NextApiHandler },
  { segments: ["auth","switch"], handler: h67 as NextApiHandler },
  { segments: ["auth","user-from-token"], handler: h68 as NextApiHandler },
  { segments: ["blocks","manifest-schema"], handler: h69 as NextApiHandler },
  { segments: ["generation","data"], handler: h70 as NextApiHandler },
  { segments: ["generation","history"], handler: h71 as NextApiHandler },
  { segments: ["generation","resources"], handler: h72 as NextApiHandler },
  { segments: ["image","ingestion-results"], handler: h73 as NextApiHandler },
  { segments: ["internal","bundle-budget"], handler: h74 as NextApiHandler },
  { segments: ["internal","dev-tunnel-gate"], handler: h75 as NextApiHandler },
  { segments: ["internal","essential-objects"], handler: h76 as NextApiHandler },
  { segments: ["internal","freshdesk-service-tier-refresh"], handler: h77 as NextApiHandler },
  { segments: ["internal","get-jobs"], handler: h78 as NextApiHandler },
  { segments: ["internal","get-presigned-url"], handler: h79 as NextApiHandler },
  { segments: ["internal","heap-dump"], handler: h80 as NextApiHandler },
  { segments: ["internal","kono-finalize"], handler: h81 as NextApiHandler },
  { segments: ["internal","longest-running-query"], handler: h82 as NextApiHandler },
  { segments: ["internal","mod-gate"], handler: h83 as NextApiHandler },
  { segments: ["internal","ping"], handler: h84 as NextApiHandler },
  { segments: ["internal","pulse"], handler: h85 as NextApiHandler },
  { segments: ["internal","redis-sys-usage"], handler: h86 as NextApiHandler },
  { segments: ["internal","redis-usage"], handler: h87 as NextApiHandler },
  { segments: ["internal","restore-models"], handler: h88 as NextApiHandler },
  { segments: ["internal","search-index-update"], handler: h89 as NextApiHandler },
  { segments: ["internal","test-model-feed-filters"], handler: h90 as NextApiHandler },
  { segments: ["mod","action-report"], handler: h91 as NextApiHandler },
  { segments: ["mod","adjust-tag-level"], handler: h92 as NextApiHandler },
  { segments: ["mod","ban-user"], handler: h93 as NextApiHandler },
  { segments: ["mod","clean-up"], handler: h94 as NextApiHandler },
  { segments: ["mod","compute-tags"], handler: h95 as NextApiHandler },
  { segments: ["mod","custom-challenge"], handler: h96 as NextApiHandler },
  { segments: ["mod","delete-user-images"], handler: h97 as NextApiHandler },
  { segments: ["mod","enable-stripe-connect"], handler: h98 as NextApiHandler },
  { segments: ["mod","enable-tipalti"], handler: h99 as NextApiHandler },
  { segments: ["mod","flip-phases"], handler: h100 as NextApiHandler },
  { segments: ["mod","mod-rules"], handler: h101 as NextApiHandler },
  { segments: ["mod","mute-user-pending-review"], handler: h102 as NextApiHandler },
  { segments: ["mod","openapi.json"], handler: h103 as NextApiHandler },
  { segments: ["mod","overturn-user-mute"], handler: h104 as NextApiHandler },
  { segments: ["mod","queue-model-metric-update"], handler: h105 as NextApiHandler },
  { segments: ["mod","reconcile-nowpayments"], handler: h106 as NextApiHandler },
  { segments: ["mod","remove-all-content"], handler: h107 as NextApiHandler },
  { segments: ["mod","remove-images"], handler: h108 as NextApiHandler },
  { segments: ["mod","remove-placement"], handler: h109 as NextApiHandler },
  { segments: ["mod","reprocess-buzz-purchases"], handler: h110 as NextApiHandler },
  { segments: ["mod","reprocess-order"], handler: h111 as NextApiHandler },
  { segments: ["mod","reprocess-scan"], handler: h112 as NextApiHandler },
  { segments: ["mod","requeue-training-data-scans"], handler: h113 as NextApiHandler },
  { segments: ["mod","reset-bank"], handler: h114 as NextApiHandler },
  { segments: ["mod","reset-user-subscription-caches"], handler: h115 as NextApiHandler },
  { segments: ["mod","reset-vault"], handler: h116 as NextApiHandler },
  { segments: ["mod","resource-training-v2"], handler: h117 as NextApiHandler },
  { segments: ["mod","restore-images"], handler: h118 as NextApiHandler },
  { segments: ["mod","review-batches"], handler: h119 as NextApiHandler },
  { segments: ["mod","search-query-rule-dry-run"], handler: h120 as NextApiHandler },
  { segments: ["mod","send-mod-notification"], handler: h121 as NextApiHandler },
  { segments: ["mod","set-image-nsfw-level"], handler: h122 as NextApiHandler },
  { segments: ["mod","set-rewards-eligibility"], handler: h123 as NextApiHandler },
  { segments: ["mod","tipalti-resync-payee"], handler: h124 as NextApiHandler },
  { segments: ["mod","unblock-images"], handler: h125 as NextApiHandler },
  { segments: ["mod","unequip-event-cosmetics"], handler: h126 as NextApiHandler },
  { segments: ["mod","update-image-flag"], handler: h127 as NextApiHandler },
  { segments: ["mod","update-index"], handler: h128 as NextApiHandler },
  { segments: ["mod","whoami"], handler: h129 as NextApiHandler },
  { segments: ["mod","withdraw-from-bank"], handler: h130 as NextApiHandler },
  { segments: ["notification","getDetails"], handler: h131 as NextApiHandler },
  { segments: ["notifications","email-unsubscribe"], handler: h132 as NextApiHandler },
  { segments: ["orchestrator","blobRatings"], handler: h133 as NextApiHandler },
  { segments: ["orchestrator","getConsumerBlobUploadUrl"], handler: h134 as NextApiHandler },
  { segments: ["orchestrator","refreshBlobs"], handler: h135 as NextApiHandler },
  { segments: ["push","resubscribe"], handler: h136 as NextApiHandler },
  { segments: ["signal-server","get-token"], handler: h137 as NextApiHandler },
  { segments: ["testing","backfill-lora-hashes"], handler: h138 as NextApiHandler },
  { segments: ["testing","backfill-stale-nsfw-rollups"], handler: h139 as NextApiHandler },
  { segments: ["testing","blocks"], handler: h140 as NextApiHandler },
  { segments: ["testing","blue-buzz-paid-access"], handler: h141 as NextApiHandler },
  { segments: ["testing","chat-completion-scan"], handler: h142 as NextApiHandler },
  { segments: ["testing","daily-challenge"], handler: h143 as NextApiHandler },
  { segments: ["testing","eventloop-stall"], handler: h144 as NextApiHandler },
  { segments: ["testing","fee-allowance-boost"], handler: h145 as NextApiHandler },
  { segments: ["testing","generator-loaded"], handler: h146 as NextApiHandler },
  { segments: ["testing","gift-membership"], handler: h147 as NextApiHandler },
  { segments: ["testing","model-file-scan"], handler: h148 as NextApiHandler },
  { segments: ["testing","model3d-seed"], handler: h149 as NextApiHandler },
  { segments: ["testing","new-order"], handler: h150 as NextApiHandler },
  { segments: ["testing","orchestrator-loaded"], handler: h151 as NextApiHandler },
  { segments: ["testing","redis-cluster"], handler: h152 as NextApiHandler },
  { segments: ["testing","referrals"], handler: h153 as NextApiHandler },
  { segments: ["testing","rewards-config"], handler: h154 as NextApiHandler },
  { segments: ["testing","settings-trace"], handler: h155 as NextApiHandler },
  { segments: ["testing","strikes"], handler: h156 as NextApiHandler },
  { segments: ["testing","xguard-test"], handler: h157 as NextApiHandler },
  { segments: ["track","batch"], handler: h158 as NextApiHandler },
  { segments: ["track","block-message"], handler: h159 as NextApiHandler },
  { segments: ["track","block-render"], handler: h160 as NextApiHandler },
  { segments: ["training-studio","access"], handler: h161 as NextApiHandler },
  { segments: ["training-studio","host"], handler: h162 as NextApiHandler },
  { segments: ["training-studio","model-status"], handler: h163 as NextApiHandler },
  { segments: ["upload","abort"], handler: h164 as NextApiHandler },
  { segments: ["upload","complete"], handler: h165 as NextApiHandler },
  { segments: ["upload","sign-part"], handler: h166 as NextApiHandler },
  { segments: ["user","getHiddenPreferences"], handler: h167 as NextApiHandler },
  { segments: ["user","orchestrator-key"], handler: h168 as NextApiHandler },
  { segments: ["user","settings"], handler: h169 as NextApiHandler },
  { segments: ["v1","announcements"], handler: h170 as NextApiHandler },
  { segments: ["v1","apps"], handler: h171 as NextApiHandler },
  { segments: ["v1","bugs"], handler: h172 as NextApiHandler },
  { segments: ["v1","creators"], handler: h173 as NextApiHandler },
  { segments: ["v1","enums"], handler: h174 as NextApiHandler },
  { segments: ["v1","image-upload"], handler: h175 as NextApiHandler },
  { segments: ["v1","me"], handler: h176 as NextApiHandler },
  { segments: ["v1","tags"], handler: h177 as NextApiHandler },
  { segments: ["v1","users"], handler: h178 as NextApiHandler },
  { segments: ["webhooks","audio-scan-result"], handler: h179 as NextApiHandler },
  { segments: ["webhooks","freshdesk"], handler: h180 as NextApiHandler },
  { segments: ["webhooks","image-scan-result"], handler: h181 as NextApiHandler },
  { segments: ["webhooks","model-file-scan-result"], handler: h182 as NextApiHandler },
  { segments: ["webhooks","model-scan-result"], handler: h183 as NextApiHandler },
  { segments: ["webhooks","resource-availability"], handler: h184 as NextApiHandler },
  { segments: ["webhooks","resource-training"], handler: h185 as NextApiHandler },
  { segments: ["webhooks","scanner-policy-result"], handler: h186 as NextApiHandler },
  { segments: ["webhooks","text-moderation-result"], handler: h187 as NextApiHandler },
  { segments: ["webhooks","text-scan-result"], handler: h188 as NextApiHandler },
  { segments: ["webhooks","twitch"], handler: h189 as NextApiHandler },
  { segments: ["webhooks","youtube-upload"], handler: h190 as NextApiHandler },
  { segments: ["run","[modelVersionId]"], handler: h191 as NextApiHandler },
  { segments: ["admin","temp","apply-models-index-displayed-attributes"], handler: h192 as NextApiHandler },
  { segments: ["admin","temp","apply-models-index-filterable-attributes"], handler: h193 as NextApiHandler },
  { segments: ["admin","temp","apply-models-index-ranking-rules"], handler: h194 as NextApiHandler },
  { segments: ["admin","temp","archive-held-user-comments"], handler: h195 as NextApiHandler },
  { segments: ["admin","temp","article-category-backfill"], handler: h196 as NextApiHandler },
  { segments: ["admin","temp","backfill-b2-file-locations"], handler: h197 as NextApiHandler },
  { segments: ["admin","temp","backfill-base-model-hot-score"], handler: h198 as NextApiHandler },
  { segments: ["admin","temp","backfill-block-image-blurhash"], handler: h199 as NextApiHandler },
  { segments: ["admin","temp","backfill-creator-milestones"], handler: h200 as NextApiHandler },
  { segments: ["admin","temp","backfill-generation-counts"], handler: h201 as NextApiHandler },
  { segments: ["admin","temp","backfill-image-meta-flags"], handler: h202 as NextApiHandler },
  { segments: ["admin","temp","backfill-image-scores"], handler: h203 as NextApiHandler },
  { segments: ["admin","temp","backfill-metric-agg"], handler: h204 as NextApiHandler },
  { segments: ["admin","temp","backfill-model-permission-snapshots"], handler: h205 as NextApiHandler },
  { segments: ["admin","temp","backfill-post-metrics"], handler: h206 as NextApiHandler },
  { segments: ["admin","temp","backfill-removal-score-exemptions"], handler: h207 as NextApiHandler },
  { segments: ["admin","temp","backfill-scheduled-challenge-themes"], handler: h208 as NextApiHandler },
  { segments: ["admin","temp","backfill-swept-trained-models"], handler: h209 as NextApiHandler },
  { segments: ["admin","temp","backfill-trained-model-permissions"], handler: h210 as NextApiHandler },
  { segments: ["admin","temp","backfill-unique-generators"], handler: h211 as NextApiHandler },
  { segments: ["admin","temp","backfill-user-downloads"], handler: h212 as NextApiHandler },
  { segments: ["admin","temp","backfill-video-blurhash"], handler: h213 as NextApiHandler },
  { segments: ["admin","temp","challenge-reconcile-backfill"], handler: h214 as NextApiHandler },
  { segments: ["admin","temp","child-label-reindex"], handler: h215 as NextApiHandler },
  { segments: ["admin","temp","clamp-publishedat-bumps"], handler: h216 as NextApiHandler },
  { segments: ["admin","temp","cleanup-orphaned-images-search"], handler: h217 as NextApiHandler },
  { segments: ["admin","temp","cleanup-poi-tag-mismatches"], handler: h218 as NextApiHandler },
  { segments: ["admin","temp","convert-model-rules"], handler: h219 as NextApiHandler },
  { segments: ["admin","temp","dedupe-official-files"], handler: h220 as NextApiHandler },
  { segments: ["admin","temp","delete-deleted-users"], handler: h221 as NextApiHandler },
  { segments: ["admin","temp","fix-cross-posted-images"], handler: h222 as NextApiHandler },
  { segments: ["admin","temp","grant-banked-blessed-buzz"], handler: h223 as NextApiHandler },
  { segments: ["admin","temp","membership-buzz-backfill"], handler: h224 as NextApiHandler },
  { segments: ["admin","temp","merge-moss-image-base"], handler: h225 as NextApiHandler },
  { segments: ["admin","temp","migrate-article-images"], handler: h226 as NextApiHandler },
  { segments: ["admin","temp","migrate-challenges"], handler: h227 as NextApiHandler },
  { segments: ["admin","temp","migrate-hidden-gallery-images"], handler: h228 as NextApiHandler },
  { segments: ["admin","temp","migrate-nsfwLevels"], handler: h229 as NextApiHandler },
  { segments: ["admin","temp","migrate-profanity-nsfw"], handler: h230 as NextApiHandler },
  { segments: ["admin","temp","minor-hash-sweep"], handler: h231 as NextApiHandler },
  { segments: ["admin","temp","model-text-moderation-backfill"], handler: h232 as NextApiHandler },
  { segments: ["admin","temp","new-order-consensus-backfill"], handler: h233 as NextApiHandler },
  { segments: ["admin","temp","perma-delete-poi-models"], handler: h234 as NextApiHandler },
  { segments: ["admin","temp","prepaid-product-repoint"], handler: h235 as NextApiHandler },
  { segments: ["admin","temp","queue-accelerator-models-reindex"], handler: h236 as NextApiHandler },
  { segments: ["admin","temp","queue-held-cover-collections-reindex"], handler: h237 as NextApiHandler },
  { segments: ["admin","temp","queue-held-showcase-models-reindex"], handler: h238 as NextApiHandler },
  { segments: ["admin","temp","queue-legacy-cover-collections-reindex"], handler: h239 as NextApiHandler },
  { segments: ["admin","temp","queue-paid-models-reindex"], handler: h240 as NextApiHandler },
  { segments: ["admin","temp","queue-takendown-models-reindex"], handler: h241 as NextApiHandler },
  { segments: ["admin","temp","reclaim-membership-buzz"], handler: h242 as NextApiHandler },
  { segments: ["admin","temp","recompute-removal-scores"], handler: h243 as NextApiHandler },
  { segments: ["admin","temp","recompute-self-activity"], handler: h244 as NextApiHandler },
  { segments: ["admin","temp","reconcile-detected-image-resources"], handler: h245 as NextApiHandler },
  { segments: ["admin","temp","remove-deprecated-base-models"], handler: h246 as NextApiHandler },
  { segments: ["admin","temp","repair-post-unpublished-stamp"], handler: h247 as NextApiHandler },
  { segments: ["admin","temp","reprocess-exempt-blocked-images"], handler: h248 as NextApiHandler },
  { segments: ["admin","temp","republish-orphaned-drafts"], handler: h249 as NextApiHandler },
  { segments: ["admin","temp","rescan-images"], handler: h250 as NextApiHandler },
  { segments: ["admin","temp","rescan-judge-collection-images"], handler: h251 as NextApiHandler },
  { segments: ["admin","temp","reset-training-model"], handler: h252 as NextApiHandler },
  { segments: ["admin","temp","text-scan-clavata-cutover"], handler: h253 as NextApiHandler },
  { segments: ["admin","temp","text-scan-rescan"], handler: h254 as NextApiHandler },
  { segments: ["apps","assistant","activity"], handler: h255 as NextApiHandler },
  { segments: ["apps","assistant","preview"], handler: h256 as NextApiHandler },
  { segments: ["apps","assistant","run-grant"], handler: h257 as NextApiHandler },
  { segments: ["apps","assistant","runner-viewer-token"], handler: h258 as NextApiHandler },
  { segments: ["apps","assistant","source-save"], handler: h259 as NextApiHandler },
  { segments: ["apps","assistant","token"], handler: h260 as NextApiHandler },
  { segments: ["apps","dev","entry-url"], handler: h261 as NextApiHandler },
  { segments: ["apps","dev","preview-errors"], handler: h262 as NextApiHandler },
  { segments: ["generation","history","callback"], handler: h263 as NextApiHandler },
  { segments: ["internal","app-assistant","app-activity"], handler: h264 as NextApiHandler },
  { segments: ["internal","app-assistant","runner-token"], handler: h265 as NextApiHandler },
  { segments: ["internal","app-assistant","sleeping-apps"], handler: h266 as NextApiHandler },
  { segments: ["internal","app-assistant","source-save"], handler: h267 as NextApiHandler },
  { segments: ["internal","app-assistant","wake-seed"], handler: h268 as NextApiHandler },
  { segments: ["internal","notifications","render-push"], handler: h269 as NextApiHandler },
  { segments: ["internal","notifications","send-email"], handler: h270 as NextApiHandler },
  { segments: ["mod","apps","refund-workflows"], handler: h271 as NextApiHandler },
  { segments: ["mod","apps","workflow-charges"], handler: h272 as NextApiHandler },
  { segments: ["mod","audit","change-history"], handler: h273 as NextApiHandler },
  { segments: ["mod","bounty-entry-file","clear-check"], handler: h274 as NextApiHandler },
  { segments: ["mod","bounty-entry-file","reblock-check"], handler: h275 as NextApiHandler },
  { segments: ["mod","bounty-poi","resolve-appeal"], handler: h276 as NextApiHandler },
  { segments: ["mod","bounty-unpaid-award","resolve"], handler: h277 as NextApiHandler },
  { segments: ["mod","collection","set-item-tag"], handler: h278 as NextApiHandler },
  { segments: ["mod","comment","bulk-delete"], handler: h279 as NextApiHandler },
  { segments: ["mod","comment","remove-as-tos"], handler: h280 as NextApiHandler },
  { segments: ["mod","comment","restore-from-tos"], handler: h281 as NextApiHandler },
  { segments: ["mod","cosmetic","assign-by-target"], handler: h282 as NextApiHandler },
  { segments: ["mod","cosmetic","create"], handler: h283 as NextApiHandler },
  { segments: ["mod","cosmetic","delete"], handler: h284 as NextApiHandler },
  { segments: ["mod","cosmetic","holdings-removed"], handler: h285 as NextApiHandler },
  { segments: ["mod","cosmetic","refund-box-purchase"], handler: h286 as NextApiHandler },
  { segments: ["mod","cosmetic","unassign"], handler: h287 as NextApiHandler },
  { segments: ["mod","cosmetic","update"], handler: h288 as NextApiHandler },
  { segments: ["mod","creator-services","deal-file-url"], handler: h289 as NextApiHandler },
  { segments: ["mod","creator-services","deal-files"], handler: h290 as NextApiHandler },
  { segments: ["mod","creator-services","dispute-evidence"], handler: h291 as NextApiHandler },
  { segments: ["mod","creator-services","dispute-review"], handler: h292 as NextApiHandler },
  { segments: ["mod","creator-services","disputes"], handler: h293 as NextApiHandler },
  { segments: ["mod","creator-services","resolve-dispute"], handler: h294 as NextApiHandler },
  { segments: ["mod","csam","training-data-report"], handler: h295 as NextApiHandler },
  { segments: ["mod","daily-challenge","cycle"], handler: h296 as NextApiHandler },
  { segments: ["mod","feedback","ticket-bug"], handler: h297 as NextApiHandler },
  { segments: ["mod","feedback","triage"], handler: h298 as NextApiHandler },
  { segments: ["mod","homeblock","create"], handler: h299 as NextApiHandler },
  { segments: ["mod","homeblock","delete"], handler: h300 as NextApiHandler },
  { segments: ["mod","homeblock","reorder"], handler: h301 as NextApiHandler },
  { segments: ["mod","homeblock","update"], handler: h302 as NextApiHandler },
  { segments: ["mod","image","kono-set-nsfw-level"], handler: h303 as NextApiHandler },
  { segments: ["mod","image","report-csam"], handler: h304 as NextApiHandler },
  { segments: ["mod","image","set-nsfw-level"], handler: h305 as NextApiHandler },
  { segments: ["mod","image","tag-vote"], handler: h306 as NextApiHandler },
  { segments: ["mod","knights","enqueue"], handler: h307 as NextApiHandler },
  { segments: ["mod","knights","notification-types"], handler: h308 as NextApiHandler },
  { segments: ["mod","knights","reset-player"], handler: h309 as NextApiHandler },
  { segments: ["mod","label-store","predictions"], handler: h310 as NextApiHandler },
  { segments: ["mod","membership-gift","refund-unfulfilled"], handler: h311 as NextApiHandler },
  { segments: ["mod","membership-gift","revoke-unpaid"], handler: h312 as NextApiHandler },
  { segments: ["mod","messages","claim"], handler: h313 as NextApiHandler },
  { segments: ["mod","messages","inbox"], handler: h314 as NextApiHandler },
  { segments: ["mod","messages","release"], handler: h315 as NextApiHandler },
  { segments: ["mod","messages","thread"], handler: h316 as NextApiHandler },
  { segments: ["mod","minor-flag","confirm"], handler: h317 as NextApiHandler },
  { segments: ["mod","minor-flag","dismiss"], handler: h318 as NextApiHandler },
  { segments: ["mod","minor-flag","resolve-appeal"], handler: h319 as NextApiHandler },
  { segments: ["mod","minor-flag","resolve-redetection"], handler: h320 as NextApiHandler },
  { segments: ["mod","minor-flag","revert"], handler: h321 as NextApiHandler },
  { segments: ["mod","minor-flag","rule"], handler: h322 as NextApiHandler },
  { segments: ["mod","minor-flag","set-minor"], handler: h323 as NextApiHandler },
  { segments: ["mod","model","bring-back"], handler: h324 as NextApiHandler },
  { segments: ["mod","model","bump"], handler: h325 as NextApiHandler },
  { segments: ["mod","model","republish"], handler: h326 as NextApiHandler },
  { segments: ["mod","model","resolve-lock-review"], handler: h327 as NextApiHandler },
  { segments: ["mod","model","resolve-restricted-nsfw-verdict"], handler: h328 as NextApiHandler },
  { segments: ["mod","model","set-poi"], handler: h329 as NextApiHandler },
  { segments: ["mod","model","set-sfw-only"], handler: h330 as NextApiHandler },
  { segments: ["mod","model","take-down"], handler: h331 as NextApiHandler },
  { segments: ["mod","model","unpublish"], handler: h332 as NextApiHandler },
  { segments: ["mod","new-order","manage-queue"], handler: h333 as NextApiHandler },
  { segments: ["mod","new-order","rate-limit-config"], handler: h334 as NextApiHandler },
  { segments: ["mod","nowpayments","credit-deposit"], handler: h335 as NextApiHandler },
  { segments: ["mod","nowpayments","open-deposits"], handler: h336 as NextApiHandler },
  { segments: ["mod","poi-flag","confirm"], handler: h337 as NextApiHandler },
  { segments: ["mod","poi-flag","dismiss"], handler: h338 as NextApiHandler },
  { segments: ["mod","poi-flag","flag-match"], handler: h339 as NextApiHandler },
  { segments: ["mod","poi-flag","revert"], handler: h340 as NextApiHandler },
  { segments: ["mod","post-text","moderate"], handler: h341 as NextApiHandler },
  { segments: ["mod","restriction","resolve"], handler: h342 as NextApiHandler },
  { segments: ["mod","review","delete"], handler: h343 as NextApiHandler },
  { segments: ["mod","review","set-exclude"], handler: h344 as NextApiHandler },
  { segments: ["mod","scanner-policies","export-dataset"], handler: h345 as NextApiHandler },
  { segments: ["mod","search","articles-update"], handler: h346 as NextApiHandler },
  { segments: ["mod","search","models-update"], handler: h347 as NextApiHandler },
  { segments: ["mod","storyline","lift-title-takedown"], handler: h348 as NextApiHandler },
  { segments: ["mod","storyline","resolve-title-appeal"], handler: h349 as NextApiHandler },
  { segments: ["mod","strike","create"], handler: h350 as NextApiHandler },
  { segments: ["mod","strike","get-user-strikes"], handler: h351 as NextApiHandler },
  { segments: ["mod","strike","void"], handler: h352 as NextApiHandler },
  { segments: ["mod","training-data","resolve"], handler: h353 as NextApiHandler },
  { segments: ["mod","user","buzz-membership-end"], handler: h354 as NextApiHandler },
  { segments: ["mod","user","cancel-pending-workflows"], handler: h355 as NextApiHandler },
  { segments: ["mod","user","clear-profile"], handler: h356 as NextApiHandler },
  { segments: ["mod","user","creator-program-ban"], handler: h357 as NextApiHandler },
  { segments: ["mod","user","creator-score-grant-revoke"], handler: h358 as NextApiHandler },
  { segments: ["mod","user","creator-score-grant"], handler: h359 as NextApiHandler },
  { segments: ["mod","user","delete"], handler: h360 as NextApiHandler },
  { segments: ["mod","user","expire-generation-credentials"], handler: h361 as NextApiHandler },
  { segments: ["mod","user","force-logout"], handler: h362 as NextApiHandler },
  { segments: ["mod","user","legal-hold"], handler: h363 as NextApiHandler },
  { segments: ["mod","user","membership-cancel-preview"], handler: h364 as NextApiHandler },
  { segments: ["mod","user","membership-cancel"], handler: h365 as NextApiHandler },
  { segments: ["mod","user","membership-code-revoke"], handler: h366 as NextApiHandler },
  { segments: ["mod","user","membership-code"], handler: h367 as NextApiHandler },
  { segments: ["mod","user","membership-extend-preview"], handler: h368 as NextApiHandler },
  { segments: ["mod","user","membership-extend"], handler: h369 as NextApiHandler },
  { segments: ["mod","user","membership-resync-preview"], handler: h370 as NextApiHandler },
  { segments: ["mod","user","membership-resync"], handler: h371 as NextApiHandler },
  { segments: ["mod","user","message-as-civitai"], handler: h372 as NextApiHandler },
  { segments: ["mod","user","mute"], handler: h373 as NextApiHandler },
  { segments: ["mod","user","personal-data-export-release"], handler: h374 as NextApiHandler },
  { segments: ["mod","user","reactions"], handler: h375 as NextApiHandler },
  { segments: ["mod","user","remove-reactions"], handler: h376 as NextApiHandler },
  { segments: ["mod","user","toggle-moderator"], handler: h377 as NextApiHandler },
  { segments: ["mod","user","unmute"], handler: h378 as NextApiHandler },
  { segments: ["mod","user","update-identity"], handler: h379 as NextApiHandler },
  { segments: ["v1","block-tokens","jwks"], handler: h380 as NextApiHandler },
  { segments: ["v1","blocks","buzz"], handler: h381 as NextApiHandler },
  { segments: ["v1","blocks","entitlements"], handler: h382 as NextApiHandler },
  { segments: ["v1","blocks","gated-images"], handler: h383 as NextApiHandler },
  { segments: ["v1","blocks","generation-resources"], handler: h384 as NextApiHandler },
  { segments: ["v1","blocks","generation-samplers"], handler: h385 as NextApiHandler },
  { segments: ["v1","blocks","me"], handler: h386 as NextApiHandler },
  { segments: ["v1","blocks","models"], handler: h387 as NextApiHandler },
  { segments: ["v1","blocks","resource-intent"], handler: h388 as NextApiHandler },
  { segments: ["v1","blocks","tip-allowance"], handler: h389 as NextApiHandler },
  { segments: ["v1","blocks","workflow-media"], handler: h390 as NextApiHandler },
  { segments: ["v1","catalog","items"], handler: h391 as NextApiHandler },
  { segments: ["v1","creator-program","join"], handler: h392 as NextApiHandler },
  { segments: ["v1","creator","engagement"], handler: h393 as NextApiHandler },
  { segments: ["v1","image-upload","multipart"], handler: h394 as NextApiHandler },
  { segments: ["v1","me","limits"], handler: h395 as NextApiHandler },
  { segments: ["v1","model-versions","bust-cache"], handler: h396 as NextApiHandler },
  { segments: ["v1","model-versions","by-hash"], handler: h397 as NextApiHandler },
  { segments: ["v1","model-versions","early-access"], handler: h398 as NextApiHandler },
  { segments: ["v1","model-versions","gifts"], handler: h399 as NextApiHandler },
  { segments: ["v1","models","com-face"], handler: h400 as NextApiHandler },
  { segments: ["v1","partners","generate-token"], handler: h401 as NextApiHandler },
  { segments: ["v1","permissions","check"], handler: h402 as NextApiHandler },
  { segments: ["v1","vault","all"], handler: h403 as NextApiHandler },
  { segments: ["v1","vault","check-vault"], handler: h404 as NextApiHandler },
  { segments: ["v1","vault","get"], handler: h405 as NextApiHandler },
  { segments: ["v1","vault","toggle-version"], handler: h406 as NextApiHandler },
  { segments: ["internal","image-delivery","[id]"], handler: h407 as NextApiHandler },
  { segments: ["media","ingest","[mediaId]"], handler: h408 as NextApiHandler },
  { segments: ["page-data","images","[imageId]"], handler: h409 as NextApiHandler },
  { segments: ["testing","email","[template]"], handler: h410 as NextApiHandler },
  { segments: ["v1","apps","[slug]"], handler: h411 as NextApiHandler },
  { segments: ["v1","articles","[id]"], handler: h412 as NextApiHandler },
  { segments: ["v1","bugs","[id]"], handler: h413 as NextApiHandler },
  { segments: ["v1","collections","[id]"], handler: h414 as NextApiHandler },
  { segments: ["v1","download-links","[linkId]"], handler: h415 as NextApiHandler },
  { segments: ["v1","model-versions","[id]"], handler: h416 as NextApiHandler },
  { segments: ["v1","models","[id]"], handler: h417 as NextApiHandler },
  { segments: ["v1","posts","[id]"], handler: h418 as NextApiHandler },
  { segments: ["v1","users","[userId]"], handler: h419 as NextApiHandler },
  { segments: ["webhooks","resource-training-v2","[modelVersionId]"], handler: h420 as NextApiHandler },
  { segments: ["image","[entityType]","[entityId]"], handler: h421 as NextApiHandler },
  { segments: ["internal","app-assistant","app-feedback","review"], handler: h422 as NextApiHandler },
  { segments: ["internal","app-assistant","app-feedback","user"], handler: h423 as NextApiHandler },
  { segments: ["internal","app-assistant","cover","listing"], handler: h424 as NextApiHandler },
  { segments: ["internal","app-assistant","dev-tunnel","keepalive"], handler: h425 as NextApiHandler },
  { segments: ["internal","app-assistant","dev-tunnel","start"], handler: h426 as NextApiHandler },
  { segments: ["internal","app-assistant","dev-tunnel","stop"], handler: h427 as NextApiHandler },
  { segments: ["mod","knights","shop","cosmetics"], handler: h428 as NextApiHandler },
  { segments: ["mod","knights","shop","membership"], handler: h429 as NextApiHandler },
  { segments: ["mod","text-scan","csam-hold","resolve"], handler: h430 as NextApiHandler },
  { segments: ["mod","text-scan","model-rules-hold","resolve"], handler: h431 as NextApiHandler },
  { segments: ["v1","blocks","sub-listings","mine"], handler: h432 as NextApiHandler },
  { segments: ["v1","blocks","user-checkpoint","set"], handler: h433 as NextApiHandler },
  { segments: ["v1","model-versions","by-hash","ids"], handler: h434 as NextApiHandler },
  { segments: ["v1","model-versions","gifts","claim"], handler: h435 as NextApiHandler },
  { segments: ["v1","blocks","media","[ticket]"], handler: h436 as NextApiHandler },
  { segments: ["v1","model-versions","by-hash","[hash]"], handler: h437 as NextApiHandler },
  { segments: ["v1","model-versions","mini","[id]"], handler: h438 as NextApiHandler },
  { segments: ["v1","posts","planner","[action]"], handler: h439 as NextApiHandler },
  { segments: ["generation","workflows","[workflowId]","status-update"], handler: h440 as NextApiHandler },
  { segments: ["service-deals","files","[fileId]","download"], handler: h441 as NextApiHandler },
  { segments: ["v1","model-files","[id]","tensor-metadata"], handler: h442 as NextApiHandler },
  { segments: ["v1","model-versions","[id]","gifts"], handler: h443 as NextApiHandler },
  { segments: ["blocks","screenshot","[appBlockId]","[file]"], handler: h444 as NextApiHandler },
  { segments: ["v1","model-versions","[id]","gifts","link"], handler: h445 as NextApiHandler },
  { segments: ["v1","model-versions","[id]","gifts","[giftId]"], handler: h446 as NextApiHandler },
  { segments: ["v1","model-versions","[id]","gifts","batch","[batchId]"], handler: h447 as NextApiHandler },
  { segments: ["v1","model-versions","[id]","gifts","[giftId]","claims"], handler: h448 as NextApiHandler },
  { segments: ["v1","model-versions","[id]","gifts","batch","[batchId]","claims"], handler: h449 as NextApiHandler },
  { segments: ["v1","model-versions","[id]","gifts","[giftId]","claims","[userId]"], handler: h450 as NextApiHandler },
];
