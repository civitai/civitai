import { useGetGenerationRequests } from '~/components/ImageGeneration/utils/generationRequestHooks';

export function QueueSnackbar() {
  // const { requests } = useGetGenerationRequests();
  // const inQueue = requests.filter(x => x.status)

  return (
    <div className="flex items-center">
      <div className="flex-1"></div>
      <div></div>
      <div className="flex-1"></div>
    </div>
  );
}
