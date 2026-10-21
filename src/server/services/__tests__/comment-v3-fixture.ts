import { readFileSync } from 'fs';
import path from 'path';

// The old comment tables, their cascades and the old count trigger, as the CommentV3 migrations find
// them in prod.

export const migration = (name: string) =>
  readFileSync(
    path.resolve(
      __dirname,
      `../../../../packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`
    ),
    'utf8'
  );

export const ENTITY_TABLES = [
  'Model',
  'Image',
  'Post',
  'Article',
  'ResourceReview',
  'Bounty',
  'BountyEntry',
  'Challenge',
  'Model3D',
  'Model3DReview',
  'Crucible',
];

export const FIXTURE = `
CREATE TABLE "User"(id serial PRIMARY KEY);
CREATE TABLE "Report"(id serial PRIMARY KEY);
CREATE TYPE "ReviewReactions" AS ENUM ('Like','Dislike','Laugh','Cry','Heart');
${ENTITY_TABLES.map((t) => `CREATE TABLE "${t}"(id serial PRIMARY KEY);`).join('\n')}
CREATE TABLE "ComicChapter"(id serial UNIQUE NOT NULL, "projectId" int NOT NULL, position int NOT NULL, PRIMARY KEY ("projectId", position));
CREATE TABLE app_listings(id text PRIMARY KEY, serial_id serial UNIQUE);

CREATE TABLE "Comment"(
  id serial PRIMARY KEY, content text NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT now(), "updatedAt" timestamp(3) NOT NULL DEFAULT now(),
  nsfw boolean DEFAULT false, "tosViolation" boolean NOT NULL DEFAULT false,
  "parentId" int REFERENCES "Comment"(id) ON DELETE CASCADE,
  "userId" int NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  "modelId" int NOT NULL REFERENCES "Model"(id) ON DELETE CASCADE,
  locked boolean DEFAULT false, hidden boolean DEFAULT false, "pinnedAt" timestamp(3));

CREATE TABLE "Thread"(
  id serial PRIMARY KEY, locked boolean NOT NULL DEFAULT false,
  "parentThreadId" int REFERENCES "Thread"(id) ON DELETE CASCADE,
  "rootThreadId" int REFERENCES "Thread"(id) ON DELETE CASCADE,
  "questionId" int UNIQUE, "answerId" int UNIQUE,
  "imageId" int UNIQUE REFERENCES "Image"(id) ON DELETE CASCADE,
  "postId" int UNIQUE REFERENCES "Post"(id) ON DELETE CASCADE,
  "reviewId" int UNIQUE REFERENCES "ResourceReview"(id) ON DELETE CASCADE,
  "commentId" int UNIQUE,
  "modelId" int UNIQUE REFERENCES "Model"(id) ON DELETE CASCADE,
  "articleId" int UNIQUE REFERENCES "Article"(id) ON DELETE CASCADE,
  "bountyId" int UNIQUE REFERENCES "Bounty"(id) ON DELETE CASCADE,
  "bountyEntryId" int UNIQUE REFERENCES "BountyEntry"(id) ON DELETE CASCADE,
  "clubPostId" int UNIQUE,
  "comicProjectId" int, "comicChapterPosition" int,
  "challengeId" int UNIQUE REFERENCES "Challenge"(id) ON DELETE CASCADE,
  "model3dId" int UNIQUE REFERENCES "Model3D"(id) ON DELETE CASCADE,
  "model3dReviewId" int UNIQUE REFERENCES "Model3DReview"(id) ON DELETE CASCADE,
  "appListingId" int UNIQUE REFERENCES app_listings(serial_id) ON DELETE CASCADE,
  "crucibleId" int UNIQUE REFERENCES "Crucible"(id) ON DELETE CASCADE,
  metadata jsonb NOT NULL DEFAULT '{}', "commentCount" int NOT NULL DEFAULT 0,
  UNIQUE ("comicProjectId", "comicChapterPosition"),
  FOREIGN KEY ("comicProjectId", "comicChapterPosition") REFERENCES "ComicChapter"("projectId", position) ON DELETE CASCADE ON UPDATE CASCADE);

CREATE TABLE "CommentV2"(
  id serial PRIMARY KEY, content text NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT now(), "updatedAt" timestamp(3) NOT NULL DEFAULT now(),
  nsfw boolean DEFAULT false, "tosViolation" boolean NOT NULL DEFAULT false,
  "userId" int NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  "threadId" int NOT NULL REFERENCES "Thread"(id) ON DELETE CASCADE,
  metadata jsonb, hidden boolean DEFAULT false, "pinnedAt" timestamp(3), "reactionCount" int NOT NULL DEFAULT 0);
ALTER TABLE "Thread" ADD FOREIGN KEY ("commentId") REFERENCES "CommentV2"(id) ON DELETE SET NULL;

CREATE TABLE "CommentReaction"(id serial PRIMARY KEY, "commentId" int NOT NULL REFERENCES "Comment"(id) ON DELETE CASCADE,
  "userId" int NOT NULL REFERENCES "User"(id) ON DELETE CASCADE, reaction "ReviewReactions" NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT now(), "updatedAt" timestamp(3) NOT NULL DEFAULT now(), UNIQUE ("commentId","userId",reaction));
CREATE TABLE "CommentV2Reaction"(id serial PRIMARY KEY, "commentId" int NOT NULL REFERENCES "CommentV2"(id) ON DELETE CASCADE,
  "userId" int NOT NULL REFERENCES "User"(id) ON DELETE CASCADE, reaction "ReviewReactions" NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT now(), "updatedAt" timestamp(3) NOT NULL DEFAULT now(), UNIQUE ("commentId","userId",reaction));
CREATE TABLE "CommentReport"("commentId" int NOT NULL REFERENCES "Comment"(id) ON DELETE CASCADE,
  "reportId" int NOT NULL UNIQUE REFERENCES "Report"(id) ON DELETE CASCADE, PRIMARY KEY ("reportId","commentId"));
CREATE TABLE "CommentV2Report"("commentV2Id" int NOT NULL REFERENCES "CommentV2"(id) ON DELETE CASCADE,
  "reportId" int NOT NULL UNIQUE REFERENCES "Report"(id) ON DELETE CASCADE, PRIMARY KEY ("reportId","commentV2Id"));
CREATE TABLE "ThreadMute"("userId" int NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  "threadId" int NOT NULL REFERENCES "Thread"(id) ON DELETE CASCADE, "mutedAt" timestamp(3) NOT NULL DEFAULT now(), PRIMARY KEY ("userId","threadId"));

CREATE FUNCTION update_thread_comment_count() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN UPDATE "Thread" SET "commentCount" = "commentCount" + 1 WHERE id = NEW."threadId";
  ELSIF TG_OP = 'DELETE' THEN UPDATE "Thread" SET "commentCount" = "commentCount" - 1 WHERE id = OLD."threadId"; END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER comment_count_update AFTER INSERT OR DELETE ON "CommentV2" FOR EACH ROW EXECUTE FUNCTION update_thread_comment_count();

INSERT INTO "User" SELECT generate_series(1, 10);
INSERT INTO "Model" SELECT generate_series(1, 5);
INSERT INTO "Image" SELECT generate_series(10, 20);
INSERT INTO "Article" SELECT generate_series(1, 3);
INSERT INTO "ComicChapter"(id, "projectId", position) VALUES (77, 5, 2);
INSERT INTO app_listings(id, serial_id) VALUES ('01ULID', 9);
INSERT INTO "Report" SELECT generate_series(1, 20);
`;

// Splits a migration the way psql -f feeds it: one statement per round trip, so a failure leaves BEGIN open.
export const statementsOf = (sql: string) => {
  const out: string[] = [];
  let buf = '';
  let inBody = false;
  for (const line of sql.split('\n')) {
    if (!inBody && line.trim().startsWith('--')) continue;
    buf += line + '\n';
    if ((line.match(/\$\$/g) ?? []).length % 2 === 1) inBody = !inBody;
    if (!inBody && line.trim().endsWith(';')) {
      out.push(buf.trim());
      buf = '';
    }
  }
  return out;
};
