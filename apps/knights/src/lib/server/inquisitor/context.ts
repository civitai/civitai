import { sql, type Kysely } from 'kysely';
import { readVoteTallies, tallyByAnswer, type KnightsAnswerTally } from '@civitai/db/knights';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { KNIGHTS_NSFW_LEVEL_QUESTION } from '@civitai/shared/new-order';
import { civitaiSiteUrl } from '../site-url';
import type { ReviewOffer } from './review.service';

export type ReviewSidebar = {
  /** The players' settled level, by its label. */
  consensus: string;
  /** The image's level now, by its label. */
  current: string;
  /** The settled item's counted votes, by answer and the stage they came at. */
  votes: KnightsAnswerTally[];
  imageUrl: string;
  postUrl: string | null;
  prompt: string | null;
  creator: { username: string; url: string } | null;
};

/** What a moderator sees beside a review: the Knights' verdict and where to look the image up on the site. */
export async function reviewSidebar(
  db: Kysely<DB>,
  review: Pick<ReviewOffer, 'queueItemId' | 'imageId' | 'consensusValue' | 'currentLevel'>
): Promise<ReviewSidebar> {
  const [question, tallies, image] = await Promise.all([
    db
      .selectFrom('KnightsQuestion')
      .select('options')
      .where('key', '=', KNIGHTS_NSFW_LEVEL_QUESTION)
      .executeTakeFirst(),
    readVoteTallies(db, [review.queueItemId]),
    db
      .selectFrom('Image as img')
      .leftJoin('User as u', 'u.id', 'img.userId')
      .select([
        'img.postId',
        'u.username',
        sql<string | null>`"img"."meta"->>'prompt'`.as('prompt'),
      ])
      .where('img.id', '=', review.imageId)
      .executeTakeFirst(),
  ]);
  const options = Array.isArray(question?.options)
    ? (question.options as { value: string; label: string }[])
    : [];
  const labels = new Map(options.map((o) => [o.value, o.label]));
  const site = civitaiSiteUrl();
  return {
    consensus: labels.get(review.consensusValue) ?? review.consensusValue,
    current: labels.get(String(review.currentLevel)) ?? String(review.currentLevel),
    votes: tallyByAnswer(tallies, labels),
    imageUrl: `${site}/images/${review.imageId}`,
    postUrl: image?.postId ? `${site}/posts/${image.postId}` : null,
    prompt: image?.prompt ?? null,
    creator: image?.username
      ? { username: image.username, url: `${site}/user/${encodeURIComponent(image.username)}` }
      : null,
  };
}

export type ModeratorStats = {
  votesThisWeek: number;
  /** Open reviews this moderator has not voted on and may vote on (not of their own images). */
  waiting: number;
  /** Of the closed reviews they voted on, the share the other moderator gave the same level; null with none. */
  agreementRate: number | null;
};

const WEEK_MS = 7 * 86_400_000;

export async function moderatorStats(
  db: Kysely<DB>,
  { moderatorId, now }: { moderatorId: number; now: Date }
): Promise<ModeratorStats> {
  const [week, waiting, closed] = await Promise.all([
    db
      .selectFrom('KnightsInquisitorVote')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('moderatorId', '=', moderatorId)
      .where('createdAt', '>=', utc(new Date(now.getTime() - WEEK_MS)))
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('KnightsInquisitorReview as r')
      .innerJoin('Image as img', 'img.id', 'r.imageId')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('r.status', '=', 'open')
      .where('img.userId', 'is distinct from', moderatorId)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('KnightsInquisitorVote as v')
              .select(sql<number>`1`.as('one'))
              .whereRef('v.reviewId', '=', 'r.id')
              .where('v.moderatorId', '=', moderatorId)
          )
        )
      )
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('KnightsInquisitorReview as r')
      .innerJoin('KnightsInquisitorVote as v', 'v.reviewId', 'r.id')
      .select([
        sql<number>`count(*) FILTER (WHERE "r"."status" = 'confirmed')::int`.as('agreed'),
        sql<number>`count(*)::int`.as('n'),
      ])
      .where('v.moderatorId', '=', moderatorId)
      .where('r.status', 'in', ['confirmed', 'split'])
      .executeTakeFirstOrThrow(),
  ]);
  return {
    votesThisWeek: Number(week.n),
    waiting: Number(waiting.n),
    agreementRate: Number(closed.n) > 0 ? Number(closed.agreed) / Number(closed.n) : null,
  };
}
