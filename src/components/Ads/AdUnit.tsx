import { adUnitFactory } from '~/components/Ads/AdUnitFactory';

export const AdUnitIncontent_1 = adUnitFactory({
  adUnit: 'incontent_1',
  sizes: [
    [320, 100],
    [320, 50],
    [300, 250],
    [300, 100],
    [300, 50],
    // [336, 280],
  ],
});

/** max dimensions: 300x600 */
export const AdUnitSide_1 = adUnitFactory({
  adUnit: 'side_1',
  lutSizes: [
    // [
    //   [1050, 1199],
    //   [
    //     [120, 600],
    //     [160, 600],
    //   ],
    // ],
    [
      [1200],
      [
        [120, 600],
        [160, 600],
        [300, 600],
        [300, 250],
        [336, 280],
      ],
    ],
  ],
});

/** max dimensions: 336x280  */
export const AdUnitSide_2 = adUnitFactory({
  adUnit: 'side_2',
  lutSizes: [
    [
      [1200],
      [
        [200, 200],
        [250, 250],
        [300, 250],
        [336, 280],
      ],
    ],
  ],
});

/** max dimensions: 336x280  */
export const AdUnitSide_3 = adUnitFactory({
  adUnit: 'side_3',
  sizes: [
    [200, 200],
    [250, 250],
    [300, 250],
    [336, 280],
  ],
});

export const AdUnitTop = adUnitFactory({
  adUnit: 'top',
  lutSizes: [
    [
      [0, 759],
      [
        [320, 100],
        [320, 50],
        [300, 250],
        [300, 100],
        [300, 50],
        [336, 280],
      ],
    ],
    [
      [760, 1023],
      [
        [468, 60],
        [728, 90],
      ],
    ],
    [
      [1024],
      [
        [728, 90],
        [970, 90],
        [970, 250],
        [980, 90],
      ],
    ],
  ],
});

export const AdUnitAdhesive = adUnitFactory({
  adUnit: 'adhesive',
  lutSizes: [
    [
      [0, 759],
      [
        [1, 1],
        // [320, 100],
        [320, 50],
        // [300, 100],
        [300, 50],
      ],
    ],
    [
      [760, 1023],
      [
        [8, 1],
        [728, 90],
      ],
    ],
    [
      [1024],
      [
        [8, 1],
        [728, 90],
        [970, 90],
        [980, 90],
        [970, 250],
      ],
    ],
  ],
});
