import { orchestratorFetch } from '../utils';

const baseUrl = '/v1/consumer/jobs';

export class Jobs {
  static getById(jobId: number) {
    orchestratorFetch(`${baseUrl}/${jobId}`, { method: 'GET' });
  }
  static post(props: { body?: any; params?: object }) {
    orchestratorFetch(baseUrl, { method: 'POST', ...props });
  }
  static deleteById(jobId: number) {
    orchestratorFetch(`${baseUrl}/${jobId}`, { method: 'DELETE' });
  }
}
