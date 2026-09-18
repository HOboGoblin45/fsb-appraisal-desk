/* Appraisal Desk: Cloudflare Worker.
   Serves the app (static assets) and the JSON API. D1 holds orders, people, the audit log and
   the message queue; KV (or R2) holds document bytes. Sessions are HttpOnly cookies backed by D1.
   Nothing here trusts the browser: every transition is re-validated by CORE.applyAction. */
import CORE from "./core.js";
import {resetDemo} from "./demo.js";
import PostalMime from "postal-mime";

const COOKIE = "fsb_session";
/* The product identity. Lenders are shown as the client beside it and may add their own logo and colors. */
const APPRIFI = {product: "Apprifi", primary: "#12324f", accent: "#d4652a", site: "https://apprifi.com"};
const SESSION_DAYS = 14;
const INVITE_DAYS = 7;
const MAX_FILE = 20 * 1024 * 1024;
const MAX_JSON = 256 * 1024;
const PBKDF2_ITER_DEFAULT = 100000;
const TYPES = {pdf:"application/pdf",png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",webp:"image/webp",heic:"image/heic",
  csv:"text/csv",txt:"text/plain",md:"text/markdown",json:"application/json",xml:"application/xml",
  docx:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",zip:"application/zip"};

/* ---------- small helpers ---------- */
const enc = new TextEncoder();
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {status, headers: {"content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra}});
}
class ApiError extends Error { constructor(status, code, msg) { super(msg); this.status = status; this.code = code; } }
const bad = (msg, code = "bad") => new ApiError(400, code, msg);
const denied = (msg = "Not allowed for your role.") => new ApiError(403, "forbidden", msg);
const notFound = (msg = "Not found.") => new ApiError(404, "not_found", msg);
function nowISO() { return new Date().toISOString(); }
function hex(buf) { return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join(""); }
async function sha256(s) { return hex(await crypto.subtle.digest("SHA-256", enc.encode(s))); }
function randomToken(n = 24) {
  const a = "abcdefghjkmnpqrstuvwxyz23456789", bytes = crypto.getRandomValues(new Uint8Array(n));
  let o = ""; for (let i = 0; i < n; i++) o += a[bytes[i] % a.length]; return o;
}
function uid(prefix = "o") { return prefix + Date.now().toString(36) + randomToken(6); }
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0;
}
async function pbkdf2(password, saltHex, iter, pepper) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pepper + "\u0000" + password), "PBKDF2", false, ["deriveBits"]);
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
  return hex(await crypto.subtle.deriveBits({name: "PBKDF2", hash: "SHA-256", salt, iterations: iter}, key, 256));
}
function getCookie(req, name) {
  const c = req.headers.get("cookie") || "";
  const m = c.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}
function cookieHeader(req, value, maxAge) {
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
async function readJSON(req) {
  const len = Number(req.headers.get("content-length") || 0);
  if (len > MAX_JSON) throw bad("Request too large.");
  const text = await req.text();
  if (text.length > MAX_JSON) throw bad("Request too large.");
  try { return text ? JSON.parse(text) : {}; } catch (e) { throw bad("Malformed JSON."); }
}
const s = (v, n = 200) => String(v == null ? "" : v).trim().slice(0, n);
const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
function ip(req) { return req.headers.get("cf-connecting-ip") || "local"; }

/* ---------- rate limiting (D1, fixed window) ---------- */
async function limited(env, key, max, windowMs) {
  const now = Date.now();
  const row = await env.DB.prepare("SELECT count, window_start FROM ratelimit WHERE key=?").bind(key).first();
  if (!row || now - row.window_start > windowMs) {
    await env.DB.prepare("INSERT INTO ratelimit (key,count,window_start) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=1, window_start=excluded.window_start").bind(key, now).run();
    return false;
  }
  if (row.count >= max) return true;
  await env.DB.prepare("UPDATE ratelimit SET count=count+1 WHERE key=?").bind(key).run();
  return false;
}

/* ---------- brand (white label) ---------- */
function defaultBrand(env) {
  // Apprifi is the product; the lender is the client shown beside it. A lender may add its own logo and colors.
  return {name: env.LENDER_NAME || "Your Lender", short: env.LENDER_SHORT || "", tagline: env.LENDER_TAGLINE || "", primary: env.LENDER_PRIMARY || APPRIFI.primary,
    accent: env.LENDER_ACCENT || APPRIFI.accent, timeZone: env.TIMEZONE || CORE.TZ, logo: env.LENDER_LOGO ? "/" + env.LENDER_LOGO : "", supportLine: "", productName: APPRIFI.product,
    site: APPRIFI.site};
}
async function loadBrand(env) {
  const b = defaultBrand(env);
  const row = await env.DB.prepare("SELECT value FROM config WHERE key='brand'").first();
  if (row) { try { Object.assign(b, JSON.parse(row.value)); } catch (e) {} }
  if (b.logoKey) b.logo = "/brand/logo?v=" + (b.logoVersion || 1);
  return b;
}
function cleanBrand(input, prev) {
  const b = {...prev};
  const hex = v => /^#[0-9a-fA-F]{6}$/.test(String(v || "")) ? String(v).toLowerCase() : null;
  if (input.name !== undefined) b.name = s(input.name, 80) || prev.name;
  if (input.short !== undefined) b.short = s(input.short, 20);
  if (input.tagline !== undefined) b.tagline = s(input.tagline, 160);
  if (input.supportLine !== undefined) b.supportLine = s(input.supportLine, 200);
  if (input.productName !== undefined) b.productName = s(input.productName, 40) || APPRIFI.product;
  if (hex(input.primary)) b.primary = hex(input.primary);
  if (hex(input.accent)) b.accent = hex(input.accent);
  if (input.timeZone !== undefined) { try { new Intl.DateTimeFormat("en-US", {timeZone: String(input.timeZone)}); b.timeZone = String(input.timeZone); } catch (e) { throw bad("Unknown time zone."); } }
  return b;
}

/* ---------- config ---------- */
/* Availability: a global record plus an optional per-appraiser record (key availability:<userId>) that wins for that appraiser's orders. */
async function loadConfig(env, appraiserId) {
  const c = CORE.defaultConfig();
  const rows = (await env.DB.prepare("SELECT key, value, updated_at FROM config WHERE key IN ('availability', ?, 'brand')").bind("availability:" + (appraiserId || "-")).all()).results || [];
  const byKey = {}; rows.forEach(r => byKey[r.key] = r);
  if (byKey.availability) { try { Object.assign(c, JSON.parse(byKey.availability.value)); c.updatedAt = byKey.availability.updated_at; } catch (e) {} }
  const own = byKey["availability:" + appraiserId];
  if (appraiserId && own) { try { const v = JSON.parse(own.value); delete v.deskCopyEmails; Object.assign(c, v); c.perAppraiser = true; } catch (e) {} }
  const brand = defaultBrand(env); if (byKey.brand) { try { Object.assign(brand, JSON.parse(byKey.brand.value)); } catch (e) {} }
  c.lenderName = brand.name; c.timeZone = brand.timeZone || CORE.TZ; c.brand = brand;
  return c;
}
function cleanConfig(input) {
  const c = CORE.defaultConfig();
  const n = (k, lo, hi, d) => { const v = Number(input[k]); c[k] = isFinite(v) && v >= lo && v <= hi ? v : d; };
  n("startHour", 5, 12, 8.5); n("endHour", 12, 21, 16); n("slotMinutes", 15, 240, 60); n("bufferMinutes", 0, 180, 45); n("leadHours", 0, 168, 24);
  c.days = Array.isArray(input.days) ? input.days.map(Number).filter(d => d >= 0 && d <= 6) : [1, 2, 3, 4, 5];
  c.daysOff = Array.isArray(input.daysOff) ? input.daysOff.map(x => s(x, 10)).filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x)).slice(0, 200) : [];
  c.appraiserName = s(input.appraiserName, 80); c.appraiserPhone = s(input.appraiserPhone, 40); c.appraiserEmail = s(input.appraiserEmail, 120).toLowerCase();
  c.note = s(input.note, 500);
  c.deskCopyEmails = Array.isArray(input.deskCopyEmails) ? input.deskCopyEmails.map(x => s(x, 120).toLowerCase()).filter(emailOk).slice(0, 20) : [];
  return c;
}

/* ---------- auth ---------- */
async function currentUser(env, req) {
  const raw = getCookie(req, COOKIE);
  if (!raw) return null;
  const h = await sha256(raw);
  const row = await env.DB.prepare(
    "SELECT s.expires_at, s.last_seen, u.id, u.email, u.name, u.role, u.phone, u.active FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id_hash=?").bind(h).first();
  if (!row) return null;
  if (row.expires_at < nowISO() || !row.active) { await env.DB.prepare("DELETE FROM sessions WHERE id_hash=?").bind(h).run(); return null; }
  const user = {id: row.id, email: row.email, name: row.name, role: row.role, phone: row.phone || ""};
  if (!row.last_seen || Date.now() - Date.parse(row.last_seen) > 10 * 60e3) {
    const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE sessions SET last_seen=?, expires_at=? WHERE id_hash=?").bind(nowISO(), exp, h),
      env.DB.prepare("UPDATE users SET last_seen=? WHERE id=?").bind(nowISO(), row.id)
    ]);
  }
  return user;
}
async function startSession(env, req, userId) {
  const raw = randomToken(40), h = await sha256(raw);
  const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  await env.DB.prepare("INSERT INTO sessions (id_hash,user_id,created_at,expires_at,last_seen,ua) VALUES (?,?,?,?,?,?)")
    .bind(h, userId, nowISO(), exp, nowISO(), s(req.headers.get("user-agent"), 200)).run();
  return cookieHeader(req, raw, SESSION_DAYS * 86400);
}
function checkPassword(password) {
  if (typeof password !== "string" || password.length < 10) throw bad("Use a password of at least 10 characters.");
  if (password.length > 200) throw bad("That password is too long.");
}
async function setPassword(env, userId, password) {
  checkPassword(password);
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  const iter = Number(env.PBKDF2_ITER) || PBKDF2_ITER_DEFAULT;
  const h = await pbkdf2(password, salt, iter, env.AUTH_SECRET);
  await env.DB.prepare("UPDATE users SET pw_hash=?, pw_salt=?, pw_iter=?, updated_at=? WHERE id=?").bind(h, salt, iter, nowISO(), userId).run();
}
function requireSecret(env) {
  if (!env.AUTH_SECRET || String(env.AUTH_SECRET).length < 16) throw new ApiError(500, "config", "AUTH_SECRET is not set on the server. Run: npx wrangler secret put AUTH_SECRET");
}
function pubUser(u) { return {id: u.id, name: u.name, email: u.email, role: u.role, phone: u.phone || ""}; }

