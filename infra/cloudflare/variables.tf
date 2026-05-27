variable "cloudflare_account_id" {
  type        = string
  description = "Cloudflare account ID that owns the Worker and D1 database."
}

variable "cloudflare_workers_subdomain" {
  type        = string
  description = "Workers.dev subdomain, used only to compute VITE_SYNC_API_BASE when no custom API base is supplied."
  default     = ""
}

variable "worker_name" {
  type        = string
  description = "Cloudflare Worker service name."
  default     = "lemons-sync-api"
}

variable "d1_database_name" {
  type        = string
  description = "Cloudflare D1 database name."
  default     = "lemons_annotations"
}

variable "race_artifacts_bucket_name" {
  type        = string
  description = "Cloudflare R2 bucket name for per-race SQLite artifacts."
  default     = "lemons-race-artifacts"
}

variable "auto_download_max_bytes" {
  type        = number
  description = "Maximum total cloud race artifact bytes that the browser auto-downloads on connect."
  default     = 104857600
}

variable "race_artifact_max_bytes" {
  type        = number
  description = "Maximum bytes accepted by the race artifact upload endpoint."
  default     = 26214400
}

variable "race_workspace_storage_quota_bytes" {
  type        = number
  description = "Maximum retained R2 bytes allowed per workspace for race artifacts."
  default     = 1073741824
}

variable "race_uploads_per_token_per_day" {
  type        = number
  description = "Maximum race artifact upload attempts reserved per token jti per UTC day."
  default     = 20
}

variable "race_uploads_per_workspace_per_day" {
  type        = number
  description = "Maximum race artifact upload attempts reserved per workspace per UTC day."
  default     = 100
}

variable "race_artifact_retained_versions" {
  type        = number
  description = "Number of immutable race artifact versions retained per race."
  default     = 2
}

variable "race_version_lifecycle_max_age_seconds" {
  type        = number
  description = "R2 lifecycle age in seconds for deleting orphaned versioned race artifacts."
  default     = 2592000
}

variable "token_signing_secret" {
  type        = string
  description = "HMAC-SHA256 signing secret for collaborative edit tokens."
  sensitive   = true
}

variable "allowed_origins" {
  type        = list(string)
  description = "Production browser origins allowed by CORS."
  default     = []
}

variable "environment" {
  type        = string
  description = "Worker environment label."
  default     = "production"
}

variable "enable_workers_dev" {
  type        = bool
  description = "Enable the workers.dev subdomain for the sync API Worker."
  default     = true
}

variable "custom_domain_hostname" {
  type        = string
  description = "Optional custom domain hostname for the Worker."
  default     = ""
}

variable "custom_domain_zone_id" {
  type        = string
  description = "Zone ID for the optional custom Worker domain."
  default     = ""
}

variable "sync_api_base_override" {
  type        = string
  description = "Optional explicit VITE_SYNC_API_BASE. Use this when the API URL cannot be derived from workers.dev or a custom domain."
  default     = ""
}

variable "github_owner" {
  type        = string
  description = "GitHub repository owner for setting Actions variables."
  default     = ""
}

variable "github_repository" {
  type        = string
  description = "GitHub repository name for setting VITE_SYNC_API_BASE. Leave empty to skip GitHub variable management."
  default     = ""
}
