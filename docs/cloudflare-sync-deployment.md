# Cloudflare Sync Deployment And Usage

This project works in two modes:

- **Standalone local mode:** no Cloudflare configuration is required. The app stores the full SQLite database in the browser OPFS cache and exports complete `.sqlite` backups containing races, laps, annotations, journals, sync metadata, tombstones, and pending outbox rows.
- **Cloud sync mode:** GitHub Pages still hosts the static app, while Cloudflare Worker + D1 + R2 provide optional collaborative race, annotation, and journal sync. The browser still writes locally first.

Cloud sync stores race metadata in D1, per-race SQLite artifacts in R2, and annotations/journals in D1. The local browser SQLite database remains the complete standalone artifact and export format.

## Prerequisites

- Node 22.13+ or Node 24 with pnpm 11.3.
- Terraform or OpenTofu.
- Cloudflare account with Workers, D1, and R2 enabled.
- Wrangler authenticated for the target Cloudflare account.
- GitHub token only if Terraform/OpenTofu should set repository Actions variables.

Install local dependencies first:

```bash
pnpm install
```

## Deploy The Cloudflare Backend

The infrastructure lives in `infra/cloudflare`.

Create a variables file, for example `infra/cloudflare/terraform.tfvars`:

```hcl
cloudflare_account_id        = "..."
cloudflare_workers_subdomain = "your-workers-subdomain"
token_signing_secret         = "use-a-long-random-secret"
race_artifacts_bucket_name   = "lemons-race-artifacts"
auto_download_max_bytes      = 104857600
race_artifact_max_bytes      = 26214400

allowed_origins = [
  "https://<github-owner>.github.io"
]

github_owner      = "<github-owner>"
github_repository = "lemons"
```

Use browser origins only in `allowed_origins`: scheme, host, and optional port.
For a GitHub Pages app at `https://<github-owner>.github.io/lemons/`, the
origin is `https://<github-owner>.github.io`.

If you use a custom API hostname, set:

```hcl
custom_domain_hostname = "lemons-sync.example.com"
custom_domain_zone_id  = "..."
```

Then apply:

```bash
mise run infra-r2-backend-bootstrap
cd infra/cloudflare
tofu init
tofu apply
```

`infra-r2-backend-bootstrap` creates the R2 state bucket configured in
`infra/cloudflare/backend.tf`. Before running it or any OpenTofu command,
provide credentials locally: `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`
for the R2 S3 backend, and `CLOUDFLARE_API_TOKEN` for the Cloudflare provider.
`mise.toml` supplies the nonsecret R2 defaults `AWS_REGION=us-east-1`,
`AWS_DEFAULT_REGION=us-east-1`, and `AWS_EC2_METADATA_DISABLED=true`.

Use shell exports, an ignored dotenv file, an untracked `mise.local.toml`, or
another local secrets workflow. Keep machine-specific credential loading
commands out of committed config. Use `mise.local.toml.example` as the
committed template.

The apply creates:

- Cloudflare D1 database
- Cloudflare R2 bucket for per-race SQLite artifacts
- Cloudflare Worker
- Worker `workers.dev` route, when `enable_workers_dev` is true
- Worker D1 binding
- Worker R2 binding
- Worker `TOKEN_SIGNING_SECRET`
- Worker CORS, race auto-download, upload limit, and quota variables
- R2 lifecycle rule for old versioned race artifacts
- D1 schema from all files in `infra/cloudflare/d1/migrations/`
- optional GitHub Actions variable `VITE_SYNC_API_BASE`

The D1 schema step runs Wrangler through a local-exec provisioner. Run apply from an environment where Wrangler can authenticate.

## Configure GitHub Pages Build

The GitHub Pages workflow reads these repository variables:

- `VITE_SYNC_API_BASE`: sync Worker base URL, for example `https://lemons-sync-api.<subdomain>.workers.dev`
- `VITE_SYNC_READ_ONLY`: optional; set to `true` only to force production read-only mode

If Terraform/OpenTofu manages GitHub variables, `VITE_SYNC_API_BASE` is created automatically when `github_repository` and a derivable API URL are set. Otherwise, create it manually in GitHub:

`Settings -> Secrets and variables -> Actions -> Variables`

After variables are configured, push to `main` and let the existing GitHub Pages workflow deploy the app.

## Create Collaborative Edit Links

Use the same signing secret configured as `token_signing_secret`:

```bash
mise run sync-edit-link -- \
  --sub alice@example.com \
  --app-url https://<github-owner>.github.io/lemons/
```

Useful options:

```bash
--days 28
--workspace main
--scope annotations:read,annotations:write,races:read,races:write
--races '*'
```

The default scope is `annotations:read,annotations:write,races:read,races:write`. Use narrower scopes when a link should only read races or should not upload new race artifacts.

The task reads the signing secret from `infra/cloudflare/terraform.tfvars` with
`tofu console`. Override with `TOKEN_SIGNING_SECRET` when needed.

The command prints a URL containing `?edit_token=...`. Send each collaborator their own link.

The browser stores the token in `sessionStorage` and removes it from the address bar. Tokens are never written into SQLite exports.

## Use Standalone Mode

Standalone mode is the default when `VITE_SYNC_API_BASE` is missing or when no collaborator token is connected.

Normal workflow:

