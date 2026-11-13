import { Alert, Badge, Code, Group, Stack, Tabs, Text, Title } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';
import { ManifestScopes, ManifestView } from '~/components/Apps/OnsiteReviewModal';
import { ListingCoverThumb, ListingIconThumb } from '~/components/Apps/ListingMediaThumb';
import { ReportTabs } from '~/components/Apps/ReportTabs';
import { FileDiffEntry, type FileLineDiff } from '~/components/Apps/reviewDiffPanels';
import {
  REVIEW_DETAIL_TAB_LABELS,
  REVIEW_DETAIL_TAB_VALUES,
  type ReviewDetailTab,
} from '~/components/Apps/reviewDetailTabs';
// 🔴 THE ICONS ARE IMPORTED, NOT RE-DECLARED. The docstring below claims this shell cannot
// drift from the real bar; a local copy of the icon map made that claim false for the one
// thing a preview exists to show.
import { TAB_ICONS } from '~/components/Apps/ReviewDetailTabsView';

/**
 * Ladle previews for the redesigned per-submission review page, in the app's real Mantine +
 * Tailwind cascade and in BOTH colour schemes.
 *
 * 🔴 WHAT IS REAL HERE AND WHAT IS NOT, stated so a screenshot is not over-read. Every PANEL
 * below is the production component with production props — `ManifestScopes`,
 * `ManifestView`, `FileDiffEntry`, `ReportTabs`. What is reconstructed is the TAB SHELL: the
 * live one (`ReviewDetailTabsView`) derives its selection from `next/router` and three of
 * its five panels open tRPC queries, neither of which Ladle mounts. The shell here renders
 * the SAME tab values, labels and icons, imported from `reviewDetailTabs.ts`, so it cannot
 * drift from the real bar's contents — only its selection is local.
 *
 * The behavioural contract (which tab a URL selects, what each panel holds, the action bar
 * sitting outside them all) is covered in `ReviewDetailTabs.browser.test.tsx` against the
 * REAL view. These stories are for looking at it.
 */

/** A manifest with one sensitive scope and two ordinary ones, each justified. */
const MANIFEST = {
  $schema: 'https://civitai.com/schemas/app-block/v1.json',
  name: 'Gen Matrix',
  blockId: 'gen-matrix',
  version: '0.2.0',
  tagline: 'Sweep a prompt across every checkpoint at once',
  repository: 'https://github.com/example/gen-matrix',
  category: 'generation',
  contentRating: 'pg13',
  trustTier: 'unverified',
  renderMode: 'iframe',
  scopes: ['ai:write:budgeted', 'collections:write:self', 'collections:read:self'],
  scopeJustifications: {
    'ai:write:budgeted': 'Runs the generation grid the user asked for, inside the host budget.',
    'collections:write:self':
      'Saves the generated sweep into a collection so it survives a reload.',
    'collections:read:self': 'Reads the collection back to show what has already been generated.',
  },
  targets: [{ slotId: 'model.sidebar_top', priority: 10, requiredContext: ['modelId'] }],
  settings: {
    gridSize: { type: 'number', widget: 'slider', label: 'Grid size', default: 4, min: 1, max: 9 },
  },
};

const DIFF_FILE: FileLineDiff = {
  path: 'src/App.tsx',
  changeKind: 'changed',
  skipReason: null,
  added: 12,
  removed: 3,
  hunks: [
    {
      oldStart: 38,
      oldLines: 8,
      newStart: 38,
      newLines: 12,
      lines: [
        ' import { useBlock } from "@civitai/blocks-react";',
        ' ',
        ' export default function App() {',
        '   const block = useBlock();',
        '-  const [grid, setGrid] = useState(compute(block));',
        '-  const total = grid.length;',
        '+  const [grid, setGrid] = useState<GridCell[]>([]);',
        '+  const total = useMemo(() => grid.filter((c) => c.done).length, [grid]);',
        '+',
        '+  useEffect(() => {',
        '+    void block.storage.get("grid").then((saved) => setGrid(saved ?? []));',
        '+  }, [block]);',
        ' ',
        '   return <Grid cells={grid} total={total} />;',
        ' }',
      ],
    },
  ],
};

const ELIDED: FileLineDiff = {
  path: 'assets/cover.png',
  changeKind: 'changed',
  skipReason: 'binary',
  added: 0,
  removed: 0,
  hunks: [],
};

