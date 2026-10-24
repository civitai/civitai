import { Alert, Badge, Button, Code, Container, Stack, Table, Text, Title } from '@mantine/core';
import { useEffect, useState } from 'react';
import {
  AdUnitIncontent_1,
  AdUnitSide_1,
  AdUnitSide_2,
  AdUnitSide_3,
  AdUnitTop,
} from '~/components/Ads/AdUnit';
import { AdUnitOutstream } from '~/components/Ads/AdUnitOutstream';
import { AD_ENGINE_PARAM, useAdsContext } from '~/components/Ads/AdsProvider';
import { IsClient } from '~/components/IsClient/IsClient';
import { Meta } from '~/components/Meta/Meta';

declare global {
  interface Window {
    __gpp?: (...args: any[]) => void;
  }
}

type Runtime = {
  loaderSrc: string | null;
  loaderReady: boolean;
  tcfApi: boolean;
  gppApi: boolean;
  slots: string[];
};

const emptyRuntime: Runtime = {
  loaderSrc: null,
  loaderReady: false,
  tcfApi: false,
  gppApi: false,
  slots: [],
};

function readRuntime(): Runtime {
  const loader = document.querySelector<HTMLScriptElement>('script[src*="adengine/civitai.com"]');
  let slots: string[] = [];
  try {
    slots =
      window.googletag
        ?.pubads?.()
        ?.getSlots?.()
        ?.map((slot: any) => slot.getSlotElementId()) ?? [];
  } catch {
    slots = [];
  }

  return {
    loaderSrc: loader?.src ?? null,
    loaderReady: !!window.adngin?.adnginLoaderReady,
    tcfApi: typeof window.__tcfapi === 'function',
    gppApi: typeof window.__gpp === 'function',
    slots,
  };
}

type TcData = {
  cmpId?: number;
  cmpStatus?: string;
  eventStatus?: string;
  gdprApplies?: boolean;
  tcString?: string;
};

/** Stays subscribed rather than detaching on the first payload like `AdsProvider` does, so a
 *  consent decision made in the banner shows up here without a reload. */
function useTcData() {
  const [tcData, setTcData] = useState<TcData | null>(null);

  useEffect(() => {
    let listenerId: number | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;

    function attach() {
      if (typeof window.__tcfapi !== 'function') return false;
      window.__tcfapi('addEventListener', 2, (data: any, success: boolean) => {
        if (!success || !data) return;
        listenerId = data.listenerId;
        const { cmpId, cmpStatus, eventStatus, gdprApplies, tcString } = data;
        setTcData({ cmpId, cmpStatus, eventStatus, gdprApplies, tcString });
      });
      return true;
    }

    if (!attach()) {
      poll = setInterval(() => {
        if (attach() && poll) clearInterval(poll);
      }, 500);
    }

    return () => {
      if (poll) clearInterval(poll);
      if (listenerId !== undefined && typeof window.__tcfapi === 'function')
        window.__tcfapi('removeEventListener', 2, null, listenerId);
    };
  }, []);

  return tcData;
}

function Flag({ value, labels = ['yes', 'no'] }: { value?: boolean; labels?: [string, string] }) {
  return (
    <Badge color={value ? 'green' : 'red'} variant="light">
      {value ? labels[0] : labels[1]}
    </Badge>
  );
}

