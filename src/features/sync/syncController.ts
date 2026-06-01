import type { SQLiteClient } from '../../db/sqliteClient';
import type {
  MediaAttachment,
  SyncConfig,
  SyncConnectionStatus,
  SyncMode,
  SyncSession,
} from '../../types';
import { readMediaBaseUrl } from '../media/media';
import { prepareMediaUpload } from '../media/mediaUpload';
import type { SyncPulledMutation, SyncRaceCursorRequest } from './syncApi';
import {
  SYNC_PULL_BATCH_SIZE,
  SYNC_PUSH_BATCH_SIZE,
  SyncApiClient,
  SyncAuthError,
} from './syncApi';
import type { PulledMutationConflictPolicy } from './syncLocalStore';
import {
  appendRaceOutboxMutation,
  applyPulledMutations,
  countFailedOutbox,
  countFailedRaceOutbox,
  countPendingOutbox,
  countPendingRaceOutbox,
  getLocalRaceKeys,
  getPendingOutbox,
  getPendingRaceOutbox,
  getRaceCursorRequests,
  getRaceIdByRaceKey,
  getRaceKeyForRaceId,
  getRaceMetadataForSync,
  getSyncConfig,
  markOutboxAccepted,
  markOutboxFailed,
  markRaceOutboxAccepted,
  markRaceOutboxFailed,
  markSyncReconnectRequired,
  outboxRowsToPushMutations,
  recordGlobalSequenceSeen,
  seedOutboxForUnsyncedAnnotations,
  seedRaceOutboxForUnsyncedRaces,
  upsertSyncConfig,
} from './syncLocalStore';

const SESSION_TOKEN_KEY = 'lemons-race-viewer-sync-token';
const READ_ONLY_REPLAY_REPAIR_VERSION = 'v2';
const READ_ONLY_REPLAY_REPAIR_KEY_PREFIX =
  'lemons-race-viewer-read-only-replay-repair';

export interface SyncControllerSnapshot {
  mode: SyncMode;
  status: SyncConnectionStatus;
  apiBase: string | null;
  session: SyncSession | null;
  config: SyncConfig | null;
  pendingCount: number;
  failedCount: number;
}

interface SyncControllerHandlers {
  onChange?: (snapshot: SyncControllerSnapshot) => void;
  onStatus?: (message: string) => void;
}

type SyncTokenSource = 'url' | 'stored' | 'public-read';

export class SyncController {
  private db: SQLiteClient;
  private apiBase: string | null;
  private api: SyncApiClient | null;
  private session: SyncSession | null;
  private config: SyncConfig | null;
  private mode: SyncMode;
  private status: SyncConnectionStatus;
  private handlers: SyncControllerHandlers;
  private isSyncing: boolean;
  private syncRequestedWhileBusy: boolean;

  constructor(db: SQLiteClient, handlers: SyncControllerHandlers = {}) {
    this.db = db;
    this.apiBase = readSyncApiBase();
    this.api = this.apiBase ? new SyncApiClient(this.apiBase) : null;
    this.session = null;
    this.config = getSyncConfig(db);
    this.mode = readOnlyModeEnabled() ? 'read-only' : 'standalone';
    this.status = this.config ? 'reconnect-required' : 'disconnected';
    this.handlers = handlers;
    this.isSyncing = false;
    this.syncRequestedWhileBusy = false;
  }

