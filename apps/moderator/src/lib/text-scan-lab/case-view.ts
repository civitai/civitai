import { commentV2Url, entityUrl, userLookupUrl } from '../entity-url';
import { ENTITY_TYPE_NAMES } from './labels';
import type { LabEntityType, LabField } from './types';

export function casePreview(fields: readonly LabField[] | null, max = 140): string | null {
  if (!fields) return null;
  const text = fields
    .map((f) => f.text.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' · ');
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export function caseSourceHref(
  civitaiUrl: string,
  entityType: LabEntityType,
  entityId: number | null
): string | null {
  if (entityId === null) return null;
  if (entityType === 'CommentV2') return commentV2Url(civitaiUrl, entityId);
  // A UserProfile's id is its user's id.
  if (entityType === 'User' || entityType === 'UserProfile') return userLookupUrl(entityId);
  return entityUrl(civitaiUrl, entityType, entityId);
}

export const caseTitle = (entityType: LabEntityType, entityId: number | null): string =>
  `${ENTITY_TYPE_NAMES[entityType]} ${entityId ?? 'text'}`;
