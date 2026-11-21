import { Prisma } from '@prisma/client';

/** SQL: true when a User `meta` column holds ban notes, internal or external, naming CSAM or NCMEC. */
export const banNoteNamesCsamSql = (meta: Prisma.Sql) => Prisma.sql`concat_ws(' ',
  ${meta} -> 'banDetails' ->> 'detailsInternal',
  ${meta} -> 'banDetails' ->> 'detailsExternal') ~* '(csam|ncmec)'`;
