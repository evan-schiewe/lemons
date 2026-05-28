import { Hono } from 'hono';

const MAX_PUSH_MUTATIONS = 50;
const MAX_PULL_LIMIT = 500;
const DEFAULT_WORKSPACE_ID = 'main';
const DEFAULT_AUTO_DOWNLOAD_MAX_BYTES = 104857600;
const DEFAULT_RACE_ARTIFACT_MAX_BYTES = 26214400;
const DEFAULT_RACE_WORKSPACE_STORAGE_QUOTA_BYTES = 1073741824;
const DEFAULT_RACE_UPLOADS_PER_TOKEN_PER_DAY = 20;
const DEFAULT_RACE_UPLOADS_PER_WORKSPACE_PER_DAY = 100;
const DEFAULT_RACE_ARTIFACT_RETAINED_VERSIONS = 2;
const DEFAULT_MEDIA_UPLOAD_MAX_BYTES = 10485760;
const DEFAULT_MEDIA_VARIANT_MAX_BYTES = 3145728;
const DEFAULT_MEDIA_UPLOADS_PER_TOKEN_PER_DAY = 100;
const DEFAULT_MEDIA_UPLOADS_PER_WORKSPACE_PER_DAY = 500;
const DEFAULT_MEDIA_WORKSPACE_STORAGE_QUOTA_BYTES = 1073741824;
const RACE_KEY_PATTERN = /^race-[a-f0-9]{64}$/;
const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/;
const ASSET_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MEDIA_VARIANT_NAMES = ['thumb', 'medium', 'large'];
const MEDIA_CONTENT_TYPES = new Map([
  ['image/webp', 'webp'],
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
]);
const SQLITE_HEADER_BYTES = [
  0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74,
  0x20, 0x33, 0x00,
];

const KIND_CONFIG = {
  lapNote: {
    table: 'lap_notes',
    fields: [
      'lap_number',
      'driver_name',
      'note_text',
      'color',
      'created_at',
      'updated_at',
    ],
    required: ['lap_number', 'note_text'],
  },
  taggedIncident: {
    table: 'tagged_incidents',
    fields: [
      'lap_number',
      'title',
      'tag',
      'color',
      'details',
      'created_at',
      'updated_at',
    ],
    required: ['lap_number', 'title', 'tag'],
  },
  rangeEvent: {
    table: 'range_events',
    fields: [
      'start_lap',
      'end_lap',
      'title',
      'tag',
      'color',
      'details',
      'created_at',
      'updated_at',
    ],
    required: ['start_lap', 'end_lap', 'title', 'tag'],
  },
  driverStint: {
    table: 'driver_stints',
    fields: [
      'driver_name',
      'start_lap',
      'end_lap',
      'color',
      'notes',
      'created_at',
      'updated_at',
    ],
    required: ['driver_name', 'start_lap', 'end_lap'],
  },
  journalEntry: {
    table: 'journal_entries',
    fields: [
      'lap_number',
      'event_time_iso',
      'event_time_source',
      'title',
      'entry_text',
      'color',
      'created_at',
      'updated_at',
    ],
    required: ['entry_text'],
  },
};

const app = new Hono();

app.on('OPTIONS', '*', (c) => {
  const cors = corsHeaders(c.req.raw, c.env);
  return new Response(null, {
    status: cors['Access-Control-Allow-Origin'] ? 204 : 403,
    headers: cors,
  });
});

app.get('/', handleHealth);
app.get('/v1/health', handleHealth);
app.post('/v1/session/resolve', route(handleResolveSession));
app.post('/v1/sync/pull', route(handlePull));
app.post('/v1/sync/push', route(handlePush));
app.post('/v1/races/list', route(handleRaceList));
app.post('/v1/races/download', route(handleRaceDownload));
app.post('/v1/races/push', route(handleRacePush));
app.post('/v1/media/upload', route(handleMediaUpload));

app.notFound((c) =>
  json({ error: 'Not found.' }, 404, corsHeaders(c.req.raw, c.env)),
);

app.onError((error, c) => {
  const cors = corsHeaders(c.req.raw, c.env);
  if (error instanceof HttpError) {
    return json({ error: error.message }, error.status, cors);
  }

  console.error(error);
  return json({ error: 'Internal sync API error.' }, 500, cors);
});

export default app;

function route(handler) {
  return (c) => handler(c.req.raw, c.env, corsHeaders(c.req.raw, c.env));
}

function handleHealth(c) {
  return json(
    {
      ok: true,
      service: 'lemons-sync-api',
    },
    200,
    corsHeaders(c.req.raw, c.env),
  );
}

async function handleResolveSession(request, env, cors) {
  const body = await readJson(request);
  const token = stringValue(body.token);
  if (!token) {
    throw new HttpError(400, 'Missing token.');
  }

  const claims = await verifyCapabilityToken(token, env);
  await ensureTokenAllowed(env, claims);
  const workspaceId = workspaceFromClaims(claims);
  const currentSequence = await getCurrentSequence(env, workspaceId);

  return json(
    {
      subject: claims.sub,
      workspaceId,
      scopes: arrayValue(claims.scope),
      raceScopes: arrayValue(claims.races),
      expiresAt: new Date(numberValue(claims.exp) * 1000).toISOString(),
      currentSequence,
    },
    200,
    cors,
  );
}

async function handleRaceList(request, env, cors) {
  const claims = await authenticateAny(request, env, [
    'races:read',
    'annotations:read',
  ]);
  const workspaceId = workspaceFromClaims(claims);
  const rows = await env.DB.prepare(
    `
      SELECT *
      FROM workspace_races
      WHERE workspace_id = ? AND deleted_at IS NULL
      ORDER BY updated_at DESC
    `,
  )
    .bind(workspaceId)
    .all();
  const races = (rows.results || [])
    .filter((row) => raceAllowed(claims, row.race_key))
    .map((row) => ({
      workspaceId,
      raceKey: row.race_key,
      name: row.name,
      sourceFileName: row.source_file_name,
      contentHash: row.content_hash,
      raceStartTime: row.race_start_time,
      rowCount: row.row_count,
      artifactSha256: row.artifact_sha256,
      artifactSizeBytes: row.artifact_size_bytes,
      serverSequence: row.server_sequence,
      updatedAt: row.updated_at,
      createdBy: row.created_by,
      updatedBy: row.updated_by,
    }));
  const currentSequence = await getCurrentSequence(env, workspaceId);

  return json(
    {
      currentSequence,
      autoDownloadMaxBytes: autoDownloadMaxBytes(env),
      totalArtifactSizeBytes: races.reduce(
        (total, race) => total + Number(race.artifactSizeBytes || 0),
        0,
      ),
      races,
    },
    200,
    cors,
  );
}

