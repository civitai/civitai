import { EventQueue } from '~/server/event-queue/event-queue';
import { deleteImageByIdPostProcess } from '~/server/services/image.service';

const instance = new EventQueue('Image', {
  test: function (data: { name: string }) {
    console.log({ data, test: false });
  },
  delete: deleteImageByIdPostProcess,
});

export const ImageQueue = instance.queue();
export const ImageWorker = instance.worker();
