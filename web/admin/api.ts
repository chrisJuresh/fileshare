// Same-origin JSON client for /api/admin. Cloudflare Access adds the JWT at the edge (cookie →
// Cf-Access-Jwt-Assertion); the app also requires Origin + JSON on mutating requests.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

let onAuthProblem: (() => void) | undefined;
export function setAuthProblemHandler(fn: () => void): void {
  onAuthProblem = fn;
}

const FRIENDLY: Record<string, string> = {
  forbidden: 'Access denied. Your Cloudflare Access session may have expired; reload the page.',
  not_found: 'Not found (it may have been deleted).',
  internal: 'Something went wrong on the server. Check the logs.',
};

export async function api<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: { accept: 'application/json' } };
  if (method !== 'GET') {
    init.headers = { accept: 'application/json', 'content-type': 'application/json' };
    init.body = JSON.stringify(body ?? {});
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    // A cross-origin redirect to the Access login page surfaces as a network error.
    onAuthProblem?.();
    throw new ApiError(0, 'network', 'Could not reach the server. Your Access session may have expired; reload the page.');
  }
  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; message?: string };
    const code = d.error ?? `http_${res.status}`;
    if (res.status === 403) onAuthProblem?.();
    throw new ApiError(res.status, code, d.message ?? FRIENDLY[code] ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
