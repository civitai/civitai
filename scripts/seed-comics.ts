/**
 * Comic Seed Script
 *
 * Creates mock comic projects with chapters, panels, cover/hero images,
 * and varied NSFW levels for testing the reader flow.
 * Uses placeholder images from picsum.photos.
 *
 * Usage:
 *   npx tsx scripts/seed-comics.ts [userId]
 *
 * Options:
 *   --clean   Delete previously seeded comics before creating new ones
 *
 * If userId is not provided, it will use the first admin user found.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({ log: ['warn', 'error'] });

const PANEL_WIDTH = 1728;
const PANEL_HEIGHT = 2304;

// NsfwLevel bitwise flags (from src/server/common/enums.ts)
const Nsfw = {
  PG: 1,
  PG13: 2,
  R: 4,
  X: 8,
  XXX: 16,
} as const;

// Placeholder images — unique seeds for variety
const panelImage = (seed: number) =>
  `https://picsum.photos/seed/comic-panel-${seed}/${PANEL_WIDTH}/${PANEL_HEIGHT}`;
const coverImageUrl = (seed: number) =>
  `https://picsum.photos/seed/comic-cover-${seed}/600/800`;
const heroImageUrl = (seed: number) =>
  `https://picsum.photos/seed/comic-hero-${seed}/1600/900`;

/** Create an Image record in the database and return its id */
async function createImageRecord(
  userId: number,
  url: string,
  opts: { width: number; height: number; nsfwLevel: number; name?: string }
) {
  const image = await prisma.image.create({
    data: {
      url,
      userId,
      width: opts.width,
      height: opts.height,
      nsfwLevel: opts.nsfwLevel,
      nsfw: nsfwLevelToEnum(opts.nsfwLevel),
      name: opts.name ?? null,
      ingestion: 'Scanned',
      type: 'image',
    },
  });
  return image.id;
}

function nsfwLevelToEnum(level: number): 'None' | 'Soft' | 'Mature' | 'X' | 'Blocked' {
  if (level >= Nsfw.X) return 'X';
  if (level >= Nsfw.R) return 'Mature';
  if (level >= Nsfw.PG13) return 'Soft';
  return 'None';
}

interface MockComic {
  name: string;
  description: string;
  genre: string;
  /** Project-level NSFW (bitwise OR of all chapter levels) */
  nsfwLevel: number;
  chapters: {
    name: string;
    nsfwLevel: number;
    panels: { prompt: string; nsfwLevel: number }[];
  }[];
}

