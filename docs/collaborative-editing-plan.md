# Collaborative Editing Refactor Plan

> **Scope notice:** This document is planning and documentation only. It does not
> implement backend infrastructure, introduce any runtime behaviour changes, or
> modify the application source. No AWS resources are created by this PR.

---

## Background and motivation

Lemons Race Viewer is currently a fully static Vite app. All data lives
exclusively in the browser:

- `sql.js` runs SQLite in-process (WASM).
- The database is persisted as a single file in OPFS when the browser supports
  it, or kept in memory for the session otherwise.
- The bundled seed dataset is served from `./assets/default-data.sqlite` at
  startup via a plain `fetch` in `SQLiteClient.loadPersistedBytes()`.
- Annotation editing is gated by `import.meta.env.DEV` in `src/main.ts`
  (`isLocalEditingEnabled`), so no external collaborator can edit at all today.
- Durable contribution requires manual export (`.sqlite` or `.json`) and
  out-of-band delivery.

The goal of this plan is to enable **restricted, multi-teammate collaborative
editing** while keeping the static hosting model and OPFS-first browser caching
intact.

---

## Why a serverless backend is required for authenticated writes

The browser is a public execution environment. Any logic shipped in the
frontend bundle—secret hashes, tokens, or GitHub credentials—can be extracted
by a determined visitor. A shared-secret query parameter (e.g.,
`?edit_key=…`) is adequate for **UI gating** (hiding the edit tabs from casual
readers) but provides no real authentication because:

1. The secret and the comparison hash both ship to the client.
2. The URL can be forwarded to anyone.
3. There is no server-side resource being protected; any claim the browser
   makes about itself is unverifiable.
4. Revocation requires a redeploy.

To accept annotation writes from specific collaborators and persist them into a
shared source of truth, a trusted process outside the browser must:

- verify the submitter's identity and permission scope,
- apply the mutation to shared state,
- publish an updated snapshot for all subsequent readers.

A small serverless backend (AWS Lambda + API Gateway) is the natural fit here:
stateless, cheap to run at low volume, and easy to deploy without a persistent
server.

---

## Why direct browser-to-GitHub PR creation is not the preferred approach

Automatically opening a pull request from the browser requires a GitHub token
with `contents: write` and `pull_requests: write` scope available in client
code. This is unsafe:

- The token is exposed in the browser bundle or in a `?token=…` URL.
- Anyone who extracts it gains write access to the repository.
- There is no trusted layer to validate or rate-limit requests before they
  touch the repo.
- SQLite is a binary format; GitHub PR diffs are unreadable for SQLite files,
  making review impossible in practice.
- Conflict resolution (two teammates editing the same race) requires
  application-level logic that the GitHub API does not provide.

A backend that holds GitHub App credentials and only touches the repo after
validating a signed capability token keeps the repo safe and keeps the
browser's role as a display/input layer, not a trusted actor.

---

## Proposed AWS architecture

```
Browser (static, GitHub Pages)
  │
  │  GET https://<bucket>.s3.amazonaws.com/db/latest.sqlite
  │  GET https://<bucket>.s3.amazonaws.com/db/version.json
  │                         (public, unauthenticated reads)
  │
  │  POST https://<api-id>.execute-api.<region>.amazonaws.com/mutations
  │  Authorization: ******
  │                         (authenticated writes only)
  ▼
API Gateway → Lambda (mutation handler)
                │
                ├─ Verify capability token (KMS/Secrets Manager signing key)
                ├─ Acquire DynamoDB write lease
                ├─ GET s3://lemons-db/db/latest.sqlite → /tmp/work.sqlite
                ├─ Apply transaction (sql.js or better-sqlite3 in Lambda)
                ├─ PUT s3://lemons-db/db/versions/<ts>-<uuid>.sqlite
                ├─ PUT s3://lemons-db/db/version.json
                ├─ PUT s3://lemons-db/db/latest.sqlite
                ├─ Release DynamoDB lease
                └─ Return { versionId, publishedAt }
```

### Component summary

| Component | Role |
|---|---|
| S3 bucket (`lemons-db`) | Public-read SQLite snapshot store; versioning enabled |
| API Gateway | HTTPS endpoint for the mutation API |
| Lambda (`lemons-mutations`) | Sole writer; validates tokens, applies mutations, publishes snapshots |
| DynamoDB (`lemons-write-leases`) | Single-item lease table for write serialization |
| KMS / Secrets Manager | Stores the HMAC signing key for capability tokens |
| CloudFront (optional) | CDN for `latest.sqlite` and static assets; invalidated on publish |

