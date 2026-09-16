# FSB Appraisal Desk

The appraisal order, status, scheduling and delivery portal for First Security Bank and its appraiser. One web address, four staff roles, and a personal status page for each borrower and agent. Runs on Cloudflare Workers with a D1 database and KV document storage, at https://fsb.apprifi.com.

## What it does

The appraisal desk places an order on one page and attests to recusal from the credit decision. The appraiser is notified, accepts or declines, and sends a scheduling request. The borrower (or agent, when access goes through the agent) receives a text and an email with a personal link and books the inspection against the appraiser's real availability. Everyone sees the same live status bar: Received, Accepted, Scheduling, Scheduled, Inspected, In review, Delivered, Invoiced. The appraiser uploads the report and invoice through the portal, the desk and loan officer download them, and the borrower gets a copy through the same personal link after agreeing to electronic delivery. Every step, message, document and download is written to an append-only independence record that exports as a text file.

## Roles

Bank admin manages people and can see every order. Appraisal desk places, edits and cancels orders, uploads documents and sends factual questions. Loan officer is read only and can download the finished report and invoice. Appraiser accepts, schedules, inspects, delivers, invoices and sets availability. Roles are assigned by the administrator when a person is invited; nobody chooses their own.

## First day

1. Open https://fsb.apprifi.com. On a fresh installation it shows a setup screen. Enter the setup key that was shown at deployment, your name, work email and a password. That account is the bank administrator.
2. On the People tab, add each assistant, loan officer and the appraiser with their role. Each one gets a one-time sign-in link that lasts seven days. Copy it or use "Send by email" to draft the message, and send it to them. The same button issues a new link if someone forgets their password.
3. The appraiser signs in and fills in Availability: name and callback number shown to borrowers, days and hours worked, inspection length, travel buffer, lead time and days off.
4. The desk places the first order and uploads the sales contract on the Documents tab.

## Email and texting

Until an email service key is added, nothing is sent automatically. Every message the system composes appears in the Outbox with its real wording and an "Open in email app" button that drafts it in Outlook or Gmail; press send there, then "Mark as sent" so the record shows who sent it. Texts have an "Open in Messages" button that drafts the text on a phone. Notices to bank staff and the appraiser are not queued while email is off, because they see the same live board.

To turn on automatic email: create a Resend account (resend.com), verify the sending domain by adding the DNS records it gives you to the apprifi.com zone in Cloudflare, create an API key, then on the PC that deploys this project run

    npx wrangler secret put RESEND_API_KEY

and paste the key. Optionally set MAIL_FROM and MAIL_REPLY_TO in wrangler.toml under [vars] and redeploy. From then on queued messages go out within seconds and retry every five minutes for up to half an hour if the mail service is down.

To turn on automatic texting: complete A2P 10DLC brand and campaign registration with Twilio (several weeks), then set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM the same way.

## Documents

PDF, images, XML (UAD), CSV, Word, Excel and ZIP up to 20 MB each. Each file is labelled by kind (sales contract, engagement letter, prior appraisal, survey, plans, appraisal report, invoice, addendum, other) and can be marked visible to the borrower and agent. Reports and addenda uploaded by the appraiser are client-visible by default and become downloadable by the borrower only after delivery and after the borrower has agreed to electronic delivery on their page. Loan officers can open reports, addenda and invoices only. Removing a document hides it from the order but keeps the bytes for the record.

Storage is Workers KV (1 GB on the free plan, roughly 100 to 300 appraisal files). To move to R2 for unlimited storage, enable R2 on the Cloudflare account, create a bucket named fsb-portal-docs, uncomment the r2_buckets block in wrangler.toml and redeploy. New uploads go to R2; existing files keep working from KV.

## Limits worth knowing

Cloudflare's free Workers plan allows 100,000 requests a day and 10 milliseconds of CPU per request. Sign-in uses PBKDF2 with 100,000 iterations, which is the most the platform allows; if sign-in ever fails with a CPU limit error, move the account to the Workers Paid plan ($5 a month), which also raises every other limit. D1 holds 5 GB. Sessions last 14 days of inactivity. Invitations last 7 days. Sign-in is rate limited to 10 attempts per email and 30 per address every 15 minutes.

## Deploying changes

The whole application is in this repository. `src/core.js` holds the state machine, permissions, slot generation and message wording, shared by the server and the browser. `src/worker.js` is the API. `src/app.src.js`, `src/app.css` and `src/index.html` are the browser app; `node build.js` assembles them into `public/`. `migrations/` holds the database schema.

    npm install
    npx wrangler login                      # once per PC
    npm run build
    npx wrangler d1 migrations apply fsb-portal --remote   # after any new migration
    npx wrangler deploy

Secrets are never in the repository: AUTH_SECRET (required, signs sessions and peppers passwords; changing it signs everyone out and invalidates all passwords), SETUP_KEY (optional, protects the first-run setup screen), RESEND_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM.

To run locally: `npx wrangler d1 migrations apply fsb-portal --local`, then `npm run dev`, then open http://127.0.0.1:8787. `node test/api.js` runs the API suite against it.

## Backups

D1 keeps 30 days of point-in-time history on every plan. `npx wrangler d1 export fsb-portal --remote --output backup.sql` writes a full SQL dump; run it monthly and keep the file with the bank's records. Documents in KV are not included in the SQL dump; the independence record for each order lists every document and who uploaded it.

## Records and compliance notes

The independence record for an order (Record tab, Export) lists who ordered it and under what role, the recusal attestation with its timestamp, every status change, message with its delivery status, document and client download. Identities are authenticated accounts with administrator-assigned roles. Retain exports with the loan file. The appraiser's own workfile retention under USPAP is separate and remains the appraiser's responsibility.
