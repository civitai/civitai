// Kept in step by hand with `MAX_BLURBS_PER_USER` in `~/server/services/blurb.service`, which is
// the enforcement point. The picker needs the ceiling client-side and that module reaches Prisma,
// so it cannot be the import.
export const MAX_BLURBS_PER_USER = 20;
