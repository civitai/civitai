import { Badge, Card, SegmentedControl, Text, Tooltip } from '@mantine/core';
import { IconClock, IconHierarchy, IconInfoCircle, IconSettings } from '@tabler/icons-react';
import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { Page } from '~/components/AppLayout/Page';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { Meta } from '~/components/Meta/Meta';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

/**
 * Throwaway option-review page for ticket 868kumuhp. Renders candidate
 * treatments for remix-gallery discoverability against real thumbnails, inside
 * the same `contain: paint` clipping the virtualised feed imposes, so a
 * treatment that would be sliced in the real feed is sliced here too.
 *
 * Not a feature, and not on a path to becoming one. Delete with the branch.
 */

type Demo = { id: number; url: string; width: number; height: number; username: string };

const IMAGES: Demo[] = [
  {
    id: 140555502,
    url: '0134d13b-0151-46ff-ab19-d3953096dc82',
    width: 800,
    height: 1056,
    username: 'LaffyGaffy2089',
  },
  {
    id: 140555347,
    url: 'e8e48fe3-d6a5-48ba-af6f-17adb1943919',
    width: 1024,
    height: 1024,
    username: 'take3tu',
  },
  {
    id: 140555328,
    url: '0fcdb681-ebf4-4c7a-9301-93e5dc099ecf',
    width: 1024,
    height: 1024,
    username: 'take3tu',
  },
  {
    id: 140555295,
    url: 'eed4c583-05a8-4b98-9057-58487bcba57f',
    width: 832,
    height: 1216,
    username: 'chamo9009',
  },
  {
    id: 140555294,
    url: '558a5e82-55f3-4108-b5ad-a1504591ca2d',
    width: 832,
    height: 1216,
    username: 'chamo9009',
  },
  {
    id: 140555250,
    url: 'ceb3e309-01ec-49f2-923a-0f0ca1b1dd8f',
    width: 1024,
    height: 1024,
    username: 'Tinydramaticartist',
  },
  {
    id: 140555213,
    url: '9a4f3c62-93b0-4c46-a9ed-185cda3bea6b',
    width: 1024,
    height: 1024,
    username: 'Tinydramaticartist',
  },
  {
    id: 140555208,
    url: '31c35265-587b-4170-b7fe-44ba5e21b7ba',
    width: 1024,
    height: 1024,
    username: 'Escorwn',
  },
  {
    id: 140555207,
    url: '1fc08b9b-462b-4ffb-9227-8a42c0310a82',
    width: 1024,
    height: 1024,
    username: 'signalofsolarum',
  },
  {
    id: 140555095,
    url: '51c9d355-a2ab-4f47-bb39-e58b9a82268d',
    width: 1024,
    height: 1024,
    username: 'signalofsolarum',
  },
  {
    id: 140555087,
    url: 'ed609404-d8c8-43e1-a856-218419d44dac',
    width: 3328,
    height: 4864,
    username: 'Eudie_Maiden_Reborn',
  },
  {
    id: 140555059,
    url: '39d59bcc-6470-431b-a953-9ea414eac66f',
    width: 984,
    height: 1280,
    username: 'BOT1NORESPONSE',
  },
  {
    id: 140555058,
    url: '58156d8e-90b9-4a9c-9f38-7163ddecc144',
    width: 1024,
    height: 1024,
    username: 'signalofsolarum',
  },
  {
    id: 140555057,
    url: 'ab611d4d-b7af-454b-92cd-2628e141c212',
    width: 1024,
    height: 1024,
    username: 'signalofsolarum',
  },
  {
    id: 140555056,
    url: '8654839d-60d1-4af0-904b-7d5bbdc8871d',
    width: 1024,
    height: 1024,
    username: 'signalofsolarum',
  },
  {
    id: 140555049,
    url: '2df721f5-928d-45b9-a79b-f79adfc2731c',
    width: 1024,
    height: 1024,
    username: 'signalofsolarum',
  },
  {
    id: 140555047,
    url: '77b03354-8d10-49a7-8557-75a86ee85834',
    width: 1024,
    height: 1024,
    username: 'signalofsolarum',
  },
  {
    id: 140555040,
    url: '36a97a8d-9c9d-4cab-82e7-8942b34d4722',
    width: 1024,
    height: 1024,
    username: 'signalofsolarum',
  },
  {
    id: 140555030,
    url: '21738c23-da39-41da-a76d-6ba748a3a80d',
    width: 832,
    height: 1216,
    username: 'Nonamedgg',
  },
  {
    id: 140555024,
    url: 'ed5b1dce-602c-4143-befe-5bf17f362853',
    width: 1024,
    height: 1024,
    username: 'signalofsolarum',
  },
  {
    id: 140555020,
    url: '647c5e51-0b68-405e-9b17-71d47ba9500c',
    width: 3328,
    height: 4864,
    username: 'Eudie_Maiden_Reborn',
  },
  {
    id: 140555019,
    url: '1decd00f-d951-41b0-8b46-2172d2798b87',
    width: 1024,
    height: 1024,
    username: 'signalofsolarum',
  },
  {
    id: 140555018,
    url: 'a7143165-6b00-498d-83e9-cbf94d838882',
    width: 1024,
    height: 1024,
    username: 'signalofsolarum',
  },
  {
    id: 140555017,
    url: '19793239-834b-4272-8fef-9519fb0b34ae',
    width: 1024,
    height: 1024,
    username: 'signalofsolarum',
  },
];