async function handleRaceDownload(request, env, cors) {
  const claims = await authenticateAny(request, env, [
    'races:read',
    'annotations:read',
  ]);
  const workspaceId = workspaceFromClaims(claims);
  const body = await readJson(request);
  const raceKey = stringValue(body.raceKey);
  if (!raceKey || !raceAllowed(claims, raceKey)) {
    throw new HttpError(403, 'Token is not allowed to read this race.');
  }

  const race = await env.DB.prepare(
    `
      SELECT artifact_key, artifact_sha256
      FROM workspace_races
      WHERE workspace_id = ? AND race_key = ? AND deleted_at IS NULL
    `,
  )
    .bind(workspaceId, raceKey)
    .first();
  if (!race) {
    throw new HttpError(404, 'Race artifact not found.');
  }

  const artifact = await env.RACE_ARTIFACTS.get(race.artifact_key);
  if (!artifact) {
    throw new HttpError(404, 'Race artifact object not found.');
  }

  return new Response(artifact.body, {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'application/x-sqlite3',
      'X-Race-Key': raceKey,
      'X-Artifact-Sha256': race.artifact_sha256,
    },
  });
}

async function handleRacePush(request, env, cors) {
  const claims = await authenticate(request, env, 'races:write');
  const workspaceId = workspaceFromClaims(claims);
  const tokenJti = stringValue(claims.jti);
  if (!tokenJti) {
    throw new HttpError(403, 'Race write tokens must include a jti claim.');
  }

  const clientId = stringValue(request.headers.get('x-client-id'));
  const clientRequestId = stringValue(
    request.headers.get('x-client-request-id'),
  );
  const raceKey = stringValue(request.headers.get('x-race-key'));
  const name = stringValue(request.headers.get('x-race-name'));
  const sourceFileName = stringValue(request.headers.get('x-source-file-name'));
  const contentHash = stringValue(request.headers.get('x-content-hash'));
  const rowCount = Math.max(
    0,
    Math.trunc(numberValueHeader(request.headers.get('x-row-count'))),
  );
  const raceStartTime =
    stringValue(request.headers.get('x-race-start-time')) || null;

  validateRacePushMetadata({
    claims,
    clientId,
    clientRequestId,
    raceKey,
    name,
    sourceFileName,
    contentHash,
    rowCount,
    raceStartTime,
  });

  const existing = await env.DB.prepare(
    `
      SELECT client_request_id, server_sequence, kind, action, annotation_id
      FROM sync_requests
      WHERE workspace_id = ? AND client_request_id = ?
    `,
  )
    .bind(workspaceId, clientRequestId)
    .first();
  if (existing) {
    if (
      existing.kind !== 'race' ||
      existing.action !== 'upsert' ||
      existing.annotation_id !== raceKey
    ) {
      throw new HttpError(
        409,
        'clientRequestId was already used for a different mutation.',
      );
    }

    const race = await env.DB.prepare(
      `
        SELECT artifact_sha256, artifact_size_bytes
        FROM workspace_races
        WHERE workspace_id = ? AND race_key = ?
      `,
    )
      .bind(workspaceId, raceKey)
      .first();
    const currentSequence = await getCurrentSequence(env, workspaceId);
    return json(
      {
        currentSequence,
        accepted: {
          clientRequestId,
          serverSequence: existing.server_sequence,
          artifactSha256: race?.artifact_sha256 || '',
          artifactSizeBytes: race?.artifact_size_bytes || 0,
        },
      },
      200,
      cors,
    );
  }

  const artifactBytes = await readLimitedArrayBuffer(
    request,
    raceArtifactMaxBytes(env),
  );
  if (!artifactBytes.byteLength) {
    throw new HttpError(400, 'Race artifact body is empty.');
  }
  validateSqliteArtifactBytes(artifactBytes);

  const artifactSha256 = await sha256Hex(artifactBytes);
  const retainedVersions = raceArtifactRetainedVersions(env);
  const projectedStorageBytes = await projectedWorkspaceRaceStorageBytes(
    env,
    workspaceId,
    raceKey,
    artifactBytes.byteLength,
    retainedVersions,
  );
  if (projectedStorageBytes > raceWorkspaceStorageQuotaBytes(env)) {
    throw new HttpError(413, 'Race artifact workspace storage quota exceeded.');
  }

  await reserveRaceUploadSlots(env, workspaceId, tokenJti);

  const sequenceRow = await env.DB.prepare(
    `
      UPDATE sync_sequences
      SET value = value + 1
      WHERE workspace_id = ?
      RETURNING value
    `,
  )
    .bind(workspaceId)
    .first();
  const serverSequence = sequenceRow?.value;
  if (!serverSequence) {
    throw new HttpError(500, 'Unable to allocate race sync sequence.');
  }

  const artifactKey = `race-versions/${workspaceId}/${raceKey}/${serverSequence}.sqlite`;
  const latestKey = `races/${workspaceId}/${raceKey}/latest.sqlite`;
  const now = new Date().toISOString();
  let wroteVersionedArtifact = false;

  try {
    await env.RACE_ARTIFACTS.put(artifactKey, artifactBytes, {
      httpMetadata: { contentType: 'application/x-sqlite3' },
    });
    wroteVersionedArtifact = true;

    await env.DB.batch([
      env.DB.prepare(
        `
          INSERT INTO workspace_races (
            workspace_id, race_key, name, source_file_name, content_hash,
            race_start_time, row_count, artifact_key, artifact_sha256,
            artifact_size_bytes, server_sequence, created_by, updated_by,
            created_at, updated_at, deleted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
          ON CONFLICT(workspace_id, race_key) DO UPDATE SET
            name = excluded.name,
            source_file_name = excluded.source_file_name,
            content_hash = excluded.content_hash,
            race_start_time = excluded.race_start_time,
            row_count = excluded.row_count,
            artifact_key = excluded.artifact_key,
            artifact_sha256 = excluded.artifact_sha256,
            artifact_size_bytes = excluded.artifact_size_bytes,
            server_sequence = excluded.server_sequence,
            created_by = COALESCE(workspace_races.created_by, excluded.created_by),
            updated_by = excluded.updated_by,
            updated_at = excluded.updated_at,
            deleted_at = NULL
        `,
      ).bind(
        workspaceId,
        raceKey,
        name,
        sourceFileName,
        contentHash,
        raceStartTime,
        rowCount,
        artifactKey,
        artifactSha256,
        artifactBytes.byteLength,
        serverSequence,
        claims.sub,
        claims.sub,
        now,
        now,
      ),
      env.DB.prepare(
        `
          INSERT INTO race_artifact_versions (
            workspace_id, race_key, server_sequence, artifact_key,
            artifact_sha256, artifact_size_bytes, created_by, created_at,
            deleted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
        `,
      ).bind(
        workspaceId,
        raceKey,
        serverSequence,
        artifactKey,
        artifactSha256,
        artifactBytes.byteLength,
        claims.sub,
        now,
      ),
      env.DB.prepare(
        `
          INSERT INTO sync_requests (
            workspace_id, client_request_id, client_id, server_sequence,
            kind, action, annotation_id, accepted_at
          ) VALUES (?, ?, ?, ?, 'race', 'upsert', ?, ?)
        `,
      ).bind(
        workspaceId,
        clientRequestId,
        clientId,
        serverSequence,
        raceKey,
        now,
      ),
    ]);
  } catch (error) {
    if (wroteVersionedArtifact) {
      await deleteR2Object(env, artifactKey);
    }
    throw error;
  }

  try {
    await env.RACE_ARTIFACTS.put(latestKey, artifactBytes, {
      httpMetadata: { contentType: 'application/x-sqlite3' },
    });
    await env.DB.prepare(
      `
        UPDATE workspace_races
        SET artifact_key = ?
        WHERE workspace_id = ? AND race_key = ? AND server_sequence = ?
      `,
    )
      .bind(latestKey, workspaceId, raceKey, serverSequence)
      .run();
  } catch (error) {
    console.error('Failed to update latest race artifact object.', error);
  }

  await pruneRaceArtifactVersions(env, workspaceId, raceKey, retainedVersions);

  const currentSequence = await getCurrentSequence(env, workspaceId);
  return json(
    {
      currentSequence,
      accepted: {
        clientRequestId,
        serverSequence,
        artifactSha256,
        artifactSizeBytes: artifactBytes.byteLength,
      },
    },
    200,
    cors,
  );
}

