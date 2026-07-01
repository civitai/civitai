// Returns the file's SHA256 if it's a dedup candidate worth a server link attempt, else null.
// Staged cheap→definitive check: size gate → worker hash. The host's declared type
// does NOT gate this — a file dropped in the main file section is checked too, so it
// can't be used to bypass dedup. The server decides what (if anything) it links; a
// genuine checkpoint match links nothing. Every early exit means "upload normally".
export async function resolveOfficialFileHash(args: {
  file: File;
  findBySize: (size: number) => Promise<{ id: number }[]>;
  hashFile: (file: File) => Promise<string | null>;
  // Fired once, only when a size collision means we're about to hash the file
  // (the slow step) — lets the UI show a "checking" indicator only when needed.
  onHashStart?: () => void;
}): Promise<string | null> {
  const { file, findBySize, hashFile, onHashStart } = args;

  const sized = await findBySize(file.size);
  if (sized.length === 0) return null;

  onHashStart?.();
  return hashFile(file); // null if over cap or worker error → fall through to normal upload
}
