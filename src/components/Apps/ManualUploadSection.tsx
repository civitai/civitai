import { Button, Card, Collapse, Divider, Group, Stack } from '@mantine/core';
import { IconChevronDown, IconChevronUp, IconFileZip } from '@tabler/icons-react';
import { useState } from 'react';

/**
 * Secondary, de-emphasized "or upload manually" section for /apps/submit.
 *
 * The CLI is the PRIMARY recommended path (see CliSubmitCta); the manual ZIP
 * upload is demoted behind a subtle toggle so it doesn't compete with the
 * recommendation — but it stays fully functional. The actual upload form
 * (FileInput, manifest preview, submit button — all page-stateful) is passed as
 * `children`, so the page keeps its logic and this component only owns the
 * collapse/visual-demotion chrome.
 *
 * `defaultOpen` lets the page keep the section open when a bundle is already
 * selected, so the user doesn't lose context mid-flow.
 */
export function ManualUploadSection({
  children,
  defaultOpen = false,
}: {
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <>
      <Divider label="or upload manually" labelPosition="center" my="xs" />
      <Group justify="center">
        <Button
          variant="subtle"
          color="gray"
          size="sm"
          leftSection={<IconFileZip size={16} />}
          rightSection={open ? <IconChevronUp size={16} /> : <IconChevronDown size={16} />}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? 'Hide manual ZIP upload' : 'Upload a ZIP manually'}
        </Button>
      </Group>

      <Collapse in={open}>
        <Card withBorder p="lg">
          <Stack gap="md">{children}</Stack>
        </Card>
      </Collapse>
    </>
  );
}
