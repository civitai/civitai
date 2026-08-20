/**
 * Seed `label_term` from the lists that used to be hardcoded in `src/lib/highlight-terms.ts`.
 *
 *   pnpm exec tsx --env-file=.env apps/moderator/xguard-lab/seed-terms.ts
 *
 * Idempotent: `ON CONFLICT (label, term) DO UPDATE` refreshes the kind, so re-running after editing
 * this file corrects a mis-categorised term rather than silently skipping it. It does NOT delete
 * terms that have been removed here — pass `--prune` for that, which will also drop anything added
 * through the UI, so do not make it the default.
 */
import pg from 'pg';

const TERMS: Record<string, { trigger?: string[]; counter?: string[]; soft?: string[] }> = {
  AgeAsserted: {
    trigger: [
      'child',
      'children',
      'kid',
      'kids',
      'toddler',
      'baby',
      'infant',
      'minor',
      'minors',
      'underage',
      'loli',
      'lolicon',
      'shota',
      'shotacon',
      'cub',
      'cunny',
      'schoolgirl',
      'schoolboy',
      'schoolgirls',
      'schoolboys',
      'elementary student',
      'middle schooler',
      'kindergartner',
      'preschooler',
      'aged down',
      'age regression',
      'age-regressed',
      'de-aged',
      'teen',
      'teens',
      'teenage',
      'teenager',
      'teenagers',
      'teen-ager',
      'preteen',
      'pre-teen',
      'tween',
      'jailbait',
      'little girl',
      'little boy',
      'little child',
      'little kid',
      'young son',
      'young daughter',
      'young child',
      'young kid',
      'toddler body',
      'baby body',
      'infant body',
      // Transliterated. These were the misses during tuning.
      'imouto',
      'otouto',
      'youjo',
      'shoujo',
      'shounen',
      'học sinh',
      'em gái',
      'девочка',
      '学生',
      '女子高生',
      '女子中学生',
      '小学生',
      '少女',
      '妹',
      'ロリ',
      'ショタ',
      '여학생',
      '소녀',
      // Mangled tag spellings seen in real prompts.
      'sshota',
      'sh0ta',
      'l0li',
      'lo_li',
      'loli_girl',
      'mom and son',
      'father and daughter',
      'mother and son',
      'dad and daughter',
    ],
    counter: [
      'adult',
      'mature',
      'milf',
      'gilf',
      'elderly',
      'old woman',
      'old man',
      'cougar',
      'granny',
      'matron',
      'voluptuous adult',
      'mature female',
      'mature woman',
      'grown woman',
      'grown man',
      'young woman',
      'young man',
      'young female',
      'young lady',
      'young actor',
      'young model',
      'young athlete',
      'young professional',
      'young couple',
      'young college girl',
      'young adult',
      'in her 20s',
      'in his 20s',
      'in her 30s',
      'in his 30s',
      'early twenties',
      'late teens',
      '20-something',
      'thirtysomething',
      'middle aged',
    ],
    soft: [
      'young',
      'petite',
      'shortstack',
      'small frame',
      'cute face',
      'cute',
      'small body',
      'tiny body',
      'slim',
      'slender',
      'delicate',
      'flat chest',
      'smooth skin',
      'soft features',
      'innocent',
      'naive',
      'shy',
      'pure',
      'chibi',
      'chibi proportions',
      'twintails',
      'pigtails',
      'sidelocks',
      '1girl',
      '1boy',
      '2girls',
      '2boys',
      'girl',
      'boy',
      'school uniform',
      'seifuku',
      'classroom',
      'playground',
      'gym uniform',
    ],
  },

  AgeNegated: {
    trigger: [
      'adult',
      'mature',
      'mature woman',
      'mature female',
      'milf',
      'gilf',
      'cougar',
      'elderly',
      'old woman',
      'old man',
      'granny',
      'matron',
      'grown woman',
      'grown man',
      'in her 20s',
      'in his 20s',
      'in her 30s',
      'in his 30s',
      'early twenties',
      '20-something',
      'thirtysomething',
      'middle aged',
      'of legal age',
      'over 18',
    ],
    counter: [
      'child',
      'loli',
      'shota',
      'schoolgirl',
      'teen',
      'teenager',
      'little girl',
      'little boy',
    ],
    soft: ['young woman', 'young man', 'young lady', 'college', 'university student'],
  },

  SexualNudity: {
    trigger: [
      'nude',
      'naked',
      'topless',
      'bottomless',
      'no clothes',
      'undressed',
      'nipples',
      'areola',
      'genitals',
      'genitalia',
      'penis',
      'vulva',
      'pussy',
      'anus',
      'bare breasts',
      'shirt lift',
      'skirt lift',
      'no panties',
      'no bra',
      'exposed breasts',
      'exposed ass',
      'full frontal',
    ],
    counter: ['clothed', 'fully dressed', 'modest', 'covered'],
    soft: ['lingerie', 'swimsuit', 'bikini', 'suggestive', 'seductive', 'sensual', 'revealing'],
  },

  SexualAct: {
    trigger: [
      'sex',
      'intercourse',
      'penetration',
      'oral',
      'blowjob',
      'blow job',
      'fellatio',
      'cunnilingus',
      'anal',
      'handjob',
      'footjob',
      'masturbation',
      'masturbate',
      'fingering',
      'humping',
      'creampie',
      'gangbang',
      'mating press',
      'doggystyle',
      'doggy style',
      'cowgirl',
      'missionary',
    ],
    counter: ['solo', 'portrait', 'standing', 'posing'],
    soft: ['cum', 'ahegao', 'hentai', 'porn', 'explicit', 'nsfw'],
  },
};

const DESCRIPTIONS: Record<string, string> = {
  AgeAsserted: 'The prompt names a person under 18 in words you can quote.',
  AgeNegated: 'The prompt states the subject is an adult.',
  SexualNudity: 'The prompt requests nudity or exposed genitals.',
  SexualAct: 'The prompt requests a sex act taking place.',
};

const prune = process.argv.includes('--prune');
const client = new pg.Client({
  connectionString:
    process.env.MODERATOR_DATABASE_URL ?? 'postgres://xguard:xguard@localhost:5433/xguard_lab',
});
await client.connect();

try {
  for (const [label, kinds] of Object.entries(TERMS)) {
    await client.query(
      `INSERT INTO label_def (name, description) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`,
      [label, DESCRIPTIONS[label] ?? label]
    );

    let n = 0;
    for (const [kind, terms] of Object.entries(kinds)) {
      for (const term of terms ?? []) {
        await client.query(
          `INSERT INTO label_term (label, term, kind) VALUES ($1, $2, $3)
           ON CONFLICT (label, term) DO UPDATE SET kind = EXCLUDED.kind`,
          [label, term, kind]
        );
        n++;
      }
    }

    if (prune) {
      const all = Object.values(kinds).flatMap((t) => t ?? []);
      const { rowCount } = await client.query(
        `DELETE FROM label_term WHERE label = $1 AND term <> ALL($2::text[])`,
        [label, all]
      );
      if (rowCount) console.log(`  pruned ${rowCount} from ${label}`);
    }

    console.log(`${label}: ${n} terms`);
  }
} finally {
  await client.end();
}
