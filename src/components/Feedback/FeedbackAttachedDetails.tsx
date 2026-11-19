import { Collapse, Text, UnstyledButton } from '@mantine/core';
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { useState } from 'react';
import type { AttachedDiagnostics } from '~/components/Feedback/attachedDiagnostics';
import { readAttachedDiagnostics } from '~/components/Feedback/attachedDiagnostics';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-dimmed">{label}</dt>
      <dd className="m-0 min-w-0 break-words font-mono">{children}</dd>
    </>
  );
}

function List({ items }: { items: string[] }) {
  return (
    <ul className="m-0 max-h-40 list-none overflow-auto p-0">
      {items.map((item, index) => (
        <li key={index} className="break-words">
          {item}
        </li>
      ))}
    </ul>
  );
}

/**
 * "Details we attach": what a report carries besides the reporter's words, shown before Send.
 * Rendered from `readAttachedDiagnostics()`, the function the submit calls, so it cannot describe
 * a different object from the one that is sent. Re-read each time it is opened.
 */
export function FeedbackAttachedDetails({ path }: { path?: string }) {
  const [details, setDetails] = useState<AttachedDiagnostics | null>(null);
  const opened = !!details;

  const toggle = () => setDetails(opened ? null : readAttachedDiagnostics());
  const Chevron = opened ? IconChevronDown : IconChevronRight;

  return (
    <div>
      <UnstyledButton
        onClick={toggle}
        aria-expanded={opened}
        className="flex items-center gap-1 text-sm text-dimmed"
      >
        <Chevron size={14} />
        Details we attach
      </UnstyledButton>
      <Collapse in={opened}>
        {details && (
          <div className="mt-2 flex flex-col gap-2 text-xs">
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              {path && <Row label="Page">{path}</Row>}
              {details.route && <Row label="Route">{details.route}</Row>}
              {details.build && <Row label="App version">{details.build}</Row>}
              {details.device && (
                <>
                  <Row label="Window">
                    {details.device.viewport.width}×{details.device.viewport.height} at{' '}
                    {details.device.pixelRatio}x, screen {details.device.screen.width}×
                    {details.device.screen.height}
                    {details.device.touch ? ', touch' : ''}
                  </Row>
                  <Row label="Browser settings">
                    {[
                      details.device.colorScheme,
                      details.device.language,
                      details.device.timeZone,
                      details.device.online === false ? 'offline' : undefined,
                    ]
                      .filter(Boolean)
                      .join(', ')}
                  </Row>
                </>
              )}
              {details.sessionId && <Row label="Session">{details.sessionId}</Row>}
              <Row label="Console errors">
                {details.consoleErrors ? (
                  <List
                    items={details.consoleErrors.map(
                      (entry) => `${entry.count > 1 ? `×${entry.count} ` : ''}${entry.message}`
                    )}
                  />
                ) : (
                  'none'
                )}
              </Row>
              <Row label="Failed requests">
                {details.networkErrors || details.trpcErrors ? (
                  <List
                    items={[
                      ...(details.networkErrors ?? []).map(
                        (entry) => `${entry.status} ${entry.url}`
                      ),
                      ...(details.trpcErrors ?? []).map(
                        (entry) =>
                          `${entry.httpStatus ? `${entry.httpStatus} ` : ''}${entry.path} ${
                            entry.code
                          }`
                      ),
                    ]}
                  />
                ) : (
                  'none'
                )}
              </Row>
            </dl>
            <Text size="xs" c="dimmed">
              Our server also records your browser and device type, your membership tier, which
              Civitai site you are on, and a few site settings. We never attach passwords, cookies,
              or the contents of requests.
            </Text>
          </div>
        )}
      </Collapse>
    </div>
  );
}
