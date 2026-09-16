/* End-to-end API test against a running wrangler dev (default http://127.0.0.1:8787). */
const BASE = process.env.BASE || "http://127.0.0.1:8787";
let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log("  ok   " + msg); } else { fail++; console.log("  FAIL " + msg); } }
function client() {
  let cookie = "";
  async function call(method, path, body, opts = {}) {
    const headers = {"x-requested-with": "FSB", "origin": BASE, ...(opts.headers || {})};
    if (cookie) headers.cookie = cookie;
    let payload;
    if (body instanceof FormData) payload = body; else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
    const res = await fetch(BASE + path, {method, headers, body: payload, redirect: "manual"});
    const sc = res.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    const ct = res.headers.get("content-type") || "";
    const data = ct.includes("json") ? await res.json() : await (opts.raw ? res.arrayBuffer() : res.text());
    return {status: res.status, data, headers: res.headers};
  }
  return {call, get: p => call("GET", p), post: (p, b) => call("POST", p, b), put: (p, b) => call("PUT", p, b), patch: (p, b) => call("PATCH", p, b), del: p => call("DELETE", p)};
}
(async () => {
  const admin = client(), desk = client(), apr = client(), officer = client(), anon = client();
  console.log("setup and sign-in");
  let r = await anon.get("/api/session"); ok(r.data.setupNeeded === true && r.data.user === null, "fresh install reports setupNeeded");
  r = await anon.post("/api/orders", {addr: "x"}); ok(r.status === 401, "orders need sign-in (" + r.status + ")");
  r = await admin.call("POST", "/api/setup", {name: "Ryan Curtis", email: "ryan@example.com", password: "short"}, {}); ok(r.status === 400, "setup rejects short password");
  r = await admin.post("/api/setup", {name: "Ryan Curtis", email: "ryan@example.com", password: "correct horse battery"}); ok(r.status === 200 && r.data.user.role === "admin", "setup creates the first admin");
  r = await anon.post("/api/setup", {name: "Mallory", email: "m@example.com", password: "correct horse battery"}); ok(r.status === 403, "second setup is refused");
  r = await admin.get("/api/session"); ok(r.data.user && r.data.user.name === "Ryan Curtis" && r.data.config, "admin session persists with config");
  r = await admin.call("POST", "/api/logout", {}, {headers: {"x-requested-with": "nope"}}); ok(r.status === 403, "mutation without the header is refused");

  console.log("people and invites");
  const inv = {};
  for (const [k, u] of Object.entries({desk: ["Maria Lopez", "maria@example.com"], appraiser: ["Sam Appraiser", "sam@example.com"], officer: ["Lee Officer", "lee@example.com"]})) {
    r = await admin.post("/api/users", {name: u[0], email: u[1], role: k}); ok(r.status === 200 && /#invite=/.test(r.data.inviteLink), "invite " + k);
    inv[k] = r.data.inviteLink.split("#invite=")[1];
  }
  r = await admin.post("/api/users", {name: "Dup", email: "maria@example.com", role: "desk"}); ok(r.status === 400, "duplicate email refused");
  r = await desk.get("/api/invite/" + inv.desk); ok(r.status === 200 && r.data.role === "desk", "invite preview");
  r = await desk.post("/api/invite/accept", {code: inv.desk, password: "maria-password-1"}); ok(r.status === 200 && r.data.user.role === "desk", "desk accepts invite");
  r = await anon.post("/api/invite/accept", {code: inv.desk, password: "another-password-9"}); ok(r.status === 404, "used invite cannot be reused");
  r = await apr.post("/api/invite/accept", {code: inv.appraiser, password: "sam-password-123"}); ok(r.status === 200, "appraiser accepts invite");
  r = await officer.post("/api/invite/accept", {code: inv.officer, password: "lee-password-123"}); ok(r.status === 200, "officer accepts invite");
  r = await desk.get("/api/users"); ok(r.status === 403, "desk cannot list people");
  r = await anon.post("/api/login", {email: "maria@example.com", password: "wrong-password"}); ok(r.status === 401, "wrong password refused");
  r = await anon.post("/api/login", {email: "maria@example.com", password: "maria-password-1"}); ok(r.status === 200 && r.data.user.name === "Maria Lopez", "password login works");

  console.log("availability");
  r = await desk.put("/api/config", {startHour: 9}); ok(r.status === 403, "desk cannot change availability");
  r = await apr.put("/api/config", {days: [1, 2, 3, 4, 5], startHour: 8.5, endHour: 16, slotMinutes: 60, bufferMinutes: 45, leadHours: 0, appraiserName: "Sam Appraiser", appraiserPhone: "(309) 555-0100", appraiserEmail: "sam@example.com", daysOff: []});
  ok(r.status === 200 && r.data.config.appraiserName === "Sam Appraiser", "appraiser saves availability");
  r = await apr.get("/api/slots?n=3"); ok(r.status === 200 && r.data.slots.length === 3, "slots generated: " + r.data.slots[0]);

  console.log("order life cycle");
  r = await officer.post("/api/orders", {addr: "1 Main", attestation: true}); ok(r.status === 403, "officer cannot place orders");
  r = await desk.post("/api/orders", {addr: "812 N Roosevelt Ave", city: "Bloomington, IL 61701"}); ok(r.status === 400, "attestation required");
  r = await desk.post("/api/orders", {addr: "812 N Roosevelt Ave", city: "Bloomington, IL 61701", loan: "2026-004417", type: "1004 URAR", purpose: "Purchase", due: "2026-10-01",
    borrowerName: "Dana Whitfield", borrowerPhone: "(309) 555-0148", borrowerEmail: "dana@example.com", agentName: "Marcy Teague", agentPhone: "(309) 555-0199", accessVia: "Borrower", notes: "Dog on site", attestation: true, officerName: "Lee Officer", officerEmail: "lee@example.com"});
  ok(r.status === 200 && r.data.order.id && r.data.order.tokB, "desk places an order");
  const oid = r.data.order.id, tokB = r.data.order.tokB, tokA = r.data.order.tokA;
  r = await desk.get("/api/orders/" + oid); ok(r.data.order.events.length === 1 && r.data.order.messages.length === 1 && r.data.order.messages[0].party === "appraiser", "created event and appraiser email queued (status " + r.data.order.messages[0].status + ")");
  r = await desk.post("/api/orders/" + oid + "/actions", {action: "accept", from: 0}); ok(r.status === 403, "desk cannot accept");
  r = await apr.post("/api/orders/" + oid + "/actions", {action: "accept", from: 0, params: {fee: 550}}); ok(r.status === 200 && r.data.order.step === 1 && r.data.order.fee === 550, "appraiser accepts with fee");
  ok(r.data.order.messages.some(m => m.party === "borrower" && m.channel === "sms" && /#t=/.test(m.body)), "borrower SMS carries the secure link");
  ok(r.data.order.messages.some(m => m.party === "officer"), "loan officer copied on acceptance");
  r = await apr.post("/api/orders/" + oid + "/actions", {action: "accept", from: 0}); ok(r.status === 409, "stale double-accept refused");
  r = await desk.post("/api/orders/" + oid + "/actions", {action: "edit", params: {borrowerPhone: "(309) 555-0150", notes: "Dog on site, gate code 1234"}}); ok(r.status === 200 && r.data.order.borrowerPhone === "(309) 555-0150", "desk edits contact and notes");
  r = await apr.post("/api/orders/" + oid + "/actions", {action: "schedule", from: 1}); ok(r.status === 200 && r.data.order.step === 2, "scheduling request sent");

  console.log("client page");
  r = await anon.get("/api/client/notatoken"); ok(r.status === 404, "bad token rejected");
  r = await anon.get("/api/client/" + tokB); ok(r.status === 200 && r.data.step === 2 && r.data.slots.length > 0 && r.data.party === "borrower" && !r.data.loan, "borrower sees status and slots, nothing else");
  const slot = r.data.slots[0];
  r = await anon.post("/api/client/" + tokB + "/book", {slot: "2020-01-01T15:00:00.000Z"}); ok(r.status === 409, "past slot refused");
  r = await anon.post("/api/client/" + tokB + "/book", {slot}); ok(r.status === 200, "borrower books " + slot);
  r = await anon.get("/api/client/" + tokA); ok(r.data.step === 3 && r.data.apptStart === slot && r.data.party === "agent", "agent link shows the booking");
  r = await anon.get("/api/client/" + tokB + "/appointment.ics"); ok(r.status === 200 && /BEGIN:VEVENT/.test(r.data), "calendar file served");
  // second order cannot take the same time
  r = await desk.post("/api/orders", {addr: "44 Elm St", city: "Normal, IL", attestation: true, borrowerName: "Pat", borrowerEmail: "pat@example.com"});
  const o2 = r.data.order.id, tok2 = r.data.order.tokB;
  await apr.post("/api/orders/" + o2 + "/actions", {action: "accept", from: 0});
  await apr.post("/api/orders/" + o2 + "/actions", {action: "schedule", from: 1});
  r = await anon.post("/api/client/" + tok2 + "/book", {slot}); ok(r.status === 409 && r.data.error === "clash", "double booking refused");
  r = await anon.get("/api/client/" + tok2); ok(r.data.slots.indexOf(slot) === -1, "taken slot is not offered to the next client");
  r = await anon.post("/api/client/" + tokB + "/reschedule", {}); ok(r.status === 200, "borrower cancels the time");
  r = await anon.get("/api/client/" + tokB); ok(r.data.step === 2 && !r.data.apptStart, "back to scheduling");
  r = await desk.post("/api/orders/" + oid + "/actions", {action: "book", params: {slot}}); ok(r.status === 200 && r.data.order.step === 3, "desk books on the client's behalf");

  console.log("inspection, review, delivery");
  r = await apr.post("/api/orders/" + oid + "/actions", {action: "hold", params: {reason: "Access refused or unavailable", note: "Tenant not answering"}}); ok(r.status === 200 && r.data.order.hold, "hold with picklist reason");
  r = await apr.post("/api/orders/" + oid + "/actions", {action: "inspect", from: 3}); ok(r.status === 409, "held file cannot advance");
  r = await apr.post("/api/orders/" + oid + "/actions", {action: "release"}); ok(r.status === 200 && !r.data.order.hold, "hold released");
  r = await apr.post("/api/orders/" + oid + "/actions", {action: "inspect", from: 3}); ok(r.status === 200 && r.data.order.step === 4, "inspection logged");
  r = await desk.post("/api/orders/" + oid + "/actions", {action: "edit", params: {addr: "813"}}); ok(r.status === 409, "inspected file cannot be edited");
  r = await apr.post("/api/orders/" + oid + "/actions", {action: "review", from: 4}); ok(r.status === 200 && r.data.order.step === 5, "in review");
  r = await apr.post("/api/orders/" + oid + "/actions", {action: "deliver", from: 5}); ok(r.status === 409 && r.data.error === "noreport", "deliver without a report is stopped");
  const fd = new FormData(); fd.append("kind", "report"); fd.append("file", new Blob(["%PDF-1.4 test report"], {type: "application/pdf"}), "appraisal-812-roosevelt.pdf");
  r = await officer.post("/api/orders/" + oid + "/docs", fd); ok(r.status === 403, "officer cannot upload");
  const fd2 = new FormData(); fd2.append("kind", "report"); fd2.append("file", new Blob(["%PDF-1.4 test report"], {type: "application/pdf"}), "appraisal-812-roosevelt.pdf");
  r = await apr.post("/api/orders/" + oid + "/docs", fd2); ok(r.status === 200 && r.data.order.docs.length === 1 && r.data.order.docs[0].client_visible === true, "appraiser uploads the report, visible to client by default");
  const did = r.data.order.docs[0].id;
  const fd3 = new FormData(); fd3.append("kind", "contract"); fd3.append("file", new Blob(["contract"], {type: "text/plain"}), "contract.exe");
  r = await desk.post("/api/orders/" + oid + "/docs", fd3); ok(r.status === 400, "unsupported type refused");
  r = await anon.call("GET", "/f/" + oid + "/" + did + "?t=" + tokB, undefined, {raw: true}); ok(r.status === 403, "client cannot download before delivery");
  r = await apr.post("/api/orders/" + oid + "/actions", {action: "deliver", from: 5}); ok(r.status === 200 && r.data.order.step === 6, "delivered");
  r = await anon.call("GET", "/f/" + oid + "/" + did + "?t=" + tokB, undefined, {raw: true}); ok(r.status === 403, "client must consent before download");
  r = await anon.post("/api/client/" + tokB + "/consent", {}); ok(r.status === 200, "borrower consents to electronic delivery");
  r = await anon.get("/api/client/" + tokB); ok(r.data.consent === true && r.data.report && r.data.report.id === did, "client page offers the report");
  r = await anon.call("GET", "/f/" + oid + "/" + did + "?t=" + tokB, undefined, {raw: true}); ok(r.status === 200 && Buffer.from(r.data).toString().startsWith("%PDF"), "borrower downloads the report");
  r = await officer.call("GET", "/f/" + oid + "/" + did, undefined, {raw: true}); ok(r.status === 200, "loan officer downloads the report");
  r = await client().call("GET", "/f/" + oid + "/" + did, undefined, {raw: true}); ok(r.status === 401, "anonymous cannot download");
  r = await apr.post("/api/orders/" + oid + "/actions", {action: "invoice", from: 6}); ok(r.status === 200 && r.data.order.step === 7, "invoiced");
  r = await desk.call("GET", "/api/orders/" + oid + "/log.txt"); ok(r.status === 200 && /RECUSAL/.test(r.data) && /Downloaded appraisal-812-roosevelt.pdf/.test(r.data), "independence record exports with the client download logged");

  console.log("cancel, decline, outbox, feedback");
  r = await desk.post("/api/orders", {addr: "9 Oak", city: "Danvers, IL", attestation: true, borrowerName: "Kim"}); const o3 = r.data.order.id;
  r = await apr.post("/api/orders/" + o3 + "/actions", {action: "decline", from: 0, params: {reason: "Conflict of interest"}}); ok(r.status === 200 && r.data.order.declined, "declined with reason");
  r = await desk.post("/api/orders/" + o2 + "/actions", {action: "cancel", params: {reason: "Loan withdrawn"}}); ok(r.status === 200 && r.data.order.cancelled, "desk cancels");
  ok(r.data.order.messages.some(m => m.template === "cancelled" && m.party === "appraiser"), "appraiser told to stop");
  r = await anon.get("/api/client/" + tok2); ok(r.data.cancelled === true && r.data.slots.length === 0, "cancelled order shows nothing to do");
  r = await desk.get("/api/messages?status=manual"); ok(r.status === 200 && r.data.messages.length > 5, "outbox lists manual messages (" + r.data.messages.length + ")");
  const mid = r.data.messages[0].id;
  r = await desk.post("/api/messages/" + mid + "/mark", {status: "sent"}); ok(r.status === 200, "mark message sent by hand");
  r = await desk.get("/api/messages?status=sent"); ok(r.data.messages.some(m => m.id === mid && m.sent_by === "Maria Lopez"), "sent message records who sent it");
  r = await officer.post("/api/feedback", {kind: "Idea", text: "Add a due-date filter", screen: "board"}); ok(r.status === 200, "feedback posted");
  r = await desk.get("/api/orders?since=" + encodeURIComponent("2000-01-01T00:00:00Z")); ok(r.data.orders.length === 3 && r.data.orders[0].docCount !== undefined, "order list with counts");
  r = await admin.patch("/api/users/" + (await admin.get("/api/users")).data.users.find(u => u.email === "lee@example.com").id, {active: false}); ok(r.status === 200, "admin suspends officer");
  r = await officer.get("/api/session"); ok(r.data.user === null, "suspended officer is signed out");
  r = await desk.post("/api/password", {current: "maria-password-1", next: "maria-password-2"}); ok(r.status === 200, "password change");
  r = await anon.post("/api/login", {email: "maria@example.com", password: "maria-password-2"}); ok(r.status === 200, "new password works");
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