  async initFromLocation(location: Location = window.location): Promise<void> {
    if (!this.api || !this.apiBase) {
      this.emit();
      return;
    }

    const locationToken = readTokenFromLocation(location);
    const storedToken = readStoredToken();
    const publicReadToken =
      this.mode === 'read-only' ? readPublicReadToken() : null;
    const token = locationToken ?? storedToken ?? publicReadToken;
    const tokenSource: SyncTokenSource | null = locationToken
      ? 'url'
      : storedToken
        ? 'stored'
        : publicReadToken
          ? 'public-read'
          : null;

    if (!token || !tokenSource) {
      if (this.mode === 'read-only') {
        this.status = 'error';
        this.handlers.onStatus?.(
          'Public read-only cloud sync is missing VITE_SYNC_PUBLIC_READ_TOKEN.',
        );
        this.emit();
        return;
      }

      this.status = this.config ? 'reconnect-required' : 'disconnected';
      this.emit();
      return;
    }

    if (tokenSource !== 'public-read') {
      storeToken(token);
      removeTokenFromUrl(location);
    }

    const didResolve = await this.resolveToken(token, {
      authErrorMessage:
        tokenSource === 'public-read'
          ? 'Public read-only cloud sync needs a valid read token.'
          : undefined,
    });
    if (!didResolve) {
      if (
        tokenSource === 'stored' &&
        this.mode === 'read-only' &&
        publicReadToken
      ) {
        await this.resolveAndSyncPublicReadToken(publicReadToken);
      }
      return;
    }

    if (this.mode === 'read-only') {
      if (
        tokenSource === 'public-read' &&
        sessionHasAnyWriteScope(this.session)
      ) {
        this.status = 'error';
        this.handlers.onStatus?.(
          'VITE_SYNC_PUBLIC_READ_TOKEN must not include write scopes.',
        );
        this.emit();
        return;
      }

      if (
        tokenSource !== 'public-read' &&
        sessionHasAnnotationWriteScope(this.session)
      ) {
        this.mode = 'standalone';
        this.emit();
      } else {
        await this.syncNow();
        return;
      }
    }

    if (
      this.config?.status === 'connected' &&
      this.session &&
      this.config.workspace_id === this.session.workspaceId
    ) {
      this.mode = 'cloud-connected';
      this.status = 'disconnected';
      this.api.setToken(token);
      this.emit();
      await this.syncNow();
      return;
    }

    this.status =
      this.config?.status === 'reconnect_required'
        ? 'reconnect-required'
        : 'disconnected';
    this.emit();
  }

  getSnapshot(): SyncControllerSnapshot {
    return {
      mode: this.mode,
      status: this.status,
      apiBase: this.apiBase,
      session: this.session,
      config: this.config,
      pendingCount: this.config
        ? countPendingOutbox(this.db, this.config.workspace_id) +
          countPendingRaceOutbox(this.db, this.config.workspace_id)
        : 0,
      failedCount: this.config
        ? countFailedOutbox(this.db, this.config.workspace_id) +
          countFailedRaceOutbox(this.db, this.config.workspace_id)
        : 0,
    };
  }

  getActiveConfig(): SyncConfig | null {
    return this.mode === 'cloud-connected' ? this.config : null;
  }

  hasCloudApi(): boolean {
    return Boolean(this.apiBase);
  }

  canConnect(): boolean {
    return Boolean(
      this.api && this.apiBase && this.session && this.mode !== 'read-only',
    );
  }

  reloadFromDatabase(): void {
    this.config = getSyncConfig(this.db);
    if (this.mode !== 'read-only') {
      this.mode = 'standalone';
    }
    this.status =
      this.config?.status === 'reconnect_required'
        ? 'reconnect-required'
        : 'disconnected';
    this.emit();
  }

  async connectCurrentDatabase(): Promise<void> {
    if (!this.api || !this.apiBase || !this.session) {
      this.handlers.onStatus?.('Cloud sync needs a valid edit token first.');
      return;
    }

    this.status = 'connecting';
    this.emit();
    const previousClientId = this.config?.client_id ?? null;
    this.config = await upsertSyncConfig(
      this.db,
      this.apiBase,
      this.session,
      previousClientId,
    );
    this.mode = 'cloud-connected';
    this.status = 'syncing';
    this.emit();

    await this.syncCloudConnectedOnce();
    this.status = 'disconnected';
    this.emit();
  }

