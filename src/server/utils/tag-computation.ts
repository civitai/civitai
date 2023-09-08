import { TagSource } from '@prisma/client';

const tagCombos: ComputedTagCombo[] = [
  {
    tag: 'nudity',
    qualifiers: [
      'nude',
      'completely nude',
      'penis',
      'vagina',
      'testicles',
      'bottomless + ass',
      'female pubic hair',
      'male pubic hair',
      'nipples',
    ],
    sources: [TagSource.WD14],
  },
  {
    tag: 'male',
    qualifiers: [
      'male focus',
      '1boy',
      '2boys',
      '3boys',
      '4boys',
      '5boys',
      '6+boys',
      'multiple boys',
    ],
    sources: [TagSource.WD14],
  },
  {
    tag: 'explicit male nudity',
    qualifiers: ['nudity + male'],
    sources: [TagSource.WD14],
  },
  {
    tag: 'female',
    qualifiers: [
      'female focus',
      '1girl',
      '2girls',
      '3girls',
      '4girls',
      '5girls',
      '6+girls',
      'multiple girls',
    ],
    sources: [TagSource.WD14],
  },
  {
    tag: 'explicit female nudity',
    qualifiers: ['nudity + female'],
    sources: [TagSource.WD14],
  },
  {
    tag: 'illustrated explicit nudity',
    qualifiers: ['nudity + !realistic'],
    sources: [TagSource.WD14],
  },
  {
    tag: 'adult toys',
    qualifiers: ['dildo', 'sex toy'],
    sources: [TagSource.WD14],
  },
  {
    tag: 'partial nudity',
    qualifiers: [
      '!nudity',
      'topless',
      'nipples',
      'covered nipples + see-through',
      'skin tight',
      'underboob',
      'sideboob',
      'areola slip',
      'pelvic curtain',
      'bulge',
      'cameltoe',
    ],
    sources: [TagSource.WD14],
  },
  {
    tag: 'sexual activity',
    qualifiers: [
      'sex',
      'group sex',
      'clothed sex',
      'tentacle sex',
      'gangbang',
      'handjob',
      'double handjob',
      'footjob',
      'breast sucking',
      'anal',
      'vaginal',
      'paizuri',
      'fellatio',
      'cunnilingus',
      'oralsex machine',
      'cum on body',
      'cum on breasts',
      'cum in mouth',
      'cum on tongue',
      'female masturbation',
      'masturbation',
      'fingering',
      'ejaculation',
      'erection',
      'male mastuerbation',
      '(kiss|french kiss) + (nudity|partial nudity)',
    ],
    sources: [TagSource.WD14],
  },
  {
    tag: 'underwear',
    qualifiers: [
      'panties',
      'bra',
      'lingerie',
      'leotard',
      'bikini',
      'swimsuit',
      'underwear only',
      'fundoshi',
      'bikini armor',
      'panties under pantyhose',
    ],
    sources: [TagSource.WD14],
    temp: true,
  },
  {
    tag: 'female swimwear or underwear',
    qualifiers: ['underwear + female'],
    sources: [TagSource.WD14],
  },
  {
    tag: 'male swimwear or underwear',
    qualifiers: ['underwear + male'],
    sources: [TagSource.WD14],
  },
  {
    tag: 'barechested male',
    qualifiers: ['topless male'],
    sources: [TagSource.WD14],
  },
  {
    tag: 'revealing clothes',
    qualifiers: [
      '!nudity',
      '!partial nudity',
      '!underwear',
      'miniskirt',
      'cleavage + (large_breasts|huge_breasts)',
      'navel + midriff',
      'navel + thighs',
      'midriff + thighs',
      'short shorts',
      'open clothes',
    ],
    sources: [TagSource.WD14],
  },

  // Old rekognition combos
  {
    tag: 'underwear',
    qualifiers: [
      '!dress',
      '!nudity',
      '!illustrated explicit nudity',
      '!partial nudity',
      '!sexual activity',
      '!graphic female nudity',
      '!graphic male nudity',
      'swimwear',
      'underwear',
      'lingerie',
      'bikini',
    ],
    temp: true,
    sources: [TagSource.Rekognition],
  },
  {
    tag: 'female swimwear or underwear',
    qualifiers: ['female + underwear'],
    sources: [TagSource.Rekognition],
  },
  {
    tag: 'male swimwear or underwear',
    qualifiers: ['male + underwear'],
    sources: [TagSource.Rekognition],
  },
];

export function getComputedTags(tags: string[], source: TagSource): string[] {
  const computedTags = new Set(tags);
  const tempTags = new Set<string>();
  const permTags = new Set<string>();

  const applicableCombos = tagCombos.filter((x) => !x.sources || x.sources.includes(source));

  for (const { tag, qualifiers, temp } of applicableCombos) {
    temp ? tempTags.add(tag) : permTags.add(tag);
    if (computedTags.has(tag)) continue;
    for (const qualifier of qualifiers) {
      const result = hasQualifiers(computedTags, qualifier);
      if (result === 'excluded') break;
      if (result === 'pass') {
        computedTags.add(tag);
        break;
      }
    }
  }

  for (const tag of tempTags) {
    if (!permTags.has(tag)) computedTags.delete(tag);
  }

  return [...computedTags].filter((x) => !tags.includes(x));
}

type QualifierResult = 'excluded' | 'fail' | 'pass';
function hasQualifiers(toCheck: Set<string>, qualifier: string): QualifierResult {
  const parts = qualifier.split(' + ').map((x) => x.trim());
  for (const part of parts) {
    const notHave = part.startsWith('!');
    const tagGroup = part.replace(/!|\(|\)/g, '');
    const tags = tagGroup.split('|');

    let hasPart = false;
    for (const tag of tags) {
      if (notHave && toCheck.has(tag)) {
        if (parts.length === 1) return 'excluded';
        return 'fail';
      }
      if (toCheck.has(tag)) {
        hasPart = true;
        break;
      }
    }
    if (!hasPart) return 'fail';
  }

  return 'pass';
}

type ComputedTagCombo = {
  tag: string;
  qualifiers: string[];
  temp?: boolean;
  sources?: TagSource[];
};
