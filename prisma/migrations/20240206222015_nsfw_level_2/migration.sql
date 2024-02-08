
-- AlterTable
ALTER TABLE "Tag" ADD COLUMN     "nsfwLevel" INTEGER NOT NULL DEFAULT 1;

update "Tag" set "nsfwLevel" = 2 where name = ANY('{"corpses","revealing clothes","physical violence","weapon violence"}');
update "Tag" set "nsfwLevel" = 4 where name = ANY('{"partial nudity","disturbing","emaciated bodies","graphic violence or gore","female swimwear or underwear","male swimwear or underwear","sexual situations"}');
update "Tag" set "nsfwLevel" = 8 where name = ANY('{"nudity","adult toys","sexual activity"}');
update "Tag" set "nsfwLevel" = 16 where name = ANY('{"illustrated explicit nudity","graphic female nudity","graphic male nudity"}');
update "Tag" set "nsfwLevel" = 32 where name = ANY('{"extremist","hanging","hate symbols","nazi party","self injury","white supremacy"}');