/** The live partial-failure shape: two completed analyses, one `{ error }`. */
const PARTIAL_REPORT = {
  status: 'failed',
  model: 'anthropic/claude-x',
  costUsd: 0.0612,
  startedAt: '2026-01-01T09:00:00Z',
  completedAt: '2026-01-01T09:04:00Z',
  scopeVerdicts: {
    scopes: [
      {
        declared: 'ai:write:budgeted',
        used: 'yes',
        justificationAccurate: 'yes',
        sensitive: true,
        evidence: ['src/run.ts:88'],
        notes: 'Spend is bounded by the host budget.',
      },
      {
        declared: 'collections:write:self',
        used: 'yes',
        justificationAccurate: 'weak',
        sensitive: false,
        evidence: ['src/save.ts:21'],
        notes: 'Writes on every render rather than on an explicit save.',
      },
    ],
    overBroad: [],
    underDeclared: [],
  },
  securityAudit: {
    findings: [
      {
        severity: 'medium',
        category: 'exfiltration',
        title: 'Posts the prompt to a third-party endpoint',
        file: 'src/telemetry.ts',
        line: 14,
        evidence: ['fetch("https://metrics.example/ingest")'],
        detail: 'The block sends the user prompt to an external host before rendering.',
      },
    ],
    manifestUnexpectedKeys: [],
    iframeSandboxGrants: [],
    promptInjectionAttempts: [],
  },
  codeReview: { error: 'non-json-response' },
  tokenUsage: { promptTokens: 18000, completionTokens: 2400 },
};

/** The page header: back control TOP LEFT, then the title, then the submitter line. */
function Header() {
  return (
    <Stack gap={4}>
      <Group>
        <button
          type="button"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            padding: '4px 10px',
            borderRadius: 4,
            border: '1px solid var(--mantine-color-default-border)',
            background: 'var(--mantine-color-default)',
            color: 'var(--mantine-color-text)',
          }}
        >
          <IconArrowLeft size={14} /> Review queue
        </button>
      </Group>
      <Title order={2}>
        <Group gap={6}>
          <Text fw={600}>gen-matrix</Text>
          <Code>0.2.0</Code>
          <Badge color="violet" size="sm">
            first version
          </Badge>
        </Group>
      </Title>
      <Group gap="xs" align="center">
        <Text size="sm">@dev-user</Text>
        <Text span size="xs" c="dimmed">
          ·
        </Text>
        <Text span size="xs" c="dimmed">
          3h
        </Text>
        <Text span size="xs" c="dimmed">
          · 412.0 KiB
        </Text>
      </Group>
    </Stack>
  );
}

/**
 * 🔴 1200, NOT 980 — the width the real page gives these panels, and the difference is not
 * just a smaller picture. The agent report's scope table is laid out by a PROPORTIONAL
 * `<colgroup>` (`APPS_AGENT_REPORT_SCOPE_COLUMNS`, `[7, 5, 6, 6, 22, null]` percent), so at
 * 980 the 5% "Used" column is ~49px and its "Yes" badge renders as "Y…" — which reads as a
 * rendering defect in a component that is fine. A story that misrepresents the layout is
 * worse than no story.
 */
const SHELL_WIDTH = 1200;

function Shell({ active, children }: { active: ReviewDetailTab; children: React.ReactNode }) {
  return (
    <div style={{ width: SHELL_WIDTH }}>
      <Stack gap="md">
        <Header />
        <Tabs value={active} variant="outline">
          <Tabs.List style={{ flexWrap: 'nowrap', overflowX: 'auto', overflowY: 'hidden' }}>
            {REVIEW_DETAIL_TAB_VALUES.map((tab) => {
              const Icon = TAB_ICONS[tab];
              return (
                <Tabs.Tab key={tab} value={tab} leftSection={<Icon size={14} />}>
                  {REVIEW_DETAIL_TAB_LABELS[tab]}
                </Tabs.Tab>
              );
            })}
          </Tabs.List>
          <Tabs.Panel value={active} pt="md">
            {children}
          </Tabs.Panel>
        </Tabs>
      </Stack>
    </div>
  );
}

/** PERMISSIONS — the default tab, with a sensitive scope prioritised. */
export const Permissions = () => (
  <Shell active="permissions">
    <Stack gap="sm">
      <Text size="xs" c="dimmed">
        What this version asks to be allowed to do, and the reason its developer gave. The platform
        does not verify these claims — your judgement is the gate.
      </Text>
      <ManifestScopes manifest={MANIFEST} />
    </Stack>
  </Shell>
);

/** CODE — the GitHub-shaped diff, unified. */
export const Code_Unified = () => (
  <Shell active="code">
    <Stack gap={6}>
      <Text size="sm" fw={600}>
        Files
      </Text>
      <Group gap={6}>
        <Text size="sm">14 total</Text>
        <Badge color="green" variant="light">
          +2 added
        </Badge>
        <Badge color="yellow" variant="light">
          ~3 changed
        </Badge>
      </Group>
      <FileDiffEntry file={DIFF_FILE} />
      <FileDiffEntry file={ELIDED} />
    </Stack>
  </Shell>
);

