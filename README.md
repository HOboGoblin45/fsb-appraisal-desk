# Appraisal Desk

The appraisal order, status, scheduling and delivery portal for a lender and its appraisers. One web address per lender, four staff roles, and a personal status page for each borrower and agent. Runs on Cloudflare Workers with a D1 database and KV document storage. First Security Bank's copy is https://fsb.apprifi.com; the demonstration is https://fsbdemo.apprifi.com.

## What this is, and is not

This is the appraiser's direct-lender order desk, offered to each lender the appraiser works with. It gives a community or commercial lender and its own appraiser the tools an appraisal management company's portal provides (one place to order, attach documents, schedule, watch status, ask questions, receive the report and invoice, and keep the record) without putting a management company between them. The lender engages the appraiser directly, sets nothing through a panel, and pays the appraiser directly; the software does not select appraisers, set or collect fees, or review reports, and the independence record says so on every order. It is not an AMC and is not designed to become one: the multiple-appraiser features exist so a firm with a supervising or second appraiser can run its own work, not so a lender can manage a rotating panel.

## Version 2: any lender

Every lender gets an isolated deployment (its own Worker, database, document store, hostname and secret) created by one command, and the lender's administrator controls the branding from inside the portal (name, tagline, colors, logo, time zone). Nothing in the code names a lender. What v2 added, each traced to the appraiser's own client correspondence:

Structured intake: product catalogue (URAR, condo, 2-4 unit, exterior-only, final inspection, manufactured, rent schedule, operating income, FHA, USDA-RD, VA, desk review, recertification, commercial narrative, farm and land, evaluation, retrospective, updated appraisal) with a hint of what the appraiser will need; loan type, valuation premise, occupancy, property type and unit count; parcel numbers; the lender's own reference; closing date, needed-by date and earliest inspection date; delivery format (PDF or PDF plus XML); multi-property group reference with a combined-report flag; intended use and lender requirements; access notes. The needed-by date defaults to the closing date on purchases.

Acceptance with a commitment: the appraiser accepts with a fee, an expected delivery date and a note, and the desk's notice carries all three. Multiple appraisers: the desk assigns or reassigns an order; each appraiser keeps a personal availability calendar that the borrower's booking page uses; notices go only to the assigned appraiser; a Mine filter for appraisers. Reviewer sub-state: the appraiser records when a draft goes to a reviewing or supervising appraiser, with the expected return date, comments and sign-off; the lender sees "With reviewer" instead of asking, and delivery is blocked while the reviewer has it. Preliminary figures: fee and an optional preliminary value released to the desk for closing figures, logged as preliminary. Revisions: the desk requests a revision by kind and description; the file returns to In review, the appraiser uploads and delivers the revised report, and the record numbers each revision. Payment: the desk records the check or ACH reference on an invoiced order; the appraiser is told; an Awaiting payment filter shows what is outstanding. Document requests: the appraiser (or desk) asks the borrower or agent for specific documents by text and email; the borrower uploads them on their status page and they land on the order. Reminders: each morning the portal nudges the appraiser about orders not accepted in a day, not scheduled in two, inspected but not logged, past the committed date, or idle for three days. Credentials: appraisers keep license and E&O numbers and dates on their profile; the administrator sees expiry warnings on the People tab.

## What it does

The appraisal desk places an order on one page and attests to recusal from the credit decision. The appraiser is notified, accepts or declines, and sends a scheduling request. The borrower (or agent, when access goes through the agent) receives a text and an email with a personal link and books the inspection against the appraiser's real availability. Everyone sees the same live status bar: Received, Accepted, Scheduling, Scheduled, Inspected, In review, Delivered, Invoiced. The appraiser uploads the report and invoice through the portal, the desk and loan officer download them, and the borrower gets a copy through the same personal link after agreeing to electronic delivery. Every step, message, document and download is written to an append-only independence record that exports as a text file.

## Who controls it

