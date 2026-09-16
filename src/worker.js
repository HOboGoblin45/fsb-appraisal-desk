/* FSB Appraisal Desk: Cloudflare Worker.
   Serves the app (static assets) and the JSON API. D1 holds orders, people, the audit log and
   the message queue; KV (or R2) holds document bytes. Sessions are HttpOnly cookies backed by D1.
   Nothing here trusts the browser: every transition is re-validated by CORE.applyAction. */
import CORE from "./core.js";
import {resetDemo} from "./demo.js";

const COOKIE = "fsb_session";
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

/* ---------- config ---------- */
async function loadConfig(env) {
  const row = await env.DB.prepare("SELECT value, updated_at FROM config WHERE key='availability'").first();
  const c = CORE.defaultConfig();
  if (row) { try { Object.assign(c, JSON.parse(row.value)); c.updatedAt = row.updated_at; } catch (e) {} }
  return c;
}
function cleanConfig(input) {
  const c = CORE.defaultConfig();
  const n = (k, lo, hi, d) => { const v = Number(input[k]); c[k] = isFinite(v) && v >= lo && v <= hi ? v : d; };
  n("startHour", 5, 12, 8.5); n("endHour", 12, 21, 16); n("slotMinutes", 15, 240, 60); n("bufferMinutes", 0, 180, 45); n("leadHours", 0, 168, 24);
  c.days = Array.isArray(input.days) ? input.days.map(Number).filter(d => d >= 0 && d <= 6) : [1, 2, 3, 4, 5];
  c.daysOff = Array.isArray(input.daysOff) ? input.daysOff.map(x => s(x, 10)).filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x)).slice(0, 200) : [];
  c.appraiserName = s(input.appraiserName, 80); c.appraiserPhone = s(input.appraiserPhone, 40); c.appraiserEmail = s(input.appraiserEmail, 120).toLowerCase();
  c.note = s(input.note, 500); c.timeZone = CORE.TZ;
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
    env.DB.prepare("SELECT id,created_at,channel,party,to_name,to_addr,subject,body,template,status,attempts,last_error,sent_at,sent_by FROM messages WHERE order_id=? ORDER BY created_at, id").bind(o.id).all()
  ]);
  o.docs = (docs.results || []).map(d => ({...d, client_visible: !!d.client_visible}));
  o.hasReport = o.docs.some(d => d.kind === "report");
  o.events = events.results || [];
  o.messages = msgs.results || [];
  return o;
}
async function bookedStarts(env, exceptId) {
  const rows = (await env.DB.prepare("SELECT appt_start FROM orders WHERE appt_start IS NOT NULL AND cancelled=0 AND declined=0 AND id<>?").bind(exceptId || "").all()).results || [];
  return rows.map(r => Date.parse(r.appt_start)).filter(isFinite);
}
function publicUrl(env, req) { return (env.PUBLIC_URL || new URL(req.url).origin).replace(/\/$/, ""); }