function Diagnostics() {
  const { adEngine, adsEnabled, adsBlocked, ready, consent, isMember } = useAdsContext();
  const tcData = useTcData();
  const [runtime, setRuntime] = useState(emptyRuntime);

  useEffect(() => {
    setRuntime(readRuntime());
    const interval = setInterval(() => setRuntime(readRuntime()), 1000);
    return () => clearInterval(interval);
  }, []);

  const rows: [string, React.ReactNode][] = [
    [
      'Ad engine requested',
      <Badge key="engine" color={adEngine === 'staging' ? 'orange' : 'blue'}>
        {adEngine}
      </Badge>,
    ],
    [
      'Loader script on page',
      runtime.loaderSrc ? (
        <Code key="src">{runtime.loaderSrc}</Code>
      ) : (
        <Flag key="src" value={false} labels={['', 'not present']} />
      ),
    ],
    ['Loader initialized (adngin)', <Flag key="loaded" value={runtime.loaderReady} />],
    [
      'Slots registered with GPT',
      <Code key="slots">{runtime.slots.length ? runtime.slots.join(', ') : 'none'}</Code>,
    ],
    ['__tcfapi present', <Flag key="tcf" value={runtime.tcfApi} />],
    ['__gpp present', <Flag key="gpp" value={runtime.gppApi} />],
    ['CMP id', <Code key="cmpId">{tcData?.cmpId ?? '—'}</Code>],
    ['CMP status', <Code key="cmpStatus">{tcData?.cmpStatus ?? '—'}</Code>],
    ['TCF event status', <Code key="eventStatus">{tcData?.eventStatus ?? '—'}</Code>],
    ['gdprApplies', <Code key="gdpr">{String(tcData?.gdprApplies ?? '—')}</Code>],
    [
      'TC string',
      <Code key="tcString">
        {tcData?.tcString
          ? `${tcData.tcString.slice(0, 32)}… (${tcData.tcString.length} chars)`
          : '—'}
      </Code>,
    ],
    ['Ads enabled for this page', <Flag key="enabled" value={adsEnabled} />],
    ['Ads confirmed blocked', <Flag key="blocked" value={!adsBlocked} labels={['no', 'yes']} />],
    ['Auctions allowed to start', <Flag key="ready" value={ready} />],
    ['Consent granted', <Flag key="consent" value={consent} />],
    ['Viewer is a member', <Code key="member">{String(isMember)}</Code>],
  ];

  return (
    <Table>
      <Table.Tbody>
        {rows.map(([label, value]) => (
          <Table.Tr key={label}>
            <Table.Td className="w-64">
              <Text size="sm">{label}</Text>
            </Table.Td>
            <Table.Td>{value}</Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

function Slot({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-dashed border-gray-4 p-3 dark:border-dark-4">
      <Text size="xs" c="dimmed" tt="uppercase" mb="xs">
        {name}
      </Text>
      {children}
    </div>
  );
}

export default function AdsTestPage() {
  const { adEngine, adsEnabled } = useAdsContext();

  return (
    <Container size="xl" py="md">
      <Meta title="Ad engine test page" deIndex />
      <Stack gap="lg">
        <div>
          <Title order={2}>Ad engine test page</Title>
          <Text c="dimmed" size="sm">
            Every ad unit the site runs, on one page, alongside the CMP state the loader reports.
            Adding <Code>?{AD_ENGINE_PARAM}=staging</Code> to any URL on the site loads
            Snigel&apos;s staging ad engine in place of production; the choice sticks for the rest
            of the browser tab, so you can browse normally afterwards.{' '}
            <Code>?{AD_ENGINE_PARAM}=production</Code> switches back.
          </Text>
        </div>

        {/* Client-gated: the engine is resolved from sessionStorage, which SSR can't see. */}
        <IsClient>
          {adEngine === 'production' && (
            <Alert color="blue">
              Running the production ad engine.{' '}
              <Button
                component="a"
                href={`?${AD_ENGINE_PARAM}=staging`}
                size="compact-sm"
                variant="light"
              >
                Reload with the staging engine
              </Button>
            </Alert>
          )}
          <Diagnostics />
        </IsClient>

        {!adsEnabled && (
          <Alert color="yellow" title="No ads will render on this page">
            Ads are switched off for this session. The usual causes: a local dev build (ads are off
            in dev), signed in as a member with ads disabled, a browser that filters ad elements
            (Brave), or a region whose consent banner hasn&apos;t been accepted yet.
          </Alert>
        )}

        <Slot name="top">
          <AdUnitTop />
        </Slot>
        <Slot name="incontent_1">
          <AdUnitIncontent_1 />
        </Slot>
        <div className="flex flex-wrap gap-3">
          <Slot name="side_1 — container ≥1200px">
            <AdUnitSide_1 />
          </Slot>
          <Slot name="side_2 — container ≥1200px">
            <AdUnitSide_2 />
          </Slot>
          <Slot name="side_3">
            <AdUnitSide_3 />
          </Slot>
        </div>
        <Slot name="outstream">
          <AdUnitOutstream />
        </Slot>
        <Text size="sm" c="dimmed">
          The adhesive unit is rendered by the site layout at the bottom of the viewport, not by
          this page.
        </Text>
      </Stack>
    </Container>
  );
}
