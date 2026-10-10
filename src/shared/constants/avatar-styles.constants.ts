import { nanoBananaVersionIds } from '~/shared/form-graph/generation/image/nano-banana.graph';
import { openaiVersionIds } from '~/shared/form-graph/generation/image/openai.graph';
import { krea2VersionIds } from '~/shared/form-graph/generation/image/krea2.graph';

export const AVATAR_WORKFLOW = 'img2img:avatar';
export const AVATAR_SIZE = 1024;

/**
 * Edit models offered for avatars, as model versions; the first is the default. Krea 2 restyles the
 * photo with the style's LoRA instead of a reference: given a character reference, it tends to
 * draw the reference's person.
 */
export const avatarEditModels = [
  { key: 'krea2-raw', label: 'Krea 2', versionId: krea2VersionIds.raw, usesReference: false },
  {
    key: 'nano-banana-2',
    label: 'Nano Banana 2',
    versionId: nanoBananaVersionIds.v2,
    usesReference: true,
  },
  {
    key: 'nano-banana-pro',
    label: 'Nano Banana Pro',
    versionId: nanoBananaVersionIds.pro,
    usesReference: true,
  },
  {
    key: 'gpt-image-2.5-flare',
    label: 'GPT Image 2.5 Flare',
    versionId: openaiVersionIds['v2.5-flare'],
    usesReference: true,
  },
] as const;
export type AvatarEditModel = (typeof avatarEditModels)[number]['key'];
export const avatarEditModelByVersionId = new Map<number, (typeof avatarEditModels)[number]>(
  avatarEditModels.map((model) => [model.versionId, model])
);

export const avatarCategories = [
  'Anime',
  'Cartoon',
  'Comics',
  'Graphic',
  'Drawing',
  'Painting',
  'Craft',
  'Games',
  'Film',
  'Photo',
] as const;
export type AvatarCategory = (typeof avatarCategories)[number];

export type AvatarStyle = {
  key: string;
  name: string;
  category: AvatarCategory;
  /** Krea 2 LoRA version: applied by the Krea 2 restyle, and used to make the starter references. */
  lora?: number;
  stylePrompt: string;
  /**
   * The colours are part of the look (monochrome, Game Boy green, Technicolor), so the reference
   * reaches the model in colour and the user gets no palette choice.
   */
  fixedPalette?: true;
  /** Offers the fantasy Character choice (elf, orc, dwarf). */
  characters?: true;
};

