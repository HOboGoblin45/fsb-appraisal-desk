/* A law-firm client (CLIENT_TYPE=firm) against ./devfirm.sh on port 8792: titles, no attestation, record wording. */
import {spawnSync} from "node:child_process";
const BASE = process.env.BASE || "http://127.0.0.1:8792";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ok   " + m); } else { fail++; console.log("  FAIL " + m); } };
async function waitHealthy() { for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + "/api/health"); if (r.ok) return; } catch (e) {} await new Promise(res => setTimeout(res, 500)); } throw new Error("dev server did not come back"); }
function client() {
  let cookie = "";
  async function call(method, path, body) {
    const headers = {"x-requested-with": "FSB", "origin": BASE}; if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(BASE + path, {method, headers, body: body === undefined ? undefined : JSON.stringify(body)});
    const sc = res.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    const ct = res.headers.get("content-type") || "";
    return {status: res.status, data: ct.includes("json") ? await res.json() : await res.text()};
  }
  return {get: p => call("GET", p), post: (p, b) => call("POST", p, b)};
}
(async () => {
  const admin = client(), para = client(), atty = client(), apr = client(), anon = client();
  const r0 = spawnSync("node", ["provision.js", "admin", "--name", "Nora Voss", "--email", "nvoss@example.com", "--local"], {encoding: "utf8"});
  const code = (/#invite=([a-z0-9]+)/.exec(r0.stdout) || [])[1]; await waitHealthy();
  let r = await anon.get("/api/session"); ok(r.data.clientType === "firm" && r.data.brand.name === "Harlan & Voss, Attorneys", "session reports a law-firm client: " + r.data.clientType);
  r = await admin.post("/api/invite/accept", {code, password: "firm-admin-password-1"}); ok(r.status === 200, "firm administrator signs in");
  r = await admin.post("/api/users", {name: "Dee Park", email: "dpark@example.com", role: "desk"}); const c1 = r.data.inviteLink.split("#invite=")[1];
  r = await para.post("/api/invite/accept", {code: c1, password: "paralegal-password-1"}); ok(r.status === 200, "paralegal (desk role) accepts");
  r = await admin.post("/api/users", {name: "Harlan Sr.", email: "harlan@example.com", role: "officer"}); const c2 = r.data.inviteLink.split("#invite=")[1];
  r = await atty.post("/api/invite/accept", {code: c2, password: "attorney-password-1"}); ok(r.status === 200, "attorney (officer role) accepts");
  r = await admin.post("/api/users", {name: "Sam Appraiser", email: "sam@example.com", role: "appraiser"}); const c3 = r.data.inviteLink.split("#invite=")[1];
  r = await apr.post("/api/invite/accept", {code: c3, password: "sam-password-123"}); ok(r.status === 200, "appraiser accepts");
  r = await para.post("/api/orders", {addr: "118 Orchard Ln", city: "Normal, IL", loan: "2026-EST-0117", purpose: "Estate", type: "Date of death / retrospective", premise: "Retrospective (date of death)", borrowerName: "Estate of Ruth Ellison", borrowerEmail: "executor@example.com", accessVia: "Attorney or executor", officerName: "Harlan Sr.", officerEmail: "harlan@example.com"});
  ok(r.status === 200 && r.data.order.attestation === false && r.data.order.orderedByRole === "Paralegal", "a paralegal places an estate order with no recusal attestation; role recorded as Paralegal");
  const oid = r.data.order.id;
  r = await para.get("/api/orders/" + oid); ok(r.data.order.events[0].what === "Order created." && !/attestation/i.test(r.data.order.events[0].what), "the first record entry carries no attestation text");
  r = await para.get("/api/orders/" + oid + "/log.txt"); ok(/^APPRAISAL ORDER RECORD/.test(r.data) && /Matter or file number: 2026-EST-0117/.test(r.data) && /Attorney on file: Harlan Sr\./.test(r.data) && !/12 CFR/.test(r.data) && /direct between Harlan & Voss, Attorneys \(client\) and the appraiser/.test(r.data), "exported record uses firm wording and omits the lending control reference");
  r = await atty.post("/api/orders/" + oid + "/actions", {action: "post", params: {text: "How is it looking?"}}); ok(r.status === 403 && /^Attorneys read the conversation/.test(r.data.message), "attorney is read only on the conversation, with firm wording: " + r.data.message);
  r = await apr.post("/api/orders/" + oid + "/actions", {action: "accept", params: {fee: 650}}); ok(r.status === 200, "appraiser accepts");
  r = await apr.post("/api/orders/" + oid + "/actions", {action: "schedule", params: {}}); ok(r.status === 200, "scheduling request sent to the executor");
  r = await anon.get("/api/client/" + r.data.order.tokB); ok(r.status === 200 && r.data.clientType === "firm" && r.data.who === "Estate of Ruth Ellison", "the executor's status page reports the firm client type");
  r = await para.get("/api/orders/" + oid); const sched = r.data.order.messages.find(m => m.template === "schedule" && m.channel === "email");
  ok(sched && !/loan officer/i.test(sched.body), "client-facing email does not say loan officer");
  console.log("\n" + pass + " passed, " + fail + " failed"); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
