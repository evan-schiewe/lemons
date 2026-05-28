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

output "media_zone_id" {
  description = "Cloudflare zone ID for the public media domain."
  value       = cloudflare_zone.media.id
}

output "media_zone_name_servers" {
  description = "Cloudflare-assigned nameservers to configure at the domain registrar."
  value       = cloudflare_zone.media.name_servers
}

output "media_bucket_name" {
  description = "R2 bucket storing public pregenerated race photo variants."
  value       = cloudflare_r2_bucket.media_photos.name
}

output "media_public_base_url" {
  description = "Public base URL for media objects."
  value       = local.media_base_url
}

output "media_custom_domain_status" {
  description = "R2 custom domain ownership and SSL status, or null when custom domain attachment is disabled."
  value       = try(cloudflare_r2_custom_domain.media_photos[0].status, null)
}
