# Deployment record

Target: Cloudflare account that owns apprifi.com. Worker name fsb-appraisal-desk. Custom domain fsb.apprifi.com (DNS record and certificate are created by wrangler on deploy).

Resources: D1 database fsb-portal (binding DB), KV namespace FILES, cron every five minutes for the mail queue and session cleanup.

Commands used, run from the repository on the deploying PC:

    npm install
    npx wrangler login
    npx wrangler d1 create fsb-portal            # id goes into wrangler.toml
    npx wrangler kv namespace create FILES       # id goes into wrangler.toml
    npx wrangler d1 migrations apply fsb-portal --remote
    npx wrangler secret put AUTH_SECRET          # long random string
    npx wrangler secret put SETUP_KEY            # one-time key for the setup screen
    npm run build
    npx wrangler deploy

Checks after deploy: https://fsb.apprifi.com/api/health returns ok; the home page shows the setup screen; after setup, /api/session shows the administrator.
