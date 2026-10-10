import { Button, Collapse, Divider, Group, Stack, Text, Title } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconArrowRight, IconChevronDown, IconTerminal2 } from '@tabler/icons-react';
import { AgentOnboardingCard } from '~/components/Apps/AgentOnboardingCard';
import { GetStartedBody } from '~/components/Apps/GetStartedBody';
import { ManualSetupCollapse, ManualSetupSteps } from '~/components/Apps/ManualSetupCollapse';

/**
 * Ladle previews for `AgentOnboardingCard` in each of `/apps/build`'s three placements.
 *
 * KEPT RATHER THAN DELETED AFTER THE REVIEW SHOOT, which is the opposite of the
 * `component-preview` skill's default ("stories for one-off reviews can be deleted after;
 * stories for reusable components can stay"). The card is animated, so its tests can pin
 * behaviour but not whether it LOOKS right, and every future change to the ring, the caret
 * or the entrance needs the same frames re-shot in both themes. Committed stories are
 * the existing convention here rather than a new one — no count is given, because the two
 * hand-maintained counts this family already shipped were both wrong; `find src -name
 * '*.stories.tsx'` is the answer.
 *
 * 🔴 WHAT READS THIS FILE, SINCE "`@ladle/react` IS A devDependency WITH NO npm SCRIPT" HAS
 * BEEN MISREAD AS "NOTHING". The reader is `npx ladle serve`, driven by the committed
 * `.claude/skills/component-preview/SKILL.md` against `.ladle/config.mjs`
 * (`stories: 'src/**'+'/*.stories.tsx'`), and `docs/previews/apps-review-detail/capture.mjs`
 * is the worked precedent for turning a story set into committed, floor-checked PNGs. A
 * script in `package.json` would be a convenience, not the difference between read and dead.
 *
 * It also earned its keep once already: the dark and light captures are what caught the copy
 * control sitting on top of the prompt's first line — a Tailwind `p-3` shorthand resetting
 * the right padding `AgentOnboardingCard.module.scss` sets to clear it. No assertion in the
 * three suites could see that AT THE TIME; one can now —
 * `src/components/CopyAffordance/CopyAffordance.geometry.test.tsx` measures the control
 * against this panel's text box, so that specific defect no longer depends on somebody
 * looking at a screenshot. The frames are still the only check on whether it looks GOOD.
 *
 * State A mounts the real `GetStartedBody`, which is props-only. The contexts for B and C are
 * reproduced here rather than mounting `AppsBuildBody`, which would need the tRPC and session
 * providers the Ladle global provider does not supply.
 */

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div style={{ width: 720 }}>{children}</div>
);

/** A · pitch — the real body: hero, the prominent card, banner, pitch, closed manual setup. */
export const Pitch = () => (
  <Frame>
    <GetStartedBody />
  </Frame>
);

/** B · first-app — the prominent card leads, the manual setup is closed below it. */
export const FirstApp = () => (
  <Frame>
    <Stack gap="lg">
      <Stack gap="xs">
        <Title order={2}>Ship your first app</Title>
        <Text size="sm" c="dimmed">
          Build on Civitai&apos;s web + AI infrastructure: a catalog of hundreds of thousands of
          models, generation paid in Buzz, hosting and identity handled. The fastest way in is to
          hand the prompt below to your coding agent.
        </Text>
      </Stack>
      <AgentOnboardingCard tone="prominent" />
      <ManualSetupCollapse />
      <Group>
        <Button variant="default" rightSection={<IconArrowRight size={16} />}>
          Create your first app
        </Button>
      </Group>
    </Stack>
  </Frame>
);

/** C · workbench — inside the "Developer resources" collapse, opened, and static. */
export const WorkbenchStripOpen = () => {
  const [opened, { toggle }] = useDisclosure(true);
  return (
    <Frame>
      <Stack gap="xs">
        <Divider />
        <Button
          variant="subtle"
          size="xs"
          onClick={toggle}
          aria-expanded={opened}
          w="fit-content"
          leftSection={<IconTerminal2 size={16} />}
          rightSection={<IconChevronDown size={16} />}
        >
          {opened ? 'Hide developer resources' : 'Developer resources'}
        </Button>
        <Collapse in={opened}>
          <Stack gap="sm">
            <AgentOnboardingCard tone="inline" animated={false} />
            <ManualSetupSteps />
          </Stack>
        </Collapse>
      </Stack>
    </Frame>
  );
};

/**
 * The reduced-motion / static render of the PROMINENT card.
 *
 * `animated={false}` reaches the same code path `prefers-reduced-motion: reduce` does — the
 * component has one static branch, taken by either trigger — so this is what a viewer who has
 * opted out of motion sees, without needing the screenshot run to set the media feature.
 */
export const PitchProminentStatic = () => (
  <Frame>
    <AgentOnboardingCard tone="prominent" animated={false} />
  </Frame>
);
