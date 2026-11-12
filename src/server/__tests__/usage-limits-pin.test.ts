import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionUser } from '~/types/session';
import type { RateLimit } from '~/server/utils/rate-limit-window';
import { postRateLimits } from '~/server/schema/post.schema';
import { articleRateLimits } from '~/server/schema/article.schema';
import { commentRateLimits } from '~/server/schema/commentv3.schema';
import { reactionRateLimits } from '~/server/schema/reaction.schema';
import { resourceLoadRateLimits } from '~/server/routers/resource-load.router';
import {
  buildCreatorScoreUnlocks,
  compiledCreatorScoreUnlockInputs,
} from '~/server/services/creator-score-unlocks.service';
import {
  getDailyPostLimit,
  resetUsageLimitConfigCache,
  resolveUsageLimitRules,
} from '~/server/services/usage-limit-config.service';
import type { UsageLimitRef } from '~/shared/constants/usage-limits';

/**
 * The limits, 429 messages and unlock labels served before the usage-limit registry, pinned as
 * literals. With no KeyValue override (the db mock finds no row) the registry must serve exactly
 * these. Each cell is
 * `period:limit` per applied rule, `#n` naming the rule's message in MESSAGES.
 */

const MESSAGES = [
  'New accounts have a lower hourly posting limit on their first day.',
  "You've reached today's limit of 20 posts. Limits rise at Creator Scores of 1,000 and 5,000, and members get double.",
  'You need to wait 24 hours after creating your account to create articles.',
  'You can only queue a few model loads an hour. Try again shortly.',
  'Loading models is a member benefit.',
  "You've reached today's limit of 40 posts. Limits rise at Creator Scores of 1,000 and 5,000.",
  "You've reached today's limit of 60 posts. Limits rise at a Creator Score of 5,000, and members get double.",
  "You've reached today's limit of 120 posts. Limits rise at a Creator Score of 5,000.",
  "You've reached today's limit of 150 posts. Members get double.",
  "You've reached today's limit of 300 posts.",
];

type Group = 'posts' | 'articles' | 'comments' | 'reactions' | 'resourceLoads';
type Row = [
  age: 'new' | 'old',
  score: number,
  tier: string,
  dailyPostLimit: number,
  served: Record<Group, string>
];

