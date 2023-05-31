import {
  ActionIcon,
  AspectRatio,
  Autocomplete,
  Card,
  Checkbox,
  Group,
  Paper,
  ScrollArea,
  SimpleGrid,
  Stack,
  Text,
  Tooltip,
  Transition,
} from '@mantine/core';
import {
  IconCloudUpload,
  IconFilter,
  IconLayoutGrid,
  IconLayoutList,
  IconSearch,
  IconSortDescending2,
  IconSquareOff,
  IconTrash,
  IconWindowMaximize,
} from '@tabler/icons-react';
import { useState } from 'react';

import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { useIsMobile } from '~/hooks/useIsMobile';

// TODO.generation: remove mock data
const images = [
  {
    id: 749581,
    name: '00267-3271058046-cf7-Euler a-s30-27ea8c02.png',
    url: '55052719-c125-444e-8cdf-af2b783a01fc',
    nsfw: 'None',
    width: 512,
    height: 768,
    hash: 'URIp9_-U-9Rn0gJ8OAxF9[xF5kEg}RWB,?xZ',
    meta: {
      Size: '512x768',
      seed: 3271058046,
      steps: 30,
      prompt:
        '(nvinkpunk:1.2) (snthwve style:0.8) cat, anthro, lightwave, sunset, intricate, highly detailed',
      sampler: 'Euler a',
      cfgScale: 7,
      'Batch pos': '3',
      resources: [],
      'Batch size': '4',
      'Model hash': '27ea8c02',
      negativePrompt:
        'cartoon, 3d, ((disfigured)), ((bad art)), ((deformed)), ((poorly drawn)), ((extra limbs)), ((close up)), ((b&w)), weird colors, blurry',
    },
    hideMeta: false,
    generationProcess: 'txt2img',
    createdAt: '2023-05-29T22:02:31.297Z',
    mimeType: 'image/png',
    scannedAt: null,
    needsReview: false,
    postId: 203797,
    postTitle: 'A new early access model - v1.0123423 Showcase',
    index: 0,
    publishedAt: '2023-05-29T22:02:44.863Z',
    modelVersionId: 67454,
    cursorId: 749581,
    user: {
      id: 4,
      username: 'manuelurenah',
      image: 'https://avatars.githubusercontent.com/u/12631159?v=4',
      deletedAt: null,
      cosmetics: [
        {
          cosmetic: {
            id: 5,
            data: {
              url: 'c8f81b5d-b271-4ad4-0eeb-64c42621e300',
            },
            type: 'Badge',
            source: 'Event',
            name: 'Moderator Badge',
          },
        },
        {
          cosmetic: {
            id: 6,
            data: {
              variant: 'gradient',
              gradient: {
                to: '#de2222',
                deg: 180,
                from: '#b31a1a',
              },
            },
            type: 'NamePlate',
            source: 'Event',
            name: 'Moderator Nameplate',
          },
        },
      ],
    },
    stats: {
      cryCountAllTime: 0,
      laughCountAllTime: 0,
      likeCountAllTime: 0,
      dislikeCountAllTime: 0,
      heartCountAllTime: 0,
      commentCountAllTime: 0,
    },
    reactions: [],
    tags: [],
    report: null,
  },
  {
    id: 749580,
    name: '00063-1930968449-cf7-DPM++ 2M Karras-s24-5d83b27c.jpg',
    url: '46f6c076-b1b8-4ff2-b288-cd003fb9356f',
    nsfw: 'None',
    width: 512,
    height: 704,
    hash: 'UTH.A]-n_N9Z.9IUtSxuj^M{IUt7%MxaRiWB',
    meta: {
      ENSD: '31337',
      Size: '512x704',
      seed: 1930968449,
      Model: 'joMad+synth-ink-25',
      steps: 24,
      hashes: {
        model: '5d83b27c',
      },
      prompt:
        '(nvinkpunk:1.3) (snthwve style:1.4) lion, anthro, lightwave, sunset, intricate, highly detailed',
      sampler: 'DPM++ 2M Karras',
      Hypernet: 'SamDoesArts',
      cfgScale: 7,
      'Batch pos': '3',
      resources: [
        {
          hash: '5d83b27c',
          name: 'joMad+synth-ink-25',
          type: 'model',
        },
        {
          name: 'SamDoesArts',
          type: 'hypernet',
          weight: 0.254,
        },
      ],
      'Batch size': '4',
      'Model hash': '5d83b27c',
      negativePrompt:
        'cartoon, 3d, ((disfigured)), ((deformed)), ((poorly drawn)), ((extra limbs)), blurry',
      'Hypernet strength': '0.254',
    },
    hideMeta: false,
    generationProcess: 'txt2img',
    createdAt: '2023-05-29T19:21:42.630Z',
    mimeType: 'image/jpeg',
    scannedAt: null,
    needsReview: false,
    postId: 203796,
    postTitle: 'A new early access model - v1.0 Showcase',
    index: 1,
    publishedAt: '2023-05-29T19:21:51.410Z',
    modelVersionId: 67453,
    cursorId: 749580,
    user: {
      id: 4,
      username: 'manuelurenah',
      image: 'https://avatars.githubusercontent.com/u/12631159?v=4',
      deletedAt: null,
      cosmetics: [
        {
          cosmetic: {
            id: 5,
            data: {
              url: 'c8f81b5d-b271-4ad4-0eeb-64c42621e300',
            },
            type: 'Badge',
            source: 'Event',
            name: 'Moderator Badge',
          },
        },
        {
          cosmetic: {
            id: 6,
            data: {
              variant: 'gradient',
              gradient: {
                to: '#de2222',
                deg: 180,
                from: '#b31a1a',
              },
            },
            type: 'NamePlate',
            source: 'Event',
            name: 'Moderator Nameplate',
          },
        },
      ],
    },
    stats: {
      cryCountAllTime: 0,
      laughCountAllTime: 0,
      likeCountAllTime: 0,
      dislikeCountAllTime: 0,
      heartCountAllTime: 0,
      commentCountAllTime: 0,
    },
    reactions: [],
    tags: [],
    report: null,
  },
  {
    id: 749579,
    name: '00059-2021441386-cf7-DPM++ 2M Karras-s24-5d83b27c.jpg',
    url: 'bd684ebe-5c2f-46e5-bf03-48201a451576',
    nsfw: 'None',
    width: 512,
    height: 704,
    hash: 'UXG[pF.7%h~q~WxuXlxuE2RjROM{IpWBxFaz',
    meta: {
      ENSD: '31337',
      Size: '512x704',
      seed: 2021441386,
      Model: 'joMad+synth-ink-25',
      steps: 24,
      hashes: {
        model: '5d83b27c',
      },
      prompt:
        '[ : (style of joemadureira:0.6)  : 0.5] (nvinkpunk:1.3) (snthwve style:1.4) man, lightwave, sunset, paint splatter, intricate, highly detailed',
      sampler: 'DPM++ 2M Karras',
      Hypernet: 'SamDoesArts',
      cfgScale: 7,
      'Batch pos': '1',
      resources: [
        {
          hash: '5d83b27c',
          name: 'joMad+synth-ink-25',
          type: 'model',
        },
        {
          name: 'SamDoesArts',
          type: 'hypernet',
          weight: 0.254,
        },
      ],
      'Batch size': '4',
      'Model hash': '5d83b27c',
      negativePrompt:
        'cartoon, 3d, [woman : : 0.5] ((disfigured)), ((deformed)), ((poorly drawn)), ((extra limbs)), blurry',
      'Hypernet strength': '0.254',
    },
    hideMeta: false,
    generationProcess: 'txt2img',
    createdAt: '2023-05-29T19:21:42.583Z',
    mimeType: 'image/jpeg',
    scannedAt: null,
    needsReview: false,
    postId: 203796,
    postTitle: 'A new early access model - v1.0 Showcase',
    index: 0,
    publishedAt: '2023-05-29T19:21:51.410Z',
    modelVersionId: 67453,
    cursorId: 749579,
    user: {
      id: 4,
      username: 'manuelurenah',
      image: 'https://avatars.githubusercontent.com/u/12631159?v=4',
      deletedAt: null,
      cosmetics: [
        {
          cosmetic: {
            id: 5,
            data: {
              url: 'c8f81b5d-b271-4ad4-0eeb-64c42621e300',
            },
            type: 'Badge',
            source: 'Event',
            name: 'Moderator Badge',
          },
        },
        {
          cosmetic: {
            id: 6,
            data: {
              variant: 'gradient',
              gradient: {
                to: '#de2222',
                deg: 180,
                from: '#b31a1a',
              },
            },
            type: 'NamePlate',
            source: 'Event',
            name: 'Moderator Nameplate',
          },
        },
      ],
    },
    stats: {
      cryCountAllTime: 0,
      laughCountAllTime: 0,
      likeCountAllTime: 0,
      dislikeCountAllTime: 0,
      heartCountAllTime: 0,
      commentCountAllTime: 0,
    },
    reactions: [],
    tags: [],
    report: null,
  },
  {
    id: 749578,
    name: '00248-1398447640-cf7-Euler a-s30-27ea8c02.png',
    url: '3c24d4fe-a96c-4821-96ff-c8c1a802e1cb',
    nsfw: 'None',
    width: 512,
    height: 768,
    hash: 'UtGt?bWFD%bI}AWWS$jZ=vWVspjr-7bHoMf5',
    meta: {
      Size: '512x768',
      seed: 1398447640,
      steps: 30,
      prompt:
        '(nvinkpunk:1.2) (snthwve style:0.8) cityscape, lightwave, sunset, intricate, highly detailed',
      sampler: 'Euler a',
      cfgScale: 7,
      'Batch pos': '0',
      resources: [],
      'Batch size': '4',
      'Model hash': '27ea8c02',
      negativePrompt:
        'cartoon, 3d, ((disfigured)), ((bad art)), ((deformed)), ((poorly drawn)), ((extra limbs)), ((close up)), ((b&w)), weird colors, blurry',
    },
    hideMeta: false,
    generationProcess: 'txt2img',
    createdAt: '2023-05-29T17:55:48.410Z',
    mimeType: 'image/png',
    scannedAt: null,
    needsReview: false,
    postId: 203795,
    postTitle: 'A new early access model - v1.0 Showcase',
    index: 1,
    publishedAt: '2023-05-29T17:55:58.312Z',
    modelVersionId: null,
    cursorId: 749578,
    user: {
      id: 4,
      username: 'manuelurenah',
      image: 'https://avatars.githubusercontent.com/u/12631159?v=4',
      deletedAt: null,
      cosmetics: [
        {
          cosmetic: {
            id: 5,
            data: {
              url: 'c8f81b5d-b271-4ad4-0eeb-64c42621e300',
            },
            type: 'Badge',
            source: 'Event',
            name: 'Moderator Badge',
          },
        },
        {
          cosmetic: {
            id: 6,
            data: {
              variant: 'gradient',
              gradient: {
                to: '#de2222',
                deg: 180,
                from: '#b31a1a',
              },
            },
            type: 'NamePlate',
            source: 'Event',
            name: 'Moderator Nameplate',
          },
        },
      ],
    },
    stats: {
      cryCountAllTime: 0,
      laughCountAllTime: 0,
      likeCountAllTime: 0,
      dislikeCountAllTime: 0,
      heartCountAllTime: 0,
      commentCountAllTime: 0,
    },
    reactions: [],
    tags: [],
    report: null,
  },
  {
    id: 749577,
    name: '00246-2372518933-cf7-DPM++ 2M Karras-s24-5d83b27c.jpg',
    url: '89f0b784-fa04-4e49-ae1f-60158aef034e',
    nsfw: 'None',
    width: 512,
    height: 704,
    hash: 'UGGt~O$V~W~DQoD#0LIA9a.QAHb[Rg9exUs+',
    meta: {
      ENSD: '31337',
      Size: '512x704',
      seed: 2372518933,
      Model: 'joMad+synth-ink-25',
      steps: 24,
      hashes: {
        model: '5d83b27c',
      },
      prompt:
        '[ : (style of joemadureira:0.6) : 0.6] (nvinkpunk:1.3) (snthwve style:1.4)  anthropomorphic lion, lightwave, sunset, paint splatter, intricate, highly detailed',
      sampler: 'DPM++ 2M Karras',
      Hypernet: 'SamDoesArts',
      cfgScale: 7,
      'Batch pos': '0',
      resources: [
        {
          hash: '5d83b27c',
          name: 'joMad+synth-ink-25',
          type: 'model',
        },
        {
          name: 'SamDoesArts',
          type: 'hypernet',
          weight: 0.254,
        },
      ],
      'Batch size': '4',
      'Model hash': '5d83b27c',
      negativePrompt:
        'cartoon, 3d, woman, ((disfigured)), ((deformed)), ((poorly drawn)), ((extra limbs)), blurry',
      'Hypernet strength': '0.254',
    },
    hideMeta: false,
    generationProcess: 'txt2img',
    createdAt: '2023-05-29T17:55:48.334Z',
    mimeType: 'image/jpeg',
    scannedAt: null,
    needsReview: false,
    postId: 203795,
    postTitle: 'A new early access model - v1.0 Showcase',
    index: 0,
    publishedAt: '2023-05-29T17:55:58.312Z',
    modelVersionId: null,
    cursorId: 749577,
    user: {
      id: 4,
      username: 'manuelurenah',
      image: 'https://avatars.githubusercontent.com/u/12631159?v=4',
      deletedAt: null,
      cosmetics: [
        {
          cosmetic: {
            id: 5,
            data: {
              url: 'c8f81b5d-b271-4ad4-0eeb-64c42621e300',
            },
            type: 'Badge',
            source: 'Event',
            name: 'Moderator Badge',
          },
        },
        {
          cosmetic: {
            id: 6,
            data: {
              variant: 'gradient',
              gradient: {
                to: '#de2222',
                deg: 180,
                from: '#b31a1a',
              },
            },
            type: 'NamePlate',
            source: 'Event',
            name: 'Moderator Nameplate',
          },
        },
      ],
    },
    stats: {
      cryCountAllTime: 0,
      laughCountAllTime: 0,
      likeCountAllTime: 0,
      dislikeCountAllTime: 0,
      heartCountAllTime: 0,
      commentCountAllTime: 0,
    },
    reactions: [],
    tags: [],
    report: null,
  },
  {
    id: 749573,
    name: '00017-771659910-cf7-DPM++ 2M Karras-s24-5d83b27c.jpg',
    url: 'c37ad1cb-bfe6-4cf1-b396-7f5db9f8ef87',
    nsfw: 'None',
    width: 512,
    height: 704,
    hash: 'U9H-x@#jEQ.T4UKQ00rC1kv~^c%#VZX4S08{',
    meta: {
      ENSD: '31337',
      Size: '512x704',
      seed: 771659910,
      Model: 'joMad+synth-ink-25',
      steps: 24,
      hashes: {
        model: '5d83b27c',
      },
      prompt:
        'style of joemadureira (nvinkpunk:1.3) (snthwve style:1.4) award winning half body portrait of a woman in a croptop and cargo pants with ombre navy blue teal hairstyle with head in motion and hair flying, paint splashes, splatter, outrun, vaporware, shaded flat illustration, digital art, trending on artstation, highly detailed, fine detail, intricate',
      sampler: 'DPM++ 2M Karras',
      Hypernet: 'SamDoesArts',
      cfgScale: 7,
      'Batch pos': '1',
      resources: [
        {
          hash: '5d83b27c',
          name: 'joMad+synth-ink-25',
          type: 'model',
        },
        {
          name: 'SamDoesArts',
          type: 'hypernet',
          weight: 0.254,
        },
      ],
      'Batch size': '4',
      'Model hash': '5d83b27c',
      negativePrompt:
        'cartoon, 3d, ((disfigured)), ((deformed)), ((poorly drawn)), ((extra limbs)), blurry',
      'Hypernet strength': '0.254',
    },
    hideMeta: false,
    generationProcess: 'txt2img',
    createdAt: '2023-05-23T15:59:46.022Z',
    mimeType: 'image/jpeg',
    scannedAt: null,
    needsReview: false,
    postId: 203793,
    postTitle: null,
    index: 0,
    publishedAt: null,
    modelVersionId: 67448,
    cursorId: 749573,
    user: {
      id: 4,
      username: 'manuelurenah',
      image: 'https://avatars.githubusercontent.com/u/12631159?v=4',
      deletedAt: null,
      cosmetics: [
        {
          cosmetic: {
            id: 5,
            data: {
              url: 'c8f81b5d-b271-4ad4-0eeb-64c42621e300',
            },
            type: 'Badge',
            source: 'Event',
            name: 'Moderator Badge',
          },
        },
        {
          cosmetic: {
            id: 6,
            data: {
              variant: 'gradient',
              gradient: {
                to: '#de2222',
                deg: 180,
                from: '#b31a1a',
              },
            },
            type: 'NamePlate',
            source: 'Event',
            name: 'Moderator Nameplate',
          },
        },
      ],
    },
    stats: {
      cryCountAllTime: 0,
      laughCountAllTime: 0,
      likeCountAllTime: 0,
      dislikeCountAllTime: 0,
      heartCountAllTime: 0,
      commentCountAllTime: 0,
    },
    reactions: [],
    tags: [],
    report: null,
  },
  {
    id: 749572,
    name: '00240-1398447632-cf7-Euler a-s30-27ea8c02.png',
    url: 'c5311a95-35d1-4e42-8a19-60143186af6d',
    nsfw: 'None',
    width: 512,
    height: 768,
    hash: 'UBCHj0r@00Os}gni1zR*_Qo}7ziw*dbI67R,',
    meta: {
      Size: '512x768',
      seed: 1398447632,
      steps: 30,
      prompt:
        '(nvinkpunk:1.2) (snthwve style:0.8) cityscape, lightwave, sunset, intricate, highly detailed',
      sampler: 'Euler a',
      cfgScale: 7,
      'Batch pos': '0',
      resources: [],
      'Batch size': '4',
      'Model hash': '27ea8c02',
      negativePrompt:
        'cartoon, 3d, ((disfigured)), ((bad art)), ((deformed)), ((poorly drawn)), ((extra limbs)), ((close up)), ((b&w)), weird colors, blurry',
    },
    hideMeta: false,
    generationProcess: 'txt2img',
    createdAt: '2023-05-22T19:31:00.965Z',
    mimeType: 'image/png',
    scannedAt: null,
    needsReview: false,
    postId: 203792,
    postTitle: 'Test upscaler model - v1.0 Showcase',
    index: 0,
    publishedAt: '2023-05-22T19:31:13.809Z',
    modelVersionId: 67446,
    cursorId: 749572,
    user: {
      id: 4,
      username: 'manuelurenah',
      image: 'https://avatars.githubusercontent.com/u/12631159?v=4',
      deletedAt: null,
      cosmetics: [
        {
          cosmetic: {
            id: 5,
            data: {
              url: 'c8f81b5d-b271-4ad4-0eeb-64c42621e300',
            },
            type: 'Badge',
            source: 'Event',
            name: 'Moderator Badge',
          },
        },
        {
          cosmetic: {
            id: 6,
            data: {
              variant: 'gradient',
              gradient: {
                to: '#de2222',
                deg: 180,
                from: '#b31a1a',
              },
            },
            type: 'NamePlate',
            source: 'Event',
            name: 'Moderator Nameplate',
          },
        },
      ],
    },
    stats: {
      cryCountAllTime: 0,
      laughCountAllTime: 0,
      likeCountAllTime: 0,
      dislikeCountAllTime: 0,
      heartCountAllTime: 0,
      commentCountAllTime: 0,
    },
    reactions: [],
    tags: [],
    report: null,
  },
  {
    id: 749571,
    name: '00241-3216472368-cf7-DPM++ 2M Karras-s24-5d83b27c.jpg',
    url: 'f694e59a-82fa-4cb6-8fe0-a7fe147756e1',
    nsfw: 'None',
    width: 512,
    height: 704,
    hash: 'UCF}_p~m%Js#0CN39aER^tIoIow{4[Rhxao$',
    meta: {
      ENSD: '31337',
      Size: '512x704',
      seed: 3216472368,
      Model: 'joMad+synth-ink-25',
      steps: 24,
      hashes: {
        model: '5d83b27c',
      },
      prompt:
        '[ : (style of joemadureira:0.6) : 0.6] (nvinkpunk:1.3) (snthwve style:1.4)  anthropomorphic fox, lightwave, sunset, paint splatter, intricate, highly detailed',
      sampler: 'DPM++ 2M Karras',
      Hypernet: 'SamDoesArts',
      cfgScale: 7,
      'Batch pos': '3',
      resources: [
        {
          hash: '5d83b27c',
          name: 'joMad+synth-ink-25',
          type: 'model',
        },
        {
          name: 'SamDoesArts',
          type: 'hypernet',
          weight: 0.254,
        },
      ],
      'Batch size': '4',
      'Model hash': '5d83b27c',
      negativePrompt:
        'cartoon, 3d, woman, ((disfigured)), ((deformed)), ((poorly drawn)), ((extra limbs)), blurry',
      'Hypernet strength': '0.254',
    },
    hideMeta: false,
    generationProcess: 'txt2img',
    createdAt: '2023-05-22T19:31:00.631Z',
    mimeType: 'image/jpeg',
    scannedAt: null,
    needsReview: false,
    postId: 203792,
    postTitle: 'Test upscaler model - v1.0 Showcase',
    index: 1,
    publishedAt: '2023-05-22T19:31:13.809Z',
    modelVersionId: 67446,
    cursorId: 749571,
    user: {
      id: 4,
      username: 'manuelurenah',
      image: 'https://avatars.githubusercontent.com/u/12631159?v=4',
      deletedAt: null,
      cosmetics: [
        {
          cosmetic: {
            id: 5,
            data: {
              url: 'c8f81b5d-b271-4ad4-0eeb-64c42621e300',
            },
            type: 'Badge',
            source: 'Event',
            name: 'Moderator Badge',
          },
        },
        {
          cosmetic: {
            id: 6,
            data: {
              variant: 'gradient',
              gradient: {
                to: '#de2222',
                deg: 180,
                from: '#b31a1a',
              },
            },
            type: 'NamePlate',
            source: 'Event',
            name: 'Moderator Nameplate',
          },
        },
      ],
    },
    stats: {
      cryCountAllTime: 0,
      laughCountAllTime: 0,
      likeCountAllTime: 0,
      dislikeCountAllTime: 0,
      heartCountAllTime: 0,
      commentCountAllTime: 0,
    },
    reactions: [],
    tags: [],
    report: null,
  },
];