1. Open the app.
2. Import CSV files or restore a previous `.sqlite` export.
3. Add annotations and journal entries.
4. Use **Export SQLite** for a complete standalone backup.

That exported file can be restored later without Cloudflare and still contains races, raw lap rows, annotations, journals, tombstones, sync metadata, and pending outbox rows.

## Use Cloud Sync Mode

Collaborator workflow:

1. Open a collaborative edit link.
2. Click **Connect Cloud Sync**.
3. Confirm the connection prompt.
4. Let the app download cloud race artifacts when the total size is under `auto_download_max_bytes`.
5. Import any missing CSVs locally if cloud auto-download was skipped or the race is not yet in cloud.
6. Edit races, annotations, and journals normally.

An empty local database can bootstrap from cloud automatically when the total R2 artifact size reported by `/v1/races/list` is below `auto_download_max_bytes`. If the total is above that cap, the app leaves local data untouched and reports that picker/import support is needed.

Writes are local-first:

- local SQLite is updated immediately
- OPFS is persisted
- race imports queue a race artifact upload to R2
- annotation and journal edits queue D1 sync mutations
- race artifacts flush before annotation/journal mutations
- annotation/journal mutations push to Cloudflare in batches of 50

Use **Sync Now** to manually pull race artifacts, push pending race uploads, and pull/push annotation and journal mutations. **Export SQLite** does a best-effort sync first, but export still works offline and includes pending outbox rows if sync fails.

Race artifacts uploaded to R2 contain one `races` row and that race's `raw_lap_rows`. They intentionally exclude annotations, journals, and precomputed `normalized_laps`; the browser rebuilds normalized laps locally after download.

## Race Upload Limits

Race uploads require `races:write` and a token with a `jti` claim. Defaults are intentionally conservative:

- `race_artifact_max_bytes`: `26214400` bytes, or 25 MiB per uploaded SQLite artifact
- `race_workspace_storage_quota_bytes`: `1073741824` bytes, or 1 GiB retained R2 storage per workspace
- `race_uploads_per_token_per_day`: 20 upload attempts per token `jti` per UTC day
- `race_uploads_per_workspace_per_day`: 100 upload attempts per workspace per UTC day
- `race_artifact_retained_versions`: keep the newest 2 immutable versions per race
- `race_version_lifecycle_max_age_seconds`: delete `race-versions/` objects older than 30 days as an orphan cleanup backstop

The Worker rejects oversized artifacts with `413`, rate-limit exhaustion with `429`, reused `clientRequestId` values for a different mutation with `409`, and malformed race metadata with `400`.

New accepted race uploads write an immutable `race-versions/<workspace>/<race>/<sequence>.sqlite` object and then update `races/<workspace>/<race>/latest.sqlite`. D1 points at `latest.sqlite` only after that object is written; if the latest update fails, D1 remains pointed at the immutable accepted object. The lifecycle rule is only a safety net; exact "keep 2" retention is enforced by the Worker after successful uploads.

## Restore And Reconnect

Restoring a `.sqlite` export never auto-syncs.

After restore:

- local data is available immediately
- any included sync config is marked reconnect required
- cloud writes stay disabled until a valid edit token is supplied again
- the user must explicitly click **Connect Cloud Sync**

This prevents an exported SQLite file from silently syncing into the wrong browser/session.

## Local Development

Run the static app:

```bash
pnpm dev
```

Run the Worker locally with Wrangler from `cloudflare/worker` after replacing the placeholder D1 database id in `wrangler.jsonc`:

```bash
cd cloudflare/worker
wrangler dev
```

For local Worker testing, create or bind an R2 bucket named `lemons-race-artifacts` and apply all D1 migrations:

```bash
cd cloudflare/worker
wrangler d1 execute lemons_annotations --local --file ../../infra/cloudflare/d1/migrations/0001_sync_schema.sql
wrangler d1 execute lemons_annotations --local --file ../../infra/cloudflare/d1/migrations/0002_race_artifacts.sql
wrangler d1 execute lemons_annotations --local --file ../../infra/cloudflare/d1/migrations/0003_race_upload_limits.sql
```

The Worker allows these development origins by default:

- `http://localhost:5173`
- `http://127.0.0.1:5173`

To test the app against a deployed Worker locally:

```bash
VITE_SYNC_API_BASE='https://lemons-sync-api.<subdomain>.workers.dev' pnpm dev
```

Then open a generated edit link using the local app URL:

```bash
mise run sync-edit-link -- \
  --sub dev@example.com \
  --app-url http://127.0.0.1:5173/lemons/
```

## Operational Notes

- Rotate collaborator links by issuing a new token with a new expiry.
- Revoke a token by inserting its `jti` into D1 `capability_revocations`.
- Keep `token_signing_secret` out of client-side code and out of SQLite exports.
- Monitor R2 storage because every uploaded race writes an immutable version and best-effort updates `latest.sqlite`.
- Race deletion is not implemented; remove obsolete race artifacts and D1 index rows manually only with a deliberate maintenance process.
- Raising race upload limits increases exposure from leaked `races:write` links.
- Terraform/OpenTofu state contains the Worker secret binding value; store state accordingly.
- `terraform validate` requires providers to be initialized with `terraform init`.

Before shipping changes, run:

```bash
pnpm check
pnpm build
terraform fmt -check -recursive infra
```
