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
else
  # This log ships to R2, so make the gap loud: a fresh forum with no admin is a
  # brick when emails are disabled, because signups can never be activated.
  puts "[cf-apply-runtime] WARNING: CF_ADMIN_EMAIL/CF_ADMIN_PASSWORD unset; no admin was ensured, and without SMTP a fresh forum has no admin and signups cannot be activated"
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
    # The raw S3 endpoint rejects anonymous GETs, so browsers can only fetch uploads
    # through the bucket's public URL (its r2.dev URL or a custom domain).
    public_url = ENV["CF_R2_UPLOADS_PUBLIC_URL"].to_s.chomp("/")
    if public_url.empty?
      puts "[cf-apply-runtime] WARNING: CF_R2_UPLOADS_PUBLIC_URL unset; uploaded images will not render publicly (the S3 endpoint rejects anonymous GETs) until it is set to the uploads bucket's public URL"
    else
      SiteSetting.s3_cdn_url = public_url
    end
    SiteSetting.enable_s3_uploads = true
    puts "[cf-apply-runtime] configured R2 uploads for fresh install"
  end
end

safely("smtp report") do
  puts "[cf-apply-runtime] smtp=#{GlobalSetting.respond_to?(:smtp_address) ? GlobalSetting.smtp_address : "?"} " \
       "port=#{GlobalSetting.try(:smtp_port)} disable_emails=#{SiteSetting.disable_emails} " \
       "notification_email=#{SiteSetting.notification_email}"
end

# One-shot deliverability check. Set CF_TEST_EMAIL for a boot, read the result in
# R2 (logs/cf-runtime.tail.log), then unset it.
if !ENV["CF_TEST_EMAIL"].to_s.empty?
  safely("test email to #{ENV["CF_TEST_EMAIL"]}") do
    message = TestMailer.send_test(ENV["CF_TEST_EMAIL"])
    Email::Sender.new(message, :test_message).send
    puts "[cf-apply-runtime] TEST EMAIL ACCEPTED BY SMTP -> #{ENV["CF_TEST_EMAIL"]}"
  end
end


# Read-only diagnostics: ship the real exception out of Logster (redis) into the
# R2-shipped log — the only way to see a rendering 500's backtrace in a container
# with no shell. Self-probes retry past warming 503s so the dump captures the
# serving app, then the latest reports are printed with their backtraces.
safely("recent error dump") do
  require "net/http"
  10.times do
    begin
      r = Net::HTTP.get_response(URI("http://127.0.0.1/latest"))
      puts "[cf-logster] self-probe /latest -> #{r.code}"
      break unless r.code.to_s == "503"
    rescue => e
      puts "[cf-logster] self-probe failed: #{e.class}: #{e.message}"
    end
    sleep 20
  end
  reports = (Logster.store.latest(limit: 10) rescue [])
  puts "[cf-logster] #{reports.length} recent reports"
  reports.each do |r|
    ts = (Time.at(r.timestamp / 1000.0).utc rescue "?")
    puts "[cf-logster] #{ts} #{r.message.to_s[0, 600].gsub(/\s+/, " ")}"
    bt = (r.backtrace.to_s.lines.first(14).join rescue "")
    puts bt unless bt.empty?
  end
end

puts "[cf-apply-runtime] done"
