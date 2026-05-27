provider "cloudflare" {}

provider "github" {
  owner = var.github_owner == "" ? null : var.github_owner
}

locals {
  worker_module_path = "${path.module}/../../cloudflare/worker/src/index.mjs"
  d1_migration_dir   = "${path.module}/d1/migrations"
  d1_migration_files = fileset("${path.module}/d1/migrations", "*.sql")

  derived_workers_dev_url = var.cloudflare_workers_subdomain == "" ? "" : "https://${var.worker_name}.${var.cloudflare_workers_subdomain}.workers.dev"
  derived_custom_url      = var.custom_domain_hostname == "" ? "" : "https://${var.custom_domain_hostname}"
  sync_api_base = (
    var.sync_api_base_override != "" ? var.sync_api_base_override :
    local.derived_custom_url != "" ? local.derived_custom_url :
    local.derived_workers_dev_url
  )
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
  main_module        = "index.mjs"

  modules = [{
    name         = "index.mjs"
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
