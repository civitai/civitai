import { Button } from '@mantine/core';
import { describe, expect, test } from 'vitest';
import phoneControls from '~/components/generation_v2/PhoneControls.module.scss';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { PHONE_VIEWPORT, renderAtViewport } from '../../../test/geometry-setup';
import classes from './MobileGenerator.module.scss';

describe('MobileGenerator Create button', () => {
  // A copy of the button as MobileGenerator draws it, inside the phone controls: what it pins is
  // that the phone-wide square-off skips it.
  test('stays a full pill inside the phone controls, which square off other buttons', async () => {
    await renderAtViewport(
      <div className={phoneControls.root}>
        <div className={classes.root}>
          <Button data-pill className={classes.create} h={56}>
            Create
          </Button>
        </div>
      </div>,
      PHONE_VIEWPORT
    );
    const create = document.querySelector('button')!;
    expect(getComputedStyle(create).borderRadius).toBe('28px');
  });
});
