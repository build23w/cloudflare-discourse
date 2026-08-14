# Applied on every boot via `rails runner`. Everything here must be idempotent, and
# must never clobber settings a migrated forum brought with it.
def safely(label)
  yield
rescue => e
  puts "[cf-apply-runtime] #{label} failed: #{e.class}: #{e.message}"
end

email = ENV["CF_ADMIN_EMAIL"].to_s
pass  = ENV["CF_ADMIN_PASSWORD"].to_s
uname = ENV["CF_ADMIN_USERNAME"].to_s
uname = "admin" if uname.empty?

if !email.empty? && !pass.empty?
  safely("ensure admin #{email}") do
    existing = User.find_by_email(email)
    if existing
      existing.grant_admin! unless existing.admin?
    else
      u = User.new(email: email, username: uname, password: pass, active: true, approved: true)
      u.save!
      u.activate
      u.grant_admin!
      puts "[cf-apply-runtime] created admin #{uname} <#{email}>"
    end
  end
end

safely("force_https") { SiteSetting.force_https = true }

# Email follows the SMTP secrets: present => on, absent => globally disabled.
safely("email mode") do
  SiteSetting.disable_emails = ENV["CF_EMAILS_ENABLED"] == "1" ? "no" : "yes"
end

# Uploads: only configure S3 for a FRESH install. A migrated forum already carries its
# own bucket/credentials/CDN in site_settings and must not be repointed.
safely("s3 uploads (fresh install only)") do
  if !SiteSetting.enable_s3_uploads && !ENV["CF_R2_ACCESS_KEY_ID"].to_s.empty?
    SiteSetting.s3_access_key_id = ENV["CF_R2_ACCESS_KEY_ID"]
    SiteSetting.s3_secret_access_key = ENV["CF_R2_SECRET_ACCESS_KEY"]
    SiteSetting.s3_endpoint = ENV["CF_R2_ENDPOINT"]
    SiteSetting.s3_region = "us-east-1"
    SiteSetting.s3_upload_bucket = ENV["CF_R2_UPLOADS_BUCKET"]
    SiteSetting.s3_use_acls = false          # R2 has no object ACL API
    SiteSetting.s3_install_cors_rule = false
    SiteSetting.enable_s3_uploads = true
    puts "[cf-apply-runtime] configured R2 uploads for fresh install"
  end
end

puts "[cf-apply-runtime] done"