async function handleMediaUpload(request, env, cors) {
  const claims = await authenticate(request, env, 'media:write');
  const workspaceId = workspaceFromClaims(claims);
  const tokenJti = stringValue(claims.jti);
  if (!tokenJti) {
    throw new HttpError(403, 'Media write tokens must include a jti claim.');
  }
  if (!env.MEDIA_PHOTOS) {
    throw new HttpError(500, 'MEDIA_PHOTOS is not configured.');
  }

  const contentLength = numberValueHeader(
    request.headers.get('content-length'),
  );
  if (contentLength > mediaUploadMaxBytes(env)) {
    throw new HttpError(413, 'Media upload is too large.');
  }

  let formData;
  try {
    formData = await request.formData();
  } catch {
    throw new HttpError(400, 'Media upload must be multipart form data.');
  }

  const metadata = parseMediaUploadMetadata(formData.get('metadata'));
  validateMediaUploadMetadata(metadata, claims);

  const existing = await env.DB.prepare(
    `
      SELECT *
      FROM media_assets
      WHERE workspace_id = ? AND client_request_id = ?
      LIMIT 1
    `,
  )
    .bind(workspaceId, metadata.clientRequestId)
    .first();
  if (existing) {
    if (
      existing.asset_id !== metadata.assetId ||
      existing.race_key !== metadata.raceKey ||
      existing.source_sha256 !== metadata.sourceSha256
    ) {
      throw new HttpError(
        409,
        'clientRequestId was already used for a different media upload.',
      );
    }

    return json({ asset: mediaAssetRowToResponse(existing) }, 200, cors);
  }

  const variants = [];
  let totalSizeBytes = 0;
  for (const variantName of MEDIA_VARIANT_NAMES) {
    const file = formData.get(variantName);
    const variant = metadata.variants[variantName] || {};
    const mediaFile = await readMediaVariantFile(
      file,
      variantName,
      mediaVariantMaxBytes(env),
    );
    const extension = MEDIA_CONTENT_TYPES.get(mediaFile.contentType);
    const objectKey = `photos/${workspaceId}/${metadata.raceKey}/${metadata.assetId}/${variantName}.${extension}`;
    totalSizeBytes += mediaFile.bytes.byteLength;

    variants.push({
      name: variantName,
      objectKey,
      width: positiveInteger(variant.width),
      height: positiveInteger(variant.height),
      byteSize: mediaFile.bytes.byteLength,
      contentType: mediaFile.contentType,
      bytes: mediaFile.bytes,
    });
  }

  if (totalSizeBytes > mediaUploadMaxBytes(env)) {
    throw new HttpError(413, 'Media upload is too large.');
  }

  const projectedStorageBytes =
    (await currentWorkspaceMediaStorageBytes(env, workspaceId)) +
    totalSizeBytes;
  if (projectedStorageBytes > mediaWorkspaceStorageQuotaBytes(env)) {
    throw new HttpError(413, 'Media workspace storage quota exceeded.');
  }

  await reserveMediaUploadSlots(env, workspaceId, tokenJti);

  const now = new Date().toISOString();
  const responseVariants = variants.map(
    ({ bytes: _bytes, ...variant }) => variant,
  );
  const wroteKeys = [];

  try {
    for (const variant of variants) {
      await env.MEDIA_PHOTOS.put(variant.objectKey, variant.bytes, {
        httpMetadata: {
          contentType: variant.contentType,
          cacheControl: 'public, max-age=31536000, immutable',
        },
      });
      wroteKeys.push(variant.objectKey);
    }

    await env.DB.prepare(
      `
        INSERT INTO media_assets (
          workspace_id, asset_id, client_request_id, race_key,
          original_file_name, source_sha256, variants_json,
          total_size_bytes, created_by, created_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `,
    )
      .bind(
        workspaceId,
        metadata.assetId,
        metadata.clientRequestId,
        metadata.raceKey,
        metadata.originalFileName,
        metadata.sourceSha256,
        JSON.stringify(responseVariants),
        totalSizeBytes,
        claims.sub,
        now,
      )
      .run();
  } catch (error) {
    await Promise.all(wroteKeys.map((key) => deleteMediaObject(env, key)));
    throw error;
  }

  return json(
    {
      asset: {
        assetId: metadata.assetId,
        raceKey: metadata.raceKey,
        originalFileName: metadata.originalFileName,
        sourceSha256: metadata.sourceSha256,
        createdBy: claims.sub,
        createdAt: now,
        variants: responseVariants,
      },
    },
    200,
    cors,
  );
}