export const avatarStyles: AvatarStyle[] = [
  {
    key: 'anime-niji',
    name: 'Niji Anime',
    category: 'Anime',
    lora: 3293186,
    stylePrompt:
      'Niji Journey anime style: glossy painted anime rendering, luminous eyes with highlights, soft rim light, vivid saturated colours, dreamy bokeh background.',
  },
  {
    key: 'anime-90s',
    name: '90s Anime',
    category: 'Anime',
    lora: 3349950,
    stylePrompt:
      'Hand-painted 1990s anime cel: muted retro colours, film grain, soft vignette, detailed hair strands, painted background.',
  },
  {
    key: 'anime-90s-scifi',
    name: '90s Sci-Fi Anime',
    category: 'Anime',
    lora: 3346833,
    stylePrompt:
      '1990s cyberpunk anime cel: sharp angular lineart, neon city lights behind, cool blue and magenta palette, film grain.',
  },
  {
    key: 'granblue',
    name: 'Granblue Fantasy',
    category: 'Anime',
    lora: 3090945,
    stylePrompt:
      'Granblue Fantasy character art: soft watercolour-like shading, delicate lineart, warm fantasy palette, ornate details.',
  },
  {
    key: 'dragon-ball',
    name: 'Dragon Ball',
    category: 'Anime',
    lora: 3075761,
    stylePrompt:
      'Dragon Ball anime style: bold clean outlines, spiky stylised hair, bright flat colours, simple cel shading, action-ready pose.',
  },
  {
    key: 'ghibli-kiki',
    name: 'Ghibli',
    category: 'Anime',
    lora: 3084641,
    stylePrompt:
      'Studio Ghibli hand-drawn animation: soft watercolour backgrounds, gentle cel shading, warm natural light, simple expressive faces.',
  },
  {
    key: 'gpt-4o',
    name: 'Storybook Anime',
    category: 'Anime',
    lora: 3085008,
    stylePrompt:
      'Soft storybook anime illustration: warm golden light, rounded friendly features, painterly textures, cosy palette.',
  },
  {
    key: 'disney-renaissance',
    name: 'Disney Classic',
    category: 'Cartoon',
    lora: 3137237,
    stylePrompt:
      '1990s hand-drawn Disney animation: clean ink lines, cel-painted colour, large expressive eyes, painted storybook background.',
  },
  {
    key: 'disney-mid-century',
    name: 'Mid-Century Cartoon',
    category: 'Cartoon',
    lora: 3360784,
    stylePrompt:
      '1950s mid-century animation: graphic flat shapes, limited retro palette, textured gouache backgrounds, stylised angular features.',
  },
  {
    key: 'pixar-3d',
    name: '3D Animated',
    category: 'Cartoon',
    lora: 3195430,
    stylePrompt:
      'Modern 3D animated film character: smooth stylised features, big expressive eyes, soft subsurface skin, cinematic lighting, shallow depth of field.',
  },
  {
    key: 'rick-and-morty',
    name: 'Adult Swim Cartoon',
    category: 'Cartoon',
    lora: 3272003,
    stylePrompt:
      'Adult animated sitcom style: wobbly thin outlines, flat colours, droopy eyes with tiny pupils, simple sci-fi background.',
  },
  {
    key: 'sims',
    name: 'Life Sim Game',
    category: 'Cartoon',
    lora: 3115512,
    stylePrompt:
      'Life simulation video game character: smooth stylised 3D, soft even lighting, plumbob-era game render, clean backdrop.',
  },
  {
    key: 'flat-cartoon',
    name: 'Flat Cartoon',
    category: 'Cartoon',
    lora: 3258343,
    stylePrompt:
      'Flat vector cartoon: bold simple shapes, no gradients, thick even outlines, bright limited palette.',
  },
  {
    key: 'anthropomorphic',
    name: 'Animal Version',
    category: 'Cartoon',
    lora: 3174346,
    stylePrompt:
      'Reimagine the person as an anthropomorphic animal character that matches their personality, keeping their expression, clothing and pose.',
    fixedPalette: true,
  },
  {
    key: 'cel-shaded',
    name: 'Bold Cel Shading',
    category: 'Comics',
    lora: 3190465,
    stylePrompt:
      'Graphic cel-shaded illustration: bold black shadow shapes, hard-edged two-tone lighting, punchy saturated colours.',
  },
  {
    key: 'tintin',
    name: 'Clear Line Comic',
    category: 'Comics',
    lora: 3095835,
    stylePrompt:
      'Ligne claire comic panel: uniform clean outlines, flat colours with no shading, simple dot eyes, crisp print look.',
  },
  {
    key: 'pulp-horror',
    name: 'Pulp Comic',
    category: 'Comics',
    lora: 3113777,
    stylePrompt:
      'Vintage pulp comic cover art: dramatic inking, lurid colours, aged paper texture, bold shadows.',
  },
  {
    key: 'pop-art',
    name: 'Pop Art',
    category: 'Comics',
    stylePrompt:
      'Lichtenstein-style pop art: thick black outlines, Ben-Day halftone dots in the skin, flat primary red, yellow and blue, comic print look.',
    fixedPalette: true,
  },
  {
    key: 'propaganda',
    name: 'Vintage Poster',
    category: 'Graphic',
    lora: 3116644,
    stylePrompt:
      'Dieselpunk propaganda poster: heroic low angle, bold limited red and cream palette, screen-printed texture, sunburst rays behind.',
    fixedPalette: true,
  },
  {
    key: 'vector',
    name: 'Minimal Vector',
    category: 'Graphic',
    lora: 3177745,
    stylePrompt:
      'Minimalist vector portrait: few flat shapes, no outlines, limited harmonious palette, generous negative space.',
  },
  {
    key: 'geometric',
    name: 'Geometric',
    category: 'Graphic',
    lora: 3365036,
    stylePrompt:
      'Geometric portrait: face built from triangles and circles, faceted flat colour planes, crisp edges.',
  },
  {
    key: 'sticker',
    name: 'Sticker',
    category: 'Graphic',
    lora: 3171066,
    stylePrompt:
      'Die-cut vinyl sticker: cute chibi proportions, bold outline, thick white border around the figure, flat colours, plain background.',
  },
  {
    key: 'tattoo',
    name: 'Tattoo Flash',
    category: 'Graphic',
    lora: 3222073,
    stylePrompt:
      'American traditional tattoo flash: heavy black outlines, limited red, green and yellow palette, banner and roses, aged paper.',
  },
  {
    key: 'graffiti',
    name: 'Graffiti',
    category: 'Graphic',
    lora: 3386598,
    stylePrompt:
      'Street graffiti mural: spray-paint portrait on a brick wall, drips, bold outlines, vivid aerosol colours.',
  },
  {
    key: 'stained-glass',
    name: 'Stained Glass',
    category: 'Graphic',
    stylePrompt:
      'Stained glass window: the portrait built from pieces of coloured glass held by thick black lead lines, light glowing through, gothic arch frame.',
    fixedPalette: true,
  },
  {
    key: 'mosaic',
    name: 'Mosaic',
    category: 'Graphic',
    stylePrompt:
      'Ancient Roman mosaic: the portrait made of small square stone and glass tesserae, visible grout lines, earthy palette with gold accents.',
    fixedPalette: true,
  },
  {
    key: 'line-drawing',
    name: 'Line Drawing',
    category: 'Drawing',
    lora: 3249577,
    stylePrompt:
      'Clean continuous line drawing: black ink on white paper, no shading, elegant contour lines.',
    fixedPalette: true,
  },
  {
    key: 'friendly-sketch',
    name: 'Friendly Sketch',
    category: 'Drawing',
    lora: 3205841,
    stylePrompt:
      'Loose friendly pencil sketch: quick confident strokes, light hatching, soft smudges, sketchbook paper.',
    fixedPalette: true,
  },
  {
    key: 'fantasy-graphite',
    name: 'Graphite',
    category: 'Drawing',
    lora: 3188163,
    stylePrompt:
      'Detailed graphite drawing: rich pencil tones from silver to deep black, careful cross-hatching, white paper.',
    fixedPalette: true,
    characters: true,
  },
  {
    key: 'da-vinci',
    name: 'Renaissance Sketch',
    category: 'Drawing',
    lora: 3229828,
    stylePrompt:
      'Renaissance study drawing: red chalk and sepia ink on aged parchment, fine hatching, handwritten notes in the margins.',
    fixedPalette: true,
  },
  {
    key: 'etching',
    name: 'Etching',
    category: 'Drawing',
    lora: 3258023,
    stylePrompt:
      'Copperplate etching: dense engraved cross-hatching, black ink only, banknote-portrait precision.',
    fixedPalette: true,
  },
  {
    key: 'old-paper',
    name: 'Old Paper',
    category: 'Drawing',
    lora: 3372705,
    stylePrompt:
      'Sepia ink drawing on worn antique paper: stains, creases, faded edges, vintage archive look.',
    fixedPalette: true,
  },
  {
    key: 'childs-drawing',
    name: "Child's Drawing",
    category: 'Drawing',
    lora: 3186388,
    stylePrompt:
      'Drawn by a young child with crayons: wobbly outlines, big round head, scribbled colour fill, sun in the corner.',
  },
  {
    key: 'crayon',
    name: 'Soft Crayon',
    category: 'Drawing',
    lora: 3225028,
    stylePrompt:
      'Soft wax crayon illustration: waxy textured strokes, warm pastel palette, paper tooth showing through.',
  },
  {
    key: 'rackham',
    name: 'Ink & Watercolour',
    category: 'Drawing',
    lora: 3141396,
    stylePrompt:
      'Edwardian fairy-tale book illustration: fine pen and ink linework, muted watercolour washes, twisted trees and soft sepia tones.',
    characters: true,
  },
  {
    key: 'watercolor',
    name: 'Watercolour',
    category: 'Painting',
    lora: 3131742,
    stylePrompt:
      'Loose watercolour painting: wet-on-wet blooms, soft bleeding edges, white paper showing, vivid pigment splashes.',
  },
  {
    key: 'watercolor-inks',
    name: 'Watercolour Inks',
    category: 'Painting',
    lora: 3245097,
    stylePrompt:
      'Vibrant watercolour ink portrait: saturated flowing inks, drips and splatters, crisp ink outlines.',
  },
  {
    key: 'sumi-e',
    name: 'Sumi-e',
    category: 'Painting',
    lora: 3370248,
    stylePrompt:
      'Japanese sumi-e ink wash: expressive black brushstrokes, graded ink washes, rice paper, a red seal stamp.',
    fixedPalette: true,
  },
  {
    key: 'woodblock',
    name: 'Woodblock Print',
    category: 'Painting',
    lora: 3171505,
    stylePrompt:
      'Japanese ukiyo-e woodblock print: flat colour areas, carved outlines, Prussian blue and soft pinks, visible wood grain and paper texture.',
  },
  {
    key: 'impressionism',
    name: 'Impressionism',
    category: 'Painting',
    lora: 3219131,
    stylePrompt:
      'Impressionist oil painting: broken dabs of colour, dappled sunlight, visible brush texture, garden backdrop.',
  },
  {
    key: 'splash-paint',
    name: 'Splash Paint',
    category: 'Painting',
    lora: 3235522,
    stylePrompt:
      'Expressive splash painting: bold paint splatters and drips around the portrait, vivid colour bursts.',
  },
  {
    key: 'classic-oil',
    name: 'Classic Oil Portrait',
    category: 'Painting',
    lora: 3297467,
    stylePrompt:
      'Old master oil portrait: chiaroscuro lighting, dark umber background, glazed skin tones, gilded frame feel.',
  },
  {
    key: 'art-nouveau',
    name: 'Art Nouveau',
    category: 'Painting',
    lora: 3258955,
    stylePrompt:
      'Art Nouveau poster in the manner of Mucha: flowing ornamental frame, halo disc behind the head, flat muted colours with bold contour lines, floral motifs.',
  },
  {
    key: 'art-deco',
    name: 'Art Deco',
    category: 'Painting',
    lora: 3346886,
    stylePrompt:
      'Art Deco illustration: streamlined geometric forms, metallic gold accents, symmetrical sunburst background.',
  },
  {
    key: 'delicate-whimsy',
    name: 'Whimsical',
    category: 'Painting',
    lora: 3363673,
    stylePrompt:
      'Delicate whimsical illustration: soft pastel washes, tiny flowers and butterflies, dreamy light.',
    characters: true,
  },
  {
    key: 'creepy-cute',
    name: 'Creepy Cute',
    category: 'Painting',
    lora: 3213052,
    stylePrompt:
      'Creepy-cute painting: big glossy eyes, spooky pastel palette, tiny bats and moons, playful gothic mood.',
    characters: true,
  },
  {
    key: 'gothic-elegance',
    name: 'Gothic',
    category: 'Painting',
    lora: 3156728,
    stylePrompt:
      'Ethereal gothic portrait: pale moonlight, black lace and silver, dark cathedral backdrop, painterly finish.',
    characters: true,
  },
  {
    key: 'frazetta',
    name: 'Fantasy Oil',
    category: 'Painting',
    lora: 3096520,
    stylePrompt:
      'Heroic dark fantasy oil painting: dramatic warm and cold light, muscular brushwork, stormy sky.',
    characters: true,
  },
  {
    key: 'dnd-painterly',
    name: 'Fantasy Hero',
    category: 'Painting',
    lora: 3118504,
    stylePrompt:
      'Tabletop fantasy character portrait: painterly digital art, adventurer gear, warm torchlight, parchment-toned background.',
    characters: true,
  },
  {
    key: 'wool',
    name: 'Knitted Wool',
    category: 'Craft',
    lora: 3195117,
    stylePrompt:
      'The person recreated as a knitted wool doll: visible yarn stitches, soft fuzzy fibres, button details, cosy studio lighting.',
  },
  {
    key: 'plush',
    name: 'Plush Toy',
    category: 'Craft',
    lora: 3201393,
    stylePrompt:
      'The person as a soft plush toy: felt fabric, embroidered eyes and mouth, visible seams, squishy rounded shape.',
  },
  {
    key: 'embroidery',
    name: 'Embroidery',
    category: 'Craft',
    lora: 3204749,
    stylePrompt:
      'Hand embroidery on linen: satin-stitch thread colours, raised texture, wooden embroidery hoop around the portrait.',
  },
  {
    key: 'paper',
    name: 'Paper Cutout',
    category: 'Craft',
    lora: 3173293,
    stylePrompt:
      'Layered paper-cut art: the portrait built from stacked coloured card layers, soft drop shadows between layers.',
  },
  {
    key: 'claymation',
    name: 'Claymation',
    category: 'Craft',
    stylePrompt:
      'Stop-motion claymation figure: sculpted plasticine with fingerprints and tool marks, rounded features, miniature set lighting.',
  },
  {
    key: 'porcelain-doll',
    name: 'Porcelain Doll',
    category: 'Craft',
    lora: 3302625,
    stylePrompt:
      'Antique porcelain doll: glossy glazed ceramic face, painted features, delicate lace collar, soft vintage light.',
  },
  {
    key: 'figurine',
    name: 'Collectible Figure',
    category: 'Craft',
    lora: 3176173,
    stylePrompt:
      'Painted PVC collectible figure: glossy plastic, crisp sculpted details, standing on a round display base, product photo.',
  },
  {
    key: 'lego',
    name: 'Brick Minifigure',
    category: 'Craft',
    stylePrompt:
      'Plastic toy-brick minifigure: cylindrical yellow head, printed simple face, claw hands, glossy ABS plastic, studded baseplate.',
  },
  {
    key: 'pixel-art',
    name: 'Pixel Art',
    category: 'Games',
    lora: 3331592,
    stylePrompt:
      '16-bit pixel art portrait: crisp visible pixels, limited palette, dithered shading, retro game character portrait.',
  },
  {
    key: 'gameboy',
    name: 'Game Boy Camera',
    category: 'Games',
    lora: 3308367,
    stylePrompt:
      '1998 handheld game camera photo: tiny resolution, four shades of green, heavy dithering.',
    fixedPalette: true,
  },
  {
    key: 'c64',
    name: '8-bit Computer',
    category: 'Games',
    lora: 3069395,
    stylePrompt: '8-bit home computer graphics: chunky wide pixels, 16-colour palette, scanlines.',
    fixedPalette: true,
  },
  {
    key: 'psx',
    name: 'PS1 / N64',
    category: 'Games',
    lora: 3072662,
    stylePrompt:
      'Late-1990s console 3D character: low-poly model, blurry low-resolution textures, flat lighting.',
  },
  {
    key: 'low-poly',
    name: 'Low Poly',
    category: 'Games',
    lora: 3331909,
    stylePrompt:
      'Low-poly 3D sculpture: faceted triangle mesh, flat-shaded polygons, crisp gradient lighting.',
  },
  {
    key: 'isometric',
    name: 'Isometric Diorama',
    category: 'Games',
    lora: 3139463,
    stylePrompt:
      'Tiny isometric diorama: the person as a miniature figure in a cube-shaped room, tilt-shift lighting, cute game-asset look.',
  },
  {
    key: 'technicolor-30s',
    name: '1930s Technicolor',
    category: 'Film',
    lora: 3134593,
    stylePrompt:
      'Still from a 1930s three-strip Technicolor film: saturated reds and teals, soft diffused studio lighting, painted backdrop, classic Hollywood framing.',
    fixedPalette: true,
  },
  {
    key: 'noir-50s',
    name: '1950s Noir',
    category: 'Film',
    lora: 3262541,
    stylePrompt:
      'Black-and-white film noir still: hard venetian-blind shadows, high contrast, smoke and rain, 1950s detective mood.',
    fixedPalette: true,
  },
  {
    key: 'psychedelic-60s',
    name: '1960s Psychedelic',
    category: 'Film',
    lora: 3129133,
    stylePrompt:
      'Psychedelic 1960s film still: swirling liquid-light patterns, acid colours, flower-power styling, grainy film.',
    fixedPalette: true,
  },
  {
    key: 'sci-fi-70s',
    name: '1970s Sci-Fi',
    category: 'Film',
    lora: 3129771,
    stylePrompt:
      'Still from a 1970s science-fiction film: warm faded technicolor film stock, heavy grain, retro-futuristic spaceship interior with orange and teal panels.',
    fixedPalette: true,
  },
  {
    key: 'commercial-80s',
    name: '1980s Commercial',
    category: 'Film',
    lora: 3285563,
    stylePrompt:
      '1980s TV commercial frame: soft-focus glow, warm video colour, big hair and bright styling, studio backdrop.',
    fixedPalette: true,
  },
  {
    key: 'vhs',
    name: 'VHS',
    category: 'Film',
    lora: 3217275,
    stylePrompt:
      'Frame grabbed from a 1990s VHS home video: smeared colours, chroma bleed, scan lines, tracking noise at the bottom edge, date stamp in the corner.',
    fixedPalette: true,
  },
  {
    key: 'vaporwave',
    name: 'Vaporwave',
    category: 'Film',
    lora: 3215746,
    stylePrompt:
      'Vaporwave aesthetic: pink and cyan neon grid, setting sun with stripes, glitch artefacts, retro 80s computer graphics.',
    fixedPalette: true,
  },
  {
    key: 'neon-cyberpunk',
    name: 'Retro Cyberpunk',
    category: 'Film',
    lora: 3358202,
    stylePrompt:
      'Retro cyberpunk illustration: rain-soaked neon city, holographic signs, teal and magenta palette, 80s anime grain.',
  },
  {
    key: 'neo-noir',
    name: 'Neo Noir',
    category: 'Film',
    lora: 3352681,
    stylePrompt:
      'Neo-noir illustration: deep shadows split by red neon, wet streets, moody cinematic framing.',
  },
  {
    key: 'manga',
    name: 'Manga',
    category: 'Anime',
    lora: 3087718,
    stylePrompt:
      'Black-and-white manga panel: crisp ink lineart, screentone shading, expressive eyes, speed lines in the background.',
    fixedPalette: true,
  },
  {
    key: 'chibi',
    name: 'Chibi',
    category: 'Anime',
    stylePrompt:
      'Chibi anime character: super-deformed cute proportions with a big head and small body, huge sparkling eyes, soft cel shading, pastel background.',
  },
  {
    key: 'headshot',
    name: 'Pro Headshot',
    category: 'Photo',
    stylePrompt:
      'Professional studio headshot photograph: soft key light, shallow depth of field, neutral grey backdrop, crisp natural detail.',
  },
  {
    key: '3d-emoji',
    name: '3D Emoji',
    category: 'Cartoon',
    stylePrompt:
      '3D emoji avatar: glossy rounded cartoon head and shoulders, smooth plastic shading, big friendly features, plain bright background.',
  },
  {
    key: 'webtoon',
    name: 'Webtoon',
    category: 'Comics',
    stylePrompt:
      'Korean manhwa webtoon illustration with glossy cel shading: clean digital lineart, soft airbrushed cel shading, glossy hair highlights, gentle gradient background.',
  },
  {
    key: 'caricature',
    name: 'Caricature',
    category: 'Drawing',
    lora: 3207085,
    stylePrompt:
      'Exaggerated big-head ink caricature: oversized head and playfully exaggerated features, confident pen lines, light watercolour wash.',
  },
  {
    key: 'superhero-comic',
    name: 'Superhero Comic',
    category: 'Comics',
    lora: 3320575,
    stylePrompt:
      'Modern American superhero comic art: bold ink lines, dramatic shading, saturated colours, dynamic lighting.',
  },
  {
    key: 'voxel',
    name: 'Voxel',
    category: 'Games',
    lora: 3281490,
    stylePrompt:
      'Voxel art character: built from small 3D cubes, blocky shapes, bright clean lighting, simple background.',
  },
];