  async syncNow(): Promise<void> {
    if (this.mode !== 'cloud-connected' && this.mode !== 'read-only') {
      return;
    }
    if (this.mode === 'read-only' && !this.session) {
      return;
    }

    if (this.isSyncing) {
      this.syncRequestedWhileBusy = true;
      return;
    }

    this.isSyncing = true;

    try {
      while (this.mode === 'cloud-connected' || this.mode === 'read-only') {
        this.syncRequestedWhileBusy = false;
        this.status = 'syncing';
        this.emit();

        try {
          if (this.mode === 'read-only') {
            await this.syncReadOnlyOnce();
          } else {
            await this.syncCloudConnectedOnce();
          }
          this.status = 'disconnected';
          this.emit();
        } catch (error) {
          this.syncRequestedWhileBusy = false;
          await this.handleSyncError(error);
          break;
        }

        if (!this.syncRequestedWhileBusy) {
          break;
        }
      }
    } finally {
      this.isSyncing = false;
    }
  }

  async queueRaceForSync(raceKey: string): Promise<void> {
    if (this.mode !== 'cloud-connected' || !this.config || !raceKey) {
      return;
    }

    await appendRaceOutboxMutation(this.db, this.config, raceKey);
    await this.syncNow();
  }

  canUploadMedia(): boolean {
    return Boolean(
      this.mode === 'cloud-connected' &&
        this.api &&
        this.config &&
        this.session?.scopes.includes('media:write') &&
        readMediaBaseUrl(),
    );
  }

  async uploadMediaFiles(
    raceId: string,
    files: File[],
  ): Promise<MediaAttachment[]> {
    if (!this.api || !this.config || !this.session || !this.canUploadMedia()) {
      throw new Error(
        'Cloud media uploads require a connected media write token.',
      );
    }

    const raceKey = getRaceKeyForRaceId(this.db, raceId);
    if (!raceKey) {
      throw new Error('Selected race is not available for media upload.');
    }

    const attachments: MediaAttachment[] = [];
    for (const file of files) {
      const prepared = await prepareMediaUpload(file);
      const response = await this.api.uploadMedia(
        this.config.client_id,
        crypto.randomUUID(),
        raceKey,
        prepared,
      );
      attachments.push({
        ...response.asset,
        caption: '',
        altText: '',
      });
    }

    return attachments;
  }

  private async resolveAndSyncPublicReadToken(token: string): Promise<void> {
    const didResolve = await this.resolveToken(token, {
      authErrorMessage: 'Public read-only cloud sync needs a valid read token.',
    });
    if (!didResolve) {
      return;
    }

    if (sessionHasAnyWriteScope(this.session)) {
      this.status = 'error';
      this.handlers.onStatus?.(
        'VITE_SYNC_PUBLIC_READ_TOKEN must not include write scopes.',
      );
      this.emit();
      return;
    }

    await this.syncNow();
  }

  private async syncCloudConnectedOnce(): Promise<void> {
    if (!this.config) {
      return;
    }

    await this.syncRaces({
      allowPush: true,
      workspaceId: this.config.workspace_id,
    });
    await this.queueLocalAnnotationChanges();
    await this.flushPending();
    await this.pullRemote(this.config.workspace_id);
  }

  private async syncReadOnlyOnce(): Promise<void> {
    if (!this.session) {
      return;
    }

    if (!sessionHasAnnotationReadScope(this.session)) {
      throw new SyncAuthError(
        'Public read-only cloud sync needs annotations:read scope.',
        403,
      );
    }

    await this.syncRaces({
      allowPush: false,
      workspaceId: this.session.workspaceId,
    });
    const replayFromStart = !readOnlyReplayRepairComplete(
      this.session.workspaceId,
    );
    await this.pullRemote(this.session.workspaceId, {
      conflictPolicy: 'remote-wins',
      replayFromStart,
    });
    if (replayFromStart) {
      markReadOnlyReplayRepairComplete(this.session.workspaceId);
    }
  }

  private async resolveToken(
    token: string,
    options: { authErrorMessage?: string } = {},
  ): Promise<boolean> {
    if (!this.api) {
      return false;
    }

    this.status = 'connecting';
    this.emit();
    try {
      this.session = await this.api.resolveSession(token);
      this.api.setToken(token);
      this.status = 'disconnected';
      this.emit();
      return true;
    } catch (error) {
      clearStoredToken();
      this.session = null;
      await this.handleSyncError(error, options.authErrorMessage);
      return false;
    }
  }

