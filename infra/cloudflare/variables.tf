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

variable "media_root_domain" {
  type        = string
  description = "Purchased root domain to onboard as a full Cloudflare zone for public media delivery, for example example.com."

  validation {
    condition     = length(trimspace(var.media_root_domain)) > 0 && !startswith(var.media_root_domain, "http://") && !startswith(var.media_root_domain, "https://")
    error_message = "media_root_domain must be a bare domain name, for example example.com."
  }
}

variable "media_subdomain" {
  type        = string
  description = "Subdomain under media_root_domain used for public R2 media delivery. Use an empty string to serve from the root domain."
  default     = "media"
}

variable "media_bucket_name" {
  type        = string
  description = "Cloudflare R2 bucket name for public pregenerated race photo variants."
  default     = "lemons-media-photos"
}

variable "media_path_prefix" {
  type        = string
  description = "R2 object key prefix for publicly cached media. Leading and trailing slashes are normalized away."
  default     = "photos/"
}

variable "media_allowed_origins" {
  type        = list(string)
  description = "Browser origins allowed to read media objects with CORS GET and HEAD requests."
  default     = []
}

variable "media_allowed_referer_prefixes" {
  type        = list(string)
  description = "Referer URL prefixes allowed by the optional soft hotlink deterrence rule. Empty Referer headers are always allowed."
  default     = []
}

variable "enable_media_custom_domain" {
  type        = bool
  description = "Attach media_subdomain.media_root_domain to the public media R2 bucket. Set false for the first bootstrap apply before registrar nameservers are delegated."
  default     = true
}

variable "enable_media_hotlink_deterrence" {
  type        = bool
  description = "Create a WAF custom rule blocking media requests with non-empty Referer headers outside media_allowed_referer_prefixes."
  default     = true
}

variable "enable_media_r2_dev" {
  type        = bool
  description = "Enable the R2 managed r2.dev public endpoint for the media bucket. Intended only for temporary testing."
  default     = false
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

variable "media_upload_max_bytes" {
  type        = number
  description = "Maximum total bytes accepted by the media upload endpoint."
  default     = 10485760
}

variable "media_variant_max_bytes" {
  type        = number
  description = "Maximum bytes accepted for one uploaded media variant."
  default     = 3145728
}

variable "media_uploads_per_token_per_day" {
  type        = number
  description = "Maximum media upload attempts reserved per token jti per UTC day."
  default     = 100
}

variable "media_uploads_per_workspace_per_day" {
  type        = number
  description = "Maximum media upload attempts reserved per workspace per UTC day."
  default     = 500
}

variable "media_workspace_storage_quota_bytes" {
  type        = number
  description = "Maximum retained R2 bytes allowed per workspace for uploaded media variants."
  default     = 1073741824
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