async function handlePull(request, env, cors) {
  const claims = await authenticate(request, env, 'annotations:read');
  const workspaceId = workspaceFromClaims(claims);
  const body = await readJson(request);
  const raceCursors = Array.isArray(body.raceCursors) ? body.raceCursors : [];
  const limit = Math.min(
    Math.max(Math.trunc(numberValue(body.limit) || MAX_PULL_LIMIT), 1),
    MAX_PULL_LIMIT,
  );
  const mutations = [];

  for (const cursor of raceCursors) {
    const raceKey = stringValue(cursor.raceKey);
    const since = Math.max(0, Math.trunc(numberValue(cursor.since) || 0));
    if (!raceKey || !raceAllowed(claims, raceKey)) {
      continue;
    }

    for (const [kind, config] of Object.entries(KIND_CONFIG)) {
      const rows = await env.DB.prepare(
        `
          SELECT *
          FROM ${config.table}
          WHERE workspace_id = ? AND race_key = ? AND server_sequence > ?
          ORDER BY server_sequence ASC
          LIMIT ?
        `,
      )
        .bind(workspaceId, raceKey, since, limit)
        .all();

      for (const row of rows.results || []) {
        const mutation = rowToPulledMutation(kind, config, row);
        await attachMediaJsonToPulledMutation(env, workspaceId, mutation);
        mutations.push(mutation);
      }
    }
  }

  mutations.sort((left, right) => left.serverSequence - right.serverSequence);
  const currentSequence = await getCurrentSequence(env, workspaceId);

  return json(
    {
      currentSequence,
      mutations: mutations.slice(0, limit),
    },
    200,
    cors,
  );
}

async function handlePush(request, env, cors) {
  const claims = await authenticate(request, env, 'annotations:write');
  const workspaceId = workspaceFromClaims(claims);
  const body = await readJson(request);
  const clientId = stringValue(body.clientId);
  const mutations = Array.isArray(body.mutations) ? body.mutations : [];

  if (!clientId) {
    throw new HttpError(400, 'Missing clientId.');
  }
  if (mutations.length > MAX_PUSH_MUTATIONS) {
    throw new HttpError(
      400,
      `Push batches are limited to ${MAX_PUSH_MUTATIONS} mutations.`,
    );
  }

  const accepted = [];
  const newMutations = [];

  for (const mutation of mutations) {
    validateMutationShape(mutation, claims, workspaceId);
    const existing = await env.DB.prepare(
      `
        SELECT client_request_id, server_sequence
        FROM sync_requests
        WHERE workspace_id = ? AND client_request_id = ?
      `,
    )
      .bind(workspaceId, mutation.clientRequestId)
      .first();

    if (existing) {
      accepted.push({
        clientRequestId: existing.client_request_id,
        serverSequence: existing.server_sequence,
      });
    } else {
      newMutations.push(mutation);
    }
  }

  if (newMutations.length) {
    const statements = [];
    const acceptedAt = new Date().toISOString();

    for (const mutation of newMutations) {
      statements.push(
        env.DB.prepare(
          'UPDATE sync_sequences SET value = value + 1 WHERE workspace_id = ?',
        ).bind(workspaceId),
      );
      statements.push(
        buildAnnotationStatement(
          env,
          workspaceId,
          claims.sub,
          mutation,
          acceptedAt,
        ),
      );
      const mediaStatement = buildAnnotationMediaStatement(
        env,
        workspaceId,
        mutation,
        acceptedAt,
      );
      if (mediaStatement) {
        statements.push(mediaStatement);
      }
      statements.push(
        env.DB.prepare(
          `
            INSERT INTO sync_requests (
              workspace_id, client_request_id, client_id, server_sequence,
              kind, action, annotation_id, accepted_at
            ) VALUES (
              ?, ?, ?, (SELECT value FROM sync_sequences WHERE workspace_id = ?),
              ?, ?, ?, ?
            )
          `,
        ).bind(
          workspaceId,
          mutation.clientRequestId,
          clientId,
          workspaceId,
          mutation.kind,
          mutation.action,
          mutation.annotationId,
          acceptedAt,
        ),
      );
    }

    await env.DB.batch(statements);

    for (const mutation of newMutations) {
      const row = await env.DB.prepare(
        `
          SELECT client_request_id, server_sequence
          FROM sync_requests
          WHERE workspace_id = ? AND client_request_id = ?
        `,
      )
        .bind(workspaceId, mutation.clientRequestId)
        .first();
      accepted.push({
        clientRequestId: row.client_request_id,
        serverSequence: row.server_sequence,
      });
    }
  }

  const currentSequence = await getCurrentSequence(env, workspaceId);
  return json({ currentSequence, accepted }, 200, cors);
}

function buildAnnotationStatement(env, workspaceId, subject, mutation, now) {
  const config = KIND_CONFIG[mutation.kind];

  if (mutation.action === 'delete') {
    return env.DB.prepare(
      `
        INSERT INTO ${config.table} (
          workspace_id, race_key, annotation_id, created_at, updated_at,
          created_by, updated_by, server_sequence, deleted_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?,
          (SELECT value FROM sync_sequences WHERE workspace_id = ?), ?
        )
        ON CONFLICT(workspace_id, annotation_id) DO UPDATE SET
          race_key = excluded.race_key,
          updated_at = excluded.updated_at,
          updated_by = excluded.updated_by,
          server_sequence = excluded.server_sequence,
          deleted_at = excluded.deleted_at
      `,
    ).bind(
      workspaceId,
      mutation.raceKey,
      mutation.annotationId,
      now,
      now,
      subject,
      subject,
      workspaceId,
      now,
    );
  }

  const payload = mutation.payload || {};
  const fieldValues = config.fields.map((field) =>
    field === 'created_at' || field === 'updated_at'
      ? stringValue(payload[field]) || now
      : nullableValue(payload[field]),
  );
  const insertColumns = [
    'workspace_id',
    'race_key',
    'annotation_id',
    ...config.fields,
    'created_by',
    'updated_by',
    'server_sequence',
    'deleted_at',
  ];
  const placeholders = insertColumns.map(() => '?');
  placeholders[insertColumns.indexOf('server_sequence')] =
    '(SELECT value FROM sync_sequences WHERE workspace_id = ?)';
  const updateFields = config.fields.filter((field) => field !== 'created_at');

  return env.DB.prepare(
    `
      INSERT INTO ${config.table} (${insertColumns.join(', ')})
      VALUES (${placeholders.join(', ')})
      ON CONFLICT(workspace_id, annotation_id) DO UPDATE SET
        race_key = excluded.race_key,
        ${updateFields.map((field) => `${field} = excluded.${field}`).join(', ')},
        created_at = COALESCE(${config.table}.created_at, excluded.created_at),
        created_by = COALESCE(${config.table}.created_by, excluded.created_by),
        updated_by = excluded.updated_by,
        server_sequence = excluded.server_sequence,
        deleted_at = NULL
    `,
  ).bind(
    workspaceId,
    mutation.raceKey,
    mutation.annotationId,
    ...fieldValues,
    subject,
    subject,
    workspaceId,
    null,
  );
}