  private async pullRemote(
    workspaceId: string,
    options: {
      conflictPolicy?: PulledMutationConflictPolicy;
      replayFromStart?: boolean;
    } = {},
  ): Promise<void> {
    if (!this.api || !workspaceId) {
      return;
    }

    const conflictPolicy = options.conflictPolicy ?? 'preserve-local';
    const replayFromStart = options.replayFromStart ?? false;
    let cursorRequests = replayFromStart
      ? getRaceCursorRequests(this.db, workspaceId).map((cursor) => ({
          ...cursor,
          since: 0,
        }))
      : [];
    let appliedTotal = 0;
    let lastMutationSignature = '';

    while (true) {
      if (!replayFromStart) {
        cursorRequests = getRaceCursorRequests(this.db, workspaceId);
      }
      if (!cursorRequests.length) {
        return;
      }

      const response = await this.api.pull(
        cursorRequests,
        SYNC_PULL_BATCH_SIZE,
      );
      const applied = await applyPulledMutations(
        this.db,
        workspaceId,
        response.mutations,
        { conflictPolicy },
      );
      appliedTotal += applied;
      await recordGlobalSequenceSeen(this.db, response.currentSequence);
      this.config = getSyncConfig(this.db);

      if (response.mutations.length < SYNC_PULL_BATCH_SIZE) {
        break;
      }

      const mutationSignature = response.mutations
        .map((mutation) => `${mutation.raceKey}:${mutation.serverSequence}`)
        .join('|');
      if (mutationSignature === lastMutationSignature) {
        break;
      }
      lastMutationSignature = mutationSignature;
      if (replayFromStart) {
        cursorRequests = advanceCursorRequests(
          cursorRequests,
          response.mutations,
        );
      }
    }

    if (appliedTotal) {
      this.handlers.onStatus?.(
        `Applied ${appliedTotal} cloud update${appliedTotal === 1 ? '' : 's'}.`,
      );
    }
  }

  private async queueLocalAnnotationChanges(): Promise<void> {
    if (!this.config) {
      return;
    }

    const seeded = await seedOutboxForUnsyncedAnnotations(this.db, this.config);
    if (seeded) {
      this.handlers.onStatus?.(
        `Queued ${seeded} local annotation${seeded === 1 ? '' : 's'} for cloud sync.`,
      );
    }
  }

  private async syncRaces({
    allowPush,
    workspaceId,
  }: {
    allowPush: boolean;
    workspaceId: string;
  }): Promise<void> {
    if (!this.api || !workspaceId) {
      return;
    }

    const response = await this.api.listRaces();
    await recordGlobalSequenceSeen(this.db, response.currentSequence);
    this.config = getSyncConfig(this.db);

    if (
      response.totalArtifactSizeBytes > response.autoDownloadMaxBytes &&
      response.races.length
    ) {
      this.handlers.onStatus?.(
        'Cloud has races; export/import or picker support needed.',
      );
    } else {
      const localRaceKeys = new Set(
        getLocalRaceKeys(this.db).map((race) => race.race_key),
      );

      for (const race of response.races) {
        const local = getRaceMetadataForSync(
          this.db,
          race.raceKey,
          workspaceId,
        );
        const shouldDownload =
          !localRaceKeys.has(race.raceKey) ||
          race.serverSequence > (local?.serverSequence ?? 0) ||
          (race.artifactSha256 &&
            local?.artifactSha256 &&
            race.artifactSha256 !== local.artifactSha256);

        if (!shouldDownload) {
          continue;
        }

        this.handlers.onStatus?.(`Downloading ${race.name} from cloud...`);
        const artifact = await this.api.downloadRaceArtifact(race.raceKey);
        await this.db.importRaceArtifact(artifact.bytes, {
          ...race,
          workspaceId,
          artifactSha256:
            artifact.metadata.artifactSha256 || race.artifactSha256,
        });
        localRaceKeys.add(race.raceKey);
      }
    }

    if (!allowPush || !this.config) {
      return;
    }

    const seeded = await seedRaceOutboxForUnsyncedRaces(this.db, this.config);
    if (seeded) {
      this.handlers.onStatus?.(
        `Queued ${seeded} local race${seeded === 1 ? '' : 's'} for cloud sync.`,
      );
    }
    await this.flushPendingRaceArtifacts();
  }