/**
 * Which demo cards carry a gallery, and how many entries.
 *
 * Deliberately sparse and lopsided. Production has 237 host images with any
 * approved entry at all and 176 of those hold exactly one, so a mock where every
 * card blooms would make every option look better than it is.
 */
const GALLERIES: Record<number, number> = {
  140555347: 1,
  140555295: 3,
  140555208: 12,
  140555058: 1,
  140555030: 4,
};

const entriesFor = (id: number) => GALLERIES[id] ?? 0;

/** Stand-in entries: other demo images, so every tile is a real asset. */
const remixesFor = (id: number, count: number) =>
  IMAGES.filter((image) => image.id !== id).slice(id % 7, (id % 7) + count);

type Option = 'none' | 'chip' | 'peel' | 'faces' | 'first';

const OPTIONS: { value: Option; label: string }[] = [
  { value: 'none', label: 'Today' },
  { value: 'chip', label: 'A - Count chip' },
  { value: 'peel', label: 'B - Hover peel' },
  { value: 'faces', label: 'C - Faces' },
  { value: 'first', label: 'D - Be the first' },
];

const BLURB: Record<Option, string> = {
  none: 'The feed as it ships today. Nothing on any card says a remix gallery exists, or that you could pay to be in one.',
  chip: 'A persistent pill, bottom-left: up to three remix thumbs, the gallery icon, and the total. Visible with no gesture, works on touch, reads at a glance. One batched query per 100 cards.',
  peel: 'No chrome until you dwell. After 600ms a filmstrip peels up from the bottom edge with the entries and who made them. Sweep the grid and nothing opens - the counter proves it.',
  faces:
    'People rather than a number. Overlapping submitter avatars and a "Remixed by" line. Sells what a payer is actually buying, which is their name on someone else’s card.',
  first:
    'The state nearly every image is in. 237 images have a remix in them; every image is open to submissions by default. This markets the empty gallery instead of the full one.',
};

