import { Meta } from '~/components/Meta/Meta';
import { PlaygroundPage } from '~/components/Challenge/Playground/PlaygroundPage';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export default function JudgePlaygroundPage() {
  return (
    <>
      <Meta title="Judge Playground" deIndex />
      <PlaygroundPage />
    </>
  );
}

export const getServerSideProps = createServerSideProps({ requireModerator: true });
