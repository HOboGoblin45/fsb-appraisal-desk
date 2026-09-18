/* Delivery, conversation and security tests against ./devmail.sh (port 8789) with the sink from test/sink.js.
   Run with a fresh local database: rm -rf .wrangler/state && apply migrations && ./devmail.sh && node test/backend.js */
import {spawnSync} from "node:child_process";
import {createHmac} from "node:crypto";
import {startSink} from "./sink.js";
const BASE = process.env.BASE || "http://127.0.0.1:8789";
const SINK_PORT = 8790, SINK = "http://127.0.0.1:" + SINK_PORT;
const TWILIO_TOKEN = "testauthtoken0123456789abcdef";
let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log("  ok   " + msg); } else { fail++; console.log("  FAIL " + msg); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitHealthy() { for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + "/api/health"); if (r.ok) return; } catch (e) {} await sleep(500); } throw new Error("dev server did not come back"); }
async function provisionAdmin(name, email) {
  const r = spawnSync("node", ["provision.js", "admin", "--name", name, "--email", email, "--local"], {encoding: "utf8"});
  const m = /#invite=([a-z0-9]+)/.exec(r.stdout || ""); if (!m) throw new Error("provisioning failed: " + r.stdout + r.stderr);
  await waitHealthy(); return m[1];
}
function client() {
  let cookie = "";
  async function call(method, path, body, opts = {}) {
    const headers = {"x-requested-with": "FSB", "origin": BASE, ...(opts.headers || {})};
    if (opts.noCsrf) { delete headers["x-requested-with"]; delete headers.origin; }
    if (cookie && !opts.noCookie) headers.cookie = cookie;
    let payload;
    if (body instanceof FormData || body instanceof URLSearchParams || typeof body === "string") payload = body; else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
    if (body instanceof URLSearchParams) headers["content-type"] = "application/x-www-form-urlencoded";
    const res = await fetch(BASE + path, {method, headers, body: payload, redirect: "manual"});
    const sc = res.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    const ct = res.headers.get("content-type") || "";
    const data = ct.includes("json") ? await res.json() : await (opts.raw ? res.arrayBuffer() : res.text());
    return {status: res.status, data, headers: res.headers};
  }
  return {call, get: p => call("GET", p), post: (p, b, o) => call("POST", p, b, o), put: (p, b) => call("PUT", p, b), patch: (p, b) => call("PATCH", p, b), del: p => call("DELETE", p), cookie: () => cookie};
}
const sinkMail = async () => (await fetch(SINK + "/mail")).json();
const sinkSms = async () => (await fetch(SINK + "/sms")).json();
const sinkReset = () => fetch(SINK + "/reset", {method: "POST"});
/* dispatch runs in waitUntil after the response; give it a moment */
async function settle(n = 6) { for (let i = 0; i < n; i++) await sleep(250); }
async function until(fn, tries = 40) { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(250); } return null; }
function twilioSig(url, params) {
  const keys = Object.keys(params).sort(); let data = url; for (const k of keys) data += k + params[k];
  return createHmac("sha1", TWILIO_TOKEN).update(data).digest("base64");
}
function pdf() { return new Blob(["%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF"], {type: "application/pdf"}); }