/* Resolve template messages to addresses, then queue them. */
async function queueMessages(env, base, o, msgs, at) {
  if (!msgs.length) return [];
  at = at || nowISO();
  const appraisers = (await env.DB.prepare("SELECT name,email,phone FROM users WHERE role='appraiser' AND active=1").all()).results || [];
  const cfg = await loadConfig(env);
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
    else if (m.party === "officer") targets = [{name: o.officerName || "Loan officer", email: o.officerEmail, phone: ""}];
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
  const cfg = await loadConfig(env);
  const at = opts.now || nowISO();
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await getOrderRow(env, orderId);
    if (!row) throw notFound("That order does not exist.");
    const o = rowToOrder(row);
    if (opts.from !== undefined && opts.from !== null && Number(opts.from) !== o.step) throw new ApiError(409, "stale", "This order already moved to " + CORE.statusOf(o) + ".");
    if (opts.version !== undefined && opts.version !== null && Number(opts.version) !== o.version) throw new ApiError(409, "stale", "Someone else changed this order. It has been reloaded.");
    const p = {...params};
    if (action === "book") p.booked = await bookedStarts(env, o.id);
    if (action === "deliver") p.hasReport = !!(await env.DB.prepare("SELECT 1 FROM docs WHERE order_id=? AND kind='report' AND deleted_at IS NULL LIMIT 1").bind(o.id).first());
    if (action === "reissue") { o.tokB = randomToken(22); o.tokA = randomToken(22); }
    let result;
    try { result = CORE.applyAction(o, action, p, actor, cfg, at); }
    catch (e) { if (e && e.code) throw new ApiError(e.code === "forbidden" ? 403 : 409, e.code, e.msg || e.message); throw e; }
    const data = {...o}; ["id", "version", "step", "hold", "declined", "cancelled", "tokB", "tokA", "apptStart", "createdAt", "updatedAt", "docs", "events", "messages", "docCount", "hasReport", "unsent"].forEach(k => delete data[k]);
    const f = orderFields(o);
    const r = await env.DB.prepare("UPDATE orders SET version=version+1, step=?, hold=?, declined=?, cancelled=?, appt_start=?, updated_at=?, tok_b=?, tok_a=?, data=? WHERE id=? AND version=?")
      .bind(f[0], f[1], f[2], f[3], f[4], f[5], o.tokB, o.tokA, JSON.stringify(data), o.id, row.version).run();
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
  if (!b.attestation) throw bad("The recusal attestation is required before an order can be placed.");
  const o = {
    addr, city: s(b.city, 120), loan: s(b.loan, 60), type: CORE.REPORT_TYPES.includes(b.type) ? b.type : CORE.REPORT_TYPES[0],
    purpose: CORE.PURPOSES.includes(b.purpose) ? b.purpose : "Purchase", due: /^\d{4}-\d{2}-\d{2}$/.test(s(b.due, 10)) ? s(b.due, 10) : "",
    fee: Number(b.fee) || 0, rush: !!b.rush, borrowerName: s(b.borrowerName, 120), borrowerPhone: s(b.borrowerPhone, 40), borrowerEmail: s(b.borrowerEmail, 120).toLowerCase(),
    agentName: s(b.agentName, 120), agentPhone: s(b.agentPhone, 40), agentEmail: s(b.agentEmail, 120).toLowerCase(),
    accessVia: CORE.ACCESS.includes(b.accessVia) ? b.accessVia : "Borrower", notes: s(b.notes, 2000),
    officerName: s(b.officerName, 120), officerEmail: s(b.officerEmail, 120).toLowerCase(),
    step: 0, hold: false, holdReason: "", declined: false, cancelled: false, clientContacted: false,
    orderedBy: user.name, orderedByRole: CORE.ROLES[role].name, orderedByEmail: user.email, orderedById: user.id, orderedAt: at, attestation: true,
    createdAt: at, updatedAt: at
  };
  if (o.borrowerEmail && !emailOk(o.borrowerEmail)) throw bad("The borrower email does not look right.");
  if (o.agentEmail && !emailOk(o.agentEmail)) throw bad("The agent email does not look right.");
  if (o.officerEmail && !emailOk(o.officerEmail)) throw bad("The loan officer email does not look right.");
  const id = uid("o"), tokB = randomToken(22), tokA = randomToken(22);
  const cfg = await loadConfig(env);
  const data = {...o}; delete data.createdAt; delete data.updatedAt;
  await env.DB.prepare("INSERT INTO orders (id,version,step,hold,declined,cancelled,tok_b,tok_a,appt_start,created_at,updated_at,data) VALUES (?,1,0,0,0,0,?,?,NULL,?,?,?)").bind(id, tokB, tokA, o.createdAt, o.updatedAt, JSON.stringify(data)).run();
  o.id = id; o.tokB = tokB; o.tokA = tokA; o.version = 1;
  await writeEvents(env, id, [{at, who: user.name, role, what: "Order created. Recusal attestation recorded."}]);
  const msgs = CORE.templates.created(o, cfg).map(m => ({...m, template: "created"}));
  const queued = await queueMessages(env, base, o, msgs, at);
  if (ctx && queued.some(q => q.status === "queued")) ctx.waitUntil(dispatch(env, 8));
  return o;
}

