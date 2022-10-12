import { useRouter } from 'next/router';

const ModelDetail = () => {
  const router = useRouter();
  const { modelId } = router.query;

  return <h1>{modelId}</h1>;
};

export default ModelDetail;