type State = {
  layout: 'list' | 'grid';
  selectedItems: number[];
};

export function Feed() {
  const mobile = useIsMobile({ breakpoint: 'md' });
  const [state, setState] = useState<State>({
    layout: 'grid',
    selectedItems: [],
  });

  return (
    <Stack sx={{ position: 'relative' }}>
      <Group spacing="xs">
        <Autocomplete
          placeholder="Search by prompt"
          data={[]}
          icon={<IconSearch size={14} />}
          sx={{ flex: 1 }}
        />
        <Group spacing={4}>
          <Tooltip label="Sort items">
            <ActionIcon size="xs">
              <IconSortDescending2 />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Toggle filter toolbar">
            <ActionIcon size="xs">
              <IconFilter />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={state.layout === 'grid' ? 'List layout' : 'Grid layout'}>
            <ActionIcon
              size="xs"
              onClick={() =>
                setState((current) => ({
                  ...current,
                  layout: current.layout === 'grid' ? 'list' : 'grid',
                }))
              }
            >
              {state.layout === 'grid' ? <IconLayoutList /> : <IconLayoutGrid />}
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>
      <ScrollArea.Autosize maxHeight={mobile ? 'calc(90vh - 139px)' : 'calc(100vh - 139px)'}>
        <SimpleGrid cols={2} spacing="md">
          {images.map((image) => {
            const selected = state.selectedItems.includes(image.id);

            return (
              <Paper
                key={image.id}
                radius="sm"
                sx={(theme) => ({
                  position: 'relative',
                  // If the item is selected, we want to add an overlay to it
                  '&::after': selected
                    ? {
                        content: '""',
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: '100%',
                        backgroundColor: theme.fn.rgba(
                          theme.colors.blue[theme.fn.primaryShade()],
                          0.3
                        ),
                      }
                    : undefined,
                })}
              >
                <Checkbox
                  sx={(theme) => ({
                    position: 'absolute',
                    top: theme.spacing.xs,
                    left: theme.spacing.xs,
                    zIndex: 100,
                  })}
                  checked={selected}
                  onChange={(event) => {
                    if (event.target.checked) {
                      setState((current) => ({
                        ...current,
                        selectedItems: [...current.selectedItems, image.id],
                      }));
                    } else {
                      setState((current) => ({
                        ...current,
                        selectedItems: current.selectedItems.filter((id) => id !== image.id),
                      }));
                    }
                  }}
                />
                <AspectRatio ratio={1}>
                  <EdgeImage src={image.url} width={image.width} />
                </AspectRatio>
              </Paper>
            );
          })}
        </SimpleGrid>
      </ScrollArea.Autosize>
      <FloatingActions
        selectCount={state.selectedItems.length}
        onDeselectClick={() =>
          setState((current) => ({
            ...current,
            selectedItems: [],
          }))
        }
      />
    </Stack>
  );
}