The portal was commissioned by First Security Bank, and the bank controls access. The bank names its portal administrator; the vendor (Apprifi) provisions that one account and hands the bank a single invitation link. From then on the administrator invites the bank's staff and the appraiser, assigns roles, suspends accounts and issues new sign-in links. The vendor holds no account inside the portal; it operates the infrastructure (Cloudflare account, deployments, backups) and can only re-issue the administrator's invitation at the bank's request.

Roles: Lender admin manages people and settings and can see every order. Appraisal desk places, edits and cancels orders, uploads documents and sends factual questions. Loan officer is read only and can download the finished report and invoice. Appraiser accepts, schedules, inspects, delivers, invoices and sets availability. Roles are assigned when a person is invited; nobody chooses their own.

## Going into service

1. The bank tells the vendor who its administrator is (name and work email). The vendor runs, from the deploying PC:

       node provision.js admin --name "Full Name" --email person@fsb1.com

   and sends the printed invitation link to that person. It works once and expires in seven days (`node provision.js reinvite --email ...` issues another). Until this happens the site shows "Not yet in service".
2. The administrator opens the link, chooses a password, and lands on the People tab. There they add each assistant, loan officer and the appraiser with a role. Each gets a one-time sign-in link; "Send by email" drafts the message. The same button resets a forgotten password later.
3. Under Bank settings the administrator can add shared or manager addresses to be copied on every desk notice.
4. The appraiser signs in and fills in Availability: name and callback number shown to borrowers, days and hours worked, inspection length, travel buffer, lead time and days off.
5. The desk places the first order and uploads the sales contract on the Documents tab.

## Email and texting

Every notice the portal composes is queued in the database and sent by the first delivery adapter that is configured; nothing depends on anyone remembering to press send. Email goes out as branded HTML (lender colors and name, the first link as a button) with a plain-text part. Until an adapter is configured, the Outbox still shows every message with an "Open in email app" or "Open in Messages" button that drafts it by hand and a "Mark as sent" button so the record shows who sent it.

Email adapters, in the order the server tries them:

1. Cloudflare Email Service, the recommended path because there is no key to manage. It requires the Workers Paid plan ($5 a month, which also raises the CPU limit and D1 restore window). In the Cloudflare dashboard open Compute, Email Service, Email Sending, choose Onboard Domain and pick apprifi.com; Cloudflare adds the SPF, DKIM, DMARC and bounce records itself. Then uncomment the two `[[send_email]]` lines in wrangler.toml, set `MAIL_FROM` under `[vars]` to an address on that domain, and redeploy.
2. Resend: create the account, verify the sending domain with the DNS records it gives you, and run `npx wrangler secret put RESEND_API_KEY` (free tier: 3,000 emails a month).
3. A JSON relay: `MAIL_HOOK_URL` (and optional `MAIL_HOOK_TOKEN`) posts `{from,to,subject,text,html,replyTo}` to a URL. The test suite uses this; a lender with its own transactional mail gateway can too.

Queued messages go out within seconds and retry every five minutes, up to six attempts, if the service is down. Two dispatchers can never send the same message twice: each row is claimed before it is sent.

Texts go through Twilio once `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and either `TWILIO_MESSAGING_SERVICE_SID` (preferred with A2P 10DLC) or `TWILIO_FROM` are set as secrets. US carriers require A2P 10DLC brand and campaign registration (or a verified toll-free number) before software may text; Twilio walks through it. In the Twilio console point the number's incoming-message webhook at `https://fsb.apprifi.com/api/hooks/twilio/inbound`; delivery reports arrive at `/api/hooks/twilio/status` automatically. Both endpoints check Twilio's signature. A reply of STOP records an opt-out and later texts to that number are held (marked "Opted out" in the Outbox, the email still goes); START lifts it. Carrier delivery states (delivered, undelivered with the error code) show on each text, and an undelivered text writes "call them instead" on the order's record.

