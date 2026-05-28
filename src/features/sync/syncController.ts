import type { SQLiteClient } from '../../db/sqliteClient';
import type {
  SyncConfig,
  SyncConnectionStatus,
  SyncMode,
  SyncSession,
} from '../../types';
import { SYNC_PUSH_BATCH_SIZE, SyncApiClient, SyncAuthError } from './syncApi';
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

    const token = readTokenFromLocation(location) ?? readStoredToken();
    if (!token) {
      this.status = this.config ? 'reconnect-required' : 'disconnected';
      this.emit();
      return;
    }

    storeToken(token);
    removeTokenFromUrl(location);
    await this.resolveToken(token);
    if (this.mode === 'read-only') {
      if (sessionHasAnnotationWriteScope(this.session)) {
        this.mode = 'standalone';
        this.emit();
      } else {
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

    await this.syncRaces();
    await this.queueLocalAnnotationChanges();
    await this.flushPending();
    await this.pullRemote();
    this.status = 'disconnected';
    this.emit();
  }

  async syncNow(): Promise<void> {
    if (this.mode !== 'cloud-connected') {
      return;
    }

    if (this.isSyncing) {
      this.syncRequestedWhileBusy = true;
      return;
    }

    this.isSyncing = true;

    try {
      while (this.mode === 'cloud-connected') {
        this.syncRequestedWhileBusy = false;
        this.status = 'syncing';
        this.emit();

        try {
          await this.syncRaces();
          await this.queueLocalAnnotationChanges();
          await this.flushPending();
          await this.pullRemote();
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

  private async resolveToken(token: string): Promise<void> {
    if (!this.api) {
      return;
    }

    this.status = 'connecting';
    this.emit();
    try {
      this.session = await this.api.resolveSession(token);
      this.api.setToken(token);
      this.status = 'disconnected';
      this.emit();
    } catch (error) {
      clearStoredToken();
      this.session = null;
      await this.handleSyncError(error);
    }
  }

  private async pullRemote(): Promise<void> {
    if (!this.api || !this.config) {
      return;
    }

    const raceCursors = getRaceCursorRequests(
      this.db,
      this.config.workspace_id,
    );
    if (!raceCursors.length) {
      return;
    }

    const response = await this.api.pull(raceCursors);
    const applied = await applyPulledMutations(
      this.db,
      this.config.workspace_id,
      response.mutations,
    );
    await recordGlobalSequenceSeen(this.db, response.currentSequence);
    this.config = getSyncConfig(this.db);

    if (applied) {
      this.handlers.onStatus?.(
        `Applied ${applied} cloud update${applied === 1 ? '' : 's'}.`,
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

  private async syncRaces(): Promise<void> {
    if (!this.api || !this.config) {
      return;
    }

    const response = await this.api.listRaces();
    await recordGlobalSequenceSeen(this.db, response.currentSequence);
    this.config = getSyncConfig(this.db);

    if (!this.config) {
      return;
    }

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
          this.config.workspace_id,
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
          workspaceId: this.config.workspace_id,
          artifactSha256:
            artifact.metadata.artifactSha256 || race.artifactSha256,
        });
        localRaceKeys.add(race.raceKey);
      }
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

  private async handleSyncError(error: unknown): Promise<void> {
    console.error(error);
    if (error instanceof SyncAuthError) {
      clearStoredToken();
      if (this.config) {
        await markSyncReconnectRequired(this.db);
        this.config = getSyncConfig(this.db);
      }
      this.mode = this.mode === 'read-only' ? 'read-only' : 'standalone';
      this.status = 'reconnect-required';
      this.handlers.onStatus?.(
        'Cloud sync needs a fresh edit token. Local editing remains available.',
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

function readOnlyModeEnabled(): boolean {
  return import.meta.env.VITE_SYNC_READ_ONLY === 'true';
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