const MOCK_COMICS: MockComic[] = [
  // ── Comic 1: SFW (PG) ────────────────────────────────────────────────
  {
    name: 'Neon Requiem',
    description:
      'In the rain-soaked streets of Neo-Kyoto 2089, a disgraced detective with cybernetic eyes hunts a serial killer who leaves origami cranes at every crime scene. But each victim is connected to a corporate conspiracy that reaches the highest levels of the megacorp that owns the city.',
    genre: 'SciFi',
    nsfwLevel: Nsfw.PG,
    chapters: [
      {
        name: 'Chapter 1: The First Crane',
        nsfwLevel: Nsfw.PG,
        panels: [
          { prompt: 'A dark rainy cyberpunk city street at night, neon signs reflecting in puddles, towering skyscrapers with holographic advertisements', nsfwLevel: Nsfw.PG },
          { prompt: 'Close-up of a weathered detective in a long coat, one eye glowing blue with cybernetic augmentation, rain dripping from his hat', nsfwLevel: Nsfw.PG },
          { prompt: 'A crime scene in a narrow alley, police drones hovering overhead with spotlights, a small origami crane placed carefully on the ground', nsfwLevel: Nsfw.PG },
          { prompt: 'The detective kneeling down examining the origami crane with his cybernetic eye zooming in, holographic data overlay visible', nsfwLevel: Nsfw.PG },
          { prompt: 'Wide shot of the detective walking away from the crime scene into the neon-lit rain, his silhouette against massive holographic billboards', nsfwLevel: Nsfw.PG },
        ],
      },
      {
        name: 'Chapter 2: Corporate Shadows',
        nsfwLevel: Nsfw.PG,
        panels: [
          { prompt: 'Interior of a massive corporate tower lobby, sleek white surfaces, holographic reception desk, armed guards in tactical gear', nsfwLevel: Nsfw.PG },
          { prompt: 'The detective confronting a corporate executive in a luxurious office high above the city, floor-to-ceiling windows showing the cityscape', nsfwLevel: Nsfw.PG },
          { prompt: 'A secret underground lab revealed behind a hidden door, rows of glowing pods containing human figures in stasis', nsfwLevel: Nsfw.PG },
          { prompt: 'The detective in a high-speed chase on a motorcycle through neon-lit streets, drones pursuing him from above', nsfwLevel: Nsfw.PG },
          { prompt: 'Dramatic rooftop scene, the detective standing on the edge of a skyscraper looking down at the city below, wind blowing his coat', nsfwLevel: Nsfw.PG },
          { prompt: 'Close-up of a second origami crane found on the detectives desk, a threatening message written in light projected from within it', nsfwLevel: Nsfw.PG },
        ],
      },
      {
        name: 'Chapter 3: Ghost in the Machine',
        nsfwLevel: Nsfw.PG,
        panels: [
          { prompt: 'A hacker den filled with screens and cables, a young woman with neon-colored hair working at multiple terminals simultaneously', nsfwLevel: Nsfw.PG },
          { prompt: 'Digital cyberspace visualization, the detective jacked into the network, floating through streams of data represented as light', nsfwLevel: Nsfw.PG },
          { prompt: 'A virtual confrontation with a masked figure in cyberspace, geometric shapes and code fragments swirling around them', nsfwLevel: Nsfw.PG },
          { prompt: 'The detective waking up from the cyberspace session, nose bleeding, in a dimly lit apartment filled with case files', nsfwLevel: Nsfw.PG },
        ],
      },
    ],
  },

  // ── Comic 2: PG-13 (mild content) ────────────────────────────────────
  {
    name: 'The Witch of Willowmere',
    description:
      'When twelve-year-old Lily discovers she can talk to the ancient trees in the forest behind her grandmother\'s cottage, she learns that a centuries-old curse is slowly killing the woodland. With the help of a grumpy talking fox and a forgetful ghost, she must find three enchanted seeds before the autumn equinox.',
    genre: 'Fantasy',
    nsfwLevel: Nsfw.PG13,
    chapters: [
      {
        name: 'Chapter 1: Grandmother\'s Secret',
        nsfwLevel: Nsfw.PG,
        panels: [
          { prompt: 'A cozy cottage at the edge of an enchanted forest, wildflowers in the garden, smoke curling from the chimney, golden afternoon light', nsfwLevel: Nsfw.PG },
          { prompt: 'A young girl with braided hair discovering a glowing book hidden in a hollow tree trunk, magical particles floating in the air', nsfwLevel: Nsfw.PG },
          { prompt: 'The ancient trees of the forest coming alive with faces in their bark, branches reaching down gently toward the girl', nsfwLevel: Nsfw.PG },
          { prompt: 'A grumpy red fox sitting on a mossy rock, wearing a tiny scarf, looking annoyed but curious at the girl', nsfwLevel: Nsfw.PG },
          { prompt: 'The girl and the fox standing at the edge of a dark part of the forest where the trees are withered and grey, stark contrast with the healthy forest', nsfwLevel: Nsfw.PG },
        ],
      },
      {
        name: 'Chapter 2: The Forgetful Ghost',
        nsfwLevel: Nsfw.PG13,
        panels: [
          { prompt: 'A translucent blue ghost of an elderly woman floating in a moonlit clearing, looking confused and trying to remember something', nsfwLevel: Nsfw.PG },
          { prompt: 'The girl, the fox, and the ghost looking at an ancient map made of leaves that shows three glowing points in the forest', nsfwLevel: Nsfw.PG },
          { prompt: 'An underground cavern filled with luminescent mushrooms and crystal formations, a hidden seed glowing on a stone pedestal', nsfwLevel: Nsfw.PG },
          { prompt: 'The girl carefully picking up the first enchanted seed, which pulses with green life energy, roots growing from her fingertips', nsfwLevel: Nsfw.PG13 },
          { prompt: 'A dark shadow creature lurking in the dead part of the forest, red eyes watching the group from between withered trees', nsfwLevel: Nsfw.PG13 },
          { prompt: 'The three companions running through the forest at night, fireflies lighting their path, the shadow creature pursuing in the distance', nsfwLevel: Nsfw.PG13 },
        ],
      },
    ],
  },

  // ── Comic 3: R-rated (violence, noir themes) ─────────────────────────
  {
    name: 'Dead Weight',
    description:
      'A hard-boiled noir thriller set in 1940s Chicago. When jazz club owner Marcus Cole finds his business partner dead in the alley behind the club, he becomes the prime suspect. To clear his name, he must navigate a web of corrupt cops, mob bosses, and dangerous dames — all while keeping his club alive and his secrets buried.',
    genre: 'Mystery',
    nsfwLevel: Nsfw.R,
    chapters: [
      {
        name: 'Chapter 1: Last Call',
        nsfwLevel: Nsfw.PG13,
        panels: [
          { prompt: 'A smoky 1940s jazz club interior, a Black man in a sharp suit standing on stage adjusting a microphone, warm amber lighting', nsfwLevel: Nsfw.PG },
          { prompt: 'A dark rainy alley behind the jazz club, a body lying face down near trash cans, a fedora nearby in a puddle', nsfwLevel: Nsfw.PG13 },
          { prompt: 'Close-up of the club owners face showing shock, rain on his face, the neon sign of the club reflecting in his eyes', nsfwLevel: Nsfw.PG },
          { prompt: 'Two police detectives in trench coats arriving at the scene, one suspicious and one sympathetic, flashlights cutting through the rain', nsfwLevel: Nsfw.PG },
          { prompt: 'The club owner sitting alone at the bar after closing, a glass of whiskey in hand, staring at a framed photo of him and his dead partner', nsfwLevel: Nsfw.PG13 },
        ],
      },
      {
        name: 'Chapter 2: The Setup',
        nsfwLevel: Nsfw.R,
        panels: [
          { prompt: 'A mob bosss office, opulent and intimidating, a large man in an expensive suit behind a mahogany desk, cigar smoke curling', nsfwLevel: Nsfw.PG13 },
          { prompt: 'The club owner meeting a mysterious woman in a red dress at a dimly lit booth, she slides an envelope across the table', nsfwLevel: Nsfw.PG13 },
          { prompt: 'A tense confrontation in a boxing gym, the club owner facing down two thugs, dramatic shadows from overhead lights', nsfwLevel: Nsfw.R },
          { prompt: 'Noir-style shot of the club owner walking down a foggy street alone, his shadow stretched long by a street lamp, city skyline in background', nsfwLevel: Nsfw.PG },
        ],
      },
      {
        name: 'Chapter 3: All That Jazz',
        nsfwLevel: Nsfw.R,
        panels: [
          { prompt: 'The jazz club packed with patrons, a singer in a sequined dress performing on stage, the club owner watching from the back with worried eyes', nsfwLevel: Nsfw.PG13 },
          { prompt: 'A secret meeting in the clubs basement, the club owner examining documents spread on a table, a single hanging light bulb swinging', nsfwLevel: Nsfw.PG },
          { prompt: 'A car chase through rain-slicked 1940s Chicago streets, vintage cars, the club owner driving with determination', nsfwLevel: Nsfw.R },
          { prompt: 'The club owner discovering a hidden safe behind a painting in his partners office, combination written on the back of a photograph', nsfwLevel: Nsfw.PG },
          { prompt: 'Final dramatic shot: the club owner standing in the spotlight on the empty stage, holding a gun, shadows closing in from all sides', nsfwLevel: Nsfw.R },
        ],
      },
    ],
  },
];

