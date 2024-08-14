import { AUTOBLOCKS_API_BASE_URL } from './constants';

type HttpError = {
  status: number;
  data: unknown;
};

export async function post<T>(args: {
  path: string;
  apiKey: string;
  body?: unknown;
}): Promise<T> {
  const resp = await fetch(`${AUTOBLOCKS_API_BASE_URL}${args.path}`, {
    method: 'POST',
    body: args.body ? JSON.stringify(args.body) : undefined,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${args.apiKey}`,
    },
  });

  let data;
  try {
    data = await resp.json();
  } catch {
    const text = await resp.text();
    const err: HttpError = {
      status: resp.status,
      data: text,
    };
    throw new Error(JSON.stringify(err));
  }

  if (!resp.ok) {
    const err: HttpError = {
      status: resp.status,
      data,
    };
    throw new Error(JSON.stringify(err));
  }
  return data;
}