### S3 object layout

```
lemons-db/
  db/
    latest.sqlite          ← current canonical snapshot (public read)
    version.json           ← { versionId, publishedAt, baseEtag }
    versions/
      2026-05-26T12:00:00Z-<uuid>.sqlite
      2026-05-26T14:30:00Z-<uuid>.sqlite
      …
```

---

## Safe write algorithm

Because S3 is object storage (no file locking), all writes must be serialized
through the Lambda. The following sequence is safe for this low-volume app:

```
1.  Acquire DynamoDB lease
    ──────────────────────
    PutItem on lemons-write-leases with a TTL of 30 s and a conditional
    expression that fails if a lease item already exists and has not expired.
    If the condition fails, return 409 and ask the client to retry after 5 s.

2.  Fetch current snapshot
    ──────────────────────
    GET s3://lemons-db/db/latest.sqlite
    Record the ETag of this response as baseEtag.

3.  Apply the mutation locally
    ──────────────────────────
    Write the bytes to /tmp/work-<uuid>.sqlite.
    Open with a SQLite library (e.g., better-sqlite3).
    Run the mutation inside a single BEGIN … COMMIT transaction.
    Export the resulting bytes.

4.  Upload the versioned snapshot
    ──────────────────────────────
    PUT s3://lemons-db/db/versions/<iso-timestamp>-<uuid>.sqlite
    with the mutated bytes.
    Record the resulting S3 VersionId.

5.  Update version metadata
    ────────────────────────
    PUT s3://lemons-db/db/version.json:
    {
      "versionId": "<uuid>",
      "publishedAt": "<iso>",
      "baseEtag": "<etag-of-snapshot-that-was-mutated>"
    }

6.  Promote latest.sqlite
    ──────────────────────
    PUT s3://lemons-db/db/latest.sqlite with the same mutated bytes.
    Use a conditional write (If-Match: <baseEtag>) to detect a race.
    If the condition fails, a concurrent write snuck through; abort and
    retry from step 1.

7.  Release DynamoDB lease
    ──────────────────────
    DeleteItem on lemons-write-leases.

8.  Return to caller
    ──────────────────
    { versionId, publishedAt, ok: true }
```

> **On DynamoDB for coordination:** A single-item DynamoDB lease with a
> conditional PutItem is a lightweight, reliable way to serialize writers
> without running a dedicated lock service. At the volume expected here (a
> handful of teammates, infrequent edits), contention will be negligible. The
> 30-second TTL means a crashed Lambda automatically releases the lease. The
> additional If-Match guard on the S3 PUT is a belt-and-suspenders check
> against edge cases where the lease expires mid-flight.

---

## Authentication and capability-link approach

Each collaborator receives a **signed capability link**:

```
https://<app-host>/?edit_token=<base64url-signed-token>
```

The token payload (signed with an HMAC-SHA256 key stored in Secrets Manager):

```json
{
  "sub": "alice@example.com",
  "scope": ["annotations:write"],
  "races": ["*"],
  "iat": 1748304000,
  "exp": 1750896000
}
```

Frontend behaviour when `edit_token` is present:

1. Send the token to `POST /sessions/resolve` on first load.
2. Backend verifies the signature and expiry; returns `{ valid, capabilities }`.
3. If valid, set a session flag that replaces the hard-coded
   `import.meta.env.DEV` gate in `src/main.ts`:
   ```typescript
   const isEditingEnabled = import.meta.env.DEV || validatedCapability != null;
   ```
4. Persist the token in `sessionStorage` so it survives in-page navigation
   but is not shared across tabs or windows.

Advantages over a bare shared secret:

- Expiry is enforced server-side; old links stop working without a redeploy.
- Per-person links can be issued; individual links can be expired early by
  shortening the `exp` claim and re-signing.
- The `scope` and `races` claims allow future per-race or read-only access.
- The frontend never needs to know the signing key.

---

## Data model and API recommendations

### Prefer structured mutations over whole-file uploads

Uploading a full SQLite snapshot for every annotation change is wasteful,
hard to validate, and prone to clobbering unrelated changes made by another
collaborator between the upload and the server processing it.