function buildAnnotationMediaStatement(env, workspaceId, mutation, now) {
  if (!annotationSupportsMedia(mutation.kind)) {
    return null;
  }

  if (mutation.action === 'delete') {
    return env.DB.prepare(
      `
        DELETE FROM annotation_media
        WHERE workspace_id = ? AND kind = ? AND annotation_id = ?
      `,
    ).bind(workspaceId, mutation.kind, mutation.annotationId);
  }

  const mediaJson = validateMediaJsonPayload(
    mutation.kind,
    mutation.payload?.media_json,
    {
      workspaceId,
      raceKey: mutation.raceKey,
    },
  );

  return env.DB.prepare(
    `
      INSERT INTO annotation_media (
        workspace_id, race_key, kind, annotation_id, media_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, kind, annotation_id) DO UPDATE SET
        race_key = excluded.race_key,
        media_json = excluded.media_json,
        updated_at = excluded.updated_at
    `,
  ).bind(
    workspaceId,
    mutation.raceKey,
    mutation.kind,
    mutation.annotationId,
    mediaJson,
    now,
  );
}

async function attachMediaJsonToPulledMutation(env, workspaceId, mutation) {
  if (mutation.action === 'delete' || !annotationSupportsMedia(mutation.kind)) {
    return;
  }

  const row = await env.DB.prepare(
    `
      SELECT media_json
      FROM annotation_media
      WHERE workspace_id = ? AND kind = ? AND annotation_id = ?
      LIMIT 1
    `,
  )
    .bind(workspaceId, mutation.kind, mutation.annotationId)
    .first();

  mutation.payload.media_json = row?.media_json || '[]';
}

function rowToPulledMutation(kind, config, row) {
  const isDeleted = Boolean(row.deleted_at);
  const payload = { id: row.annotation_id };

  if (!isDeleted) {
    for (const field of config.fields) {
      payload[field] = row[field] ?? null;
    }
  }

  return {
    serverSequence: row.server_sequence,
    submittedAt: row.deleted_at || row.updated_at,
    submittedBy: row.updated_by,
    raceKey: row.race_key,
    kind,
    action: isDeleted ? 'delete' : 'upsert',
    annotationId: row.annotation_id,
    payload,
  };
}

function validateMutationShape(mutation, claims, workspaceId) {
  const config = KIND_CONFIG[mutation.kind];
  if (!config) {
    throw new HttpError(400, 'Invalid mutation kind.');
  }
  if (mutation.action !== 'upsert' && mutation.action !== 'delete') {
    throw new HttpError(400, 'Invalid mutation action.');
  }
  if (!stringValue(mutation.clientRequestId)) {
    throw new HttpError(400, 'Missing clientRequestId.');
  }
  if (!stringValue(mutation.raceKey)) {
    throw new HttpError(400, 'Missing raceKey.');
  }
  if (!raceAllowed(claims, mutation.raceKey)) {
    throw new HttpError(403, 'Token is not allowed to edit this race.');
  }
  if (!stringValue(mutation.annotationId)) {
    throw new HttpError(400, 'Missing annotationId.');
  }

  if (mutation.action === 'delete') {
    return;
  }

  const payload = mutation.payload || {};
  for (const field of config.required) {
    const value = payload[field];
    if (value == null || value === '') {
      throw new HttpError(400, `Missing required ${field}.`);
    }
  }

  for (const field of ['lap_number', 'start_lap', 'end_lap']) {
    if (
      payload[field] != null &&
      (!Number.isInteger(numberValue(payload[field])) ||
        numberValue(payload[field]) < 1)
    ) {
      throw new HttpError(400, `${field} must be a positive whole number.`);
    }
  }

  if (
    (mutation.kind === 'rangeEvent' || mutation.kind === 'driverStint') &&
    numberValue(payload.end_lap) < numberValue(payload.start_lap)
  ) {
    throw new HttpError(
      400,
      'End lap must be greater than or equal to start lap.',
    );
  }

  if (mutation.kind === 'journalEntry') {
    const hasLap =
      typeof payload.lap_number === 'number' &&
      Number.isInteger(payload.lap_number) &&
      payload.lap_number > 0;
    const hasTime = Boolean(stringValue(payload.event_time_iso));
    if (!hasLap && !hasTime) {
      throw new HttpError(400, 'Journal entries require a lap or timestamp.');
    }
  }

  if (annotationSupportsMedia(mutation.kind)) {
    validateMediaJsonPayload(mutation.kind, payload.media_json, {
      workspaceId,
      raceKey: mutation.raceKey,
    });
  } else if (payload.media_json != null && payload.media_json !== '') {
    throw new HttpError(
      400,
      'Media attachments are not allowed for this kind.',
    );
  }
}

function annotationSupportsMedia(kind) {
  return kind === 'taggedIncident' || kind === 'journalEntry';
}

function validateMediaJsonPayload(kind, value, context = null) {
  if (!annotationSupportsMedia(kind)) {
    return '[]';
  }

  if (value == null || value === '') {
    return '[]';
  }

  if (typeof value !== 'string') {
    throw new HttpError(400, 'media_json must be a JSON string.');
  }

  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new HttpError(400, 'media_json must be valid JSON.');
  }

  if (!Array.isArray(parsed)) {
    throw new HttpError(400, 'media_json must be an array.');
  }
  if (parsed.length > 4) {
    throw new HttpError(400, 'A record can include at most 4 images.');
  }

  const normalized = parsed.map((item) =>
    validateMediaAttachmentShape(item, context),
  );
  return JSON.stringify(normalized);
}

function validateMediaAttachmentShape(item, context) {
  if (!item || typeof item !== 'object') {
    throw new HttpError(400, 'Invalid media attachment.');
  }

  const assetId = stringValue(item.assetId);
  if (!ASSET_ID_PATTERN.test(assetId)) {
    throw new HttpError(400, 'Invalid media asset id.');
  }

  const variants = Array.isArray(item.variants) ? item.variants : [];
  if (!variants.length) {
    throw new HttpError(400, 'Media attachment is missing variants.');
  }

  const expectedPrefix =
    context?.workspaceId && context?.raceKey
      ? `photos/${context.workspaceId}/${context.raceKey}/${assetId}/`
      : '';

  return {
    assetId,
    originalFileName: stringValue(item.originalFileName).slice(0, 240),
    sourceSha256: stringValue(item.sourceSha256),
    createdBy: stringValue(item.createdBy),
    createdAt: stringValue(item.createdAt),
    caption: stringValue(item.caption).slice(0, 240),
    altText: stringValue(item.altText).slice(0, 240),
    variants: variants.map((variant) =>
      validateMediaVariantShape(variant, expectedPrefix),
    ),
  };
}

