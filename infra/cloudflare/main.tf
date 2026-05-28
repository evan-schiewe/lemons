provider "cloudflare" {}

provider "github" {
  owner = var.github_owner == "" ? null : var.github_owner
}

locals {
  worker_module_path = "${path.module}/../../cloudflare/worker/dist/index.js"
  d1_migration_dir   = "${path.module}/d1/migrations"
  d1_migration_files = fileset("${path.module}/d1/migrations", "*.sql")

  derived_workers_dev_url = var.cloudflare_workers_subdomain == "" ? "" : "https://${var.worker_name}.${var.cloudflare_workers_subdomain}.workers.dev"
  derived_custom_url      = var.custom_domain_hostname == "" ? "" : "https://${var.custom_domain_hostname}"
  sync_api_base = (
    var.sync_api_base_override != "" ? var.sync_api_base_override :
    local.derived_custom_url != "" ? local.derived_custom_url :
    local.derived_workers_dev_url
  )

  media_hostname               = var.media_subdomain == "" ? var.media_root_domain : "${var.media_subdomain}.${var.media_root_domain}"
  media_base_url               = "https://${local.media_hostname}"
  media_path_prefix_normalized = trim(var.media_path_prefix, "/")
  media_path_match_prefix      = local.media_path_prefix_normalized == "" ? "/" : "/${local.media_path_prefix_normalized}/"
  media_rule_expression = format(
    "(http.host eq %s and starts_with(http.request.uri.path, %s))",
    jsonencode(local.media_hostname),
    jsonencode(local.media_path_match_prefix),
  )
  media_allowed_referer_expression = length(var.media_allowed_referer_prefixes) == 0 ? "false" : join(" or ", [
    for prefix in var.media_allowed_referer_prefixes :
    format("starts_with(http.referer, %s)", jsonencode(prefix))
  ])
  media_hotlink_expression = "(${local.media_rule_expression} and http.referer ne \"\" and not (${local.media_allowed_referer_expression}))"
}

resource "cloudflare_d1_database" "annotations" {
  account_id            = var.cloudflare_account_id
  name                  = var.d1_database_name
  primary_location_hint = "wnam"
  read_replication = {
    mode = "disabled"
  }
}

resource "cloudflare_r2_bucket" "race_artifacts" {
  account_id = var.cloudflare_account_id
  name       = var.race_artifacts_bucket_name
}

resource "cloudflare_r2_bucket_lifecycle" "race_artifacts" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.race_artifacts.name

  rules = [{
    id = "Delete old race artifact versions"
    conditions = {
      prefix = "race-versions/"
    }
    enabled = true
    abort_multipart_uploads_transition = {
      condition = {
        max_age = 86400
        type    = "Age"
      }
    }
    delete_objects_transition = {
      condition = {
        max_age = var.race_version_lifecycle_max_age_seconds
        type    = "Age"
      }
    }
  }]
}

resource "cloudflare_zone" "media" {
  account = {
    id = var.cloudflare_account_id
  }
  name = var.media_root_domain
  type = "full"
}

resource "cloudflare_r2_bucket" "media_photos" {
  account_id = var.cloudflare_account_id
  name       = var.media_bucket_name
}

resource "cloudflare_r2_managed_domain" "media_photos" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.media_photos.name
  enabled     = var.enable_media_r2_dev
}

resource "cloudflare_r2_custom_domain" "media_photos" {
  count       = var.enable_media_custom_domain ? 1 : 0
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.media_photos.name
  domain      = local.media_hostname
  enabled     = true
  min_tls     = "1.2"
  zone_id     = cloudflare_zone.media.id
}

resource "cloudflare_r2_bucket_cors" "media_photos" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.media_photos.name

  rules = length(var.media_allowed_origins) == 0 ? [] : [{
    id = "Allow media reads"
    allowed = {
      methods = ["GET", "HEAD"]
      origins = var.media_allowed_origins
      headers = []
    }
    expose_headers = [
      "Cache-Control",
      "CF-Cache-Status",
      "Content-Length",
      "Content-Type",
      "ETag",
    ]
    max_age_seconds = 7200
  }]
}

