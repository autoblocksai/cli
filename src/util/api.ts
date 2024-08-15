import { AUTOBLOCKS_API_BASE_URL } from './constants';
import axios from 'axios';
import axiosRetry from 'axios-retry';
import { Semaphore } from './semaphore';

// Limit to 10 concurrent requests
const requestSemaphore = new Semaphore(10);

axiosRetry(axios, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
});

export async function post<T>(args: {
  path: string;
  apiKey: string;
  body?: unknown;
}): Promise<T> {
  return await requestSemaphore.run(async () => {
    try {
      const resp = await axios.post<T>(
        `${AUTOBLOCKS_API_BASE_URL}${args.path}`,
        args.body,
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${args.apiKey}`,
          },
          timeout: 30_000,
        },
      );
      return resp.data;
    } catch (err) {
      if (axios.isAxiosError(err)) {
        throw new Error(`Failed to POST ${args.path}: ${err.toJSON()}`);
      }
      throw err;
    }
  });
}
