
-- AlterTable
ALTER TABLE "Tag" ADD COLUMN     "nsfwLevel" INTEGER NOT NULL DEFAULT 0;

update "Tag" set "nsfwLevel" = -1 where name = ANY('{"extremist","hanging","hate symbols","nazi party","self injury","white supremacy"}');
update "Tag" set "nsfwLevel" = 1 where name = ANY('{"corpses","revealing clothes","sexual situations","physical violence","weapon violence","female swimwear or underwear","male swimwear or underwear"}');
update "Tag" set "nsfwLevel" = 2 where name = ANY('{"partial nudity","disturbing","emaciated bodies","graphic violence or gore"}');
update "Tag" set "nsfwLevel" = 3 where name = ANY('{"nudity","adult toys","sexual activity"}');
update "Tag" set "nsfwLevel" = 4 where name = ANY('{"illustrated explicit nudity","graphic female nudity","graphic male nudity"}');