resource "cloudflare_ruleset" "media_cache" {
  zone_id     = cloudflare_zone.media.id
  name        = "Cache media photos"
  description = "Long-lived CDN caching for immutable R2 photo variants."
  kind        = "zone"
  phase       = "http_request_cache_settings"

  rules = [{
    ref         = "cache_media_photos"
    description = "Cache immutable media photo objects."
    expression  = local.media_rule_expression
    action      = "set_cache_settings"
    action_parameters = {
      cache = true
      edge_ttl = {
        mode    = "override_origin"
        default = 31536000
        status_code_ttl = [
          {
            status_code = 200
            value       = 31536000
          },
          {
            status_code = 301
            value       = 31536000
          },
          {
            status_code = 302
            value       = 300
          },
          {
            status_code_range = {
              from = 400
              to   = 499
            }
            value = 300
          },
          {
            status_code_range = {
              from = 500
              to   = 599
            }
            value = 0
          },
        ]
      }
      browser_ttl = {
        mode    = "override_origin"
        default = 31536000
      }
      cache_key = {
        ignore_query_strings_order = false
        custom_key = {
          query_string = {
            exclude = {
              all = true
            }
          }
        }
      }
      respect_strong_etags = true
    }
  }]
}

resource "cloudflare_ruleset" "media_headers" {
  zone_id     = cloudflare_zone.media.id
  name        = "Set media response headers"
  description = "Response headers for public cross-origin media assets."
  kind        = "zone"
  phase       = "http_response_headers_transform"

  rules = [{
    ref         = "set_media_response_headers"
    description = "Set media security and embedding headers."
    expression  = local.media_rule_expression
    action      = "rewrite"
    action_parameters = {
      headers = {
        "Cross-Origin-Resource-Policy" = {
          operation = "set"
          value     = "cross-origin"
        }
        "X-Content-Type-Options" = {
          operation = "set"
          value     = "nosniff"
        }
      }
    }
  }]
}

resource "cloudflare_ruleset" "media_hotlink_deterrence" {
  count       = var.enable_media_hotlink_deterrence && length(var.media_allowed_referer_prefixes) > 0 ? 1 : 0
  zone_id     = cloudflare_zone.media.id
  name        = "Deter media hotlinking"
  description = "Block media requests with non-empty Referer headers outside the configured allowlist."
  kind        = "zone"
  phase       = "http_request_firewall_custom"

  rules = [{
    ref         = "block_unlisted_media_referers"
    description = "Block unlisted non-empty media Referer headers."
    expression  = local.media_hotlink_expression
    action      = "block"
  }]
}

resource "cloudflare_worker" "sync_api" {
  account_id = var.cloudflare_account_id
  name       = var.worker_name

  observability = {
    enabled = true
    traces = {
      destinations = []
    }
  }

  subdomain = {
    enabled          = var.enable_workers_dev
    previews_enabled = false
  }
}