Replies come back to the order. Every text from a borrower or agent is matched to their open order by phone number and posted on that order's Conversation tab, with the appraiser and the desk emailed. For email, set `MAIL_INBOUND` (for example `desk@fsb.apprifi.com`) and, under Email, Email Routing for apprifi.com, route that address (or a catch-all) to the `fsb-appraisal-desk` Worker. Notices then carry a reply-to of `desk+<order>@fsb.apprifi.com`; a reply lands on that order's conversation with the quoted history stripped, PDF or image attachments become documents on the order, and a staff member replying from their own inbox is posted under their own name. Anything that cannot be matched waits at the bottom of the Outbox screen as unmatched.

The administrator can prove delivery works at any time: Lender settings, Delivery and notifications, "Send me a test email" or "Send me a test text" sends to their own address and shows the provider's answer.

Other mail the portal sends when email is on: invitations (added people receive their sign-in link the moment they are saved; the link is still shown to the administrator), password resets ("Forgot your password?" on the sign-in page; a two-hour, single-use link; the sign-in page only offers it when email is configured), and feedback copies to the other administrators and to `VENDOR_EMAIL`.

## Conversation

Each order has one conversation. The desk and the administrator post to the appraiser; the appraiser posts to the desk; the desk or the appraiser can post to the borrower or agent (delivered as a text and an email with their personal link); the borrower or agent replies from their status page, by text, or by email. Loan officers read it but cannot post, which keeps loan production staff out of the appraiser's ear. Every entry is written to the independence record, unread entries are flagged on the board and on the tab, and the client sees only what was to or from them. The older `ask` and `reply` actions still work and land on the same conversation.

## Documents

PDF, images, XML (UAD), CSV, Word, Excel and ZIP up to 20 MB each. Each file is labelled by kind (sales contract, engagement letter, prior appraisal, survey, plans, appraisal report, invoice, addendum, other) and can be marked visible to the borrower and agent. Reports and addenda uploaded by the appraiser are client-visible by default and become downloadable by the borrower only after delivery and after the borrower has agreed to electronic delivery on their page. Loan officers can open reports, addenda and invoices only. Removing a document hides it from the order but keeps the bytes for the record.

Every upload is checked against its extension (a text file renamed .pdf, or a file without the PDF, PNG, JPEG, WebP, HEIC or ZIP signature, is refused), stored under a random key, and served only as an attachment with a sandbox content-security policy and nosniff, so nothing uploaded can run in a browser. Staff downloads of the other side's documents are logged on the record (the appraiser opening their own report is not). Borrower links open only client-visible files, only after delivery and consent.

Storage is Workers KV (1 GB on the free plan, roughly 100 to 300 appraisal files). To move to R2 for unlimited storage, enable R2 on the Cloudflare account, create a bucket named fsb-portal-docs, uncomment the r2_buckets block in wrangler.toml and redeploy. New uploads go to R2; existing files keep working from KV because each document records where it lives.

## The demonstration copy

https://fsbdemo.apprifi.com is the same code deployed as a second Worker (`--env demo`) with its own database and storage. It carries a DEMO flag: a banner, one-click sign-in as any role (password FSBdemo-2026 for every sample account), messages marked composed rather than sent, a "Reset the demonstration" item in the menu, and a cron at 08:00 UTC that reloads the sample data every night. The seed (`src/demo.js`) replays eight fictional orders through the real order and action code, so every event, message and client link is genuine. Anyone with the link can use it; nothing in it is real and nothing leaves it. Deploy changes to it with `npm run build && npx wrangler deploy --env demo`; reload its data at any time with a POST to /api/demo/reset while signed in.

## Limits worth knowing

Sessions: signing in on a new device does not sign out the others; changing a password does, and so does a password reset. Password reset requests are limited to three an hour per address. Client status pages accept up to 40 messages and 30 uploads a day per link.

Cloudflare's free Workers plan allows 100,000 requests a day and 10 milliseconds of CPU per request. Sign-in uses PBKDF2 with 100,000 iterations, which is the most the platform allows; if sign-in ever fails with a CPU limit error, move the account to the Workers Paid plan ($5 a month), which also raises every other limit. D1 holds 5 GB. Sessions last 14 days of inactivity. Invitations last 7 days. Sign-in is rate limited to 10 attempts per email and 30 per address every 15 minutes.

