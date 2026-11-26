// Training Studio's New-training autosave database (`apps/training-studio/src/routes/flowDraft.ts`).
// Both sign-outs — the Studio's own and the main app's — delete it, so a shared browser keeps no one's
// dataset past sign-out.
export const FLOW_DRAFT_DB = 'civitai-training-studio';

/** Delete every user's draft. Resolves after `timeoutMs` at most, so a sign-out never hangs on it. */
export function deleteFlowDrafts(timeoutMs = 1000): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, timeoutMs);
    try {
      const req = indexedDB.deleteDatabase(FLOW_DRAFT_DB);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}
