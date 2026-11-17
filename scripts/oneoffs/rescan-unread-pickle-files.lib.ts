/** The ids a run is narrowed to: none, or files, or versions, never both. */
export function idFilter(fileIdsArg?: string, versionIdsArg?: string) {
  if (fileIdsArg && versionIdsArg) throw new Error('Pass --file-ids or --version-ids, not both');
  const parse = (name: string, value: string) => {
    const ids = value.split(',').map(Number);
    if (!ids.length || ids.some((id) => !Number.isInteger(id) || id <= 0))
      throw new Error(`--${name} must be a comma-separated list of positive ids`);
    return [...new Set(ids)];
  };
  if (fileIdsArg) return { fileIds: parse('file-ids', fileIdsArg) };
  if (versionIdsArg) return { versionIds: parse('version-ids', versionIdsArg) };
  return {};
}

/** The files of the asked versions, and every asked version that has none of them. */
export function expandVersions(
  versionIds: number[],
  files: { id: number; modelVersionId: number }[]
) {
  const withFiles = new Set(files.map((f) => f.modelVersionId));
  return {
    fileIds: files.filter((f) => versionIds.includes(f.modelVersionId)).map((f) => f.id),
    versionsWithoutFiles: versionIds.filter((id) => !withFiles.has(id)),
  };
}
