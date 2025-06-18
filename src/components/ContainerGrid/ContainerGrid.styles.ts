// import {
//   createStyles,
//   MantineSpacing,
//   MantineTheme,
//   MANTINE_SIZES,
//   MantineSize,
// } from '@mantine/styles';
// import React from 'react';
// import { containerQuery } from '~/utils/mantine-css-helpers';

// export interface GridStylesParams {
//   gutter: MantineSpacing;
//   gutterXs: MantineSpacing;
//   gutterSm: MantineSpacing;
//   gutterMd: MantineSpacing;
//   gutterLg: MantineSpacing;
//   gutterXl: MantineSpacing;
//   justify?: React.CSSProperties['justifyContent'];
//   align?: React.CSSProperties['alignContent'];
//   containerName?: string;
// }

// function getGutterStyles(
//   gutters: Record<MantineSize, MantineSpacing>,
//   theme: MantineTheme,
//   containerName?: string
// ) {
//   return MANTINE_SIZES.reduce<Record<string, React.CSSProperties>>((acc, size) => {
//     if (typeof gutters[size] !== 'undefined') {
//       acc[containerQuery.largerThan(size, containerName)] = {
//         margin: -theme.fn.size({ size: gutters[size], sizes: theme.spacing }) / 2,
//       };
//     }

//     return acc;
//   }, {});
// }

// export default createStyles(
//   (
//     theme,
//     {
//       justify,
//       align,
//       gutter,
//       gutterXs,
//       gutterSm,
//       gutterMd,
//       gutterLg,
//       gutterXl,
//       containerName,
//     }: GridStylesParams
//   ) => ({
//     root: {
//       margin: -theme.fn.size({ size: gutter, sizes: theme.spacing }) / 2,
//       display: 'flex',
//       flexWrap: 'wrap',
//       justifyContent: justify,
//       alignItems: align,
//       ...getGutterStyles(
//         { xs: gutterXs, sm: gutterSm, md: gutterMd, lg: gutterLg, xl: gutterXl },
//         theme,
//         containerName
//       ),
//     },
//   })
// );
