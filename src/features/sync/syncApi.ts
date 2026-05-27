import type {
  AnnotationKind,
  AnnotationPayload,
  CloudRaceMetadata,
  SyncSession,
} from '../../types';

export const SYNC_PUSH_BATCH_SIZE = 50;

export interface SyncRaceCursorRequest {
  raceKey: string;
  since: number;
}

export interface SyncPushMutation {
  clientRequestId: string;
  raceKey: string;
  kind: AnnotationKind;
  action: 'upsert' | 'delete';
  annotationId: string;
  payload: AnnotationPayload;
}

export interface SyncAcceptedMutation {
  clientRequestId: string;
  serverSequence: number;
}

export interface SyncPulledMutation {
  serverSequence: number;
  submittedAt: string;
  submittedBy: string;
  raceKey: string;
  kind: AnnotationKind;
  action: 'upsert' | 'delete';
  annotationId: string;
  payload: AnnotationPayload;
}

export interface SyncPullResponse {
  currentSequence: number;
  mutations: SyncPulledMutation[];
}

export interface SyncPushResponse {
  currentSequence: number;
  accepted: SyncAcceptedMutation[];
}

export interface CloudRaceListResponse {
  currentSequence: number;
  autoDownloadMaxBytes: number;
  totalArtifactSizeBytes: number;
  races: CloudRaceMetadata[];
}

export interface CloudRaceArtifactDownload {
  bytes: Uint8Array;
  metadata: Pick<CloudRaceMetadata, 'raceKey' | 'artifactSha256'>;
}

export interface CloudRacePushResponse {
  currentSequence: number;
  accepted: {
    clientRequestId: string;
    serverSequence: number;
    artifactSha256: string;
    artifactSizeBytes: number;
  };
}

export class SyncApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'SyncApiError';
    this.status = status;
  }
}

export class SyncAuthError extends SyncApiError {
  constructor(message: string, status: number) {
    super(message, status);
    this.name = 'SyncAuthError';
  }
}

export class SyncApiClient {
  private apiBase: string;
  private token: string | null;

  constructor(apiBase: string, token: string | null = null) {
    this.apiBase = apiBase.replace(/\/+$/, '');
    this.token = token;
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  async resolveSession(token: string): Promise<SyncSession> {
    const response = await this.post<SyncSession>('/v1/session/resolve', {
      token,
    });
    return response;
  }

  async pull(
    raceCursors: SyncRaceCursorRequest[],
    limit = 500,
  ): Promise<SyncPullResponse> {
    return this.post<SyncPullResponse>(
      '/v1/sync/pull',
      {
        raceCursors,
        limit,
      },
      true,
    );
  }

  async push(
    clientId: string,
    mutations: SyncPushMutation[],
  ): Promise<SyncPushResponse> {
    if (mutations.length > SYNC_PUSH_BATCH_SIZE) {
      throw new Error(
        `Sync push batches are limited to ${SYNC_PUSH_BATCH_SIZE}.`,
      );
    }

    return this.post<SyncPushResponse>(
      '/v1/sync/push',
      {
        clientId,
        mutations,
      },
      true,
    );
  }

  async listRaces(): Promise<CloudRaceListResponse> {
    return this.post<CloudRaceListResponse>('/v1/races/list', {}, true);
  }

  async downloadRaceArtifact(
    raceKey: string,
  ): Promise<CloudRaceArtifactDownload> {
    const response = await this.request('/v1/races/download', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raceKey }),
      authRequired: true,
    });

    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      metadata: {
        raceKey: response.headers.get('x-race-key') || raceKey,
        artifactSha256: response.headers.get('x-artifact-sha256') || '',
      },
    };
  }

  async pushRaceArtifact(
    clientId: string,
    clientRequestId: string,
    metadata: CloudRaceMetadata,
    bytes: Uint8Array,
  ): Promise<CloudRacePushResponse> {
    const body = new Uint8Array(bytes.byteLength);
    body.set(bytes);

    const response = await this.request('/v1/races/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-sqlite3',
        'X-Client-Id': clientId,
        'X-Client-Request-Id': clientRequestId,
        'X-Race-Key': metadata.raceKey,
        'X-Race-Name': metadata.name,
        'X-Source-File-Name': metadata.sourceFileName,
        'X-Content-Hash': metadata.contentHash,
        'X-Row-Count': `${metadata.rowCount}`,
        'X-Race-Start-Time': metadata.raceStartTime || '',
      },
      body: body.buffer,
      authRequired: true,
    });

    return (await response.json()) as CloudRacePushResponse;
  }

  private async post<T>(
    path: string,
    body: unknown,
    authRequired = false,
  ): Promise<T> {
    const response = await this.request(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      authRequired,
    });

    return (await response.json()) as T;
  }

  private async request(
    path: string,
    options: RequestInit & { authRequired?: boolean },
  ): Promise<Response> {
    const headers = new Headers(options.headers);
    if (!headers.has('Content-Type') && options.body != null) {
      headers.set('Content-Type', 'application/json');
    }

    if (this.token) {
      headers.set('Authorization', `Bearer ${this.token}`);
    } else if (options.authRequired) {
      throw new SyncAuthError('Cloud sync requires a valid token.', 401);
    }

    let response: Response;
    try {
      response = await fetch(`${this.apiBase}${path}`, {
        ...options,
        headers,
      });
    } catch (error) {
      if (error instanceof TypeError) {
        throw new SyncApiError(
          `Could not reach sync API at ${this.apiBase}. If this is a CORS error, add ${window.location.origin} to allowed_origins and redeploy the Worker.`,
          0,
        );
      }
      throw error;
    }

    if (!response.ok) {
      const message = await readErrorMessage(response);
      if (response.status === 401 || response.status === 403) {
        throw new SyncAuthError(message, response.status);
      }
      throw new SyncApiError(message, response.status);
    }

    return response;
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    return (
      (await response.text()) ||
      `Sync API request failed with ${response.status}.`
    );
  }

  try {
    const body = (await response.json()) as { error?: string };
    return body.error || `Sync API request failed with ${response.status}.`;
  } catch {
    return `Sync API request failed with ${response.status}.`;
  }
}
