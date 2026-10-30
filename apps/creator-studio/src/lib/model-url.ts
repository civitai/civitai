import { Flags, NsfwLevel, sfwBrowsingLevelsFlag } from '@civitai/shared';

// R+ maturity bits (R/X/XXX). Blocked is a TOS action, not a rating, so it's not part of "R+".
const matureLevelsFlag = Flags.arrayToInstance([NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX]);

// A model routes to civitai.red (mature) when it's flagged `nsfw`, or its nsfwLevel is R+ (has an R/X/XXX bit)
// with no PG/PG13 bit — i.e. mature-only content, no all-ages rating mixed in.
export function isMatureModel({
  nsfw,
  nsfwLevel,
}: {
  nsfw?: boolean;
  nsfwLevel?: number;
}): boolean {
  if (nsfw) return true;
  const level = nsfwLevel ?? 0;
  return (
    Flags.intersects(level, matureLevelsFlag) && !Flags.intersects(level, sfwBrowsingLevelsFlag)
  );
}

// Every link out of the Studio to public content goes through here. The rule was hand-rolled as
// `nsfwLevel > 3` at five call sites, which is not the same test: it sends a mixed rating (PG13|R) and a
// Blocked item to civitai.red, where `isMatureModel` — the rule this app actually documents — says .com.
export function civitaiUrl(path: string, entity: { nsfw?: boolean; nsfwLevel?: number }): string {
  const domain = isMatureModel(entity) ? 'civitai.red' : 'civitai.com';
  return `https://${domain}/${path.replace(/^\//, '')}`;
}

export function modelUrl(modelId: number, model: { nsfw?: boolean; nsfwLevel?: number }): string {
  return civitaiUrl(`models/${modelId}`, model);
}