Instead, the API should accept **per-annotation-kind mutation objects** that
the backend applies to the current canonical snapshot atomically.

### Mutation payload shape

```json
{
  "race_id": "race-<content-hash>",
  "client_request_id": "<uuid>",
  "mutations": [
    {
      "kind": "lapNote",
      "action": "upsert",
      "payload": {
        "id": "<uuid>",
        "lap_number": 42,
        "driver_name": "Alice",
        "note_text": "Pit stop",
        "color": "#7c3aed"
      }
    },
    {
      "kind": "taggedIncident",
      "action": "delete",
      "payload": { "id": "<uuid>" }
    }
  ]
}
```

`kind` maps directly to the five annotation tables defined in `src/types.ts`:
`lapNote`, `taggedIncident`, `rangeEvent`, `driverStint`, `journalEntry`.

`action` is one of `upsert` or `delete`.

`client_request_id` enables idempotent retries: if the Lambda sees the same
UUID twice it returns the cached success response without re-applying the
mutation.

### Schema additions for collaboration metadata

Add optional columns to each annotation table to support attribution and
conflict debugging. These can be `NULL` for locally-created annotations.

```sql
ALTER TABLE lap_notes       ADD COLUMN created_by TEXT;
ALTER TABLE lap_notes       ADD COLUMN updated_by TEXT;
ALTER TABLE tagged_incidents ADD COLUMN created_by TEXT;
ALTER TABLE tagged_incidents ADD COLUMN updated_by TEXT;
-- repeat for range_events, driver_stints, journal_entries
```

### Minimal API surface

| Endpoint | Auth | Description |
|---|---|---|
| `GET /version` | none | Returns current `version.json` from S3 |
| `POST /sessions/resolve` | ****** | Validates capability token; returns capabilities |
| `POST /mutations` | ****** | Applies annotation mutations; republishes snapshot |

The static S3 read path (`latest.sqlite`, `version.json`) requires no API
calls and no auth.

---

## Frontend refactor plan

### Phase 0 — No-op (current state)

- App fetches `./assets/default-data.sqlite` at startup.
- Edits are only possible in `DEV` mode.
- All persistence is local (OPFS or memory).

### Phase 1 — Remote snapshot read, local edits still gated

_Goal: replace bundled asset with S3-hosted snapshot. No auth, no writes._

1. Add a `VITE_DB_SNAPSHOT_URL` environment variable pointing to
   `https://<bucket>.s3.amazonaws.com/db/latest.sqlite`.
2. Change `DEFAULT_DATABASE_URL` in `src/db/sqliteClient.ts` to use this
   variable when set, falling back to `./assets/default-data.sqlite`.
3. Add a `VITE_DB_VERSION_URL` variable pointing to `version.json`.
4. In `SQLiteClient.fetchBundledVersion()`, prefer `version.json` from S3
   (which contains a stable `versionId`) over the current ETag/Last-Modified
   heuristic. This makes version comparison reliable across CDN edge nodes.
5. Keep the existing OPFS cache unchanged. The app already handles "is cached
   copy stale?" via `shouldRefreshBundledCopy`; the only change is the version
   source.

No auth changes. No write path changes.

### Phase 2 — Capability token gating

_Goal: allow teammates to unlock edit mode via signed URL._

1. On app init, read `edit_token` from `window.location.search`.
2. If present, call `POST /sessions/resolve`; on success store capabilities in
   a module-level variable (e.g., `activeCapability`).
3. Replace:
   ```typescript
   const isLocalEditingEnabled = import.meta.env.DEV;
   ```
   with:
   ```typescript
   const isLocalEditingEnabled = import.meta.env.DEV || activeCapability != null;
   ```
4. Show a non-intrusive banner: _"Collaborative edit mode enabled for
   [sub]."_
5. Clear the token from the URL bar with `history.replaceState` to avoid
   accidental sharing via copy-paste.

At this phase, edits are still written only to the local OPFS database. The
mutation API is not called yet.

### Phase 3 — Remote-backed annotation writes

_Goal: send mutation payloads to the Lambda after each local save._

1. Add a `RemoteAnnotationStore` class that wraps `createAnnotationStore`
   (from `src/features/annotations/annotationStore.ts`) and, after each
   successful local write, posts the mutation to `POST /mutations`.
2. The remote write is **fire-and-forget with retry**: local persistence
   succeeds immediately; the remote call is retried up to 3 times with
   exponential back-off. If it ultimately fails, surface a non-blocking
   warning toast.