## Platform features used (2026)

The app uses the parts of the 2026 web platform that are safe in every current browser, each with a fallback: native `<dialog closedby="any">` for every sheet (focus trapped, Escape and outside clicks close it, page inert underneath); `contrast-color()` so text on a lender's chosen primary and accent colors is always legible, with a luminance fallback computed in JavaScript for browsers without it; CSS anchor positioning for the account menu; `field-sizing: content` so text boxes grow with what is typed; `text-wrap: balance` and `pretty` for headings and prose; same-document view transitions for section changes, disabled under reduced-motion. Glassmorphism, customizable selects and CSS carousels were deliberately not adopted.

## Adding a lender

From the repository on the deploying PC, after `npx wrangler login`:

    node lender.js new --slug prairie --name "Prairie Community Bank" --domain prairie.apprifi.com --tagline "Pontiac and Fairbury" --tz America/Chicago
    node provision.js admin --env prairie --name "Full Name" --email person@lender.com

The first command creates the database and document store, appends an `[env.prairie]` block to wrangler.toml, applies the schema, sets a fresh AUTH_SECRET and deploys to the hostname (the hostname must be a name in a zone on the same Cloudflare account). The second issues the lender's administrator invitation. The administrator sets the logo and colors under Lender branding. Later code changes go out with `node lender.js deploy --slug prairie`. Each lender's data never shares a database or store with another lender's.

## Deploying changes

The whole application is in this repository. `src/core.js` holds the state machine, permissions, slot generation and message wording, shared by the server and the browser. `src/worker.js` is the API. `src/app.src.js`, `src/app.css` and `src/index.html` are the browser app; `node build.js` assembles them into `public/`. `migrations/` holds the database schema.

    npm install
    npx wrangler login                      # once per PC
    npm run build
    npx wrangler d1 migrations apply fsb-portal --remote   # after any new migration
    npx wrangler deploy

Secrets are never in the repository: AUTH_SECRET (required, signs sessions and peppers passwords; changing it signs everyone out and invalidates all passwords), RESEND_API_KEY (only if not using Cloudflare Email Service), TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM, MAIL_HOOK_TOKEN. Set each with `npx wrangler secret put NAME` (add `--env demo` for the demonstration copy, which never sends anyway).

`node provision.js status` shows how many accounts and orders the production database holds without opening anything else.

To run locally: `npx wrangler d1 migrations apply fsb-portal --local`, then `npm run dev`, then open http://127.0.0.1:8787. `node test/api.js` then `node test/v2.js` run the API suites against it (84 and 39 checks). `./devmail.sh` starts a copy on port 8789 with every delivery adapter pointed at the in-process sink in `test/sink.js`; `node test/backend.js` then runs 95 checks covering real sending, HTML mail, invitations and resets by email, Twilio webhooks and signatures, STOP and START, replies by text and by email (through wrangler's local `/cdn-cgi/handler/email` endpoint), attachments, the conversation, feedback copies, test sends, upload content checks, download headers and record entries, relay outages and retries, and password changes signing out other devices.

## Backups

D1 can restore the database to any minute in the last 7 days on the free plan, or 30 days on the Workers Paid plan (the plan that also enables automatic email). `npx wrangler d1 export fsb-portal --remote --output backup.sql` writes a full SQL dump; run it monthly and keep the file with the bank's records. Documents in KV are not included in the SQL dump; the independence record for each order lists every document and who uploaded it.

## Records and compliance notes

The independence record for an order (Record tab, Export) lists who ordered it and under what role, the recusal attestation with its timestamp, every status change, message with its delivery status, document and client download. Identities are authenticated accounts with administrator-assigned roles. Retain exports with the loan file. The appraiser's own workfile retention under USPAP is separate and remains the appraiser's responsibility.
