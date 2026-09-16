#!/usr/bin/env node
/* Vendor-side provisioning for the FSB Appraisal Desk.
   The bank decides who administers the portal; this creates that person's account and a one-time
   invitation link. Nothing here runs inside the app, and the vendor holds no account in it.

   node provision.js admin --name "Ryan Curtis" --email ryan@example.com [--phone "(309) 555-0100"] [--local]
   node provision.js status [--local]
   node provision.js reinvite --email ryan@example.com [--local]
*/
import {createHash, randomBytes} from "node:crypto";
import {readFileSync, writeFileSync, unlinkSync} from "node:fs";
import {spawnSync} from "node:child_process";

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (k) => { const i = args.indexOf("--" + k); return i > -1 ? args[i + 1] : undefined; };
const local = args.includes("--local");
const DB = "fsb-portal";

function die(msg) { console.error(msg); process.exit(1); }
function q(v) { return "'" + String(v).replace(/'/g, "''") + "'"; }
function token(n) { const a = "abcdefghjkmnpqrstuvwxyz23456789", b = randomBytes(n); let o = ""; for (let i = 0; i < n; i++) o += a[b[i] % a.length]; return o; }
function sha256(s) { return createHash("sha256").update(s, "utf8").digest("hex"); }
function publicUrl() {
  if (opt("url")) return opt("url").replace(/\/$/, "");
  if (local) return "http://127.0.0.1:8787";
  const m = /PUBLIC_URL\s*=\s*"([^"]+)"/.exec(readFileSync("wrangler.toml", "utf8"));
  return m ? m[1].replace(/\/$/, "") : die("PUBLIC_URL not found in wrangler.toml; pass --url");
}
/* Reads go through --command (remote --file returns only an import summary); writes go through --file. */
function d1(sql, read) {
  const file = ".provision.sql";
  const args = ["wrangler", "d1", "execute", DB, local ? "--local" : "--remote", "--json"];
  if (read) args.push("--command", '"' + sql.replace(/"/g, "'") + '"'); else { writeFileSync(file, sql); args.push("--file", file); }
  try {
    const r = spawnSync("npx", args, {encoding: "utf8", shell: true});
    if (r.status !== 0) die("wrangler failed:\n" + (r.stderr || r.stdout));
    const start = r.stdout.indexOf("["), end = r.stdout.lastIndexOf("]");
    return start > -1 ? JSON.parse(r.stdout.slice(start, end + 1)) : [];
  } finally { if (!read) try { unlinkSync(file); } catch (e) {} }
}
function results(out) { return (out[0] && out[0].results) || []; }

if (cmd === "status") {
  const out = d1("SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM users WHERE role='admin' AND active=1) AS admins, (SELECT COUNT(*) FROM orders) AS orders, (SELECT MAX(at) FROM events) AS last_event", true);
  console.log(results(out)[0] || out);
  process.exit(0);
}
if (cmd === "admin" || cmd === "reinvite") {
  const email = String(opt("email") || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) die("A valid --email is required.");
  const name = String(opt("name") || "").trim();
  if (cmd === "admin" && !name) die("--name is required.");
  const now = new Date().toISOString();
  const code = token(28), hash = sha256(code);
  const expires = new Date(Date.now() + 7 * 864e5).toISOString();
  const existing = results(d1("SELECT id, name, role FROM users WHERE email=" + q(email), true))[0];
  let id, stmts = [];
  if (existing) {
    id = existing.id;
    if (cmd === "admin") stmts.push("UPDATE users SET role='admin', active=1, name=" + q(name) + ", updated_at=" + q(now) + " WHERE id=" + q(id) + ";");
  } else {
    if (cmd === "reinvite") die("No account with that email. Use: node provision.js admin --name ... --email ...");
    id = "u" + Date.now().toString(36) + token(6);
    stmts.push("INSERT INTO users (id,email,name,role,phone,active,created_at,created_by,updated_at) VALUES (" +
      [q(id), q(email), q(name), "'admin'", q(String(opt("phone") || "").trim()), "1", q(now), "'vendor provisioning'", q(now)].join(",") + ");");
  }
  stmts.push("UPDATE invites SET used_at=" + q(now) + " WHERE user_id=" + q(id) + " AND used_at IS NULL;");
  stmts.push("INSERT INTO invites (code_hash,user_id,created_by,created_at,expires_at) VALUES (" + [q(hash), q(id), "'vendor provisioning'", q(now), q(expires)].join(",") + ");");
  stmts.push("INSERT INTO audit (at,who,what) VALUES (" + [q(now), "'Vendor'", q((existing ? "Reissued the administrator invitation for " : "Provisioned the bank administrator account for ") + (name || existing.name) + " (" + email + ") as designated by the bank.")].join(",") + ");");
  d1(stmts.join("\n"));
  const link = publicUrl() + "/#invite=" + code;
  console.log("\nAdministrator: " + (name || existing.name) + " <" + email + ">" + (existing ? " (existing account)" : ""));
  console.log("Invitation link (works once, expires " + expires.slice(0, 10) + "):\n\n  " + link + "\n");
  console.log("Send that link to the bank's designated administrator. They choose a password, then invite their own staff and the appraiser from the People tab.");
  process.exit(0);
}
die("Usage:\n  node provision.js admin --name \"Full Name\" --email person@bank.com [--phone ...] [--local]\n  node provision.js reinvite --email person@bank.com [--local]\n  node provision.js status [--local]");
