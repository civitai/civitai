import { Alert, Button } from '@mantine/core';
import { describe, expect, test } from 'vitest';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { box, PHONE_VIEWPORT, renderAtViewport } from '../../../test/geometry-setup';
import classes from './FooterStrips.module.scss';

/**
 * The footer as GenerationLayout and FormFooter nest it: the layout's own stack (a claim button),
 * then the form's, which arrives through the footer slot one wrapper deeper. The form's stack holds
 * a plain item (the queue) over an alert.
 */
function Footer() {
  return (
    <div className={`${classes.frame} flex flex-col gap-2 p-2`}>
      <div className={classes.strips} data-strips>
        <div className="flex flex-col">
          <Button data-testid="claim">Claim</Button>
        </div>
      </div>
      <div>
        <div data-slot="footer" className="flex flex-col gap-2">
          <div className={classes.strips} data-strips>
            <div data-testid="queue">
              <div style={{ height: 24 }}>Queue</div>
            </div>
            <Alert data-testid="alert" p="xs">
              A resource needs to be loaded first
            </Alert>
          </div>
        </div>
      </div>
    </div>
  );
}

const byTestId = (id: string) => document.querySelector(`[data-testid="${id}"]`)!;

describe('FooterStrips spacing', () => {
  test('the queue sits as far from the claim button above it as from the alert below it', async () => {
    await renderAtViewport(<Footer />, PHONE_VIEWPORT);
    const claim = box(byTestId('claim'));
    const queue = box(byTestId('queue').firstElementChild!);
    const alert = box(byTestId('alert'));

    expect(queue.top - claim.bottom).toBe(8);
    expect(alert.top - queue.bottom).toBe(8);
  });

  test('a folded one-line alert has no fixed minimum height', async () => {
    await renderAtViewport(<Footer />, PHONE_VIEWPORT);
    expect(box(byTestId('alert')).height).toBeLessThan(40);
  });
});
