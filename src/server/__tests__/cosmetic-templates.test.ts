import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cosmeticDimensionsPass,
  cosmeticImageRequirements,
} from '~/server/schema/creator-shop.schema';
import { CosmeticType } from '~/shared/utils/prisma/enums';

const TEMPLATES_DIR = join(process.cwd(), 'public/images/cosmetic-templates');

const readPngHeader = (file: string) => {
  const buf = readFileSync(join(TEMPLATES_DIR, file));
  const colorType = buf[25];
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    hasAlphaChannel: colorType === 4 || colorType === 6,
  };
};

describe('shipped Creator Shop templates', () => {
  it.each([
    ['badge.png', CosmeticType.Badge],
    ['avatar-frame.png', CosmeticType.ProfileDecoration],
    ['profile-background.png', CosmeticType.ProfileBackground],
  ])('%s passes its own submit-side dimension rule', (file, type) => {
    const req = cosmeticImageRequirements(type);
    const { width, height, hasAlphaChannel } = readPngHeader(file);
    expect({ width, height, pass: cosmeticDimensionsPass(req, width, height) }).toMatchObject({
      pass: true,
    });
    if (req.requireTransparency) expect(hasAlphaChannel).toBe(true);
  });
});
