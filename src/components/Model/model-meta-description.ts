import { truncate } from 'lodash-es';
import { abbreviateNumber } from '~/utils/number-helpers';
import { removeTags } from '~/utils/string-helpers';

/** Google cuts snippets by pixel width, roughly this many characters. */
const MAX_LENGTH = 155;

export function buildModelMetaDescription({
  name,
  ecosystemName,
  typeName,
  creator,
  downloads = 0,
  likes = 0,
  description,
}: {
  name: string;
  ecosystemName: string;
  typeName: string;
  creator?: string | null;
  downloads?: number | null;
  likes?: number | null;
  description?: string | null;
}) {
  const lead = `${name} is a ${ecosystemName} ${typeName}${creator ? ` by ${creator}` : ''}.`;
  const stats = [
    downloads ? `${abbreviateNumber(downloads)} downloads` : null,
    likes ? `${abbreviateNumber(likes)} likes` : null,
  ].filter(Boolean);
  const own = removeTags(description ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const parts = [lead, stats.length ? `${stats.join(', ')}.` : null, own || null].filter(Boolean);
  return truncate(parts.join(' '), { length: MAX_LENGTH, separator: ' ' });
}
