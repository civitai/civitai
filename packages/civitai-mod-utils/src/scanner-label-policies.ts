// Moderator-facing plain-English policy summaries per scanner label, shown in the focused-review
// sidebar so mods see what a label should catch while verdicting. Keyed by the lowercase label slug.
// Keep in sync with docs/features/scanner-moderator-guide.md.

export type ScannerLabelPolicy = {
  title: string;
  catch: string;
  shouldFire: string[];
  shouldNotFire: string[];
  gotchas?: string[];
};

export const SCANNER_LABEL_POLICIES: Record<string, ScannerLabelPolicy> = {
  young: {
    title: 'Young',
    catch: 'Prompts that describe, assert, or imply a person under 18.',
    shouldFire: [
      'Explicit youth terms: child, kid, toddler, shota, loli, cub, schoolgirl, schoolboy, elementary student, aged down',
      'Any explicit age under 18 (16 years old, 12yo, etc.)',
      'Foreign-language youth terms (Vietnamese học sinh, Russian девочка, Japanese 女子高生)',
      'Sexual content framing a participant as a parent’s child (mom and son, father and daughter)',
    ],
    shouldNotFire: [
      'An explicit adult age (18+, 21, 25, adult, mature, MILF, elderly) overrides implicit youth signals',
      'young adult, young man, young woman, young actor — adult vocabulary unless an under-18 age is also asserted',
      'Art style alone (anime, cartoon, chibi, stylized) — explicit content in anime style is NOT Young without explicit youth terms',
      'Adult body archetypes & fashion: petite, shortstack, small frame, cute face, lolita fashion (as a fashion descriptor)',
      'Size descriptors on non-bodies (small house, tiny car)',
      'Tags 1girl, 1boy, 2girls, 2boys alone',
      'Anthro characters (anthro, furry, dog girl, cat girl, kemono, monster girl) with adult body proportions',
      'A character’s franchise — judge by what the prompt says, not the franchise’s audience',
      'Parenthetical age tags inside franchise context (e.g. "kama (teenager) (fate)") — these are character-design markers, not asserted ages',
    ],
    gotchas: [
      'Anime style is not a youth signal by itself.',
      '"Petite" / "small" describing an adult is fine.',
      'Pokemon/anime names with anime style are fictional, not real minors.',
    ],
  },

  suggestive: {
    title: 'Suggestive',
    catch:
      'Sexually-charged content — anything from suggestive posing through fully explicit. Explicit is a subset of Suggestive.',
    shouldFire: [
      'Suggestive posing, sensual framing, sexual undertones, implied sex',
      'Lingerie or swimwear in a sexualized context',
      'Revealing or partial-coverage clothing in a sexualized context',
      'All explicit sexual content (nudity, visible genitals, sex acts) — fires Explicit too',
    ],
    shouldNotFire: [
      'Medical, anatomical, biological descriptions without sexual framing',
      'Swimwear in genuinely non-sexual contexts (beach, athletic swim competition, modest fashion)',
      'Standard portraiture, fashion photography, glamour photography without explicit sexual framing',
      'Exposed shoulders or partial clothing without sexual framing',
      'Business / professional / casual portraits',
      'Body-shape descriptors alone (curvy, hourglass, large breasts, thick thighs, toned, muscular) without sexualized posing, sexualized framing, or revealing-in-sexual-context clothing',
      'Anthro / furry / feral characters without depicted sex acts, visible genitals, sexual fluids, or sexualized posing',
      'Terms appearing only in the NEGATIVE prompt — those are avoidance signals',
    ],
    gotchas: [
      'The distinguishing factor is sexualized framing, not the clothing itself. Bikini at swim meet ≠ bikini in sensual bedroom pose.',
      'If the prompt is Explicit, Suggestive should fire too. Suggestive without Explicit means "sexual undertones but no actual explicit elements."',
      'Body shape ≠ sexualized content. A "curvy clothed body" alone is not Suggestive.',
    ],
  },

  explicit: {
    title: 'Explicit',
    catch: 'Hard sexual content — visible explicit anatomy, depicted sex acts, or sexual fluids.',
    shouldFire: [
      'Visible genitals (pussy, penis, anus, vulva)',
      'Visible nipples in sexualized framing',
      'Depicted sex acts (masturbation, intercourse, oral sex, anal sex)',
      'Explicit sexual fluids (cum, ejaculation, squirting)',
      'Unambiguous nudity depicted in a sexual manner',
    ],
    shouldNotFire: [
      'Suggestive but non-explicit: implied sex, lingerie, sensual posing, revealing clothing without visible genitals or depicted acts (that’s Suggestive, not Explicit)',
      'Body-shape descriptors alone (large breasts, thick thighs, cleavage, wide hips, curvy, hourglass, toned, muscular) — even paired with revealing-but-clothed attire',
      'Topless or artistic nudity without sexualized framing',
      'Anthro characters without depicted sex acts, visible genitals, or sexual fluids',
      'Explicit terms appearing ONLY in the negative prompt (those are avoidance signals)',
    ],
    gotchas: [
      'A "curvy clothed body" is NOT Explicit. Body shape ≠ nudity.',
      'Nudity itself remains explicit-triggering when present — the body-shape carve-out only covers clothed cases.',
      'A prompt with bikini, pussy, nude, cum in the negative is trying to prevent explicit content — sec.',
    ],
  },

  celebrity: {
    title: 'Celebrity',
    catch: 'Prompts using the name of a globally-famous real living or historical person.',
    shouldFire: [
      'Unambiguous real-name references a general audience would immediately recognize (Taylor Swift, Barack Obama, Cristiano Ronaldo, Beyoncé, Elon Musk, Albert Einstein, Marilyn Monroe)',
      'AND no fictional-context marker is present',
    ],
    shouldNotFire: [
      'The "[Name] from [franchise]" pattern — the "from" makes the name fictional (Pitt from Kid Icarus, Cloud from Final Fantasy)',
      'Any reference to anime, manga, cartoon, video game, comic, manhwa, JRPG, MMO, gacha, fantasy RPG',
      'Style tags: anime style, anime screencap, game CG, pixel art, cartoon style',
      'Franchise/title references — even ones you don’t recognize (Pokemon, Genshin, Final Fantasy, My Little Pony, Poppy Playtime, Kid Icarus, Zelda)',
      'Character-feature tags: catgirl, dragon girl, monster girl, demon, elf, succubus, magical girl, mecha, robot, android',
      'LoRA trigger words / opaque identifiers (MaiSchool, Lewdlemage, HelenSynthExl, expressiveH)',
      'Original characters, OCs, fan-fiction characters, fursonas',
      'First-name-only references (Sarah, John) without globally-famous-real-person context',
      'Side characters, supporting characters, villains in fictional series',
    ],
    gotchas: [
      'Default to sec. The vast majority of named characters in prompts are fictional.',
      'Capitalized name-shaped strings are usually LoRA triggers, not celebrity references.',
      'If you don’t recognize a name, it’s almost certainly an OC or fictional character.',
    ],
  },

  familial: {
    title: 'Familial',
    catch:
      'A family/blood relationship between two or more people in the prompt. This is an atomic detector — sexual content is irrelevant to this label; the derived "Incest" label combines Familial with sexual signals.',
    shouldFire: [
      'A family-relation term describing a relationship BETWEEN people: "mom and son", "father and daughter", "two siblings", "stepmom and stepson"',
      'Step-relatives between people: stepmom + stepson, stepsister + stepbrother',
      'Explicit family terms paired with another person: mother, father, mom, dad, son, daughter, brother, sister, sibling, twin, aunt, uncle, cousin, niece, nephew, grandmother, grandfather, etc.',
    ],
    shouldNotFire: [
      'A single person tagged with a family role and no other family member present: "mommy aesthetic", "MILF", "DILF", "older sister character archetype", "father figure"',
      '"Sister" / "brother" / "mother" / "father" as endearment, friendship, religious or character-archetype context: "sister of the convent", "brother in arms", "soul sister", "big sister type" (anime archetype)',
      'No family-relation term in the prompt',
      'Family relation in non-sexual scenes (still fires Familial; only the derived Incest label requires the sexual context too)',
    ],
    gotchas: [
      'Familial is intentionally independent of sexual content. It fires whenever there is a family pair, even in a wholesome family portrait. The derived Incest label only fires when Familial AND Suggestive/Explicit both fire.',
      'A single "mommy" or "MILF" with no other family member is NOT Familial — Familial requires the relationship to be between people.',
    ],
  },

  incest: {
    title: 'Incest (derived)',
    catch:
      'Sexual content involving family relations. This is a DERIVED label — it fires automatically when the atomic Familial label AND (Suggestive OR Explicit) both trigger. There is no standalone Incest model; you are reviewing the combination.',
    shouldFire: [
      'A family-relation term (mother, father, mom, dad, son, daughter, brother, sister, sibling, twin, aunt, uncle, cousin, grandparent, niece, nephew) PLUS a sexual context',
      'Step-relatives (stepmom, stepdad, stepsister, stepbrother) in a sexual context',
    ],
    shouldNotFire: [
      'Non-sexual family content: family portraits, mother-and-child scenes, sibling interactions, parenting scenes',
      '"Sister" / "brother" used as endearment, friendship, or religious context (sister of the convent, brother in arms, soul sister)',
      'Family relations in SFW, comedic, or narrative contexts',
      'Fictional sibling characters in non-sexual situations',
    ],
  },

  nonconsent: {
    title: 'Non-Consent',
    catch: 'Explicit non-consent framing in sexual content.',
    shouldFire: [
      'Literal terms: rape, raped, raping, non-consensual, noncon, non-con, forced sex, sexual assault, molested, molesting',
      'Incapacitation in sexual context: drugged, unconscious, asleep, passed out, comatose paired with sexual activity',
    ],
    shouldNotFire: [
      'Sexual content alone — sexual content is not a non-consent signal',
      'BDSM, bondage, rough sex, restraints, ropes, gags, struggling, crying, tears — without one of the explicit non-consent terms',
      'The word "forced" alone (forced perspective, forced into a corner, forced to smile)',
      'Suggestive content without sexual non-consent framing',
    ],
    gotchas: [
      'BDSM aesthetics ≠ non-consent. The policy targets explicit non-consent framing, not bondage imagery.',
    ],
  },

  gore: {
    title: 'Gore',
    catch: 'Extreme graphic violence with anatomical detail.',
    shouldFire: [
      'Dismemberment, mutilation, evisceration, decapitation',
      'Exposed internal organs, severed limbs, visible bone or viscera, intestines, brain matter',
      'Gore-spray, catastrophic bodily injury',
    ],
    shouldNotFire: [
      'Mild or stylized violence: combat scenes, fistfights, scrapes, bruises, action-movie violence',
      'Controlled blood splatter without anatomical exposure',
      'Horror, action, fantasy contexts without graphic anatomical injury',
      'Monsters, scary scenes, horror atmosphere alone',
      'Medical, surgical, anatomical study, or autopsy contexts framed as educational/clinical',
      'Special-effects makeup, costume, prosthetic, zombie cosmetic, halloween imagery',
      'Blood alone — bloody sword, bloody clothing, blood splatter without anatomical exposure',
      '"Bloody" used metaphorically (bloody mary cocktail, bloody mess as exasperation)',
    ],
  },

  bestiality: {
    title: 'Bestiality',
    catch: 'Sexual activity between a real animal and a human.',
    shouldFire: [
      'Sexual content depicting a real (non-anthropomorphic, non-fictional) animal in physical form with a human',
    ],
    shouldNotFire: [
      'Anthro / furry / fictional anthro / monster girl / demi-human / slime girl / dog girl / cat girl / wolf girl / fox girl / sergal / kemono — humanoid, not real animals',
      'Pokemon, Digimon, My Little Pony, Sonic, Zootopia, Kemono Friends, Helluva Boss — fictional anthro',
      'Specific Pokemon by name (steenee, sylveon, lopunny, cinderace, lucario, eevee) are anthro/fictional',
      'Sex position names (doggystyle, doggy style, cowgirl, missionary, reverse cowgirl) are HUMAN positions',
      'Generic animal mentions (dog, horse, wolf) in non-sexual contexts (pet, scenery, accessory)',
      'Animal-feature tags (dog ears, cat ears, tail, fur) on otherwise-human characters — kemonomimi/anthro',
    ],
    gotchas: [
      'doggystyle is a HUMAN sex position. It is not bestiality.',
      'Pokemon are not real animals.',
    ],
  },

  diaper: {
    title: 'Diaper',
    catch: 'Explicit diaper / ABDL content.',
    shouldFire: [
      'Literal terms: diaper, diapers, pamper, pampers, ABDL, adult baby, padded underwear, or unambiguous synonyms',
    ],
    shouldNotFire: [
      'Youth content alone (loli, child, chibi, schoolgirl, young, cute, pigtails) — that’s Young, not Diaper',
      'Belly-focused content (stuffed belly, big belly, bloated belly)',
      'Other body fluids or bathroom-adjacent terms (urine, scat) — separate labels',
      'Femboy, futanari, fetish content without explicit diaper terms',
    ],
  },

  urine: {
    title: 'Urine',
    catch: 'Urine / urination / piss content.',
    shouldFire: ['urine, urination, piss, piss play and unambiguous synonyms'],
    shouldNotFire: [
      'Other bodily fluids: cum, semen, sweat, saliva, drool, tears, female ejaculation, squirt — unless urine is also explicitly requested',
      'Bathroom or toilet imagery alone without an explicit urine reference',
    ],
  },

  scat: {
    title: 'Scat',
    catch: 'Feces / excrement / scat fetish content.',
    shouldFire: ['Explicit feces, excrement, or scat references'],
    shouldNotFire: ['"squirt" alone — that’s a separate label'],
  },

  menstruation: {
    title: 'Menstruation',
    catch: 'Menstruation or period blood imagery.',
    shouldFire: ['Explicit menstruation or period blood requests'],
    shouldNotFire: [],
  },
};

export function getScannerLabelPolicy(label: string): ScannerLabelPolicy | undefined {
  return SCANNER_LABEL_POLICIES[label.toLowerCase()];
}
