import {
  AUTOBLOCKS_API_BASE_URL,
  AUTOBLOCKS_V2_API_BASE_URL,
} from './constants';
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
  });
}

export async function postV2<T>(args: {
  apiEndpoint?: string;
  path: string;
  apiKey: string;
  body?: unknown;
}): Promise<T> {
  return await requestSemaphore.run(async () => {
    const resp = await axios.post<T>(
      `${args.apiEndpoint || AUTOBLOCKS_V2_API_BASE_URL}${args.path}`,
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
  });
}