function validateMediaVariantShape(variant, expectedPrefix) {
  const name = stringValue(variant?.name);
  const objectKey = stringValue(variant?.objectKey).replace(/^\/+/, '');
  const contentType = normalizeMediaContentType(variant?.contentType);
  const extension = MEDIA_CONTENT_TYPES.get(contentType);

  if (!MEDIA_VARIANT_NAMES.includes(name)) {
    throw new HttpError(400, 'Invalid media variant name.');
  }
  if (!extension) {
    throw new HttpError(400, 'Invalid media variant content type.');
  }
  if (expectedPrefix && objectKey !== `${expectedPrefix}${name}.${extension}`) {
    throw new HttpError(400, 'Invalid media variant object key.');
  }

  return {
    name,
    objectKey,
    width: positiveInteger(variant?.width),
    height: positiveInteger(variant?.height),
    byteSize: positiveInteger(variant?.byteSize),
    contentType,
  };
}

function parseMediaUploadMetadata(value) {
  if (typeof value !== 'string') {
    throw new HttpError(400, 'Missing media metadata.');
  }

  try {
    return JSON.parse(value);
  } catch {
    throw new HttpError(400, 'Media metadata must be JSON.');
  }
}

function validateMediaUploadMetadata(metadata, claims) {
  const clientId = stringValue(metadata.clientId);
  const clientRequestId = stringValue(metadata.clientRequestId);
  const raceKey = stringValue(metadata.raceKey);
  const assetId = stringValue(metadata.assetId);
  const originalFileName = stringValue(metadata.originalFileName);
  const sourceSha256 = stringValue(metadata.sourceSha256);

  if (!clientId || !clientRequestId) {
    throw new HttpError(400, 'Missing media upload client ids.');
  }
  if (clientId.length > 128 || clientRequestId.length > 128) {
    throw new HttpError(400, 'Media upload client ids are too long.');
  }
  if (!raceKey || !raceAllowed(claims, raceKey)) {
    throw new HttpError(
      403,
      'Token is not allowed to upload media for this race.',
    );
  }
  if (!ASSET_ID_PATTERN.test(assetId)) {
    throw new HttpError(400, 'Invalid media asset id.');
  }
  if (!originalFileName || originalFileName.length > 240) {
    throw new HttpError(400, 'Invalid original file name.');
  }
  if (!SHA256_PATTERN.test(sourceSha256)) {
    throw new HttpError(400, 'Invalid source image hash.');
  }

  metadata.clientId = clientId;
  metadata.clientRequestId = clientRequestId;
  metadata.raceKey = raceKey;
  metadata.assetId = assetId;
  metadata.originalFileName = originalFileName;
  metadata.sourceSha256 = sourceSha256;
  metadata.variants =
    metadata.variants && typeof metadata.variants === 'object'
      ? metadata.variants
      : {};
}

async function readMediaVariantFile(value, variantName, maxBytes) {
  if (!value || typeof value.arrayBuffer !== 'function') {
    throw new HttpError(400, `Missing ${variantName} media variant.`);
  }

  const contentType = normalizeMediaContentType(value.type);
  if (!MEDIA_CONTENT_TYPES.has(contentType)) {
    throw new HttpError(400, `Unsupported ${variantName} media content type.`);
  }

  if (Number(value.size || 0) > maxBytes) {
    throw new HttpError(413, `${variantName} media variant is too large.`);
  }

  const bytes = await value.arrayBuffer();
  if (!bytes.byteLength) {
    throw new HttpError(400, `${variantName} media variant is empty.`);
  }
  if (bytes.byteLength > maxBytes) {
    throw new HttpError(413, `${variantName} media variant is too large.`);
  }

  return { bytes, contentType };
}

function normalizeMediaContentType(value) {
  const contentType = stringValue(value).toLowerCase();
  return contentType === 'image/jpg' ? 'image/jpeg' : contentType;
}

async function currentWorkspaceMediaStorageBytes(env, workspaceId) {
  const row = await env.DB.prepare(
    `
      SELECT COALESCE(SUM(total_size_bytes), 0) AS total
      FROM media_assets
      WHERE workspace_id = ? AND deleted_at IS NULL
    `,
  )
    .bind(workspaceId)
    .first();
  return Number(row?.total || 0);
}

