# Cloudflare Sync Infrastructure

This directory provisions the optional Cloudflare backend for collaborative
sync. The static app still works without it; without `VITE_SYNC_API_BASE`, the
browser stays in standalone local SQLite mode.

Managed resources:

- D1 database for workspace metadata, annotations, journals, and race metadata
- R2 bucket for per-race SQLite artifacts and retained artifact versions
- DNS zone for the public media domain
- R2 bucket for public pregenerated race photo variants
- R2 custom domain, CORS, cache rules, response headers, and optional soft
  hotlink deterrence for the media bucket
- Worker version and deployment for token validation plus race/annotation sync
- Worker D1, R2, secret, and plain-text bindings
- Worker `workers.dev` route or optional custom domain
- R2 lifecycle cleanup for old `race-versions/` objects
- idempotent D1 migrations from `d1/migrations`
- optional GitHub Actions variable `VITE_SYNC_API_BASE`
- optional GitHub Actions variable `VITE_MEDIA_BASE_URL`

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
media_root_domain            = "example.com"
enable_media_custom_domain   = false # first apply only

allowed_origins = [
  "https://<github-owner>.github.io"
]

media_allowed_origins = [
  "https://<github-owner>.github.io",
  "http://localhost:5173",
  "http://127.0.0.1:5173"
]

media_allowed_referer_prefixes = [
  "https://<github-owner>.github.io/lemons/",
  "http://localhost:5173/lemons/",
  "http://127.0.0.1:5173/lemons/"
]
```

Use browser origins only in `allowed_origins`: scheme, host, and optional port.
For `https://<github-owner>.github.io/lemons/`, the origin is
`https://<github-owner>.github.io`.

Useful optional variables:

- `github_owner` and `github_repository` to manage the repo
  `VITE_SYNC_API_BASE` Actions variable
- `custom_domain_hostname` and `custom_domain_zone_id` for a custom Worker URL
- `media_subdomain`, `media_bucket_name`, and `media_path_prefix` for the R2
  photo CDN
- `enable_media_custom_domain`, `enable_media_r2_dev`, and
  `enable_media_hotlink_deterrence` for media bootstrap and delivery behavior
- `sync_api_base_override` when the frontend API base cannot be derived
- race artifact size, quota, rate limit, retention, and lifecycle settings
- media upload size, quota, and rate limit settings

See `variables.tf` for the full list.

## Media CDN Bootstrap

The media CDN uses a separate R2 bucket from sync artifacts. Domain purchase
and registrar nameserver delegation stay outside OpenTofu.

1. Buy the domain.
2. Apply once with `enable_media_custom_domain = false`.
3. Set the registrar nameservers to the `media_zone_name_servers` output.
4. Wait for the Cloudflare zone to become active.
5. Apply again with `enable_media_custom_domain = true`.

Upload photo variants under immutable keys. The in-app uploader writes keys
like `photos/<workspace>/<race-key>/<asset-id>/medium.webp`, sets
`Content-Type`, and stores objects with
`Cache-Control: public, max-age=31536000, immutable`. Terraform manages the
bucket and delivery rules, not individual media objects.

`enable_media_r2_dev` defaults to false. The Cloudflare provider warns that the
managed `r2.dev` domain resource cannot be destroyed by Terraform once created,
so keep it managed and disabled unless you deliberately need the temporary test
endpoint.

The optional hotlink rule only blocks requests with a non-empty `Referer` that
does not start with one of `media_allowed_referer_prefixes`. Empty referrers
remain allowed, so this is deterrence rather than private access control.

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

The `infra-plan`, `infra-apply`, and `infra-validate` mise tasks first run
`worker-build`, which bundles the Hono Worker to `cloudflare/worker/dist` for
the Terraform Worker upload.

After apply, the `sync_api_base` output is the value the frontend needs as
`VITE_SYNC_API_BASE`, and `media_public_base_url` is the value for
`VITE_MEDIA_BASE_URL`. If `github_owner` and `github_repository` are set,
OpenTofu writes both GitHub Actions variables automatically; otherwise set them
in GitHub manually.

## Edit Links

Use the signing secret that was applied to the Worker:

```bash
mise run sync-edit-link alice@example.com
```

The task reads `token_signing_secret` from `infra/cloudflare/terraform.tfvars`
with `tofu console`, then creates a link for the `APP_URL` configured in
`mise.toml`. Set `TOKEN_SIGNING_SECRET` to override the secret source. Pass
`--app-url` to override the configured app URL.

For custom subjects, workspaces, scopes, or app URLs, call the script directly:

```bash
TOKEN_SIGNING_SECRET='...' node cloudflare/worker/create-token.mjs \
  --sub alice@example.com \
  --app-url https://<github-owner>.github.io/lemons/
```

Generated tokens default to:

```text
annotations:read,annotations:write,races:read,races:write,media:write
```

The generated URL contains `?edit_token=...`. The browser stores that token in
`sessionStorage`, removes it from the address bar, and requires an explicit
**Connect Cloud Sync** action before any local SQLite database syncs.