export const avatarStyleByKey = new Map(avatarStyles.map((style) => [style.key, style]));
export const DEFAULT_AVATAR_STYLE = 'anime-niji';

export const avatarPalettes = [
  { key: 'natural', label: 'Natural', colors: [] },
  {
    key: 'amber',
    label: 'Amber',
    phrase: 'warm amber and honey, late afternoon light',
    colors: ['#c8782a', '#e9b35f', '#5a3416'],
  },
  {
    key: 'moonlit',
    label: 'Moonlit',
    phrase: 'cool blues and silver, moonlight',
    colors: ['#1f3a68', '#7d9cc7', '#d6dde8'],
  },
  {
    key: 'spring',
    label: 'Spring',
    phrase: 'fresh greens and soft gold, spring daylight',
    colors: ['#4f8a3c', '#a8cf6b', '#e4c867'],
  },
  {
    key: 'neon',
    label: 'Neon',
    phrase: 'deep indigo, teal and neon pink, night',
    colors: ['#21134d', '#13a8a0', '#ff3fa4'],
  },
  {
    key: 'pastel',
    label: 'Pastel',
    phrase: 'pastel pink and lavender, soft light',
    colors: ['#f4c2d7', '#c9b6ea', '#fbe9f1'],
  },
  {
    key: 'autumn',
    label: 'Autumn',
    phrase: 'autumn reds, rust and orange',
    colors: ['#9e2b1d', '#c8612b', '#e89a3c'],
  },
  {
    key: 'sunny',
    label: 'Sunny',
    phrase: 'bright turquoise, white and yellow, sunny',
    colors: ['#1fb5c4', '#ffffff', '#f6d33c'],
  },
  {
    key: 'jewel',
    label: 'Jewel',
    phrase: 'emerald, sapphire and gold jewel tones',
    colors: ['#0f6b4c', '#1d3c8f', '#c9a227'],
  },
  {
    key: 'earth',
    label: 'Earth',
    phrase: 'muted earth tones, olive and terracotta',
    colors: ['#6b6b3a', '#b5603b', '#d8c7a3'],
  },
  {
    key: 'dusk',
    label: 'Dusk',
    phrase: 'dusky purple and peach, twilight',
    colors: ['#4b2e64', '#c77d8f', '#f2b98c'],
  },
] as const;
const palettePhrase = new Map<string, string>(
  avatarPalettes.flatMap((palette) =>
    'phrase' in palette ? [[palette.key, palette.phrase] as const] : []
  )
);

