import { Container, Paper, Stack, useMantineTheme } from '@mantine/core';

export default function Test() {
  const theme = useMantineTheme();
  return <></>;
  // return (
  //   <Container p="md">
  //     <Stack>
  //       {allAdSizes.map((size, i) => (
  //         <AdPlaceholder key={i} size={size} />
  //       ))}
  //     </Stack>
  //   </Container>
  // );
}

// function AdPlaceholder({ size }: { size: string }) {
//   const _size = adSizeImageMap[size as AnyAdSize];
//   if (!_size) return null;
//   const [width, height] = size.split('x').map(Number);
//   const [imageWidth, imageHeight] = _size.split('x').map(Number);
//   return (
//     <Paper
//       w={width}
//       h={height}
//       withBorder
//       style={{ backgroundImage: `url(/images/become-a-member/${imageWidth}x${imageHeight}.jpg)` }}
//       sx={{
//         backgroundRepeat: 'no-repeat',
//         backgroundPosition: 'center',
//       }}
//     ></Paper>
//   );
// }