/* ---------- sending ---------- */
function providers(env) {
  return {email: !!(env.EMAIL || env.RESEND_API_KEY), emailVia: env.EMAIL ? "cloudflare" : (env.RESEND_API_KEY ? "resend" : ""), sms: !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM)};
}
async function sendEmail(env, m) {
  const from = env.MAIL_FROM || "First Security Bank Appraisal Desk <appraisals@fsb.apprifi.com>";
  if (env.EMAIL) {
    // Cloudflare Email Service binding: the sending domain is verified in the same account
    const r = await env.EMAIL.send({to: m.to_addr, from, subject: m.subject || "First Security Bank appraisal update", text: m.body, replyTo: env.MAIL_REPLY_TO || undefined});
    return (r && r.messageId) || "";
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: {"authorization": "Bearer " + env.RESEND_API_KEY, "content-type": "application/json"},
    body: JSON.stringify({from, to: [m.to_addr], subject: m.subject || "First Security Bank appraisal update", text: m.body, reply_to: env.MAIL_REPLY_TO || undefined})
  });
  const t = await res.text();
  if (!res.ok) throw new Error("Resend " + res.status + ": " + t.slice(0, 300));
  try { return JSON.parse(t).id || ""; } catch (e) { return ""; }
}
async function sendSms(env, m) {
  const url = "https://api.twilio.com/2010-04-01/Accounts/" + env.TWILIO_ACCOUNT_SID + "/Messages.json";
  const body = new URLSearchParams({From: env.TWILIO_FROM, To: normalizePhone(m.to_addr), Body: m.body});
  const res = await fetch(url, {method: "POST", headers: {"authorization": "Basic " + btoa(env.TWILIO_ACCOUNT_SID + ":" + env.TWILIO_AUTH_TOKEN), "content-type": "application/x-www-form-urlencoded"}, body});
  const t = await res.text();
  if (!res.ok) throw new Error("Twilio " + res.status + ": " + t.slice(0, 300));
  try { return JSON.parse(t).sid || ""; } catch (e) { return ""; }
}
function normalizePhone(p) { const d = String(p || "").replace(/\D/g, ""); if (d.length === 10) return "+1" + d; if (d.length === 11 && d[0] === "1") return "+" + d; return String(p || ""); }
async function dispatch(env, limit = 20) {
  const pv = providers(env), emailOn = pv.email, smsOn = pv.sms;
  if (!emailOn && !smsOn) return 0;
  const rows = (await env.DB.prepare("SELECT * FROM messages WHERE status='queued' AND attempts<6 ORDER BY created_at LIMIT ?").bind(limit).all()).results || [];
  let n = 0;
  for (const m of rows) {
    if ((m.channel === "email" && !emailOn) || (m.channel === "sms" && !smsOn)) continue;
    try {
      const pid = m.channel === "email" ? await sendEmail(env, m) : await sendSms(env, m);
      await env.DB.prepare("UPDATE messages SET status='sent', sent_at=?, provider_id=?, attempts=attempts+1, last_error=NULL WHERE id=?").bind(nowISO(), pid, m.id).run(); n++;
    } catch (e) {
      const final = m.attempts + 1 >= 6;
      await env.DB.prepare("UPDATE messages SET status=?, attempts=attempts+1, last_error=? WHERE id=?").bind(final ? "failed" : "queued", s(e.message, 400), m.id).run();
    }
  }
  return n;
}