// prettier-ignore
const ROWS: Row[] = [
  ['new', 0, 'none', 20, {"posts":"3600:2#0 86400:20#1","articles":"3600:0#2 86400:3","comments":"3600:10 86400:40","reactions":"60:60 600:300 3600:1000 86400:5000","resourceLoads":"3600:3#3 86400:0#4"}],
  ['new', 0, 'free', 20, {"posts":"3600:2#0 86400:20#1","articles":"3600:0#2 86400:3","comments":"3600:10 86400:40","reactions":"60:60 600:300 3600:1000 86400:5000","resourceLoads":"3600:3#3 86400:0#4"}],
  ['new', 0, 'founder', 40, {"posts":"3600:2#0 86400:40#5","articles":"3600:0#2 86400:3","comments":"3600:10 86400:40","reactions":"60:60 600:300 3600:1000 86400:5000","resourceLoads":"3600:3#3 86400:10"}],
  ['new', 0, 'bronze', 40, {"posts":"3600:2#0 86400:40#5","articles":"3600:0#2 86400:3","comments":"3600:10 86400:40","reactions":"60:60 600:300 3600:1000 86400:5000","resourceLoads":"3600:3#3 86400:3"}],
  ['new', 0, 'silver', 40, {"posts":"3600:2#0 86400:40#5","articles":"3600:0#2 86400:3","comments":"3600:10 86400:40","reactions":"60:60 600:300 3600:1000 86400:5000","resourceLoads":"3600:3#3 86400:6"}],
  ['new', 0, 'gold', 40, {"posts":"3600:2#0 86400:40#5","articles":"3600:0#2 86400:3","comments":"3600:10 86400:40","reactions":"60:60 600:300 3600:1000 86400:5000","resourceLoads":"3600:3#3 86400:10"}],
  ['new', 999, 'none', 20, {"posts":"3600:2#0 86400:20#1","articles":"3600:0#2 86400:3","comments":"3600:10 86400:40","reactions":"60:60 600:300 3600:1000 86400:5000","resourceLoads":"3600:3#3 86400:0#4"}],
  ['new', 999, 'free', 20, {"posts":"3600:2#0 86400:20#1","articles":"3600:0#2 86400:3","comments":"3600:10 86400:40","reactions":"60:60 600:300 3600:1000 86400:5000","resourceLoads":"3600:3#3 86400:0#4"}],
  ['new', 999, 'founder', 40, {"posts":"3600:2#0 86400:40#5","articles":"3600:0#2 86400:3","comments":"3600:10 86400:40","reactions":"60:60 600:300 3600:1000 86400:5000","resourceLoads":"3600:3#3 86400:10"}],
  ['new', 999, 'bronze', 40, {"posts":"3600:2#0 86400:40#5","articles":"3600:0#2 86400:3","comments":"3600:10 86400:40","reactions":"60:60 600:300 3600:1000 86400:5000","resourceLoads":"3600:3#3 86400:3"}],
  ['new', 999, 'silver', 40, {"posts":"3600:2#0 86400:40#5","articles":"3600:0#2 86400:3","comments":"3600:10 86400:40","reactions":"60:60 600:300 3600:1000 86400:5000","resourceLoads":"3600:3#3 86400:6"}],
  ['new', 999, 'gold', 40, {"posts":"3600:2#0 86400:40#5","articles":"3600:0#2 86400:3","comments":"3600:10 86400:40","reactions":"60:60 600:300 3600:1000 86400:5000","resourceLoads":"3600:3#3 86400:10"}],
  ['new', 1000, 'none', 60, {"posts":"3600:2#0 86400:60#6","articles":"3600:0#2 86400:5","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:0#4"}],
  ['new', 1000, 'free', 60, {"posts":"3600:2#0 86400:60#6","articles":"3600:0#2 86400:5","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:0#4"}],
  ['new', 1000, 'founder', 120, {"posts":"3600:2#0 86400:120#7","articles":"3600:0#2 86400:5","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:10"}],
  ['new', 1000, 'bronze', 120, {"posts":"3600:2#0 86400:120#7","articles":"3600:0#2 86400:5","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:3"}],
  ['new', 1000, 'silver', 120, {"posts":"3600:2#0 86400:120#7","articles":"3600:0#2 86400:5","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:6"}],
  ['new', 1000, 'gold', 120, {"posts":"3600:2#0 86400:120#7","articles":"3600:0#2 86400:5","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:10"}],
  ['new', 4999, 'none', 60, {"posts":"3600:2#0 86400:60#6","articles":"3600:0#2 86400:5","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:0#4"}],
  ['new', 4999, 'free', 60, {"posts":"3600:2#0 86400:60#6","articles":"3600:0#2 86400:5","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:0#4"}],
  ['new', 4999, 'founder', 120, {"posts":"3600:2#0 86400:120#7","articles":"3600:0#2 86400:5","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:10"}],
  ['new', 4999, 'bronze', 120, {"posts":"3600:2#0 86400:120#7","articles":"3600:0#2 86400:5","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:3"}],
  ['new', 4999, 'silver', 120, {"posts":"3600:2#0 86400:120#7","articles":"3600:0#2 86400:5","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:6"}],
  ['new', 4999, 'gold', 120, {"posts":"3600:2#0 86400:120#7","articles":"3600:0#2 86400:5","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:10"}],
  ['new', 5000, 'none', 150, {"posts":"3600:2#0 86400:150#8","articles":"3600:0#2 86400:10","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:0#4"}],
  ['new', 5000, 'free', 150, {"posts":"3600:2#0 86400:150#8","articles":"3600:0#2 86400:10","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:0#4"}],
  ['new', 5000, 'founder', 300, {"posts":"3600:2#0 86400:300#9","articles":"3600:0#2 86400:10","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:10"}],
  ['new', 5000, 'bronze', 300, {"posts":"3600:2#0 86400:300#9","articles":"3600:0#2 86400:10","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:3"}],
  ['new', 5000, 'silver', 300, {"posts":"3600:2#0 86400:300#9","articles":"3600:0#2 86400:10","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:6"}],
  ['new', 5000, 'gold', 300, {"posts":"3600:2#0 86400:300#9","articles":"3600:0#2 86400:10","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:10"}],
  ['new', 9999, 'none', 150, {"posts":"3600:2#0 86400:150#8","articles":"3600:0#2 86400:10","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:0#4"}],
  ['new', 9999, 'free', 150, {"posts":"3600:2#0 86400:150#8","articles":"3600:0#2 86400:10","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:0#4"}],
  ['new', 9999, 'founder', 300, {"posts":"3600:2#0 86400:300#9","articles":"3600:0#2 86400:10","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:10"}],
  ['new', 9999, 'bronze', 300, {"posts":"3600:2#0 86400:300#9","articles":"3600:0#2 86400:10","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:3"}],
  ['new', 9999, 'silver', 300, {"posts":"3600:2#0 86400:300#9","articles":"3600:0#2 86400:10","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:6"}],
  ['new', 9999, 'gold', 300, {"posts":"3600:2#0 86400:300#9","articles":"3600:0#2 86400:10","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:10"}],
  ['new', 10000, 'none', 150, {"posts":"3600:2#0 86400:150#8","articles":"3600:0#2 86400:20","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:0#4"}],
  ['new', 10000, 'free', 150, {"posts":"3600:2#0 86400:150#8","articles":"3600:0#2 86400:20","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:0#4"}],
  ['new', 10000, 'founder', 300, {"posts":"3600:2#0 86400:300#9","articles":"3600:0#2 86400:20","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:10"}],
  ['new', 10000, 'bronze', 300, {"posts":"3600:2#0 86400:300#9","articles":"3600:0#2 86400:20","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:3"}],
  ['new', 10000, 'silver', 300, {"posts":"3600:2#0 86400:300#9","articles":"3600:0#2 86400:20","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:6"}],
  ['new', 10000, 'gold', 300, {"posts":"3600:2#0 86400:300#9","articles":"3600:0#2 86400:20","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:10"}],
  ['old', 0, 'none', 20, {"posts":"86400:20#1","articles":"86400:3","comments":"3600:10 86400:40","reactions":"60:60 600:300 3600:1000 86400:5000","resourceLoads":"3600:3#3 86400:0#4"}],
  ['old', 0, 'free', 20, {"posts":"86400:20#1","articles":"86400:3","comments":"3600:10 86400:40","reactions":"60:60 600:300 3600:1000 86400:5000","resourceLoads":"3600:3#3 86400:0#4"}],
  ['old', 0, 'founder', 40, {"posts":"86400:40#5","articles":"86400:3","comments":"3600:10 86400:40","reactions":"60:60 600:300 3600:1000 86400:5000","resourceLoads":"3600:3#3 86400:10"}],
  ['old', 0, 'bronze', 40, {"posts":"86400:40#5","articles":"86400:3","comments":"3600:10 86400:40","reactions":"60:60 600:300 3600:1000 86400:5000","resourceLoads":"3600:3#3 86400:3"}],
  ['old', 0, 'silver', 40, {"posts":"86400:40#5","articles":"86400:3","comments":"3600:10 86400:40","reactions":"60:60 600:300 3600:1000 86400:5000","resourceLoads":"3600:3#3 86400:6"}],
  ['old', 0, 'gold', 40, {"posts":"86400:40#5","articles":"86400:3","comments":"3600:10 86400:40","reactions":"60:60 600:300 3600:1000 86400:5000","resourceLoads":"3600:3#3 86400:10"}],
  ['old', 999, 'none', 20, {"posts":"86400:20#1","articles":"86400:3","comments":"3600:10 86400:40","reactions":"60:60 600:300 3600:1000 86400:5000","resourceLoads":"3600:3#3 86400:0#4"}],
  ['old', 999, 'free', 20, {"posts":"86400:20#1","articles":"86400:3","comments":"3600:10 86400:40","reactions":"60:60 600:300 3600:1000 86400:5000","resourceLoads":"3600:3#3 86400:0#4"}],
  ['old', 999, 'founder', 40, {"posts":"86400:40#5","articles":"86400:3","comments":"3600:10 86400:40","reactions":"60:60 600:300 3600:1000 86400:5000","resourceLoads":"3600:3#3 86400:10"}],
  ['old', 999, 'bronze', 40, {"posts":"86400:40#5","articles":"86400:3","comments":"3600:10 86400:40","reactions":"60:60 600:300 3600:1000 86400:5000","resourceLoads":"3600:3#3 86400:3"}],
  ['old', 999, 'silver', 40, {"posts":"86400:40#5","articles":"86400:3","comments":"3600:10 86400:40","reactions":"60:60 600:300 3600:1000 86400:5000","resourceLoads":"3600:3#3 86400:6"}],
  ['old', 999, 'gold', 40, {"posts":"86400:40#5","articles":"86400:3","comments":"3600:10 86400:40","reactions":"60:60 600:300 3600:1000 86400:5000","resourceLoads":"3600:3#3 86400:10"}],
  ['old', 1000, 'none', 60, {"posts":"86400:60#6","articles":"86400:5","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:0#4"}],
  ['old', 1000, 'free', 60, {"posts":"86400:60#6","articles":"86400:5","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:0#4"}],
  ['old', 1000, 'founder', 120, {"posts":"86400:120#7","articles":"86400:5","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:10"}],
  ['old', 1000, 'bronze', 120, {"posts":"86400:120#7","articles":"86400:5","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:3"}],
  ['old', 1000, 'silver', 120, {"posts":"86400:120#7","articles":"86400:5","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:6"}],
  ['old', 1000, 'gold', 120, {"posts":"86400:120#7","articles":"86400:5","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:10"}],
  ['old', 4999, 'none', 60, {"posts":"86400:60#6","articles":"86400:5","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:0#4"}],
  ['old', 4999, 'free', 60, {"posts":"86400:60#6","articles":"86400:5","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:0#4"}],
  ['old', 4999, 'founder', 120, {"posts":"86400:120#7","articles":"86400:5","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:10"}],
  ['old', 4999, 'bronze', 120, {"posts":"86400:120#7","articles":"86400:5","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:3"}],
  ['old', 4999, 'silver', 120, {"posts":"86400:120#7","articles":"86400:5","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:6"}],
  ['old', 4999, 'gold', 120, {"posts":"86400:120#7","articles":"86400:5","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:10"}],
  ['old', 5000, 'none', 150, {"posts":"86400:150#8","articles":"86400:10","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:0#4"}],
  ['old', 5000, 'free', 150, {"posts":"86400:150#8","articles":"86400:10","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:0#4"}],
  ['old', 5000, 'founder', 300, {"posts":"86400:300#9","articles":"86400:10","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:10"}],
  ['old', 5000, 'bronze', 300, {"posts":"86400:300#9","articles":"86400:10","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:3"}],
  ['old', 5000, 'silver', 300, {"posts":"86400:300#9","articles":"86400:10","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:6"}],
  ['old', 5000, 'gold', 300, {"posts":"86400:300#9","articles":"86400:10","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:10"}],
  ['old', 9999, 'none', 150, {"posts":"86400:150#8","articles":"86400:10","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:0#4"}],
  ['old', 9999, 'free', 150, {"posts":"86400:150#8","articles":"86400:10","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:0#4"}],
  ['old', 9999, 'founder', 300, {"posts":"86400:300#9","articles":"86400:10","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:10"}],
  ['old', 9999, 'bronze', 300, {"posts":"86400:300#9","articles":"86400:10","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:3"}],
  ['old', 9999, 'silver', 300, {"posts":"86400:300#9","articles":"86400:10","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:6"}],
  ['old', 9999, 'gold', 300, {"posts":"86400:300#9","articles":"86400:10","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:10"}],
  ['old', 10000, 'none', 150, {"posts":"86400:150#8","articles":"86400:20","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:0#4"}],
  ['old', 10000, 'free', 150, {"posts":"86400:150#8","articles":"86400:20","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:0#4"}],
  ['old', 10000, 'founder', 300, {"posts":"86400:300#9","articles":"86400:20","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:10"}],
  ['old', 10000, 'bronze', 300, {"posts":"86400:300#9","articles":"86400:20","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:3"}],
  ['old', 10000, 'silver', 300, {"posts":"86400:300#9","articles":"86400:20","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:6"}],
  ['old', 10000, 'gold', 300, {"posts":"86400:300#9","articles":"86400:20","comments":"3600:60 86400:480","reactions":"60:100 600:500 3600:1500 86400:8000","resourceLoads":"3600:3#3 86400:10"}],
];

