import { Container } from '@mantine/core';

export default function DMCANotice() {
  return (
    <Container size="md">
      <iframe
        className="clickup-embed clickup-dynamic-height"
        src="https://forms.clickup.com/8459928/f/825mr-5904/HX69YZMDH2N3JJA1R4"
        width="100%"
        height="100%"
        style={{ background: 'transparent' }}
      ></iframe>
      <script async src="https://app-cdn.clickup.com/assets/js/forms-embed/v1.js"></script>
    </Container>
  );
}
