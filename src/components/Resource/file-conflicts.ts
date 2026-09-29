import { getModelFileFormat } from '~/utils/file-helpers';

type ConflictCandidate = {
  name: string;
  type?: string | null;
  size?: string | null;
  fp?: string | null;
  quantType?: string | null;
};

export function getSimilarFiles<T extends ConflictCandidate>(files: T[]) {
  const groups = new Map<string, T[]>();
  for (const file of files) {
    // Positional so absent fields can't collapse two distinct files onto the same key.
    const key = [file.size, file.type, file.fp, getModelFileFormat(file.name), file.quantType]
      .map((value) => value ?? '')
      .join('|');
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }

  const similar: T[][] = [];
  for (const group of groups.values()) {
    // Component files need none of size/fp/quantType, so two bare Text Encoders
    // have nothing to disambiguate on and aren't a real conflict.
    if (group.length < 2 || !group.some((f) => f.size || f.fp || f.quantType)) continue;
    similar.push(group);
  }

  return similar;
}