/** CODE — the same file, side by side. */
export const Code_Split = () => (
  <Shell active="code">
    <FileDiffEntry file={DIFF_FILE} defaultLayout="split" />
  </Shell>
);

/** AGENT REPORT — one analysis failed, the other two still render. */
export const Agent_PartialFailure = () => (
  <Shell active="agent">
    <Stack gap={6}>
      <Alert color="orange" variant="light">
        <Text size="xs">
          One analysis failed (Code review). The rest of this report completed and is shown below.
        </Text>
      </Alert>
      <ReportTabs
        report={PARTIAL_REPORT}
        costCapped={false}
        onRerunSection={() => undefined}
        rerunningSection={null}
      />
    </Stack>
  </Shell>
);

/**
 * AGENT REPORT — a report whose analyses NEVER RAN (the shape a targeted re-run creates).
 *
 * 🔴 THE POINT IS THE CONTRAST WITH THE STORY ABOVE: a `missing` section must read "did not
 * run", never "no findings", and the header must never claim `0 analyses failed ()`.
 */
export const Agent_NeverRan = () => (
  <Shell active="agent">
    <Stack gap={6}>
      <Alert color="orange" variant="light">
        <Text size="xs">
          2 analyses never ran (Security audit, Code review). What did complete is shown below.
        </Text>
        <Text size="xs" mt={4}>
          Provisioning failed: no k8s target
        </Text>
      </Alert>
      <ReportTabs
        report={{ ...PARTIAL_REPORT, securityAudit: null, codeReview: null }}
        costCapped={false}
        onRerunSection={() => undefined}
        rerunningSection={null}
      />
    </Stack>
  </Shell>
);

/** MANIFEST — the full structured manifest WITHOUT its permissions card. */
export const Manifest = () => (
  <Shell active="manifest">
    <Stack gap="md">
      <Stack gap={4}>
        <Text size="sm" fw={600}>
          Manifest diff
        </Text>
        <Text size="xs" c="dimmed">
          First version — full manifest below.
        </Text>
      </Stack>
      <Stack gap={4}>
        <Text size="sm" fw={600}>
          Manifest
        </Text>
        <ManifestView manifest={MANIFEST} includeScopes={false} />
      </Stack>
    </Stack>
  </Shell>
);

/**
 * PREVIEW — the store listing media at the size a moderator can actually judge.
 *
 * 🔴 BOTH SIZES SIDE BY SIDE, deliberately. The point of the change is a COMPARISON — the
 * same two components render at the table-row box in `/apps/mine` and the review queue, and
 * at the review box here — and a story showing only the new one cannot show that the small
 * one was the defect. The live gallery is not reproduced: it needs a tRPC query, and its own
 * sizing is pinned in `ReviewListingMedia.size.geometry.test.tsx`.
 */
export const Preview_Media = () => (
  <Shell active="preview">
    <Stack gap="lg">
      <Stack gap={4}>
        <Text size="sm" fw={600}>
          Store listing media — review page
        </Text>
        <Group gap="lg" align="flex-start">
          <Stack gap={4}>
            <Text size="xs" c="dimmed">
              Icon
            </Text>
            <ListingIconThumb
              size="review"
              url={SHOT}
              name="Gen Matrix"
              imgTestId="story-icon-review"
              placeholderTestId="story-icon-review-ph"
            />
          </Stack>
          <Stack gap={4}>
            <Text size="xs" c="dimmed">
              Cover
            </Text>
            <ListingCoverThumb
              size="review"
              url={SHOT}
              name="Gen Matrix"
              imgTestId="story-cover-review"
              placeholderTestId="story-cover-review-ph"
            />
          </Stack>
        </Group>
      </Stack>
      <Stack gap={4}>
        <Text size="sm" fw={600}>
          The same two components at the QUEUE-ROW size, for scale
        </Text>
        <Group gap="lg" align="flex-start">
          <ListingIconThumb
            url={SHOT}
            name="Gen Matrix"
            imgTestId="story-icon-row"
            placeholderTestId="story-icon-row-ph"
          />
          <ListingCoverThumb
            url={SHOT}
            name="Gen Matrix"
            imgTestId="story-cover-row"
            placeholderTestId="story-cover-row-ph"
          />
        </Group>
      </Stack>
    </Stack>
  </Shell>
);

/** A 16:9 placeholder so both boxes have real bytes to letterbox. */
const SHOT =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180">' +
      '<rect width="320" height="180" fill="#4c6ef5"/>' +
      '<circle cx="160" cy="90" r="56" fill="#e7f5ff"/>' +
      '<text x="160" y="98" font-size="28" text-anchor="middle" fill="#1864ab">art</text>' +
      '</svg>'
  );
