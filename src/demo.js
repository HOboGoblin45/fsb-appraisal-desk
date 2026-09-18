/* Demonstration copy: wipes the database and replays a realistic set of orders through the same
   code paths the product uses, so every event, message and link is genuine. Fictional people. */
import CORE from "./core.js";
import {SAMPLE_PDFS} from "./demo-files.js";

export const DEMO_PASSWORD = "FSBdemo-2026";
export const DEMO_USERS = [
  {id: "u_demo_admin", email: "admin@fsbdemo.apprifi.com", name: "Jordan Hale", role: "admin", phone: "(309) 555-0101"},
  {id: "u_demo_desk", email: "desk@fsbdemo.apprifi.com", name: "Maria Lopez", role: "desk", phone: "(309) 555-0102"},
  {id: "u_demo_officer", email: "officer@fsbdemo.apprifi.com", name: "Lee Whitcomb", role: "officer", phone: "(309) 555-0103"},
  {id: "u_demo_appraiser", email: "appraiser@fsbdemo.apprifi.com", name: "Sam Reynolds", role: "appraiser", phone: "(309) 555-0100"}
];

function b64(s) { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; }
const HOUR = 3600e3, DAY = 864e5;

export async function resetDemo(env, base, h) {
  const now = Date.now();
  const ago = (days, hours = 0, minutes = 0) => new Date(now - days * DAY - hours * HOUR - minutes * 60e3).toISOString();

  // 1. wipe everything, including stored document bytes
  const docs = (await env.DB.prepare("SELECT key FROM docs").all()).results || [];
  const st = h.store(env);
  for (const d of docs) { try { await st.del(d.key); } catch (e) {} }
  await env.DB.batch(["messages", "events", "docs", "orders", "sessions", "invites", "feedback", "ratelimit", "audit", "config", "users", "optouts", "inbound"].map(t => env.DB.prepare("DELETE FROM " + t)));

  // 2. people
  for (const u of DEMO_USERS) {
    await env.DB.prepare("INSERT INTO users (id,email,name,role,phone,active,created_at,created_by,updated_at,last_seen) VALUES (?,?,?,?,?,1,?,?,?,?)")
      .bind(u.id, u.email, u.name, u.role, u.phone, ago(30), "demonstration", ago(30), ago(0, 3)).run();
    await h.setPassword(env, u.id, DEMO_PASSWORD);
  }
  await env.DB.prepare("UPDATE users SET license_no=?, license_state='IL', license_expires=?, eo_expires=?, eo_carrier=? WHERE id='u_demo_appraiser'").bind("556.001234", new Date(now + 200 * DAY).toISOString().slice(0, 10), new Date(now + 30 * DAY).toISOString().slice(0, 10), "Sample Insurance Co.").run();
  await env.DB.prepare("INSERT INTO audit (at,who,what) VALUES (?,?,?)").bind(ago(30), "Vendor", "Provisioned the administrator account for Jordan Hale (admin@fsbdemo.apprifi.com) as designated by the lender.").run();
  await env.DB.prepare("INSERT INTO audit (at,who,what) VALUES (?,?,?)").bind(ago(29), "Jordan Hale", "Added Maria Lopez, Lee Whitcomb and Sam Reynolds.").run();

  // 3. availability and contact
  const cfg = {...CORE.defaultConfig(), appraiserName: "Sam Reynolds", appraiserPhone: "(309) 555-0100", appraiserEmail: "appraiser@fsbdemo.apprifi.com", leadHours: 24, deskCopyEmails: []};
  await env.DB.prepare("INSERT INTO config (key,value,updated_at,updated_by) VALUES ('availability',?,?,?)").bind(JSON.stringify(cfg), ago(28), "Sam Reynolds").run();

  const desk = {id: "u_demo_desk", name: "Maria Lopez", email: "desk@fsbdemo.apprifi.com", role: "desk"};
  const apr = {id: "u_demo_appraiser", name: "Sam Reynolds", role: "appraiser"};
  const deskActor = {id: desk.id, name: desk.name, role: "desk"};
  const act = (id, action, params, actor, at, opts) => h.runAction(env, base, null, id, action, params || {}, actor, {...(opts || {}), now: at});
  async function addDoc(o, name, kind, key, by, role, visible, at) {
    const bytes = b64(SAMPLE_PDFS[key]);
    const did = h.uid("d"), k = "doc/" + o.id + "/" + did;
    await st.put(k, bytes, "application/pdf");
    await env.DB.prepare("INSERT INTO docs (id,order_id,name,size,type,kind,client_visible,storage,key,uploaded_by,uploaded_role,uploaded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(did, o.id, name, bytes.byteLength, "application/pdf", kind, visible ? 1 : 0, st.kind, k, by, role, at).run();
    await h.writeEvents(env, o.id, [{at, who: by, role, what: "Uploaded " + name + " (" + CORE.DOC_KINDS[kind].name + ", " + bytes.byteLength + " bytes" + (visible ? ", visible to the client" : "") + ")."}]);
  }
  const place = (b, at) => h.createOrder(env, base, null, {attestation: true, type: "1004 URAR", ...b}, desk, at);
  function slotsFrom(atIso, booked) { return CORE.genSlots(cfg, booked || [], Date.parse(atIso), 12); }

  // 4. orders, oldest first so the board reads naturally
  // F: complete (invoiced)
  const F = await place({addr: "16 W Elm St", city: "Danvers, IL 61732", loan: "2026-004102", purpose: "Refinance", loanType: "Portfolio / in-house", propertyType: "Single family", occupancy: "Owner occupied", pins: "14-02-118-006", refNo: "FSB-2026-0041", due: new Date(now - 6 * DAY).toISOString().slice(0, 10), borrowerName: "Thomas Reid", borrowerPhone: "(309) 555-0171", borrowerEmail: "thomas.reid@example.com", accessVia: "Borrower", officerName: "Lee Whitcomb", officerEmail: "officer@fsbdemo.apprifi.com", notes: "Owner occupied. Call ahead."}, ago(20));
  await addDoc(F, "engagement-letter-16-elm.pdf", "engagement", "contract", desk.name, "desk", false, ago(20));
  await act(F.id, "accept", {fee: 525, etaDate: new Date(now - 8 * DAY).toISOString().slice(0, 10)}, apr, ago(19, 20));
  await act(F.id, "schedule", {}, apr, ago(19, 18));
  { const s = slotsFrom(ago(19, 17)); await act(F.id, "book", {slot: s[2]}, {name: "Thomas Reid", role: "client"}, ago(19, 17)); }
  await act(F.id, "inspect", {}, apr, ago(15));
  await act(F.id, "review", {}, apr, ago(14));
  await addDoc(F, "appraisal-16-elm-danvers.pdf", "report", "report", apr.name, "appraiser", true, ago(9));
  await act(F.id, "deliver", {}, apr, ago(8, 20));
  await act(F.id, "consent", {party: "borrower"}, {name: "Thomas Reid", role: "client"}, ago(8, 2));
  await h.writeEvents(env, F.id, [{at: ago(8, 1), who: "Thomas Reid", role: "client", what: "Downloaded appraisal-16-elm-danvers.pdf."}]);
  await addDoc(F, "invoice-16-elm.pdf", "invoice", "invoice", apr.name, "appraiser", false, ago(7, 3));
  await act(F.id, "invoice", {fee: 525}, apr, ago(7, 2));
  await act(F.id, "paid", {method: "Check", ref: "10422", amount: 525}, deskActor, ago(1, 6));

  // E: delivered, invoice pending
  const E = await place({addr: "2201 Ironwood Ct", city: "Normal, IL 61761", loan: "2026-004217", purpose: "Purchase", loanType: "Conventional", propertyType: "Single family", occupancy: "Vacant", pins: "14-33-427-003", refNo: "FSB-2026-0047", closingDate: new Date(now + 4 * DAY).toISOString().slice(0, 10), due: new Date(now - 2 * DAY).toISOString().slice(0, 10), borrowerName: "Priya Natarajan", borrowerPhone: "(309) 555-0148", borrowerEmail: "priya.n@example.com", agentName: "Marcy Teague, Kestrel Realty", agentPhone: "(309) 555-0199", agentEmail: "marcy@example.com", accessVia: "Agent", officerName: "Lee Whitcomb", officerEmail: "officer@fsbdemo.apprifi.com", notes: "Vacant. Lockbox on the front door; agent will share the code."}, ago(14));
  await addDoc(E, "sales-contract-2201-ironwood.pdf", "contract", "contract", desk.name, "desk", false, ago(14));
  await act(E.id, "accept", {fee: 575, etaDate: new Date(now - 4 * DAY).toISOString().slice(0, 10), note: "Lockbox access confirmed with the agent."}, apr, ago(13, 22));
  await act(E.id, "schedule", {}, apr, ago(13, 20));
  { const s = slotsFrom(ago(13, 19)); await act(E.id, "book", {slot: s[4]}, {name: "Marcy Teague, Kestrel Realty", role: "client"}, ago(13, 19)); }
  await act(E.id, "inspect", {}, apr, ago(10));
  await act(E.id, "review", {}, apr, ago(9));
  await addDoc(E, "appraisal-2201-ironwood.pdf", "report", "report", apr.name, "appraiser", true, ago(4, 3));
  await act(E.id, "deliver", {}, apr, ago(4, 2));
  await act(E.id, "consent", {party: "borrower"}, {name: "Priya Natarajan", role: "client"}, ago(3));
  await act(E.id, "revise", {kind: "Correction (names, header, client)", text: "Borrower name on page 1 reads Natarajan Priya; please correct the order of the names."}, deskActor, ago(2, 6));
  await addDoc(E, "appraisal-2201-ironwood-rev1.pdf", "report", "report", apr.name, "appraiser", true, ago(1, 22));
  await act(E.id, "deliver", {}, apr, ago(1, 21));

  // D: in review
  const D = await place({addr: "305 S Main St", city: "Deer Creek, IL 61733", loan: "2026-004288", purpose: "Purchase", loanType: "Conventional", propertyType: "Single family", occupancy: "Seller occupied", premise: "As improved (subject to listed repairs)", pins: "05-27-306-011", refNo: "FSB-2026-0052", closingDate: new Date(now + 6 * DAY).toISOString().slice(0, 10), due: new Date(now + 3 * DAY).toISOString().slice(0, 10), borrowerName: "Carlos and Ana Ruiz", borrowerPhone: "(309) 555-0122", borrowerEmail: "ruiz.family@example.com", accessVia: "Borrower", officerName: "Lee Whitcomb", officerEmail: "officer@fsbdemo.apprifi.com", notes: "Two dogs, friendly. Detached workshop counts as outbuilding."}, ago(9));
  await addDoc(D, "sales-contract-305-s-main.pdf", "contract", "contract", desk.name, "desk", false, ago(9));
  await act(D.id, "accept", {fee: 550, etaDate: new Date(now + 1 * DAY).toISOString().slice(0, 10)}, apr, ago(8, 22));
  await act(D.id, "schedule", {}, apr, ago(8, 20));
  { const s = slotsFrom(ago(8, 19)); await act(D.id, "book", {slot: s[1]}, {name: "Carlos and Ana Ruiz", role: "client"}, ago(8, 19)); }
  await act(D.id, "inspect", {}, apr, ago(6));
  await act(D.id, "review", {}, apr, ago(5));
  await act(D.id, "prelim", {fee: 550, value: 268000}, apr, ago(3, 4));
  await act(D.id, "sendreview", {name: "Jordan Price, Certified General", eta: new Date(now + 1 * DAY).toISOString().slice(0, 10), note: "Supervisory review and co-signature."}, apr, ago(2, 3));

  // H: cancelled
  const H = await place({addr: "98 Lakeshore Dr", city: "Heritage Lake, IL 61755", loan: "2026-004301", purpose: "Purchase", due: new Date(now + 5 * DAY).toISOString().slice(0, 10), borrowerName: "Kim Okafor", borrowerPhone: "(309) 555-0133", borrowerEmail: "kim.okafor@example.com", accessVia: "Borrower", notes: ""}, ago(7));
  await act(H.id, "accept", {fee: 550}, apr, ago(6, 22));
  await act(H.id, "cancel", {reason: "Loan withdrawn", note: "Buyer walked after inspection."}, deskActor, ago(6, 4));

  // G: on hold
  const G = await place({addr: "540 Countryside Rd", city: "Tremont, IL 61568", loan: "2026-004315", purpose: "Refinance", loanType: "Portfolio / in-house", propertyType: "Farm / agricultural", type: "Agricultural / farm / land", pins: "07-22-100-004, 07-22-100-005", due: new Date(now + 6 * DAY).toISOString().slice(0, 10), borrowerName: "Gene Albrecht", borrowerPhone: "(309) 555-0144", borrowerEmail: "", accessVia: "Borrower", officerName: "Lee Whitcomb", officerEmail: "officer@fsbdemo.apprifi.com", notes: "No email on file; phone only."}, ago(6));
  await act(G.id, "accept", {fee: 550}, apr, ago(5, 22));
  await act(G.id, "schedule", {}, apr, ago(5, 20));
  await act(G.id, "hold", {reason: "Cannot reach contact", note: "Three calls and two texts since Monday, no answer. Desk, can you reach him?"}, apr, ago(3));

  // C: scheduled (inspection coming up)
  const C = await place({addr: "77 Prairie View Dr", city: "Heritage Lake, IL 61755", loan: "2026-004330", purpose: "Refinance", loanType: "Conventional", propertyType: "Single family", occupancy: "Owner occupied", pins: "07-14-410-018", refNo: "FSB-2026-0058", due: new Date(now + 9 * DAY).toISOString().slice(0, 10), borrowerName: "Angela Moss", borrowerPhone: "(309) 555-0155", borrowerEmail: "angela.moss@example.com", accessVia: "Borrower", officerName: "Lee Whitcomb", officerEmail: "officer@fsbdemo.apprifi.com", notes: "Finished basement added 2023; permits in the file."}, ago(5));
  await addDoc(C, "prior-appraisal-77-prairie-view-2021.pdf", "prior", "report", desk.name, "desk", false, ago(5));
  await act(C.id, "accept", {fee: 550, etaDate: new Date(now + 8 * DAY).toISOString().slice(0, 10)}, apr, ago(4, 22));
  await act(C.id, "schedule", {}, apr, ago(4, 20));
  { const s = CORE.genSlots(cfg, await bookedNow(env), now, 12); await act(C.id, "book", {slot: s[3]}, {name: "Angela Moss", role: "client"}, ago(4, 18)); }
  await act(C.id, "ask", {text: "Angela asked whether she needs to be home for the whole inspection. Anything else she should have ready?"}, deskActor, ago(2));
  await act(C.id, "reply", {text: "She only needs to let me in and show me the basement access. About an hour. Permits for the basement would be helpful if she has them handy."}, apr, ago(1, 20));
  await act(C.id, "post", {text: "Angela, I will be there about an hour. Please leave the basement door unlocked and have the finish permit handy if you can.", to: "client"}, apr, ago(1, 19, 30));
  await act(C.id, "post", {text: "Will do. The permit is in a folder on the kitchen counter. My daughter will let you in if I am not back from work.", via: "text message"}, {name: "Angela Moss", role: "client"}, ago(1, 19, 10));
  await act(C.id, "docreq", {items: "Basement finish permit and the contractor's invoice"}, apr, ago(1, 19));
  await addDoc(C, "basement-permit-2023.pdf", "other", "contract", "Angela Moss", "client", false, ago(1, 2));
  await h.writeEvents(env, C.id, [{at: ago(1, 2), who: "Angela Moss", role: "client", what: "Angela Moss uploaded basement-permit-2023.pdf."}]);

  // B: scheduling, waiting on the borrower to pick a time
  const B = await place({addr: "812 N Roosevelt Ave", city: "Bloomington, IL 61701", loan: "2026-004417", purpose: "Purchase", loanType: "Conventional", propertyType: "Single family", occupancy: "Seller occupied", pins: "14-33-152-009", refNo: "FSB-2026-0063", closingDate: new Date(now + 14 * DAY).toISOString().slice(0, 10), accessNotes: "Gate code 4471. Dog in the yard, text before arriving.", due: new Date(now + 12 * DAY).toISOString().slice(0, 10), borrowerName: "Evan Marsh", borrowerPhone: "(309) 555-0166", borrowerEmail: "evan.marsh@example.com", agentName: "Dale Prince, Prairie Homes", agentPhone: "(309) 555-0177", agentEmail: "dale@example.com", accessVia: "Borrower", officerName: "Lee Whitcomb", officerEmail: "officer@fsbdemo.apprifi.com", notes: "Gate code 4471. Dog in the yard, please text before arriving."}, ago(3));
  await addDoc(B, "sales-contract-812-roosevelt.pdf", "contract", "contract", desk.name, "desk", false, ago(3));
  await act(B.id, "accept", {fee: 550, etaDate: new Date(now + 10 * DAY).toISOString().slice(0, 10)}, apr, ago(2, 23));
  await act(B.id, "schedule", {}, apr, ago(2, 20));

  // A: just placed
  const A = await place({addr: "1420 Sycamore Ln", city: "Mackinaw, IL 61755", loan: "2026-004452", purpose: "Purchase", loanType: "Conventional", propertyType: "Single family", occupancy: "Seller occupied", pins: "07-14-302-011", refNo: "FSB-2026-0064", closingDate: new Date(now + 16 * DAY).toISOString().slice(0, 10), earliestInspection: new Date(now + 2 * DAY).toISOString().slice(0, 10), intendedUse: "Mortgage lending; First Security Bank is the only intended user.", due: new Date(now + 14 * DAY).toISOString().slice(0, 10), borrowerName: "Dana Whitfield", borrowerPhone: "(309) 555-0188", borrowerEmail: "dana.whitfield@example.com", agentName: "Marcy Teague, Kestrel Realty", agentPhone: "(309) 555-0199", agentEmail: "marcy@example.com", accessVia: "Agent", officerName: "Lee Whitcomb", officerEmail: "officer@fsbdemo.apprifi.com", notes: "Seller occupied until closing. Agent coordinates access.", rush: true}, ago(0, 2));
  await addDoc(A, "sales-contract-1420-sycamore.pdf", "contract", "contract", desk.name, "desk", false, ago(0, 2));

  await env.DB.prepare("INSERT INTO audit (at,who,what) VALUES (?,?,?)").bind(h.nowISO(), "Demonstration", "Sample data loaded. Resets every night.").run();
  return {orders: 8, users: DEMO_USERS.length};
}
async function bookedNow(env) {
  const rows = (await env.DB.prepare("SELECT appt_start FROM orders WHERE appt_start IS NOT NULL AND cancelled=0 AND declined=0").all()).results || [];
  return rows.map(r => Date.parse(r.appt_start)).filter(isFinite);
}