resource "cloudflare_worker_version" "sync_api" {
  account_id         = var.cloudflare_account_id
  worker_id          = cloudflare_worker.sync_api.id
  compatibility_date = "2026-05-27"
  main_module        = "index.js"

  modules = [{
    name         = "index.js"
    content_type = "application/javascript+module"
    content_file = local.worker_module_path
  }]

  bindings = [
    {
      type = "d1"
      name = "DB"
      id   = cloudflare_d1_database.annotations.id
    },
    {
      type        = "r2_bucket"
      name        = "RACE_ARTIFACTS"
      bucket_name = cloudflare_r2_bucket.race_artifacts.name
    },
    {
      type        = "r2_bucket"
      name        = "MEDIA_PHOTOS"
      bucket_name = cloudflare_r2_bucket.media_photos.name
    },
    {
      type = "plain_text"
      name = "ALLOWED_ORIGINS"
      text = join(",", var.allowed_origins)
    },
    {
      type = "plain_text"
      name = "AUTO_DOWNLOAD_MAX_BYTES"
      text = tostring(var.auto_download_max_bytes)
    },
    {
      type = "plain_text"
      name = "RACE_ARTIFACT_MAX_BYTES"
      text = tostring(var.race_artifact_max_bytes)
    },
    {
      type = "plain_text"
      name = "RACE_WORKSPACE_STORAGE_QUOTA_BYTES"
      text = tostring(var.race_workspace_storage_quota_bytes)
    },
    {
      type = "plain_text"
      name = "RACE_UPLOADS_PER_TOKEN_PER_DAY"
      text = tostring(var.race_uploads_per_token_per_day)
    },
    {
      type = "plain_text"
      name = "RACE_UPLOADS_PER_WORKSPACE_PER_DAY"
      text = tostring(var.race_uploads_per_workspace_per_day)
    },
    {
      type = "plain_text"
      name = "RACE_ARTIFACT_RETAINED_VERSIONS"
      text = tostring(var.race_artifact_retained_versions)
    },
    {
      type = "plain_text"
      name = "MEDIA_UPLOAD_MAX_BYTES"
      text = tostring(var.media_upload_max_bytes)
    },
    {
      type = "plain_text"
      name = "MEDIA_VARIANT_MAX_BYTES"
      text = tostring(var.media_variant_max_bytes)
    },
    {
      type = "plain_text"
      name = "MEDIA_UPLOADS_PER_TOKEN_PER_DAY"
      text = tostring(var.media_uploads_per_token_per_day)
    },
    {
      type = "plain_text"
      name = "MEDIA_UPLOADS_PER_WORKSPACE_PER_DAY"
      text = tostring(var.media_uploads_per_workspace_per_day)
    },
    {
      type = "plain_text"
      name = "MEDIA_WORKSPACE_STORAGE_QUOTA_BYTES"
      text = tostring(var.media_workspace_storage_quota_bytes)
    },
    {
      type = "plain_text"
      name = "RACE_VERSION_LIFECYCLE_MAX_AGE_SECONDS"
      text = tostring(var.race_version_lifecycle_max_age_seconds)
    },
    {
      type = "plain_text"
      name = "ENVIRONMENT"
      text = var.environment
    },
    {
      type = "secret_text"
      name = "TOKEN_SIGNING_SECRET"
      text = var.token_signing_secret
    }
  ]
}

resource "cloudflare_workers_deployment" "sync_api" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_worker.sync_api.name
  strategy    = "percentage"

  versions = [{
    percentage = 100
    version_id = cloudflare_worker_version.sync_api.id
  }]

  annotations = {
    workers_message = "Deploy Lemons sync API."
  }
}

resource "cloudflare_workers_custom_domain" "sync_api" {
  count      = var.custom_domain_hostname == "" ? 0 : 1
  account_id = var.cloudflare_account_id
  hostname   = var.custom_domain_hostname
  service    = cloudflare_worker.sync_api.name
  zone_id    = var.custom_domain_zone_id
}

resource "null_resource" "d1_schema" {
  triggers = {
    database_id = cloudflare_d1_database.annotations.id
    migrations = join(",", [
      for file in local.d1_migration_files :
      "${file}:${filesha256("${local.d1_migration_dir}/${file}")}"
    ])
  }

  provisioner "local-exec" {
    command = "for file in ${local.d1_migration_dir}/*.sql; do npx wrangler d1 execute ${cloudflare_d1_database.annotations.name} --remote --file \"$file\"; done"
    environment = {
      CLOUDFLARE_ACCOUNT_ID = var.cloudflare_account_id
    }
  }

  depends_on = [cloudflare_d1_database.annotations]
}

resource "github_actions_variable" "sync_api_base" {
  count         = var.github_repository == "" || local.sync_api_base == "" ? 0 : 1
  repository    = var.github_repository
  variable_name = "VITE_SYNC_API_BASE"
  value         = local.sync_api_base
}

resource "github_actions_variable" "media_base_url" {
  count         = var.github_repository == "" ? 0 : 1
  repository    = var.github_repository
  variable_name = "VITE_MEDIA_BASE_URL"
  value         = local.media_base_url
}
