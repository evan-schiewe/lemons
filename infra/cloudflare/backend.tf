terraform {
  backend "s3" {
    bucket                      = "tfstate-6249be2c6110d613cef848249b7e6f62"
    key                         = "global/terraform.tfstate"
    region                      = "us-east-1" # R2 requires this to satisfy AWS SDK requirements
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
    use_path_style              = true

    endpoints = {
      s3 = "https://6249be2c6110d613cef848249b7e6f62.r2.cloudflarestorage.com"
    }
  }
}
