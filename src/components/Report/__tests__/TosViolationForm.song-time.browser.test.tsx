import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { ReportTargetProvider } from '~/components/Report/report-target.context';
import { TosViolationForm } from '~/components/Report/TosViolationForm';
import { useMusicPlayerStore, useMusicPlayheadStore } from '~/store/music-player.store';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

// Music T10 S3 (odd/tasks/music-section-t10.md): a song report carries a time, prefilled from the player.

const SONG = 42;
const MINOR = 'Photorealistic depiction of a minor';
const track = (id: number) => ({
  id,
  url: 'song.mp3',
  title: 'Song',
  durationSec: 180,
  creator: { id: 1, username: 'creator' },
});

const onSubmit = vi.fn();
const renderForm = (song?: { durationSec: number | null }) =>
  renderWithProviders(
    <ReportTargetProvider value={{ entityType: 'image', entityId: SONG, song }}>
      <TosViolationForm onSubmit={onSubmit} setUploading={vi.fn()}>
        <button type="submit">Submit</button>
      </TosViolationForm>
    </ReportTargetProvider>
  );
const timeField = () => page.getByRole('textbox', { name: /time in the song/i });
const submitWith = async (time: string) => {
  await userEvent.clear(timeField());
  await userEvent.type(timeField(), time);
  await userEvent.click(page.getByText('Graphic violence'));
  await userEvent.click(page.getByRole('button', { name: 'Submit' }));
};

beforeEach(() => {
  vi.clearAllMocks();
  useMusicPlayerStore.setState({ current: null });
  useMusicPlayheadStore.setState({ currentTime: 0, duration: 0 });
});

describe('the report form on a song', () => {
  test('prefills the time from the player and submits the edited time in seconds', async () => {
    useMusicPlayerStore.setState({ current: track(SONG) });
    useMusicPlayheadStore.setState({ currentTime: 75.6, duration: 180 });
    renderForm({ durationSec: 180 });

    await expect.element(timeField()).toHaveValue('1:15');
    await submitWith('2:05');

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      violation: 'Graphic violence',
      timestampSec: 125,
    });
  });

  test('starts at 0:00 when another song is playing', async () => {
    useMusicPlayerStore.setState({ current: track(SONG + 1) });
    useMusicPlayheadStore.setState({ currentTime: 75.6, duration: 180 });
    renderForm({ durationSec: 180 });

    await expect.element(timeField()).toHaveValue('0:00');
  });

  test('refuses a time past the end of the song', async () => {
    renderForm({ durationSec: 180 });
    await submitWith('3:01');

    await expect.element(page.getByText('That time is past the end of the song.')).toBeVisible();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('does not offer a photorealistic depiction of a minor', async () => {
    renderForm({ durationSec: 180 });

    await expect.element(page.getByText('Graphic violence')).toBeVisible();
    expect(page.getByText(MINOR).elements()).toHaveLength(0);
  });
});

describe('the report form on an image', () => {
  test('asks for no time and still offers every violation', async () => {
    renderForm();

    await expect.element(page.getByText(MINOR)).toBeVisible();
    expect(timeField().elements()).toHaveLength(0);
  });
});
