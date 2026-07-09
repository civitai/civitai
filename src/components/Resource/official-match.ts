// Returns the file's SHA256 if it's a dedup candidate worth a server link attempt, else null.
// The host's declared type does NOT gate this — a file dropped in the main file section is
// checked too, so it can't be used to bypass dedup (the server links nothing for a genuine
// checkpoint match).
export async function resolveOfficialFileHash(args: {
  file: File;
  findBySize: (size: number) => Promise<boolean>;
  hashFile: (file: File) => Promise<string | null>;
  // Only fired when a size collision requires hashing — skipped on immediate size-miss,
  // so the UI shows the "checking" indicator only when there's real work.
  onHashStart?: () => void;
}): Promise<string | null> {
  const { file, findBySize, hashFile, onHashStart } = args;

  const hasSizeMatch = await findBySize(file.size);
  if (!hasSizeMatch) return null;

  onHashStart?.();
  return hashFile(file); // null if over cap or worker error → fall through to normal upload
}
