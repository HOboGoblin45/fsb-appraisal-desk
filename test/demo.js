/* Checks the demonstration copy against a running `wrangler dev --env demo` (default http://127.0.0.1:8788). */
const BASE = process.env.BASE || "http://127.0.0.1:8788";
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ok   " + m); } else { fail++; console.log("  FAIL " + m); } }
function client() {
  let cookie = "";
  async function call(method, path, body, raw) {
    const headers = {"x-requested-with": "FSB", "origin": BASE}; if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(BASE + path, {method, headers, body: body === undefined ? undefined : JSON.stringify(body)});
    const sc = res.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    const ct = res.headers.get("content-type") || "";
    return {status: res.status, data: ct.includes("json") ? await res.json() : (raw ? await res.arrayBuffer() : await res.text())};
  }
  return {get: (p, raw) => call("GET", p, undefined, raw), post: (p, b) => call("POST", p, b)};
}
(async () => {
  const anon = client();
  let r = await anon.get("/api/session"); ok(r.data.demo === true, "session reports demo mode");
  r = await anon.post("/api/demo/reset", {});
  if (r.status === 401) { const d = client(); await d.post("/api/login", {email: "desk@fsbdemo.apprifi.com", password: "FSBdemo-2026"}); r = await d.post("/api/demo/reset", {}); ok(r.status === 200, "a signed-in person can reset the demonstration"); }
  else ok(r.status === 200, "an empty demonstration loads itself (" + r.status + ")");
  const who = {};
  for (const [role, email] of [["desk", "desk@fsbdemo.apprifi.com"], ["appraiser", "appraiser@fsbdemo.apprifi.com"], ["officer", "officer@fsbdemo.apprifi.com"], ["admin", "admin@fsbdemo.apprifi.com"]]) {
    who[role] = client(); r = await who[role].post("/api/login", {email, password: "FSBdemo-2026"}); ok(r.status === 200 && r.data.user.role === role, "demo sign-in as " + role + " (" + r.data.user.name + ")");
  }
  r = await who.desk.get("/api/orders"); const orders = r.data.orders; ok(orders.length === 8, "eight sample orders");
  const byAddr = a => orders.find(o => o.addr === a);
  const expect = {"1420 Sycamore Ln": 0, "812 N Roosevelt Ave": 2, "77 Prairie View Dr": 3, "305 S Main St": 5, "2201 Ironwood Ct": 6, "16 W Elm St": 7};
  for (const [a, step] of Object.entries(expect)) { const o = byAddr(a); ok(o && o.step === step && !o.hold && !o.cancelled, a + " at step " + step + " (" + (o ? o.step : "missing") + ")"); }
  ok(byAddr("540 Countryside Rd").hold === true, "540 Countryside Rd is on hold");
  ok(byAddr("98 Lakeshore Dr").cancelled === true, "98 Lakeshore Dr is cancelled");
  const C = byAddr("77 Prairie View Dr"); ok(C.apptStart && Date.parse(C.apptStart) > Date.now(), "scheduled inspection is in the future: " + C.apptStart);
  const F = byAddr("16 W Elm St"); ok(F.hasReport === true, "completed order carries a report");
  r = await who.desk.get("/api/orders/" + byAddr("812 N Roosevelt Ave").id); const B = r.data.order;
  ok(B.events.length >= 4 && B.messages.length >= 3, "812 N Roosevelt has events (" + B.events.length + ") and messages (" + B.messages.length + ")");
  ok(B.messages.every(m => m.status === "demo"), "demo messages are marked composed, not sent");
  const link = (B.messages.map(m => m.body).join("\n").match(/#t=([a-z0-9]+)/) || [])[1]; ok(!!link, "borrower link present in the scheduling text");
  r = await anon.get("/api/client/" + link); ok(r.status === 200 && r.data.step === 2 && r.data.slots.length > 0 && r.data.who === "Evan Marsh", "borrower page for Evan Marsh offers " + r.data.slots.length + " times");
  r = await who.desk.get("/api/orders/" + byAddr("2201 Ironwood Ct").id); const E = r.data.order; const rep = E.docs.find(d => d.kind === "report");
  ok(rep && rep.client_visible && E.consent && E.consent.borrower, "delivered order has a client-visible report and recorded consent");
  r = await who.officer.get("/f/" + E.id + "/" + rep.id, true); ok(r.status === 200 && Buffer.from(r.data).toString("latin1").startsWith("%PDF"), "loan officer downloads the sample report PDF");
  r = await who.desk.get("/api/orders/" + byAddr("16 W Elm St").id + "/log.txt"); ok(r.status === 200 && /Downloaded appraisal-16-elm-danvers.pdf/.test(r.data) && /Invoice sent/.test(r.data), "independence record for the completed order reads end to end");
  r = await who.admin.get("/api/users"); ok(r.data.users.length === 4 && r.data.users.every(u => u.has_pw), "four demo accounts with passwords");
  r = await who.desk.get("/api/messages"); ok(r.data.messages.length > 20, "outbox shows the composed messages (" + r.data.messages.length + ")");
  r = await who.desk.get("/api/orders/" + byAddr("77 Prairie View Dr").id); ok(r.data.order.events.some(e => /Reply from the appraiser/.test(e.what)), "question and reply exchange on the record");
  console.log("\n" + pass + " passed, " + fail + " failed"); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
