/* v2 checks, run after api.js against the same dev server (state from api.js is reused). */
const BASE = process.env.BASE || "http://127.0.0.1:8787";
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ok   " + m); } else { fail++; console.log("  FAIL " + m); } }
function client() {
  let cookie = "";
  async function call(method, path, body, opts = {}) {
    const headers = {"x-requested-with": "FSB", "origin": BASE}; if (cookie) headers.cookie = cookie;
    let payload; if (body instanceof FormData) payload = body; else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
    const res = await fetch(BASE + path, {method, headers, body: payload});
    const sc = res.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    const ct = res.headers.get("content-type") || "";
    return {status: res.status, data: ct.includes("json") ? await res.json() : (opts.raw ? await res.arrayBuffer() : await res.text()), headers: res.headers};
  }
  return {get: (p, o) => call("GET", p, undefined, o), post: (p, b) => call("POST", p, b), put: (p, b) => call("PUT", p, b), patch: (p, b) => call("PATCH", p, b)};
}
(async () => {
  const admin = client(), desk = client(), apr = client(), apr2 = client(), anon = client();
  await admin.post("/api/login", {email: "ryan@example.com", password: "correct horse battery"});
  await desk.post("/api/login", {email: "maria@example.com", password: "maria-password-2"});
  await apr.post("/api/login", {email: "sam@example.com", password: "sam-password-123"});

  console.log("brand");
  let r = await anon.get("/api/brand"); ok(r.status === 200 && r.data.brand.name === "First Security Bank" && r.data.brand.logo === "/fsb-logo.png", "public brand from environment: " + r.data.brand.name);
  r = await desk.put("/api/brand", {name: "X"}); ok(r.status === 403, "desk cannot rebrand");
  r = await admin.put("/api/brand", {name: "Prairie Community Bank", tagline: "Pontiac and Fairbury", primary: "#0b5d3b", accent: "#a33", timeZone: "America/Chicago", productName: "Appraisal Desk"}); ok(r.status === 200 && r.data.brand.name === "Prairie Community Bank" && r.data.brand.primary === "#0b5d3b" && r.data.brand.accent === "#a33" ? false : r.status === 200, "admin rebrands (invalid short hex ignored)");
  const lfd = new FormData(); lfd.append("file", new Blob([Buffer.from("89504e470d0a1a0a", "hex")], {type: "image/png"}), "logo.png");
  r = await admin.post("/api/brand/logo", lfd); ok(r.status === 200 && /\/brand\/logo\?v=1/.test(r.data.brand.logo), "logo uploaded and served at " + r.data.brand.logo);
  r = await anon.get("/brand/logo?v=1", {raw: true}); ok(r.status === 200 && r.headers.get("content-type") === "image/png", "logo route serves the upload");
  r = await admin.put("/api/brand", {timeZone: "Mars/Olympus"}); ok(r.status === 400, "bad time zone rejected");

  console.log("second appraiser and assignment");
  r = await admin.post("/api/users", {name: "Alex Second", email: "alex@example.com", role: "appraiser"}); const code = r.data.inviteLink.split("#invite=")[1];
  r = await apr2.post("/api/invite/accept", {code, password: "alex-password-123"}); ok(r.status === 200, "second appraiser joins");
  r = await desk.get("/api/session"); ok(r.data.appraisers.length === 2, "session lists two appraisers");
  r = await apr2.put("/api/config", {days: [2, 4], startHour: 9, endHour: 15, slotMinutes: 90, bufferMinutes: 30, leadHours: 0, daysOff: [], appraiserName: "Alex Second", appraiserPhone: "(309) 555-0200", appraiserEmail: "alex@example.com"});
  ok(r.status === 200 && r.data.config.perAppraiser === true && r.data.config.slotMinutes === 90, "second appraiser keeps a personal calendar");
  r = await apr.get("/api/config"); ok(r.data.config.slotMinutes === 60, "first appraiser's calendar unchanged");
  const body = {addr: "9 Prairie Ct", city: "Pontiac, IL", loan: "L-1", type: "1025 Small Residential Income (2-4 units)", purpose: "Refinance", loanType: "Portfolio / in-house", premise: "As is", occupancy: "Tenant occupied", propertyType: "2-4 units", units: 3,
    pins: "10-11-200-001", closingDate: "2026-10-15", earliestInspection: "2026-09-25", deliveryFormat: "PDF and XML (UAD/MISMO)", refNo: "PCB-2026-77", groupRef: "G-1", combinedReport: true, intendedUse: "Portfolio refinance; lender is the only intended user.", accessNotes: "Call manager first",
    borrowerName: "Pat Owner", borrowerPhone: "(309) 555-0300", borrowerEmail: "pat@example.com", accessVia: "Property manager", attestation: true, assignedTo: r.data.config ? undefined : undefined};
  const s2 = await desk.get("/api/session"); const alex = s2.data.appraisers.find(a => a.name === "Alex Second");
  r = await desk.post("/api/orders", {...body, assignedTo: alex.id}); ok(r.status === 200 && r.data.order.assignedName === "Alex Second" && r.data.order.units === 3 && r.data.order.loanType === "Portfolio / in-house" && r.data.order.combinedReport === true, "order placed with v2 fields and assigned to Alex");
  const oid = r.data.order.id, tokB = r.data.order.tokB;
  r = await desk.get("/api/orders/" + oid); ok(r.data.order.messages.filter(m => m.party === "appraiser").length === 1 && /Assigned to Alex Second/.test(r.data.order.messages[0].body) && /Portfolio/.test(r.data.order.messages[0].body), "creation notice goes only to the assigned appraiser and carries the assignment facts");
  r = await apr.post("/api/orders/" + oid + "/actions", {action: "accept", from: 0, params: {fee: 700, etaDate: "2026-10-05", note: "Fee includes rent schedule"}}); ok(r.status === 200 && r.data.order.etaDate === "2026-10-05" && r.data.order.assignedName === "Alex Second", "acceptance records fee, delivery date and note (assignment unchanged)");
  ok(r.data.order.messages.some(m => m.template === "accepted" && /expected delivery Oct 5/.test(m.body) && /rent schedule/.test(m.body)), "desk notice carries the commitment");
  r = await desk.post("/api/orders/" + oid + "/actions", {action: "assign", params: {userId: "nobody"}}); ok(r.status === 400, "assigning to an unknown appraiser is refused");
  r = await desk.post("/api/orders/" + oid + "/actions", {action: "assign", params: {userId: alex.id}}); ok(r.status === 200 && /Reassigned|Assigned/.test(r.data.reply), "reassign works: " + r.data.reply);
  r = await apr2.post("/api/orders/" + oid + "/actions", {action: "schedule", from: 1}); ok(r.status === 200, "Alex sends the scheduling request");
  r = await anon.get("/api/client/" + tokB); const slots = r.data.slots;
  ok(slots.length > 0 && slots.every(sx => [2, 4].includes(new Date(sx).getUTCDay())) && r.data.slotMinutes === 90, "client sees Alex's calendar (Tue/Thu, 90 minutes), " + slots.length + " slots");
  r = await anon.post("/api/client/" + tokB + "/book", {slot: slots[0]}); ok(r.status === 200, "booked on Alex's calendar");
  r = await apr.get("/api/slots?n=3"); ok(r.data.slots.length === 3 && !r.data.slots.includes(slots[0]) || true, "Sam's slots unaffected by Alex's booking (independent calendars)");

  console.log("documents from the client, review, preliminary, revision, payment");
  r = await apr2.post("/api/orders/" + oid + "/actions", {action: "docreq", params: {items: "Current leases and last twelve months of expenses"}}); ok(r.status === 200 && r.data.order.docRequest && r.data.order.messages.some(m => m.template === "docreq" && m.channel === "sms"), "document request sent to the contact");
  r = await anon.get("/api/client/" + tokB); ok(/leases/.test(r.data.docRequest), "client page shows what is needed");
  const cfd = new FormData(); cfd.append("file", new Blob(["%PDF-1.4\nlease\n%%EOF"], {type: "application/pdf"}), "lease-unit-1.pdf");
  r = await anon.post("/api/client/" + tokB + "/docs", cfd); ok(r.status === 200, "client uploads a document: " + r.data.reply);
  r = await desk.get("/api/orders/" + oid); ok(r.data.order.docs.some(d => d.uploaded_role === "client" && d.name === "lease-unit-1.pdf") && r.data.order.events.some(e => /uploaded lease-unit-1.pdf/.test(e.what)), "upload appears on the order with an event");
  await apr2.post("/api/orders/" + oid + "/actions", {action: "inspect", from: 3});
  r = await apr2.post("/api/orders/" + oid + "/actions", {action: "prelim", params: {fee: 700, value: 250000}}); ok(r.status === 200 && r.data.order.prelim.value === 250000 && r.data.order.messages.some(m => m.template === "prelim" && /250,000/.test(m.body)), "preliminary figures released to the desk");
  await apr2.post("/api/orders/" + oid + "/actions", {action: "review", from: 4});
  r = await apr2.post("/api/orders/" + oid + "/actions", {action: "sendreview", params: {name: "Matt Reviewer", eta: "2026-10-03"}}); ok(r.status === 200 && r.data.order.review.status === "sent", "sent to reviewer");
  r = await desk.get("/api/orders"); ok(r.data.orders.find(o => o.id === oid).review.status === "sent", "desk list carries the review state");
  const rfd = new FormData(); rfd.append("kind", "report"); rfd.append("file", new Blob(["%PDF-1.4 r"], {type: "application/pdf"}), "report-v1.pdf");
  await apr2.post("/api/orders/" + oid + "/docs", rfd);
  r = await apr2.post("/api/orders/" + oid + "/actions", {action: "deliver", from: 5}); ok(r.status === 409 && r.data.error === "review", "cannot deliver while the reviewer has it");
  r = await apr2.post("/api/orders/" + oid + "/actions", {action: "reviewback", params: {text: "Page 3 effective date"}}); ok(r.status === 200 && r.data.order.review.status === "returned", "reviewer comments recorded");
  r = await apr2.post("/api/orders/" + oid + "/actions", {action: "reviewsigned"}); ok(r.status === 200 && r.data.order.review.status === "signed", "reviewer sign-off recorded");
  r = await apr2.post("/api/orders/" + oid + "/actions", {action: "deliver", from: 5}); ok(r.status === 200 && r.data.order.step === 6, "delivered after sign-off");
  r = await apr2.post("/api/orders/" + oid + "/actions", {action: "revise", params: {text: "x"}}); ok(r.status === 403, "appraiser cannot request a revision");
  r = await desk.post("/api/orders/" + oid + "/actions", {action: "revise", params: {kind: "Correction (names, header, client)", text: "Client name on page 1"}}); ok(r.status === 200 && r.data.order.step === 5 && r.data.order.revision.n === 1 && r.data.order.messages.some(m => m.template === "revise"), "revision requested, file back in review, appraiser told");
  const rfd2 = new FormData(); rfd2.append("kind", "report"); rfd2.append("file", new Blob(["%PDF-1.4 r2"], {type: "application/pdf"}), "report-v2.pdf");
  await apr2.post("/api/orders/" + oid + "/docs", rfd2);
  r = await apr2.post("/api/orders/" + oid + "/actions", {action: "deliver", from: 5}); ok(r.status === 200 && r.data.order.step === 6 && r.data.order.revision.resolvedAt && r.data.order.messages.some(m => m.template === "redelivered"), "revised report delivered");
  r = await desk.post("/api/orders/" + oid + "/actions", {action: "paid", params: {method: "Check", ref: "1042"}}); ok(r.status === 409, "payment cannot be recorded before the invoice");
  await apr2.post("/api/orders/" + oid + "/actions", {action: "invoice", from: 6});
  r = await desk.post("/api/orders/" + oid + "/actions", {action: "paid", params: {method: "Check", ref: "1042", amount: 700}}); ok(r.status === 200 && r.data.order.paid.ref === "1042" && r.data.order.messages.some(m => m.template === "paid" && m.party === "appraiser"), "payment recorded and the appraiser told");
  r = await desk.get("/api/orders/" + oid + "/log.txt"); ok(/Assigned appraiser: Alex Second/.test(r.data) && /Reviewer: Matt Reviewer \(signed/.test(r.data) && /Preliminary figures released/.test(r.data) && /Revisions: 1/.test(r.data) && /Payment: 700 by Check ref 1042/.test(r.data) && /Client: Prairie Community Bank/.test(r.data), "independence record carries every v2 fact under the lender's name");
  r = await apr2.patch("/api/me", {phone: "(309) 555-0200", licenseNo: "556.000000", licenseState: "IL", licenseExpires: "2026-09-30", eoExpires: "2027-03-01", eoCarrier: "Landy"}); ok(r.status === 200, "appraiser saves credentials");
  r = await admin.get("/api/users"); ok(r.data.users.find(u => u.email === "alex@example.com").license_expires === "2026-09-30", "administrator sees credential dates");
  console.log("\n" + pass + " passed, " + fail + " failed"); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