/* ---------- documents ---------- */
function store(env) {
  if (env.BUCKET) return {
    kind: "r2",
    put: (key, buf, type) => env.BUCKET.put(key, buf, {httpMetadata: {contentType: type}}),
    get: async key => { const obj = await env.BUCKET.get(key); return obj ? obj.body : null; },
    del: key => env.BUCKET.delete(key)
  };
  return {
    kind: "kv",
    put: (key, buf, type) => env.FILES.put(key, buf, {metadata: {type}}),
    get: key => env.FILES.get(key, "stream"),
    del: key => env.FILES.delete(key)
  };
}
function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/* ---------- independence log ---------- */
function logText(o, cfg) {
  const L = [];
  L.push("APPRAISER INDEPENDENCE RECORD"); L.push("");
  L.push("Property: " + o.addr + ", " + o.city); L.push("Order: " + o.id); L.push("Loan number: " + (o.loan || "not provided"));
  L.push("Report type: " + o.type + ", " + o.purpose); L.push("Client: First Security Bank, Mackinaw, Illinois");
  L.push("Appraiser: " + (o.appraiserName || cfg.appraiserName || "not recorded")); L.push("Status: " + CORE.statusOf(o)); L.push("Exported: " + new Date().toISOString()); L.push("");
  L.push("ORDERING AND RECUSAL");
  L.push("Ordered by: " + o.orderedBy + " (" + o.orderedByRole + ", " + (o.orderedByEmail || "") + ")"); L.push("Ordered at: " + o.orderedAt);
  L.push("Loan officer on file: " + (o.officerName || "not recorded"));
  L.push("Recusal attestation: " + (o.attestation ? "RECORDED" : "NOT RECORDED"));
  L.push('Attested text: "I will abstain from participating in any decision to approve, not approve, or set the terms of this transaction."');
  L.push("Control reference: 12 CFR 1026.42(d)(3)(ii); Interagency Appraisal and Evaluation Guidelines, 2010."); L.push("");
  L.push("Identities in this record are authenticated portal accounts (email and password) with roles assigned by the bank administrator."); L.push("");
  L.push("DOCUMENTS");
  (o.docs || []).forEach(d => L.push("  " + d.uploaded_at + "  " + d.name + "  (" + d.size + " bytes, " + d.kind + ")  uploaded by " + d.uploaded_by + " (" + d.uploaded_role + ")"));
  if (!(o.docs || []).length) L.push("  none"); L.push("");
  L.push("ACTIVITY (append-only server record)");
  (o.events || []).forEach(e => L.push("  " + e.at + "  " + e.who + " (" + e.role + ")  " + e.what)); L.push("");
  L.push("MESSAGES");
  (o.messages || []).forEach(m => { L.push("  " + m.created_at + "  " + m.channel.toUpperCase() + " to " + m.to_name + (m.to_addr ? " <" + m.to_addr + ">" : "") + "  [" + m.status + (m.sent_at ? " " + m.sent_at : "") + "]" + (m.subject ? "  subject: " + m.subject : "")); L.push("      " + m.body.replace(/\n/g, "\n      ")); });
  if (!(o.messages || []).length) L.push("  none"); L.push("");
  L.push("Generated by the FSB Appraisal Desk portal.");
  return L.join("\n");
}
function icsFor(o, cfg) {
  const dt = iso => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const esc = t => String(t || "").replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//First Security Bank//Appraisal Desk//EN", "METHOD:PUBLISH", "BEGIN:VEVENT",
    "UID:" + o.id + "@fsb.apprifi.com", "DTSTAMP:" + dt(nowISO()), "DTSTART:" + dt(o.apptStart), "DTEND:" + dt(o.apptEnd || (Date.parse(o.apptStart) + 3600e3)),
    "SUMMARY:" + esc("Appraisal inspection: " + o.addr), "LOCATION:" + esc(o.addr + ", " + o.city),
    "DESCRIPTION:" + esc(CORE.aprCap(cfg) + " will need access to every room, the basement and the garage. " + CORE.contactLine(cfg)),
    "END:VEVENT", "END:VCALENDAR"].join("\r\n");
}

