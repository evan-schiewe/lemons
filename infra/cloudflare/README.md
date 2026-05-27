# Cloudflare Sync Infrastructure

This directory provisions the optional Cloudflare backend for collaborative
sync. The static app still works without it; without `VITE_SYNC_API_BASE`, the
browser stays in standalone local SQLite mode.

Managed resources:

- D1 database for workspace metadata, annotations, journals, and race metadata
- R2 bucket for per-race SQLite artifacts and retained artifact versions
- Worker version and deployment for token validation plus race/annotation sync
- Worker D1, R2, secret, and plain-text bindings
- Worker `workers.dev` route or optional custom domain
- R2 lifecycle cleanup for old `race-versions/` objects
- idempotent D1 migrations from `d1/migrations`
- optional GitHub Actions variable `VITE_SYNC_API_BASE`

## State And Credentials

OpenTofu state is stored in the Cloudflare R2 bucket configured in
`backend.tf`. That bucket must already exist before the first `init`.

OpenTofu credentials are supplied by the local environment before running
infrastructure tasks:

- R2 S3 backend credentials: `AWS_ACCESS_KEY_ID` and
  `AWS_SECRET_ACCESS_KEY`
- Cloudflare provider token: `CLOUDFLARE_API_TOKEN`

`mise.toml` sets the nonsecret R2 backend defaults `AWS_REGION=us-east-1`,
`AWS_DEFAULT_REGION=us-east-1`, and `AWS_EC2_METADATA_DISABLED=true`. Put any
machine-specific credential loader in untracked `mise.local.toml`, export the
variables in your shell, or load them from another local secrets workflow. Use
`mise.local.toml.example` as the committed template.

## Variables

`terraform.tfvars` is local and ignored. Minimum production config:

```hcl
cloudflare_account_id        = "..."
cloudflare_workers_subdomain = "your-workers-subdomain"
token_signing_secret         = "use-a-long-random-secret"

allowed_origins = [
  "https://<github-owner>.github.io"
]
```

Use browser origins only in `allowed_origins`: scheme, host, and optional port.
For `https://<github-owner>.github.io/lemons/`, the origin is
`https://<github-owner>.github.io`.

Useful optional variables:

- `github_owner` and `github_repository` to manage the repo
  `VITE_SYNC_API_BASE` Actions variable
- `custom_domain_hostname` and `custom_domain_zone_id` for a custom Worker URL
- `sync_api_base_override` when the frontend API base cannot be derived
- race artifact size, quota, rate limit, retention, and lifecycle settings

See `variables.tf` for the full list.

## Plan And Apply

Use the `mise` tasks from the repo root:

```bash
mise run infra-init
mise run infra-plan
mise run infra-apply
```

`infra-apply` also runs the D1 migrations through Wrangler via the
`null_resource.d1_schema` provisioner, so Wrangler must be authenticated for the
target Cloudflare account.

After apply, the `sync_api_base` output is the value the frontend needs as
`VITE_SYNC_API_BASE`. If `github_owner` and `github_repository` are set,
OpenTofu writes that GitHub Actions variable automatically; otherwise set it in
GitHub manually.

## Edit Links

Use the signing secret that was applied to the Worker:

```bash
mise run sync-edit-link
```

The task reads `token_signing_secret` from `infra/cloudflare/terraform.tfvars`
with `tofu console`, then creates a link for the `APP_URL` configured in
`mise.toml`. Set `TOKEN_SIGNING_SECRET` to override the secret source.

For custom subjects, workspaces, scopes, or app URLs, call the script directly:

```bash
TOKEN_SIGNING_SECRET='...' node cloudflare/worker/create-token.mjs \
  --sub alice@example.com \
  --app-url https://<github-owner>.github.io/lemons/
```

Generated tokens default to:

```text
annotations:read,annotations:write,races:read,races:write
```

The generated URL contains `?edit_token=...`. The browser stores that token in
`sessionStorage`, removes it from the address bar, and requires an explicit
**Connect Cloud Sync** action before any local SQLite database syncs.