const UNLOCKS = [
  {
    key: 'daily-posts:1000',
    minScore: 1000,
    label: 'Post up to 60 times a day (120 as a member)',
  },
  {
    key: 'comment-rate-limit',
    minScore: 1000,
    label: 'Higher comment limits',
  },
  {
    key: 'reaction-rate-limit',
    minScore: 1000,
    label: 'Higher reaction limits',
  },
  {
    key: 'daily-articles:1000',
    minScore: 1000,
    label: 'Publish up to 5 articles a day',
  },
  {
    key: 'daily-posts:5000',
    minScore: 5000,
    label: 'Post up to 150 times a day (300 as a member)',
  },
  {
    key: 'daily-articles:5000',
    minScore: 5000,
    label: 'Publish up to 10 articles a day',
  },
  {
    key: 'daily-articles:10000',
    minScore: 10000,
    label: 'Publish up to 20 articles a day',
  },
];

const sources: Record<Group, UsageLimitRef> = {
  posts: postRateLimits,
  articles: articleRateLimits,
  comments: commentRateLimits,
  reactions: reactionRateLimits,
  resourceLoads: resourceLoadRateLimits,
};

async function servedRules(group: Group, user: SessionUser): Promise<RateLimit[]> {
  return resolveUsageLimitRules(sources[group].usageLimitIds, user);
}