3. The `RemoteAnnotationStore` only activates when `activeCapability` is set;
   the existing `createAnnotationStore` is used as-is in non-edit mode.
4. After a successful mutation response, update the stored `versionId` so
   subsequent version checks reflect the new snapshot.

### Phase 4 — Version-aware OPFS refresh

_Goal: collaborators see each other's changes on next page load._

1. On startup, compare the remote `versionId` from `version.json` against the
   locally cached `versionId` stored alongside the OPFS file (a separate
   `localStorage` key).
2. If they differ, invalidate the OPFS cache and fetch the new `latest.sqlite`
   from S3 before opening the database. This replaces the current ETag-based
   comparison in `loadPersistedBytes`.
3. Preserve the existing `STORAGE_SOURCE_CUSTOM` guard so a user who has
   imported a private `.sqlite` backup is never silently overwritten.

### Phase 5 — Conflict UX (optional, future)

_Goal: detect and surface concurrent write conflicts rather than silently
retrying._

1. If the Lambda returns `409 Conflict` (ETag mismatch after lease), show a
   modal: _"Your edit conflicted with a change by [other_sub]. Reloading the
   latest snapshot…"_
2. Re-fetch `latest.sqlite`, re-open the database, and discard the conflicting
   local write.

---

## Risks and tradeoffs

### Write serialization via DynamoDB lease

**Risk:** Lambda cold start + DynamoDB round-trip adds latency (~300–600 ms) to
each annotation save.  
**Mitigation:** Use provisioned concurrency on the Lambda if latency matters.
For annotation writes (not real-time gameplay) this is acceptable.

### S3 eventual consistency for `latest.sqlite`

**Risk:** Immediately after a write, a reader on a different CDN node may still
see the old snapshot.  
**Mitigation:** `version.json` is fetched with `cache: 'no-store'`. If the
version has not advanced, the browser keeps its OPFS copy. The app never
blindly serves stale data as "current"; it only serves it as "cached while
version unchanged."

### Binary SQLite as shared format

**Risk:** If schema migrations are needed in the future, all published snapshots
must be migrated together or the Lambda must run `applyMigrations` on every
loaded snapshot.  
**Mitigation:** `SQLiteClient.applyMigrations()` already exists and is
idempotent. Run it in the Lambda mutation handler before applying any user
mutation.

### Capability token replay

**Risk:** A leaked token can be used until it expires.  
**Mitigation:** Keep expiry short (2–4 weeks). Add a token revocation list in
DynamoDB if needed. The backend checks the list before accepting a write.

### Whole-snapshot download on first load

**Risk:** `latest.sqlite` may grow large over time as more races are added.  
**Mitigation:** The app already caches in OPFS and only re-fetches when the
version changes, so the download is amortized. If the file grows unacceptably,
consider splitting races into per-race snapshot files and loading on demand.

### No online/offline detection

**Risk:** If the mutation API is unreachable, a collaborator's edits exist only
in their OPFS cache.  
**Mitigation:** Phase 3 makes remote writes advisory (fire-and-forget with
toast warning). The local edit is never blocked on network availability. A
future phase could queue mutations in `localStorage` and replay them when
connectivity returns.

---

## Phased rollout plan

| Phase | Deliverable | Prerequisites |
|---|---|---|
| 1 | Remote snapshot read from S3 | Bucket created, `latest.sqlite` seeded from `default-data.sqlite` |
| 2 | Capability token gating (UI only) | Lambda `POST /sessions/resolve`, Secrets Manager signing key |
| 3 | Remote annotation writes | Lambda `POST /mutations`, DynamoDB lease table |
| 4 | Version-aware OPFS refresh | Phase 1 + 3 complete |
| 5 | Conflict UX | Phase 3 complete |

Each phase is independently deployable and leaves the app fully functional if
the subsequent phase is not yet complete.

---

## What this plan explicitly does not change

- The static hosting model (GitHub Pages or equivalent) is unchanged.
- No changes to the CSV import pipeline, normalization logic, or chart views.
- No changes to the local `.sqlite`/`.json` export and restore workflows.
- No live multi-user editing (all writes are serialized; there is no WebSocket
  or operational-transform layer).
- No GitHub PR automation; the shared SQLite snapshot in S3 is the canonical
  collaborative store, not the git repository.