async function reserveMediaUploadSlots(env, workspaceId, tokenJti) {
  const windowStart = `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
  const now = new Date().toISOString();

  await reserveMediaUploadCounter(
    env,
    workspaceId,
    'token',
    tokenJti,
    windowStart,
    mediaUploadsPerTokenPerDay(env),
    now,
    'Token media upload limit exceeded.',
  );
  await reserveMediaUploadCounter(
    env,
    workspaceId,
    'workspace',
    workspaceId,
    windowStart,
    mediaUploadsPerWorkspacePerDay(env),
    now,
    'Workspace media upload limit exceeded.',
  );
}

async function reserveMediaUploadCounter(
  env,
  workspaceId,
  bucketType,
  bucketKey,
  windowStart,
  limit,
  now,
  message,
) {
  const row = await env.DB.prepare(
    `
      INSERT INTO media_upload_counters (
        workspace_id, bucket_type, bucket_key, window_start, count, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(workspace_id, bucket_type, bucket_key, window_start)
      DO UPDATE SET
        count = count + 1,
        updated_at = excluded.updated_at
      WHERE count < ?
      RETURNING count
    `,
  )
    .bind(workspaceId, bucketType, bucketKey, windowStart, now, limit)
    .first();

  if (!row) {
    throw new HttpError(429, message);
  }
}

function mediaAssetRowToResponse(row) {
  return {
    assetId: row.asset_id,
    raceKey: row.race_key,
    originalFileName: row.original_file_name,
    sourceSha256: row.source_sha256,
    createdBy: row.created_by,
    createdAt: row.created_at,
    variants: parseJsonArray(row.variants_json),
  };
}

async function deleteMediaObject(env, key) {
  try {
    await env.MEDIA_PHOTOS.delete(key);
  } catch (error) {
    console.error('Failed to delete media object during cleanup.', error);
  }
}

function validateRacePushMetadata({
  claims,
  clientId,
  clientRequestId,
  raceKey,
  name,
  sourceFileName,
  contentHash,
  rowCount,
  raceStartTime,
}) {
  if (!clientId || !clientRequestId) {
    throw new HttpError(400, 'Missing race push client headers.');
  }
  if (clientId.length > 128 || clientRequestId.length > 128) {
    throw new HttpError(400, 'Race push client headers are too long.');
  }
  if (!contentHash || !CONTENT_HASH_PATTERN.test(contentHash)) {
    throw new HttpError(400, 'Invalid race content hash.');
  }
  if (!raceKey || !RACE_KEY_PATTERN.test(raceKey)) {
    throw new HttpError(400, 'Invalid race key.');
  }
  if (raceKey !== `race-${contentHash}`) {
    throw new HttpError(400, 'Race key does not match content hash.');
  }
  if (!raceAllowed(claims, raceKey)) {
    throw new HttpError(403, 'Token is not allowed to write this race.');
  }
  if (!name || !sourceFileName) {
    throw new HttpError(400, 'Missing race metadata headers.');
  }
  if (name.length > 200 || sourceFileName.length > 240) {
    throw new HttpError(400, 'Race metadata headers are too long.');
  }
  if (rowCount > 1000000) {
    throw new HttpError(400, 'Race row count is too large.');
  }
  if (raceStartTime && raceStartTime.length > 64) {
    throw new HttpError(400, 'Race start time header is too long.');
  }
}

async function readLimitedArrayBuffer(request, maxBytes) {
  const contentLength = numberValueHeader(
    request.headers.get('content-length'),
  );
  if (contentLength > maxBytes) {
    throw new HttpError(413, 'Race artifact is too large.');
  }
  if (!request.body) {
    return new ArrayBuffer(0);
  }

  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The response should still be a deterministic 413 even if the stream
          // cannot be cancelled cleanly.
        }
        throw new HttpError(413, 'Race artifact is too large.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

function validateSqliteArtifactBytes(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength < SQLITE_HEADER_BYTES.length) {
    throw new HttpError(400, 'Race artifact is not a SQLite database.');
  }

  for (let index = 0; index < SQLITE_HEADER_BYTES.length; index += 1) {
    if (bytes[index] !== SQLITE_HEADER_BYTES[index]) {
      throw new HttpError(400, 'Race artifact is not a SQLite database.');
    }
  }
}

async function projectedWorkspaceRaceStorageBytes(
  env,
  workspaceId,
  raceKey,
  newArtifactSizeBytes,
  retainedVersions,
) {
  const totals = await env.DB.prepare(
    `
      SELECT
        COALESCE((
          SELECT SUM(artifact_size_bytes)
          FROM race_artifact_versions
          WHERE workspace_id = ? AND deleted_at IS NULL
        ), 0) AS version_bytes,
        COALESCE((
          SELECT SUM(artifact_size_bytes)
          FROM workspace_races
          WHERE workspace_id = ? AND deleted_at IS NULL
        ), 0) AS latest_bytes
    `,
  )
    .bind(workspaceId, workspaceId)
    .first();
  const existingRace = await env.DB.prepare(
    `
      SELECT artifact_size_bytes
      FROM workspace_races
      WHERE workspace_id = ? AND race_key = ? AND deleted_at IS NULL
    `,
  )
    .bind(workspaceId, raceKey)
    .first();
  const activeVersions = await listActiveRaceArtifactVersions(
    env,
    workspaceId,
    raceKey,
  );
  const oldLatestSize = Number(existingRace?.artifact_size_bytes || 0);
  const retainedOldVersionCount = Math.max(0, retainedVersions - 1);
  const prunedVersionBytes = activeVersions
    .slice(retainedOldVersionCount)
    .reduce((total, row) => total + Number(row.artifact_size_bytes || 0), 0);

  return (
    Number(totals?.version_bytes || 0) +
    newArtifactSizeBytes -
    prunedVersionBytes +
    Number(totals?.latest_bytes || 0) -
    oldLatestSize +
    newArtifactSizeBytes
  );
}

async function reserveRaceUploadSlots(env, workspaceId, tokenJti) {
  const windowStart = `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
  const now = new Date().toISOString();

  await reserveRaceUploadCounter(
    env,
    workspaceId,
    'token',
    tokenJti,
    windowStart,
    raceUploadsPerTokenPerDay(env),
    now,
    'Token race upload limit exceeded.',
  );
  await reserveRaceUploadCounter(
    env,
    workspaceId,
    'workspace',
    workspaceId,
    windowStart,
    raceUploadsPerWorkspacePerDay(env),
    now,
    'Workspace race upload limit exceeded.',
  );
}

async function reserveRaceUploadCounter(
  env,
  workspaceId,
  bucketType,
  bucketKey,
  windowStart,
  limit,
  now,
  message,
) {
  const row = await env.DB.prepare(
    `
      INSERT INTO race_upload_counters (
        workspace_id, bucket_type, bucket_key, window_start, count, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(workspace_id, bucket_type, bucket_key, window_start)
      DO UPDATE SET
        count = count + 1,
        updated_at = excluded.updated_at
      WHERE count < ?
      RETURNING count
    `,
  )
    .bind(workspaceId, bucketType, bucketKey, windowStart, now, limit)
    .first();

  if (!row) {
    throw new HttpError(429, message);
  }
}

async function listActiveRaceArtifactVersions(env, workspaceId, raceKey) {
  const rows = await env.DB.prepare(
    `
      SELECT server_sequence, artifact_key, artifact_size_bytes
      FROM race_artifact_versions
      WHERE workspace_id = ? AND race_key = ? AND deleted_at IS NULL
      ORDER BY server_sequence DESC
    `,
  )
    .bind(workspaceId, raceKey)
    .all();
  return rows.results || [];
}

async function pruneRaceArtifactVersions(
  env,
  workspaceId,
  raceKey,
  retainedVersions,
) {
  const activeVersions = await listActiveRaceArtifactVersions(
    env,
    workspaceId,
    raceKey,
  );
  const staleVersions = activeVersions.slice(retainedVersions);
  if (!staleVersions.length) {
    return;
  }

  const deletedAt = new Date().toISOString();
  for (const version of staleVersions) {
    try {
      await env.RACE_ARTIFACTS.delete(version.artifact_key);
      await env.DB.prepare(
        `
          UPDATE race_artifact_versions
          SET deleted_at = ?
          WHERE workspace_id = ? AND race_key = ? AND server_sequence = ?
        `,
      )
        .bind(deletedAt, workspaceId, raceKey, version.server_sequence)
        .run();
    } catch (error) {
      console.error('Failed to prune old race artifact version.', error);
    }
  }
}

async function deleteR2Object(env, key) {
  try {
    await env.RACE_ARTIFACTS.delete(key);
  } catch (error) {
    console.error('Failed to delete R2 object during cleanup.', error);
  }
}

async function authenticate(request, env, requiredScope) {
  const claims = await authenticateToken(request, env);

  if (!arrayValue(claims.scope).includes(requiredScope)) {
    throw new HttpError(403, 'Token does not have the required scope.');
  }

  return claims;
}

async function authenticateAny(request, env, requiredScopes) {
  const claims = await authenticateToken(request, env);
  const scopes = arrayValue(claims.scope);

  if (!requiredScopes.some((scope) => scopes.includes(scope))) {
    throw new HttpError(403, 'Token does not have the required scope.');
  }

  return claims;
}

async function authenticateToken(request, env) {
  const header = request.headers.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw new HttpError(401, 'Missing bearer token.');
  }

  const claims = await verifyCapabilityToken(match[1], env);
  await ensureTokenAllowed(env, claims);

  return claims;
}