async function cleanPreviousSeeds(userId: number) {
  const names = MOCK_COMICS.map((c) => c.name);
  const existing = await prisma.comicProject.findMany({
    where: { userId, name: { in: names } },
    select: { id: true, name: true },
  });

  if (existing.length === 0) {
    console.log('No previous seed comics found.\n');
    return;
  }

  console.log(`Cleaning ${existing.length} previous seed comics...`);
  for (const p of existing) {
    // Delete panels, chapters, engagements, then project
    await prisma.comicPanel.deleteMany({ where: { projectId: p.id } });
    await prisma.comicChapter.deleteMany({ where: { projectId: p.id } });
    await prisma.comicProjectEngagement.deleteMany({ where: { projectId: p.id } });
    await prisma.comicProject.delete({ where: { id: p.id } });
    console.log(`  Deleted: "${p.name}" (id: ${p.id})`);
  }
  console.log('');
}

async function main() {
  const args = process.argv.slice(2);
  const shouldClean = args.includes('--clean');
  const userIdArg = args.find((a) => !a.startsWith('--'));
  let userId: number;

  if (userIdArg) {
    userId = parseInt(userIdArg, 10);
    if (isNaN(userId)) {
      console.error('Invalid userId:', userIdArg);
      process.exit(1);
    }
  } else {
    const user = await prisma.user.findFirst({
      where: { isModerator: true },
      select: { id: true, username: true },
      orderBy: { id: 'asc' },
    });
    if (!user) {
      console.error('No moderator user found. Pass a userId as argument: npx tsx scripts/seed-comics.ts <userId>');
      process.exit(1);
    }
    userId = user.id;
    console.log(`Using moderator user: ${user.username} (id: ${userId})`);
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, username: true } });
  if (!user) {
    console.error(`User ${userId} not found`);
    process.exit(1);
  }

  if (shouldClean) {
    await cleanPreviousSeeds(userId);
  }

  console.log(`Creating ${MOCK_COMICS.length} comic projects for user "${user.username}" (id: ${userId})...\n`);

  let globalSeed = Date.now(); // Use timestamp for unique seeds across runs

  for (const comic of MOCK_COMICS) {
    // Create cover Image record
    const coverSeed = globalSeed++;
    const coverId = await createImageRecord(userId, coverImageUrl(coverSeed), {
      width: 600,
      height: 800,
      nsfwLevel: comic.nsfwLevel,
      name: `${comic.name} - Cover`,
    });

    // Create hero Image record
    const heroSeed = globalSeed++;
    const heroId = await createImageRecord(userId, heroImageUrl(heroSeed), {
      width: 1600,
      height: 900,
      nsfwLevel: comic.nsfwLevel,
      name: `${comic.name} - Hero`,
    });

    // Create the project with cover and hero images
    const project = await prisma.comicProject.create({
      data: {
        userId,
        name: comic.name,
        description: comic.description,
        genre: comic.genre as any,
        status: 'Active',
        nsfwLevel: comic.nsfwLevel,
        coverImageId: coverId,
        heroImageId: heroId,
        heroImagePosition: 40 + Math.floor(Math.random() * 30), // 40-70 range
        publishedAt: new Date(),
      },
    });

    const nsfwLabel =
      comic.nsfwLevel >= Nsfw.R ? 'R' :
      comic.nsfwLevel >= Nsfw.PG13 ? 'PG-13' : 'PG';
    console.log(`  Created project: "${project.name}" (id: ${project.id}, nsfw: ${nsfwLabel})`);

    for (let chIdx = 0; chIdx < comic.chapters.length; chIdx++) {
      const chapter = comic.chapters[chIdx];

      await prisma.comicChapter.create({
        data: {
          projectId: project.id,
          position: chIdx,
          name: chapter.name,
          status: 'Published',
          publishedAt: new Date(),
          nsfwLevel: chapter.nsfwLevel,
        },
      });

      const chNsfwLabel =
        chapter.nsfwLevel >= Nsfw.R ? 'R' :
        chapter.nsfwLevel >= Nsfw.PG13 ? 'PG-13' : 'PG';
      console.log(`    Chapter ${chIdx}: "${chapter.name}" (${chapter.panels.length} panels, nsfw: ${chNsfwLabel})`);

      for (let pIdx = 0; pIdx < chapter.panels.length; pIdx++) {
        const panel = chapter.panels[pIdx];
        const panelSeed = globalSeed++;

        // Create an Image record for panels that have non-PG nsfw levels
        // so ImageGuard2 can properly blur them in the reader
        let imageId: number | null = null;
        if (panel.nsfwLevel > Nsfw.PG) {
          imageId = await createImageRecord(userId, panelImage(panelSeed), {
            width: PANEL_WIDTH,
            height: PANEL_HEIGHT,
            nsfwLevel: panel.nsfwLevel,
            name: `${comic.name} - Ch${chIdx + 1} Panel ${pIdx + 1}`,
          });
        }

        await prisma.comicPanel.create({
          data: {
            projectId: project.id,
            chapterPosition: chIdx,
            position: pIdx,
            prompt: panel.prompt,
            imageUrl: panelImage(panelSeed),
            status: 'Ready',
            ...(imageId ? { imageId } : {}),
          },
        });
      }
    }

    console.log('');
  }

  console.log('Done! Comics are ready for testing.\n');
  console.log('NSFW levels across comics:');
  console.log('  Neon Requiem       — PG     (all chapters PG)');
  console.log('  Witch of Willowmere — PG-13  (ch1 PG, ch2 PG-13)');
  console.log('  Dead Weight        — R       (ch1 PG-13, ch2+ch3 R)\n');

  console.log('Reader URLs:');
  const projects = await prisma.comicProject.findMany({
    where: { userId, name: { in: MOCK_COMICS.map((c) => c.name) } },
    select: { id: true, name: true },
    orderBy: { id: 'desc' },
    take: MOCK_COMICS.length,
  });

  for (const p of projects) {
    console.log(`  /comics/${p.id}  — ${p.name}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