function encode(rules: RateLimit[]) {
  return [...rules]
    .sort((a, b) => a.period - b.period)
    .map((rule) => {
      const message =
        rule.errorMessage === undefined ? '' : `#${MESSAGES.indexOf(rule.errorMessage)}`;
      return `${rule.period}:${rule.limit}${message}`;
    })
    .join(' ');
}

function userFor(age: Row[0], score: number, tier: string) {
  return {
    id: 1,
    isModerator: false,
    createdAt: age === 'new' ? new Date() : new Date('2024-01-01T00:00:00Z'),
    tier: tier === 'none' ? undefined : tier,
    meta: { scores: { total: score } },
  } as SessionUser;
}

beforeEach(() => resetUsageLimitConfigCache());

describe('usage limits served today', () => {
  it.each(ROWS)(
    '%s account, score %i, tier %s',
    async (age, score, tier, dailyPostLimit, served) => {
      const user = userFor(age, score, tier);
      const actual: Record<string, string> = {};
      for (const group of Object.keys(served) as Group[])
        actual[group] = encode(await servedRules(group, user));
      expect(actual).toEqual(served);
      expect(await getDailyPostLimit(user)).toBe(dailyPostLimit);
    }
  );

  // What a refusal carries: product limits send counts, abuse limits only an id and a retry time.
  it('serves each entry under its id and kind', async () => {
    const user = userFor('new', 0, 'bronze');
    const served = [];
    for (const group of Object.keys(sources) as Group[])
      for (const rule of await servedRules(group, user)) served.push(`${rule.id}:${rule.kind}`);
    expect(served).toEqual([
      'posts.hourly:product',
      'posts.daily:product',
      'articles.first-day:abuse',
      'articles.daily:abuse',
      'comments.hourly:product',
      'comments.daily:product',
      'reactions.minute:abuse',
      'reactions.ten-minutes:abuse',
      'reactions.hourly:abuse',
      'reactions.daily:abuse',
      'resource-loads.daily:abuse',
      'resource-loads.hourly:abuse',
    ]);
  });

  it('caps auto-label per minute, the same for everyone', async () => {
    for (const user of [userFor('new', 0, 'none'), userFor('old', 10_000, 'gold')]) {
      const rules = await resolveUsageLimitRules(
        ['auto-label.upload', 'auto-label.submit', 'auto-label.poll'],
        user
      );
      expect(rules.map((rule) => `${rule.id} ${rule.period}:${rule.limit}`)).toEqual([
        'auto-label.upload 60:1000',
        'auto-label.submit 60:100',
        'auto-label.poll 60:1500',
      ]);
    }
  });

  it('lists the same posting, comment, reaction and article unlocks', () => {
    const unlocks = buildCreatorScoreUnlocks(compiledCreatorScoreUnlockInputs)
      .filter((unlock) => /^(daily-|comment-rate|reaction-rate)/.test(unlock.key))
      .map(({ key, minScore, label }) => ({ key, minScore, label }));
    expect(unlocks).toEqual(UNLOCKS);
  });
});
