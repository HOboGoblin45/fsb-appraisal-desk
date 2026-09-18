#!/usr/bin/env node
/* Stand up Apprifi for a new lender: its own Worker environment, database, document store, hostname and
   identity, fully isolated from every other lender. Run from the repository on the deploying PC after
   `npx wrangler login`.

   node lender.js new --slug prairie --name "Prairie Community Bank" --domain prairie.apprifi.com \
        [--tagline "Pontiac and Fairbury"] [--tz America/Chicago] [--primary "#0b5d3b"] [--accent "#8a1c1c"] \
        [--email-domain prairiebank.com] [--type lender|firm|wealth]
   Then: node provision.js admin --env prairie --name "..." --email ...   (the lender's designated administrator)
   And, once, in the Cloudflare dashboard under Email Routing for apprifi.com: a rule sending desk-prairie@apprifi.com
   to the Worker appraisal-desk-prairie, so replies to notices land on the order.
   --email-domain adds the lender to the public site's sign-in router (site/lenders.json) and redeploys the site.
   Later: node lender.js deploy --slug prairie   (after any code change)
*/
import {readFileSync, writeFileSync, existsSync, appendFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {randomBytes} from "node:crypto";

const args = process.argv.slice(2), cmd = args[0];
const opt = k => { const i = args.indexOf("--" + k); return i > -1 ? args[i + 1] : undefined; };
function die(m) { console.error(m); process.exit(1); }
function run(cmdline, quiet) {
  const r = spawnSync(cmdline, {encoding: "utf8", shell: true, stdio: quiet ? "pipe" : ["inherit", "pipe", "pipe"]});
  if (r.status !== 0) die("Command failed: " + cmdline + "\n" + (r.stderr || "") + (r.stdout || ""));
  return (r.stdout || "") + (r.stderr || "");
}
const slug = String(opt("slug") || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
if (!slug) die("--slug is required (letters, digits, dashes).");

if (cmd === "deploy") {
  run("node build.js"); run("npx wrangler deploy --env " + slug); process.exit(0);
}
if (cmd !== "new") die("Usage: node lender.js new --slug x --name \"...\" --domain x.example.com | node lender.js deploy --slug x");

const name = String(opt("name") || "").trim(), domain = String(opt("domain") || "").trim().toLowerCase();
if (!name || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) die("--name and a valid --domain are required.");
const tz = opt("tz") || "America/Chicago", tagline = opt("tagline") || "", primary = opt("primary") || "", accent = opt("accent") || "", emailDomain = String(opt("email-domain") || "").toLowerCase(), ctype = ["lender", "firm", "wealth"].includes(opt("type")) ? opt("type") : "lender";
const toml = readFileSync("wrangler.toml", "utf8");
if (toml.includes("[env." + slug + "]")) die("[env." + slug + "] already exists in wrangler.toml. Use: node lender.js deploy --slug " + slug);

console.log("Creating the database and document store for " + name + " ...");
const d1 = run("npx wrangler d1 create appraisal-desk-" + slug, true);
const d1id = (/database_id\s*=\s*"([0-9a-f-]+)"/.exec(d1) || [])[1] || die("Could not read the D1 id:\n" + d1);
const kv = run("npx wrangler kv namespace create FILES_" + slug.toUpperCase().replace(/-/g, "_"), true);
const kvid = (/id\s*=\s*"([0-9a-f]+)"/.exec(kv) || [])[1] || die("Could not read the KV id:\n" + kv);
run("npx wrangler r2 bucket create appraisal-desk-" + slug, true);
const q = v => '"' + String(v).replace(/"/g, "'") + '"';
const block = `
# ---------------------------------------------------------------------------
# ${name}: https://${domain}. Deploy with: node lender.js deploy --slug ${slug}
[env.${slug}]
name = "appraisal-desk-${slug}"
workers_dev = false
routes = [
  { pattern = ${q(domain)}, custom_domain = true }
]

[env.${slug}.assets]
directory = "./public"
binding = "ASSETS"
not_found_handling = "single-page-application"
run_worker_first = ["/api/*", "/f/*", "/brand/*"]

[env.${slug}.vars]
PUBLIC_URL = ${q("https://" + domain)}
LENDER_NAME = ${q(name)}
LENDER_TAGLINE = ${q(tagline)}
CLIENT_TYPE = ${q(ctype)}
${primary ? "LENDER_PRIMARY = " + q(primary) + "\n" : ""}${accent ? "LENDER_ACCENT = " + q(accent) + "\n" : ""}TIMEZONE = ${q(tz)}
VENDOR_EMAIL = "crescicharles@gmail.com"
MAIL_FROM = ${q(name + " via Apprifi <no-reply@apprifi.com>")}
MAIL_INBOUND = ${q("desk-" + slug + "@apprifi.com")}

[[env.${slug}.send_email]]
name = "EMAIL"

[[env.${slug}.r2_buckets]]
binding = "BUCKET"
bucket_name = "appraisal-desk-${slug}"

[[env.${slug}.d1_databases]]
binding = "DB"
database_name = "appraisal-desk-${slug}"
database_id = "${d1id}"
migrations_dir = "migrations"

[[env.${slug}.kv_namespaces]]
binding = "FILES"
id = "${kvid}"

[env.${slug}.triggers]
crons = ["*/5 * * * *"]
`;
appendFileSync("wrangler.toml", block);
console.log("Applying the schema ...");
run("npx wrangler d1 migrations apply appraisal-desk-" + slug + " --remote --env " + slug, true);
console.log("Setting the session secret ...");
const secret = randomBytes(36).toString("base64url");
const sr = spawnSync("npx", ["wrangler", "secret", "put", "AUTH_SECRET", "--env", slug], {input: secret, encoding: "utf8", shell: true});
if (sr.status !== 0) die("Could not set AUTH_SECRET:\n" + sr.stderr + sr.stdout);
console.log("Deploying ...");
run("node build.js", true); run("npx wrangler deploy --env " + slug, true);
if (emailDomain) {
  const lp = "site/lenders.json", list = existsSync(lp) ? JSON.parse(readFileSync(lp, "utf8")) : [];
  if (!list.some(l => l.slug === slug)) list.push({slug, name, portal: "https://" + domain, domains: [emailDomain]});
  writeFileSync(lp, JSON.stringify(list, null, 2) + "\n");
  console.log("Added " + emailDomain + " to the public sign-in router; deploying the site ...");
  run("npx wrangler deploy -c site/wrangler.toml", true);
}
console.log("\n" + name + " is live at https://" + domain + " (the certificate can take a few minutes).");
console.log("Next: the lender names its administrator, then run\n  node provision.js admin --env " + slug + " --name \"Full Name\" --email person@lender.com\nand send them the printed link. The administrator uploads the logo under Lender branding.");