/* ---------- API router ---------- */
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
async function api(req, env, ctx) {
  const url = new URL(req.url), path = url.pathname.replace(/\/+$/, ""), method = req.method;
  const seg = path.split("/").filter(Boolean); // ["api", ...]
  if (MUTATING.has(method)) {
    // same-origin only: browsers always send Origin on these methods; the custom header defeats form posts
    const origin = req.headers.get("origin");
    if (origin && origin !== url.origin) throw denied("Cross-site request refused.");
    if (req.headers.get("x-requested-with") !== "FSB") throw denied("Missing request header.");
  }
  const p = (i) => seg[i] || "";

  if (path === "/api/health") return json({ok: true, time: nowISO()});

  /* --- client (token) endpoints, no session --- */
  if (p(1) === "client" && p(2)) {
    const tok = s(p(2), 40);
    if (await limited(env, "client:" + ip(req), 240, 10 * 60e3)) throw new ApiError(429, "rate", "Too many requests. Wait a minute.");
    const row = await env.DB.prepare("SELECT * FROM orders WHERE tok_b=? OR tok_a=?").bind(tok, tok).first();
    if (!row) throw notFound("This link is not valid.");
    const o = rowToOrder(row), party = row.tok_b === tok ? "borrower" : "agent";
    const cfg = await loadConfig(env);
    const actor = {name: party === "agent" ? (o.agentName || "Agent") : (o.borrowerName || "Borrower"), role: "client"};
    if (method === "GET" && !p(3)) {
      const booked = await bookedStarts(env, o.id);
      const report = o.step >= 6 ? await env.DB.prepare("SELECT id,name,size FROM docs WHERE order_id=? AND deleted_at IS NULL AND client_visible=1 AND kind IN ('report','addendum') ORDER BY uploaded_at DESC LIMIT 1").bind(o.id).first() : null;
      return json({
        orderId: o.id, addr: o.addr, city: o.city, step: o.step, hold: !!o.hold, declined: !!o.declined, cancelled: !!o.cancelled,
        apptStart: o.apptStart, apptEnd: o.apptEnd || null, party, who: actor.name, contactParty: CORE.contactParty(o),
        slotMinutes: cfg.slotMinutes, appraiser: {name: cfg.appraiserName || "", phone: cfg.appraiserPhone || ""},
        slots: o.step === 2 && !o.hold && !o.cancelled ? CORE.genSlots(cfg, booked, Date.now(), 24) : [],
        report: report || null, consent: !!(o.consent && o.consent[party]), tz: cfg.timeZone || CORE.TZ
      });
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
    const out = {user: user ? pubUser(user) : null, provisioned: count > 0, providers: providers(env), time: nowISO(), storage: env.BUCKET ? "r2" : "kv", demo: !!env.DEMO};
    if (user) out.config = await loadConfig(env);
    return json(out);
  }
  if (path === "/api/login" && method === "POST") {
    requireSecret(env);
    const b = await readJSON(req);
    const email = s(b.email, 120).toLowerCase(), password = String(b.password || "");
    if (await limited(env, "login:ip:" + ip(req), 30, 15 * 60e3) || await limited(env, "login:em:" + email, 10, 15 * 60e3)) throw new ApiError(429, "rate", "Too many sign-in attempts. Wait 15 minutes.");
    const u = await env.DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first();
    const generic = new ApiError(401, "auth", "That email and password do not match.");
    if (!u || !u.pw_hash) throw generic;
    if (!u.active) throw new ApiError(403, "suspended", "This account has been suspended by the bank administrator.");
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
      const inv = await env.DB.prepare("SELECT i.expires_at,i.used_at,u.name,u.email,u.role,u.active FROM invites i JOIN users u ON u.id=i.user_id WHERE i.code_hash=?").bind(await sha256(s(p(2), 60))).first();
      if (!inv || inv.used_at || inv.expires_at < nowISO() || !inv.active) throw notFound("This invitation is not valid any more. Ask the bank administrator for a new one.");
      return json({name: inv.name, email: inv.email, role: inv.role});
    }
    if (method === "POST" && p(2) === "accept") {
      const b = await readJSON(req);
      const h = await sha256(s(b.code, 60));
      const inv = await env.DB.prepare("SELECT i.user_id,i.expires_at,i.used_at,u.active,u.name FROM invites i JOIN users u ON u.id=i.user_id WHERE i.code_hash=?").bind(h).first();
      if (!inv || inv.used_at || inv.expires_at < nowISO() || !inv.active) throw notFound("This invitation is not valid any more. Ask the bank administrator for a new one.");
      await setPassword(env, inv.user_id, b.password);
      await env.DB.batch([
        env.DB.prepare("UPDATE invites SET used_at=? WHERE code_hash=?").bind(nowISO(), h),
        env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(inv.user_id),
        env.DB.prepare("INSERT INTO audit (at,who,what) VALUES (?,?,?)").bind(nowISO(), inv.name, "Accepted invitation and set a password.")
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
    return json({ok: true});
  }

  /* --- people (admin) --- */
  if (p(1) === "users") {
    if (role !== "admin") throw denied("Only the bank administrator manages people.");
    if (method === "GET" && !p(2)) {
      const rows = (await env.DB.prepare("SELECT u.id,u.email,u.name,u.role,u.phone,u.active,u.created_at,u.created_by,u.last_seen,(u.pw_hash IS NOT NULL) has_pw,(SELECT MAX(expires_at) FROM invites i WHERE i.user_id=u.id AND i.used_at IS NULL) invite_expires FROM users u ORDER BY u.name").all()).results || [];
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
      return json({ok: true, id, inviteLink: publicUrl(env, req) + "/#invite=" + code, expiresDays: INVITE_DAYS});
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
      return json({ok: true, inviteLink: publicUrl(env, req) + "/#invite=" + code, expiresDays: INVITE_DAYS});
    }
    throw notFound();
  }
  if (path === "/api/audit" && method === "GET") {
    if (role !== "admin") throw denied();
    return json({audit: (await env.DB.prepare("SELECT at,who,what FROM audit ORDER BY id DESC LIMIT 200").all()).results || []});
  }

  /* --- config --- */
  if (path === "/api/config") {
    if (method === "GET") return json({config: await loadConfig(env)});
    if (method === "PUT") {
      if (!CORE.can(role, "config")) throw denied("Only the appraiser or the administrator can change availability.");
      const c = cleanConfig(await readJSON(req));
      if (role !== "admin") c.deskCopyEmails = (await loadConfig(env)).deskCopyEmails || [];
      await env.DB.batch([
        env.DB.prepare("INSERT INTO config (key,value,updated_at,updated_by) VALUES ('availability',?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by").bind(JSON.stringify(c), nowISO(), user.name),
        env.DB.prepare("INSERT INTO audit (at,who,what) VALUES (?,?,?)").bind(nowISO(), user.name, "Updated appraiser availability and contact settings.")
      ]);
      return json({ok: true, config: c});
    }
  }
  if (path === "/api/slots" && method === "GET") {
    const cfg = await loadConfig(env);
    return json({slots: CORE.genSlots(cfg, await bookedStarts(env, ""), Date.now(), Number(url.searchParams.get("n")) || 8)});
  }

  /* --- feedback --- */
  if (path === "/api/feedback") {
    if (method === "GET") return json({feedback: (await env.DB.prepare("SELECT * FROM feedback ORDER BY at DESC LIMIT 500").all()).results || []});
    if (method === "POST") {
      const b = await readJSON(req); const text = s(b.text, 4000);
      if (!text) throw bad("Write a note first.");
      await env.DB.prepare("INSERT INTO feedback (id,at,who,role,kind,screen,order_ref,text) VALUES (?,?,?,?,?,?,?,?)").bind(uid("f"), nowISO(), user.name, role, s(b.kind, 40) || "Note", s(b.screen, 40), s(b.order, 120), text).run();
      return json({ok: true});
    }
  }

  /* --- outbox --- */
  if (p(1) === "messages") {
    if (method === "GET" && !p(2)) {
      const st = url.searchParams.get("status");
      const q = st ? env.DB.prepare("SELECT m.*, o.data FROM messages m JOIN orders o ON o.id=m.order_id WHERE m.status=? ORDER BY m.created_at DESC LIMIT 300").bind(st)
                   : env.DB.prepare("SELECT m.*, o.data FROM messages m JOIN orders o ON o.id=m.order_id ORDER BY m.created_at DESC LIMIT 300");
      const rows = (await q.all()).results || [];
      return json({messages: rows.map(r => { let addr = ""; try { const d = JSON.parse(r.data); addr = d.addr; } catch (e) {} const {data, ...m} = r; m.order_addr = addr; return m; })});
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
        const st = store(env), added = [], events = [];
        for (const f of files) {
          const ext = (f.name.split(".").pop() || "").toLowerCase(), type = TYPES[ext];
          if (!type) throw bad(f.name + " is not a supported file type (PDF, images, XML, CSV, Office files, ZIP).");
          if (f.size > MAX_FILE) throw bad(f.name + " is over the 20 MB limit.");
          if (!f.size) throw bad(f.name + " is empty.");
          const did = uid("d"), key = "doc/" + o.id + "/" + did;
          await st.put(key, await f.arrayBuffer(), type);
          await env.DB.prepare("INSERT INTO docs (id,order_id,name,size,type,kind,client_visible,storage,key,uploaded_by,uploaded_role,uploaded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
            .bind(did, o.id, s(f.name, 200), f.size, type, kind, visible ? 1 : 0, st.kind, key, user.name, role, nowISO()).run();
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
    if (user.role === "officer" && !["report", "addendum", "invoice"].includes(d.kind)) throw denied("Loan officers can open the finished report and invoice only.");
  }
  const body = await store(env).get(d.key);
  if (!body) throw notFound("The file bytes are missing from storage.");
  return new Response(body, {headers: {"content-type": d.type, "content-disposition": contentDisposition(d.name), "cache-control": "private, no-store", "x-content-type-options": "nosniff"}});
}

const SEC = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin", "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()", "strict-transport-security": "max-age=31536000"
};
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return await api(req, env, ctx);
      if (url.pathname.startsWith("/f/")) return await fileRoute(req, env);
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
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      if (env.DEMO && event.cron === "0 8 * * *") { await resetDemo(env, (env.PUBLIC_URL || "").replace(/\/$/, ""), {createOrder, runAction, setPassword, store, writeEvents, uid, randomToken, nowISO}); return; }
      await dispatch(env, 50);
      await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(nowISO()).run();
      await env.DB.prepare("DELETE FROM ratelimit WHERE window_start < ?").bind(Date.now() - 864e5).run();
    })());
  }
};