function FloatingActions({ selectCount, onDeselectClick }: FloatingActionsProps) {
  return (
    <Transition mounted={selectCount > 0} transition="slide-up">
      {(transitionStyles) => (
        <Card
          p="xs"
          radius={0}
          style={transitionStyles}
          sx={{ position: 'absolute', bottom: 0, left: 0 }}
          withBorder
        >
          <Stack spacing={4}>
            <Text color="dimmed" size="xs" inline>
              {selectCount} selected
            </Text>
            <Group spacing={8}>
              <Tooltip label="Deselect all" withinPortal>
                <ActionIcon size="md" onClick={onDeselectClick} variant="light">
                  <IconSquareOff />
                </ActionIcon>
              </Tooltip>
              <Tooltip label="Post images" withinPortal>
                <ActionIcon size="md" variant="light">
                  <IconCloudUpload />
                </ActionIcon>
              </Tooltip>
              <Tooltip label="Upscale images" withinPortal>
                <ActionIcon size="md" variant="light" disabled>
                  <IconWindowMaximize />
                </ActionIcon>
              </Tooltip>
              <Tooltip label="Delete images" withinPortal>
                <ActionIcon size="md" variant="light" color="red">
                  <IconTrash />
                </ActionIcon>
              </Tooltip>
            </Group>
          </Stack>
        </Card>
      )}
    </Transition>
  );
}

type FloatingActionsProps = {
  selectCount: number;
  onDeselectClick: () => void;
};
