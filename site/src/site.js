/* apprifi.com: serves the public pages from assets and answers two small API routes.
   POST /api/contact   request a walkthrough; emails the vendor, rate limited, honeypot
   GET  /api/lender?email=   the sign-in router: which portal does this work email belong to */
import LENDERS from "../lenders.json";

const SEC = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin", "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()", "strict-transport-security": "max-age=31536000"
};
const json = (data, status = 200) => new Response(JSON.stringify(data), {status, headers: {"content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SEC}});
const s = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const escHtml = t => String(t).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));

function lenderFor(email) {
  const domain = String(email || "").toLowerCase().split("@")[1] || "";
  if (!domain) return null;
  return LENDERS.find(l => (l.domains || []).some(d => domain === d || domain.endsWith("." + d))) || null;
}

async function limited(env, key, max, ttl) {
  if (!env.SITE) return false;
  const k = "rl:" + key, cur = Number(await env.SITE.get(k)) || 0;
  if (cur >= max) return true;
  await env.SITE.put(k, String(cur + 1), {expirationTtl: ttl});
  return false;
}

async function contact(req, env, ctx) {
  const ip = req.headers.get("cf-connecting-ip") || "unknown";
  let b; try { b = await req.json(); } catch (e) { return json({error: "Malformed request."}, 400); }
  if (s(b.website, 100)) return json({ok: true}); // honeypot: bots fill it, people never see it
  const name = s(b.name, 120), org = s(b.org, 160), email = s(b.email, 160).toLowerCase(), phone = s(b.phone, 40), role = s(b.role, 80), message = s(b.message, 3000), volume = s(b.volume, 60);
  if (!name || !org || !emailOk(email)) return json({error: "Name, institution and a work email are required."}, 400);
  if (await limited(env, "contact:" + ip, 5, 3600)) return json({error: "Too many requests from this connection. Try again in an hour, or email orders@apprifi.com."}, 429);
  const body = "Walkthrough request from apprifi.com\n\nName: " + name + "\nInstitution: " + org + "\nRole: " + (role || "not given") + "\nEmail: " + email + "\nPhone: " + (phone || "not given") + "\nAppraisals a month: " + (volume || "not given") + "\n\n" + (message || "(no message)") + "\n\nIP: " + ip + "\nWhen: " + new Date().toISOString();
  const html = "<pre style=\"font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;white-space:pre-wrap\">" + escHtml(body) + "</pre>";
  if (!env.EMAIL || !env.VENDOR_EMAIL) return json({error: "The request could not be delivered right now. Email orders@apprifi.com instead."}, 503);
  try {
    await env.EMAIL.send({to: env.VENDOR_EMAIL, from: env.MAIL_FROM || "Apprifi <no-reply@apprifi.com>", replyTo: {email, name}, subject: "Walkthrough request: " + org + " (" + name + ")", text: body, html});
  } catch (e) { return json({error: "The request could not be delivered right now. Email orders@apprifi.com instead."}, 503); }
  return json({ok: true});
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.hostname === "www.apprifi.com") return Response.redirect("https://apprifi.com" + url.pathname + url.search, 301);
    if (url.pathname === "/api/contact" && req.method === "POST") return contact(req, env, ctx);
    if (url.pathname === "/api/lender" && req.method === "GET") {
      const l = lenderFor(url.searchParams.get("email"));
      return json(l ? {found: true, name: l.name, portal: l.portal} : {found: false});
    }
    if (url.pathname.startsWith("/api/")) return json({error: "No such route."}, 404);
    if (url.pathname === "/demo") return Response.redirect("https://demo.apprifi.com/", 302);
    const res = await env.ASSETS.fetch(req);
    const h = new Headers(res.headers);
    Object.entries(SEC).forEach(([k, v]) => h.set(k, v));
    if ((h.get("content-type") || "").includes("text/html")) h.set("cache-control", "public, max-age=300");
    return new Response(res.body, {status: res.status, headers: h});
  }
};