(async () => {
  const sink = await startSink(SINK_PORT);
  const admin = client(), desk = client(), apr = client(), officer = client(), anon = client();
  console.log("provisioning, providers, invitations by email");
  const adminCode = await provisionAdmin("Ryan Curtis", "ryan@example.com");
  let r = await admin.post("/api/invite/accept", {code: adminCode, password: "correct horse battery"}); ok(r.status === 200, "administrator accepts the provisioned invitation");
  r = await admin.get("/api/session"); ok(r.data.providers.email && r.data.providers.emailVia === "hook" && r.data.providers.sms && r.data.providers.inboundEmail, "session reports email (relay), texts and inbound mail all on: " + JSON.stringify(r.data.providers));
  r = await admin.post("/api/users", {name: "Maria Lopez", email: "maria@example.com", role: "desk", phone: "(309) 555-0102"}); ok(r.status === 200 && r.data.emailed === true, "adding a person emails the invitation (emailed=true)");
  let mail = await until(async () => (await sinkMail()).find(m => m.to === "maria@example.com"));
  ok(!!mail && /Appraisal Desk sign-in/.test(mail.subject) && /#invite=[a-z0-9]+/.test(mail.text), "invitation arrived at the relay with the sign-in link");
  ok(mail && /<html/.test(mail.html) && /First Security Bank/.test(mail.html) && /background:#/.test(mail.html) && /href="http:\/\/127\.0\.0\.1:8789\/#invite=/.test(mail.html), "invitation has a branded HTML part with the link as a button");
  ok(mail && mail.replyTo === undefined, "system mail carries no order reply-to");
  const mariaCode = /#invite=([a-z0-9]+)/.exec(mail.text)[1];
  r = await desk.post("/api/invite/accept", {code: mariaCode, password: "maria-password-1"}); ok(r.status === 200 && r.data.user.role === "desk", "desk signs in from the emailed link");
  r = await admin.post("/api/users", {name: "Sam Appraiser", email: "sam@example.com", role: "appraiser", phone: "(309) 555-0100"}); const samLink = r.data.inviteLink;
  r = await apr.post("/api/invite/accept", {code: samLink.split("#invite=")[1], password: "sam-password-123"}); ok(r.status === 200, "appraiser accepts invite");
  r = await admin.post("/api/users", {name: "Lee Officer", email: "lee@example.com", role: "officer"}); r = await officer.post("/api/invite/accept", {code: r.data.inviteLink.split("#invite=")[1], password: "lee-password-123"}); ok(r.status === 200, "officer accepts invite");
  r = await apr.put("/api/config", {...(await apr.get("/api/config")).data.config, appraiserName: "Sam Appraiser", appraiserPhone: "(309) 555-0100", appraiserEmail: "sam@example.com", leadHours: 1}); ok(r.status === 200, "appraiser saves contact details");
  r = await admin.get("/api/messages"); ok(r.status === 200 && r.data.messages.some(m => m.kind === "system" && m.order_addr === "System" && m.status === "sent"), "outbox lists system mail as sent");

  console.log("forgotten password");
  await sinkReset();
  r = await anon.post("/api/reset", {email: "nobody@example.com"}); ok(r.status === 200 && /on its way/.test(r.data.message), "unknown address gets the same answer");
  await settle(2); ok((await sinkMail()).length === 0, "and no mail is sent for it");
  r = await anon.post("/api/reset", {email: "maria@example.com"}); ok(r.status === 200, "known address accepted");
  mail = await until(async () => (await sinkMail()).find(m => m.to === "maria@example.com"));
  ok(!!mail && /Reset your/.test(mail.subject) && /#invite=[a-z0-9]+/.test(mail.text) && /two hours/.test(mail.text), "reset link emailed");
  const resetCode = /#invite=([a-z0-9]+)/.exec(mail.text)[1];
  r = await anon.get("/api/invite/" + resetCode); ok(r.status === 200 && r.data.kind === "reset" && r.data.email === "maria@example.com", "reset link previews as a reset");
  const desk2 = client();
  r = await desk2.post("/api/invite/accept", {code: resetCode, password: "maria-new-password-2"}); ok(r.status === 200, "new password set from the link");
  r = await desk.get("/api/session"); ok(r.data.user === null, "old desk session was signed out by the reset");
  r = await anon.post("/api/login", {email: "maria@example.com", password: "maria-password-1"}); ok(r.status === 401, "old password refused");
  r = await desk.post("/api/login", {email: "maria@example.com", password: "maria-new-password-2"}); ok(r.status === 200, "new password works");
  r = await anon.get("/api/invite/" + resetCode); ok(r.status === 404, "reset link works once");
  for (let i = 0; i < 3; i++) r = await anon.post("/api/reset", {email: "maria@example.com"}); ok(r.status === 429, "reset requests are rate limited per address");

  console.log("order notices go out for real");
  await sinkReset();
  r = await desk.post("/api/orders", {addr: "1420 Sycamore Ln", city: "Mackinaw, IL", loan: "2026-1", purpose: "Purchase", type: "1004 URAR", due: "2026-10-30", borrowerName: "Dana Whitfield", borrowerPhone: "(309) 555-0188", borrowerEmail: "dana@example.com", agentName: "Marcy Teague", agentPhone: "(309) 555-0199", agentEmail: "marcy@example.com", accessVia: "Borrower", attestation: true});
  ok(r.status === 200, "order placed"); const O = r.data.order;
  mail = await until(async () => (await sinkMail()).find(m => m.to === "sam@example.com" && /New appraisal order/.test(m.subject)));
  ok(!!mail, "appraiser's new-order email was sent through the relay");
  ok(mail && mail.replyTo === "First Security Bank Appraisal Desk <desk+" + O.id + "@fsb.apprifi.com>", "order mail replies come back tagged with the order id: " + (mail && mail.replyTo));
  r = await desk.get("/api/orders/" + O.id); ok(r.data.order.messages.every(m => m.status === "sent" && /^mail_/.test(m.provider_id || "") || m.status !== "queued"), "message rows record sent + provider id");
  r = await apr.post("/api/orders/" + O.id + "/actions", {action: "accept", params: {fee: 550, etaDate: "2026-10-20"}}); ok(r.status === 200, "appraiser accepts");
  let sms = await until(async () => (await sinkSms()).find(x => x.To === "+13095550188"));
  ok(!!sms && /ordered an appraisal/.test(sms.Body) && /#t=/.test(sms.Body) && sms.From === "+13095550000", "borrower text sent through Twilio with the personal link");
  ok(sms && sms.auth.startsWith("Basic ") && !sms.StatusCallback, "Twilio call is authenticated; no status callback on a non-https portal URL");
  mail = await until(async () => (await sinkMail()).find(m => m.to === "dana@example.com"));
  ok(!!mail && /Your appraisal has been ordered/.test(mail.subject) && /<a href="http:\/\/127\.0\.0\.1:8789\/#t=/.test(mail.html), "borrower email sent with the link as a button");
  r = await desk.get("/api/orders/" + O.id);
  const smsRow = r.data.order.messages.find(m => m.channel === "sms" && m.to_addr.includes("0188"));
  ok(smsRow && smsRow.status === "sent" && /^SM/.test(smsRow.provider_id), "text row holds the Twilio SID");

  console.log("carrier delivery reports");
  const statusUrl = BASE + "/api/hooks/twilio/status";
  let params = {MessageSid: smsRow.provider_id, MessageStatus: "delivered", To: "+13095550188"};
  r = await anon.post("/api/hooks/twilio/status", new URLSearchParams(params), {noCsrf: true, headers: {"x-twilio-signature": "bogus"}}); ok(r.status === 403, "webhook with a bad signature is refused");
  r = await anon.post("/api/hooks/twilio/status", new URLSearchParams(params), {noCsrf: true, headers: {"x-twilio-signature": twilioSig(statusUrl, params)}}); ok(r.status === 200 && /<Response><\/Response>/.test(r.data), "signed status callback accepted");
  r = await desk.get("/api/orders/" + O.id); ok(r.data.order.messages.find(m => m.id === smsRow.id).delivery === "delivered", "delivery state recorded on the text");
  params = {MessageSid: smsRow.provider_id, MessageStatus: "undelivered", ErrorCode: "30003"};
  r = await anon.post("/api/hooks/twilio/status", new URLSearchParams(params), {noCsrf: true, headers: {"x-twilio-signature": twilioSig(statusUrl, params)}});
  r = await desk.get("/api/orders/" + O.id); ok(r.data.order.messages.find(m => m.id === smsRow.id).delivery === "undelivered (30003)" && r.data.order.events.some(e => /was undelivered/.test(e.what) && /Call them/.test(e.what)), "an undelivered text goes on the record with advice to call");

  console.log("replies by text land on the conversation");
  await sinkReset();
  const inboundUrl = BASE + "/api/hooks/twilio/inbound";
  params = {From: "+13095550188", To: "+13095550000", Body: "Can we do Tuesday afternoon? I work until 3.", MessageSid: "SMin1"};
  r = await anon.post("/api/hooks/twilio/inbound", new URLSearchParams(params), {noCsrf: true, headers: {"x-twilio-signature": twilioSig(inboundUrl, params)}}); ok(r.status === 200, "inbound text accepted");
  r = await desk.get("/api/orders/" + O.id);
  let th = r.data.order.thread || [];
  ok(th.length === 1 && th[0].role === "client" && th[0].who === "Dana Whitfield" && th[0].via === "text message" && /Tuesday afternoon/.test(th[0].text), "borrower's text is on the order's conversation as a client entry");
  ok(r.data.order.events.some(e => /Message from Dana Whitfield \(client, by text message\)/.test(e.what)), "and on the independence record");
  mail = await until(async () => (await sinkMail()).filter(m => /Message from Dana Whitfield/.test(m.subject)));
  ok(mail && mail.length === 2 && mail.some(m => m.to === "sam@example.com") && mail.some(m => m.to === "maria@example.com"), "appraiser and desk were emailed about it");
  const cl = client();
  r = await cl.get("/api/client/" + O.tokB); ok(r.status === 200 && r.data.thread.length === 1 && r.data.thread[0].mine === true, "borrower sees their own message on the status page");

  console.log("STOP and START");
  params = {From: "+13095550188", To: "+13095550000", Body: "STOP", MessageSid: "SMin2"};
  r = await anon.post("/api/hooks/twilio/inbound", new URLSearchParams(params), {noCsrf: true, headers: {"x-twilio-signature": twilioSig(inboundUrl, params)}}); ok(r.status === 200, "STOP accepted");
  await sinkReset();
  r = await apr.post("/api/orders/" + O.id + "/actions", {action: "schedule", params: {}}); ok(r.status === 200, "appraiser sends the scheduling request");
  await settle();
  r = await desk.get("/api/orders/" + O.id);
  const sch = r.data.order.messages.filter(m => m.template === "schedule");
  ok(sch.find(m => m.channel === "sms").status === "optout" && sch.find(m => m.channel === "email").status === "sent", "text to an opted-out number is held (optout); the email still goes");
  ok((await sinkSms()).length === 0, "nothing reached Twilio for that number");
  r = await desk.get("/api/inbound"); ok(r.status === 200 && r.data.inbound.some(i => i.handled === "optout" && i.from_addr === "+13095550188"), "opt-out is listed for the desk");
  params = {From: "+13095550188", To: "+13095550000", Body: "START", MessageSid: "SMin3"};
  r = await anon.post("/api/hooks/twilio/inbound", new URLSearchParams(params), {noCsrf: true, headers: {"x-twilio-signature": twilioSig(inboundUrl, params)}});
  r = await apr.post("/api/orders/" + O.id + "/actions", {action: "renotify", params: {}}); await settle();
  ok((await sinkSms()).some(x => x.To === "+13095550188" && /Reminder/.test(x.Body)), "after START the texts flow again");
  params = {From: "+13095559999", To: "+13095550000", Body: "Who is this?", MessageSid: "SMin4"};
  r = await anon.post("/api/hooks/twilio/inbound", new URLSearchParams(params), {noCsrf: true, headers: {"x-twilio-signature": twilioSig(inboundUrl, params)}});
  r = await desk.get("/api/inbound"); ok(r.data.inbound.some(i => i.handled === "unmatched" && i.from_addr === "+13095559999" && /Who is this/.test(i.body)), "a text from an unknown number waits on the outbox screen as unmatched");
  r = await officer.get("/api/inbound"); ok(r.status === 200, "officer may read the inbound list (read-only role sees the outbox)");

  console.log("conversation between staff and with the client");
  await sinkReset();
  r = await officer.post("/api/orders/" + O.id + "/actions", {action: "post", params: {text: "How is it looking?"}}); ok(r.status === 403 && /independence/.test(r.data.message), "loan officer cannot post");
  r = await desk.post("/api/orders/" + O.id + "/actions", {action: "post", params: {text: "The seller mentioned a new roof in 2024; permit is in the file."}}); ok(r.status === 200 && r.data.reply === "Sent and logged.", "desk posts to the appraiser");
  mail = await until(async () => (await sinkMail()).find(m => m.to === "sam@example.com" && /Message on 1420/.test(m.subject)));
  ok(!!mail && /new roof/.test(mail.text) && /Logged on the independence record/.test(mail.text), "appraiser emailed the desk's message");
  r = await apr.post("/api/orders/" + O.id + "/actions", {action: "post", params: {text: "Dana, I will need the garage unlocked as well. See you Tuesday.", to: "client"}}); ok(r.status === 200 && /Sent to Dana Whitfield by text and email/.test(r.data.reply), "appraiser messages the borrower");
  sms = await until(async () => (await sinkSms()).find(x => x.To === "+13095550188" && /garage/.test(x.Body)));
  ok(!!sms && /Sam Appraiser about 1420/.test(sms.Body) && /#t=/.test(sms.Body), "borrower gets it by text with the link");
  mail = await until(async () => (await sinkMail()).find(m => m.to === "dana@example.com" && /Message about your appraisal/.test(m.subject))); ok(!!mail, "and by email");
  r = await desk.post("/api/orders/" + O.id + "/actions", {action: "post", params: {text: "hi", to: "client"}}); ok(r.status === 200, "desk can also message the client");
  r = await admin.post("/api/orders/" + O.id + "/actions", {action: "post", params: {text: "x", to: "client"}}); ok(r.status === 403, "administrator cannot message the client");
  r = await cl.post("/api/client/" + O.tokB + "/message", {text: "Garage will be open. Thank you."}); ok(r.status === 200 && /notified/.test(r.data.reply), "borrower replies from the status page");
  r = await cl.get("/api/client/" + O.tokB); th = r.data.thread;
  ok(th.length === 4 && th.filter(t => t.mine).length === 2 && !th.some(t => /new roof/.test(t.text)), "client sees only what was to or from them, not staff-to-staff");
  r = await officer.get("/api/orders/" + O.id); ok((r.data.order.thread || []).length === 5, "officer reads the full thread");
  r = await desk.post("/api/orders/" + O.id + "/actions", {action: "ask", params: {text: "Legacy question"}}); ok(r.status === 200, "old ask action still works (maps to post)");
  r = await apr.post("/api/orders/" + O.id + "/actions", {action: "reply", params: {text: "Legacy reply"}}); ok(r.status === 200, "old reply action still works");

  console.log("replies by email through Email Routing");
  await sinkReset();
  const rawMail = (from, to, subject, body, extra = "") => "From: " + from + "\r\nTo: " + to + "\r\nSubject: " + subject + "\r\nMessage-ID: <" + Math.random().toString(36).slice(2) + "@test>\r\nDate: Tue, 15 Sep 2026 10:00:00 -0500\r\n" + extra + "\r\n" + body;
  const emailIn = (from, to, raw) => fetch(BASE + "/cdn-cgi/handler/email?from=" + encodeURIComponent(from) + "&to=" + encodeURIComponent(to), {method: "POST", headers: {"content-type": "message/rfc822"}, body: raw});
  let er = await emailIn("dana@example.com", "desk+" + O.id + "@fsb.apprifi.com", rawMail('"Dana Whitfield" <dana@example.com>', "desk+" + O.id + "@fsb.apprifi.com", "Re: Message about your appraisal: 1420 Sycamore Ln",
    "Tuesday at 2 works, and the dog will be inside.\r\n\r\nOn Tue, Sep 15, 2026 at 9:00 AM First Security Bank Appraisal Desk wrote:\r\n> Dana, I will need the garage unlocked as well.\r\n> See you Tuesday.\r\n", "Content-Type: text/plain; charset=utf-8\r\n"));
  ok(er.status === 200, "local email handler accepted the message (" + er.status + ")");
  r = await desk.get("/api/orders/" + O.id); th = r.data.order.thread;
  const last = th[th.length - 1];
  ok(last && last.role === "client" && last.via === "email" && last.text === "Tuesday at 2 works, and the dog will be inside.", "email reply posted to the conversation with the quoted history stripped: " + JSON.stringify(last && last.text));
  mail = await until(async () => (await sinkMail()).find(m => m.to === "sam@example.com" && /Message from Dana Whitfield/.test(m.subject))); ok(!!mail, "appraiser notified of the email reply");
  const boundary = "b0undary";
  const mixed = rawMail('"Dana Whitfield" <dana@example.com>', "desk+" + O.id + "@fsb.apprifi.com", "Permit", "--" + boundary + "\r\nContent-Type: text/plain\r\n\r\nHere is the roof permit.\r\n--" + boundary + "\r\nContent-Type: application/pdf; name=\"roof-permit.pdf\"\r\nContent-Disposition: attachment; filename=\"roof-permit.pdf\"\r\nContent-Transfer-Encoding: base64\r\n\r\n" + Buffer.from("%PDF-1.4\n%%EOF").toString("base64") + "\r\n--" + boundary + "--\r\n", "MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"" + boundary + "\"\r\n");
  er = await emailIn("dana@example.com", "desk+" + O.id + "@fsb.apprifi.com", mixed);
  r = await desk.get("/api/orders/" + O.id);
  ok(r.data.order.docs.some(d => d.name === "roof-permit.pdf" && d.uploaded_role === "client") && r.data.order.events.some(e => /Attached roof-permit.pdf by email/.test(e.what)), "PDF attached to an email reply becomes a document on the order");
  er = await emailIn("stranger@example.com", "desk@fsb.apprifi.com", rawMail("stranger@example.com", "desk@fsb.apprifi.com", "Hello", "Is this the bank?", "Content-Type: text/plain\r\n"));
  r = await desk.get("/api/inbound"); ok(r.data.inbound.some(i => i.channel === "email" && i.from_addr === "stranger@example.com" && i.handled === "unmatched"), "mail from an unknown sender waits as unmatched");
  er = await emailIn("sam@example.com", "desk+" + O.id + "@fsb.apprifi.com", rawMail("sam@example.com", "desk+" + O.id + "@fsb.apprifi.com", "Re: Message on 1420 Sycamore Ln", "Got it, thanks Maria.", "Content-Type: text/plain\r\n"));
  r = await desk.get("/api/orders/" + O.id); th = r.data.order.thread;
  ok(th[th.length - 1].role === "appraiser" && th[th.length - 1].via === "email" && th[th.length - 1].text === "Got it, thanks Maria.", "the appraiser replying from their inbox lands on the conversation as the appraiser");
  er = await emailIn("dana@example.com", "desk+nosuchorder@fsb.apprifi.com", rawMail("dana@example.com", "desk+nosuchorder@fsb.apprifi.com", "Q", "Still on for Tuesday?", "Content-Type: text/plain\r\n"));
  r = await desk.get("/api/orders/" + O.id); th = r.data.order.thread;
  ok(th[th.length - 1].text === "Still on for Tuesday?" && th[th.length - 1].role === "client", "a bad tag falls back to matching the sender's address to their open order");

  console.log("feedback and delivery tests");
  await sinkReset();
  r = await desk.post("/api/feedback", {kind: "Bug", text: "The due date column wraps on my phone.", screen: "board"}); ok(r.status === 200 && r.data.notified === 2, "feedback stored and two people notified (vendor and the administrator)");
  mail = await until(async () => { const l = await sinkMail(); return l.filter(m => /Portal feedback: Bug from Maria Lopez/.test(m.subject)).length === 2 ? l : null; });
  ok(mail && mail.some(m => m.to === "vendor@example.com") && mail.some(m => m.to === "ryan@example.com"), "feedback copies reached the vendor and the administrator");
  await sinkReset();
  r = await desk.post("/api/test-send", {channel: "email"}); ok(r.status === 403, "only the administrator runs delivery tests");
  r = await admin.post("/api/test-send", {channel: "email"}); ok(r.status === 200 && r.data.via === "hook" && r.data.to === "ryan@example.com", "administrator's test email sent: " + JSON.stringify(r.data));
  ok((await sinkMail()).some(m => m.to === "ryan@example.com" && /test message/.test(m.subject)), "test email is in the relay");
  r = await admin.post("/api/test-send", {channel: "sms"}); ok(r.status === 400 && /mobile number/.test(r.data.message), "test text needs a mobile on file");
  const me = (await admin.get("/api/users")).data.users.find(u => u.email === "ryan@example.com");
  await admin.patch("/api/users/" + me.id, {phone: "309-555-0101"});
  r = await admin.post("/api/test-send", {channel: "sms"}); ok(r.status === 200 && r.data.via === "twilio" && /^SM/.test(r.data.providerId), "administrator's test text sent through Twilio");
  r = await admin.post("/api/test-send", {channel: "sms", to: "12"}); ok(r.status === 502 && /provider refused/.test(r.data.message), "a provider refusal is reported plainly: " + r.data.message);

  console.log("files: content checks, download headers, record");
  let fd = new FormData(); fd.append("kind", "contract"); fd.append("file", new Blob(["this is not a pdf"], {type: "application/pdf"}), "fake.pdf");
  r = await desk.post("/api/orders/" + O.id + "/docs", fd); ok(r.status === 400 && /does not look like a PDF/.test(r.data.message), "a text file renamed .pdf is refused");
  fd = new FormData(); fd.append("kind", "contract"); fd.append("file", pdf(), "contract.pdf");
  r = await desk.post("/api/orders/" + O.id + "/docs", fd); ok(r.status === 200, "a real PDF uploads");
  const contract = r.data.order.docs.find(d => d.name === "contract.pdf");
  const dl = await fetch(BASE + "/f/" + O.id + "/" + contract.id, {headers: {cookie: apr.cookie()}});
  ok(dl.status === 200 && dl.headers.get("content-security-policy") === "sandbox; default-src 'none'" && /attachment/.test(dl.headers.get("content-disposition")) && dl.headers.get("x-content-type-options") === "nosniff", "download is sandboxed, nosniff and attachment-only");
  r = await desk.get("/api/orders/" + O.id); ok(r.data.order.events.some(e => e.who === "Sam Appraiser" && /Downloaded contract.pdf/.test(e.what)), "the appraiser's download of the desk's file is on the record");
  const dl2 = await fetch(BASE + "/f/" + O.id + "/" + contract.id, {headers: {cookie: desk.cookie()}}); ok(dl2.status === 200, "desk opens its own file");
  r = await desk.get("/api/orders/" + O.id); ok(r.data.order.events.filter(e => /Downloaded contract.pdf/.test(e.what)).length === 1, "and that is not logged as a download of the other side's file");
  const dl3 = await fetch(BASE + "/f/" + O.id + "/" + contract.id, {headers: {cookie: officer.cookie()}}); ok(dl3.status === 403, "officer cannot open the contract");
  const dl4 = await fetch(BASE + "/f/" + O.id + "/" + contract.id); ok(dl4.status === 401, "anonymous cannot open it");
  const dl5 = await fetch(BASE + "/f/" + O.id + "/" + contract.id + "?t=" + O.tokB); ok(dl5.status === 403, "the borrower link cannot open a staff-only file");
  r = await desk.get("/api/session"); ok(r.data.storage === "kv", "local storage is KV (R2 is bound in production when available)");

  console.log("relay outage and retry");
  await sinkReset(); await fetch(SINK + "/failnext", {method: "POST"});
  r = await apr.post("/api/orders/" + O.id + "/actions", {action: "hold", params: {reason: "Access refused or unavailable", note: "Test"}}); await settle();
  r = await desk.get("/api/orders/" + O.id); let hm = r.data.order.messages.find(m => m.template === "hold");
  ok(hm && hm.status === "queued" && hm.attempts === 1 && /relay down|Mail relay 503/.test(hm.last_error || ""), "a relay failure leaves the message queued with the error: " + (hm && hm.last_error));
  r = await desk.post("/api/messages/" + hm.id + "/retry", {}); await settle();
  r = await desk.get("/api/orders/" + O.id); hm = r.data.order.messages.find(m => m.template === "hold"); ok(hm.status === "sent", "retry sends it");

  console.log("password change signs out other devices");
  const deskPhone = client(); r = await deskPhone.post("/api/login", {email: "maria@example.com", password: "maria-new-password-2"}); ok(r.status === 200, "desk signs in on a second device");
  r = await desk.post("/api/password", {current: "maria-new-password-2", next: "maria-third-password-3"}); ok(r.status === 200, "desk changes password on the first device");
  r = await desk.get("/api/session"); ok(!!r.data.user, "first device stays signed in");
  r = await deskPhone.get("/api/session"); ok(r.data.user === null, "second device is signed out");
  r = await admin.get("/api/audit"); ok(r.data.audit.some(a => /other sessions signed out/.test(a.what)) && r.data.audit.some(a => /Reset their password from an emailed link/.test(a.what)), "both are on the administration record");

  console.log("webhooks need no CSRF header but everything else still does");
  r = await desk.post("/api/orders/" + O.id + "/actions", {action: "note", params: {text: "x"}}, {noCsrf: true}); ok(r.status === 403, "API mutation without the header is refused");
  r = await anon.post("/api/hooks/twilio/nothing", new URLSearchParams({a: "b"}), {noCsrf: true}); ok(r.status === 404, "unknown hook is 404");

  sink.server.close();
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
