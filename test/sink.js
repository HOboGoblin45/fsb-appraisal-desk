/* Local mail and SMS sink for the delivery tests. Stands in for the lender's mail relay (MAIL_HOOK_URL)
   and for Twilio (TWILIO_API_BASE). Keeps everything it receives in memory and serves it back as JSON. */
import http from "node:http";
export function startSink(port = 8790) {
  const state = {mail: [], sms: []};
  const server = http.createServer((req, res) => {
    let raw = ""; req.on("data", c => raw += c);
    req.on("end", () => {
      const send = (code, obj) => { res.writeHead(code, {"content-type": "application/json"}); res.end(JSON.stringify(obj)); };
      if (req.method === "POST" && req.url === "/mail") {
        if (state.failNext) { state.failNext = false; return send(503, {error: "relay down"}); }
        const m = JSON.parse(raw); m.at = new Date().toISOString(); state.mail.push(m); return send(200, {id: "mail_" + state.mail.length});
      }
      if (req.method === "POST" && /^\/2010-04-01\/Accounts\/[^/]+\/Messages\.json$/.test(req.url)) {
        const auth = req.headers.authorization || "";
        if (!auth.startsWith("Basic ")) return send(401, {message: "no auth"});
        const p = Object.fromEntries(new URLSearchParams(raw));
        if (!/^\+1\d{10}$/.test(p.To || "")) return send(400, {code: 21211, message: "Invalid 'To' number " + p.To});
        const sid = "SM" + String(state.sms.length + 1).padStart(30, "0");
        state.sms.push({...p, sid, auth, at: new Date().toISOString()}); return send(201, {sid, status: "queued"});
      }
      if (req.method === "GET" && req.url === "/mail") return send(200, state.mail);
      if (req.method === "GET" && req.url === "/sms") return send(200, state.sms);
      if (req.method === "POST" && req.url === "/reset") { state.mail = []; state.sms = []; return send(200, {ok: true}); }
      if (req.method === "POST" && req.url === "/failnext") { state.failNext = true; return send(200, {ok: true}); }
      send(404, {error: "no"});
    });
  });
  return new Promise(resolve => server.listen(port, "127.0.0.1", () => resolve({server, state, url: "http://127.0.0.1:" + port})));
}
if (process.argv[1] && process.argv[1].endsWith("sink.js")) startSink(Number(process.env.PORT) || 8790).then(s => console.log("sink on " + s.url));
