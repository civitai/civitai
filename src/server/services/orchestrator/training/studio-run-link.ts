type LinkMeta = { trainingStudioWorkflowId?: string } | null | undefined;

/**
 * The Training Studio run a version came from: the one its own meta names, else its model's. Versions
 * carry the link since a run could be added to an existing model; a draft made before that names the
 * run on its model only. Neither key is client-writable: on Model meta they are
 * `SERVER_OWNED_META_KEYS`; on version meta the client schema (`model-version.schema.ts`) admits
 * neither.
 */
export function studioRunOfVersion(versionMeta: unknown, modelMeta: unknown): string | undefined {
  return (
    (versionMeta as LinkMeta)?.trainingStudioWorkflowId ??
    (modelMeta as LinkMeta)?.trainingStudioWorkflowId
  );
}
