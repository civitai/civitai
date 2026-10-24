import type { ModelFileType } from '~/server/common/constants';

export type AttachSelection = { id: number; type: ModelFileType };

export type AttachOutcome = {
  /** Model file ids created, in the order they were created. */
  modelFileIds: number[];
  failures: string[];
};

/**
 * Attaches each chosen import in turn.
 *
 * Sequential on purpose: each attach awaits a storage-resolver registration and a scan
 * submission, so a parallel batch multiplies that load for no user-visible gain.
 *
 * 🔴 Every item is attempted even after one fails, and the caller is told which files were
 * CREATED, not merely how many succeeded. A failure here is not "nothing happened": the router
 * creates the `ModelFile` first and only then claims the import, so losing that claim leaves a
 * real file behind whose id is the only way to find it again.
 */
export async function attachImports({
  chosen,
  modelVersionId,
  attachOne,
}: {
  chosen: AttachSelection[];
  modelVersionId: number;
  attachOne: (input: {
    id: number;
    modelVersionId: number;
    type: ModelFileType;
  }) => Promise<{ modelFileId: number }>;
}): Promise<AttachOutcome> {
  const modelFileIds: number[] = [];
  const failures: string[] = [];

  for (const item of chosen) {
    try {
      const result = await attachOne({ id: item.id, modelVersionId, type: item.type });
      modelFileIds.push(result.modelFileId);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  return { modelFileIds, failures };
}
