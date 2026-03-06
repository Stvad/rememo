export class RoamApiError extends Error {
  status: number;

  details: unknown;

  retryAfterMs?: number;

  constructor(message: string, status: number, details?: unknown, retryAfterMs?: number) {
    super(message);
    this.name = 'RoamApiError';
    this.status = status;
    this.details = details;
    this.retryAfterMs = retryAfterMs;
  }
}

type QueryPayload = {
  query: string;
  args?: unknown[];
};

export class RoamApiClient {
  private static readonly MAX_RETRIES = 4;

  private graph: string;

  private token: string;

  private peerOriginPromise: Promise<string> | null = null;

  constructor(graph: string, token: string) {
    this.graph = graph;
    this.token = token;
  }

  async getPeerOrigin() {
    if (!this.peerOriginPromise) {
      this.peerOriginPromise = this.resolvePeerOrigin();
    }

    return this.peerOriginPromise;
  }

  async query<T>(query: string, args: unknown[] = []) {
    return this.request<T>('q', { query, args });
  }

  async write<T = unknown>(payload: Record<string, unknown>) {
    return this.request<T>('write', payload);
  }

  private async resolvePeerOrigin() {
    const response = await fetch(`https://api.roamresearch.com/api/graph/${this.graph}/q`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: '[:find ?title :where [?e :node/title ?title] :limit 1]',
        args: [],
      } satisfies QueryPayload),
    });

    if (!response.url) {
      throw new Error('Unable to resolve the Roam graph peer host.');
    }

    return new URL(response.url).origin;
  }

  private async request<T>(
    path: 'q' | 'write',
    payload: Record<string, unknown>,
    attempt = 0
  ): Promise<T> {
    const peerOrigin = await this.getPeerOrigin();
    const response = await fetch(`${peerOrigin}/api/graph/${this.graph}/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    const retryAfterMs = this.getRetryAfterMs(response, attempt);

    if (!response.ok) {
      if (response.status === 429 && attempt < RoamApiClient.MAX_RETRIES) {
        await this.sleep(retryAfterMs);
        return this.request<T>(path, payload, attempt + 1);
      }

      throw new RoamApiError(
        data?.message || `Roam API request failed (${response.status})`,
        response.status,
        data,
        retryAfterMs
      );
    }

    return (data?.result ?? data) as T;
  }

  private getRetryAfterMs(response: Response, attempt: number) {
    const retryAfterHeader = response.headers.get('retry-after');
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;

    if (!Number.isNaN(retryAfterSeconds) && retryAfterSeconds > 0) {
      return retryAfterSeconds * 1000;
    }

    return Math.min(1500 * 2 ** attempt, 15000);
  }

  private sleep(ms: number) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }
}
