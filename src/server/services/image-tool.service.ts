import type { ImageMetaProps } from '~/server/schema/image.schema';
import {
  getToolByAlias,
  getToolByDomain,
  getToolByName,
  getToolIdsByAliasesOrNames,
} from '~/server/services/tool.service';
import { normalizeMetadataToolNames } from '~/utils/metadata/declared-tools.metadata';

export async function resolveImageToolIds(meta?: ImageMetaProps | null) {
  let primaryToolId: number | undefined;
  const { name: sourceName, homepage: sourceHomepage } = meta?.external?.source ?? {};

  if (meta && 'engine' in meta) {
    primaryToolId = (await getToolByAlias(meta.engine as string))?.id;
    if (!primaryToolId) primaryToolId = (await getToolByName(meta.engine as string))?.id;
  } else if (sourceName || sourceHomepage) {
    if (sourceName) primaryToolId = (await getToolByName(sourceName))?.id;
    if (sourceHomepage && !primaryToolId) {
      primaryToolId = (await getToolByDomain(sourceHomepage))?.id;
    }
  }

  const additionalToolNames = normalizeMetadataToolNames(meta?.tools);
  const additionalToolIds = additionalToolNames
    ? await getToolIdsByAliasesOrNames(additionalToolNames).catch(() => [])
    : [];
  const toolIds = [...new Set([...(primaryToolId ? [primaryToolId] : []), ...additionalToolIds])];

  return toolIds.length ? toolIds : undefined;
}