export const avatarCharacters = [
  { key: 'human', label: 'Human' },
  { key: 'elf', label: 'Elf', phrase: 'an elf, with long pointed ears and fine elven features' },
  {
    key: 'orc',
    label: 'Orc',
    phrase: 'an orc, with green skin, small tusks and a heavier brow',
    changesSkin: true,
  },
  {
    key: 'dwarf',
    label: 'Dwarf',
    phrase:
      'a dwarf, with a sturdy build and a braided beard (braided hair instead if they are a child or have no beard)',
  },
] as const;
const characterByKey = new Map<string, { label: string; phrase?: string; changesSkin?: boolean }>(
  avatarCharacters.map((character) => [character.key, character])
);

const KEEP_IDENTITY =
  "Keep the person's face, facial features, age and identity. The person from the first image must be the only subject: do not copy the other person. No text, letters or captions.";

export function buildAvatarEditPrompt(
  style: AvatarStyle,
  {
    palette,
    character,
    refining,
  }: { palette?: string; character?: string; refining?: boolean } = {}
) {
  const intro =
    'The first image is a photo of the person to draw. The second image is a different person drawn in the target art style, used only as a style reference.';
  const becomes = character ? characterByKey.get(character) : undefined;
  // Without asking for new clothes, the photo's own outfit survives the change: an orc in a sweater.
  const transform = becomes?.phrase
    ? `Draw them as ${
        becomes.phrase
      }, while keeping their own face, eyes and expression recognisable, and dress them in clothing that suits ${
        becomes.phrase.split(',')[0]
      } in this style.`
    : '';
  const naturalFeatures = becomes?.changesSkin ? 'hair colour' : 'skin and hair colour';

  // The earlier avatar shows the same person, so it is followed, not kept at a distance.
  if (refining)
    return [
      'The first image is a photo of the person to draw. The second image is an earlier avatar of the same person.',
      'Redraw the person from the first image as a head-and-shoulders portrait in the style, colours and composition of the second image, refining it.',
      transform,
      "Keep the person's face, facial features, age and identity. No text, letters or captions.",
    ]
      .filter(Boolean)
      .join(' ');

  if (style.fixedPalette)
    return [
      intro,
      'Redraw the person from the first image as a head-and-shoulders portrait in exactly the art style, colour palette, lighting and mood of the second image.',
      transform,
      KEEP_IDENTITY,
    ]
      .filter(Boolean)
      .join(' ');

  const phrase = palette ? palettePhrase.get(palette) : undefined;
  const colour = phrase
    ? `Colour it in full colour with this palette for the background, clothing and lighting: ${phrase}. Keep the person's natural ${naturalFeatures}.`
    : transform
    ? `Colour it in full colour, keeping the person's natural ${naturalFeatures} and choosing colours that suit the clothing and background.`
    : "Colour it in full colour with the natural colours of the photo: the person's real skin, hair and clothing colours, and a soft background that suits them.";
  return [
    intro,
    'Redraw the person from the first image as a head-and-shoulders portrait using the line work, shading, brushwork and rendering of the second image.',
    transform,
    colour,
    KEEP_IDENTITY,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Krea 2 takes no style reference. The style's LoRA and description carry the look; the only second
 * image is the earlier avatar when refining.
 */
export function buildAvatarRestylePrompt(
  style: AvatarStyle,
  {
    palette,
    character,
    refining,
  }: { palette?: string; character?: string; refining?: boolean } = {}
) {
  const becomes = character ? characterByKey.get(character) : undefined;
  const transform = becomes?.phrase
    ? `Draw them as ${
        becomes.phrase
      }, keeping their own face recognisable, in clothing that suits ${
        becomes.phrase.split(',')[0]
      }.`
    : '';
  const phrase = !style.fixedPalette && palette ? palettePhrase.get(palette) : undefined;
  return [
    refining
      ? 'The first image is a photo of the person. The second image is an earlier avatar of the same person. Redraw the person from the first image as a head-and-shoulders portrait in the style, colours and composition of the second image, refining it.'
      : 'Restyle this photo as a head-and-shoulders portrait.',
    style.stylePrompt,
    transform,
    phrase ? `Colour palette: ${phrase}.` : '',
    "Keep the person's face, facial features, age and identity. No text, letters or captions.",
  ]
    .filter(Boolean)
    .join(' ');
}

export const AVATAR_RESTYLE_NEGATIVE_PROMPT =
  'text, letters, caption, watermark, signature, logo, blurry, deformed face, extra people';
