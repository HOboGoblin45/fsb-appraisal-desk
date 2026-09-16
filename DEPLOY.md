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
    npm run build
    npx wrangler deploy
    node provision.js admin --name "..." --email ...   # once the bank names its administrator

Checks after deploy: https://fsb.apprifi.com/api/health returns ok; the home page shows "Not yet in service" until the administrator is provisioned, then the sign-in screen; /api/session reports provisioned: true.