/* ---------- orders ---------- */
function rowToOrder(r) {
  const o = JSON.parse(r.data);
  o.id = r.id; o.version = r.version; o.step = r.step; o.hold = !!r.hold; o.declined = !!r.declined; o.cancelled = !!r.cancelled;
  o.tokB = r.tok_b; o.tokA = r.tok_a; o.apptStart = r.appt_start || null; o.createdAt = r.created_at; o.updatedAt = r.updated_at;
  if (r.assigned_to && !o.assignedTo) o.assignedTo = r.assigned_to;
  return o;
}
function orderFields(o) {
  // columns kept outside the JSON blob, for indexes and the list view
  return [o.step | 0, o.hold ? 1 : 0, o.declined ? 1 : 0, o.cancelled ? 1 : 0, o.apptStart || null, o.updatedAt];
}
async function getOrderRow(env, id) {
  return env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(id).first();
}
async function listOrders(env, since) {
  const q = since
    ? env.DB.prepare("SELECT * FROM orders WHERE updated_at > ? ORDER BY created_at DESC").bind(since)
    : env.DB.prepare("SELECT * FROM orders ORDER BY created_at DESC");
  const rows = (await q.all()).results || [];
  const orders = rows.map(rowToOrder);
  if (!orders.length) return orders;
  const dc = (await env.DB.prepare("SELECT order_id, COUNT(*) n, SUM(kind='report') r FROM docs WHERE deleted_at IS NULL GROUP BY order_id").all()).results || [];
  const mc = (await env.DB.prepare("SELECT order_id, COUNT(*) n FROM messages WHERE status IN ('manual','failed') GROUP BY order_id").all()).results || [];
  const dm = {}, mm = {};
  dc.forEach(x => dm[x.order_id] = x); mc.forEach(x => mm[x.order_id] = x.n);
  orders.forEach(o => { o.docCount = dm[o.id] ? dm[o.id].n : 0; o.hasReport = !!(dm[o.id] && dm[o.id].r); o.unsent = mm[o.id] || 0; });
  return orders;
}
async function orderDetail(env, o) {
  const [docs, events, msgs] = await Promise.all([
    env.DB.prepare("SELECT id,name,size,type,kind,client_visible,uploaded_by,uploaded_role,uploaded_at FROM docs WHERE order_id=? AND deleted_at IS NULL ORDER BY uploaded_at").bind(o.id).all(),
    env.DB.prepare("SELECT at,who,role,what FROM events WHERE order_id=? ORDER BY id").bind(o.id).all(),
    env.DB.prepare("SELECT id,created_at,channel,party,to_name,to_addr,subject,body,template,status,attempts,last_error,sent_at,sent_by,provider_id,delivery,delivery_at FROM messages WHERE order_id=? ORDER BY created_at, id").bind(o.id).all()
  ]);
  o.docs = (docs.results || []).map(d => ({...d, client_visible: !!d.client_visible}));
  o.hasReport = o.docs.some(d => d.kind === "report");
  o.events = events.results || [];
  o.messages = msgs.results || [];
  return o;
}
async function bookedStarts(env, exceptId, appraiserId) {
  const q = appraiserId
    ? env.DB.prepare("SELECT appt_start FROM orders WHERE appt_start IS NOT NULL AND cancelled=0 AND declined=0 AND id<>? AND (assigned_to=? OR assigned_to='')").bind(exceptId || "", appraiserId)
    : env.DB.prepare("SELECT appt_start FROM orders WHERE appt_start IS NOT NULL AND cancelled=0 AND declined=0 AND id<>?").bind(exceptId || "");
  const rows = (await q.all()).results || [];
  return rows.map(r => Date.parse(r.appt_start)).filter(isFinite);
}
function publicUrl(env, req) { return (env.PUBLIC_URL || new URL(req.url).origin).replace(/\/$/, ""); }

