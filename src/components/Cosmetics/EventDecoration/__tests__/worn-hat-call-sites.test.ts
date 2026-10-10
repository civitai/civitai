import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getEventDecorationDefinition } from '~/shared/constants/event-decoration.constants';

/**
 * Each card that draws a worn hat names the content under it by hand, and a wrong pair (a model
 * card saying 'Image', a version id for a model id) makes its popover ask about the wrong thing.
 * The render test drives one card end to end; this pins the pair at every other call site, the
 * templates that carry it down to TwCosmeticWrapper, and that no hatted card is missing from the list.
 */

const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');

// Every card that passes `eventDecoration=`, with the content it wears it on.
const CALL_SITES: [file: string, expected: string][] = [
  [
    'src/components/Cards/ArticleCard.tsx',
    "eventDecorationOn={{ entityType: 'Article', entityId: id }}",
  ],
  [
    'src/components/Cards/ModelCard.tsx',
    "eventDecorationOn={{ entityType: 'Model', entityId: data.id }}",
  ],
  [
    'src/components/Cards/ImageCard.tsx',
    "eventDecorationOn={{ entityType: 'Image', entityId: data.id }}",
  ],
  [
    // A Showcase card wears the hat of what it stands for; getGenericCardWornOn is pinned in
    // generic-image-card-worn-on.test.ts.
    'src/components/Cards/GenericImageCard.tsx',
    'eventDecorationOn={getGenericCardWornOn(image.id, entityType, entityId)}',
  ],
  [
    'src/components/Image/Infinite/ImagesCard.tsx',
    "eventDecorationOn={{ entityType: 'Image', entityId: image.id }}",
  ],
  [
    'src/components/CreatorShop/Storefront/ModelShopCard.tsx',
    "eventDecorationOn={{ entityType: 'Model', entityId: data.id }}",
  ],
  [
    'src/components/Image/AsPosts/ImagesAsPostsCard.tsx',
    "eventDecorationOn={hatted && { entityType: 'Image', entityId: hatted.id }}",
  ],
  [
    'src/components/Model/ModelCarousel/ModelCarousel.tsx',
    "wornOn={{ entityType: 'Image', entityId: image.id }}",
  ],
];

// Draw a hat with no content behind it (a fit sample, a try-on, the event page's own thumbs).
const NO_CONTENT = [
  'src/components/Cosmetics/EventDecoration/HatFitEditor.tsx',
  'src/components/Modals/CardDecorationModal.tsx',
  'src/components/Events/ScoredEvent/EventContentThumb.tsx',
  'src/components/Shop/CosmeticSample.tsx',
];
// Draw the hat for a card. These pass the content on; MasonryCard has none to pass (its one hatted
// caller is the try-on preview).
const WRAPPERS = [
  'src/components/TwCosmeticWrapper/TwCosmeticWrapper.tsx',
  'src/components/Cosmetics/EventDecoration/EventDecorationOverlay.tsx',
  'src/components/MasonryGrid/MasonryCard.tsx',
];

// The templates between a card and TwCosmeticWrapper.
const TEMPLATES = [
  'src/components/CardTemplates/AspectRatioImageCard.tsx',
  'src/components/CardTemplates/AspectRatioCard.tsx',
  'src/components/CardTemplates/CosmeticCard.tsx',
  'src/components/Cards/FeedCard.tsx',
];

const DRAWS_A_HAT = new RegExp(
  String.raw`\beventDecoration=\{|<EventDecorationOverlay\b|<WornHatPopover\b`
);

const tsxFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? tsxFiles(join(dir, e.name))
      : e.name.endsWith('.tsx')
      ? [join(dir, e.name)]
      : []
  );

describe('worn hat call sites', () => {
  it.each(CALL_SITES)('%s names the content its hat is worn on', (file, expected) => {
    expect(read(file).split(expected).length - 1).toBe(1);
  });

  it.each(TEMPLATES)('%s passes the content on', (file) => {
    expect(read(file)).toContain('eventDecorationOn={eventDecorationOn}');
  });

  // A card added later that draws a hat must say what it is on, or its hat only bursts.
  it('lists every component that draws a hat', () => {
    const drawing = tsxFiles(join(process.cwd(), 'src'))
      .map((f) => relative(process.cwd(), f).split(sep).join('/'))
      .filter((f) => !f.includes('__tests__') && !f.endsWith('.test.tsx'))
      .filter((f) => DRAWS_A_HAT.test(read(f)));
    expect(drawing.sort()).toEqual(
      [...CALL_SITES.map(([f]) => f), ...NO_CONTENT, ...WRAPPERS, ...TEMPLATES].sort()
    );
  });

  // The popover names the event as its page does; the event's own definition is server-only.
  it("names the birthday event by its page's title", () => {
    const title = getEventDecorationDefinition('birthday2026')?.eventTitle;
    expect(read('src/server/events/birthday2026.event.ts').replace(/\r\n/g, '\n')).toContain(
      `createEvent(name, {\n  title: ${JSON.stringify(title)},`
    );
  });

  // The post card wears the hat of the first image that has one; the content must be that image.
  it('ImagesAsPostsCard names the image whose hat it draws', () => {
    const source = read('src/components/Image/AsPosts/ImagesAsPostsCard.tsx');
    expect(source).toContain('data.images.find((i) => isDefined(i.eventDecoration))');
    expect(source).toContain('const eventDecoration = hatted?.eventDecoration?.data;');
  });
});
