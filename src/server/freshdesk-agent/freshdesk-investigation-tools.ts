import { Prisma } from '@prisma/client';
import { dbRead } from '~/server/db/client';
import { agentLog } from './freshdesk-debug';

// Helper to safely run a parameterized query and return rows (empty array on error)
async function safeQuery<T>(sql: Prisma.Sql): Promise<T[]> {
  try {
    return (await dbRead.$queryRaw<T[]>(sql)) as T[];
  } catch (err) {
    agentLog('QUERY ERROR', err instanceof Error ? err.message : String(err));
    return [];
  }
}

function formatDate(d: Date | string | null | undefined): string {
  if (!d) return 'N/A';
  const date = new Date(d);
  return date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

// ─── Query result types ──────────────────────────────────────────────

type UserRow = {
  id: number;
  username: string;
  email: string;
  createdAt: Date;
  deletedAt: Date | null;
  bannedAt: Date | null;
  muted: boolean;
  mutedAt: Date | null;
  muteExpiresAt: Date | null;
  isModerator: boolean;
  rewardsEligibility: string | null;
  browsingLevel: number;
  customerId: string | null;
  paddleCustomerId: string | null;
};

type UserStrikeRow = {
  id: number;
  reason: string;
  status: string;
  points: number;
  description: string;
  createdAt: Date;
  expiresAt: Date | null;
};

type UserRestrictionRow = {
  id: number;
  type: string;
  status: string;
  triggers: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedMessage: string | null;
  userMessage: string | null;
};

type UserProfileRow = {
  bio: string | null;
  location: string | null;
  nsfw: boolean;
};

type UserStatRow = {
  uploadCountAllTime: number;
  downloadCountAllTime: number;
  generationCountAllTime: number;
  followerCountAllTime: number;
  followingCountAllTime: number;
};

type CosmeticRow = {
  cosmeticId: number;
  name: string;
  type: string;
  source: string;
  obtainedAt: Date;
  equippedAt: Date | null;
  claimKey: string | null;
  equippedToType: string | null;
};

type CosmeticPurchaseRow = {
  cosmeticId: number;
  name: string;
  unitAmount: number;
  purchasedAt: Date;
  refunded: boolean;
};

type ChallengeWinRow = {
  place: number;
  buzzAwarded: number;
  pointsAwarded: number;
  reason: string | null;
  challengeTitle: string;
  endsAt: Date;
};

type ModelRow = {
  id: number;
  name: string;
  status: string;
  type: string;
  publishedAt: Date | null;
  deletedAt: Date | null;
  tosViolation: boolean;
  nsfwLevel: number;
  locked: boolean;
  availability: string;
};

type ImageRow = {
  id: number;
  url: string;
  nsfwLevel: number;
  ingestion: string;
  tosViolation: boolean;
  blockedFor: string | null;
  createdAt: Date;
  postId: number | null;
};

type PostRow = {
  id: number;
  title: string | null;
  publishedAt: Date | null;
  nsfwLevel: number;
  tosViolation: boolean;
  availability: string;
};

type ContentReportRow = {
  id: number;
  reason: string;
  status: string;
  createdAt: Date;
  entityType: string;
};

type SubscriptionRow = {
  id: string;
  status: string;
  buzzType: string | null;
  productName: string;
  unitAmount: number;
  currency: string;
  interval: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  endedAt: Date | null;
};

type PurchaseRow = {
  id: string;
  status: string;
  createdAt: Date;
  productName: string | null;
  unitAmount: number | null;
  currency: string | null;
};

type WithdrawalRow = {
  id: number;
  requestedBuzzAmount: number;
  status: string;
  transferredAmount: number | null;
  platformFeeRate: number | null;
  createdAt: Date;
};

type ModerationStrikeRow = {
  id: number;
  reason: string;
  status: string;
  points: number;
  description: string;
  internalNotes: string | null;
  entityType: string | null;
  entityId: number | null;
  createdAt: Date;
  expiresAt: Date | null;
  voidedAt: Date | null;
  voidReason: string | null;
};

type ModerationUserRow = {
  bannedAt: Date | null;
  muted: boolean;
  mutedAt: Date | null;
  muteExpiresAt: Date | null;
  rewardsEligibility: string | null;
  eligibilityChangedAt: Date | null;
};

type ReportRow = {
  id: number;
  reason: string;
  status: string;
  createdAt: Date;
};

// ─── TOOL: investigate_user_account ───────────────────────────────────

export async function investigateUserAccount(userId: number): Promise<string> {
  const users = await safeQuery<UserRow>(Prisma.sql`
    SELECT id, username, email, "createdAt", "deletedAt", "bannedAt",
           "muted", "mutedAt", "muteExpiresAt", "isModerator",
           "rewardsEligibility", "browsingLevel", "customerId", "paddleCustomerId"
    FROM "User"
    WHERE id = ${userId}
    LIMIT 1
  `);

  if (users.length === 0) return `No user found with ID ${userId}.`;

  const u = users[0];

  const [strikes, restrictions, profiles, stats] = await Promise.all([
    safeQuery<UserStrikeRow>(Prisma.sql`
      SELECT id, reason, status, points, description, "createdAt", "expiresAt"
      FROM "UserStrike"
      WHERE "userId" = ${userId} AND status = 'Active'
      ORDER BY "createdAt" DESC
      LIMIT 10
    `),
    safeQuery<UserRestrictionRow>(Prisma.sql`
      SELECT id, type, status, "createdAt", "resolvedAt", "userMessage"
      FROM "UserRestriction"
      WHERE "userId" = ${userId} AND status = 'Pending'
      ORDER BY "createdAt" DESC
      LIMIT 5
    `),
    safeQuery<UserProfileRow>(Prisma.sql`
      SELECT bio, location, nsfw
      FROM "UserProfile"
      WHERE "userId" = ${userId}
      LIMIT 1
    `),
    safeQuery<UserStatRow>(Prisma.sql`
      SELECT "uploadCountAllTime", "downloadCountAllTime",
             "generationCountAllTime", "followerCountAllTime",
             "followingCountAllTime"
      FROM "UserStat"
      WHERE "userId" = ${userId}
      LIMIT 1
    `),
  ]);

  const lines: string[] = [
    `=== USER ACCOUNT: ${u.username} (ID: ${userId}) ===`,
    `Email: ${u.email}`,
    `Created: ${formatDate(u.createdAt)}`,
    `Status: ${
      u.deletedAt
        ? 'DELETED (' + formatDate(u.deletedAt) + ')'
        : u.bannedAt
        ? 'BANNED (' + formatDate(u.bannedAt) + ')'
        : 'Active'
    }`,
    `Muted: ${u.muted ? 'Yes (expires: ' + formatDate(u.muteExpiresAt) + ')' : 'No'}`,
    `Moderator: ${u.isModerator ? 'Yes' : 'No'}`,
    `Rewards Eligibility: ${u.rewardsEligibility ?? 'Eligible'}`,
    `Browsing Level: ${u.browsingLevel}`,
    `Stripe Customer: ${u.customerId ?? 'None'}`,
    `Paddle Customer: ${u.paddleCustomerId ?? 'None'}`,
  ];

  if (profiles.length > 0) {
    const p = profiles[0];
    lines.push(`\nProfile: ${p.bio ? 'Has bio' : 'No bio'}, Location: ${p.location ?? 'Not set'}`);
  }

  if (stats.length > 0) {
    const s = stats[0];
    lines.push(
      `\nStats: ${s.uploadCountAllTime} uploads, ${s.downloadCountAllTime} downloads, ${s.generationCountAllTime} generations, ${s.followerCountAllTime} followers`
    );
  }

  if (strikes.length > 0) {
    lines.push(`\n--- ACTIVE STRIKES (${strikes.length}) ---`);
    for (const s of strikes) {
      lines.push(`  Strike #${s.id}: ${s.reason} (${s.points} pts) - ${s.description}`);
      lines.push(`    Created: ${formatDate(s.createdAt)}, Expires: ${formatDate(s.expiresAt)}`);
    }
  } else {
    lines.push('\nNo active strikes.');
  }

  if (restrictions.length > 0) {
    lines.push(`\n--- PENDING RESTRICTIONS (${restrictions.length}) ---`);
    for (const r of restrictions) {
      lines.push(
        `  Restriction #${r.id}: ${r.type} (${r.status}) - Created: ${formatDate(r.createdAt)}`
      );
      if (r.userMessage) lines.push(`    Message: ${r.userMessage}`);
    }
  } else {
    lines.push('No pending restrictions.');
  }

  return lines.join('\n');
}

// ─── TOOL: investigate_cosmetics ──────────────────────────────────────

export async function investigateCosmetics(userId: number): Promise<string> {
  const [cosmetics, purchases, wins] = await Promise.all([
    safeQuery<CosmeticRow>(Prisma.sql`
      SELECT uc."cosmeticId", c.name, c.type, c.source,
             uc."obtainedAt", uc."equippedAt", uc."claimKey",
             uc."equippedToType"
      FROM "UserCosmetic" uc
      JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
      WHERE uc."userId" = ${userId}
      ORDER BY uc."obtainedAt" DESC
      LIMIT 30
    `),
    safeQuery<CosmeticPurchaseRow>(Prisma.sql`
      SELECT ucsp."cosmeticId", c.name, ucsp."unitAmount",
             ucsp."purchasedAt", ucsp."refunded"
      FROM "UserCosmeticShopPurchases" ucsp
      JOIN "Cosmetic" c ON c.id = ucsp."cosmeticId"
      WHERE ucsp."userId" = ${userId}
      ORDER BY ucsp."purchasedAt" DESC
      LIMIT 15
    `),
    safeQuery<ChallengeWinRow>(Prisma.sql`
      SELECT cw.place, cw."buzzAwarded", cw."pointsAwarded", cw.reason,
             ch.title AS "challengeTitle", ch."endsAt"
      FROM "ChallengeWinner" cw
      JOIN "Challenge" ch ON ch.id = cw."challengeId"
      WHERE cw."userId" = ${userId}
      ORDER BY cw."createdAt" DESC
      LIMIT 10
    `),
  ]);

  const lines: string[] = [`=== COSMETICS & REWARDS FOR USER ${userId} ===`];

  if (cosmetics.length === 0) {
    lines.push('No cosmetics found.');
  } else {
    lines.push(`\n--- OWNED COSMETICS (${cosmetics.length}) ---`);
    for (const c of cosmetics) {
      const equipped = c.equippedAt ? ' [EQUIPPED]' : '';
      lines.push(
        `  ${c.name} (${c.type}, source: ${c.source})${equipped} - Obtained: ${formatDate(
          c.obtainedAt
        )}`
      );
    }
  }

  if (purchases.length > 0) {
    lines.push(`\n--- SHOP PURCHASES (${purchases.length}) ---`);
    for (const p of purchases) {
      const refund = p.refunded ? ' [REFUNDED]' : '';
      lines.push(`  ${p.name} - ${p.unitAmount} Buzz${refund} - ${formatDate(p.purchasedAt)}`);
    }
  } else {
    lines.push('\nNo cosmetic shop purchases.');
  }

  if (wins.length > 0) {
    lines.push(`\n--- CHALLENGE WINS (${wins.length}) ---`);
    for (const w of wins) {
      lines.push(
        `  #${w.place} in "${w.challengeTitle}" - ${w.buzzAwarded} Buzz, ${w.pointsAwarded} pts`
      );
    }
  } else {
    lines.push('\nNo challenge wins.');
  }

  return lines.join('\n');
}

// ─── TOOL: investigate_content ────────────────────────────────────────

export async function investigateContent(userId: number): Promise<string> {
  const [models, images, posts, reports] = await Promise.all([
    safeQuery<ModelRow>(Prisma.sql`
      SELECT id, name, status, type, "publishedAt", "deletedAt",
             "tosViolation", "nsfwLevel", locked, availability
      FROM "Model"
      WHERE "userId" = ${userId}
      ORDER BY "createdAt" DESC
      LIMIT 15
    `),
    safeQuery<ImageRow>(Prisma.sql`
      SELECT id, url, "nsfwLevel", ingestion, "tosViolation",
             "blockedFor", "createdAt", "postId"
      FROM "Image"
      WHERE "userId" = ${userId}
      ORDER BY "createdAt" DESC
      LIMIT 15
    `),
    safeQuery<PostRow>(Prisma.sql`
      SELECT id, title, "publishedAt", "nsfwLevel",
             "tosViolation", availability
      FROM "Post"
      WHERE "userId" = ${userId}
      ORDER BY "createdAt" DESC
      LIMIT 10
    `),
    safeQuery<ContentReportRow>(Prisma.sql`
      SELECT r.id, r.reason, r.status, r."createdAt",
             COALESCE(
               (SELECT 'Model' FROM "ModelReport" mr WHERE mr."reportId" = r.id LIMIT 1),
               (SELECT 'Image' FROM "ImageReport" ir WHERE ir."reportId" = r.id LIMIT 1),
               (SELECT 'Post' FROM "PostReport" pr WHERE pr."reportId" = r.id LIMIT 1),
               'Other'
             ) AS "entityType"
      FROM "Report" r
      WHERE r.id IN (
        SELECT "reportId" FROM "ModelReport" WHERE "modelId" IN (
          SELECT id FROM "Model" WHERE "userId" = ${userId}
        )
        UNION
        SELECT "reportId" FROM "ImageReport" WHERE "imageId" IN (
          SELECT id FROM "Image" WHERE "userId" = ${userId}
        )
      )
      ORDER BY r."createdAt" DESC
      LIMIT 10
    `),
  ]);

  const lines: string[] = [`=== CONTENT OVERVIEW FOR USER ${userId} ===`];

  lines.push(`\n--- MODELS (${models.length}) ---`);
  if (models.length === 0) {
    lines.push('  No models found.');
  } else {
    for (const m of models) {
      const flags = [
        m.tosViolation ? 'TOS_VIOLATION' : '',
        m.locked ? 'LOCKED' : '',
        m.deletedAt ? 'DELETED' : '',
      ]
        .filter(Boolean)
        .join(', ');
      lines.push(
        `  [${m.status}] "${m.name}" (ID: ${m.id}) - NSFW: ${m.nsfwLevel}, Avail: ${
          m.availability
        }${flags ? ' | ' + flags : ''}`
      );
    }
  }

  lines.push(`\n--- IMAGES (${images.length}) ---`);
  if (images.length === 0) {
    lines.push('  No images found.');
  } else {
    for (const img of images) {
      const flags = [
        img.tosViolation ? 'TOS_VIOLATION' : '',
        img.blockedFor ? `BLOCKED(${img.blockedFor})` : '',
        String(img.ingestion) !== 'Scanned' ? `ingestion:${img.ingestion}` : '',
      ]
        .filter(Boolean)
        .join(', ');
      lines.push(
        `  Image #${img.id} - NSFW: ${img.nsfwLevel}, Created: ${formatDate(img.createdAt)}${
          flags ? ' | ' + flags : ''
        }`
      );
    }
  }

  lines.push(`\n--- POSTS (${posts.length}) ---`);
  if (posts.length === 0) {
    lines.push('  No posts found.');
  } else {
    for (const p of posts) {
      lines.push(
        `  Post #${p.id}: "${p.title ?? '(untitled)'}" - Published: ${formatDate(
          p.publishedAt
        )}, Avail: ${p.availability}`
      );
    }
  }

  if (reports.length > 0) {
    lines.push(`\n--- REPORTS AGAINST CONTENT (${reports.length}) ---`);
    for (const r of reports) {
      lines.push(
        `  Report #${r.id} (${r.entityType}): ${r.reason} [${r.status}] - ${formatDate(
          r.createdAt
        )}`
      );
    }
  } else {
    lines.push('\nNo reports against user content.');
  }

  return lines.join('\n');
}

// ─── TOOL: investigate_subscription ───────────────────────────────────

export async function investigateSubscription(userId: number): Promise<string> {
  const [subscriptions, purchases, withdrawals] = await Promise.all([
    safeQuery<SubscriptionRow>(Prisma.sql`
      SELECT cs.id, cs.status, cs."buzzType",
             p.name AS "productName",
             pr."unitAmount", pr.currency, pr.interval,
             cs."currentPeriodStart", cs."currentPeriodEnd",
             cs."cancelAtPeriodEnd", cs."canceledAt", cs."endedAt"
      FROM "CustomerSubscription" cs
      JOIN "Product" p ON p.id = cs."productId"
      JOIN "Price" pr ON pr.id = cs."priceId"
      WHERE cs."userId" = ${userId}
      ORDER BY cs."createdAt" DESC
      LIMIT 5
    `),
    safeQuery<PurchaseRow>(Prisma.sql`
      SELECT pu.id, pu.status, pu."createdAt",
             p.name AS "productName",
             pr."unitAmount", pr.currency
      FROM "Purchase" pu
      LEFT JOIN "Product" p ON p.id = pu."productId"
      LEFT JOIN "Price" pr ON pr.id = pu."priceId"
      WHERE pu."userId" = ${userId}
      ORDER BY pu."createdAt" DESC
      LIMIT 10
    `),
    safeQuery<WithdrawalRow>(Prisma.sql`
      SELECT id, "requestedBuzzAmount", status, "transferredAmount",
             "platformFeeRate", "createdAt"
      FROM "BuzzWithdrawalRequest"
      WHERE "userId" = ${userId}
      ORDER BY "createdAt" DESC
      LIMIT 5
    `),
  ]);

  const lines: string[] = [`=== SUBSCRIPTION & PURCHASES FOR USER ${userId} ===`];

  if (subscriptions.length === 0) {
    lines.push('\nNo subscriptions found.');
  } else {
    lines.push(`\n--- SUBSCRIPTIONS (${subscriptions.length}) ---`);
    for (const s of subscriptions) {
      const cancel = s.cancelAtPeriodEnd ? ' [CANCELING AT PERIOD END]' : '';
      const ended = s.endedAt ? ` [ENDED: ${formatDate(s.endedAt)}]` : '';
      lines.push(
        `  ${s.productName} (${s.buzzType ?? 'N/A'}) - Status: ${s.status}${cancel}${ended}`
      );
      lines.push(`    Price: ${s.unitAmount} ${s.currency}/${s.interval}`);
      lines.push(
        `    Period: ${formatDate(s.currentPeriodStart)} to ${formatDate(s.currentPeriodEnd)}`
      );
    }
  }

  if (purchases.length > 0) {
    lines.push(`\n--- ONE-TIME PURCHASES (${purchases.length}) ---`);
    for (const p of purchases) {
      lines.push(
        `  Purchase #${p.id}: ${p.productName ?? 'Unknown'} - ${p.unitAmount ?? 0} ${
          p.currency ?? 'N/A'
        } [${p.status}] - ${formatDate(p.createdAt)}`
      );
    }
  } else {
    lines.push('\nNo one-time purchases.');
  }

  if (withdrawals.length > 0) {
    lines.push(`\n--- BUZZ WITHDRAWALS (${withdrawals.length}) ---`);
    for (const w of withdrawals) {
      const transferred = w.transferredAmount ? ` (transferred: ${w.transferredAmount})` : '';
      lines.push(
        `  Withdrawal #${w.id}: ${w.requestedBuzzAmount} Buzz [${
          w.status
        }]${transferred} - ${formatDate(w.createdAt)}`
      );
    }
  } else {
    lines.push('\nNo buzz withdrawal requests.');
  }

  lines.push(
    '\nNote: Buzz account balances are managed by an external service and cannot be queried directly. Check the Buzz admin dashboard for balance details.'
  );

  return lines.join('\n');
}

// ─── TOOL: investigate_moderation ─────────────────────────────────────

export async function investigateModeration(userId: number): Promise<string> {
  const [strikes, restrictions, filedReports, receivedReports, users] = await Promise.all([
    safeQuery<ModerationStrikeRow>(Prisma.sql`
      SELECT id, reason, status, points, description, "internalNotes",
             "entityType", "entityId", "createdAt", "expiresAt",
             "voidedAt", "voidReason"
      FROM "UserStrike"
      WHERE "userId" = ${userId}
      ORDER BY "createdAt" DESC
      LIMIT 20
    `),
    safeQuery<UserRestrictionRow>(Prisma.sql`
      SELECT id, type, status, triggers, "createdAt",
             "resolvedAt", "resolvedMessage", "userMessage"
      FROM "UserRestriction"
      WHERE "userId" = ${userId}
      ORDER BY "createdAt" DESC
      LIMIT 10
    `),
    safeQuery<ReportRow>(Prisma.sql`
      SELECT id, reason, status, "createdAt"
      FROM "Report"
      WHERE "userId" = ${userId}
      ORDER BY "createdAt" DESC
      LIMIT 10
    `),
    safeQuery<ReportRow>(Prisma.sql`
      SELECT r.id, r.reason, r.status, r."createdAt"
      FROM "Report" r
      JOIN "UserReport" ur ON ur."reportId" = r.id
      WHERE ur."userId" = ${userId}
      ORDER BY r."createdAt" DESC
      LIMIT 10
    `),
    safeQuery<ModerationUserRow>(Prisma.sql`
      SELECT "bannedAt", "muted", "mutedAt", "muteExpiresAt",
             "rewardsEligibility", "eligibilityChangedAt"
      FROM "User"
      WHERE id = ${userId}
      LIMIT 1
    `),
  ]);

  const lines: string[] = [`=== MODERATION HISTORY FOR USER ${userId} ===`];

  if (users.length > 0) {
    const u = users[0];
    lines.push('\n--- CURRENT STATUS ---');
    lines.push(`  Banned: ${u.bannedAt ? 'Yes (' + formatDate(u.bannedAt) + ')' : 'No'}`);
    lines.push(`  Muted: ${u.muted ? 'Yes (expires: ' + formatDate(u.muteExpiresAt) + ')' : 'No'}`);
    lines.push(`  Rewards: ${u.rewardsEligibility ?? 'Eligible'}`);
  }

  const activeStrikes = strikes.filter((s) => s.status === 'Active');
  const totalPoints = activeStrikes.reduce((sum, s) => sum + s.points, 0);
  lines.push(
    `\n--- STRIKES (${strikes.length} total, ${activeStrikes.length} active, ${totalPoints} active pts) ---`
  );

  if (strikes.length === 0) {
    lines.push('  No strikes on record.');
  } else {
    for (const s of strikes) {
      const voided = s.voidedAt ? ` [VOIDED: ${s.voidReason ?? 'No reason'}]` : '';
      lines.push(`  Strike #${s.id} [${s.status}]: ${s.reason} (${s.points} pts)${voided}`);
      lines.push(`    ${s.description}`);
      if (s.entityType) lines.push(`    Entity: ${s.entityType} #${s.entityId ?? 'N/A'}`);
      lines.push(`    Created: ${formatDate(s.createdAt)}, Expires: ${formatDate(s.expiresAt)}`);
    }
  }

  if (restrictions.length > 0) {
    lines.push(`\n--- RESTRICTIONS (${restrictions.length}) ---`);
    for (const r of restrictions) {
      lines.push(`  Restriction #${r.id}: ${r.type} [${r.status}] - ${formatDate(r.createdAt)}`);
      if (r.resolvedAt)
        lines.push(`    Resolved: ${formatDate(r.resolvedAt)} - ${r.resolvedMessage ?? ''}`);
      if (r.userMessage) lines.push(`    User message: ${r.userMessage}`);
    }
  } else {
    lines.push('\nNo restrictions on record.');
  }

  lines.push(`\n--- REPORTS AGAINST USER (${receivedReports.length}) ---`);
  if (receivedReports.length === 0) {
    lines.push('  No reports against user.');
  } else {
    for (const r of receivedReports) {
      lines.push(`  Report #${r.id}: ${r.reason} [${r.status}] - ${formatDate(r.createdAt)}`);
    }
  }

  lines.push(`\n--- REPORTS FILED BY USER (${filedReports.length}) ---`);
  if (filedReports.length === 0) {
    lines.push('  No reports filed by user.');
  } else {
    for (const r of filedReports) {
      lines.push(`  Report #${r.id}: ${r.reason} [${r.status}] - ${formatDate(r.createdAt)}`);
    }
  }

  return lines.join('\n');
}