  private async flushPendingRaceArtifacts(): Promise<void> {
    if (!this.api || !this.config || !this.session) {
      return;
    }

    const api = this.api;
    const config = this.config;
    const session = this.session;
    let pending = countPendingRaceOutbox(this.db, config.workspace_id);
    if (!pending) {
      return;
    }

    let batchIndex = 0;
    while (pending > 0) {
      batchIndex += 1;
      this.handlers.onStatus?.(`Syncing race artifact ${batchIndex}...`);
      const rows = getPendingRaceOutbox(this.db, config.workspace_id, 1);
      if (!rows.length) {
        break;
      }

      const [row] = rows;
      const raceId = getRaceIdByRaceKey(this.db, row.race_key);
      const metadata = getRaceMetadataForSync(
        this.db,
        row.race_key,
        config.workspace_id,
      );
      if (!raceId || !metadata) {
        await markRaceOutboxFailed(
          this.db,
          rows,
          'Race is no longer available locally.',
        );
        pending = countPendingRaceOutbox(this.db, config.workspace_id);
        continue;
      }

      try {
        const response = await api.pushRaceArtifact(
          config.client_id,
          row.client_request_id,
          metadata,
          this.db.exportRaceArtifact(raceId),
        );
        await markRaceOutboxAccepted(this.db, row, response, session.subject);
        await recordGlobalSequenceSeen(this.db, response.currentSequence);
        this.config = getSyncConfig(this.db);
      } catch (error) {
        await markRaceOutboxFailed(
          this.db,
          rows,
          error instanceof Error ? error.message : 'Cloud race sync failed.',
        );
        throw error;
      }

      pending = countPendingRaceOutbox(this.db, config.workspace_id);
    }
  }

  private async flushPending(): Promise<void> {
    if (!this.api || !this.config || !this.session) {
      return;
    }

    const api = this.api;
    const config = this.config;
    const session = this.session;
    let pending = countPendingOutbox(this.db, config.workspace_id);
    if (!pending) {
      return;
    }

    const totalBatches = Math.ceil(pending / SYNC_PUSH_BATCH_SIZE);
    let batchIndex = 0;

    while (pending > 0) {
      batchIndex += 1;
      this.handlers.onStatus?.(
        `Syncing ${batchIndex}/${totalBatches} batches...`,
      );
      const rows = getPendingOutbox(
        this.db,
        config.workspace_id,
        SYNC_PUSH_BATCH_SIZE,
      );
      if (!rows.length) {
        break;
      }

      try {
        const response = await api.push(
          config.client_id,
          outboxRowsToPushMutations(rows),
        );
        const acceptedByRequest = new Map(
          response.accepted.map((item) => [item.clientRequestId, item]),
        );

        for (const row of rows) {
          const accepted = acceptedByRequest.get(row.client_request_id);
          if (!accepted) {
            await markOutboxFailed(
              this.db,
              [row],
              'Cloud sync did not accept this mutation.',
            );
            continue;
          }

          await markOutboxAccepted(this.db, row, accepted, session.subject);
        }

        await recordGlobalSequenceSeen(this.db, response.currentSequence);
        this.config = getSyncConfig(this.db);
      } catch (error) {
        await markOutboxFailed(
          this.db,
          rows,
          error instanceof Error ? error.message : 'Cloud sync failed.',
        );
        throw error;
      }

      pending = countPendingOutbox(this.db, config.workspace_id);
    }
  }

  private async handleSyncError(
    error: unknown,
    authErrorMessage?: string,
  ): Promise<void> {
    console.error(error);
    if (error instanceof SyncAuthError) {
      clearStoredToken();
      if (this.config && this.mode !== 'read-only') {
        await markSyncReconnectRequired(this.db);
        this.config = getSyncConfig(this.db);
      }
      this.mode = this.mode === 'read-only' ? 'read-only' : 'standalone';
      this.status = this.mode === 'read-only' ? 'error' : 'reconnect-required';
      this.handlers.onStatus?.(
        authErrorMessage ||
          (this.mode === 'read-only'
            ? error.message || 'Read-only cloud sync needs a valid read token.'
            : 'Cloud sync needs a fresh edit token. Local editing remains available.'),
      );
      this.emit();
      return;
    }

    this.status = 'error';
    this.handlers.onStatus?.(
      error instanceof Error ? error.message : 'Cloud sync failed.',
    );
    this.emit();
  }