function RemixGalleryOptions() {
  const [option, setOption] = useState<Option>('chip');
  const [opens, setOpens] = useState(0);

  return (
    <>
      <Meta title="Remix gallery - discoverability options" deIndex />
      <div className="container max-w-[1400px] py-4">
        <div className="sticky top-0 z-30 -mx-2 mb-4 bg-white/95 px-2 py-3 backdrop-blur dark:bg-dark-7/95">
          <Text component="div" className="mb-1 flex items-center gap-2 text-xl font-semibold">
            <IconHierarchy /> Remix gallery discoverability
            <Badge color="gray" variant="light" size="sm">
              868kumuhp
            </Badge>
          </Text>
          <SegmentedControl
            value={option}
            onChange={(value) => setOption(value as Option)}
            data={OPTIONS}
            fullWidth
          />
          <Text size="sm" c="dimmed" className="mt-2">
            {BLURB[option]}
          </Text>
          <Text size="xs" c="dimmed" className="mt-1">
            5 of these 24 cards carry a gallery - 1, 3, 12, 1 and 4 entries. That sparseness is the
            real production distribution, not a placeholder.
          </Text>
        </div>

        {option === 'peel' && (
          <div className="fixed right-4 top-32 z-40 rounded-md bg-black/80 px-3 py-2 text-white">
            <Text size="xs" className="opacity-70">
              strips opened
            </Text>
            <Text className="text-2xl font-bold tabular-nums">{opens}</Text>
            <Text size="xs" className="max-w-[150px] opacity-70">
              Sweep the grid, then scroll with the pointer parked. Should stay put.
            </Text>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
          {IMAGES.map((image) => (
            <DemoCard
              key={image.id}
              image={image}
              option={option}
              onOpen={() => setOpens((count) => count + 1)}
            />
          ))}
        </div>

        <DetailBarSection />

        <Card className="mt-8 rounded-xl" withBorder>
          <Text className="mb-2 flex items-center gap-2 font-semibold">
            <IconInfoCircle size={18} /> What the production numbers say
          </Text>
          <Text size="sm" c="dimmed">
            237 images site-wide have any approved remix in their gallery, and 176 of those have
            exactly one. 355 approved placements, from 82 distinct payers, across 134 owners.
            Meanwhile every image is open to submissions by default, with only 294 explicitly
            closed. So A, B and C mark a state that is currently almost absent from the site, while
            D and E mark the state nearly every image is in.
          </Text>
        </Card>
      </div>
    </>
  );
}

function DemoCard({ image, option, onOpen }: { image: Demo; option: Option; onOpen: () => void }) {
  const count = entriesFor(image.id);
  const remixes = remixesFor(image.id, Math.min(count, 6));

  return (
    // `contain: paint` reproduces the virtualiser's clipping. A treatment that
    // overhangs the card is sliced here exactly as it would be in the real feed.
    <div style={{ contentVisibility: 'auto', containIntrinsicSize: '300px 400px' }}>
      <div className="relative overflow-hidden rounded-lg bg-gray-2 dark:bg-dark-6">
        {/* The media box clips on its own account, so a closed peel sits outside
            it rather than over the row beneath. */}
        <div className="relative overflow-hidden">
          <EdgeMedia
            src={image.url}
            type="image"
            width={450}
            className="w-full"
            style={{ aspectRatio: `${image.width} / ${image.height}`, objectFit: 'cover' }}
          />
          {option === 'chip' && count > 0 && <CountChip count={count} remixes={remixes} />}
          {option === 'peel' && count > 0 && (
            <HoverPeel count={count} remixes={remixes} onOpen={onOpen} />
          )}
          {option === 'faces' && count > 0 && <FaceCluster count={count} remixes={remixes} />}
          {option === 'first' && <BeTheFirst count={count} />}
        </div>
        <div className="flex items-center justify-between px-2 py-1.5">
          <Text size="xs" c="dimmed" className="truncate">
            {image.username}
          </Text>
          <Text size="xs" c="dimmed">
            128 reactions
          </Text>
        </div>
      </div>
    </div>
  );
}

/** Option A - persistent pill, bottom-left. */
function CountChip({ count, remixes }: { count: number; remixes: Demo[] }) {
  return (
    <Tooltip
      withinPortal
      label={`${count} ${count === 1 ? 'remix' : 'remixes'} in this image's gallery`}
    >
      <div className="pointer-events-auto absolute bottom-2 left-2 z-10 flex h-7 items-center gap-1 rounded-full bg-black/60 pl-1 pr-2 ring-1 ring-white/10 backdrop-blur-sm transition hover:brightness-125">
        {remixes.slice(0, 3).map((remix, index) => (
          <EdgeMedia
            key={remix.id}
            src={remix.url}
            type="image"
            width={64}
            className={clsx(
              'size-5 rounded-[4px] object-cover ring-1 ring-black/50',
              index > 0 && '-ml-2'
            )}
          />
        ))}
        <IconHierarchy size={13} className="shrink-0 text-lime-4" />
        <Text size="xs" fw={600} className="text-white">
          {count}
        </Text>
      </div>
    </Tooltip>
  );
}

/**
 * Option B - nothing until a deliberate dwell.
 *
 * The gate is the design, so the prototype implements it rather than opening on
 * hover: 600ms dwell, restarted by pointer movement over 6px, cancelled by any
 * scroll. An instant-open mock would demonstrate the opposite of the property
 * being judged.
 */
function HoverPeel({
  count,
  remixes,
  onOpen,
}: {
  count: number;
  remixes: Demo[];
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [who, setWho] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);

  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const arm = () => {
    cancel();
    timer.current = setTimeout(() => {
      setOpen(true);
      onOpen();
    }, 600);
  };

  useEffect(() => {
    const onScroll = () => {
      cancel();
      setOpen(false);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      cancel();
    };
  }, []);

  return (
    <div
      className="absolute inset-0 z-10"
      onPointerEnter={(event) => {
        if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
        origin.current = { x: event.clientX, y: event.clientY };
        arm();
      }}
      onPointerMove={(event) => {
        if (open || !origin.current || !timer.current) return;
        const dx = event.clientX - origin.current.x;
        const dy = event.clientY - origin.current.y;
        if (Math.hypot(dx, dy) > 6) {
          origin.current = { x: event.clientX, y: event.clientY };
          arm();
        }
      }}
      onPointerLeave={() => {
        cancel();
        setOpen(false);
        setWho(null);
      }}
    >
      <div
        className={clsx(
          'absolute inset-x-0 bottom-0 z-20 overflow-hidden bg-gradient-to-t from-black/90 via-black/75 to-transparent transition-transform',
          open ? 'translate-y-0' : 'translate-y-full'
        )}
        style={{
          height: 88,
          transitionDuration: open ? '220ms' : '160ms',
          transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        <div className="flex items-center gap-1 px-2 pt-1.5">
          <IconHierarchy size={12} className="shrink-0 text-yellow-6" />
          <Text size="xs" className="truncate text-white/75">
            {who ? `Remixed by ${who}` : `${count} ${count === 1 ? 'remix' : 'remixes'}`}
          </Text>
        </div>
        <div className="flex gap-1 px-2 pt-1">
          {remixes.slice(0, 4).map((remix) => (
            <div
              key={remix.id}
              onPointerEnter={() => setWho(remix.username)}
              onPointerLeave={() => setWho(null)}
            >
              <EdgeMedia
                src={remix.url}
                type="image"
                width={128}
                className="size-16 rounded-md object-cover ring-1 ring-white/20 hover:ring-2 hover:ring-yellow-5"
              />
            </div>
          ))}
          {count > 4 && (
            <div className="flex size-16 items-center justify-center rounded-md bg-white/10">
              <Text size="xs" fw={600} className="text-white">
                +{count - 4}
              </Text>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Option C - submitter faces, not a count. */
function FaceCluster({ count, remixes }: { count: number; remixes: Demo[] }) {
  const names = remixes.slice(0, 2).map((remix) => remix.username);
  return (
    <div className="pointer-events-auto absolute inset-x-0 bottom-0 z-10 flex items-center gap-2 bg-gradient-to-t from-black/85 to-transparent px-2 pb-1.5 pt-6">
      <div className="flex">
        {remixes.slice(0, 4).map((remix, index) => (
          <EdgeMedia
            key={remix.id}
            src={remix.url}
            type="image"
            width={64}
            className={clsx(
              'size-6 rounded-full object-cover ring-2 ring-black/70',
              index > 0 && '-ml-2'
            )}
          />
        ))}
        {count > 4 && (
          <div className="-ml-2 flex size-6 items-center justify-center rounded-full bg-gray-7 ring-2 ring-black/70">
            <Text size="xs" fw={600} className="text-white">
              +{count - 4}
            </Text>
          </div>
        )}
      </div>
      <Text size="xs" className="truncate text-white/85">
        Remixed by {names.join(', ')}
        {count > names.length ? ` +${count - names.length}` : ''}
      </Text>
    </div>
  );
}

/**
 * Option D - markets the open gallery rather than the full one.
 *
 * Renders on every card, including the ones with no entries, because that is the
 * state nearly every image on the site is in.
 */
function BeTheFirst({ count }: { count: number }) {
  return (
    <div className="pointer-events-auto absolute bottom-2 left-2 z-10 flex h-7 items-center gap-1.5 rounded-full bg-black/60 px-2 ring-1 ring-white/10 backdrop-blur-sm transition hover:bg-yellow-6">
      <IconHierarchy size={13} className="shrink-0 text-yellow-5" />
      <Text size="xs" fw={600} className="text-white">
        {count > 0 ? `${count} remixed - add yours` : 'Be the first remix'}
      </Text>
    </div>
  );
}

/**
 * Option E - the detail page's reaction row, mocked.
 *
 * Not the real detail page: this is the row from `ImageDetail2` reproduced at
 * size so the bar can be judged beside the reaction pills it would sit next to,
 * without editing a shipping component to show a proposal.
 */
function DetailBarSection() {
  const [state, setState] = useState<'entries' | 'empty' | 'owner' | 'pending'>('entries');

  return (
    <Card className="mt-8 rounded-xl" withBorder>
      <Text className="mb-1 flex items-center gap-2 font-semibold">
        <IconHierarchy size={18} /> Option E - a bar in the image detail reaction row
      </Text>
      <Text size="sm" c="dimmed" className="mb-3">
        Sits beside the sticker bar under the image, above the fold on every screen size, and on
        mobile too - where the gallery card is currently behind a drawer gesture plus five blocks of
        scroll. Needs no new server work: the detail page already runs both gallery queries, so a
        bar in the same tree shares their cache and costs zero extra requests.
      </Text>
      <SegmentedControl
        value={state}
        onChange={(value) => setState(value as typeof state)}
        className="mb-4"
        data={[
          { value: 'entries', label: 'Has entries' },
          { value: 'empty', label: 'Empty, open' },
          { value: 'owner', label: 'Owner, waiting' },
          { value: 'pending', label: 'Your remix pending' },
        ]}
      />
      <div className="flex flex-wrap items-center justify-center gap-2 rounded-lg bg-gray-1 p-4 dark:bg-dark-6">
        <div className="flex h-[30px] items-center gap-2 rounded-3xl bg-gray-8/40 px-3">
          <Text size="xs" className="text-white">
            128
          </Text>
          <Text size="xs" className="text-white">
            42
          </Text>
          <Text size="xs" className="text-white">
            7
          </Text>
        </div>
        <div className="flex h-[30px] items-center gap-1.5 rounded-3xl bg-gray-8/40 px-3">
          <Text size="xs" className="text-white">
            3 stickers
          </Text>
        </div>
        <div
          className={clsx(
            'flex h-[30px] items-center gap-1.5 rounded-3xl px-3',
            state === 'owner' ? 'bg-yellow-6' : 'bg-gray-8/40'
          )}
        >
          <IconHierarchy size={16} className={state === 'owner' ? 'text-black' : 'text-lime-4'} />
          {state === 'entries' && (
            <>
              <Text size="xs" fw={500} className="text-white">
                4
              </Text>
              <div className="flex">
                {IMAGES.slice(2, 5).map((remix, index) => (
                  <EdgeMedia
                    key={remix.id}
                    src={remix.url}
                    type="image"
                    width={64}
                    className={clsx(
                      'size-5 rounded-full object-cover ring-1 ring-white/40',
                      index > 0 && '-ml-2'
                    )}
                  />
                ))}
              </div>
            </>
          )}
          {state === 'empty' && (
            <Text size="xs" fw={500} className="text-white">
              Be the first remix
            </Text>
          )}
          {state === 'owner' && (
            <>
              <IconSettings size={14} className="text-black" />
              <Text size="xs" fw={600} className="text-black">
                2 waiting
              </Text>
            </>
          )}
          {state === 'pending' && (
            <>
              <Text size="xs" fw={500} className="text-white">
                1
              </Text>
              <IconClock size={14} className="text-yellow-5" />
            </>
          )}
        </div>
      </div>
      <Text size="xs" c="dimmed" className="mt-3">
        The owner state is the one that earns the bar even at zero entries: today a creator only
        learns someone is waiting on them by scrolling to the card.
      </Text>
    </Card>
  );
}

export const getServerSideProps = createServerSideProps({ requireModerator: true });

export default Page(RemixGalleryOptions);
