import * as z from 'zod';
import { CollectionItemStatus } from '~/shared/utils/prisma/enums';

export const contestScoreSignals = [
  'imageAuthors',
  'reactors',
  'downloaders',
  'generators',
  'collectors',
] as const;
export type ContestScoreSignal = (typeof contestScoreSignals)[number];

const windowShape = {
  collectionId: z.number().int().positive(),
  start: z.coerce.date().optional(),
  end: z.coerce.date().optional(),
  tagIds: z.array(z.number().int().positive()).max(50).optional(),
  statuses: z.array(z.enum(CollectionItemStatus)).min(1).max(3).optional(),
};

const orderedWindow = (data: { start?: Date; end?: Date }) =>
  !data.start || !data.end || data.start < data.end;
const orderedWindowError = { message: 'start must precede end', path: ['end'] };

export type GetCommunityScoreInput = z.infer<typeof getCommunityScoreSchema>;
export const getCommunityScoreSchema = z
  .object({ ...windowShape, refresh: z.boolean().optional() })
  .refine(orderedWindow, orderedWindowError);

export type GetContestCandidatesInput = z.infer<typeof getContestCandidatesSchema>;
export const getContestCandidatesSchema = z
  .object({ ...windowShape, limit: z.number().int().positive().max(1000).optional() })
  .refine(orderedWindow, orderedWindowError);

export type CreateContestSnapshotInput = z.infer<typeof createContestSnapshotSchema>;
export const createContestSnapshotSchema = z
  .object({ ...windowShape, note: z.string().max(500).optional() })
  .refine(orderedWindow, orderedWindowError);

export type ListContestSnapshotsInput = z.infer<typeof listContestSnapshotsSchema>;
export const listContestSnapshotsSchema = z.object({
  collectionId: z.number().int().positive(),
});
