/* FSB Appraisal Desk: browser app. Talks to the Worker API; CORE (above) supplies shared rules. */
(function(){
  "use strict";
  var STEPS=CORE.STEPS, ROLES=CORE.ROLES, CLIENT_LABEL=CORE.CLIENT_LABEL, DOC_KINDS=CORE.DOC_KINDS;
  var S = {
    me:null, view:"board", sel:null, tab:"status", orders:[], detail:{}, config:null, feedback:[], users:[], audit:[], messages:[],
    busy:false, toastT:null, boot:"loading", bootWhy:"", token:null, client:null, invite:null, inviteCode:null, setupNeeded:false,
    providers:{email:false,sms:false}, filter:"active", q:"", mfilter:"manual", lastSync:"", menu:false, pollT:null, storage:"kv"
  };

  /* ---------- helpers ---------- */
  function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
  function nowISO(){return new Date().toISOString();}
  var tz=function(){ return (S.config&&S.config.timeZone)||CORE.TZ; };
  function fmtTime(iso){ return iso?CORE.fmtTime(iso,tz()):""; }
  function fmtDay(iso){ return iso?CORE.fmtDay(iso,tz()):""; }
  function fmtHr(iso){ return iso?CORE.fmtHr(iso,tz()):""; }
  function fmtDate(d){ return CORE.fmtDate(d); }
  function kb(n){return n>=1048576?(n/1048576).toFixed(1)+" MB":Math.max(1,Math.round(n/1024))+" KB";}
  function lsGet(k){try{return localStorage.getItem(k);}catch(e){return null;}}
  function lsSet(k,v){try{localStorage.setItem(k,v);}catch(e){}}
  function $(id){ return document.getElementById(id); }
  function val(id){ var e=$(id); return e?String(e.value||"").trim():""; }
  function toast(html){
    var old=document.querySelector(".toast"); if(old) old.remove();
    if(S.toastT) clearTimeout(S.toastT);
    var el=document.createElement("div"); el.className="toast"; el.setAttribute("role","status"); el.innerHTML=html;
    document.body.appendChild(el);
    S.toastT=setTimeout(function(){el.remove();},5200);
  }
  function modal(html){ $("modal").innerHTML=html||""; if(html){ var f=$("modal").querySelector("input,select,textarea"); if(f) try{ f.focus(); }catch(e){} } }
  function money(n){ return CORE.money(n); }
  function status(o){ return CORE.statusOf(o); }
  function can(w){ return S.me&&CORE.can(S.me.role,w); }

  /* ---------- API ---------- */
  function api(method,path,body,form){
    var h={"x-requested-with":"FSB","accept":"application/json"};
    var opts={method:method,headers:h,credentials:"same-origin"};
    if(body!==undefined){ if(form){ opts.body=body; } else { h["content-type"]="application/json"; opts.body=JSON.stringify(body); } }
    return fetch(path,opts).then(function(r){
      var ct=r.headers.get("content-type")||"";
      return (ct.indexOf("json")>-1?r.json():r.text()).then(function(data){
        if(!r.ok){
          var e=new Error((data&&data.message)||("Request failed ("+r.status+")")); e.status=r.status; e.code=data&&data.error; e.data=data;
          if(r.status===401&&S.me&&!S.token){ S.me=null; S.view="board"; render(); toast("Your session ended. Sign in again."); }
          throw e;
        }
        return data;
      });
    },function(){ var e=new Error("Cannot reach the server. Check your connection."); e.code="network"; throw e; });
  }
  function fail(e){ toast("<b>"+esc(e&&e.message||"Something went wrong.")+"</b>"); }

  /* ---------- model access ---------- */
  function byId(id){ for(var i=0;i<S.orders.length;i++){ if(S.orders[i].id===id) return S.orders[i]; } return null; }
  function current(){ if(!S.sel) return null; return S.detail[S.sel]||byId(S.sel); }
  function upsert(o){ for(var k=0;k<S.orders.length;k++){ if(S.orders[k].id===o.id){ S.orders[k]=o; return; } } S.orders.unshift(o); }
  function mergeList(list){
    list.forEach(function(o){ var old=byId(o.id); upsert(o); if(S.detail[o.id]&&old&&old.version!==o.version) delete S.detail[o.id]; });
    S.orders.sort(function(a,b){ return (b.createdAt||"")<(a.createdAt||"")?-1:1; });
  }
  function clientLink(t){ return location.origin+location.pathname+"#t="+t; }
  function readHash(){
    var h=(location.hash||"").replace(/^#/,""), out={};
    h.split("&").forEach(function(kv){ var m=/^([a-z]+)=(.+)$/i.exec(kv); if(m) out[m[1]]=decodeURIComponent(m[2]); });
    return out;
  }
  function homeFor(role){ return role==="appraiser"?"queue":(role==="admin"?"people":"board"); }
  function navFor(role){
    if(role==="desk")      return [["board","Order board"],["new","New order"],["outbox","Outbox"],["feedback","Feedback"]];
    if(role==="officer")   return [["board","Order status"],["outbox","Outbox"],["feedback","Feedback"]];
    if(role==="appraiser") return [["queue","My queue"],["avail","Availability"],["outbox","Outbox"],["feedback","Feedback"]];
    if(role==="admin")     return [["people","People"],["board","Order status"],["outbox","Outbox"],["avail","Availability"],["feedback","Feedback"]];
    return [];
  }

  /* ---------- loading ---------- */
  function loadOrders(full){
    var path="/api/orders"+(!full&&S.lastSync?("?since="+encodeURIComponent(S.lastSync)):"");
    return api("GET",path).then(function(d){
      if(full) S.orders=[];
      var n=(d.orders||[]).length;
      mergeList(d.orders||[]); S.lastSync=d.time;
      if(S.sel&&!byId(S.sel)) S.sel=null;
      if(S.sel&&!S.detail[S.sel]) return loadDetail(S.sel).then(function(){ return n; });
      return n;
    });
  }
  function loadDetail(id){
    return api("GET","/api/orders/"+encodeURIComponent(id)).then(function(d){ S.detail[id]=d.order; upsert(d.order); render(); return d.order; });
  }
  function loadUsers(){ if(!S.me||S.me.role!=="admin") return Promise.resolve(); return api("GET","/api/users").then(function(d){ S.users=d.users; }); }
  function loadFeedback(){ return api("GET","/api/feedback").then(function(d){ S.feedback=d.feedback; }); }
  function loadMessages(){ var q=S.mfilter==="all"?"":("?status="+S.mfilter); return api("GET","/api/messages"+q).then(function(d){ S.messages=d.messages; }); }
  function poll(){
    if(document.hidden||!S.me||S.token) return;
    loadOrders(false).then(function(n){ if(n) render(); }).catch(function(){});
  }
  function startPolling(){ if(S.pollT) clearInterval(S.pollT); S.pollT=setInterval(poll,15000); }
  function refreshView(){
    var v=S.view, p=[];
    if(v==="people") p.push(loadUsers()); if(v==="feedback") p.push(loadFeedback()); if(v==="outbox") p.push(loadMessages());
    if(v==="avail") p.push(api("GET","/api/slots?n=6").then(function(d){ S.slotPreview=d.slots; }));
    return Promise.all(p).then(render).catch(fail);
  }
  function afterSignIn(user,sessionData){
    S.me=user; S.config=(sessionData&&sessionData.config)||S.config||CORE.defaultConfig();
    var h=readHash(); S.view=homeFor(user.role);
    render();
    loadOrders(true).then(function(){
      if(h.o&&byId(h.o)){ S.sel=h.o; S.view=user.role==="appraiser"?"queue":"board"; S.tab="status"; return loadDetail(h.o); }
    }).then(refreshView).catch(fail);
    startPolling();
  }
  function boot(){
    var h=readHash();
    if(h.t){ S.token=h.t; return loadClient(); }
    if(h.invite){ S.inviteCode=h.invite; S.boot="ready"; render();
      return api("GET","/api/invite/"+encodeURIComponent(h.invite)).then(function(d){ S.invite=d; render(); }).catch(function(e){ S.invite={error:e.message}; render(); });
    }
    api("GET","/api/session").then(function(d){
      S.boot="ready"; S.setupNeeded=!!d.setupNeeded; S.setupNeedsKey=!!d.setupNeedsKey; S.providers=d.providers||S.providers; S.storage=d.storage||"kv";
      if(d.user) afterSignIn(d.user,d); else render();
    }).catch(function(e){ S.boot="offline"; S.bootWhy=e.message; render(); });
  }
  function loadClient(){
    return api("GET","/api/client/"+encodeURIComponent(S.token)).then(function(d){ S.client=d; S.config={timeZone:d.tz,slotMinutes:d.slotMinutes}; S.boot="ready"; render(); })
      .catch(function(e){ S.client={error:e.message,status:e.status}; S.boot="ready"; render(); });
  }

  /* ---------- shared bits ---------- */
  function rail(o){
    var h='<div class="rail" aria-hidden="true">';
    for(var i=0;i<STEPS.length;i++){ var done=(i<o.step)||(i===o.step&&o.step===STEPS.length-1); h+='<i class="'+(done?"done":(i===o.step?"now":""))+'"></i>'; }
    return h+'</div>';
  }
  function pill(o){
    var cls="info";
    if(o.cancelled) cls="crit"; else if(o.declined) cls="crit"; else if(o.hold) cls="wait"; else if(o.step>=6) cls="ok"; else if(o.step===0) cls="crit";
    return '<span class="pill '+cls+'">'+esc(status(o))+'</span>'+(o.rush&&CORE.isOpen(o)?'<span class="flag">Rush</span>':'');
  }
  function mpill(st){ var m={sent:"Sent",queued:"Sending",manual:"Needs sending",failed:"Failed",portal:"Seen in portal"}; return '<span class="pill '+esc(st)+'">'+esc(m[st]||st)+'</span>'; }
  function timelineHtml(o){
    return '<ul class="tl">'+STEPS.map(function(s,i){
      var cls=i<o.step?"done":(i===o.step?"now":"pend");
      var when=i<o.step?"Complete":(i===o.step?(o.cancelled?"Cancelled":(o.declined?"Declined":(o.hold?("On hold: "+(o.holdReason||"waiting")):"In progress"))):"");
      return '<li class="'+cls+'"><span class="nd">'+(i<o.step?"&#10003;":(i+1))+'</span><span class="tx"><b>'+esc(s)+'</b><span>'+esc(when)+'</span></span></li>';
    }).join("")+'</ul>';
  }
  function sel(id,opts,cur){ return '<select id="'+id+'">'+opts.map(function(x){ return '<option'+(x===cur?" selected":"")+'>'+esc(x)+'</option>'; }).join("")+'</select>'; }
  function sheet(title,inner,primary,act,extra){
    return '<div class="sheet" data-a="closesheet"><div class="sheetc" data-stop="1"><div class="stack">'+
      '<div><h2 style="font-size:17px">'+esc(title)+'</h2></div>'+inner+
      '<div class="row"><button class="btn btn-p" data-a="'+esc(act)+'"'+(extra||"")+'>'+esc(primary)+'</button><button class="btn" data-a="closesheet">Cancel</button></div>'+
      '</div></div></div>';
  }
  function mailto(m){
    return "mailto:"+encodeURIComponent(m.to_addr||"")+"?subject="+encodeURIComponent(m.subject||"First Security Bank appraisal update")+"&body="+encodeURIComponent(m.body||"");
  }
  function smsto(m){
    var n=String(m.to_addr||"").replace(/[^\d+]/g,"");
    var ios=/iPhone|iPad|iPod/.test(navigator.userAgent||"");
    return "sms:"+n+(ios?"&":"?")+"body="+encodeURIComponent(m.body||"");
  }
  function msgActions(m){
    var a=[];
    if(m.status!=="sent"&&m.status!=="portal"){
      if(m.channel==="email"&&m.to_addr) a.push('<a class="btn btn-s" href="'+esc(mailto(m))+'">Open in email app</a>');
      if(m.channel==="sms"&&m.to_addr) a.push('<a class="btn btn-s" href="'+esc(smsto(m))+'">Open in Messages</a>');
      a.push('<button class="btn btn-s" data-copy="'+esc((m.subject?m.subject+"\n\n":"")+m.body)+'" data-what="Message">Copy text</button>');
      if(m.status==="failed"&&m.to_addr) a.push('<button class="btn btn-s" data-mretry="'+esc(m.id)+'">Retry</button>');
      if(m.status!=="queued") a.push('<button class="btn btn-s" data-msent="'+esc(m.id)+'">Mark as sent</button>');
    }
    return a.length?'<div class="acts">'+a.join("")+'</div>':"";
  }
  function msgHtml(m,withOrder){
    var toLine=esc(m.channel==="sms"?"Text":"Email")+" to "+esc(m.to_name)+(m.to_addr?(' <span class="muted">'+esc(m.to_addr)+'</span>'):' <span class="muted">(no '+(m.channel==="sms"?"mobile":"email")+' on file)</span>');
    return '<div class="msg '+(m.channel==="sms"?"sms":"")+'"><div class="meta"><b>'+toLine+'</b>'+mpill(m.status)+'<span class="sm muted">'+esc(fmtTime(m.created_at))+(m.sent_by?(' &middot; sent by '+esc(m.sent_by)):'')+'</span>'+
      (withOrder&&m.order_addr?('<span class="sm muted">&middot; '+esc(m.order_addr)+'</span>'):'')+'</div>'+
      (m.subject?'<div style="font-weight:600;color:var(--ink);margin-bottom:3px">'+esc(m.subject)+'</div>':'')+
      '<div style="white-space:pre-wrap">'+esc(m.body)+'</div>'+
      (m.last_error&&m.status==="failed"?'<p class="sm" style="color:var(--red);margin-top:4px">'+esc(m.last_error)+'</p>':'')+
      msgActions(m)+'</div>';
  }

  /* ---------- entry screens ---------- */
  function setupHtml(){
    return '<div class="signwrap"><div class="panel"><div class="ph"><div><h2>Set up the portal</h2>'+
      '<p class="note">This is a fresh installation. The first account is the bank administrator, who then invites everyone else and assigns their roles.</p></div></div>'+
      '<div class="pb"><div class="stack">'+
      '<label class="f">Your name<input id="su_name" autocomplete="name"></label>'+
      '<label class="f">Work email<input id="su_email" type="email" autocomplete="username"></label>'+
      '<label class="f">Choose a password (10 characters or more)<input id="su_pw" type="password" autocomplete="new-password"></label>'+
      (S.setupNeedsKey?'<label class="f">Setup key (given to you with the deployment)<input id="su_key" autocomplete="off"></label>':'')+
      '<div><button class="btn btn-p" data-a="setup">Create administrator account</button></div>'+
      '</div></div></div></div>';
  }
  function signinHtml(){
    if(S.boot==="loading") return '<div class="panel"><div class="empty"><b>One moment</b>Connecting.</div></div>';
    if(S.boot==="offline") return '<div class="panel"><div class="empty"><b>Cannot reach the server</b>'+esc(S.bootWhy||"")+'<div style="margin-top:10px"><button class="btn btn-s" data-a="retry">Try again</button></div></div></div>';
    return '<div class="signwrap"><div class="panel"><div class="ph"><div><h2>Sign in</h2>'+
      '<p class="note">Use the email and password from your invitation. Your role (appraisal desk, loan officer, appraiser or administrator) is set by the bank administrator and decides which screens you see.</p></div></div>'+
      '<div class="pb"><form class="stack" id="signinForm">'+
      '<label class="f">Work email<input id="si_email" type="email" autocomplete="username" inputmode="email"></label>'+
      '<label class="f">Password<input id="si_pw" type="password" autocomplete="current-password"></label>'+
      '<div><button class="btn btn-p" type="submit" data-a="signin">Sign in</button></div>'+
      '<p class="sm muted">Forgot your password, or never got an invitation? Ask the bank administrator to issue a new sign-in link.</p>'+
      '</form></div></div><p class="brandline">First Security Bank &middot; Mackinaw, Heritage Lake, Deer Creek, Danvers</p></div>';
  }
  function inviteHtml(){
    if(!S.invite) return '<div class="panel"><div class="empty"><b>Checking your invitation</b></div></div>';
    if(S.invite.error) return '<div class="signwrap"><div class="panel"><div class="empty"><b>This invitation is not valid</b>'+esc(S.invite.error)+'<div style="margin-top:10px"><a class="btn btn-s" href="./">Go to sign in</a></div></div></div></div>';
    return '<div class="signwrap"><div class="panel"><div class="ph"><div><h2>Welcome, '+esc(S.invite.name)+'</h2>'+
      '<p class="note">You have been added as <b>'+esc((ROLES[S.invite.role]||{}).name||S.invite.role)+'</b> ('+esc(S.invite.email)+'). '+esc((ROLES[S.invite.role]||{}).hint||"")+'</p></div></div>'+
      '<div class="pb"><form class="stack" id="inviteForm">'+
      '<label class="f">Choose a password (10 characters or more)<input id="iv_pw" type="password" autocomplete="new-password"></label>'+
      '<label class="f">Type it again<input id="iv_pw2" type="password" autocomplete="new-password"></label>'+
      '<div><button class="btn btn-p" type="submit" data-a="acceptinvite">Set password and sign in</button></div>'+
      '</form></div></div></div>';
  }

  /* ---------- people (admin) ---------- */
  function peopleHtml(){
    var rows=S.users.map(function(r){
      var me=S.me.id===r.id;
      var how=!r.has_pw?('<span class="pill wait">Waiting on first sign-in</span>'+(r.invite_expires&&r.invite_expires<nowISO()?' <span class="pill crit">Link expired</span>':'')):(r.active?'<span class="pill ok">Active</span>':'<span class="pill crit">Suspended</span>');
      return '<tr><td><div class="addr">'+esc(r.name)+(me?' <span class="pill info">you</span>':'')+'<small>'+esc(r.email)+(r.phone?(' &middot; '+esc(r.phone)):'')+'</small></div></td>'+
        '<td class="sm" data-label="Role">'+(me?esc(ROLES[r.role].name):'<select data-urole="'+esc(r.id)+'">'+Object.keys(ROLES).map(function(k){ return '<option value="'+k+'"'+(k===r.role?" selected":"")+'>'+esc(ROLES[k].name)+'</option>'; }).join("")+'</select>')+'</td>'+
        '<td data-label="Status">'+how+'</td>'+
        '<td class="sm muted" data-label="Last seen">'+esc(r.last_seen?fmtTime(r.last_seen):"never")+'</td>'+
        '<td><div class="row">'+(me?'<span class="sm muted">Your own account</span>':
          '<button class="btn btn-s" data-uinvite="'+esc(r.id)+'">New sign-in link</button>'+
          '<button class="btn btn-s" data-uactive="'+esc(r.id)+'" data-to="'+(r.active?"0":"1")+'">'+(r.active?"Suspend":"Restore")+'</button>')+'</div></td></tr>';
    }).join("");
    return '<div class="panel"><div class="ph"><div><h2>People</h2>'+
      '<p class="note">Everyone who can sign in, and what they may do. Adding someone produces a one-time sign-in link that lasts seven days; send it to them yourself. The same button resets a forgotten password.</p></div>'+
      '<button class="btn btn-p" data-a="addperson">Add someone</button></div>'+
      (rows?'<div class="tablewrap"><table><thead><tr><th>Person</th><th>Role</th><th>Status</th><th>Last seen</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div>':'<div class="empty"><b>Loading</b></div>')+
      '<div class="pb"><div class="callout"><b>Roles.</b> '+Object.keys(ROLES).map(function(k){ return '<b>'+esc(ROLES[k].name)+'</b>: '+esc(ROLES[k].hint); }).join(" ")+'</div></div></div>'+
      (S.audit.length?'<div class="panel"><div class="ph"><div><h2>Administration record</h2><p class="note">Who changed access and settings.</p></div></div><div class="pb"><div class="log">'+S.audit.map(function(a){ return '<div><b>'+esc(fmtTime(a.at))+'</b>  '+esc(a.who)+'  &middot;  '+esc(a.what)+'</div>'; }).join("")+'</div></div></div>':'');
  }
  function personSheet(){
    return sheet("Add someone",
      '<p class="sm muted">They get a one-time link to choose a password. Their role decides which screens they see.</p>'+
      '<label class="f">Name<input id="p_name" autocomplete="off"></label>'+
      '<label class="f">Work email<input id="p_email" type="email" autocomplete="off"></label>'+
      '<label class="f">Mobile, optional<input id="p_phone" autocomplete="off"></label>'+
      '<label class="f">Role<select id="p_role">'+Object.keys(ROLES).map(function(k){ return '<option value="'+k+'"'+(k==="desk"?" selected":"")+'>'+esc(ROLES[k].name)+'</option>'; }).join("")+'</select></label>'+
      '<ul class="rolehints">'+Object.keys(ROLES).map(function(k){ return '<li><b>'+esc(ROLES[k].name)+'</b> '+esc(ROLES[k].hint)+'</li>'; }).join("")+'</ul>',
      "Add and create link","saveperson");
  }
  function inviteLinkSheet(name,email,link,days){
    var body="Hello "+name+",\n\nYou have been given access to the First Security Bank Appraisal Desk. Open this link to choose your password (it works once and expires in "+days+" days):\n\n"+link+"\n\nAfter that, sign in at "+location.origin+location.pathname+" with your work email.";
    return '<div class="sheet" data-a="closesheet"><div class="sheetc" data-stop="1"><div class="stack">'+
      '<div><h2 style="font-size:17px">Sign-in link for '+esc(name)+'</h2><p class="sm muted" style="margin-top:3px">Send this to '+esc(email)+'. It works once and expires in '+days+' days. It is not shown again, but you can issue a new one at any time.</p></div>'+
      '<div class="invlink">'+esc(link)+'</div>'+
      '<div class="row"><button class="btn btn-p" data-copy="'+esc(link)+'" data-what="Link">Copy link</button>'+
      '<a class="btn" href="mailto:'+esc(encodeURIComponent(email))+'?subject='+esc(encodeURIComponent("Your FSB Appraisal Desk sign-in"))+'&body='+esc(encodeURIComponent(body))+'">Send by email</a>'+
      '<button class="btn" data-a="closesheet">Done</button></div></div></div></div>';
  }

  /* ---------- board ---------- */
  function filtered(){
    var q=S.q.toLowerCase(), f=S.filter;
    return S.orders.filter(function(o){
      if(f==="active"&&!CORE.isOpen(o)) return false;
      if(f==="attention"&&!(o.hold||o.unsent||(o.step===0)||(o.due&&o.step<6&&CORE.isOpen(o)&&o.due<nowISO().slice(0,10)))) return false;
      if(f==="delivered"&&!(o.step>=6&&!o.cancelled&&!o.declined)) return false;
      if(f==="closed"&&!(o.cancelled||o.declined||o.step===STEPS.length-1)) return false;
      if(q){ var hay=[o.addr,o.city,o.loan,o.borrowerName,o.agentName,o.type,o.id,o.officerName].join(" ").toLowerCase(); if(hay.indexOf(q)===-1) return false; }
      return true;
    });
  }
  function filtersHtml(){
    var fs=[["active","Active"],["attention","Needs attention"],["delivered","Delivered"],["closed","Closed"],["all","All"]];
    return '<div class="filters">'+fs.map(function(f){ return '<button data-filter="'+f[0]+'" aria-pressed="'+(S.filter===f[0])+'">'+f[1]+'</button>'; }).join("")+
      '<div class="search"><input id="q" placeholder="Search address, borrower, loan number" value="'+esc(S.q)+'" aria-label="Search orders"></div></div>';
  }
  function boardHtml(readonly){
    var list=filtered(), title=readonly?"Order status":"Order board";
    var head='<div class="panel"><div class="ph"><div><h2>'+title+'</h2><p class="note">'+S.orders.length+' order'+(S.orders.length===1?"":"s")+' on file. '+(readonly?"Read only: loan officers and the administrator see status and download the finished report.":"Click any row to open it.")+'</p></div>'+
      (readonly?'<span class="pill wait">View only</span>':'<button class="btn btn-p" data-a="gonew">New order</button>')+'</div><div class="pb" style="padding-bottom:0">'+filtersHtml()+'</div>';
    if(!list.length) return head+'<div class="empty"><b>'+(S.orders.length?"Nothing matches":"No orders yet")+'</b>'+(S.orders.length?"Try another filter.":(readonly?"Orders placed by the desk will appear here.":"Place the first one and it appears for everyone immediately."))+'</div></div>';
    var rows=list.map(function(o){
      var late=o.due && o.step<6 && CORE.isOpen(o) && o.due<nowISO().slice(0,10);
      return '<tr data-open="'+esc(o.id)+'"'+(o.id===S.sel?' aria-current="true"':'')+'>'+
        '<td><button class="addrbtn" data-open="'+esc(o.id)+'"><span class="addr">'+esc(o.addr)+'<small>'+esc(o.city)+'</small></span></button></td>'+
        '<td class="mono sm muted" data-label="Order">'+esc(o.id.slice(0,12))+'</td>'+
        '<td class="sm" data-label="Type">'+esc(o.type)+'</td>'+
        '<td class="sm" data-label="Borrower">'+esc(o.borrowerName||"")+'</td>'+
        '<td data-label="Status">'+rail(o)+pill(o)+(o.unsent?'<span class="pill manual" title="Messages waiting to be sent by hand">'+o.unsent+' to send</span>':'')+'</td>'+
        '<td class="mono sm'+(late?'" style="color:var(--red);font-weight:700':'')+'" data-label="Due">'+esc(fmtDate(o.due))+(late?" late":"")+'</td></tr>';
    }).join("");
    return head+'<div class="tablewrap"><table><thead><tr><th>Property</th><th>Order</th><th>Type</th><th>Borrower</th><th>Status</th><th>Due</th></tr></thead><tbody>'+rows+'</tbody></table></div></div>';
  }

  /* ---------- order detail ---------- */
  function docsHtml(o){
    var docs=o.docs||[], canUp=can("docs")&&!o.cancelled, role=S.me.role;
    var list=docs.length? docs.map(function(d){
      var kind=(DOC_KINDS[d.kind]||DOC_KINDS.other).name;
      var canDel=(role==="admin"||role==="desk"||d.uploaded_role===role);
      var canOpen=!(role==="officer"&&["report","addendum","invoice"].indexOf(d.kind)===-1);
      return '<div class="doc"><span class="ic">'+esc((d.name.split(".").pop()||"?").slice(0,4).toUpperCase())+'</span>'+
        '<span class="nm">'+esc(d.name)+'<span><span class="kind">'+esc(kind)+'</span> &middot; '+esc(kb(d.size))+' &middot; '+esc(d.uploaded_by)+' &middot; '+esc(fmtTime(d.uploaded_at))+(d.client_visible?' &middot; <b>visible to the client</b>':'')+'</span></span>'+
        '<span class="row">'+(canOpen?'<a class="btn btn-s" href="/f/'+esc(o.id)+'/'+esc(d.id)+'" download="'+esc(d.name)+'">Download</a>':'')+
        (canUp&&(d.kind==="report"||d.kind==="addendum"||role!=="officer")?'<button class="btn btn-s" data-dvis="'+esc(d.id)+'" data-to="'+(d.client_visible?"0":"1")+'" data-kind="'+esc(d.kind)+'">'+(d.client_visible?"Hide from client":"Show to client")+'</button>':'')+
        (canDel&&canUp?'<button class="btn btn-s" data-ddel="'+esc(d.id)+'" data-name="'+esc(d.name)+'">Remove</button>':'')+'</span></div>';
    }).join("") : '<p class="sm muted">No documents yet.</p>';
    var check="";
    if(o.purpose==="Purchase"&&!docs.some(function(d){return d.kind==="contract";})&&CORE.isOpen(o)) check='<div class="callout warn"><b>Sales contract missing.</b> A purchase appraisal needs the fully executed contract and any addenda. Upload it here so the appraiser is not chasing it.</div>';
    if(o.step>=5&&role==="appraiser"&&!docs.some(function(d){return d.kind==="report";})&&!o.cancelled) check+='<div class="callout"><b>Upload the report before delivering.</b> Mark it as the appraisal report and it becomes downloadable by the desk, the loan officer and, once delivered, the borrower.</div>';
    var kinds=Object.keys(DOC_KINDS).filter(function(k){ var w=DOC_KINDS[k].who; return w==="any"||w===role||(role==="admin"); });
    var up=canUp?'<div class="stack-s" style="margin-top:8px"><div class="grid2"><label class="f">This file is<select id="up_kind">'+kinds.map(function(k){ return '<option value="'+k+'"'+((role==="appraiser"&&o.step>=5&&k==="report")||(role!=="appraiser"&&k==="contract")?" selected":"")+'>'+esc(DOC_KINDS[k].name)+'</option>'; }).join("")+'</select></label>'+
      '<label class="chk" style="align-self:end;padding-bottom:10px"><input type="checkbox" id="up_vis">Visible to the borrower and agent on their status page</label></div>'+
      '<button type="button" class="drop"><b>Drop files here, or click to choose</b><span>PDF, images, XML, CSV, Word, Excel, ZIP. 20 MB each.</span>'+
      '<input type="file" class="vh" multiple accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,.csv,.txt,.md,.json,.xml,.docx,.xlsx,.zip"></button></div>':'';
    return '<div class="stack-s doclist">'+check+list+up+'</div>';
  }
  function logHtml(o){
    var l=(o.events||[]);
    if(!l.length) return '<p class="sm muted">No activity yet.</p>';
    return '<div class="log">'+l.slice().reverse().map(function(e){ return '<div><b>'+esc(fmtTime(e.at))+'</b>  '+esc(e.who)+' ('+esc(e.role)+')  &middot;  '+esc(e.what)+'</div>'; }).join("")+'</div>';
  }
  function actionsHtml(o){
    var role=S.me.role, acts=CORE.nextActions(o,role), b=[];
    acts.forEach(function(a){ b.push('<button class="btn '+(a[2]?"btn-p":"")+'" data-adv="'+a[0]+'" data-from="'+o.step+'">'+esc(a[1])+'</button>'); });
    if(role==="desk"&&!o.cancelled&&!o.declined){
      if(o.step<4) b.push('<button class="btn" data-a="editorder">Edit order</button>');
      if(o.step<6) b.push('<button class="btn" data-adv="cancel" data-from="'+o.step+'">Cancel order</button>');
      if(o.step<6) b.push('<button class="btn" data-a="reissue">Reissue client links</button>');
    }
    if(role==="admin"&&!o.cancelled&&!o.declined&&o.step<6) b.push('<button class="btn" data-adv="cancel" data-from="'+o.step+'">Cancel order</button>');
    if(role==="appraiser"&&!o.cancelled&&!o.declined&&o.step>0&&o.step<7) b.push('<button class="btn" data-a="setfee">Set fee</button>');
    if(can("note")) b.push('<button class="btn" data-a="addnote">Add internal note</button>');
    if(!b.length) return "";
    return '<div><p class="lbl" style="margin-bottom:7px">'+(role==="appraiser"?"Advance this file":"Actions")+'</p><div class="row">'+b.join("")+'</div></div>';
  }
  function detailHtml(o){
    var full=!!o.events, role=S.me.role;
    var tabs=[["status","Status"],["docs","Documents"+(full?" ("+(o.docs||[]).length+")":"")],["msgs","Messages"+(full?" ("+(o.messages||[]).length+")":"")],["log","Record"]];
    var body;
    if(!full) body='<div class="empty"><b>Loading</b></div>';
    else if(S.tab==="docs") body=docsHtml(o);
    else if(S.tab==="msgs") body='<div class="stack-s">'+((o.messages||[]).length?(o.messages||[]).slice().reverse().map(function(m){ return msgHtml(m,false); }).join(""):'<p class="sm muted">No messages yet.</p>')+'</div>';
    else if(S.tab==="log") body='<div class="stack">'+
      '<div class="callout"><b>Independence record.</b> Who ordered the file and under what role, the recusal attestation, every status change, message, document and client download, written by the server and never editable from this screen. Export it for an examiner or a reviewer.</div>'+
      logHtml(o)+'<div><a class="btn btn-s" href="/api/orders/'+esc(o.id)+'/log.txt" download>Export independence record</a></div></div>';
    else {
      var nextc="";
      if(o.cancelled) nextc='<div class="callout"><b>Cancelled.</b> '+esc(o.cancelReason||"")+'</div>';
      else if(o.declined) nextc='<div class="callout warn"><b>Declined by the appraiser.</b> Reason: '+esc(o.declinedReason||"not stated")+'. Nothing was sent to the borrower. Place a new order or route it to another appraiser.</div>';
      else if(o.hold) nextc='<div class="callout warn"><b>On hold: '+esc(o.holdReason||"")+'.</b> '+esc(o.holdNote||"")+' The borrower sees a waiting notice. Release the hold to move the file again.</div>';
      else if(o.step===0) nextc='<div class="callout"><b>Waiting on the appraiser</b> to accept or decline.</div>';
      else if(o.step===2) nextc='<div class="callout"><b>Waiting on '+esc(CORE.contactName(o))+'</b> to pick an inspection time from their link. Resend the link if they have not, or book a time for them after a phone call.</div>';
      else if(o.step===3) nextc='<div class="callout"><b>Inspection booked</b> for '+esc(fmtDay(o.apptStart))+', '+esc(fmtHr(o.apptStart))+'.</div>';
      else if(o.step===6) nextc='<div class="callout"><b>Report delivered.</b> The borrower copy '+((o.consent&&o.consent.borrower)?'was opened electronically on '+esc(fmtTime(o.consent.borrower.at))+'.':'has not been opened yet; if they do not, provide a paper copy.')+'</div>';
      body='<div class="stack">'+nextc+timelineHtml(o)+actionsHtml(o)+
        (can("ask")&&CORE.isOpen(o)?'<div class="stack-s"><p class="lbl">Ask the appraiser</p><label class="f"><textarea id="qbox" placeholder="Additional property information, a factual correction, or a timing question."></textarea></label><div><button class="btn btn-s" data-a="ask">Send to appraiser</button></div><div class="callout"><b>Value cannot be discussed.</b> Questions are limited to factual corrections and additional property information. Every message is logged on the Record tab.</div></div>':'')+
        (role==="appraiser"&&CORE.isOpen(o)?'<div class="stack-s"><p class="lbl">Reply to the desk</p><label class="f"><textarea id="rbox" placeholder="Answer a question or flag something the desk needs to know."></textarea></label><div><button class="btn btn-s" data-a="reply">Send to desk</button></div></div>':'')+
        '</div>';
    }
    var appt=o.apptStart?'<dt>Inspection</dt><dd>'+esc(fmtDay(o.apptStart))+'<br><span class="mono sm">'+esc(fmtHr(o.apptStart))+'</span></dd>':"";
    var links=(role==="desk"||role==="admin")&&o.tokB?'<div class="stack-s"><p class="lbl">Secure client links</p><p class="sm muted">One page each: status and inspection booking. No sign-in, and neither link reaches any other file. They are already inside every message to the client.</p>'+
      '<div class="row"><button class="btn btn-s" data-copy="'+esc(clientLink(o.tokB))+'" data-what="Borrower link">Copy borrower link</button>'+(o.agentName?'<button class="btn btn-s" data-copy="'+esc(clientLink(o.tokA))+'" data-what="Agent link">Copy agent link</button>':'')+'</div></div>':"";
    return '<div class="panel"><div class="ph"><div><h2>'+esc(o.addr)+'</h2>'+
      '<p class="note mono sm">'+esc(o.id.slice(0,12))+'  &middot;  Loan '+esc(o.loan||"n/a")+'  &middot;  '+esc(o.type)+'  &middot;  '+esc(o.purpose||"")+'</p></div>'+pill(o)+'</div>'+
      '<div class="detail"><div class="dm"><div class="tabs">'+tabs.map(function(t){ return '<button data-tab="'+t[0]+'" aria-selected="'+(S.tab===t[0])+'">'+esc(t[1])+'</button>'; }).join("")+'</div>'+body+'</div>'+
      '<div class="ds"><div class="stack"><dl class="kv">'+
        '<dt>Borrower</dt><dd>'+esc(o.borrowerName||"not set")+(o.borrowerPhone?'<span class="tiny mono">'+esc(o.borrowerPhone)+'</span>':"")+(o.borrowerEmail?'<span class="tiny">'+esc(o.borrowerEmail)+'</span>':"")+'</dd>'+
        '<dt>Agent</dt><dd>'+esc(o.agentName||"None")+(o.agentPhone?'<span class="tiny mono">'+esc(o.agentPhone)+'</span>':"")+(o.agentEmail?'<span class="tiny">'+esc(o.agentEmail)+'</span>':"")+'</dd>'+
        '<dt>Access</dt><dd>'+esc(o.accessVia||"Borrower")+'</dd>'+
        '<dt>Ordered by</dt><dd>'+esc(o.orderedBy||"")+'<span class="tiny">'+esc(fmtTime(o.orderedAt))+'</span></dd>'+
        (o.officerName?'<dt>Loan officer</dt><dd>'+esc(o.officerName)+(o.officerEmail?'<span class="tiny">'+esc(o.officerEmail)+'</span>':"")+'</dd>':"")+
        '<dt>Fee</dt><dd class="mono">'+(o.fee?money(o.fee):"not set")+'</dd>'+
        '<dt>Due</dt><dd class="mono">'+esc(fmtDate(o.due))+(o.rush?' <span class="flag">Rush</span>':'')+'</dd>'+appt+
        (o.appraiserName?'<dt>Appraiser</dt><dd>'+esc(o.appraiserName)+'</dd>':"")+
      '</dl>'+links+
      (o.notes?'<div class="msg"><b>Notes from the desk</b><div style="white-space:pre-wrap">'+esc(o.notes)+'</div></div>':"")+
      (o.attestation?'<div class="msg own"><b>Recusal attestation on file</b>'+esc(o.orderedBy)+' attested at order placement: "I will abstain from participating in any decision to approve, not approve, or set the terms of this transaction." Recorded '+esc(fmtTime(o.orderedAt))+'.</div>':"")+
      '</div></div></div></div>';
  }

  /* ---------- new order and edit ---------- */
  function orderForm(o,prefix){
    o=o||{}; var p=prefix;
    var g=function(k){ return esc(o[k]||""); };
    return '<div class="grid2">'+
        '<label class="f">Property address<input id="'+p+'_addr" placeholder="812 N Roosevelt Ave" value="'+g("addr")+'"></label>'+
        '<label class="f">City, state, ZIP<input id="'+p+'_city" placeholder="Bloomington, IL 61701" value="'+g("city")+'"></label></div>'+
      '<div class="grid3">'+
        '<label class="f">Loan number<input id="'+p+'_loan" placeholder="2026-004417" value="'+g("loan")+'"></label>'+
        '<label class="f">Report type'+sel(p+"_type",CORE.REPORT_TYPES,o.type||CORE.REPORT_TYPES[0])+'</label>'+
        '<label class="f">Purpose'+sel(p+"_purpose",CORE.PURPOSES,o.purpose||"Purchase")+'</label></div>'+
      '<div class="grid3">'+
        '<label class="f">Due date<input id="'+p+'_due" type="date" value="'+g("due")+'"></label>'+
        '<label class="f">Fee, if known<input id="'+p+'_fee" type="number" inputmode="decimal" placeholder="600" value="'+(o.fee?esc(o.fee):"")+'"></label>'+
        '<label class="f">Rush?<select id="'+p+'_rush"><option'+(o.rush?"":" selected")+'>No</option><option'+(o.rush?" selected":"")+'>Yes</option></select></label></div>'+
      '<p class="lbl" style="margin-top:2px">Who the appraiser contacts for access</p>'+
      '<div class="grid3">'+
        '<label class="f">Borrower name<input id="'+p+'_bname" value="'+g("borrowerName")+'"></label>'+
        '<label class="f">Borrower mobile<input id="'+p+'_bphone" inputmode="tel" placeholder="(309) 555-0148" value="'+g("borrowerPhone")+'"></label>'+
        '<label class="f">Borrower email<input id="'+p+'_bemail" type="email" inputmode="email" value="'+g("borrowerEmail")+'"></label></div>'+
      '<div class="grid3">'+
        '<label class="f">Agent name, if any<input id="'+p+'_aname" placeholder="Marcy Teague, Kestrel Realty" value="'+g("agentName")+'"></label>'+
        '<label class="f">Agent mobile<input id="'+p+'_aphone" inputmode="tel" value="'+g("agentPhone")+'"></label>'+
        '<label class="f">Agent email<input id="'+p+'_aemail" type="email" inputmode="email" value="'+g("agentEmail")+'"></label></div>'+
      '<div class="grid3">'+
        '<label class="f">Access contact'+sel(p+"_access",CORE.ACCESS,o.accessVia||"Borrower")+'</label>'+
        '<label class="f">Loan officer<input id="'+p+'_oname" value="'+g("officerName")+'"></label>'+
        '<label class="f">Loan officer email<input id="'+p+'_oemail" type="email" value="'+g("officerEmail")+'"></label></div>'+
      '<label class="f">Notes for the appraiser<textarea id="'+p+'_notes" placeholder="Tenant occupied, dog on site, gate code, anything that affects access.">'+g("notes")+'</textarea></label>';
  }
  function readOrderForm(p){
    return {addr:val(p+"_addr"),city:val(p+"_city"),loan:val(p+"_loan"),type:val(p+"_type"),purpose:val(p+"_purpose"),due:val(p+"_due"),fee:Number(val(p+"_fee"))||0,rush:val(p+"_rush")==="Yes",
      borrowerName:val(p+"_bname"),borrowerPhone:val(p+"_bphone"),borrowerEmail:val(p+"_bemail"),agentName:val(p+"_aname"),agentPhone:val(p+"_aphone"),agentEmail:val(p+"_aemail"),
      accessVia:val(p+"_access"),officerName:val(p+"_oname"),officerEmail:val(p+"_oemail"),notes:val(p+"_notes")};
  }
  function newOrderHtml(){
    return '<div class="panel"><div class="ph"><div><h2>New order</h2><p class="note">One page, not a wizard. The appraiser is notified the moment you place it. You can edit it until the inspection happens, and cancel it until the report is delivered.</p></div>'+
      '<button class="btn btn-s" data-a="goboard">Cancel</button></div>'+
      '<div class="pb"><div class="stack">'+orderForm(null,"n")+
      '<label class="att" for="n_att"><input type="checkbox" id="n_att"><span class="t"><b>Required before this order can be placed</b>I will abstain from participating in any decision to approve, not approve, or set the terms of this transaction. This attestation is timestamped, tied to my account, and cannot be edited afterward.</span></label>'+
      '<div class="row"><button class="btn btn-p" data-a="createorder">Place order</button><span class="sm muted">Upload the sales contract on the Documents tab once the order exists.</span></div>'+
      '</div></div></div>';
  }

  /* ---------- appraiser queue ---------- */
  function queueHtml(){
    var o=current();
    var list=filtered();
    var cards=list.length? list.map(function(x){
      return '<div class="qcard'+(x.step===0&&!x.declined?" hot":"")+'"><div class="addr">'+esc(x.addr)+'<small>'+esc(x.city)+' &middot; '+esc(x.type)+' &middot; due '+esc(fmtDate(x.due))+(x.apptStart?(' &middot; inspection '+esc(fmtDay(x.apptStart))+' '+esc(fmtHr(x.apptStart))):'')+'</small></div>'+
        '<div class="row">'+pill(x)+'<button class="btn btn-s" data-open="'+esc(x.id)+'">Open</button></div></div>';
    }).join("") : '<div class="empty"><b>'+(S.orders.length?"Nothing matches":"Nothing in the queue")+'</b>'+(S.orders.length?"Try another filter.":"Orders placed by the desk arrive here, and you get an email.")+'</div>';
    var head='<div class="panel"><div class="ph"><div><h2>My queue</h2><p class="note">Your side of the same data. One click moves a file forward and everyone sees it.</p></div></div>'+
      '<div class="pb">'+filtersHtml()+'<div class="stack-s">'+cards+'</div></div></div>';
    return head+(o?detailHtml(o):"");
  }

  /* ---------- availability ---------- */
  function availHtml(){
    var c=S.config||CORE.defaultConfig(), dayNames=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    var slots=S.slotPreview||[];
    return '<div class="panel"><div class="ph"><div><h2>Availability and contact</h2><p class="note">How the appraiser appears to borrowers and agents, and the rules that generate the times they are offered. Nothing inside the lead time is ever shown.</p></div>'+
      '<button class="btn btn-p btn-s" data-a="saveavail">Save</button></div>'+
      '<div class="pb"><div class="stack">'+
      '<div><p class="lbl" style="margin-bottom:7px">How the appraiser appears to borrowers and agents</p><div class="grid3">'+
        '<label class="f">Name shown on messages<input id="c_aname" placeholder="Leave blank to show \'your appraiser\'" value="'+esc(c.appraiserName||"")+'"></label>'+
        '<label class="f">Callback number<input id="c_aphone" inputmode="tel" placeholder="Leave blank to point them at the bank" value="'+esc(c.appraiserPhone||"")+'"></label>'+
        '<label class="f">Appraiser email for notices<input id="c_aemail" type="email" placeholder="Used if no appraiser account exists" value="'+esc(c.appraiserEmail||"")+'"></label></div>'+
      '<p class="sm muted" style="margin-top:7px">First Security Bank is always the sender. This is the person a borrower reaches about access and timing.</p></div>'+
      '<div><p class="lbl" style="margin-bottom:7px">Days worked</p><div class="row">'+dayNames.map(function(n,i){ var on=(c.days||[]).indexOf(i)>-1; return '<button class="btn btn-s'+(on?" btn-p":"")+'" data-day="'+i+'" aria-pressed="'+on+'">'+n+'</button>'; }).join("")+'</div></div>'+
      '<div class="grid3">'+
        '<label class="f">Day starts (hour, 8.5 = 8:30)<input id="c_start" type="number" inputmode="decimal" step="0.5" min="5" max="12" value="'+esc(c.startHour)+'"></label>'+
        '<label class="f">Day ends<input id="c_end" type="number" inputmode="decimal" step="0.5" min="12" max="21" value="'+esc(c.endHour)+'"></label>'+
        '<label class="f">Inspection length, minutes<input id="c_slot" type="number" inputmode="numeric" step="15" min="15" max="240" value="'+esc(c.slotMinutes)+'"></label></div>'+
      '<div class="grid2">'+
        '<label class="f">Travel buffer, minutes<input id="c_buf" type="number" inputmode="numeric" step="15" min="0" max="180" value="'+esc(c.bufferMinutes)+'"></label>'+
        '<label class="f">Earliest booking, hours from now<input id="c_lead" type="number" inputmode="numeric" step="1" min="0" max="168" value="'+esc(c.leadHours)+'"></label></div>'+
      '<div><p class="lbl" style="margin-bottom:7px">Days off</p><div>'+(c.daysOff||[]).map(function(d){ return '<span class="dayoff">'+esc(fmtDate(d))+' <button type="button" data-dayoff="'+esc(d)+'" aria-label="Remove day off">&times;</button></span>'; }).join("")+'</div>'+
        '<div class="row" style="margin-top:6px"><input id="c_off" type="date" style="max-width:200px"><button class="btn btn-s" data-a="adddayoff">Add day off</button></div></div>'+
      '<div class="callout nav"><b>Next six open times these rules produce, after saving</b>'+(slots.length?slots.map(function(s){ return fmtDay(s)+", "+fmtHr(s); }).join(" &middot; "):"None. Widen the days or hours.")+'</div>'+
      '</div></div></div>';
  }

  /* ---------- outbox ---------- */
  function outboxHtml(){
    var fs=[["manual","Needs sending"],["queued","Sending"],["sent","Sent"],["failed","Failed"],["portal","Staff notices"],["all","All"]];
    var prov='<div class="callout'+(S.providers.email?"":" warn")+'"><b>Email: '+(S.providers.email?"sending automatically.":"not connected yet.")+'</b> '+(S.providers.email?"Queued messages go out within a few seconds and retry for up to half an hour if the mail service is down.":"Until the mail service key is added, every email below has an \"Open in email app\" button that drafts it in Outlook or Gmail for you; press send there, then mark it sent here.")+
      ' <b>Texts: '+(S.providers.sms?"sending automatically.":"by hand.")+'</b> '+(S.providers.sms?"":"US carriers require A2P 10DLC registration before software can text; until that clears, \"Open in Messages\" drafts the text on a phone.")+
      (S.providers.email?"":" Notices to bank staff and the appraiser are not queued while email is off, because everyone sees the same live board; they sit under Staff notices for the record.")+'</div>';
    return '<div class="panel"><div class="ph"><div><h2>Outbox</h2><p class="note">Every email and text the system composes, with its real wording and where it stands. Nothing here is hidden from you.</p></div></div>'+
      '<div class="pb">'+prov+'<div class="filters">'+fs.map(function(f){ return '<button data-mfilter="'+f[0]+'" aria-pressed="'+(S.mfilter===f[0])+'">'+f[1]+'</button>'; }).join("")+'</div>'+
      (S.messages.length?'<div class="stack-s">'+S.messages.map(function(m){ return msgHtml(m,true); }).join("")+'</div>':'<div class="empty"><b>Nothing here</b>'+(S.mfilter==="manual"?"Every message has been sent.":"")+'</div>')+
      '</div></div>';
  }

  /* ---------- feedback ---------- */
  function feedbackHtml(){
    var items=S.feedback;
    return '<div class="panel"><div class="ph"><div><h2>Feedback</h2><p class="note">Everything anyone has flagged, newest first. Use the red button on any screen to add to it.</p></div>'+
      '<button class="btn btn-p btn-s" data-a="openfb">Add feedback</button></div>'+
      '<div class="pb">'+(items.length?'<div class="stack-s">'+items.map(function(f){ return '<div class="msg'+(f.kind==="Bug"?" sms":"")+'"><b>'+esc(f.kind)+' &middot; '+esc(f.screen)+(f.order_ref?(' &middot; '+esc(f.order_ref)):'')+' &middot; '+esc(f.who)+' &middot; '+esc(fmtTime(f.at))+'</b><div style="white-space:pre-wrap">'+esc(f.text)+'</div></div>'; }).join("")+'</div>':'<div class="empty"><b>No feedback yet</b>Say what is wrong, what is missing, and what you would never use.</div>')+'</div></div>';
  }
  function feedbackSheet(){
    var screens={board:"Order board",new:"New order",queue:"Appraiser queue",avail:"Availability",outbox:"Outbox",feedback:"Feedback",people:"People"};
    var o=current();
    return sheet("Tell us what is wrong",
      '<p class="sm muted">Be blunt. "I would never use this" is the most useful thing you can write.</p>'+
      '<label class="f">What kind<select id="fb_kind"><option>Missing something</option><option>Confusing</option><option>Bug</option><option>Would not use</option><option>Idea</option></select></label>'+
      '<label class="f">Your note<textarea id="fb_text" placeholder="What were you trying to do, and what got in the way?"></textarea></label>'+
      '<p class="sm muted">Recorded against: <b>'+esc(screens[S.view]||S.view)+'</b>'+(o?(" &middot; "+esc(o.addr)):"")+'</p>',
      "Send","sendfb");
  }

  /* ---------- client page ---------- */
  function slotCal(slots){
    var days=[], map={};
    (slots||[]).forEach(function(iso){ var k=fmtDay(iso); if(!map[k]){ map[k]=[]; days.push(k); } map[k].push(iso); });
    if(!days.length) return '<p class="sm muted">No times are open right now. Use the button below and the appraiser will call you.</p>';
    return days.slice(0,6).map(function(k){ return '<div class="calday"><p class="lbl">'+esc(k)+'</p><div class="caltimes">'+map[k].map(function(iso){ return '<button class="slot slot-t" data-slot="'+esc(iso)+'">'+esc(fmtHr(iso))+'</button>'; }).join("")+'</div></div>'; }).join("");
  }
  function clientPageHtml(){
    var c=S.client;
    if(!c) return '<div class="clientwrap"><div class="panel"><div class="empty"><b>Loading your appraisal</b>One moment.</div></div></div>';
    if(c.error) return '<div class="clientwrap"><div class="panel"><div class="empty"><b>This link is not valid</b>It may have expired, or the file may be closed. Call your loan officer at First Security Bank and they can send you a new one.</div></div></div>';
    var isAgent=c.party==="agent", aprName=c.appraiser.name||"The appraiser", slotM=c.slotMinutes||60;
    var contact=c.appraiser.phone?("Questions? Call "+(c.appraiser.name||"the appraiser")+" at "+c.appraiser.phone+"."):"Questions? Contact your loan officer at First Security Bank.";
    var vst=STEPS.map(function(st,i){ var cls=i<c.step?"done":(i===c.step?"now":""); return '<li class="'+cls+'"><span class="nd">'+(i<c.step?"&#10003;":"")+'</span><span class="t">'+esc(CLIENT_LABEL[st])+'</span></li>'; }).join("");
    var action;
    if(c.cancelled) action='<div class="nextc"><h4>No longer needed</h4><p>First Security Bank has closed this appraisal request. Nothing is needed from you.</p></div>';
    else if(c.declined) action='<div class="nextc"><h4>With the bank</h4><p>First Security Bank is arranging your appraisal. Nothing is needed from you right now.</p></div>';
    else if(c.hold) action='<div class="nextc"><h4>Waiting on property access</h4><p>'+esc(aprName)+' needs access arranged before the inspection can happen. Nothing is needed from you right now.</p></div>';
    else if(c.step===2) action='<div class="stack-s"><h4 class="calhead">Choose your inspection time</h4><p class="sm muted" style="margin-bottom:2px">About '+esc(slotM)+' minutes. Pick whatever suits you.</p>'+slotCal(c.slots)+'<button class="btn btn-s" data-a="noslot" style="margin-top:8px">None of these work for me</button></div>';
    else if(c.step===3) action='<div class="nextc"><h4>Your inspection is booked</h4><p class="mono" style="color:var(--ink);font-weight:700;font-size:14px;margin:5px 0 7px">'+esc(fmtDay(c.apptStart))+', '+esc(fmtHr(c.apptStart))+'</p>'+
        '<p>'+esc(aprName)+' will need to see every room, the basement, the attic access and the garage, and will photograph each room. About '+esc(slotM)+' minutes.</p>'+
        '<p class="sm muted" style="margin-top:7px">This is not a home inspection, and nothing needs tidying. It does not affect the value.</p>'+
        '<div class="row" style="margin-top:10px"><a class="btn btn-s" href="/api/client/'+esc(S.token)+'/appointment.ics" download="appraisal-inspection.ics">Add to calendar</a><button class="btn btn-s" data-a="reschedule">Change this time</button></div></div>';
    else if(c.step>=6) action='<div class="nextc"><h4>Your appraisal is ready</h4><p>A copy is available to you at no charge.</p>'+
        (c.report?(c.consent?'<div style="margin-top:10px"><a class="btn btn-p btn-s" href="/f/'+esc(c.orderId)+'/'+esc(c.report.id)+'?t='+esc(S.token)+'" download="'+esc(c.report.name)+'">Download my copy</a></div>'
          :'<div class="stack-s" style="margin-top:10px"><label class="chk"><input type="checkbox" id="consent">I agree to receive my appraisal copy electronically through this page instead of on paper. I can ask First Security Bank for a paper copy at no charge at any time.</label><div><button class="btn btn-p btn-s" data-a="consent">Continue to my copy</button></div></div>')
          :'<p class="sm muted" style="margin-top:8px">Your loan officer will provide your copy.</p>')+'</div>';
    else if(c.step<=1) action='<div class="nextc"><h4>Nothing to do yet</h4><p>'+esc(aprName)+' will send a link to choose an inspection time. You will get a text and an email.</p></div>';
    else action='<div class="nextc"><h4>Nothing to do right now</h4><p>Your report is being prepared. You will hear from First Security Bank when it is delivered.</p></div>';
    return '<div class="clientwrap"><div class="panel"><div class="pb">'+
      '<p class="lbl">Appraisal status'+(isAgent?' &middot; listing agent':'')+'</p><h2 style="font-size:19px;margin-top:3px">'+esc(c.addr)+'</h2><p class="sm muted">'+esc(c.city)+'</p>'+
      '<ul class="vst" style="margin-top:14px">'+vst+'</ul><div style="margin-top:14px">'+action+'</div>'+
      '<p class="sm muted" style="margin-top:16px;line-height:1.5">'+esc(contact)+' This link is personal to '+esc(c.who)+' and stops working when the file closes.</p>'+
      '</div></div><p class="sm muted" style="text-align:center;margin-top:12px">First Security Bank &middot; Mackinaw, Heritage Lake, Deer Creek, Danvers</p></div>';
  }

  /* ---------- render ---------- */
  function connChip(){ return ''; }
  function render(){
    var stage=$("stage"), nav=$("views"), who=$("whochip"), fbtn=$("fbtn");
    var band=document.querySelector(".band"), mast=document.querySelector(".mast"), foot=document.querySelector("footer");
    if(S.token){
      band.hidden=true; mast.hidden=true; foot.hidden=true; nav.innerHTML=""; who.innerHTML=""; fbtn.hidden=true;
      stage.innerHTML=clientPageHtml(); return;
    }
    band.hidden=false; mast.hidden=false; foot.hidden=false;
    if(S.inviteCode){ nav.innerHTML='<button role="tab" aria-selected="true" disabled>Welcome</button>'; who.innerHTML=""; fbtn.hidden=true; stage.innerHTML=inviteHtml(); return; }
    if(!S.me){
      nav.innerHTML='<button role="tab" aria-selected="true" disabled>Sign in</button>'; who.innerHTML=""; fbtn.hidden=true;
      stage.innerHTML=S.setupNeeded?setupHtml():signinHtml();
      var f=stage.querySelector("input"); if(f&&S.boot==="ready") try{ f.focus(); }catch(e){}
      return;
    }
    fbtn.hidden=false;
    who.innerHTML='<button class="chip act" data-a="menu" aria-haspopup="true" aria-expanded="'+S.menu+'"><b>'+esc(S.me.name)+'</b> &middot; '+esc((ROLES[S.me.role]||{}).name||S.me.role)+'</button>'+
      (S.menu?'<div class="menu" data-stop="1"><button data-a="changepw">Change my password</button><button data-a="signout">Sign out</button></div>':'');
    nav.innerHTML=navFor(S.me.role).map(function(i){ return '<button role="tab" data-v="'+i[0]+'" aria-selected="'+(S.view===i[0])+'">'+esc(i[1])+'</button>'; }).join("");

    var v=S.view, html="";
    if(v==="feedback") html=feedbackHtml();
    else if(v==="outbox") html=outboxHtml();
    else if(v==="new") html=newOrderHtml();
    else if(v==="avail") html=availHtml();
    else if(v==="queue") html=queueHtml();
    else if(v==="people") html=peopleHtml();
    else { html=boardHtml(S.me.role!=="desk"); var o=current(); if(o) html+=detailHtml(o); }

    var keep={}, focusId=null, selStart=null, selEnd=null;
    try{
      var ae=document.activeElement;
      if(ae&&ae.id&&stage.contains(ae)){ focusId=ae.id; if(ae.selectionStart!=null){ selStart=ae.selectionStart; selEnd=ae.selectionEnd; } }
      stage.querySelectorAll("input,select,textarea").forEach(function(el){ if(!el.id) return; keep[el.id]=(el.type==="checkbox"||el.type==="radio")?el.checked:el.value; });
    }catch(e){}
    stage.innerHTML=html;
    try{
      Object.keys(keep).forEach(function(id){ var el=stage.querySelector("#"+CSS.escape(id)); if(!el) return; if(el.type==="checkbox"||el.type==="radio") el.checked=keep[id]; else if(keep[id]!=="") el.value=keep[id]; });
      if(focusId){ var f2=stage.querySelector("#"+CSS.escape(focusId)); if(f2){ f2.focus(); if(selStart!=null&&f2.setSelectionRange) try{ f2.setSelectionRange(selStart,selEnd); }catch(e2){} } }
    }catch(e){}
    wireDrop();
  }

  /* ---------- uploads ---------- */
  function wireDrop(){
    document.querySelectorAll(".drop").forEach(function(drop){
      var input=drop.querySelector('input[type="file"]'); if(!input) return;
      drop.addEventListener("click",function(e){ if(e.target!==input) input.click(); });
      input.addEventListener("change",function(){ handleFiles(input.files); input.value=""; });
      ["dragenter","dragover"].forEach(function(t){ drop.addEventListener(t,function(e){e.preventDefault();drop.classList.add("over");}); });
      ["dragleave","drop"].forEach(function(t){ drop.addEventListener(t,function(e){e.preventDefault();drop.classList.remove("over");}); });
      drop.addEventListener("drop",function(e){ if(e.dataTransfer&&e.dataTransfer.files) handleFiles(e.dataTransfer.files); });
    });
  }
  function handleFiles(files){
    var o=current(); if(!o){ toast("Open an order first."); return; }
    var list=Array.prototype.slice.call(files||[]); if(!list.length) return;
    var kind=val("up_kind")||"other", vis=$("up_vis")&&$("up_vis").checked;
    var fd=new FormData(); fd.append("kind",kind); fd.append("clientVisible",vis?"1":"0");
    list.forEach(function(f){ fd.append("file",f,f.name); });
    toast("Uploading "+list.length+" file"+(list.length===1?"":"s")+".");
    api("POST","/api/orders/"+encodeURIComponent(o.id)+"/docs",fd,true).then(function(d){
      S.detail[o.id]=d.order; upsert(d.order); render(); toast(list.length+" file"+(list.length===1?"":"s")+" attached.");
    }).catch(function(e){ fail(e); loadDetail(o.id).catch(function(){}); });
  }

  /* ---------- actions ---------- */
  function act(o,action,params,from){
    if(S.busy) return Promise.resolve();
    S.busy=true;
    return api("POST","/api/orders/"+encodeURIComponent(o.id)+"/actions",{action:action,params:params||{},from:from}).then(function(d){
      S.detail[o.id]=d.order; upsert(d.order); modal(""); render();
      var manual=(d.queued||[]).filter(function(q){ return q.status==="manual"; }).length;
      toast("<b>"+esc(d.reply)+"</b>"+(manual?(" "+manual+" message"+(manual===1?"":"s")+" waiting in the Outbox to be sent by hand."):""));
    }).catch(function(e){
      fail(e);
      if(e.status===409||e.status===404) loadDetail(o.id).catch(function(){});
    }).then(function(){ S.busy=false; });
  }
  function advance(o,a,from){
    if(a==="hold") return modal(sheet("Place this file on hold",
      '<p class="sm muted">The desk is emailed the reason. The borrower sees a waiting notice, nothing more.</p>'+
      '<label class="f">Reason'+sel("h_reason",CORE.HOLD_REASONS,CORE.HOLD_REASONS[0])+'</label>'+
      '<label class="f">Detail, optional<textarea id="h_note" placeholder="What has to happen before it can move again?"></textarea></label>',
      "Place on hold","dohold",' data-from="'+from+'"'));
    if(a==="decline") return modal(sheet("Decline this order",
      '<p class="sm muted">The desk is told today so they can re-route it. Nothing goes to the borrower.</p>'+
      '<label class="f">Reason'+sel("d_reason",CORE.DECLINE_REASONS,CORE.DECLINE_REASONS[0])+'</label>'+
      '<label class="f">Detail, optional<textarea id="d_note"></textarea></label>',
      "Decline","dodecline",' data-from="'+from+'"'));
    if(a==="cancel") return modal(sheet("Cancel this order",
      '<p class="sm muted">The appraiser is told to stop work'+(o.clientContacted?', and the client is told nothing further is needed.':'.')+' This cannot be undone; place a new order if the loan comes back.</p>'+
      '<label class="f">Reason'+sel("x_reason",CORE.CANCEL_REASONS,CORE.CANCEL_REASONS[0])+'</label>'+
      '<label class="f">Detail, optional<textarea id="x_note"></textarea></label>',
      "Cancel the order","docancel",' data-from="'+from+'"'));
    if(a==="accept") return modal(sheet("Accept this order",
      '<p class="sm muted">The desk is notified, and the borrower gets their status link by text and email'+(o.fee?'':'; set the fee now if you know it')+'.</p>'+
      '<label class="f">Fee<input id="a_fee" type="number" inputmode="decimal" value="'+(o.fee||"")+'" placeholder="Leave blank to set later"></label>'+
      (o.due?'<p class="sm">Due <b>'+esc(fmtDate(o.due))+'</b>'+(o.rush?' <span class="flag">Rush</span>':'')+'. If that is not workable, decline with the reason instead.</p>':''),
      "Accept order","doaccept",' data-from="'+from+'"'));
    if(a==="book"){
      var local=new Date(Date.now()+864e5); local.setMinutes(0,0,0);
      return modal(sheet("Book a time for "+CORE.contactName(o),
        '<p class="sm muted">Use this after arranging a time by phone. The client gets a confirmation with a calendar file, the same as if they had picked it themselves. Times are in the bank\'s time zone.</p>'+
        '<label class="f">Inspection date and time<input id="b_when" type="datetime-local" step="900"></label>',
        "Book it","dobook",' data-from="'+from+'"'));
    }
    if(a==="deliver") return act(o,"deliver",{},from).catch(function(){});
    if(a==="invoice") return modal(sheet("Send the invoice",
      '<p class="sm muted">Upload the invoice on the Documents tab first if you have it as a file. The desk is emailed either way.</p>'+
      '<label class="f">Amount<input id="i_fee" type="number" inputmode="decimal" value="'+(o.fee||"")+'"></label>',
      "Send invoice","doinvoice",' data-from="'+from+'"'));
    if(a==="reschedule"&&o.apptStart) { if(!confirm("Cancel the inspection set for "+fmtDay(o.apptStart)+" at "+fmtHr(o.apptStart)+"? The client will be asked to pick a new time.")) return; }
    return act(o,a,{},from);
  }
  function createOrder(){
    var b=readOrderForm("n");
    if(!b.addr){ toast("A property address is required."); return; }
    if(!$("n_att").checked){ toast("The recusal attestation is required before an order can be placed."); return; }
    b.attestation=true;
    if(S.busy) return; S.busy=true;
    api("POST","/api/orders",b).then(function(d){
      var o=d.order; S.detail[o.id]=null; delete S.detail[o.id]; upsert(o); S.sel=o.id; S.view="board"; S.tab="docs";
      return loadDetail(o.id).then(function(){ toast("Order placed. <b>Upload the contract on the Documents tab.</b>"+(S.providers.email?"":" The appraiser's notice is waiting in the Outbox.")); });
    }).catch(fail).then(function(){ S.busy=false; });
  }
  function saveAvail(){
    var c=S.config||CORE.defaultConfig();
    var body={days:c.days||[],daysOff:c.daysOff||[],startHour:Number(val("c_start"))||8.5,endHour:Number(val("c_end"))||16,slotMinutes:Number(val("c_slot"))||60,
      bufferMinutes:Number(val("c_buf"))||0,leadHours:Number(val("c_lead"))||0,appraiserName:val("c_aname"),appraiserPhone:val("c_aphone"),appraiserEmail:val("c_aemail")};
    api("PUT","/api/config",body).then(function(d){ S.config=d.config; return refreshView(); }).then(function(){ toast("Availability saved."); }).catch(fail);
  }
  function pickSlot(iso){
    api("POST","/api/client/"+encodeURIComponent(S.token)+"/book",{slot:iso}).then(function(d){ toast("<b>"+esc(d.reply)+"</b>"); return loadClient(); })
      .catch(function(e){ fail(e); loadClient(); });
  }
  function copyText(text,what){
    var done=function(){ toast((what||"Text")+" copied."); };
    if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(text).then(done).catch(function(){ window.prompt("Copy this:",text); }); }
    else window.prompt("Copy this:",text);
  }
  function submitSignin(){
    var email=val("si_email"), pw=($("si_pw")||{}).value||"";
    if(!email||!pw){ toast("Email and password, please."); return; }
    if(S.busy) return; S.busy=true;
    api("POST","/api/login",{email:email,password:pw}).then(function(d){ return api("GET","/api/session").then(function(sd){ afterSignIn(d.user,sd); }); })
      .catch(fail).then(function(){ S.busy=false; });
  }

  /* ---------- events ---------- */
  document.addEventListener("submit",function(e){
    if(e.target.id==="signinForm"){ e.preventDefault(); submitSignin(); }
    if(e.target.id==="inviteForm"){ e.preventDefault(); acceptInvite(); }
  });
  function acceptInvite(){
    var pw=($("iv_pw")||{}).value||"", pw2=($("iv_pw2")||{}).value||"";
    if(pw.length<10){ toast("Use at least 10 characters."); return; }
    if(pw!==pw2){ toast("The two passwords do not match."); return; }
    if(S.busy) return; S.busy=true;
    api("POST","/api/invite/accept",{code:S.inviteCode,password:pw}).then(function(d){
      S.inviteCode=null; S.invite=null; history.replaceState(null,"",location.pathname);
      return api("GET","/api/session").then(function(sd){ afterSignIn(d.user,sd); toast("Welcome, <b>"+esc(d.user.name)+"</b>."); });
    }).catch(fail).then(function(){ S.busy=false; });
  }
  document.addEventListener("input",function(e){ if(e.target&&e.target.id==="q"){ S.q=e.target.value; render(); } });
  document.addEventListener("keydown",function(e){ if(e.key==="Escape"){ if($("modal").innerHTML){ modal(""); } if(S.menu){ S.menu=false; render(); } } });

  document.addEventListener("click",function(e){
    var t=e.target.closest("[data-stop],[data-a],[data-v],[data-open],[data-tab],[data-adv],[data-slot],[data-day],[data-dayoff],[data-copy],[data-filter],[data-mfilter],[data-msent],[data-mretry],[data-uinvite],[data-uactive],[data-dvis],[data-ddel]");
    if(S.menu&&!(t&&t.dataset.a==="menu")&&!(t&&t.dataset.stop)){ S.menu=false; render(); if(!t) return; t=e.target.closest("[data-a],[data-v],[data-open],[data-tab],[data-adv],[data-slot],[data-day],[data-dayoff],[data-copy],[data-filter],[data-mfilter],[data-msent],[data-mretry],[data-uinvite],[data-uactive],[data-dvis],[data-ddel]"); if(!t) return; }
    if(!t) return;
    if(t.dataset.stop&&!t.dataset.a) return;
    var a=t.dataset.a, o=current();
    if(t.dataset.v){ S.view=t.dataset.v; S.menu=false; render(); refreshView(); return; }
    if(t.dataset.open){ S.sel=t.dataset.open; S.tab="status"; if(S.me.role==="appraiser") S.view="queue"; render(); if(!S.detail[S.sel]) loadDetail(S.sel).catch(fail); else { var el=document.querySelector(".detail"); if(el&&window.innerWidth<900) el.scrollIntoView({behavior:"smooth"}); } return; }
    if(t.dataset.tab){ S.tab=t.dataset.tab; render(); return; }
    if(t.dataset.filter){ S.filter=t.dataset.filter; render(); return; }
    if(t.dataset.mfilter){ S.mfilter=t.dataset.mfilter; loadMessages().then(render).catch(fail); return; }
    if(t.dataset.slot){ pickSlot(t.dataset.slot); return; }
    if(t.dataset.copy!==undefined){ copyText(t.dataset.copy,t.dataset.what); return; }
    if(t.dataset.day!==undefined){ var c=S.config||CORE.defaultConfig(); var d=Number(t.dataset.day); c.days=c.days||[]; var i=c.days.indexOf(d); if(i>-1) c.days.splice(i,1); else c.days.push(d); c.days.sort(); S.config=c; render(); return; }
    if(t.dataset.dayoff){ var c2=S.config; c2.daysOff=(c2.daysOff||[]).filter(function(x){ return x!==t.dataset.dayoff; }); render(); return; }
    if(t.dataset.msent){ api("POST","/api/messages/"+encodeURIComponent(t.dataset.msent)+"/mark",{status:"sent"}).then(function(){ toast("Marked as sent."); return o&&S.view!=="outbox"?loadDetail(o.id):loadMessages().then(render); }).then(function(){ if(o) loadDetail(o.id).catch(function(){}); }).catch(fail); return; }
    if(t.dataset.mretry){ api("POST","/api/messages/"+encodeURIComponent(t.dataset.mretry)+"/retry",{}).then(function(){ toast("Retrying."); return loadMessages().then(render); }).catch(fail); return; }
    if(t.dataset.uinvite){ var u=S.users.filter(function(x){return x.id===t.dataset.uinvite;})[0]; api("POST","/api/users/"+encodeURIComponent(t.dataset.uinvite)+"/invite",{}).then(function(d){ modal(inviteLinkSheet(u.name,u.email,d.inviteLink,d.expiresDays)); return loadUsers(); }).then(render).catch(fail); return; }
    if(t.dataset.uactive){ var to=t.dataset.to==="1"; api("PATCH","/api/users/"+encodeURIComponent(t.dataset.uactive),{active:to}).then(function(){ toast(to?"Restored.":"Suspended. Their sessions were ended."); return loadUsers(); }).then(render).catch(fail); return; }
    if(t.dataset.dvis){ api("PATCH","/api/orders/"+encodeURIComponent(o.id)+"/docs/"+encodeURIComponent(t.dataset.dvis),{clientVisible:t.dataset.to==="1",kind:t.dataset.kind}).then(function(){ return loadDetail(o.id); }).catch(fail); return; }
    if(t.dataset.ddel){ if(!confirm("Remove "+t.dataset.name+" from this order? It stays in storage for the record.")) return; api("DELETE","/api/orders/"+encodeURIComponent(o.id)+"/docs/"+encodeURIComponent(t.dataset.ddel)).then(function(){ toast("Removed."); return loadDetail(o.id); }).catch(fail); return; }
    if(t.dataset.adv){ if(!o){ toast("Open an order first."); return; } var from=Number(t.dataset.from); if(from!==o.step){ toast("This order already moved to <b>"+esc(status(o))+"</b>."); loadDetail(o.id).catch(function(){}); return; } advance(o,t.dataset.adv,from); return; }

    if(a==="menu"){ S.menu=!S.menu; render(); return; }
    if(a==="closesheet"){ modal(""); return; }
    if(a==="retry"){ S.boot="loading"; render(); boot(); return; }
    if(a==="setup"){ if(S.busy) return; S.busy=true; api("POST","/api/setup",{name:val("su_name"),email:val("su_email"),password:($("su_pw")||{}).value||"",setupKey:val("su_key")}).then(function(d){ S.setupNeeded=false; return api("GET","/api/session").then(function(sd){ afterSignIn(d.user,sd); toast("Welcome. <b>Add your people on this tab.</b>"); }); }).catch(fail).then(function(){ S.busy=false; }); return; }
    if(a==="signin"){ submitSignin(); return; }
    if(a==="acceptinvite"){ acceptInvite(); return; }
    if(a==="signout"){ api("POST","/api/logout",{}).catch(function(){}).then(function(){ S.me=null; S.sel=null; S.orders=[]; S.detail={}; S.menu=false; S.lastSync=""; render(); }); return; }
    if(a==="changepw"){ modal(sheet("Change my password",'<label class="f">Current password<input id="cp_cur" type="password" autocomplete="current-password"></label><label class="f">New password (10 characters or more)<input id="cp_new" type="password" autocomplete="new-password"></label>',"Change","dochangepw")); return; }
    if(a==="dochangepw"){ api("POST","/api/password",{current:($("cp_cur")||{}).value||"",next:($("cp_new")||{}).value||""}).then(function(){ modal(""); toast("Password changed."); }).catch(fail); return; }
    if(a==="addperson"){ modal(personSheet()); return; }
    if(a==="saveperson"){ var pn=val("p_name"), pe=val("p_email"), pr=val("p_role"), pp=val("p_phone"); if(!pn||!pe){ toast("Name and email are required."); return; }
      api("POST","/api/users",{name:pn,email:pe,role:pr,phone:pp}).then(function(d){ modal(inviteLinkSheet(pn,pe,d.inviteLink,d.expiresDays)); return loadUsers(); }).then(render).catch(fail); return; }
    if(a==="gonew"){ S.view="new"; render(); return; }
    if(a==="goboard"){ S.view="board"; render(); return; }
    if(a==="createorder"){ createOrder(); return; }
    if(a==="saveavail"){ saveAvail(); return; }
    if(a==="adddayoff"){ var dv=val("c_off"); if(!/^\d{4}-\d{2}-\d{2}$/.test(dv)){ toast("Pick a date first."); return; } S.config.daysOff=S.config.daysOff||[]; if(S.config.daysOff.indexOf(dv)===-1) S.config.daysOff.push(dv); S.config.daysOff.sort(); render(); return; }
    if(a==="openfb"){ modal(feedbackSheet()); return; }
    if(a==="sendfb"){ var txt=val("fb_text"); if(!txt){ toast("Write a note first."); return; } api("POST","/api/feedback",{kind:val("fb_kind"),text:txt,screen:S.view,order:o?o.addr:""}).then(function(){ modal(""); toast("Thank you. <b>It is on the Feedback tab.</b>"); if(S.view==="feedback") return loadFeedback().then(render); }).catch(fail); return; }
    if(a==="ask"){ if(!o) return; var q=val("qbox"); if(!q){ toast("Write a question first."); return; } act(o,"ask",{text:q}).then(function(){ var b=$("qbox"); if(b) b.value=""; }); return; }
    if(a==="reply"){ if(!o) return; var rq=val("rbox"); if(!rq){ toast("Write a reply first."); return; } act(o,"reply",{text:rq}); return; }
    if(a==="addnote"){ modal(sheet("Internal note",'<p class="sm muted">Goes on the record, not to the borrower.</p><label class="f">Note<textarea id="nt_text"></textarea></label>',"Add note","donote")); return; }
    if(a==="donote"){ if(!o) return; var nt=val("nt_text"); if(!nt){ toast("Write a note first."); return; } act(o,"note",{text:nt}); return; }
    if(a==="setfee"){ modal(sheet("Set the fee",'<label class="f">Fee<input id="f_fee" type="number" inputmode="decimal" value="'+(o&&o.fee||"")+'"></label>',"Save","dofee")); return; }
    if(a==="dofee"){ if(!o) return; act(o,"fee",{fee:Number(val("f_fee"))||0}); return; }
    if(a==="editorder"){ if(!o) return; modal('<div class="sheet" data-a="closesheet"><div class="sheetc" data-stop="1" style="max-width:820px"><div class="stack"><div><h2 style="font-size:17px">Edit order</h2><p class="sm muted" style="margin-top:3px">Every change is written to the record. If a contact detail changes after messages went out, resend the link.</p></div>'+orderForm(o,"e")+'<div class="row"><button class="btn btn-p" data-a="doedit">Save changes</button><button class="btn" data-a="closesheet">Cancel</button></div></div></div></div>'); return; }
    if(a==="doedit"){ if(!o) return; var eb=readOrderForm("e"); if(!eb.addr){ toast("A property address is required."); return; } act(o,"edit",eb); return; }
    if(a==="reissue"){ if(!o) return; if(!confirm("Issue new client links? The old links stop working immediately. Use this if a link was sent to the wrong person.")) return; act(o,"reissue",{}); return; }
    if(a==="dohold"){ if(!o) return; act(o,"hold",{reason:val("h_reason"),note:val("h_note")},Number(t.dataset.from)); return; }
    if(a==="dodecline"){ if(!o) return; act(o,"decline",{reason:val("d_reason"),note:val("d_note")},Number(t.dataset.from)); return; }
    if(a==="docancel"){ if(!o) return; act(o,"cancel",{reason:val("x_reason"),note:val("x_note")},Number(t.dataset.from)); return; }
    if(a==="doaccept"){ if(!o) return; act(o,"accept",{fee:val("a_fee")},Number(t.dataset.from)); return; }
    if(a==="doinvoice"){ if(!o) return; act(o,"invoice",{fee:val("i_fee")},Number(t.dataset.from)); return; }
    if(a==="dobook"){ if(!o) return; var w=val("b_when"); var wm=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(w); if(!wm){ toast("Pick a date and time."); return; } var ms=CORE.zonedToUtc(+wm[1],+wm[2],+wm[3],+wm[4],+wm[5],tz()); if(!isFinite(ms)){ toast("That date is not valid."); return; } act(o,"book",{slot:new Date(ms).toISOString()},Number(t.dataset.from)); return; }
    if(a==="reschedule"){ if(!S.token) return; if(!confirm("Cancel this time and pick a new one?")) return; api("POST","/api/client/"+encodeURIComponent(S.token)+"/reschedule",{}).then(function(d){ toast("<b>"+esc(d.reply)+"</b>"); return loadClient(); }).catch(function(e){ fail(e); loadClient(); }); return; }
    if(a==="noslot"){ if(!S.token) return; var note=prompt("What days and times would work for you?"); if(note===null) return; api("POST","/api/client/"+encodeURIComponent(S.token)+"/noslot",{note:note}).then(function(d){ toast("<b>"+esc(d.reply)+"</b>"); return loadClient(); }).catch(fail); return; }
    if(a==="consent"){ if(!S.token) return; if(!($("consent")&&$("consent").checked)){ toast("Tick the box to continue."); return; } api("POST","/api/client/"+encodeURIComponent(S.token)+"/consent",{}).then(function(){ return loadClient(); }).catch(fail); return; }
  });
  document.addEventListener("change",function(e){
    var t=e.target;
    if(t&&t.dataset&&t.dataset.urole){ var uid=t.dataset.urole, role=t.value; api("PATCH","/api/users/"+encodeURIComponent(uid),{role:role}).then(function(){ toast("Role changed to <b>"+esc(ROLES[role].name)+"</b>. They will see it at their next sign-in."); return loadUsers(); }).then(render).catch(function(err){ fail(err); loadUsers().then(render); }); }
  });
  $("fbtn").addEventListener("click",function(){ modal(feedbackSheet()); });
  document.addEventListener("visibilitychange",function(){ if(!document.hidden) poll(); });
  window.addEventListener("hashchange",function(){
    var h=readHash();
    if(h.t!==S.token){ location.reload(); return; }
    if(h.o&&S.me&&byId(h.o)){ S.sel=h.o; S.tab="status"; S.view=S.me.role==="appraiser"?"queue":"board"; render(); if(!S.detail[h.o]) loadDetail(h.o).catch(fail); }
  });

  (function(){ var h0=readHash(); if(h0.t) S.token=h0.t; else if(h0.invite) S.inviteCode=h0.invite; })();
  render();
  boot();
})();
