import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * A service review image opens by id only on an offering a visitor may open. The offering page asks
 * that through Prisma (`listableServiceOfferingWhere` and the shop check); the image read asks it in
 * SQL (`viewableServiceOfferingSql`). A term added to or dropped from one side alone would open review
 * images on offerings whose page is closed, or close them on open ones.
 */
const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const offeringService = read('src/server/services/creator-service.service.ts');
const shopService = read('src/server/services/creator-shop.service.ts');
const fragment = read('src/server/services/creator-service-offering-viewable-sql.ts');

const body = (source: string, start: string) => {
  const from = source.indexOf(start);
  expect(from, `${start} not found`).toBeGreaterThan(-1);
  return source.slice(from, source.indexOf('\n};', from));
};
const listable = body(offeringService, 'const listableServiceOfferingWhere = (');

describe('the offering a review image needs matches the offering page', () => {
  it('asks for the same offering status', () => {
    const prisma = [...listable.matchAll(/status: ServiceOfferingStatus\.(\w+)/g)].map((m) => m[1]);
    const sql = [...fragment.matchAll(/vo\."status" = '(\w+)'/g)].map((m) => m[1]);
    expect(prisma).toHaveLength(1);
    expect(sql).toEqual(prisma);
  });

  it('asks the same of the seller', () => {
    const seller = listable.match(/seller: \{([^}]*)\}/)?.[1] ?? '';
    const prisma = [...seller.matchAll(/(\w+): (null|false)/g)]
      .map(([, field, value]) => `${field}=${value}`)
      .sort();
    const sql = [
      ...[...fragment.matchAll(/vs\."(\w+)" IS NULL/g)].map((m) => `${m[1]}=null`),
      ...[...fragment.matchAll(/NOT vs\."(\w+)"/g)].map((m) => `${m[1]}=false`),
    ].sort();
    expect(prisma.length).toBeGreaterThan(0);
    expect(sql).toEqual(prisma);
  });

  it('asks for a shop that is on, with an unset setting off', () => {
    expect(shopService).toContain(
      "if (enabled !== true) throw throwNotFoundError('Shop not found');"
    );
    expect(shopService).toContain('return settings.creatorShop ?? {};');
    expect(fragment).toContain(`vs."settings" -> 'creatorShop' -> 'enabled' = 'true'::jsonb`);
  });
});