async function ensureTokenAllowed(env, claims) {
  const workspaceId = workspaceFromClaims(claims);
  const revoked = claims.jti
    ? await env.DB.prepare(
        'SELECT jti FROM capability_revocations WHERE workspace_id = ? AND jti = ?',
      )
        .bind(workspaceId, claims.jti)
        .first()
    : null;

  if (revoked) {
    throw new HttpError(403, 'Token has been revoked.');
  }
}

async function verifyCapabilityToken(token, env) {
  if (!env.TOKEN_SIGNING_SECRET) {
    throw new HttpError(500, 'TOKEN_SIGNING_SECRET is not configured.');
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new HttpError(401, 'Invalid token format.');
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const signedBytes = new TextEncoder().encode(
    `${encodedHeader}.${encodedPayload}`,
  );
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.TOKEN_SIGNING_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const expected = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, signedBytes),
  );
  const actual = base64UrlToBytes(encodedSignature);
  if (!constantTimeEqual(expected, actual)) {
    throw new HttpError(401, 'Invalid token signature.');
  }

  const header = JSON.parse(base64UrlDecode(encodedHeader));
  if (header.alg !== 'HS256') {
    throw new HttpError(401, 'Unsupported token algorithm.');
  }

  const claims = JSON.parse(base64UrlDecode(encodedPayload));
  if (!stringValue(claims.sub)) {
    throw new HttpError(401, 'Token is missing subject.');
  }
  if (!arrayValue(claims.scope).length) {
    throw new HttpError(401, 'Token is missing scopes.');
  }
  if (numberValue(claims.exp) <= Date.now() / 1000) {
    throw new HttpError(401, 'Token has expired.');
  }

  return claims;
}

async function getCurrentSequence(env, workspaceId) {
  const row = await env.DB.prepare(
    'SELECT value FROM sync_sequences WHERE workspace_id = ?',
  )
    .bind(workspaceId)
    .first();
  return row?.value ?? 0;
}

function workspaceFromClaims(claims) {
  return stringValue(claims.workspace_id) || DEFAULT_WORKSPACE_ID;
}

function raceAllowed(claims, raceKey) {
  const races = arrayValue(claims.races);
  return races.includes('*') || races.includes(raceKey);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'Request body must be JSON.');
  }
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...headers,
      'Content-Type': 'application/json',
    },
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const configured = `${env.ALLOWED_ORIGINS || ''}`
    .split(',')
    .map(normalizeAllowedOrigin)
    .filter(Boolean);
  const allowed = new Set([
    ...configured,
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ]);

  if (!origin || !allowed.has(origin)) {
    return {
      Vary: 'Origin',
    };
  }

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type,Authorization,X-Client-Id,X-Client-Request-Id,X-Race-Key,X-Race-Name,X-Source-File-Name,X-Content-Hash,X-Row-Count,X-Race-Start-Time',
    'Access-Control-Expose-Headers': 'X-Race-Key,X-Artifact-Sha256',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function normalizeAllowedOrigin(value) {
  const trimmed = `${value || ''}`.trim();
  if (!trimmed) {
    return '';
  }

  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

function base64UrlDecode(value) {
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  return atob(padded);
}

function base64UrlToBytes(value) {
  return Uint8Array.from(base64UrlDecode(value), (char) => char.charCodeAt(0));
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left[i] ^ right[i];
  }
  return diff === 0;
}

function arrayValue(value) {
  return Array.isArray(value) ? value.map((item) => `${item}`) : [];
}

function stringValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function numberValueHeader(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function autoDownloadMaxBytes(env) {
  const parsed = Number(env.AUTO_DOWNLOAD_MAX_BYTES);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.trunc(parsed)
    : DEFAULT_AUTO_DOWNLOAD_MAX_BYTES;
}

function raceArtifactMaxBytes(env) {
  return positiveIntegerEnv(
    env.RACE_ARTIFACT_MAX_BYTES,
    DEFAULT_RACE_ARTIFACT_MAX_BYTES,
  );
}

function raceWorkspaceStorageQuotaBytes(env) {
  return positiveIntegerEnv(
    env.RACE_WORKSPACE_STORAGE_QUOTA_BYTES,
    DEFAULT_RACE_WORKSPACE_STORAGE_QUOTA_BYTES,
  );
}

function raceUploadsPerTokenPerDay(env) {
  return positiveIntegerEnv(
    env.RACE_UPLOADS_PER_TOKEN_PER_DAY,
    DEFAULT_RACE_UPLOADS_PER_TOKEN_PER_DAY,
  );
}

function raceUploadsPerWorkspacePerDay(env) {
  return positiveIntegerEnv(
    env.RACE_UPLOADS_PER_WORKSPACE_PER_DAY,
    DEFAULT_RACE_UPLOADS_PER_WORKSPACE_PER_DAY,
  );
}

function raceArtifactRetainedVersions(env) {
  return positiveIntegerEnv(
    env.RACE_ARTIFACT_RETAINED_VERSIONS,
    DEFAULT_RACE_ARTIFACT_RETAINED_VERSIONS,
  );
}

function mediaUploadMaxBytes(env) {
  return positiveIntegerEnv(
    env.MEDIA_UPLOAD_MAX_BYTES,
    DEFAULT_MEDIA_UPLOAD_MAX_BYTES,
  );
}

function mediaVariantMaxBytes(env) {
  return positiveIntegerEnv(
    env.MEDIA_VARIANT_MAX_BYTES,
    DEFAULT_MEDIA_VARIANT_MAX_BYTES,
  );
}

function mediaUploadsPerTokenPerDay(env) {
  return positiveIntegerEnv(
    env.MEDIA_UPLOADS_PER_TOKEN_PER_DAY,
    DEFAULT_MEDIA_UPLOADS_PER_TOKEN_PER_DAY,
  );
}

function mediaUploadsPerWorkspacePerDay(env) {
  return positiveIntegerEnv(
    env.MEDIA_UPLOADS_PER_WORKSPACE_PER_DAY,
    DEFAULT_MEDIA_UPLOADS_PER_WORKSPACE_PER_DAY,
  );
}

function mediaWorkspaceStorageQuotaBytes(env) {
  return positiveIntegerEnv(
    env.MEDIA_WORKSPACE_STORAGE_QUOTA_BYTES,
    DEFAULT_MEDIA_WORKSPACE_STORAGE_QUOTA_BYTES,
  );
}

function positiveIntegerEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function positiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new HttpError(400, 'Media dimensions must be positive integers.');
  }
  return Math.trunc(parsed);
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(`${value || '[]'}`);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function nullableValue(value) {
  if (value == null) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return value;
  }
  return `${value}`;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
