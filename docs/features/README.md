# Feature documentation

Feature docs live in `docs/features/`. Check whether one exists before implementing a feature.

Operational runbooks, security reviews, incident handoffs and content-policy records do not belong in `docs/`: this repo is public. See the Security section of root CLAUDE.md.

## Core systems

| System | Documentation |
|--------|--------------|
| Image Resources | [docs/features/image-resources.md](image-resources.md) |
| NSFW Filtering | [docs/features/nsfw-filtering.md](nsfw-filtering.md) |
| Image Rating and Visibility | [docs/features/image-rating.md](image-rating.md) |
| Text Scan (LLM moderation of user text) | [docs/features/text-scan.md](text-scan.md) |
| Moderator app: Model Flags (appeals, flagged, file matches) | [docs/features/moderator-model-flags.md](moderator-model-flags.md) |
| CSAM text holds queue (moderator app) | [docs/features/text-scan-csam-holds.md](text-scan-csam-holds.md) |
| Model rule matches queue (moderator app) | [docs/features/text-scan.md](text-scan.md) |
| Minor detection review mode | [docs/features/minor-detection-review.md](minor-detection-review.md) |
| Label store (every moderation judgement, for training) | [docs/features/label-store.md](label-store.md) |
| Rating Disputes | [docs/features/rating-dispute.md](rating-dispute.md) |
| Buzz Accounts | [docs/features/buzz-accounts.md](buzz-accounts.md) |
| Monetization rules (paid access / fees / donation goals) | [docs/features/monetization-rules.md](monetization-rules.md) |
| Notifications | [docs/features/notifications.md](notifications.md) |
| Web Push (browser push notifications) | [docs/features/web-push.md](web-push.md) |
| Metrics/Analytics | [docs/features/entity-metrics.md](entity-metrics.md) |
| Feed Impressions | [docs/features/feed-impressions.md](feed-impressions.md) |
| Bitwise Flags | [docs/features/bitwise-flags.md](bitwise-flags.md) |
| Civitai LLM Client | [docs/features/civitai-llm-client.md](civitai-llm-client.md) |
| Challenge Platform | [docs/features/challenge-platform.md](challenge-platform.md) |
| Civitai Link | [docs/features/civitai-link.md](civitai-link.md) |
| App Store sub-listings (items inside an app as store cards) | [docs/features/app-store-sub-listings.md](app-store-sub-listings.md) |
| Generator model onboarding (new ecosystem / model / version) | [docs/features/generator-model-onboarding.md](generator-model-onboarding.md) |
| Turbo LoRAs and the Turbo picker | [docs/features/recommended-generation-settings.md](recommended-generation-settings.md) |
| Batch post scheduling and the post planner                   | [docs/features/batch-post-scheduling.md](batch-post-scheduling.md)           |
| Article scheduling                                           | [docs/features/article-scheduling.md](article-scheduling.md)                 |
| Official articles (`isOfficial`, the Civitai Official tag)   | [docs/features/official-articles.md](official-articles.md)                   |
| Avatar Gen (portrait to stylised avatar workflow)            | [docs/features/avatar-gen.md](avatar-gen.md)                                 |
| Account settings deep links (`?setting=`)                    | [docs/features/account-settings-links.md](account-settings-links.md)         |
| Storylines (branching stories told in posts) | [docs/features/storylines.md](storylines.md) |
| Model civitai.com face (separate .com title, description and cover) | [docs/features/model-com-face.md](model-com-face.md) |
