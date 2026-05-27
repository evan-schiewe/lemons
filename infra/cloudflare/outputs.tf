output "d1_database_id" {
  description = "Cloudflare D1 database ID."
  value       = cloudflare_d1_database.annotations.id
}

output "worker_name" {
  description = "Cloudflare Worker name."
  value       = cloudflare_worker.sync_api.name
}

output "sync_api_base" {
  description = "API base URL to expose to the Vite app as VITE_SYNC_API_BASE."
  value       = local.sync_api_base
}

output "race_artifacts_bucket_name" {
  description = "R2 bucket storing per-race SQLite artifacts."
  value       = cloudflare_r2_bucket.race_artifacts.name
}
