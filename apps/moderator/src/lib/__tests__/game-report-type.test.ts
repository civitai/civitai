import { describe, expect, it } from 'vitest';

import {
  gameFrameReportImage,
  getReportItemUrl,
  reportEntityForSlug,
  reportEntityLabels,
  reportPath,
} from '../reports';
import { OWNED_REPORT_ENTITIES, reportEntity } from '../server/report-entities';

describe('game report type', () => {
  it('is reachable by its queue slug', () => {
    expect(reportEntityForSlug('game')).toBe('gameFrameGame');
    expect(reportPath('gameFrameGame')).toBe('/reports/game');
    expect(reportEntityLabels.gameFrameGame).toBe('Game');
  });

  it("links to the game's own absolute URL rather than a civitai path", () => {
    const url = 'https://games.civitai.com/?game=kraken-cove';
    expect(getReportItemUrl('https://civitai.red', 'gameFrameGame', 42, url)).toBe(url);
  });

  it('renders no link for a mirror url that is not https', () => {
    expect(
      getReportItemUrl('https://civitai.red', 'gameFrameGame', 42, 'javascript:alert(1)')
    ).toBeNull();
    expect(getReportItemUrl('https://civitai.red', 'gameFrameGame', 42, null)).toBeNull();
  });

  it("shows the reported player picture from the report's details", () => {
    const url = 'https://games.civitai.com/api/reports/media/0123456789abcdef0123456789abcdef.png';
    expect(gameFrameReportImage({ subject: 'image:x', image: { url, key: 'x' } })).toBe(url);
  });

  it('shows no picture for a game report, or one whose url is not https', () => {
    expect(gameFrameReportImage({ subject: 'game', comment: '' })).toBeNull();
    expect(gameFrameReportImage(null)).toBeNull();
    expect(gameFrameReportImage({ image: { url: 'javascript:alert(1)' } })).toBeNull();
    expect(gameFrameReportImage({ image: { url: 'http://games.civitai.com/x.png' } })).toBeNull();
    expect(gameFrameReportImage({ image: 'https://games.civitai.com/x.png' })).toBeNull();
  });

  it('joins through GameFrameGameReport and is owned by the author', () => {
    expect(reportEntity('gameFrameGame')).toMatchObject({
      reportTable: 'GameFrameGameReport',
      fk: 'gameFrameGameId',
      table: 'GameFrameGame',
      ownerColumn: 'userId',
    });
    expect(OWNED_REPORT_ENTITIES.map((e) => e.type)).toContain('gameFrameGame');
  });
});