  private emit(): void {
    this.handlers.onChange?.(this.getSnapshot());
  }
}

function readSyncApiBase(): string | null {
  const value = import.meta.env.VITE_SYNC_API_BASE;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readPublicReadToken(): string | null {
  const value = import.meta.env.VITE_SYNC_PUBLIC_READ_TOKEN;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readOnlyModeEnabled(): boolean {
  return (
    import.meta.env.VITE_SYNC_READ_ONLY === 'true' ||
    Boolean(readPublicReadToken())
  );
}

function advanceCursorRequests(
  cursorRequests: SyncRaceCursorRequest[],
  mutations: SyncPulledMutation[],
): SyncRaceCursorRequest[] {
  const nextSinceByRaceKey = new Map(
    cursorRequests.map((cursor) => [cursor.raceKey, cursor.since]),
  );
  mutations.forEach((mutation) => {
    nextSinceByRaceKey.set(
      mutation.raceKey,
      Math.max(
        nextSinceByRaceKey.get(mutation.raceKey) ?? 0,
        mutation.serverSequence,
      ),
    );
  });

  return cursorRequests.map((cursor) => ({
    ...cursor,
    since: nextSinceByRaceKey.get(cursor.raceKey) ?? cursor.since,
  }));
}

function readOnlyReplayRepairComplete(workspaceId: string): boolean {
  try {
    return (
      localStorage.getItem(readOnlyReplayRepairKey(workspaceId)) ===
      READ_ONLY_REPLAY_REPAIR_VERSION
    );
  } catch {
    return false;
  }
}

function markReadOnlyReplayRepairComplete(workspaceId: string): void {
  try {
    localStorage.setItem(
      readOnlyReplayRepairKey(workspaceId),
      READ_ONLY_REPLAY_REPAIR_VERSION,
    );
  } catch {
    // If localStorage is unavailable, replaying on the next load is safe.
  }
}

function readOnlyReplayRepairKey(workspaceId: string): string {
  return `${READ_ONLY_REPLAY_REPAIR_KEY_PREFIX}:${workspaceId}`;
}

function readTokenFromLocation(location: Location): string | null {
  const params = new URLSearchParams(location.search);
  return params.get('edit_token') || params.get('sync_token');
}

function removeTokenFromUrl(location: Location): void {
  const url = new URL(location.href);
  if (
    !url.searchParams.has('edit_token') &&
    !url.searchParams.has('sync_token')
  ) {
    return;
  }

  url.searchParams.delete('edit_token');
  url.searchParams.delete('sync_token');
  history.replaceState(
    null,
    document.title,
    `${url.pathname}${url.search}${url.hash}`,
  );
}

function readStoredToken(): string | null {
  try {
    return sessionStorage.getItem(SESSION_TOKEN_KEY);
  } catch {
    return null;
  }
}

function sessionHasAnnotationWriteScope(session: SyncSession | null): boolean {
  return Boolean(session?.scopes?.includes('annotations:write'));
}

function sessionHasAnyWriteScope(session: SyncSession | null): boolean {
  return Boolean(session?.scopes?.some((scope) => scope.endsWith(':write')));
}

function sessionHasAnnotationReadScope(session: SyncSession | null): boolean {
  return Boolean(session?.scopes?.includes('annotations:read'));
}

function storeToken(token: string): void {
  try {
    sessionStorage.setItem(SESSION_TOKEN_KEY, token);
  } catch {
    // Ignore storage failures; the current in-memory token still works.
  }
}

function clearStoredToken(): void {
  try {
    sessionStorage.removeItem(SESSION_TOKEN_KEY);
  } catch {
    // Ignore storage failures while clearing auth state.
  }
}
