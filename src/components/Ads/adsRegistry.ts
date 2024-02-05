import { AscendeumAdUnit, AscendeumAdUnitType, ExoclickAdUnit } from '~/components/Ads/ads.utils';

function config<TAscendeum extends AscendeumAdUnitType>(props: {
  sfw: AscendeumAdUnit<TAscendeum>;
  nsfw?: ExoclickAdUnit;
}) {
  return props;
}

const breakpoints = {
  xs: 576,
  sm: 768,
  md: 992,
  lg: 1200,
  xl: 1400,
};

export const adsRegistry = {
  masonryColumns: config({
    sfw: { type: 'ascendeum', adunit: 'Dynamic_InContent', breakpoints: [{ sizes: ['300x250'] }] },
    nsfw: { type: 'exoclick', breakpoints: [{ sizes: '300x250' }] },
  }),
  masonryGrid: config({
    sfw: { type: 'ascendeum', adunit: 'Dynamic_InContent', breakpoints: [{ sizes: ['300x250'] }] },
    nsfw: { type: 'exoclick', breakpoints: [{ sizes: '300x250' }] },
  }),
  feedLayoutHeader: config({
    sfw: {
      type: 'ascendeum',
      adunit: 'Leaderboard_A',
      breakpoints: [
        { sizes: ['300x100'] },
        { minWidth: breakpoints.md, sizes: ['728x90'] },
        { minWidth: breakpoints.lg, sizes: ['728x90', '970x90'] },
      ],
    },
    nsfw: {
      type: 'exoclick',
      breakpoints: [{ sizes: '300x250' }, { minWidth: breakpoints.md, sizes: '728x90' }],
    },
  }),
  homePageHeader: config({
    sfw: {
      type: 'ascendeum',
      adunit: 'Leaderboard_A',
      breakpoints: [
        { sizes: ['300x100'] },
        { minWidth: breakpoints.md, sizes: ['728x90'] },
        { minWidth: breakpoints.lg, sizes: ['728x90', '970x90'] },
      ],
    },
    nsfw: {
      type: 'exoclick',
      breakpoints: [{ sizes: '300x100' }, { minWidth: breakpoints.md, sizes: '728x90' }],
    },
  }),
  homePageSectionDivider: config({
    sfw: {
      type: 'ascendeum',
      adunit: 'Leaderboard_A',
      breakpoints: [
        { sizes: ['300x100'] },
        { minWidth: breakpoints.md, sizes: ['728x90'] },
        { minWidth: breakpoints.lg, sizes: ['728x90', '970x90'] },
      ],
    },
    nsfw: {
      type: 'exoclick',
      breakpoints: [{ sizes: '300x100' }, { minWidth: breakpoints.md, sizes: '728x90' }],
    },
  }),
  modelDetailFeedHeader: config({
    sfw: {
      type: 'ascendeum',
      adunit: 'Leaderboard_A',
      breakpoints: [
        { sizes: ['300x100'] },
        { minWidth: breakpoints.md, sizes: ['728x90'] },
        { minWidth: breakpoints.lg, sizes: ['728x90', '970x90'] },
      ],
    },
    nsfw: {
      type: 'exoclick',
      breakpoints: [{ sizes: '300x100' }, { minWidth: breakpoints.md, sizes: '728x90' }],
    },
  }),
  imageDetail: config({
    sfw: { type: 'ascendeum', adunit: 'Sidebar_A', breakpoints: [{ sizes: ['300x250'] }] },
    nsfw: { type: 'exoclick', breakpoints: [{ sizes: '300x250' }] },
  }),
  modelVersionDetail: config({
    sfw: { type: 'ascendeum', adunit: 'Sidebar_A', breakpoints: [{ sizes: ['300x250'] }] },
    nsfw: { type: 'exoclick', breakpoints: [{ sizes: '300x250' }] },
  }),
  modelDetailSectionDivider: config({
    sfw: {
      type: 'ascendeum',
      adunit: 'Leaderboard_B',
      breakpoints: [
        { sizes: ['300x100'] },
        { minWidth: breakpoints.md, sizes: ['728x90'] },
        { minWidth: breakpoints.lg, sizes: ['728x90', '970x90'] },
      ],
    },
    nsfw: {
      type: 'exoclick',
      breakpoints: [{ sizes: '300x100' }, { minWidth: breakpoints.md, sizes: '728x90' }],
    },
  }),
  postDetailSidebar: config({
    sfw: {
      type: 'ascendeum',
      adunit: 'StickySidebar_A',
      breakpoints: [{ minWidth: breakpoints.md, sizes: ['300x600'] }],
    },
    nsfw: { type: 'exoclick', breakpoints: [{ minWidth: breakpoints.md, sizes: '300x500' }] },
  }),
  postDetailFooter: config({
    sfw: {
      type: 'ascendeum',
      adunit: 'Leaderboard_A',
      breakpoints: [
        { sizes: ['300x250'] },
        { minWidth: breakpoints.md, sizes: ['728x90'] },
        { minWidth: breakpoints.lg, sizes: ['970x250'] },
      ],
    },
    nsfw: {
      type: 'exoclick',
      breakpoints: [{ sizes: '300x250' }, { minWidth: breakpoints.md, sizes: '728x90' }],
    },
  }),
};