/* Resolve template messages to addresses, then queue them. */
async function queueMessages(env, base, o, msgs, at) {
  if (!msgs.length) return [];
  at = at || nowISO();
  let appraisers = (await env.DB.prepare("SELECT id,name,email,phone FROM users WHERE role='appraiser' AND active=1").all()).results || [];
  if (o.assignedTo && appraisers.some(a => a.id === o.assignedTo)) appraisers = appraisers.filter(a => a.id === o.assignedTo);
  const cfg = await loadConfig(env, o.assignedTo);
  const pv = providers(env), emailOn = pv.email, smsOn = pv.sms;
  const link = t => base + "/#t=" + t, portal = base + "/#o=" + o.id;
  const stmts = [], out = [];
  for (const m of msgs) {
    let targets = [];
    if (m.party === "borrower") targets = [{name: o.borrowerName || "Borrower", email: o.borrowerEmail, phone: o.borrowerPhone, tok: o.tokB}];
    else if (m.party === "agent") targets = [{name: o.agentName || "Agent", email: o.agentEmail, phone: o.agentPhone, tok: o.tokA}];
    else if (m.party === "desk") {
      targets = [{name: o.orderedBy || "Appraisal desk", email: o.orderedByEmail, phone: ""}];
      (cfg.deskCopyEmails || []).forEach(e => { if (e && e !== (o.orderedByEmail || "").toLowerCase()) targets.push({name: "Appraisal desk", email: e, phone: ""}); });
    }
    else if (m.party === "officer") targets = [{name: o.officerName || CORE.ROLES.officer.name, email: o.officerEmail, phone: ""}];
    else if (m.party === "appraiser") targets = appraisers.length ? appraisers : [{name: cfg.appraiserName || "Appraiser", email: cfg.appraiserEmail, phone: cfg.appraiserPhone}];
    for (const t of targets) {
      const addr = m.channel === "sms" ? s(t.phone, 40) : s(t.email, 120).toLowerCase();
      const body = String(m.body).replace(/\[link\]/g, t.tok ? link(t.tok) : portal).replace(/\[portal\]/g, portal)
        .replace(/\[ics\]/g, t.tok ? base + "/api/client/" + t.tok + "/appointment.ics" : portal);
      let status;
      const staff = ["desk", "appraiser", "officer"].includes(m.party);
      if (env.DEMO) status = "demo";
      else if (!addr) status = staff ? "portal" : "manual";
      else if (m.channel === "email") status = emailOn ? "queued" : (staff ? "portal" : "manual");
      else status = smsOn ? "queued" : "manual";
      const id = uid("m");
      out.push({id, status, channel: m.channel, to: t.name});
      stmts.push(env.DB.prepare("INSERT INTO messages (id,order_id,created_at,channel,party,to_name,to_addr,subject,body,template,status,attempts,last_error) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?)")
        .bind(id, o.id, at, m.channel, m.party, s(t.name, 120), addr, s(m.subject || "", 200), body, m.template || "", status, addr ? null : ("No " + (m.channel === "sms" ? "mobile number" : "email") + " on file")));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  return out;
}
async function writeEvents(env, orderId, events) {
  if (!events.length) return;
  await env.DB.batch(events.map(e => env.DB.prepare("INSERT INTO events (order_id,at,who,role,what) VALUES (?,?,?,?,?)").bind(orderId, e.at, s(e.who, 120), s(e.role, 20), s(e.what, 3000))));
}
/* Apply one action with optimistic concurrency. Retries the whole read-apply-write on a version race. */
async function runAction(env, base, ctx, orderId, action, params, actor, opts = {}) {
  const at = opts.now || nowISO();
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await getOrderRow(env, orderId);
    if (!row) throw notFound("That order does not exist.");
    const o = rowToOrder(row);
    const cfg = await loadConfig(env, o.assignedTo);
    if (opts.from !== undefined && opts.from !== null && Number(opts.from) !== o.step) throw new ApiError(409, "stale", "This order already moved to " + CORE.statusOf(o) + ".");
    if (opts.version !== undefined && opts.version !== null && Number(opts.version) !== o.version) throw new ApiError(409, "stale", "Someone else changed this order. It has been reloaded.");
    const p = {...params};
    if (action === "book") p.booked = await bookedStarts(env, o.id, o.assignedTo);
    if (action === "assign") { const u = await env.DB.prepare("SELECT id,name FROM users WHERE id=? AND role='appraiser' AND active=1").bind(String(p.userId || "")).first(); if (!u) throw bad("Pick an active appraiser."); p.name = u.name; }
    if (action === "deliver") p.hasReport = !!(await env.DB.prepare("SELECT 1 FROM docs WHERE order_id=? AND kind='report' AND deleted_at IS NULL LIMIT 1").bind(o.id).first());
    if (action === "reissue") { o.tokB = randomToken(22); o.tokA = randomToken(22); }
    let result;
    try { result = CORE.applyAction(o, action, p, actor, cfg, at); }
    catch (e) { if (e && e.code) throw new ApiError(e.code === "forbidden" ? 403 : 409, e.code, e.msg || e.message); throw e; }
    const data = {...o}; ["id", "version", "step", "hold", "declined", "cancelled", "tokB", "tokA", "apptStart", "createdAt", "updatedAt", "docs", "events", "messages", "docCount", "hasReport", "unsent"].forEach(k => delete data[k]);
    const f = orderFields(o);
    const r = await env.DB.prepare("UPDATE orders SET version=version+1, step=?, hold=?, declined=?, cancelled=?, appt_start=?, updated_at=?, tok_b=?, tok_a=?, assigned_to=?, data=? WHERE id=? AND version=?")
      .bind(f[0], f[1], f[2], f[3], f[4], f[5], o.tokB, o.tokA, o.assignedTo || "", JSON.stringify(data), o.id, row.version).run();
    if (!r.meta || r.meta.changes !== 1) continue; // lost the race, re-read and try again
    o.version = row.version + 1;
    await writeEvents(env, o.id, result.events);
    const queued = await queueMessages(env, base, o, result.messages, at);
    if (ctx && queued.some(q => q.status === "queued")) ctx.waitUntil(dispatch(env, 8));
    return {order: o, reply: result.reply, queued};
  }
  throw new ApiError(409, "busy", "The order is being changed by someone else. Try again.");
}


/* Create an order for a signed-in desk user. `at` lets the demo seed backdate. */
async function createOrder(env, base, ctx, b, user, at) {
  at = at || nowISO();
  const role = user.role;
  const addr = s(b.addr, 200); if (!addr) throw bad("A property address is required.");
  const attest = CORE.clientType().attest;
  if (attest && !b.attestation) throw bad("The recusal attestation is required before an order can be placed.");
  const o = {
    addr, city: s(b.city, 120), loan: s(b.loan, 60), type: CORE.REPORT_TYPES.includes(b.type) ? b.type : CORE.REPORT_TYPES[0],
    purpose: CORE.PURPOSES.includes(b.purpose) ? b.purpose : "Purchase", due: /^\d{4}-\d{2}-\d{2}$/.test(s(b.due, 10)) ? s(b.due, 10) : "",
    fee: Number(b.fee) || 0, rush: !!b.rush, borrowerName: s(b.borrowerName, 120), borrowerPhone: s(b.borrowerPhone, 40), borrowerEmail: s(b.borrowerEmail, 120).toLowerCase(),
    agentName: s(b.agentName, 120), agentPhone: s(b.agentPhone, 40), agentEmail: s(b.agentEmail, 120).toLowerCase(),
    accessVia: CORE.ACCESS.includes(b.accessVia) ? b.accessVia : "Borrower", notes: s(b.notes, 2000), accessNotes: s(b.accessNotes, 500),
    officerName: s(b.officerName, 120), officerEmail: s(b.officerEmail, 120).toLowerCase(),
    loanType: CORE.LOAN_TYPES.includes(b.loanType) ? b.loanType : "", premise: CORE.PREMISES.includes(b.premise) ? b.premise : "As is",
    occupancy: CORE.OCCUPANCY.includes(b.occupancy) ? b.occupancy : "", propertyType: CORE.PROPERTY_TYPES.includes(b.propertyType) ? b.propertyType : "",
    units: Number(b.units) || 0, pins: s(b.pins, 200), closingDate: /^\d{4}-\d{2}-\d{2}$/.test(s(b.closingDate, 10)) ? s(b.closingDate, 10) : "",
    earliestInspection: /^\d{4}-\d{2}-\d{2}$/.test(s(b.earliestInspection, 10)) ? s(b.earliestInspection, 10) : "",
    deliveryFormat: CORE.DELIVERY_FORMATS.includes(b.deliveryFormat) ? b.deliveryFormat : "PDF", refNo: s(b.refNo, 60), groupRef: s(b.groupRef, 60), combinedReport: !!b.combinedReport,
    intendedUse: s(b.intendedUse, 1000), assignedTo: "", assignedName: "",
    step: 0, hold: false, holdReason: "", declined: false, cancelled: false, clientContacted: false,
    orderedBy: user.name, orderedByRole: CORE.ROLES[role].name, orderedByEmail: user.email, orderedById: user.id, orderedAt: at, attestation: attest,
    createdAt: at, updatedAt: at
  };
  if (o.borrowerEmail && !emailOk(o.borrowerEmail)) throw bad("The borrower email does not look right.");
  if (o.agentEmail && !emailOk(o.agentEmail)) throw bad("The agent email does not look right.");
  if (o.officerEmail && !emailOk(o.officerEmail)) throw bad("The " + CORE.ROLES.officer.name.toLowerCase() + " email does not look right.");
  if (o.purpose === "Purchase" && !o.due && o.closingDate) o.due = o.closingDate;
  if (b.assignedTo) { const u = await env.DB.prepare("SELECT id,name FROM users WHERE id=? AND role='appraiser' AND active=1").bind(String(b.assignedTo)).first(); if (!u) throw bad("That appraiser is not active."); o.assignedTo = u.id; o.assignedName = u.name; }
  else { const only = (await env.DB.prepare("SELECT id,name FROM users WHERE role='appraiser' AND active=1").all()).results || []; if (only.length === 1) { o.assignedTo = only[0].id; o.assignedName = only[0].name; } }
  const id = uid("o"), tokB = randomToken(22), tokA = randomToken(22);
  const cfg = await loadConfig(env, o.assignedTo);
  const data = {...o}; delete data.createdAt; delete data.updatedAt;
  await env.DB.prepare("INSERT INTO orders (id,version,step,hold,declined,cancelled,tok_b,tok_a,appt_start,created_at,updated_at,assigned_to,data) VALUES (?,1,0,0,0,0,?,?,NULL,?,?,?,?)").bind(id, tokB, tokA, o.createdAt, o.updatedAt, o.assignedTo || "", JSON.stringify(data)).run();
  o.id = id; o.tokB = tokB; o.tokA = tokA; o.version = 1;
  await writeEvents(env, id, [{at, who: user.name, role, what: attest ? "Order created. Recusal attestation recorded." : "Order created."}]);
  const msgs = CORE.templates.created(o, cfg).map(m => ({...m, template: "created"}));
  const queued = await queueMessages(env, base, o, msgs, at);
  if (ctx && queued.some(q => q.status === "queued")) ctx.waitUntil(dispatch(env, 8));
  return o;
}
/* Daily reminders the system owes the appraiser (accept, schedule, inspect, deliver, no activity). */
async function runNudges(env, base) {
  const rows = (await env.DB.prepare("SELECT * FROM orders WHERE cancelled=0 AND declined=0 AND step<7 AND hold=0").all()).results || [];
  let n = 0;
  for (const r of rows) {
    const o = rowToOrder(r);
    for (const key of CORE.nudgesDue(o, Date.now())) { try { await runAction(env, base, null, o.id, "nudge", {key}, {name: "System", role: "system"}); n++; } catch (e) {} }
  }
  return n;
}

/* ---------- sending ---------- */
/* Email goes out through the first configured adapter: the Cloudflare Email Service binding (EMAIL), Resend
   (RESEND_API_KEY), or an HTTP sink (MAIL_HOOK_URL, used by the test suite and by any lender that already
   has a transactional mail relay that accepts JSON). SMS goes through Twilio (account SID + auth token +
   either a messaging service SID or a from number). Nothing is sent in the demonstration copy. */
function providers(env) {
  // MAIL_HOOK_URL is an explicit override (a lender's own relay, or the test sink); otherwise the Cloudflare binding, then Resend
  const emailVia = env.MAIL_DISABLED === "1" ? "" : (env.MAIL_HOOK_URL ? "hook" : (env.EMAIL ? "cloudflare" : (env.RESEND_API_KEY ? "resend" : "")));
  const smsOn = !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && (env.TWILIO_MESSAGING_SERVICE_SID || env.TWILIO_FROM));
  return {email: !!emailVia, emailVia, sms: smsOn, smsVia: smsOn ? "twilio" : "", inboundEmail: !!env.MAIL_INBOUND};
}
function mailHost(env) { return (env.PUBLIC_URL || "https://example.com").replace(/^https?:\/\//, "").replace(/[:/].*$/, ""); }
function mailFrom(env, lender) { return env.MAIL_FROM || (lender + " via Apprifi <no-reply@" + mailHost(env) + ">"); }
/* Replies to a notice about an order come back to desk+<orderId>@<domain> when inbound routing is on. */
function replyTo(env, lender, orderId) {
  if (env.MAIL_INBOUND && orderId) { const [local, domain] = String(env.MAIL_INBOUND).split("@"); if (local && domain) return lender + " via Apprifi <" + local + "+" + orderId + "@" + domain + ">"; }
  return env.MAIL_REPLY_TO || undefined;
}
const escHtml = t => String(t).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
/* Branded HTML alongside the plain text. The first link becomes a button; every other URL is linked in place. */
function renderEmail(brand, m) {
  const primary = /^#[0-9a-f]{6}$/i.test(brand.primary || "") ? brand.primary : "#1f4984";
  const urlRe = /https?:\/\/[^\s<>"')\]]+/g;
  const first = (m.body.match(urlRe) || [])[0] || "";
  const paras = String(m.body).split(/\n{2,}/).map(p => "<p style=\"margin:0 0 14px;font:15px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c2431\">" +
    escHtml(p).replace(/\n/g, "<br>").replace(urlRe, u => "<a href=\"" + escHtml(u) + "\" style=\"color:" + primary + "\">" + escHtml(u) + "</a>") + "</p>").join("");
  const button = first ? "<p style=\"margin:6px 0 20px\"><a href=\"" + escHtml(first) + "\" style=\"display:inline-block;background:" + primary + ";color:#ffffff;text-decoration:none;font:600 15px -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:11px 18px;border-radius:6px\">Open</a></p>" : "";
  const foot = escHtml(brand.name) + (brand.tagline ? " &middot; " + escHtml(brand.tagline) : "") + (brand.supportLine ? "<br>" + escHtml(brand.supportLine) : "") +
    "<br>Sent by " + escHtml(brand.productName || APPRIFI.product) + " on behalf of " + escHtml(brand.name) + ". Links in this message are personal to you; please do not forward them.";
  const html = "<!doctype html><html><body style=\"margin:0;background:#f3f5f8;padding:24px 12px\">" +
    "<table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\"><tr><td align=\"center\">" +
    "<table role=\"presentation\" width=\"600\" style=\"max-width:600px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden\" cellspacing=\"0\" cellpadding=\"0\">" +
    "<tr><td style=\"background:" + primary + ";padding:14px 24px\"><table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\"><tr>" +
    "<td style=\"font:700 19px Georgia,'Times New Roman',serif;color:#ffffff;letter-spacing:-.01em\">" + escHtml(brand.productName || APPRIFI.product) + "</td>" +
    "<td align=\"right\" style=\"font:600 13px -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#ffffff;opacity:.92\">" + escHtml(brand.name) + "</td></tr></table></td></tr>" +
    "<tr><td style=\"padding:24px 24px 10px\">" + paras + button + "</td></tr>" +
    "<tr><td style=\"padding:14px 24px 22px;font:12px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#6b7482;border-top:1px solid #e6e9ee\">" + foot + "</td></tr>" +
    "</table></td></tr></table></body></html>";
  return {text: m.body, html};
}
async function sendEmail(env, m) {
  const brand = await loadBrand(env), lender = brand.name;
  const from = mailFrom(env, lender), subject = m.subject || (lender + " appraisal update");
  const {text, html} = renderEmail(brand, m);
  const reply = replyTo(env, lender, m.order_id);
  const to = m.to_name ? {email: m.to_addr, name: m.to_name} : m.to_addr;
  if (env.EMAIL && !env.MAIL_HOOK_URL) {
    // Cloudflare Email Service binding: the sending domain is onboarded in the same account, no key to manage
    const r = await env.EMAIL.send({to, from, subject, text, html, replyTo: reply, headers: m.id ? {"X-Appraisal-Desk-Message": String(m.id)} : undefined});
    return (r && r.messageId) || "";
  }
  if (env.RESEND_API_KEY && !env.MAIL_HOOK_URL) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: {"authorization": "Bearer " + env.RESEND_API_KEY, "content-type": "application/json"},
      body: JSON.stringify({from, to: [m.to_addr], subject, text, html, reply_to: reply})
    });
    const t = await res.text();
    if (!res.ok) throw new Error("Resend " + res.status + ": " + t.slice(0, 300));
    try { return JSON.parse(t).id || ""; } catch (e) { return ""; }
  }
  const res = await fetch(env.MAIL_HOOK_URL, {
    method: "POST", headers: {"content-type": "application/json", ...(env.MAIL_HOOK_TOKEN ? {"authorization": "Bearer " + env.MAIL_HOOK_TOKEN} : {})},
    body: JSON.stringify({id: m.id, from, to: m.to_addr, toName: m.to_name, subject, text, html, replyTo: reply, orderId: m.order_id || ""})
  });
  const t = await res.text();
  if (!res.ok) throw new Error("Mail relay " + res.status + ": " + t.slice(0, 300));
  try { return JSON.parse(t).id || ""; } catch (e) { return ""; }
}
async function sendSms(env, m) {
  const base = (env.TWILIO_API_BASE || "https://api.twilio.com").replace(/\/$/, "");
  const url = base + "/2010-04-01/Accounts/" + env.TWILIO_ACCOUNT_SID + "/Messages.json";
  const params = {To: normalizePhone(m.to_addr), Body: m.body};
  if (env.TWILIO_MESSAGING_SERVICE_SID) params.MessagingServiceSid = env.TWILIO_MESSAGING_SERVICE_SID; else params.From = env.TWILIO_FROM;
  if (env.PUBLIC_URL && /^https:/.test(env.PUBLIC_URL)) params.StatusCallback = env.PUBLIC_URL.replace(/\/$/, "") + "/api/hooks/twilio/status";
  const res = await fetch(url, {method: "POST", headers: {"authorization": "Basic " + btoa(env.TWILIO_ACCOUNT_SID + ":" + env.TWILIO_AUTH_TOKEN), "content-type": "application/x-www-form-urlencoded"}, body: new URLSearchParams(params)});
  const t = await res.text();
  if (!res.ok) throw new Error("Twilio " + res.status + ": " + t.slice(0, 300));
  try { return JSON.parse(t).sid || ""; } catch (e) { return ""; }
}
function normalizePhone(p) { const d = String(p || "").replace(/\D/g, ""); if (d.length === 10) return "+1" + d; if (d.length === 11 && d[0] === "1") return "+" + d; return String(p || ""); }
async function isOptedOut(env, channel, addr) {
  const key = channel === "sms" ? normalizePhone(addr) : String(addr || "").toLowerCase();
  return !!(await env.DB.prepare("SELECT 1 FROM optouts WHERE addr=? AND channel=?").bind(key, channel).first());
}
async function dispatch(env, limit = 20) {
  const pv = providers(env), emailOn = pv.email, smsOn = pv.sms;
  if (!emailOn && !smsOn) return 0;
  const rows = (await env.DB.prepare("SELECT * FROM messages WHERE status='queued' AND attempts<6 ORDER BY created_at LIMIT ?").bind(limit).all()).results || [];
  let n = 0;
  for (const m of rows) {
    if ((m.channel === "email" && !emailOn) || (m.channel === "sms" && !smsOn)) continue;
    // claim the row first, so two dispatchers running at once (a request and the cron) never send the same message twice
    const claim = await env.DB.prepare("UPDATE messages SET status='sending', attempts=attempts+1 WHERE id=? AND status='queued'").bind(m.id).run();
    if (!claim.meta || claim.meta.changes !== 1) continue;
    try {
      if (await isOptedOut(env, m.channel, m.to_addr)) {
        await env.DB.prepare("UPDATE messages SET status='optout', last_error='Recipient opted out (STOP)' WHERE id=?").bind(m.id).run();
        continue;
      }
      const pid = m.channel === "email" ? await sendEmail(env, m) : await sendSms(env, m);
      await env.DB.prepare("UPDATE messages SET status='sent', sent_at=?, provider_id=?, last_error=NULL WHERE id=?").bind(nowISO(), pid, m.id).run(); n++;
    } catch (e) {
      const final = m.attempts + 1 >= 6;
      await env.DB.prepare("UPDATE messages SET status=?, last_error=? WHERE id=?").bind(final ? "failed" : "queued", s(e.message, 400), m.id).run();
    }
  }
  return n;
}
/* Mail that belongs to no order: invitations, password resets, feedback copies, delivery tests. */
async function queueSystemMail(env, ctx, m) {
  const pv = providers(env);
  const status = env.DEMO ? "demo" : (pv.email ? "queued" : "manual");
  const id = uid("m");
  await env.DB.prepare("INSERT INTO messages (id,order_id,created_at,channel,party,to_name,to_addr,subject,body,template,status,attempts,kind) VALUES (?,'',?,'email','system',?,?,?,?,?,?,0,'system')")
    .bind(id, nowISO(), s(m.to_name, 120), s(m.to_addr, 120).toLowerCase(), s(m.subject, 200), String(m.body), s(m.template, 40), status).run();
  if (status === "queued" && ctx) ctx.waitUntil(dispatch(env, 8));
  return {id, status};
}
async function inviteMail(env, ctx, req, target, by, link) {
  const brand = await loadBrand(env), roleName = (CORE.ROLES[target.role] || {}).name || target.role;
  return queueSystemMail(env, ctx, {to_name: target.name, to_addr: target.email, template: "invite",
    subject: "Your Apprifi sign-in for " + brand.name,
    body: by.name + " has added you to Apprifi for " + brand.name + " as " + roleName + ". Choose your password and sign in here within " + INVITE_DAYS + " days: " + link +
      "\n\nThe link works once. If it expires, ask " + by.name + " for a new one." + (brand.supportLine ? "\n\n" + brand.supportLine : "")});
}
/* Twilio signs every webhook: HMAC-SHA1 over the exact URL plus the sorted POST fields, base64. */
async function twilioSignatureOk(env, req, params) {
  const sig = req.headers.get("x-twilio-signature") || "";
  if (!sig || !env.TWILIO_AUTH_TOKEN) return false;
  const u = new URL(req.url);
  const base = (env.PUBLIC_URL || u.origin).replace(/\/$/, "") + u.pathname + u.search;
  const keys = [...params.keys()].sort();
  let data = base; for (const k of keys) data += k + params.get(k);
  const key = await crypto.subtle.importKey("raw", enc.encode(env.TWILIO_AUTH_TOKEN), {name: "HMAC", hash: "SHA-1"}, false, ["sign"]);
  const mac = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)))));
  return safeEqual(mac, sig);
}
/* Find the open order a client reply belongs to: the newest one whose borrower or agent has that phone or email. */
async function orderForContact(env, channel, addr) {
  const rows = (await env.DB.prepare("SELECT * FROM orders WHERE cancelled=0 AND declined=0 AND step<7 ORDER BY updated_at DESC LIMIT 400").all()).results || [];
  const want = channel === "sms" ? normalizePhone(addr) : String(addr || "").toLowerCase();
  for (const r of rows) {
    const o = rowToOrder(r);
    if (channel === "sms") { if (normalizePhone(o.borrowerPhone) === want) return {o, party: "borrower"}; if (o.agentPhone && normalizePhone(o.agentPhone) === want) return {o, party: "agent"}; }
    else { if (o.borrowerEmail === want) return {o, party: "borrower"}; if (o.agentEmail && o.agentEmail === want) return {o, party: "agent"}; }
  }
  return null;
}
/* Strip the quoted history a mail client appends below a reply. */
function replyText(t) {
  const lines = String(t || "").replace(/\r/g, "").split("\n"), out = [];
  for (const ln of lines) {
    if (/^On .{6,120} wrote:\s*$/.test(ln) || /^-{2,}\s*Original Message\s*-{2,}/i.test(ln) || /^From:\s.+/.test(ln) && out.length) break;
    if (/^>/.test(ln)) continue;
    out.push(ln);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 4000);
}
/* Record an inbound reply and route it: a matched client goes on the order's conversation; staff by email goes on too. */
async function handleInbound(env, base, ctx, inb) {
  const id = uid("i");
  let orderId = inb.orderId || "", handled = "";
  const addr = inb.channel === "sms" ? normalizePhone(inb.from) : String(inb.from || "").toLowerCase();
  const text = inb.channel === "sms" ? s(inb.body, 2000) : replyText(inb.body);
  try {
    let o = null, party = "";
    if (orderId) { const row = await getOrderRow(env, orderId); if (row) o = rowToOrder(row); }
    if (o) {
      if (inb.channel === "sms") { if (normalizePhone(o.borrowerPhone) === addr) party = "borrower"; else if (o.agentPhone && normalizePhone(o.agentPhone) === addr) party = "agent"; }
      else { if (o.borrowerEmail === addr) party = "borrower"; else if (o.agentEmail && o.agentEmail === addr) party = "agent"; }
    }
    if (!o || !party) { const m = await orderForContact(env, inb.channel, inb.from); if (m) { o = m.o; party = m.party; } }
    if (o && party) {
      orderId = o.id;
      if (text) {
        const actor = {name: party === "agent" ? (o.agentName || "Agent") : (o.borrowerName || "Borrower"), role: "client"};
        await runAction(env, base, ctx, o.id, "post", {text, via: inb.channel === "sms" ? "text message" : "email"}, actor);
        handled = "posted";
      } else handled = "empty";
    } else if (inb.channel === "email") {
      // a staff member replying by email lands on the order too, when the tag named one
      const u = await env.DB.prepare("SELECT id,name,role FROM users WHERE email=? AND active=1").bind(addr).first();
      if (u && orderId && text && CORE.can(u.role, "post")) { await runAction(env, base, ctx, orderId, "post", {text, via: "email"}, {name: u.name, role: u.role, id: u.id}); handled = "posted"; }
      else handled = "unmatched";
    } else handled = "unmatched";
  } catch (e) { handled = "error: " + s(e.message, 200); }
  await env.DB.prepare("INSERT INTO inbound (id,at,channel,from_addr,from_name,order_id,subject,body,provider_id,handled) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .bind(id, nowISO(), inb.channel, s(addr, 160), s(inb.fromName, 120), orderId, s(inb.subject, 200), text || s(inb.body, 4000), s(inb.providerId, 120), handled).run();
  return {id, orderId, handled};
}

/* ---------- documents ---------- */
/* New uploads go to R2 when a bucket is bound, otherwise KV. Reads follow the storage recorded on the document,
   so switching a lender to R2 later leaves earlier files readable. */
function store(env, kind) {
  const useR2 = kind ? kind === "r2" : !!env.BUCKET;
  if (useR2) {
    if (!env.BUCKET) throw new ApiError(500, "storage", "This document is in R2 but no bucket is bound.");
    return {
      kind: "r2",
      put: (key, buf, type) => env.BUCKET.put(key, buf, {httpMetadata: {contentType: type}}),
      get: async key => { const obj = await env.BUCKET.get(key); return obj ? obj.body : null; },
      del: key => env.BUCKET.delete(key)
    };
  }
  return {
    kind: "kv",
    put: (key, buf, type) => env.FILES.put(key, buf, {metadata: {type}}),
    get: key => env.FILES.get(key, "stream"),
    del: key => env.FILES.delete(key)
  };
}
/* The extension decides the type; the first bytes must agree for binary formats, so a renamed file is refused. */
function sniffOk(ext, buf) {
  const b = new Uint8Array(buf.slice(0, 16)), at = (i, str) => [...str].every((c, j) => b[i + j] === c.charCodeAt(0));
  switch (ext) {
    case "pdf": return at(0, "%PDF");
    case "png": return b[0] === 0x89 && at(1, "PNG");
    case "jpg": case "jpeg": return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case "webp": return at(0, "RIFF") && at(8, "WEBP");
    case "heic": return at(4, "ftyp");
    case "zip": case "docx": case "xlsx": return at(0, "PK");
    default: return true; // text formats
  }
}
/* Validate and persist one uploaded file, then record it. Shared by staff and client uploads. */
async function saveUpload(env, o, f, kind, visible, who, role) {
  const ext = (f.name.split(".").pop() || "").toLowerCase(), type = TYPES[ext];
  if (!type) throw bad(f.name + " is not a supported file type (PDF, images, XML, CSV, Office files, ZIP).");
  if (f.size > MAX_FILE) throw bad(f.name + " is over the 20 MB limit.");
  if (!f.size) throw bad(f.name + " is empty.");
  const buf = await f.arrayBuffer();
  if (!sniffOk(ext, buf)) throw bad(f.name + " does not look like a " + ext.toUpperCase() + " file.");
  const st = store(env), did = uid("d"), key = "doc/" + o.id + "/" + did;
  await st.put(key, buf, type);
  await env.DB.prepare("INSERT INTO docs (id,order_id,name,size,type,kind,client_visible,storage,key,uploaded_by,uploaded_role,uploaded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(did, o.id, s(f.name, 200), f.size, type, kind, visible ? 1 : 0, st.kind, key, who, role, nowISO()).run();
  return did;
}
function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/* ---------- independence log ---------- */
function logText(o, cfg) {
  const L = [];
  const CT = CORE.clientType();
  L.push(CT.recordTitle); L.push("");
  L.push("Property: " + o.addr + ", " + o.city); L.push("Order: " + o.id); L.push(CT.refLabel + ": " + (o.loan || "not provided"));
  L.push("Product: " + o.type + ", " + o.purpose + (o.loanType ? ", " + o.loanType : "") + (o.premise ? ", " + o.premise : "")); L.push("Client: " + cfg.lenderName + (cfg.brand && cfg.brand.tagline ? ", " + cfg.brand.tagline : ""));
  if (o.refNo || o.pins) L.push("Client reference: " + (o.refNo || "n/a") + "; parcels: " + (o.pins || "n/a"));
  if (o.assignedName) L.push("Assigned appraiser: " + o.assignedName);
  if (o.etaDate) L.push("Committed delivery date: " + o.etaDate);
  if (o.review) L.push("Reviewer: " + (o.review.name || "") + " (" + o.review.status + (o.review.signedAt ? ", signed " + o.review.signedAt : "") + ")");
  if (o.prelim) L.push("Preliminary figures released " + o.prelim.at + (o.prelim.value ? " (value " + o.prelim.value + ")" : ""));
  if (o.revision) L.push("Revisions: " + o.revision.n + " (" + o.revision.kind + ")");
  if (o.paid) L.push("Payment: " + o.paid.amount + " by " + o.paid.method + (o.paid.ref ? " ref " + o.paid.ref : "") + " on " + o.paid.at);
  L.push("Appraiser: " + (o.appraiserName || cfg.appraiserName || "not recorded")); L.push("Status: " + CORE.statusOf(o)); L.push("Exported: " + new Date().toISOString()); L.push("");
  L.push(CT.attest ? "ORDERING AND RECUSAL" : "ORDERING");
  L.push("Ordered by: " + o.orderedBy + " (" + o.orderedByRole + ", " + (o.orderedByEmail || "") + ")"); L.push("Ordered at: " + o.orderedAt);
  L.push(CORE.ROLES.officer.name + " on file: " + (o.officerName || "not recorded"));
  if (CT.attest) {
    L.push("Recusal attestation: " + (o.attestation ? "RECORDED" : "NOT RECORDED"));
    L.push('Attested text: "I will abstain from participating in any decision to approve, not approve, or set the terms of this transaction."');
    L.push("Control reference: 12 CFR 1026.42(d)(3)(ii); Interagency Appraisal and Evaluation Guidelines, 2010.");
  }
  L.push("");
  L.push("Engagement: direct between " + cfg.lenderName + " (client) and the appraiser. No appraisal management company is involved. Apprifi is a communication and record-keeping tool operated for the client; it does not select the appraiser, set or collect the fee, or review the report.");
  L.push("Identities in this record are authenticated portal accounts (email and password) with roles assigned by the client's administrator."); L.push("");
  L.push("DOCUMENTS");
  (o.docs || []).forEach(d => L.push("  " + d.uploaded_at + "  " + d.name + "  (" + d.size + " bytes, " + d.kind + ")  uploaded by " + d.uploaded_by + " (" + d.uploaded_role + ")"));
  if (!(o.docs || []).length) L.push("  none"); L.push("");
  L.push("ACTIVITY (append-only server record)");
  (o.events || []).forEach(e => L.push("  " + e.at + "  " + e.who + " (" + e.role + ")  " + e.what)); L.push("");
  L.push("MESSAGES");
  (o.messages || []).forEach(m => { L.push("  " + m.created_at + "  " + m.channel.toUpperCase() + " to " + m.to_name + (m.to_addr ? " <" + m.to_addr + ">" : "") + "  [" + m.status + (m.sent_at ? " " + m.sent_at : "") + "]" + (m.subject ? "  subject: " + m.subject : "")); L.push("      " + m.body.replace(/\n/g, "\n      ")); });
  if (!(o.messages || []).length) L.push("  none"); L.push("");
  L.push("Generated by Apprifi for " + cfg.lenderName + ".");
  return L.join("\n");
}
function icsFor(o, cfg) {
  const dt = iso => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const esc = t => String(t || "").replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Apprifi//" + esc(cfg.lenderName) + "//EN", "METHOD:PUBLISH", "BEGIN:VEVENT",
    "UID:" + o.id + "@appraisal-desk", "DTSTAMP:" + dt(nowISO()), "DTSTART:" + dt(o.apptStart), "DTEND:" + dt(o.apptEnd || (Date.parse(o.apptStart) + 3600e3)),
    "SUMMARY:" + esc("Appraisal inspection: " + o.addr), "LOCATION:" + esc(o.addr + ", " + o.city),
    "DESCRIPTION:" + esc(CORE.aprCap(cfg) + " will need access to every room, the basement and the garage. " + CORE.contactLine(cfg)),
    "END:VEVENT", "END:VCALENDAR"].join("\r\n");
}

/* ---------- API router ---------- */
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
async function api(req, env, ctx) {
  const url = new URL(req.url), path = url.pathname.replace(/\/+$/, ""), method = req.method;
  const seg = path.split("/").filter(Boolean); // ["api", ...]
  const p = (i) => seg[i] || "";
  /* --- provider webhooks: authenticated by the provider's signature, not by a session --- */
  if (p(1) === "hooks") return hooks(req, env, ctx, p);
  if (MUTATING.has(method)) {
    // same-origin only: browsers always send Origin on these methods; the custom header defeats form posts
    const origin = req.headers.get("origin");
    if (origin && origin !== url.origin) throw denied("Cross-site request refused.");
    if (req.headers.get("x-requested-with") !== "FSB") throw denied("Missing request header.");
  }

  if (path === "/api/health") return json({ok: true, time: nowISO()});

  /* --- forgotten password: always answers the same way, so it reveals nothing about who has an account --- */
  if (path === "/api/reset" && method === "POST") {
    requireSecret(env);
    const b = await readJSON(req);
    const email = s(b.email, 120).toLowerCase();
    if (!emailOk(email)) throw bad("Enter your work email.");
    if (await limited(env, "reset:ip:" + ip(req), 10, 60 * 60e3) || await limited(env, "reset:em:" + email, 3, 60 * 60e3)) throw new ApiError(429, "rate", "Too many reset requests. Wait an hour, or ask your administrator for a new sign-in link.");
    const u = await env.DB.prepare("SELECT id,name,email,active FROM users WHERE email=?").bind(email).first();
    if (u && u.active && providers(env).email && !env.DEMO) {
      const code = randomToken(28), brand = await loadBrand(env);
      await env.DB.batch([
        env.DB.prepare("UPDATE invites SET used_at=? WHERE user_id=? AND used_at IS NULL AND kind='reset'").bind(nowISO(), u.id),
        env.DB.prepare("INSERT INTO invites (code_hash,user_id,created_by,created_at,expires_at,kind) VALUES (?,?,?,?,?,'reset')").bind(await sha256(code), u.id, "self-service", nowISO(), new Date(Date.now() + 2 * 3600e3).toISOString()),
        env.DB.prepare("INSERT INTO audit (at,who,what) VALUES (?,?,?)").bind(nowISO(), u.name, "Requested a password reset link.")
      ]);
      await queueSystemMail(env, ctx, {to_name: u.name, to_addr: u.email, subject: "Reset your Apprifi password (" + brand.name + ")", template: "reset",
        body: "Someone asked to reset the password for " + u.email + " on Apprifi for " + brand.name + ". If that was you, choose a new password here within two hours: " + publicUrl(env, req) + "/#invite=" + code + "\n\nIf it was not you, ignore this message; your password has not changed."});
    }
    return json({ok: true, message: "If that address has an active account, a reset link is on its way. It lasts two hours."});
  }

  /* --- client (token) endpoints, no session --- */
  if (p(1) === "client" && p(2)) {
    const tok = s(p(2), 40);
    if (await limited(env, "client:" + ip(req), 240, 10 * 60e3)) throw new ApiError(429, "rate", "Too many requests. Wait a minute.");
    const row = await env.DB.prepare("SELECT * FROM orders WHERE tok_b=? OR tok_a=?").bind(tok, tok).first();
    if (!row) throw notFound("This link is not valid.");
    const o = rowToOrder(row), party = row.tok_b === tok ? "borrower" : "agent";
    const cfg = await loadConfig(env, o.assignedTo);
    const actor = {name: party === "agent" ? (o.agentName || "Agent") : (o.borrowerName || "Borrower"), role: "client"};
    if (method === "GET" && !p(3)) {
      const booked = await bookedStarts(env, o.id, o.assignedTo);
      const uploaded = (await env.DB.prepare("SELECT name,uploaded_at FROM docs WHERE order_id=? AND uploaded_role='client' AND deleted_at IS NULL ORDER BY uploaded_at").bind(o.id).all()).results || [];
      const report = o.step >= 6 ? await env.DB.prepare("SELECT id,name,size FROM docs WHERE order_id=? AND deleted_at IS NULL AND client_visible=1 AND kind IN ('report','addendum') ORDER BY uploaded_at DESC LIMIT 1").bind(o.id).first() : null;
      return json({
        orderId: o.id, addr: o.addr, city: o.city, step: o.step, hold: !!o.hold, declined: !!o.declined, cancelled: !!o.cancelled,
        apptStart: o.apptStart, apptEnd: o.apptEnd || null, party, who: actor.name, contactParty: CORE.contactParty(o),
        slotMinutes: cfg.slotMinutes, appraiser: {name: cfg.appraiserName || "", phone: cfg.appraiserPhone || ""},
        slots: o.step === 2 && !o.hold && !o.cancelled ? CORE.genSlots(cfg, booked, Date.now(), 24) : [],
        report: report || null, consent: !!(o.consent && o.consent[party]), tz: cfg.timeZone || CORE.TZ,
        lender: {name: cfg.lenderName, tagline: cfg.brand.tagline || "", logo: cfg.brand.logoKey ? "/brand/logo?v=" + (cfg.brand.logoVersion || 1) : cfg.brand.logo, primary: cfg.brand.primary, accent: cfg.brand.accent},
        docRequest: o.docRequest && CORE.isOpen(o) ? o.docRequest.items : "", uploaded, clientType: CORE.clientType().key,
        thread: (o.thread || []).filter(t => t.role === "client" || t.to === "client").map(t => ({at: t.at, who: t.who, mine: t.role === "client" && t.who === actor.name, text: t.text, via: t.via || "portal"})).slice(-50),
        open: CORE.isOpen(o)
      });
    }
    if (method === "POST" && p(3) === "docs") {
      if (!CORE.isOpen(o)) throw bad("This file is closed.");
      if (await limited(env, "cupload:" + tok, 30, 24 * 3600e3)) throw new ApiError(429, "rate", "Upload limit reached for today.");
      const form = await req.formData();
      const files = form.getAll("file").filter(f => f && typeof f === "object" && f.size !== undefined);
      if (!files.length) throw bad("No file was received.");
      for (const f of files) {
        await saveUpload(env, o, f, "other", false, actor.name, "client");
        await runAction(env, publicUrl(env, req), ctx, o.id, "clientdoc", {name: f.name}, actor);
      }
      return json({ok: true, reply: files.length + " file" + (files.length === 1 ? "" : "s") + " received. Thank you."});
    }
    if (method === "POST" && p(3) === "message") {
      if (!CORE.isOpen(o)) throw bad("This file is closed.");
      if (await limited(env, "cmsg:" + tok, 40, 24 * 3600e3)) throw new ApiError(429, "rate", "Message limit reached for today. Please call instead.");
      const body = await readJSON(req);
      const r = await runAction(env, publicUrl(env, req), ctx, o.id, "post", {text: s(body.text, 2000)}, actor);
      return json({ok: true, reply: "Sent. " + (cfg.appraiserName || "The appraiser") + " and " + cfg.lenderName + " have been notified."});
    }
    if (method === "GET" && p(3) === "appointment.ics") {
      if (!o.apptStart) throw notFound("No appointment is booked.");
      return new Response(icsFor(o, cfg), {headers: {"content-type": "text/calendar; charset=utf-8", "content-disposition": contentDisposition("appraisal-inspection.ics"), "cache-control": "no-store"}});
    }
    if (method === "POST" && ["book", "reschedule", "noslot", "consent"].includes(p(3))) {
      const body = await readJSON(req);
      const r = await runAction(env, publicUrl(env, req), ctx, o.id, p(3), {slot: body.slot, note: s(body.note, 500), party}, actor);
      return json({ok: true, reply: r.reply});
    }
    throw notFound();
  }

  /* --- demonstration copy: reload the sample data --- */
  if (path === "/api/demo/reset" && method === "POST") {
    if (!env.DEMO) throw notFound();
    if (await limited(env, "demo:" + ip(req), 6, 60 * 60e3)) throw new ApiError(429, "rate", "The demo was reset recently. Try again in a while.");
    const count = (await env.DB.prepare("SELECT COUNT(*) n FROM users").first()).n;
    if (count > 0 && !(await currentUser(env, req))) throw new ApiError(401, "signin", "Sign in first.");
    await resetDemo(env, publicUrl(env, req), {createOrder, runAction, setPassword, store, writeEvents, uid, randomToken, nowISO});
    return json({ok: true}, 200, {"set-cookie": cookieHeader(req, "", 0)});
  }

  /* --- session state, setup, sign-in --- */
  if (path === "/api/session" && method === "GET") {
    const user = await currentUser(env, req);
    const count = (await env.DB.prepare("SELECT COUNT(*) n FROM users").first()).n;
    const out = {user: user ? pubUser(user) : null, provisioned: count > 0, providers: providers(env), time: nowISO(), storage: env.BUCKET ? "r2" : "kv", demo: !!env.DEMO, brand: await loadBrand(env), clientType: CORE.clientType().key};
    if (user) { out.config = await loadConfig(env, user.role === "appraiser" ? user.id : undefined); out.appraisers = (await env.DB.prepare("SELECT id,name FROM users WHERE role='appraiser' AND active=1 ORDER BY name").all()).results || []; }
    return json(out);
  }
  if (path === "/api/brand" && method === "GET") return json({brand: await loadBrand(env)});
  if (path === "/api/login" && method === "POST") {
    requireSecret(env);
    const b = await readJSON(req);
    const email = s(b.email, 120).toLowerCase(), password = String(b.password || "");
    if (await limited(env, "login:ip:" + ip(req), 30, 15 * 60e3) || await limited(env, "login:em:" + email, 10, 15 * 60e3)) throw new ApiError(429, "rate", "Too many sign-in attempts. Wait 15 minutes.");
    const u = await env.DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first();
    const generic = new ApiError(401, "auth", "That email and password do not match.");
    if (!u || !u.pw_hash) throw generic;
    if (!u.active) throw new ApiError(403, "suspended", "This account has been suspended by the lender's administrator.");
    const h = await pbkdf2(password, u.pw_salt, u.pw_iter, env.AUTH_SECRET);
    if (!safeEqual(h, u.pw_hash)) throw generic;
    const cookie = await startSession(env, req, u.id);
    await env.DB.prepare("UPDATE users SET last_seen=? WHERE id=?").bind(nowISO(), u.id).run();
    return json({ok: true, user: pubUser(u)}, 200, {"set-cookie": cookie});
  }
  if (path === "/api/logout" && method === "POST") {
    const raw = getCookie(req, COOKIE);
    if (raw) await env.DB.prepare("DELETE FROM sessions WHERE id_hash=?").bind(await sha256(raw)).run();
    return json({ok: true}, 200, {"set-cookie": cookieHeader(req, "", 0)});
  }
  if (p(1) === "invite") {
    requireSecret(env);
    if (await limited(env, "invite:" + ip(req), 30, 15 * 60e3)) throw new ApiError(429, "rate", "Too many attempts. Wait 15 minutes.");
    if (method === "GET" && p(2)) {
      const inv = await env.DB.prepare("SELECT i.expires_at,i.used_at,i.kind,u.name,u.email,u.role,u.active FROM invites i JOIN users u ON u.id=i.user_id WHERE i.code_hash=?").bind(await sha256(s(p(2), 60))).first();
      if (!inv || inv.used_at || inv.expires_at < nowISO() || !inv.active) throw notFound("This link is not valid any more. Ask the lender's administrator for a new one, or request a new reset link from the sign-in page.");
      return json({name: inv.name, email: inv.email, role: inv.role, kind: inv.kind || "invite"});
    }
    if (method === "POST" && p(2) === "accept") {
      const b = await readJSON(req);
      const h = await sha256(s(b.code, 60));
      const inv = await env.DB.prepare("SELECT i.user_id,i.expires_at,i.used_at,i.kind,u.active,u.name FROM invites i JOIN users u ON u.id=i.user_id WHERE i.code_hash=?").bind(h).first();
      if (!inv || inv.used_at || inv.expires_at < nowISO() || !inv.active) throw notFound("This link is not valid any more. Ask the lender's administrator for a new one, or request a new reset link from the sign-in page.");
      await setPassword(env, inv.user_id, b.password);
      await env.DB.batch([
        env.DB.prepare("UPDATE invites SET used_at=? WHERE code_hash=?").bind(nowISO(), h),
        env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(inv.user_id),
        env.DB.prepare("INSERT INTO audit (at,who,what) VALUES (?,?,?)").bind(nowISO(), inv.name, inv.kind === "reset" ? "Reset their password from an emailed link." : "Accepted invitation and set a password.")
      ]);
      const u = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(inv.user_id).first();
      const cookie = await startSession(env, req, u.id);
      return json({ok: true, user: pubUser(u)}, 200, {"set-cookie": cookie});
    }
    throw notFound();
  }

  /* --- everything below needs a signed-in staff account --- */
  const user = await currentUser(env, req);
  if (!user) throw new ApiError(401, "signin", "Please sign in.");
  const role = user.role;

  if (path === "/api/password" && method === "POST") {
    const b = await readJSON(req);
    const u = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(user.id).first();
    const h = await pbkdf2(String(b.current || ""), u.pw_salt, u.pw_iter, env.AUTH_SECRET);
    if (!safeEqual(h, u.pw_hash)) throw new ApiError(401, "auth", "Your current password is wrong.");
    await setPassword(env, user.id, b.next);
    // every other device is signed out; this one keeps its session
    const mine = await sha256(getCookie(req, COOKIE) || "");
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE user_id=? AND id_hash<>?").bind(user.id, mine),
      env.DB.prepare("INSERT INTO audit (at,who,what) VALUES (?,?,?)").bind(nowISO(), user.name, "Changed their password; other sessions signed out.")
    ]);
    return json({ok: true});
  }
  /* --- delivery check: the administrator sends a test to their own address and sees the provider's answer --- */
  if (path === "/api/test-send" && method === "POST") {
    if (role !== "admin") throw denied("Only the administrator runs delivery tests.");
    const b = await readJSON(req), channel = b.channel === "sms" ? "sms" : "email";
    if (env.DEMO) throw bad("The demonstration copy never sends anything.");
    const pv = providers(env);
    if (channel === "email" && !pv.email) throw bad("No email provider is configured on the server yet.");
    if (channel === "sms" && !pv.sms) throw bad("No text-message provider is configured on the server yet.");
    if (await limited(env, "test:" + user.id, 10, 60 * 60e3)) throw new ApiError(429, "rate", "Ten tests an hour is plenty.");
    const brand = await loadBrand(env);
    const to_addr = channel === "sms" ? s(b.to || user.phone, 40) : user.email;
    if (!to_addr) throw bad("Add a mobile number to your account first (People, your row).");
    const m = {id: uid("m"), order_id: "", to_name: user.name, to_addr, subject: "Apprifi test message (" + brand.name + ")",
      body: channel === "sms" ? brand.name + " via Apprifi: text delivery works. Reply STOP to opt out." : "This is a delivery test sent by " + user.name + " from Apprifi for " + brand.name + " at " + nowISO() + ".\n\nIf you are reading it, email delivery works: " + publicUrl(env, req)};
    await env.DB.prepare("INSERT INTO messages (id,order_id,created_at,channel,party,to_name,to_addr,subject,body,template,status,attempts,kind) VALUES (?,'',?,?,'system',?,?,?,?,'test','queued',0,'system')")
      .bind(m.id, nowISO(), channel, m.to_name, m.to_addr, channel === "sms" ? "" : m.subject, m.body).run();
    try {
      const pid = channel === "email" ? await sendEmail(env, m) : await sendSms(env, m);
      await env.DB.prepare("UPDATE messages SET status='sent', sent_at=?, provider_id=?, attempts=1 WHERE id=?").bind(nowISO(), pid, m.id).run();
      return json({ok: true, via: channel === "email" ? pv.emailVia : pv.smsVia, to: to_addr, providerId: pid});
    } catch (e) {
      await env.DB.prepare("UPDATE messages SET status='failed', attempts=1, last_error=? WHERE id=?").bind(s(e.message, 400), m.id).run();
      throw new ApiError(502, "provider", "The provider refused it: " + s(e.message, 300));
    }
  }

  /* --- brand (admin) --- */
  if (path === "/api/brand" && method === "PUT") {
    if (!CORE.can(role, "brand")) throw denied("Only the administrator changes branding.");
    const prev = await loadBrand(env); const b = cleanBrand(await readJSON(req), prev);
    const store_ = {...b}; delete store_.logo;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO config (key,value,updated_at,updated_by) VALUES ('brand',?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by").bind(JSON.stringify(store_), nowISO(), user.name),
      env.DB.prepare("INSERT INTO audit (at,who,what) VALUES (?,?,?)").bind(nowISO(), user.name, "Updated the lender branding.")
    ]);
    return json({ok: true, brand: await loadBrand(env)});
  }
  if (path === "/api/brand/logo" && method === "POST") {
    if (!CORE.can(role, "brand")) throw denied();
    const form = await req.formData(); const f = form.get("file");
    if (!f || typeof f !== "object") throw bad("No file was received.");
    const ext = (f.name.split(".").pop() || "").toLowerCase(), type = {png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml"}[ext];
    if (!type) throw bad("Use a PNG, JPG, WebP or SVG.");
    if (f.size > 1024 * 1024) throw bad("Keep the logo under 1 MB.");
    await env.FILES.put("brand/logo", await f.arrayBuffer(), {metadata: {type}});
    const prev = await loadBrand(env); const b = {...prev, logoKey: "brand/logo", logoType: type, logoVersion: (prev.logoVersion || 0) + 1}; delete b.logo;
    await env.DB.prepare("INSERT INTO config (key,value,updated_at,updated_by) VALUES ('brand',?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by").bind(JSON.stringify(b), nowISO(), user.name).run();
    return json({ok: true, brand: await loadBrand(env)});
  }
  if (path === "/api/me" && method === "PATCH") {
    const b = await readJSON(req);
    const d = /^\d{4}-\d{2}-\d{2}$/;
    await env.DB.prepare("UPDATE users SET phone=?, license_no=?, license_state=?, license_expires=?, eo_expires=?, eo_carrier=?, updated_at=? WHERE id=?")
      .bind(s(b.phone, 40), s(b.licenseNo, 40), s(b.licenseState, 20), d.test(s(b.licenseExpires, 10)) ? s(b.licenseExpires, 10) : "", d.test(s(b.eoExpires, 10)) ? s(b.eoExpires, 10) : "", s(b.eoCarrier, 80), nowISO(), user.id).run();
    return json({ok: true});
  }
  if (path === "/api/me" && method === "GET") {
    const u = await env.DB.prepare("SELECT id,name,email,role,phone,license_no,license_state,license_expires,eo_expires,eo_carrier FROM users WHERE id=?").bind(user.id).first();
    return json({me: u});
  }

  /* --- people (admin) --- */
  if (p(1) === "users") {
    if (role !== "admin") throw denied("Only the lender's administrator manages people.");
    if (method === "GET" && !p(2)) {
      const rows = (await env.DB.prepare("SELECT u.id,u.email,u.name,u.role,u.phone,u.active,u.created_at,u.created_by,u.last_seen,u.license_no,u.license_state,u.license_expires,u.eo_expires,u.eo_carrier,(u.pw_hash IS NOT NULL) has_pw,(SELECT MAX(expires_at) FROM invites i WHERE i.user_id=u.id AND i.used_at IS NULL) invite_expires FROM users u ORDER BY u.name").all()).results || [];
      return json({users: rows.map(r => ({...r, active: !!r.active, has_pw: !!r.has_pw}))});
    }
    if (method === "POST" && !p(2)) {
      const b = await readJSON(req);
      const name = s(b.name, 80), email = s(b.email, 120).toLowerCase(), r = s(b.role, 20);
      if (!name) throw bad("A name is required."); if (!emailOk(email)) throw bad("A valid work email is required."); if (!CORE.ROLES[r]) throw bad("Pick a role.");
      if (await env.DB.prepare("SELECT 1 FROM users WHERE email=?").bind(email).first()) throw bad("Someone with that email already exists.");
      const id = uid("u");
      await env.DB.prepare("INSERT INTO users (id,email,name,role,phone,active,created_at,created_by,updated_at) VALUES (?,?,?,?,?,1,?,?,?)").bind(id, email, name, r, s(b.phone, 40), nowISO(), user.name, nowISO()).run();
      const code = randomToken(28);
      await env.DB.batch([
        env.DB.prepare("INSERT INTO invites (code_hash,user_id,created_by,created_at,expires_at) VALUES (?,?,?,?,?)").bind(await sha256(code), id, user.name, nowISO(), new Date(Date.now() + INVITE_DAYS * 864e5).toISOString()),
        env.DB.prepare("INSERT INTO audit (at,who,what) VALUES (?,?,?)").bind(nowISO(), user.name, "Added " + name + " (" + email + ") as " + CORE.ROLES[r].name + ".")
      ]);
      const link = publicUrl(env, req) + "/#invite=" + code;
      const mail = await inviteMail(env, ctx, req, {name, email, role: r}, user, link);
      return json({ok: true, id, inviteLink: link, expiresDays: INVITE_DAYS, emailed: mail.status === "queued"});
    }
    if (p(2) && method === "PATCH") {
      const target = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(p(2)).first();
      if (!target) throw notFound("No such person.");
      const b = await readJSON(req), sets = [], vals = [], notes = [];
      if (b.role !== undefined) { if (!CORE.ROLES[b.role]) throw bad("Unknown role."); if (target.id === user.id) throw bad("You cannot change your own role."); sets.push("role=?"); vals.push(b.role); notes.push("role to " + CORE.ROLES[b.role].name); }
      if (b.active !== undefined) {
        if (target.id === user.id) throw bad("You cannot suspend yourself.");
        if (!b.active && target.role === "admin") { const n = (await env.DB.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1").first()).n; if (n <= 1) throw bad("That is the only active administrator."); }
        sets.push("active=?"); vals.push(b.active ? 1 : 0); notes.push(b.active ? "restored" : "suspended");
      }
      if (b.name !== undefined) { const nm = s(b.name, 80); if (!nm) throw bad("Name cannot be blank."); sets.push("name=?"); vals.push(nm); notes.push("name"); }
      if (b.phone !== undefined) { sets.push("phone=?"); vals.push(s(b.phone, 40)); notes.push("phone"); }
      if (!sets.length) throw bad("Nothing to change.");
      sets.push("updated_at=?"); vals.push(nowISO()); vals.push(target.id);
      const stmts = [env.DB.prepare("UPDATE users SET " + sets.join(", ") + " WHERE id=?").bind(...vals),
        env.DB.prepare("INSERT INTO audit (at,who,what) VALUES (?,?,?)").bind(nowISO(), user.name, "Changed " + target.name + ": " + notes.join(", ") + ".")];
      if (b.active === false || b.role !== undefined) stmts.push(env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(target.id));
      await env.DB.batch(stmts);
      return json({ok: true});
    }
    if (p(2) && p(3) === "invite" && method === "POST") {
      const target = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(p(2)).first();
      if (!target) throw notFound("No such person.");
      const code = randomToken(28);
      await env.DB.batch([
        env.DB.prepare("UPDATE invites SET used_at=? WHERE user_id=? AND used_at IS NULL").bind(nowISO(), target.id),
        env.DB.prepare("INSERT INTO invites (code_hash,user_id,created_by,created_at,expires_at) VALUES (?,?,?,?,?)").bind(await sha256(code), target.id, user.name, nowISO(), new Date(Date.now() + INVITE_DAYS * 864e5).toISOString()),
        env.DB.prepare("INSERT INTO audit (at,who,what) VALUES (?,?,?)").bind(nowISO(), user.name, "Issued a new sign-in link for " + target.name + ".")
      ]);
      const link = publicUrl(env, req) + "/#invite=" + code;
      const mail = await inviteMail(env, ctx, req, target, user, link);
      return json({ok: true, inviteLink: link, expiresDays: INVITE_DAYS, emailed: mail.status === "queued"});
    }
    throw notFound();
  }
  if (path === "/api/audit" && method === "GET") {
    if (role !== "admin") throw denied();
    return json({audit: (await env.DB.prepare("SELECT at,who,what FROM audit ORDER BY id DESC LIMIT 200").all()).results || []});
  }

  /* --- config --- */
  if (path === "/api/config") {
    if (method === "GET") return json({config: await loadConfig(env, url.searchParams.get("for") || (role === "appraiser" ? user.id : undefined))});
    if (method === "PUT") {
      if (!CORE.can(role, "config")) throw denied("Only the appraiser or the administrator can change availability.");
      const c = cleanConfig(await readJSON(req));
      if (role !== "admin") c.deskCopyEmails = (await loadConfig(env)).deskCopyEmails || [];
      const key = role === "appraiser" ? "availability:" + user.id : "availability";
      await env.DB.batch([
        env.DB.prepare("INSERT INTO config (key,value,updated_at,updated_by) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by").bind(key, JSON.stringify(c), nowISO(), user.name),
        env.DB.prepare("INSERT INTO audit (at,who,what) VALUES (?,?,?)").bind(nowISO(), user.name, "Updated appraiser availability and contact settings.")
      ]);
      return json({ok: true, config: await loadConfig(env, role === "appraiser" ? user.id : undefined)});
    }
  }
  if (path === "/api/slots" && method === "GET") {
    const who = role === "appraiser" ? user.id : (url.searchParams.get("for") || undefined);
    const cfg = await loadConfig(env, who);
    return json({slots: CORE.genSlots(cfg, await bookedStarts(env, "", who), Date.now(), Number(url.searchParams.get("n")) || 8)});
  }

  /* --- feedback --- */
  if (path === "/api/feedback") {
    if (method === "GET") return json({feedback: (await env.DB.prepare("SELECT * FROM feedback ORDER BY at DESC LIMIT 500").all()).results || []});
    if (method === "POST") {
      const b = await readJSON(req); const text = s(b.text, 4000);
      if (!text) throw bad("Write a note first.");
      const kind = s(b.kind, 40) || "Note";
      await env.DB.prepare("INSERT INTO feedback (id,at,who,role,kind,screen,order_ref,text) VALUES (?,?,?,?,?,?,?,?)").bind(uid("f"), nowISO(), user.name, role, kind, s(b.screen, 40), s(b.order, 120), text).run();
      // the vendor and the lender's administrators hear about it the same minute
      const brand = await loadBrand(env);
      const admins = (await env.DB.prepare("SELECT name,email FROM users WHERE role='admin' AND active=1 AND id<>?").bind(user.id).all()).results || [];
      const to = [...admins]; if (env.VENDOR_EMAIL && emailOk(env.VENDOR_EMAIL)) to.push({name: "Vendor", email: env.VENDOR_EMAIL});
      const body = kind + " from " + user.name + " (" + CORE.ROLES[role].name + ") on Apprifi for " + brand.name + (b.screen ? ", screen: " + s(b.screen, 40) : "") + (b.order ? ", order: " + s(b.order, 120) : "") + "\n\n" + text + "\n\nAll feedback: " + publicUrl(env, req) + "/#v=feedback";
      let n = 0; for (const t of to) { const r = await queueSystemMail(env, ctx, {to_name: t.name, to_addr: t.email, subject: "Portal feedback: " + kind + " from " + user.name, template: "feedback", body}); if (r.status === "queued") n++; }
      return json({ok: true, notified: n});
    }
  }
  /* --- inbound replies that could not be matched to an order (desk and admin) --- */
  if (path === "/api/inbound" && method === "GET") {
    if (!CORE.can(role, "outbox")) throw denied();
    return json({inbound: (await env.DB.prepare("SELECT id,at,channel,from_addr,from_name,order_id,subject,body,handled FROM inbound ORDER BY at DESC LIMIT 200").all()).results || []});
  }

  /* --- outbox --- */
  if (p(1) === "messages") {
    if (method === "GET" && !p(2)) {
      const st = url.searchParams.get("status");
      const q = st ? env.DB.prepare("SELECT m.*, o.data FROM messages m LEFT JOIN orders o ON o.id=m.order_id WHERE m.status=? ORDER BY m.created_at DESC LIMIT 300").bind(st)
                   : env.DB.prepare("SELECT m.*, o.data FROM messages m LEFT JOIN orders o ON o.id=m.order_id ORDER BY m.created_at DESC LIMIT 300");
      const rows = (await q.all()).results || [];
      return json({messages: rows.map(r => { let addr = ""; try { const d = JSON.parse(r.data); addr = d.addr; } catch (e) {} const {data, ...m} = r; m.order_addr = addr || (m.kind === "system" ? "System" : ""); return m; })});
    }
    if (p(2) && method === "POST" && p(3) === "mark") {
      if (!CORE.can(role, "outbox")) throw denied();
      const b = await readJSON(req); const st = b.status === "sent" ? "sent" : "manual";
      const m = await env.DB.prepare("SELECT * FROM messages WHERE id=?").bind(p(2)).first();
      if (!m) throw notFound();
      await env.DB.batch([
        env.DB.prepare("UPDATE messages SET status=?, sent_at=?, sent_by=? WHERE id=?").bind(st, st === "sent" ? nowISO() : null, st === "sent" ? user.name : null, m.id),
        env.DB.prepare("INSERT INTO events (order_id,at,who,role,what) VALUES (?,?,?,?,?)").bind(m.order_id, nowISO(), user.name, role, (st === "sent" ? "Sent by hand: " : "Marked unsent: ") + m.channel.toUpperCase() + " to " + m.to_name + (m.subject ? " (" + m.subject + ")" : ""))
      ]);
      return json({ok: true});
    }
    if (p(2) && method === "POST" && p(3) === "retry") {
      if (!CORE.can(role, "outbox")) throw denied();
      await env.DB.prepare("UPDATE messages SET status='queued', attempts=0, last_error=NULL WHERE id=? AND to_addr<>''").bind(p(2)).run();
      ctx.waitUntil(dispatch(env, 8));
      return json({ok: true});
    }
    throw notFound();
  }

  /* --- orders --- */
  if (p(1) === "orders") {
    if (method === "GET" && !p(2)) return json({orders: await listOrders(env, url.searchParams.get("since") || ""), time: nowISO()});
    if (method === "POST" && !p(2)) {
      if (!CORE.can(role, "place")) throw denied("Only the appraisal desk places orders.");
      const b = await readJSON(req);
      const o = await createOrder(env, publicUrl(env, req), ctx, b, user);
      return json({ok: true, order: o});
    }
    const id = s(p(2), 40);
    if (!id) throw notFound();
    if (method === "GET" && !p(3)) {
      const row = await getOrderRow(env, id); if (!row) throw notFound("That order does not exist.");
      return json({order: await orderDetail(env, rowToOrder(row))});
    }
    if (method === "GET" && p(3) === "log.txt") {
      const row = await getOrderRow(env, id); if (!row) throw notFound();
      const o = await orderDetail(env, rowToOrder(row));
      return new Response(logText(o, await loadConfig(env)), {headers: {"content-type": "text/plain; charset=utf-8", "content-disposition": contentDisposition("independence-record-" + id.slice(0, 12) + ".txt"), "cache-control": "no-store"}});
    }
    if (method === "POST" && p(3) === "actions") {
      const b = await readJSON(req);
      const action = s(b.action, 20);
      if (!/^[a-z]+$/.test(action)) throw bad("Unknown action.");
      const r = await runAction(env, publicUrl(env, req), ctx, id, action, b.params || {}, {name: user.name, role, id: user.id}, {from: b.from, version: b.version});
      return json({ok: true, reply: r.reply, order: await orderDetail(env, r.order), queued: r.queued});
    }
    if (p(3) === "docs") {
      const row = await getOrderRow(env, id); if (!row) throw notFound("That order does not exist.");
      const o = rowToOrder(row);
      if (method === "POST" && !p(4)) {
        if (!CORE.can(role, "docs")) throw denied("Your role cannot upload documents.");
        if (o.cancelled) throw bad("This order was cancelled.");
        const form = await req.formData();
        const kind = CORE.DOC_KINDS[form.get("kind")] ? form.get("kind") : "other";
        const visible = form.get("clientVisible") === "1" || (CORE.DOC_KINDS[kind].client && role === "appraiser");
        const files = form.getAll("file").filter(f => f && typeof f === "object" && f.size !== undefined);
        if (!files.length) throw bad("No file was received.");
        const added = [], events = [];
        for (const f of files) {
          const did = await saveUpload(env, o, f, kind, visible, user.name, role);
          added.push(did); events.push({at: nowISO(), who: user.name, role, what: "Uploaded " + f.name + " (" + CORE.DOC_KINDS[kind].name + ", " + f.size + " bytes" + (visible ? ", visible to the client" : "") + ")."});
        }
        await writeEvents(env, o.id, events);
        await env.DB.prepare("UPDATE orders SET updated_at=? WHERE id=?").bind(nowISO(), o.id).run();
        return json({ok: true, added, order: await orderDetail(env, rowToOrder(await getOrderRow(env, id)))});
      }
      if (p(4) && method === "DELETE") {
        const d = await env.DB.prepare("SELECT * FROM docs WHERE id=? AND order_id=? AND deleted_at IS NULL").bind(p(4), o.id).first();
        if (!d) throw notFound("That document is gone.");
        if (!(role === "admin" || role === "desk" || d.uploaded_role === role)) throw denied("You can only remove documents your side uploaded.");
        await env.DB.batch([
          env.DB.prepare("UPDATE docs SET deleted_at=?, deleted_by=? WHERE id=?").bind(nowISO(), user.name, d.id),
          env.DB.prepare("INSERT INTO events (order_id,at,who,role,what) VALUES (?,?,?,?,?)").bind(o.id, nowISO(), user.name, role, "Removed document " + d.name + " (kept in storage for the record)."),
          env.DB.prepare("UPDATE orders SET updated_at=? WHERE id=?").bind(nowISO(), o.id)
        ]);
        return json({ok: true});
      }
      if (p(4) && method === "PATCH") {
        if (!CORE.can(role, "docs")) throw denied();
        const b = await readJSON(req);
        const d = await env.DB.prepare("SELECT * FROM docs WHERE id=? AND order_id=? AND deleted_at IS NULL").bind(p(4), o.id).first();
        if (!d) throw notFound();
        const vis = b.clientVisible ? 1 : 0, kind = CORE.DOC_KINDS[b.kind] ? b.kind : d.kind;
        await env.DB.batch([
          env.DB.prepare("UPDATE docs SET client_visible=?, kind=? WHERE id=?").bind(vis, kind, d.id),
          env.DB.prepare("INSERT INTO events (order_id,at,who,role,what) VALUES (?,?,?,?,?)").bind(o.id, nowISO(), user.name, role, "Document " + d.name + ": " + CORE.DOC_KINDS[kind].name + (vis ? ", visible to the client." : ", staff only.")),
          env.DB.prepare("UPDATE orders SET updated_at=? WHERE id=?").bind(nowISO(), o.id)
        ]);
        return json({ok: true});
      }
    }
    throw notFound();
  }
  throw notFound("No such API route.");
}

/* ---------- provider webhooks ---------- */
const twiml = () => new Response("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>", {headers: {"content-type": "text/xml"}});
async function hooks(req, env, ctx, p) {
  if (req.method !== "POST") throw notFound();
  if (p(2) === "twilio" && (p(3) === "status" || p(3) === "inbound")) {
    const params = new URLSearchParams(await req.text());
    if (!(await twilioSignatureOk(env, req, params))) throw denied("Bad Twilio signature.");
    if (p(3) === "status") {
      const sid = s(params.get("MessageSid") || params.get("SmsSid"), 60), status = s(params.get("MessageStatus") || params.get("SmsStatus"), 30).toLowerCase();
      const err = s(params.get("ErrorCode"), 20);
      if (sid && status) {
        const m = await env.DB.prepare("SELECT id,order_id,to_name,delivery FROM messages WHERE provider_id=?").bind(sid).first();
        if (m) {
          await env.DB.prepare("UPDATE messages SET delivery=?, delivery_at=?, last_error=? WHERE id=?").bind(status + (err ? " (" + err + ")" : ""), nowISO(), ["undelivered", "failed"].includes(status) ? "Carrier reported " + status + (err ? ", code " + err : "") : null, m.id).run();
          if (["undelivered", "failed"].includes(status) && m.order_id) await writeEvents(env, m.order_id, [{at: nowISO(), who: "Carrier", role: "system", what: "Text to " + m.to_name + " was " + status + (err ? " (Twilio error " + err + ")" : "") + ". Call them instead."}]);
        }
      }
      return twiml();
    }
    const from = s(params.get("From"), 40), body = s(params.get("Body"), 2000), sid = s(params.get("MessageSid"), 60);
    const word = body.trim().toUpperCase();
    if (/^(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT)$/.test(word)) {
      await env.DB.prepare("INSERT INTO optouts (addr,channel,at,source) VALUES (?,'sms',?,'STOP by text') ON CONFLICT(addr) DO UPDATE SET at=excluded.at, source=excluded.source").bind(normalizePhone(from), nowISO()).run();
      await env.DB.prepare("INSERT INTO inbound (id,at,channel,from_addr,order_id,body,provider_id,handled) VALUES (?,?,'sms',?,'',?,?,'optout')").bind(uid("i"), nowISO(), normalizePhone(from), body, sid).run();
      return twiml();
    }
    if (/^(START|UNSTOP|YES)$/.test(word)) {
      await env.DB.prepare("DELETE FROM optouts WHERE addr=? AND channel='sms'").bind(normalizePhone(from)).run();
      await env.DB.prepare("INSERT INTO inbound (id,at,channel,from_addr,order_id,body,provider_id,handled) VALUES (?,?,'sms',?,'',?,?,'optin')").bind(uid("i"), nowISO(), normalizePhone(from), body, sid).run();
      return twiml();
    }
    await handleInbound(env, (env.PUBLIC_URL || new URL(req.url).origin).replace(/\/$/, ""), ctx, {channel: "sms", from, body, providerId: sid});
    return twiml();
  }
  throw notFound();
}

/* ---------- file download: /f/<orderId>/<docId>[?t=token] ---------- */
async function fileRoute(req, env) {
  const url = new URL(req.url), m = /^\/f\/([a-z0-9]+)\/([a-z0-9]+)$/i.exec(url.pathname);
  if (!m || req.method !== "GET") throw notFound();
  const d = await env.DB.prepare("SELECT * FROM docs WHERE id=? AND order_id=? AND deleted_at IS NULL").bind(m[2], m[1]).first();
  if (!d) throw notFound("That file is not available.");
  const tok = url.searchParams.get("t");
  if (tok) {
    if (await limited(env, "file:" + ip(req), 120, 10 * 60e3)) throw new ApiError(429, "rate", "Too many requests.");
    const row = await env.DB.prepare("SELECT * FROM orders WHERE id=? AND (tok_b=? OR tok_a=?)").bind(m[1], tok, tok).first();
    if (!row) throw denied("This link cannot open that file.");
    const o = rowToOrder(row), party = row.tok_b === tok ? "borrower" : "agent";
    if (!d.client_visible || o.step < 6) throw denied("This file is not available to you.");
    if (!(o.consent && o.consent[party])) throw denied("Please agree to electronic delivery on your status page first.");
    await writeEvents(env, o.id, [{at: nowISO(), who: party === "agent" ? (o.agentName || "Agent") : (o.borrowerName || "Borrower"), role: "client", what: "Downloaded " + d.name + "."}]);
  } else {
    const user = await currentUser(env, req);
    if (!user) throw new ApiError(401, "signin", "Please sign in.");
    if (user.role === "officer" && !["report", "addendum", "invoice"].includes(d.kind)) throw denied(CORE.ROLES.officer.name + "s can open the finished report and invoice only.");
    // downloads of the other side's documents go on the record (an appraiser opening their own report does not)
    if (user.role !== d.uploaded_role) await writeEvents(env, d.order_id, [{at: nowISO(), who: user.name, role: user.role, what: "Downloaded " + d.name + "."}]);
  }
  const body = await store(env, d.storage).get(d.key);
  if (!body) throw notFound("The file bytes are missing from storage.");
  return new Response(body, {headers: {"content-type": d.type, "content-disposition": contentDisposition(d.name), "cache-control": "private, no-store", "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'", "x-frame-options": "DENY", "referrer-policy": "no-referrer"}});
}

const SEC = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin", "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()", "strict-transport-security": "max-age=31536000"
};
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    CORE.setClientType(env.CLIENT_TYPE || "lender");
    try {
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return await api(req, env, ctx);
      if (url.pathname.startsWith("/f/")) return await fileRoute(req, env);
      if (url.pathname === "/brand/logo") {
        const v = await env.FILES.getWithMetadata("brand/logo", "stream");
        if (!v || !v.value) throw notFound();
        return new Response(v.value, {headers: {"content-type": (v.metadata && v.metadata.type) || "image/png", "cache-control": "public, max-age=3600"}});
      }
      const res = await env.ASSETS.fetch(req);
      const h = new Headers(res.headers);
      Object.entries(SEC).forEach(([k, v]) => h.set(k, v));
      if ((h.get("content-type") || "").includes("text/html")) h.set("cache-control", "no-cache");
      return new Response(res.body, {status: res.status, headers: h});
    } catch (e) {
      if (e instanceof ApiError) {
        if (url.pathname.startsWith("/f/")) return new Response(e.message, {status: e.status, headers: {"content-type": "text/plain"}});
        return json({error: e.code, message: e.message}, e.status);
      }
      console.error(e && e.stack || e);
      return json({error: "server", message: "Something went wrong on the server. " + (env.DEBUG ? String(e && e.message) : "Try again.")}, 500);
    }
  },
  /* Inbound mail (Cloudflare Email Routing -> this Worker). Replies to desk+<orderId>@domain land on that order's
     conversation; anything else is matched by the sender's address; the rest waits on the Outbox screen. */
  async email(message, env, ctx) {
    CORE.setClientType(env.CLIENT_TYPE || "lender");
    const base = (env.PUBLIC_URL || "").replace(/\/$/, "");
    let parsed;
    try { parsed = await PostalMime.parse(message.raw); } catch (e) { parsed = {}; }
    const to = String(message.to || "").toLowerCase();
    const tag = /\+([a-z0-9]+)@/i.exec(to);
    const fromAddr = (parsed.from && parsed.from.address) || String(message.from || "");
    const fromName = (parsed.from && parsed.from.name) || "";
    const text = parsed.text || (parsed.html ? String(parsed.html).replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/[ \t]+/g, " ").trim() : "");
    if (env.DEMO) return; // the demonstration copy ignores mail
    const r = await handleInbound(env, base, ctx, {channel: "email", from: fromAddr, fromName, subject: parsed.subject || "", body: text, providerId: parsed.messageId || "", orderId: tag ? tag[1] : ""});
    // attachments from a matched client become documents on the order
    if (r.orderId && r.handled === "posted" && Array.isArray(parsed.attachments)) {
      const row = await getOrderRow(env, r.orderId); if (!row) return;
      const o = rowToOrder(row), who = s(fromName || fromAddr, 120);
      for (const a of parsed.attachments.slice(0, 10)) {
        const name = s(a.filename || "attachment", 200), buf = a.content instanceof ArrayBuffer ? a.content : (a.content && a.content.buffer) || null;
        if (!buf || !buf.byteLength) continue;
        try {
          const f = {name, size: buf.byteLength, arrayBuffer: async () => buf};
          await saveUpload(env, o, f, "other", false, who, "client");
          await writeEvents(env, o.id, [{at: nowISO(), who, role: "client", what: "Attached " + name + " by email (" + buf.byteLength + " bytes)."}]);
        } catch (e) { await writeEvents(env, o.id, [{at: nowISO(), who, role: "client", what: "Email attachment " + name + " was not kept: " + s(e.message, 200)}]); }
      }
    }
  },
  async scheduled(event, env, ctx) {
    CORE.setClientType(env.CLIENT_TYPE || "lender");
    ctx.waitUntil((async () => {
      if (env.DEMO && event.cron === "0 8 * * *") { await resetDemo(env, (env.PUBLIC_URL || "").replace(/\/$/, ""), {createOrder, runAction, setPassword, store, writeEvents, uid, randomToken, nowISO}); return; }
      await env.DB.prepare("UPDATE messages SET status='queued' WHERE status='sending' AND created_at < ?").bind(new Date(Date.now() - 10 * 60e3).toISOString()).run();
      await dispatch(env, 50);
      const d = new Date(); if (d.getUTCHours() === 13 && d.getUTCMinutes() < 5) await runNudges(env, (env.PUBLIC_URL || "").replace(/\/$/, ""));
      await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(nowISO()).run();
      await env.DB.prepare("DELETE FROM ratelimit WHERE window_start < ?").bind(Date.now() - 864e5).run();
    })());
  }
};
