/* Appraisal Desk: shared core.
   One source of truth for the order state machine, permissions, slot generation and
   message wording. Runs unchanged in the Cloudflare Worker (ES module) and in the
   browser (the build script strips the final export line). No I/O in here. */
var CORE = (function(){
  "use strict";

  var STEPS = ["Received","Accepted","Scheduling","Scheduled","Inspected","In review","Delivered","Invoiced"];
  var CLIENT_LABEL = {
    "Received":"Appraisal ordered","Accepted":"Appraiser assigned","Scheduling":"Pick an inspection time",
    "Scheduled":"Inspection scheduled","Inspected":"Inspection complete","In review":"Report being prepared",
    "Delivered":"Report delivered to your lender","Invoiced":"Complete"
  };
  var ROLES = {
    admin:{name:"Bank admin",hint:"Manages who can sign in and what they may do. Sees every order. Does not place orders."},
    desk:{name:"Appraisal desk",hint:"Loan officer assistant. Places, edits and cancels orders, uploads documents, sends questions."},
    officer:{name:"Loan officer",hint:"Read only. Sees status, downloads the finished report. Cannot touch the order, which keeps the independence record clean."},
    appraiser:{name:"Appraiser",hint:"Accepts, schedules, inspects, delivers the report and invoice, sets availability."}
  };
  /* product catalogue: name, whether an XML (MISMO/UAD) file is normally required, and what the appraiser needs before starting */
  var PRODUCTS = [
    {name:"1004 URAR",xml:true,needs:"Sales contract for purchases."},
    {name:"1073 Condo",xml:true,needs:"Sales contract, HOA contact and budget if available."},
    {name:"1025 Small Residential Income (2-4 units)",xml:true,needs:"Leases, rent roll, sales contract."},
    {name:"2055 Exterior-only",xml:true,needs:""},
    {name:"1004D / 442 Final inspection",xml:false,needs:"Original report and the list of work to be completed."},
    {name:"1004C Manufactured home",xml:true,needs:"HUD tags and title status."},
    {name:"1007 Rent schedule",xml:false,needs:"Current leases."},
    {name:"216 Operating income statement",xml:false,needs:"Twelve months of income and expenses."},
    {name:"FHA 1004",xml:true,needs:"FHA case number; sales contract."},
    {name:"USDA-RD 1004",xml:true,needs:"Sales contract."},
    {name:"VA 1004",xml:true,needs:"VA case number; sales contract."},
    {name:"Desk review",xml:false,needs:"The report under review."},
    {name:"Recertification of value",xml:false,needs:"Original report."},
    {name:"Commercial narrative",xml:false,needs:"Leases, rent roll, twelve months of expenses, plans and cost breakdown if construction."},
    {name:"Agricultural / farm / land",xml:false,needs:"Parcel numbers, acreage, FSA maps or plat, leases."},
    {name:"Evaluation",xml:false,needs:""},
    {name:"Date of death / retrospective",xml:false,needs:"Effective date, parcel list, attorney contact."},
    {name:"Updated appraisal (as is)",xml:false,needs:"Original report."}
  ];
  var REPORT_TYPES = PRODUCTS.map(function(p){ return p.name; });
  var PURPOSES = ["Purchase","Refinance","Construction","Purchase and improvement","Home equity","Additional collateral","Estate","Other"];
  var LOAN_TYPES = ["Conventional","Portfolio / in-house","FHA","VA","USDA-RD","Construction","Commercial","HELOC","Not a loan"];
  var PREMISES = ["As is","As completed (subject to plans and specs)","As improved (subject to listed repairs)","Final inspection only","Updated appraisal","Retrospective (date of death)"];
  var OCCUPANCY = ["Owner occupied","Tenant occupied","Vacant","Seller occupied","Under construction"];
  var PROPERTY_TYPES = ["Single family","Condominium","2-4 units","Multifamily (5+)","Manufactured home","Commercial","Mixed use","Farm / agricultural","Vacant land","Other"];
  var DELIVERY_FORMATS = ["PDF","PDF and XML (UAD/MISMO)"];
  var ACCESS = ["Borrower","Agent","Seller","Property manager","Attorney or executor","Lockbox, no contact","Owner (not the borrower)"];
  var REVISION_KINDS = ["Correction (names, header, client)","Missing item","Question on comparables or adjustments","Scope change","Reconsideration of value"];
  var PAY_METHODS = ["Check","ACH / direct deposit","Card","Other"];
  var DOC_KINDS = {
    contract:{name:"Sales contract",who:"desk"},
    engagement:{name:"Engagement letter",who:"desk"},
    prior:{name:"Prior appraisal",who:"desk"},
    survey:{name:"Survey or plat",who:"desk"},
    plans:{name:"Plans and specs",who:"desk"},
    other:{name:"Other",who:"any"},
    report:{name:"Appraisal report",who:"appraiser",client:true},
    invoice:{name:"Invoice",who:"appraiser"},
    addendum:{name:"Addendum or revision",who:"appraiser",client:true}
  };
  var HOLD_REASONS = ["Cannot reach contact","Access refused or unavailable","Property not ready (construction)","Missing sales contract","Missing plans or specs","Scope of work question","Weather or road conditions","Other"];
  var DECLINE_REASONS = ["Outside my coverage area","Conflict of interest","Workload, cannot meet due date","Property type outside my competency","Fee not workable","Other"];
  var CANCEL_REASONS = ["Loan withdrawn","Borrower chose another lender","Duplicate order","Ordered in error","Property changed","Other"];

  /* what each role may do; the server enforces this, the browser only hides buttons */
  var PERM = {
    admin:    {view:true, people:true, config:true, brand:true, cancel:true, note:true, docs:true, outbox:true, assign:true, paid:true, revise:true},
    desk:     {view:true, place:true, edit:true, cancel:true, ask:true, note:true, docs:true, outbox:true, hold:true, renotify:true, reissue:true, book:true, assign:true, paid:true, revise:true, docreq:true},
    officer:  {view:true, docs:false, outbox:true},
    appraiser:{view:true, accept:true, decline:true, schedule:true, renotify:true, book:true, inspect:true, review:true, deliver:true, invoice:true, hold:true, fee:true, config:true, docs:true, note:true, outbox:true, prelim:true, reviewer:true, docreq:true}
  };
  function can(role,what){ return !!(PERM[role]&&PERM[role][what]); }

  function statusOf(o){
    if(o.cancelled) return "Cancelled";
    if(o.declined) return "Declined";
    if(o.hold) return "On hold";
    if(o.step===5&&o.revision&&!o.revision.resolvedAt) return "Revision requested";
    if(o.step===5&&o.review&&(o.review.status==="sent"||o.review.status==="returned")) return "With reviewer";
    if(o.step===7&&o.paid) return "Paid";
    return STEPS[o.step]||"Received";
  }
  function lenderName(cfg){ return ((cfg&&cfg.lenderName)||"").trim()||"your lender"; }
  function isOpen(o){ return !o.cancelled && !o.declined && o.step<STEPS.length-1; }

  /* ---------- time, always in the bank's zone ---------- */
  var TZ="America/Chicago";
  function parts(ms,tz){
    var f=new Intl.DateTimeFormat("en-US",{timeZone:tz||TZ,hourCycle:"h23",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",weekday:"short"});
    var p={}; f.formatToParts(new Date(ms)).forEach(function(x){ p[x.type]=x.value; });
    var wd={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6}[p.weekday];
    return {y:+p.year,m:+p.month,d:+p.day,h:(+p.hour)%24,mi:+p.minute,s:+p.second,wd:wd};
  }
  function tzOffset(ms,tz){ var p=parts(ms,tz); return Date.UTC(p.y,p.m-1,p.d,p.h,p.mi,p.s)-Math.floor(ms/1000)*1000; }
  function zonedToUtc(y,m,d,h,mi,tz){
    var guess=Date.UTC(y,m-1,d,h,mi,0);
    var off=tzOffset(guess,tz); var r=guess-off;
    var off2=tzOffset(r,tz); if(off2!==off) r=guess-off2;
    return r;
  }
  function ymd(p){ return p.y+"-"+(p.m<10?"0":"")+p.m+"-"+(p.d<10?"0":"")+p.d; }
  function fmtDay(iso,tz){ try{ return new Intl.DateTimeFormat("en-US",{timeZone:tz||TZ,weekday:"long",month:"short",day:"numeric"}).format(new Date(iso)); }catch(e){ return String(iso); } }
  function fmtHr(iso,tz){ try{ return new Intl.DateTimeFormat("en-US",{timeZone:tz||TZ,hour:"numeric",minute:"2-digit"}).format(new Date(iso)); }catch(e){ return ""; } }
  function fmtTime(iso,tz){ try{ return new Intl.DateTimeFormat("en-US",{timeZone:tz||TZ,month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}).format(new Date(iso)); }catch(e){ return String(iso); } }
  function fmtDate(d){ if(!d) return "not set"; try{ var m=/^(\d{4})-(\d{2})-(\d{2})/.exec(d); if(!m) return d; return new Intl.DateTimeFormat("en-US",{timeZone:"UTC",month:"short",day:"numeric"}).format(new Date(Date.UTC(+m[1],+m[2]-1,+m[3],12))); }catch(e){ return d; } }

  function defaultConfig(){
    return {days:[1,2,3,4,5],startHour:8.5,endHour:16,slotMinutes:60,bufferMinutes:45,leadHours:24,daysOff:[],
            appraiserName:"",appraiserPhone:"",appraiserEmail:"",timeZone:TZ,note:"",deskCopyEmails:[],lenderName:""};
  }
  function num(v,dflt){ v=Number(v); return isFinite(v)&&v>=0?v:dflt; }
  /* Open inspection times: honours days worked, hours, days off, lead time, length and travel buffer.
     booked = array of ms starts already taken. nowMs lets tests pin the clock. */
  function genSlots(cfg,booked,nowMs,limit,daysAhead){
    cfg=cfg||defaultConfig(); booked=booked||[]; nowMs=nowMs||Date.now(); limit=limit||12; daysAhead=daysAhead||45;
    var tz=cfg.timeZone||TZ, days=cfg.days||[1,2,3,4,5], off=cfg.daysOff||[];
    var sh=num(cfg.startHour,8.5), eh=num(cfg.endHour,16), slotM=num(cfg.slotMinutes,60)||60, bufM=num(cfg.bufferMinutes,45), lead=num(cfg.leadHours,24);
    if(!days.length||eh<=sh) return [];
    var cutoff=nowMs+lead*3600e3, blockMs=(slotM+bufM)*60e3, slots=[];
    var p0=parts(cutoff,tz), dayStart=Date.UTC(p0.y,p0.m-1,p0.d,12);
    for(var i=0;i<daysAhead&&slots.length<limit;i++){
      var dp=parts(dayStart+i*864e5,"UTC"), wd=new Date(Date.UTC(dp.y,dp.m-1,dp.d)).getUTCDay();
      if(days.indexOf(wd)===-1) continue;
      if(off.indexOf(ymd(dp))>-1) continue;
      for(var t=sh;t+slotM/60<=eh+1e-9&&slots.length<limit;t+=slotM/60){
        var h=Math.floor(t), mi=Math.round((t-h)*60);
        var ms=zonedToUtc(dp.y,dp.m,dp.d,h,mi,tz);
        if(ms<cutoff) continue;
        var clash=false;
        for(var b=0;b<booked.length;b++){ if(Math.abs(booked[b]-ms)<blockMs){ clash=true; break; } }
        if(!clash) slots.push(new Date(ms).toISOString());
      }
    }
    return slots;
  }
  function slotClashes(cfg,booked,ms){
    var slotM=num((cfg||{}).slotMinutes,60)||60, bufM=num((cfg||{}).bufferMinutes,45), blockMs=(slotM+bufM)*60e3;
    for(var b=0;b<booked.length;b++){ if(Math.abs(booked[b]-ms)<blockMs) return true; }
    return false;
  }

  /* ---------- wording ---------- */
  function apr(cfg){ return ((cfg&&cfg.appraiserName)||"").trim(); }
  function aprCap(cfg){ return apr(cfg)||"The appraiser"; }
  function aprLower(cfg){ return apr(cfg)||"the appraiser"; }
  function aprSig(cfg){ var n=apr(cfg), p=((cfg&&cfg.appraiserPhone)||"").trim();
    if(n&&p) return n+", "+p+"."; if(n) return n+"."; if(p) return "Your appraiser, "+p+"."; return lenderName(cfg)+"."; }
  function qLine(cfg){ var p=((cfg&&cfg.appraiserPhone)||"").trim(); return p?(" Questions: "+p+"."):""; }
  function assignedLine(cfg){ var n=apr(cfg); return n?(" "+n+" is your appraiser."):""; }
  function contactLine(cfg){ var p=((cfg&&cfg.appraiserPhone)||"").trim(); return p?("Questions? Call "+aprLower(cfg)+" at "+p+"."):("Questions? Contact your loan officer at "+lenderName(cfg)+"."); }
  function money(n){ n=Number(n)||0; return "$"+n.toLocaleString("en-US"); }

  /* who gets what. Each message: {channel:"email"|"sms", party:"borrower"|"agent"|"desk"|"appraiser"|"officer", subject, body}
     The server resolves party -> address and link tokens; [link] is replaced there. */
  function contactParty(o){ return (o.accessVia==="Agent"&&o.agentName)?"agent":"borrower"; }
  function contactName(o){ return contactParty(o)==="agent"?o.agentName:(o.borrowerName||"Borrower"); }

  var T = {
    created:function(o,c){ return [
      {channel:"email",party:"appraiser",subject:"New appraisal order: "+o.addr,
       body:lenderName(c)+" has placed an order for "+o.addr+", "+o.city+". Product: "+o.type+". Purpose: "+o.purpose+(o.loanType?(". Loan: "+o.loanType):"")+(o.premise?(". "+o.premise):"")+(o.closingDate?(". Closing "+fmtDate(o.closingDate)):"")+(o.due?(". Due: "+fmtDate(o.due)):"")+(o.rush?". RUSH.":"")+(o.assignedName?(". Assigned to "+o.assignedName+"."):"")+" Open it in the portal to accept or decline: [portal]"}
    ];},
    accepted:function(o,c){ var m=[
      {channel:"email",party:"desk",subject:"Appraisal accepted: "+o.addr,
       body:aprCap(c)+" has accepted the appraisal at "+o.addr+(o.fee?(" at "+money(o.fee)):"")+(o.etaDate?(", expected delivery "+fmtDate(o.etaDate)):(o.due?(", due "+fmtDate(o.due)):""))+(o.acceptNote?(". "+o.acceptNote):"")+". You will be notified as the file moves. [portal]"},
      {channel:"sms",party:"borrower",body:lenderName(c)+" has ordered an appraisal for "+o.addr+"."+assignedLine(c)+" Track it here: [link]. Reply STOP to opt out."},
      {channel:"email",party:"borrower",subject:"Your appraisal has been ordered: "+o.addr,
       body:lenderName(c)+" has ordered an appraisal for "+o.addr+"."+assignedLine(c)+" You can follow its progress and, when the time comes, choose your inspection time here: [link]. "+contactLine(c)}
    ]; if(o.officerName) m.push({channel:"email",party:"officer",subject:"Appraisal accepted: "+o.addr,body:aprCap(c)+" has accepted the appraisal at "+o.addr+". Status: [portal]"}); return m; },
    declined:function(o,c){ return [
      {channel:"email",party:"desk",subject:"Appraisal declined: "+o.addr,
       body:"The appraiser declined the order at "+o.addr+". Reason: "+(o.declinedReason||"not stated")+". Nothing has been sent to the borrower. Re-route this file today. [portal]"}
    ];},
    schedule:function(o,c){ return [
      {channel:"sms",party:contactParty(o),body:"Time to schedule your appraisal inspection at "+o.addr+". Pick a time that works: [link]. Takes about "+num(c.slotMinutes,60)+" minutes."+qLine(c)},
      {channel:"email",party:contactParty(o),subject:"Schedule your appraisal inspection: "+o.addr,
       body:"Your appraisal inspection at "+o.addr+" is ready to be scheduled. Choose a time that works for you: [link]. The inspection takes about "+num(c.slotMinutes,60)+" minutes and "+aprLower(c)+" will need access to every room, the basement and the garage. "+aprSig(c)}
    ];},
    renotify:function(o,c){ return [
      {channel:"sms",party:contactParty(o),body:"Reminder: time to schedule your appraisal inspection at "+o.addr+". Pick a time: [link]."+qLine(c)},
      {channel:"email",party:contactParty(o),subject:"Reminder: schedule your appraisal inspection at "+o.addr,body:"Your inspection at "+o.addr+" still needs a time. Choose one here: [link]. "+aprSig(c)}
    ];},
    booked:function(o,c,p){ var when=fmtDay(o.apptStart,c.timeZone)+" at "+fmtHr(o.apptStart,c.timeZone); var m=[
      {channel:"sms",party:contactParty(o),body:"Confirmed: your appraisal inspection at "+o.addr+" is "+when+". "+aprSig(c)},
      {channel:"email",party:contactParty(o),subject:"Inspection confirmed: "+o.addr+", "+when,
       body:"Your appraisal inspection at "+o.addr+" is confirmed for "+when+". "+aprCap(c)+" will need to see every room, the basement, the attic access and the garage, and will photograph each room. It takes about "+num(c.slotMinutes,60)+" minutes. Add it to your calendar: [ics]. Need to change it? [link]. "+aprSig(c)},
      {channel:"email",party:"desk",subject:"Inspection scheduled: "+o.addr,body:"The inspection at "+o.addr+" is scheduled for "+when+". [portal]"}
    ]; if(p&&p.byStaff) m.push({channel:"email",party:"appraiser",subject:"Inspection booked by the desk: "+o.addr,body:"The desk booked the inspection at "+o.addr+" for "+when+". [portal]"}); return m; },
    rescheduled:function(o,c,p){ var had=p&&p.had?(" that was set for "+fmtDay(p.had,c.timeZone)+" at "+fmtHr(p.had,c.timeZone)):""; var m=[
      {channel:"email",party:"appraiser",subject:"Inspection cancelled: "+o.addr,body:"The inspection at "+o.addr+had+" was cancelled"+(p&&p.byStaff?" by the desk":" by the client")+". They have been asked to pick a new time. Do not drive to the property. [portal]"},
      {channel:"email",party:"desk",subject:"Inspection cancelled: "+o.addr,body:"The inspection at "+o.addr+had+" was cancelled and the client has been asked to choose a new time. [portal]"}
    ]; if(p&&p.byStaff){ m.push({channel:"sms",party:contactParty(o),body:"Your appraisal inspection at "+o.addr+had+" needs a new time. Pick one here: [link]."+qLine(c)}); } return m; },
    noslot:function(o,c,p){ return [
      {channel:"email",party:"appraiser",subject:"Scheduling problem: "+o.addr,body:"The client could not use the offered times for "+o.addr+". They said: "+(p&&p.note||"")+" Call them to arrange a time, then book it in the portal. [portal]"}
    ];},
    inspected:function(o,c){ var m=[{channel:"email",party:"desk",subject:"Inspection complete: "+o.addr,body:"The inspection at "+o.addr+" is complete. The report is now in preparation. [portal]"}];
      m.push({channel:"sms",party:contactParty(o),body:"Thank you. The inspection at "+o.addr+" is complete and the report is being prepared. "+aprSig(c)}); return m; },
    delivered:function(o,c){ var m=[
      {channel:"email",party:"desk",subject:"Appraisal delivered: "+o.addr,body:"The appraisal report for "+o.addr+" has been delivered through the portal and is available to download. [portal]"},
      {channel:"email",party:"borrower",subject:"Your appraisal copy: "+o.addr,
       body:"A copy of the appraisal for "+o.addr+" is available to you at no charge: [link]. You are receiving this electronically because you agreed to electronic delivery. To receive a paper copy instead at no charge, reply to this message or call your loan officer at "+lenderName(c)+"."}
    ]; if(o.officerName) m.push({channel:"email",party:"officer",subject:"Appraisal delivered: "+o.addr,body:"The report for "+o.addr+" is in the portal. [portal]"}); return m; },
    invoiced:function(o,c){ return [
      {channel:"email",party:"desk",subject:"Invoice: "+o.addr,body:"The invoice for the appraisal at "+o.addr+(o.fee?(" in the amount of "+money(o.fee)):"")+" is in the portal. "+aprSig(c)+" [portal]"}
    ];},
    hold:function(o,c){ return [
      {channel:"email",party:"desk",subject:"Appraisal on hold: "+o.addr,body:"The appraisal at "+o.addr+" is on hold. Reason: "+(o.holdReason||"not stated")+(o.holdNote?(". "+o.holdNote):"")+". No action is needed from the borrower unless the desk says otherwise. "+aprSig(c)+" [portal]"}
    ];},
    release:function(o,c){ return [
      {channel:"email",party:"desk",subject:"Appraisal resumed: "+o.addr,body:"The appraisal at "+o.addr+" is off hold and moving again. [portal]"}
    ];},
    cancelled:function(o,c){ var m=[
      {channel:"email",party:"appraiser",subject:"Order cancelled: "+o.addr,body:lenderName(c)+" cancelled the appraisal order at "+o.addr+". Reason: "+(o.cancelReason||"not stated")+". Stop work on this file."+(o.step>=3?" If a trip was made, note the trip fee on the order.":"")+" [portal]"}
    ]; if(o.clientContacted){ m.push({channel:"sms",party:contactParty(o),body:"The appraisal inspection for "+o.addr+" is no longer needed. Nothing further is required from you. "+lenderName(c)+"."}); } return m; },
    ask:function(o,c,p){ return [
      {channel:"email",party:"appraiser",subject:"Question on "+o.addr,body:(p&&p.text||"")+"\n\nSent by "+(p&&p.by||"the desk")+" through the portal. Logged on the independence record. [portal]"}
    ];},
    reply:function(o,c,p){ return [
      {channel:"email",party:"desk",subject:"Reply on "+o.addr,body:(p&&p.text||"")+"\n\nFrom "+aprLower(c)+" through the portal. [portal]"}
    ];},
    assigned:function(o,c){ return [
      {channel:"email",party:"appraiser",subject:"Assigned to you: "+o.addr,body:"The appraisal at "+o.addr+", "+o.city+" ("+o.type+", "+o.purpose+") has been assigned to "+(o.assignedName||"you")+(o.due?(", due "+fmtDate(o.due)):"")+". Open it in the portal to accept or decline: [portal]"}
    ];},
    reviewsent:function(o,c){ return [
      {channel:"email",party:"desk",subject:"Report in review: "+o.addr,body:"The report for "+o.addr+" is complete and with "+((o.review&&o.review.name)||"the reviewing appraiser")+" for review and signature"+(o.review&&o.review.eta?(", expected back "+fmtDate(o.review.eta)):"")+". You will be notified when it is delivered. [portal]"}
    ];},
    prelim:function(o,c,p){ return [
      {channel:"email",party:"desk",subject:"Preliminary figures: "+o.addr,body:"For closing figures only, ahead of the signed report: "+(o.fee?("appraisal fee "+money(o.fee)):"fee to follow")+(p&&p.value?("; preliminary value "+money(p.value)):"")+". The signed report follows"+(o.etaDate?(" by "+fmtDate(o.etaDate)):"")+" and controls. "+aprSig(c)+" [portal]"}
    ];},
    revise:function(o,c,p){ return [
      {channel:"email",party:"appraiser",subject:"Revision requested: "+o.addr,body:lenderName(c)+" requests a revision to the report for "+o.addr+". "+((p&&p.kind)||"")+": "+((p&&p.text)||"")+" Upload the revised report and deliver it again through the portal. [portal]"}
    ];},
    redelivered:function(o,c){ var m=[
      {channel:"email",party:"desk",subject:"Revised report delivered: "+o.addr,body:"The revised appraisal report for "+o.addr+" (revision "+((o.revision&&o.revision.n)||1)+") has been delivered through the portal. [portal]"}
    ]; if(o.officerName) m.push({channel:"email",party:"officer",subject:"Revised report delivered: "+o.addr,body:"The revised report for "+o.addr+" is in the portal. [portal]"}); return m; },
    paid:function(o,c){ return [
      {channel:"email",party:"appraiser",subject:"Payment recorded: "+o.addr,body:lenderName(c)+" recorded payment for "+o.addr+(o.fee?(" of "+money(o.fee)):"")+(o.paid&&o.paid.method?(" by "+o.paid.method):"")+(o.paid&&o.paid.ref?(", reference "+o.paid.ref):"")+". [portal]"}
    ];},
    docreq:function(o,c,p){ return [
      {channel:"sms",party:contactParty(o),body:aprCap(c)+" needs a few documents for the appraisal at "+o.addr+". Upload them here: [link]."+qLine(c)},
      {channel:"email",party:contactParty(o),subject:"Documents needed for your appraisal: "+o.addr,body:"To complete the appraisal at "+o.addr+", "+aprLower(c)+" needs the following: "+((p&&p.items)||"")+". Please upload them on your status page: [link]. "+aprSig(c)}
    ];},
    nudge:function(o,c,p){ var why={accept:"has not been accepted or declined",schedule:"has no scheduling request yet",inspect:"had its inspection scheduled but nothing has been logged since",deliver:"is past the expected delivery date",stale:"has had no activity for three days"};
      return [{channel:"email",party:"appraiser",subject:"Reminder: "+o.addr+" "+(why[p&&p.key]||"needs attention"),body:"The order at "+o.addr+" ("+o.type+(o.due?(", due "+fmtDate(o.due)):"")+") "+(why[p&&p.key]||"needs attention")+". The lender sees the same status. Update it here: [portal]"}]; }
  };

  /* ---------- transitions (pure). Throws {code,msg}. Returns {events:[],messages:[],msg} ---------- */
  function fail(code,msg){ var e=new Error(msg); e.code=code; e.msg=msg; throw e; }
  function applyAction(o,action,p,actor,cfg,now){
    p=p||{}; cfg=cfg||defaultConfig(); now=now||new Date().toISOString();
    var role=actor.role, ev=[], msgs=[], reply="", who=actor.name;
    function log(w){ ev.push({at:now,who:who,role:role,what:w}); }
    function send(k,extra){ (T[k](o,cfg,extra)||[]).forEach(function(m){ m.template=k; msgs.push(m); }); }
    if(o.cancelled && action!=="note") fail("closed","This order was cancelled.");
    if(o.declined && ["note","cancel","reissue"].indexOf(action)===-1) fail("closed","This order was declined. Place a new one.");

    switch(action){
      case "accept":
        if(!can(role,"accept")) fail("forbidden","Only the appraiser can accept.");
        if(o.step!==0) fail("stale","This order already moved to "+statusOf(o)+".");
        if(p.fee!==undefined&&p.fee!==null&&p.fee!=="") o.fee=Number(p.fee)||0;
        if(p.etaDate&&/^\d{4}-\d{2}-\d{2}$/.test(String(p.etaDate))) o.etaDate=String(p.etaDate);
        o.acceptNote=String(p.note||"").slice(0,300);
        o.step=1; o.acceptedAt=now; o.appraiserName=o.assignedName||apr(cfg)||who; if(!o.assignedTo&&actor.id){ o.assignedTo=actor.id; o.assignedName=who; } o.clientContacted=true;
        log("Order accepted."+(o.fee?(" Fee "+money(o.fee)+"."):"")+(o.etaDate?(" Expected delivery "+fmtDate(o.etaDate)+"."):"")+(o.acceptNote?(" "+o.acceptNote):""));
        send("accepted"); reply="Accepted. The desk and the borrower have been notified."; break;
      case "decline":
        if(!can(role,"decline")) fail("forbidden","Only the appraiser can decline.");
        if(o.step!==0) fail("stale","Only a new order can be declined. Use hold or ask the desk to cancel.");
        o.declined=true; o.declinedReason=String(p.reason||"Not stated").slice(0,200)+(p.note?(": "+String(p.note).slice(0,400)):"");
        log("Order DECLINED: "+o.declinedReason); send("declined"); reply="Declined. The desk was told; the borrower was not contacted."; break;
      case "schedule":
        if(!can(role,"schedule")) fail("forbidden","Only the appraiser can send the scheduling request.");
        if(o.hold) fail("held","Release the hold first.");
        if(o.step!==1) fail("stale","This order is at "+statusOf(o)+".");
        o.step=2; o.clientContacted=true; log("Scheduling request sent to "+contactName(o)+"."); send("schedule"); reply="Scheduling request sent."; break;
      case "renotify":
        if(!can(role,"renotify")) fail("forbidden","Not allowed for your role.");
        if(o.step!==2) fail("stale","The scheduling link only applies while the file is waiting to be scheduled.");
        log("Scheduling link resent to "+contactName(o)+"."); send("renotify"); reply="Link resent."; break;
      case "book": {
        if(!(can(role,"book")||role==="client")) fail("forbidden","Not allowed for your role.");
        if(o.hold) fail("held","This file is on hold.");
        if(o.step<1||o.step>3) fail("stale","This file is at "+statusOf(o)+" and cannot be booked.");
        var ms=Date.parse(p.slot||""); if(!isFinite(ms)) fail("bad","Pick a time.");
        if(ms<Date.parse(now)) fail("bad","That time is in the past.");
        if(slotClashes(cfg,p.booked||[],ms)) fail("clash","That time was just taken. Pick another.");
        if(role==="client"){ var open=genSlots(cfg,p.booked||[],Date.parse(now),60); if(open.indexOf(new Date(ms).toISOString())===-1) fail("bad","That time is no longer offered. Pick another."); }
        var had=o.apptStart; o.apptStart=new Date(ms).toISOString(); o.apptEnd=new Date(ms+(num(cfg.slotMinutes,60)||60)*60e3).toISOString();
        o.step=3; o.clientContacted=true;
        log((role==="client"?contactName(o)+" booked":"Booked by "+who+" for "+contactName(o))+" the inspection for "+fmtDay(o.apptStart,cfg.timeZone)+", "+fmtHr(o.apptStart,cfg.timeZone)+(had?(" (replacing "+fmtDay(had,cfg.timeZone)+" "+fmtHr(had,cfg.timeZone)+")"):"")+".");
        send("booked",{byStaff:role!=="client"}); reply="Booked for "+fmtDay(o.apptStart,cfg.timeZone)+", "+fmtHr(o.apptStart,cfg.timeZone)+"."; break; }
      case "reschedule": {
        if(!(can(role,"book")||role==="client")) fail("forbidden","Not allowed for your role.");
        if(o.step!==3) fail("stale","There is no booked inspection to change.");
        var had2=o.apptStart; o.apptStart=null; o.apptEnd=null; o.step=2;
        log((role==="client"?contactName(o):who)+" cancelled the inspection"+(had2?(" set for "+fmtDay(had2,cfg.timeZone)+" "+fmtHr(had2,cfg.timeZone)):"")+"; a new time was requested.");
        send("rescheduled",{had:had2,byStaff:role!=="client"}); reply="Cancelled. The appraiser was told not to drive out."; break; }
      case "noslot":
        if(role!=="client") fail("forbidden","Client action.");
        if(o.step!==2) fail("stale","Not waiting on a time.");
        log(contactName(o)+" could not use the offered times: "+String(p.note||"").slice(0,500)); send("noslot",{note:String(p.note||"").slice(0,500)}); reply="Sent to the appraiser. They will call you."; break;
      case "consent":
        if(role!=="client") fail("forbidden","Client action.");
        o.consent=o.consent||{}; o.consent[p.party||"borrower"]={at:now}; log((p.party==="agent"?(o.agentName||"Agent"):(o.borrowerName||"Borrower"))+" consented to electronic delivery."); reply="Recorded."; break;
      case "inspect":
        if(!can(role,"inspect")) fail("forbidden","Only the appraiser can log the inspection.");
        if(o.hold) fail("held","Release the hold first.");
        if(o.step!==3) fail("stale","This file is at "+statusOf(o)+".");
        o.step=4; o.inspectedAt=now; log("Inspection complete."); send("inspected"); reply="Inspection logged."; break;
      case "review":
        if(!can(role,"review")) fail("forbidden","Only the appraiser can do that.");
        if(o.hold) fail("held","Release the hold first.");
        if(o.step!==4) fail("stale","This file is at "+statusOf(o)+".");
        o.step=5; log("Moved to in review."); reply="Moved to in review."; break;
      case "deliver":
        if(!can(role,"deliver")) fail("forbidden","Only the appraiser can deliver.");
        if(o.hold) fail("held","Release the hold first.");
        if(o.step!==5) fail("stale","This file is at "+statusOf(o)+".");
        if(!p.hasReport&&!p.force) fail("noreport","No appraisal report is attached. Upload it first, or confirm delivery without one.");
        if(o.review&&o.review.status==="sent"&&!p.force) fail("review","The report is still with the reviewer. Record their sign-off first.");
        if(o.revision&&!o.revision.resolvedAt){
          o.revision.resolvedAt=now; o.step=o.invoicedAt?7:6; o.redeliveredAt=now;
          log("Revised report delivered (revision "+o.revision.n+")."); send("redelivered"); reply="Revised report delivered."; break;
        }
        o.step=6; o.deliveredAt=now; if(o.review) o.review.status="signed"; log("Report delivered through the portal"+(p.hasReport?"":" (no report file attached)")+". Borrower copy issued; electronic delivery counts once the borrower has consented on their page.");
        send("delivered"); reply="Delivered. Borrower copy issued and logged."; break;
      case "assign": {
        if(!can(role,"assign")) fail("forbidden","Only the desk or the administrator assigns.");
        if(o.step>=6) fail("stale","A delivered file cannot be reassigned.");
        if(!p.userId||!p.name) fail("bad","Pick an appraiser.");
        var was=o.assignedName; o.assignedTo=String(p.userId).slice(0,60); o.assignedName=String(p.name).slice(0,120); o.appraiserName=o.assignedName;
        log((was?("Reassigned from "+was+" to "):"Assigned to ")+o.assignedName+"."); send("assigned"); reply="Assigned to "+o.assignedName+"."; break; }
      case "sendreview":
        if(!can(role,"reviewer")) fail("forbidden","Appraiser action.");
        if(o.step!==5) fail("stale","Move the file to in review first.");
        o.review={status:"sent",name:String(p.name||"").slice(0,120),eta:/^\d{4}-\d{2}-\d{2}$/.test(String(p.eta||""))?String(p.eta):"",sentAt:now,note:String(p.note||"").slice(0,300)};
        log("Draft sent to "+(o.review.name||"the reviewing appraiser")+" for review and signature"+(o.review.eta?(", expected back "+fmtDate(o.review.eta)):"")+"."); send("reviewsent"); reply="Reviewer noted. The desk can see the file is in review."; break;
      case "reviewback":
        if(!can(role,"reviewer")) fail("forbidden","Appraiser action.");
        if(!o.review||o.review.status!=="sent") fail("stale","Nothing is with the reviewer.");
        o.review.status="returned"; o.review.returnedAt=now; o.review.comments=String(p.text||"").slice(0,1000);
        log("Reviewer returned comments"+(o.review.comments?(": "+o.review.comments):".")); reply="Noted."; break;
      case "reviewsigned":
        if(!can(role,"reviewer")) fail("forbidden","Appraiser action.");
        if(!o.review||o.review.status==="signed") fail("stale","No review is open.");
        o.review.status="signed"; o.review.signedAt=now; log("Reviewer signed off ("+(o.review.name||"reviewer")+")."); reply="Signed off. Deliver when the signed report is uploaded."; break;
      case "prelim":
        if(!can(role,"prelim")) fail("forbidden","Appraiser action.");
        if(o.step<4||o.step>5) fail("stale","Preliminary figures can be released after the inspection and before delivery.");
        if(p.fee!==undefined&&p.fee!==null&&p.fee!=="") o.fee=Number(p.fee)||0;
        o.prelim={at:now,value:Number(p.value)||0,by:who};
        log("Preliminary figures released to the lender for closing purposes"+(o.prelim.value?(": value "+money(o.prelim.value)):"")+(o.fee?(", fee "+money(o.fee)):"")+". The signed report controls."); send("prelim",{value:o.prelim.value}); reply="Released to the desk."; break;
      case "revise": {
        if(!can(role,"revise")) fail("forbidden","Only the desk or the administrator requests revisions.");
        if(o.step<6) fail("stale","The report has not been delivered yet. Send a question instead.");
        if(!p.text) fail("bad","Describe the revision.");
        var n=((o.revision&&o.revision.n)||0)+1;
        o.revision={n:n,kind:String(p.kind||REVISION_KINDS[0]).slice(0,80),text:String(p.text).slice(0,2000),requestedAt:now,by:who,resolvedAt:null};
        o.step=5; log("Revision "+n+" requested ("+o.revision.kind+"): "+o.revision.text); send("revise",{kind:o.revision.kind,text:o.revision.text}); reply="Revision requested. The appraiser was notified."; break; }
      case "paid":
        if(!can(role,"paid")) fail("forbidden","Only the desk or the administrator records payment.");
        if(o.step!==7) fail("stale","Payment is recorded after the invoice.");
        o.paid={at:now,by:who,method:String(p.method||"Check").slice(0,40),ref:String(p.ref||"").slice(0,80),amount:Number(p.amount)||o.fee||0};
        log("Payment recorded: "+money(o.paid.amount)+" by "+o.paid.method+(o.paid.ref?(", reference "+o.paid.ref):"")+"."); send("paid"); reply="Payment recorded."; break;
      case "docreq":
        if(!can(role,"docreq")) fail("forbidden","Not allowed for your role.");
        if(!isOpen(o)) fail("stale","This file is closed.");
        if(!p.items) fail("bad","List what you need.");
        o.docRequest={items:String(p.items).slice(0,800),at:now,by:who}; o.clientContacted=true;
        log("Documents requested from "+contactName(o)+": "+o.docRequest.items); send("docreq",{items:o.docRequest.items}); reply="Request sent with an upload link."; break;
      case "clientdoc":
        if(role!=="client") fail("forbidden","Client action.");
        log(contactName(o)+" uploaded "+String(p.name||"a document").slice(0,200)+"."); reply="Received."; break;
      case "nudge":
        if(role!=="system") fail("forbidden","System action.");
        o.nudged=o.nudged||{}; o.nudged[p.key]=now; send("nudge",{key:p.key}); reply="nudged"; break;
      case "invoice":
        if(!can(role,"invoice")) fail("forbidden","Only the appraiser can invoice.");
        if(o.step!==6) fail("stale","Deliver the report first.");
        if(p.fee!==undefined&&p.fee!==null&&p.fee!=="") o.fee=Number(p.fee)||0;
        o.step=7; o.invoicedAt=now; log("Invoice sent"+(o.fee?(", "+money(o.fee)):"")+"."); send("invoiced"); reply="Invoice sent. File complete."; break;
      case "hold":
        if(!can(role,"hold")) fail("forbidden","Not allowed for your role.");
        if(o.hold) fail("stale","Already on hold.");
        if(o.step>=6) fail("stale","A delivered file cannot be put on hold.");
        o.hold=true; o.holdReason=String(p.reason||"Other").slice(0,120); o.holdNote=String(p.note||"").slice(0,400); o.holdAt=now;
        log("Placed on hold: "+o.holdReason+(o.holdNote?(". "+o.holdNote):"")); send("hold"); reply="On hold. The desk was notified with the reason."; break;
      case "release":
        if(!can(role,"hold")) fail("forbidden","Not allowed for your role.");
        if(!o.hold) fail("stale","Not on hold.");
        o.hold=false; o.holdReason=""; o.holdNote=""; o.holdAt=null; log("Hold released."); send("release"); reply="Hold released."; break;
      case "cancel":
        if(!can(role,"cancel")) fail("forbidden","Only the desk or the administrator can cancel.");
        if(o.step>=6) fail("stale","A delivered file cannot be cancelled. Ask the appraiser about a revision instead.");
        o.cancelled=true; o.cancelReason=String(p.reason||"Other").slice(0,120)+(p.note?(": "+String(p.note).slice(0,400)):""); o.cancelledAt=now; o.apptStart=null; o.apptEnd=null;
        log("Order CANCELLED: "+o.cancelReason); send("cancelled"); reply="Cancelled. The appraiser was told to stop."+(o.clientContacted?" The client was told nothing further is needed.":""); break;
      case "ask":
        if(!can(role,"ask")) fail("forbidden","Only the desk can send questions.");
        if(!p.text) fail("bad","Write a question first.");
        log("Question from the bank: "+String(p.text).slice(0,2000)); send("ask",{text:String(p.text).slice(0,2000),by:who}); reply="Sent and logged."; break;
      case "reply":
        if(role!=="appraiser") fail("forbidden","Only the appraiser can reply here.");
        if(!p.text) fail("bad","Write a reply first.");
        log("Reply from the appraiser: "+String(p.text).slice(0,2000)); send("reply",{text:String(p.text).slice(0,2000)}); reply="Sent and logged."; break;
      case "note":
        if(!can(role,"note")) fail("forbidden","Not allowed.");
        if(!p.text) fail("bad","Write a note first.");
        log("Note: "+String(p.text).slice(0,2000)); reply="Noted."; break;
      case "fee":
        if(!can(role,"fee")) fail("forbidden","Only the appraiser sets the fee.");
        o.fee=Number(p.fee)||0; log("Fee set to "+money(o.fee)+"."); reply="Fee saved."; break;
      case "edit": {
        if(!can(role,"edit")) fail("forbidden","Only the desk can edit an order.");
        if(o.step>=4) fail("stale","An inspected file cannot be edited. Add a note or ask the appraiser instead.");
        var F=["addr","city","loan","type","purpose","due","rush","borrowerName","borrowerPhone","borrowerEmail","agentName","agentPhone","agentEmail","accessVia","notes","officerName","officerEmail","fee","loanType","premise","occupancy","propertyType","units","pins","closingDate","earliestInspection","deliveryFormat","refNo","groupRef","combinedReport","intendedUse","accessNotes"];
        var ch=[]; F.forEach(function(k){ if(p[k]===undefined) return; var v=p[k]; if(k==="fee"||k==="units") v=Number(v)||0; else if(k==="rush"||k==="combinedReport") v=!!v; else v=String(v).slice(0,(k==="notes"||k==="intendedUse")?2000:200);
          if(String(o[k]===undefined?"":o[k])!==String(v)){ ch.push(k); o[k]=v; } });
        if(!ch.length) fail("bad","Nothing changed.");
        log("Order edited: "+ch.join(", ")+"."); reply="Saved."+(o.clientContacted&&(ch.indexOf("borrowerPhone")>-1||ch.indexOf("borrowerEmail")>-1||ch.indexOf("agentPhone")>-1||ch.indexOf("agentEmail")>-1)?" Contact details changed after messages went out; resend the link if needed.":""); break; }
      case "reissue":
        if(!can(role,"reissue")) fail("forbidden","Only the desk can reissue links.");
        log("Client links reissued; the old links stopped working."); reply="New links issued. Resend them to the borrower."; break;
      default: fail("bad","Unknown action.");
    }
    o.updatedAt=now;
    return {events:ev,messages:msgs,reply:reply};
  }

  /* what the appraiser (and desk) can do next; the UI renders these */
  function nextActions(o,role){
    var a=[];
    if(o.cancelled||o.declined) return a;
    if(o.hold){ if(can(role,"hold")) a.push(["release","Release hold",1]); return a; }
    var inRevision=o.step===5&&o.revision&&!o.revision.resolvedAt;
    if(role==="appraiser"){
      if(o.step===0){ a.push(["accept","Accept order",1]); a.push(["decline","Decline",0]); }
      if(o.step===1) a.push(["schedule","Send scheduling request",1]);
      if(o.step===2){ a.push(["renotify","Resend scheduling link",0]); a.push(["book","Book a time for them",0]); }
      if(o.step===3){ a.push(["inspect","Log inspection complete",1]); a.push(["reschedule","Cancel this time",0]); }
      if(o.step===4) a.push(["review","Move to in review",1]);
      if(o.step===5){
        if(inRevision) a.push(["deliver","Deliver revised report",1]);
        else if(o.review&&o.review.status==="sent") a.push(["reviewback","Reviewer returned comments",0]);
        else a.push(["deliver","Deliver report",1]);
        if(o.review&&(o.review.status==="sent"||o.review.status==="returned")) a.push(["reviewsigned","Reviewer signed off",1]);
        else if(!inRevision) a.push(["sendreview","Send to reviewer",0]);
      }
      if(o.step===4||o.step===5) a.push(["prelim","Release preliminary figures",0]);
      if(o.step===6) a.push(["invoice","Send invoice",1]);
      if(o.step>=1&&o.step<=5) a.push(["docreq","Request documents from the client",0]);
      if(o.step<6) a.push(["hold","Place on hold",0]);
    }
    if(role==="desk"||role==="admin"){
      if(role==="desk"&&o.step===2){ a.push(["renotify","Resend scheduling link",0]); a.push(["book","Book a time for them",0]); }
      if(role==="desk"&&o.step===3) a.push(["reschedule","Cancel this time",0]);
      if(o.step>=6&&!inRevision) a.push(["revise","Request a revision",0]);
      if(o.step===7&&!o.paid) a.push(["paid","Record payment",1]);
      if(role==="desk"&&o.step<6) a.push(["hold","Place on hold",0]);
    }
    return a;
  }

  /* reminders the system owes the appraiser; returns keys due now (each at most once a day) */
  function nudgesDue(o,nowMs){
    if(!isOpen(o)||o.hold) return [];
    var due=[], H=3600e3, last=function(k){ return o.nudged&&o.nudged[k]?Date.parse(o.nudged[k]):0; };
    var upd=Date.parse(o.updatedAt||o.createdAt||0), created=Date.parse(o.createdAt||0);
    if(o.step===0&&nowMs-created>24*H) due.push("accept");
    if(o.step===1&&nowMs-Date.parse(o.acceptedAt||o.updatedAt)>48*H) due.push("schedule");
    if(o.step===3&&o.apptStart&&nowMs-Date.parse(o.apptStart)>24*H) due.push("inspect");
    if((o.step===4||o.step===5)&&o.etaDate&&nowMs>Date.parse(o.etaDate+"T23:59:59Z")) due.push("deliver");
    if(o.step>=1&&o.step<6&&nowMs-upd>72*H) due.push("stale");
    return due.filter(function(k){ return nowMs-last(k)>24*H; });
  }

  return {STEPS:STEPS,CLIENT_LABEL:CLIENT_LABEL,ROLES:ROLES,PRODUCTS:PRODUCTS,REPORT_TYPES:REPORT_TYPES,PURPOSES:PURPOSES,ACCESS:ACCESS,
    LOAN_TYPES:LOAN_TYPES,PREMISES:PREMISES,OCCUPANCY:OCCUPANCY,PROPERTY_TYPES:PROPERTY_TYPES,DELIVERY_FORMATS:DELIVERY_FORMATS,REVISION_KINDS:REVISION_KINDS,PAY_METHODS:PAY_METHODS,
    lenderName:lenderName,nudgesDue:nudgesDue,
    DOC_KINDS:DOC_KINDS,HOLD_REASONS:HOLD_REASONS,DECLINE_REASONS:DECLINE_REASONS,CANCEL_REASONS:CANCEL_REASONS,PERM:PERM,can:can,
    statusOf:statusOf,isOpen:isOpen,TZ:TZ,fmtDay:fmtDay,fmtHr:fmtHr,fmtTime:fmtTime,fmtDate:fmtDate,defaultConfig:defaultConfig,
    genSlots:genSlots,slotClashes:slotClashes,zonedToUtc:zonedToUtc,applyAction:applyAction,nextActions:nextActions,contactParty:contactParty,contactName:contactName,
    aprCap:aprCap,aprLower:aprLower,contactLine:contactLine,money:money,templates:T};
})();

/* Appraisal Desk: browser app. Talks to the Worker API; CORE (above) supplies shared rules. */
(function(){
  "use strict";
  var STEPS=CORE.STEPS, ROLES=CORE.ROLES, CLIENT_LABEL=CORE.CLIENT_LABEL, DOC_KINDS=CORE.DOC_KINDS;
  var S = {
    me:null, view:"board", sel:null, tab:"status", orders:[], detail:{}, config:null, feedback:[], users:[], audit:[], messages:[],
    busy:false, toastT:null, boot:"loading", bootWhy:"", token:null, client:null, invite:null, inviteCode:null, provisioned:true,
    providers:{email:false,sms:false}, filter:"active", q:"", mfilter:"manual", lastSync:"", menu:false, pollT:null, storage:"kv", demo:false, brand:{name:"Your Lender",tagline:"",primary:"#1f4984",accent:"#790000",logo:"",productName:"Appraisal Desk"}, appraisers:[]
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
  function lender(){ return (S.brand&&S.brand.name)||"your lender"; }
  function shade(hex,f){ var m=/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex||""); if(!m) return hex; return "#"+[1,2,3].map(function(i){ var v=Math.round(parseInt(m[i],16)*f); return ("0"+Math.max(0,Math.min(255,v)).toString(16)).slice(-2); }).join(""); }
  function applyBrand(b){
    if(!b) return; S.brand=b;
    var st=$("brandvars"); if(!st){ st=document.createElement("style"); st.id="brandvars"; document.head.appendChild(st); }
    st.textContent=":root{--navy:"+b.primary+";--navy-deep:"+shade(b.primary,0.78)+";--red:"+b.accent+"}";
    document.title=b.name+" "+(b.productName||"Appraisal Desk");
    var logo=document.querySelector(".logo"), wrap=document.querySelector(".topin");
    if(b.logo){ if(!logo){ logo=document.createElement("img"); logo.className="logo"; wrap.insertBefore(logo,wrap.firstChild); var t=document.querySelector(".textlogo"); if(t) t.remove(); } logo.src=b.logo; logo.alt=b.name; }
    else { if(logo) logo.remove(); var tl=document.querySelector(".textlogo"); if(!tl){ tl=document.createElement("div"); tl.className="textlogo"; wrap.insertBefore(tl,wrap.firstChild); } tl.innerHTML='<b>'+esc(b.name)+'</b>'+(b.tagline?'<span>'+esc(b.tagline)+'</span>':''); }
    var h1=document.querySelector(".mast h1"), tag=document.querySelector(".mast .tag");
    if(h1) h1.textContent=b.productName||"Appraisal Desk";
    if(tag) tag.textContent="Order intake, live status, inspection scheduling and report delivery between "+b.name+" and its appraisers.";
  }
  function brandline(){ return '<p class="brandline">'+esc(lender())+(S.brand.tagline?' &middot; '+esc(S.brand.tagline):'')+'</p>'; }
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
  function loadUsers(){ if(!S.me||S.me.role!=="admin") return Promise.resolve(); return Promise.all([api("GET","/api/users"),api("GET","/api/audit")]).then(function(r){ S.users=r[0].users; S.audit=r[1].audit||[]; }); }
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
    S.me=user; S.config=(sessionData&&sessionData.config)||S.config||CORE.defaultConfig(); if(sessionData&&sessionData.appraisers) S.appraisers=sessionData.appraisers; if(sessionData&&sessionData.brand) applyBrand(sessionData.brand);
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
      S.boot="ready"; S.provisioned=d.provisioned!==false; S.providers=d.providers||S.providers; S.storage=d.storage||"kv"; S.demo=!!d.demo; applyBrand(d.brand); S.appraisers=d.appraisers||[];
      if(S.demo){ S.mfilter="all"; demoBar(); }
      if(S.demo&&!S.provisioned){ render(); return api("POST","/api/demo/reset",{}).then(function(){ return api("GET","/api/session"); }).then(function(d2){ S.provisioned=d2.provisioned!==false; render(); }).catch(function(e){ S.boot="offline"; S.bootWhy=e.message; render(); }); }
      if(d.user) afterSignIn(d.user,d); else render();
    }).catch(function(e){ S.boot="offline"; S.bootWhy=e.message; render(); });
  }
  function loadClient(){
    return api("GET","/api/client/"+encodeURIComponent(S.token)).then(function(d){ S.client=d; S.config={timeZone:d.tz,slotMinutes:d.slotMinutes}; if(d.lender) applyBrand({name:d.lender.name,tagline:d.lender.tagline,logo:d.lender.logo,primary:d.lender.primary,accent:d.lender.accent,productName:"Appraisal Desk"}); S.boot="ready"; render(); })
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
  function mpill(st){ var m={sent:"Sent",queued:"Sending",manual:"Needs sending",failed:"Failed",portal:"Seen in portal",demo:"Composed (demo)"}; return '<span class="pill '+esc(st)+'">'+esc(m[st]||st)+'</span>'; }
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
    return "mailto:"+encodeURIComponent(m.to_addr||"")+"?subject="+encodeURIComponent(m.subject||(lender()+" appraisal update"))+"&body="+encodeURIComponent(m.body||"");
  }
  function smsto(m){
    var n=String(m.to_addr||"").replace(/[^\d+]/g,"");
    var ios=/iPhone|iPad|iPod/.test(navigator.userAgent||"");
    return "sms:"+n+(ios?"&":"?")+"body="+encodeURIComponent(m.body||"");
  }
  function msgActions(m){
    var a=[];
    if(m.status!=="sent"&&m.status!=="portal"&&m.status!=="demo"){
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

  function demoBar(){
    if(document.querySelector(".bar")) return;
    var bar=document.createElement("div"); bar.className="bar";
    bar.innerHTML='DEMONSTRATION <em>Sample people and orders. Nothing is sent to anyone. The data resets every night.</em>';
    document.body.insertBefore(bar,document.body.firstChild);
  }
  var DEMO_ROLES=[["desk","Appraisal desk","Place and manage orders","desk@fsbdemo.apprifi.com"],["appraiser","Appraiser","Accept, schedule, deliver","appraiser@fsbdemo.apprifi.com"],["officer","Loan officer","Watch status, download the report","officer@fsbdemo.apprifi.com"],["admin","Bank administrator","People and settings","admin@fsbdemo.apprifi.com"]];
  function demoSigninHtml(){
    return '<div class="signwrap"><div class="panel"><div class="ph"><div><h2>Try the portal</h2>'+
      '<p class="note">This is a demonstration copy with sample orders at every stage. Pick who you want to be. Everyone sees the same live data, so open two browser windows to watch a change made by one person appear for another.</p></div></div>'+
      '<div class="pb"><div class="stack-s">'+DEMO_ROLES.map(function(r){ return '<button class="btn btn-p" style="width:100%;justify-content:space-between;display:flex;text-align:left" data-demo="'+r[0]+'"><span><b>'+esc(r[1])+'</b><br><span style="font-weight:400;font-size:12.5px;opacity:.85">'+esc(r[2])+'</span></span><span aria-hidden="true">&rarr;</span></button>'; }).join("")+
      '<p class="sm muted" style="margin-top:6px">To see what a borrower sees, sign in as the appraiser, open 812 N Roosevelt Ave, and use the Messages tab: the text to the borrower carries their personal link. Open it on your phone.</p>'+
      '<p class="sm muted">Password for every demo account: <span class="mono">FSBdemo-2026</span>. Sign in at any time with the email addresses shown on the People tab.</p>'+
      '</div></div></div>'+brandline()+'</div>';
  }

  /* ---------- entry screens ---------- */
  function signinHtml(){
    if(S.boot==="loading") return '<div class="panel"><div class="empty"><b>One moment</b>Connecting.</div></div>';
    if(S.boot==="offline") return '<div class="panel"><div class="empty"><b>Cannot reach the server</b>'+esc(S.bootWhy||"")+'<div style="margin-top:10px"><button class="btn btn-s" data-a="retry">Try again</button></div></div></div>';
    if(S.demo&&!S.provisioned) return '<div class="panel"><div class="empty"><b>Loading the demonstration</b>Sample orders are being prepared. One moment.</div></div>';
    if(S.demo) return demoSigninHtml();
    if(!S.provisioned) return '<div class="signwrap"><div class="panel"><div class="ph"><div><h2>Not yet in service</h2>'+
      '<p class="note">This portal has been installed for '+esc(lender())+' but the lender has not yet designated its administrator. Once the lender names that person, they receive an invitation, set their password, and add everyone else.</p></div></div></div></div>';
    return '<div class="signwrap"><div class="panel"><div class="ph"><div><h2>Sign in</h2>'+
      '<p class="note">Access is granted by the portal administrator at '+esc(lender())+'. Use the email and password you chose from your invitation. Your role (appraisal desk, loan officer, appraiser or administrator) is assigned by the lender and decides which screens you see.</p></div></div>'+
      '<div class="pb"><form class="stack" id="signinForm">'+
      '<label class="f">Work email<input id="si_email" type="email" autocomplete="username" inputmode="email"></label>'+
      '<label class="f">Password<input id="si_pw" type="password" autocomplete="current-password"></label>'+
      '<div><button class="btn btn-p" type="submit" data-a="signin">Sign in</button></div>'+
      '<p class="sm muted">Forgot your password, or never received an invitation? Ask the portal administrator to issue a new sign-in link.</p>'+
      '</form></div></div>'+brandline()+'</div>';
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
        '<td class="sm muted" data-label="Last seen">'+esc(r.last_seen?fmtTime(r.last_seen):"never")+credWarn(r)+'</td>'+
        '<td><div class="row">'+(me?'<span class="sm muted">Your own account</span>':
          '<button class="btn btn-s" data-uinvite="'+esc(r.id)+'">New sign-in link</button>'+
          '<button class="btn btn-s" data-uactive="'+esc(r.id)+'" data-to="'+(r.active?"0":"1")+'">'+(r.active?"Suspend":"Restore")+'</button>')+'</div></td></tr>';
    }).join("");
    return '<div class="panel"><div class="ph"><div><h2>People</h2>'+
      '<p class="note">Everyone who can sign in, and what they may do. Adding someone produces a one-time sign-in link that lasts seven days; send it to them yourself. The same button resets a forgotten password.'+(S.demo?' In this demonstration every sample account uses the password FSBdemo-2026.':'')+'</p></div>'+
      '<button class="btn btn-p" data-a="addperson">Add someone</button></div>'+
      (rows?'<div class="tablewrap"><table><thead><tr><th>Person</th><th>Role</th><th>Status</th><th>Last seen</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div>':'<div class="empty"><b>Loading</b></div>')+
      '<div class="pb"><div class="callout"><b>Roles</b>'+Object.keys(ROLES).map(function(k){ return '<div style="margin-top:4px"><strong>'+esc(ROLES[k].name)+'.</strong> '+esc(ROLES[k].hint)+'</div>'; }).join("")+'</div></div></div>'+
      adminSettingsHtml()+
      (S.audit.length?'<div class="panel"><div class="ph"><div><h2>Administration record</h2><p class="note">Who changed access and settings.</p></div></div><div class="pb"><div class="log">'+S.audit.map(function(a){ return '<div><b>'+esc(fmtTime(a.at))+'</b>  '+esc(a.who)+'  &middot;  '+esc(a.what)+'</div>'; }).join("")+'</div></div></div>':'');
  }
  function credWarn(r){
    if(r.role!=="appraiser") return "";
    var out=[], soon=new Date(Date.now()+45*864e5).toISOString().slice(0,10), today=nowISO().slice(0,10);
    [["license_expires","License"],["eo_expires","E&O"]].forEach(function(k){ var d=r[k[0]]; if(!d) out.push('<span class="pill wait">'+k[1]+' date missing</span>'); else if(d<today) out.push('<span class="pill crit">'+k[1]+' expired '+esc(fmtDate(d))+'</span>'); else if(d<soon) out.push('<span class="pill manual">'+k[1]+' expires '+esc(fmtDate(d))+'</span>'); });
    return out.length?'<div class="row" style="margin-top:4px">'+out.join("")+'</div>':'';
  }
  function brandSettingsHtml(){
    var b=S.brand||{};
    return '<div class="panel"><div class="ph"><div><h2>Lender branding</h2><p class="note">How the portal presents itself to staff, borrowers and agents. Every message is sent in this name.</p></div>'+
      '<button class="btn btn-p btn-s" data-a="savebrand">Save</button></div><div class="pb"><div class="stack">'+
      '<div class="grid3"><label class="f">Lender name<input id="br_name" value="'+esc(b.name||"")+'"></label><label class="f">Short name<input id="br_short" value="'+esc(b.short||"")+'"></label><label class="f">Product name<input id="br_product" value="'+esc(b.productName||"Appraisal Desk")+'"></label></div>'+
      '<div class="grid2"><label class="f">Tagline or locations (shown under the logo and on client pages)<input id="br_tagline" value="'+esc(b.tagline||"")+'"></label><label class="f">Time zone<input id="br_tz" value="'+esc(b.timeZone||"America/Chicago")+'" placeholder="America/Chicago"></label></div>'+
      '<div class="grid3"><label class="f">Primary color<input id="br_primary" type="color" value="'+esc(b.primary||"#1f4984")+'"></label><label class="f">Accent color<input id="br_accent" type="color" value="'+esc(b.accent||"#790000")+'"></label>'+
      '<label class="f">Logo (PNG, JPG, SVG under 1 MB)<input id="br_logo" type="file" accept=".png,.jpg,.jpeg,.webp,.svg"></label></div>'+
      '</div></div></div>';
  }
  function adminSettingsHtml(){
    var c=S.config||CORE.defaultConfig(), list=c.deskCopyEmails||[];
    var email=S.providers.email?('<span class="pill ok">Email sending automatically'+(S.providers.emailVia==="cloudflare"?" via Cloudflare":"")+'</span>'):'<span class="pill manual">Email by hand from the Outbox</span>';
    var sms=S.providers.sms?'<span class="pill ok">Texts sending automatically</span>':'<span class="pill manual">Texts by hand (carrier registration pending)</span>';
    return brandSettingsHtml()+'<div class="panel"><div class="ph"><div><h2>Notifications</h2><p class="note">Who is copied on desk notices, and how messages leave the portal.</p></div>'+
      '<button class="btn btn-p btn-s" data-a="savebank">Save</button></div><div class="pb"><div class="stack">'+
      '<div class="row">'+email+sms+'</div>'+
      '<div><p class="lbl" style="margin-bottom:7px">Copy these addresses on every desk notice</p>'+
      '<p class="sm muted" style="margin-bottom:6px">Desk notices (accepted, scheduled, inspected, delivered, invoiced, holds, declines) always go to the person who placed the order. Add shared or manager addresses here to copy them too.</p>'+
      '<div>'+list.map(function(e){ return '<span class="dayoff">'+esc(e)+' <button type="button" data-copyoff="'+esc(e)+'" aria-label="Remove">&times;</button></span>'; }).join("")+'</div>'+
      '<div class="row" style="margin-top:6px"><input id="b_copy" type="email" placeholder="assistant@bank.com" style="max-width:280px"><button class="btn btn-s" data-a="addcopy">Add address</button></div></div>'+
      '</div></div></div>';
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
    var body="Hello "+name+",\n\nYou have been given access to the "+lender()+" Appraisal Desk. Open this link to choose your password (it works once and expires in "+days+" days):\n\n"+link+"\n\nAfter that, sign in at "+location.origin+location.pathname+" with your work email.";
    return '<div class="sheet" data-a="closesheet"><div class="sheetc" data-stop="1"><div class="stack">'+
      '<div><h2 style="font-size:17px">Sign-in link for '+esc(name)+'</h2><p class="sm muted" style="margin-top:3px">Send this to '+esc(email)+'. It works once and expires in '+days+' days. It is not shown again, but you can issue a new one at any time.</p></div>'+
      '<div class="invlink">'+esc(link)+'</div>'+
      '<div class="row"><button class="btn btn-p" data-copy="'+esc(link)+'" data-what="Link">Copy link</button>'+
      '<a class="btn" href="mailto:'+esc(encodeURIComponent(email))+'?subject='+esc(encodeURIComponent("Your "+lender()+" Appraisal Desk sign-in"))+'&body='+esc(encodeURIComponent(body))+'">Send by email</a>'+
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
      if(f==="unpaid"&&!(o.step===7&&!o.paid)) return false;
      if(f==="mine"&&!(S.me&&o.assignedTo===S.me.id)) return false;
      if(q){ var hay=[o.addr,o.city,o.loan,o.borrowerName,o.agentName,o.type,o.id,o.officerName].join(" ").toLowerCase(); if(hay.indexOf(q)===-1) return false; }
      return true;
    });
  }
  function filtersHtml(){
    var fs=[["active","Active"],["attention","Needs attention"],["delivered","Delivered"],["unpaid","Awaiting payment"],["closed","Closed"],["all","All"]];
    if(S.me&&S.me.role==="appraiser"&&S.appraisers.length>1) fs.splice(1,0,["mine","Mine"]);
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
        '<td class="sm" data-label="Type">'+esc(o.type)+(S.appraisers.length>1?'<br><span class="muted">'+esc(o.assignedName||"Unassigned")+'</span>':'')+'</td>'+
        '<td class="sm" data-label="Borrower">'+esc(o.borrowerName||"")+'</td>'+
        '<td data-label="Status">'+rail(o)+pill(o)+(o.unsent?'<span class="pill manual" title="Messages waiting to be sent by hand">'+o.unsent+' to send</span>':'')+'</td>'+
        '<td class="mono sm'+(late?'" style="color:var(--red);font-weight:700':'')+'" data-label="Due">'+esc(fmtDate(o.due))+(late?" late":"")+(o.etaDate&&CORE.isOpen(o)&&o.step<6?'<br><span class="muted">ETA '+esc(fmtDate(o.etaDate))+'</span>':'')+'</td></tr>';
    }).join("");
    return head+'<div class="tablewrap"><table><thead><tr><th>Property</th><th>Order</th><th>Type</th><th>Borrower</th><th>Status</th><th>Due</th></tr></thead><tbody>'+rows+'</tbody></table></div></div>';
  }

  /* ---------- order detail ---------- */
  function docsHtml(o){
    var docs=o.docs||[], canUp=can("docs")&&!o.cancelled, role=S.me.role;
    var list=docs.length? docs.map(function(d){
      var kind=d.uploaded_role==="client"?"From the client":(DOC_KINDS[d.kind]||DOC_KINDS.other).name;
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
      else if(o.step===5&&o.revision&&!o.revision.resolvedAt) nextc='<div class="callout warn"><b>Revision '+o.revision.n+' requested</b> by '+esc(o.revision.by)+' on '+esc(fmtTime(o.revision.requestedAt))+' ('+esc(o.revision.kind)+'): '+esc(o.revision.text)+'</div>';
      else if(o.step===5&&o.review&&o.review.status==="sent") nextc='<div class="callout"><b>With the reviewer</b> ('+esc(o.review.name||"reviewing appraiser")+') since '+esc(fmtTime(o.review.sentAt))+(o.review.eta?', expected back '+esc(fmtDate(o.review.eta)):'')+'.</div>';
      else if(o.step===5&&o.review&&o.review.status==="returned") nextc='<div class="callout"><b>Reviewer returned comments</b>'+(o.review.comments?': '+esc(o.review.comments):'.')+' Revise and record the sign-off.</div>';
      else if(o.step===6) nextc='<div class="callout"><b>Report delivered.</b> The borrower copy '+((o.consent&&o.consent.borrower)?'was opened electronically on '+esc(fmtTime(o.consent.borrower.at))+'.':'has not been opened yet; if they do not, provide a paper copy.')+'</div>';
      else if(o.step===7&&o.paid) nextc='<div class="callout"><b>Paid.</b> '+esc(money(o.paid.amount))+' by '+esc(o.paid.method)+(o.paid.ref?', reference '+esc(o.paid.ref):'')+', recorded '+esc(fmtTime(o.paid.at))+' by '+esc(o.paid.by)+'.</div>';
      else if(o.step===7) nextc='<div class="callout"><b>Invoiced.</b> Record the payment here when it goes out so the appraiser stops asking.</div>';
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
        '<dt>Fee</dt><dd class="mono">'+(o.fee?money(o.fee):"not quoted")+'</dd>'+
        '<dt>Needed by</dt><dd class="mono">'+esc(fmtDate(o.due))+(o.rush?' <span class="flag">Rush</span>':'')+(o.closingDate?'<span class="tiny">Closing '+esc(fmtDate(o.closingDate))+'</span>':'')+(o.earliestInspection?'<span class="tiny">Inspect on or after '+esc(fmtDate(o.earliestInspection))+'</span>':'')+'</dd>'+
        (o.etaDate?'<dt>Committed</dt><dd class="mono">'+esc(fmtDate(o.etaDate))+'</dd>':'')+appt+
        '<dt>Appraiser</dt><dd>'+esc(o.assignedName||o.appraiserName||"Unassigned")+(can("assign")&&S.appraisers.length>1&&o.step<6&&CORE.isOpen(o)?'<span class="tiny"><button class="btn btn-s" style="margin-top:4px" data-a="assign">'+(o.assignedTo?"Reassign":"Assign")+'</button></span>':'')+'</dd>'+
        ((o.loanType||o.premise||o.propertyType||o.occupancy)?'<dt>Assignment</dt><dd>'+esc([o.loanType,o.propertyType&&(o.propertyType+(o.units?" ("+o.units+" units)":"")),o.occupancy].filter(Boolean).join(" · "))+(o.premise?'<span class="tiny">'+esc(o.premise)+'</span>':'')+(o.deliveryFormat&&o.deliveryFormat!=="PDF"?'<span class="tiny">'+esc(o.deliveryFormat)+'</span>':'')+'</dd>':'')+
        ((o.pins||o.refNo)?'<dt>References</dt><dd class="sm">'+(o.refNo?'Ref '+esc(o.refNo):'')+(o.pins?'<span class="tiny mono">PIN '+esc(o.pins)+'</span>':'')+'</dd>':'')+
        (o.groupRef?'<dt>Group</dt><dd class="sm">'+esc(o.groupRef)+(o.combinedReport?'<span class="tiny">Combined report and invoice</span>':'')+'</dd>':'')+
        (o.prelim?'<dt>Preliminary</dt><dd class="sm">'+(o.prelim.value?esc(money(o.prelim.value)):'fee only')+'<span class="tiny">released '+esc(fmtTime(o.prelim.at))+'</span></dd>':'')+
        (o.docRequest?'<dt>Docs requested</dt><dd class="sm">'+esc(o.docRequest.items)+'<span class="tiny">'+esc(fmtTime(o.docRequest.at))+'</span></dd>':'')+
      '</dl>'+links+
      (o.accessNotes?'<div class="msg"><b>Access</b><div>'+esc(o.accessNotes)+'</div></div>':"")+
      (o.intendedUse?'<div class="msg"><b>Intended use and requirements</b><div style="white-space:pre-wrap">'+esc(o.intendedUse)+'</div></div>':"")+
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
        '<label class="f">Your reference (file or order number)<input id="'+p+'_ref" value="'+g("refNo")+'"></label>'+
        '<label class="f">Parcel numbers (PIN)<input id="'+p+'_pins" placeholder="07-14-302-011, 07-14-302-012" value="'+g("pins")+'"></label></div>'+
      '<div class="grid3">'+
        '<label class="f">Product'+sel(p+"_type",CORE.REPORT_TYPES,o.type||CORE.REPORT_TYPES[0])+'</label>'+
        '<label class="f">Purpose'+sel(p+"_purpose",CORE.PURPOSES,o.purpose||"Purchase")+'</label>'+
        '<label class="f">Loan type'+sel(p+"_loantype",[""].concat(CORE.LOAN_TYPES),o.loanType||"")+'</label></div>'+
      '<div class="grid3">'+
        '<label class="f">Property type'+sel(p+"_ptype",[""].concat(CORE.PROPERTY_TYPES),o.propertyType||"")+'</label>'+
        '<label class="f">Units<input id="'+p+'_units" type="number" inputmode="numeric" min="0" max="500" value="'+(o.units?esc(o.units):"")+'"></label>'+
        '<label class="f">Occupancy'+sel(p+"_occ",[""].concat(CORE.OCCUPANCY),o.occupancy||"")+'</label></div>'+
      '<div class="grid3">'+
        '<label class="f">Valuation premise'+sel(p+"_premise",CORE.PREMISES,o.premise||"As is")+'</label>'+
        '<label class="f">Delivery format'+sel(p+"_fmt",CORE.DELIVERY_FORMATS,o.deliveryFormat||"PDF")+'</label>'+
        '<label class="f">Rush?<select id="'+p+'_rush"><option'+(o.rush?"":" selected")+'>No</option><option'+(o.rush?" selected":"")+'>Yes</option></select></label></div>'+
      '<div class="grid3">'+
        '<label class="f">Closing or target date<input id="'+p+'_closing" type="date" value="'+g("closingDate")+'"></label>'+
        '<label class="f">Report needed by<input id="'+p+'_due" type="date" value="'+g("due")+'"></label>'+
        '<label class="f">Earliest inspection date<input id="'+p+'_earliest" type="date" value="'+g("earliestInspection")+'"></label></div>'+
      '<div class="grid3">'+
        '<label class="f">Fee, if agreed<input id="'+p+'_fee" type="number" inputmode="decimal" placeholder="Leave blank for the appraiser to quote" value="'+(o.fee?esc(o.fee):"")+'"></label>'+
        (S.appraisers.length>1?'<label class="f">Assign to'+sel(p+"_assign",[""].concat(S.appraisers.map(function(a){ return a.name; })),o.assignedName||"")+'</label>':'<div></div>')+
        '<label class="f">Part of a multi-property order? Group reference<input id="'+p+'_group" placeholder="Same reference on each property" value="'+g("groupRef")+'"></label></div>'+
      '<label class="chk"><input type="checkbox" id="'+p+'_combined"'+(o.combinedReport?" checked":"")+'>Properties in this group should be combined into one report and one invoice</label>'+
      '<label class="f">Intended use and any lender requirements<textarea id="'+p+'_use" placeholder="Intended use, intended users, engagement wording, lender-specific requirements">'+g("intendedUse")+'</textarea></label>'+
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
      '<div class="grid2"><label class="f">Access notes (gate code, dog, tenant, lockbox)<input id="'+p+'_accessnotes" value="'+g("accessNotes")+'"></label><div></div></div>'+
      '<label class="f">Notes for the appraiser<textarea id="'+p+'_notes" placeholder="Anything else the appraiser should know.">'+g("notes")+'</textarea></label>';
  }
  function readOrderForm(p){
    var asg=S.appraisers.filter(function(a){ return a.name===val(p+"_assign"); })[0];
    return {addr:val(p+"_addr"),city:val(p+"_city"),loan:val(p+"_loan"),type:val(p+"_type"),purpose:val(p+"_purpose"),due:val(p+"_due"),fee:Number(val(p+"_fee"))||0,rush:val(p+"_rush")==="Yes",
      borrowerName:val(p+"_bname"),borrowerPhone:val(p+"_bphone"),borrowerEmail:val(p+"_bemail"),agentName:val(p+"_aname"),agentPhone:val(p+"_aphone"),agentEmail:val(p+"_aemail"),
      accessVia:val(p+"_access"),officerName:val(p+"_oname"),officerEmail:val(p+"_oemail"),notes:val(p+"_notes"),
      refNo:val(p+"_ref"),pins:val(p+"_pins"),loanType:val(p+"_loantype"),propertyType:val(p+"_ptype"),units:Number(val(p+"_units"))||0,occupancy:val(p+"_occ"),premise:val(p+"_premise"),
      deliveryFormat:val(p+"_fmt"),closingDate:val(p+"_closing"),earliestInspection:val(p+"_earliest"),groupRef:val(p+"_group"),combinedReport:!!($(p+"_combined")&&$(p+"_combined").checked),
      intendedUse:val(p+"_use"),accessNotes:val(p+"_accessnotes"),assignedTo:asg?asg.id:""};
  }
  function newOrderHtml(){
    return '<div class="panel"><div class="ph"><div><h2>New order</h2><p class="note">One page, not a wizard. The appraiser is notified the moment you place it. You can edit it until the inspection happens, and cancel it until the report is delivered.</p></div>'+
      '<button class="btn btn-s" data-a="goboard">Cancel</button></div>'+
      '<div class="pb"><div class="stack">'+orderForm(null,"n")+
      '<label class="att" for="n_att"><input type="checkbox" id="n_att"><span class="t"><b>Required before this order can be placed</b>I will abstain from participating in any decision to approve, not approve, or set the terms of this transaction. This attestation is timestamped, tied to my account, and cannot be edited afterward.</span></label>'+
      '<div class="callout" id="prodhint"></div>'+
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
      '<p class="sm muted" style="margin-top:7px">'+esc(lender())+' is always the sender. This is the person a borrower reaches about access and timing.'+(S.me.role==="appraiser"?' These settings are yours; each appraiser has their own calendar.':' This is the default calendar; each appraiser can override it with their own.')+'</p></div>'+
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
    var prov=S.demo?'<div class="callout"><b>Demonstration.</b> These are the real texts and emails the portal composes at each step, addressed to the sample people. In this copy nothing is delivered; in service they send automatically, and the appraiser and the desk are copied on the notices meant for them.</div>':'<div class="callout'+(S.providers.email?"":" warn")+'"><b>Email: '+(S.providers.email?("sending automatically"+(S.providers.emailVia==="cloudflare"?" through Cloudflare Email Service.":".")):"not connected yet.")+'</b> '+(S.providers.email?"Queued messages go out within a few seconds and retry for up to half an hour if the mail service is down.":"Until the mail service key is added, every email below has an \"Open in email app\" button that drafts it in Outlook or Gmail for you; press send there, then mark it sent here.")+
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
    if(c.error) return '<div class="clientwrap"><div class="panel"><div class="empty"><b>This link is not valid</b>It may have expired, or the file may be closed. Call your loan officer and they can send you a new one.</div></div></div>';
    var isAgent=c.party==="agent", aprName=c.appraiser.name||"The appraiser", slotM=c.slotMinutes||60;
    var LN=(c.lender&&c.lender.name)||lender();
    var contact=c.appraiser.phone?("Questions? Call "+(c.appraiser.name||"the appraiser")+" at "+c.appraiser.phone+"."):("Questions? Contact your loan officer at "+LN+".");
    var vst=STEPS.map(function(st,i){ var cls=i<c.step?"done":(i===c.step?"now":""); return '<li class="'+cls+'"><span class="nd">'+(i<c.step?"&#10003;":"")+'</span><span class="t">'+esc(CLIENT_LABEL[st])+'</span></li>'; }).join("");
    var action;
    if(c.cancelled) action='<div class="nextc"><h4>No longer needed</h4><p>'+esc(LN)+' has closed this appraisal request. Nothing is needed from you.</p></div>';
    else if(c.declined) action='<div class="nextc"><h4>With the lender</h4><p>'+esc(LN)+' is arranging your appraisal. Nothing is needed from you right now.</p></div>';
    else if(c.hold) action='<div class="nextc"><h4>Waiting on property access</h4><p>'+esc(aprName)+' needs access arranged before the inspection can happen. Nothing is needed from you right now.</p></div>';
    else if(c.step===2) action='<div class="stack-s"><h4 class="calhead">Choose your inspection time</h4><p class="sm muted" style="margin-bottom:2px">About '+esc(slotM)+' minutes. Pick whatever suits you.</p>'+slotCal(c.slots)+'<button class="btn btn-s" data-a="noslot" style="margin-top:8px">None of these work for me</button></div>';
    else if(c.step===3) action='<div class="nextc"><h4>Your inspection is booked</h4><p class="mono" style="color:var(--ink);font-weight:700;font-size:14px;margin:5px 0 7px">'+esc(fmtDay(c.apptStart))+', '+esc(fmtHr(c.apptStart))+'</p>'+
        '<p>'+esc(aprName)+' will need to see every room, the basement, the attic access and the garage, and will photograph each room. About '+esc(slotM)+' minutes.</p>'+
        '<p class="sm muted" style="margin-top:7px">This is not a home inspection, and nothing needs tidying. It does not affect the value.</p>'+
        '<div class="row" style="margin-top:10px"><a class="btn btn-s" href="/api/client/'+esc(S.token)+'/appointment.ics" download="appraisal-inspection.ics">Add to calendar</a><button class="btn btn-s" data-a="reschedule">Change this time</button></div></div>';
    else if(c.step>=6) action='<div class="nextc"><h4>Your appraisal is ready</h4><p>A copy is available to you at no charge.</p>'+
        (c.report?(c.consent?'<div style="margin-top:10px"><a class="btn btn-p btn-s" href="/f/'+esc(c.orderId)+'/'+esc(c.report.id)+'?t='+esc(S.token)+'" download="'+esc(c.report.name)+'">Download my copy</a></div>'
          :'<div class="stack-s" style="margin-top:10px"><label class="chk"><input type="checkbox" id="consent">I agree to receive my appraisal copy electronically through this page instead of on paper. I can ask '+esc(LN)+' for a paper copy at no charge at any time.</label><div><button class="btn btn-p btn-s" data-a="consent">Continue to my copy</button></div></div>')
          :'<p class="sm muted" style="margin-top:8px">Your loan officer will provide your copy.</p>')+'</div>';
    else if(c.step<=1) action='<div class="nextc"><h4>Nothing to do yet</h4><p>'+esc(aprName)+' will send a link to choose an inspection time. You will get a text and an email.</p></div>';
    else action='<div class="nextc"><h4>Nothing to do right now</h4><p>Your report is being prepared. You will hear from '+esc(LN)+' when it is delivered.</p></div>';
    var uploads='';
    if(c.docRequest||(c.uploaded&&c.uploaded.length)){
      uploads='<div class="stack-s" style="margin-top:14px"><h4 class="calhead">Documents for the appraiser</h4>'+(c.docRequest?'<p class="sm">'+esc(c.appraiser.name||"The appraiser")+' has asked for: <b>'+esc(c.docRequest)+'</b></p>':'')+
        ((c.uploaded||[]).length?'<p class="sm muted">Received: '+c.uploaded.map(function(u){ return esc(u.name); }).join(", ")+'</p>':'')+
        (!c.cancelled&&c.step<6?'<button type="button" class="drop"><b>Tap to choose files</b><span>PDF, photos, Word or Excel. 20 MB each.</span><input type="file" class="vh" multiple accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,.docx,.xlsx,.csv,.txt"></button>':'')+'</div>';
    }
    return '<div class="clientwrap"><div class="panel"><div class="pb">'+
      '<p class="lbl">Appraisal status'+(isAgent?' &middot; listing agent':'')+'</p><h2 style="font-size:19px;margin-top:3px">'+esc(c.addr)+'</h2><p class="sm muted">'+esc(c.city)+'</p>'+
      '<ul class="vst" style="margin-top:14px">'+vst+'</ul><div style="margin-top:14px">'+action+'</div>'+uploads+
      '<p class="sm muted" style="margin-top:16px;line-height:1.5">'+esc(contact)+' This link is personal to '+esc(c.who)+' and stops working when the file closes.</p>'+
      '</div></div><p class="sm muted" style="text-align:center;margin-top:12px">'+esc(LN)+((c.lender&&c.lender.tagline)?' &middot; '+esc(c.lender.tagline):'')+'</p></div>';
  }

  /* ---------- render ---------- */
  function connChip(){ return ''; }
  function render(){
    var stage=$("stage"), nav=$("views"), who=$("whochip"), fbtn=$("fbtn");
    var band=document.querySelector(".band"), mast=document.querySelector(".mast"), foot=document.querySelector("footer");
    if(S.token){
      band.hidden=true; mast.hidden=true; foot.hidden=true; nav.innerHTML=""; who.innerHTML=""; fbtn.hidden=true;
      stage.innerHTML=clientPageHtml(); wireDrop(); return;
    }
    band.hidden=false; mast.hidden=false; foot.hidden=false;
    if(S.inviteCode){ nav.innerHTML='<button role="tab" aria-selected="true" disabled>Welcome</button>'; who.innerHTML=""; fbtn.hidden=true; stage.innerHTML=inviteHtml(); return; }
    if(!S.me){
      nav.innerHTML='<button role="tab" aria-selected="true" disabled>Sign in</button>'; who.innerHTML=""; fbtn.hidden=true;
      stage.innerHTML=signinHtml();
      var f=stage.querySelector("input"); if(f&&S.boot==="ready") try{ f.focus(); }catch(e){}
      return;
    }
    fbtn.hidden=false;
    who.innerHTML='<button class="chip act" data-a="menu" aria-haspopup="true" aria-expanded="'+S.menu+'"><b>'+esc(S.me.name)+'</b> &middot; '+esc((ROLES[S.me.role]||{}).name||S.me.role)+'</button>'+
      (S.menu?'<div class="menu" data-stop="1">'+(S.me.role==="appraiser"?'<button data-a="myprofile">My profile and credentials</button>':'')+(S.demo?'<button data-a="demoreset">Reset the demonstration</button>':'<button data-a="changepw">Change my password</button>')+'<button data-a="signout">Sign out</button></div>':'');
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
    wireDrop(); prodHint();
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
    if(S.token){
      var cl=Array.prototype.slice.call(files||[]); if(!cl.length) return;
      var cfd=new FormData(); cl.forEach(function(f){ cfd.append("file",f,f.name); });
      toast("Uploading.");
      api("POST","/api/client/"+encodeURIComponent(S.token)+"/docs",cfd,true).then(function(d){ toast("<b>"+esc(d.reply)+"</b>"); return loadClient(); }).catch(fail); return;
    }
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
      '<p class="sm muted">The desk is notified with your fee and delivery date, and the borrower gets their status link by text and email. If the date they need is not workable, say so in the note or decline with the reason.</p>'+
      '<div class="grid2"><label class="f">Fee<input id="a_fee" type="number" inputmode="decimal" value="'+(o.fee||"")+'" placeholder="Quote"></label>'+
      '<label class="f">Expected delivery<input id="a_eta" type="date" value="'+esc(o.etaDate||o.due||"")+'"></label></div>'+
      (o.due||o.closingDate?'<p class="sm">Needed by <b>'+esc(fmtDate(o.due))+'</b>'+(o.closingDate?', closing '+esc(fmtDate(o.closingDate)):'')+(o.rush?' <span class="flag">Rush</span>':'')+'.</p>':'')+
      '<label class="f">Note to the desk, optional<input id="a_note" placeholder="Example: fee assumes as-is; construction draw not included"></label>',
      "Accept order","doaccept",' data-from="'+from+'"'));
    if(a==="sendreview") return modal(sheet("Send to reviewer",'<p class="sm muted">Tells the desk the report is complete and with a reviewing or supervising appraiser, so nobody has to ask.</p><div class="grid2"><label class="f">Reviewer<input id="rv_name" placeholder="Name"></label><label class="f">Expected back<input id="rv_eta" type="date"></label></div><label class="f">Note, optional<input id="rv_note"></label>',"Record","dosendreview"));
    if(a==="reviewback") return modal(sheet("Reviewer comments",'<label class="f">What came back<textarea id="rv_text" placeholder="Page references and corrections"></textarea></label>',"Record","doreviewback"));
    if(a==="reviewsigned") return act(o,"reviewsigned",{},from);
    if(a==="prelim") return modal(sheet("Release preliminary figures",'<p class="sm muted">For the lender\'s closing figures only. The record shows they were released before the signed report, which controls.</p><div class="grid2"><label class="f">Fee<input id="pl_fee" type="number" inputmode="decimal" value="'+(o.fee||"")+'"></label><label class="f">Preliminary value, optional<input id="pl_value" type="number" inputmode="decimal"></label></div>',"Release to the desk","doprelim"));
    if(a==="revise") return modal(sheet("Request a revision",'<p class="sm muted">The appraiser is notified and the file goes back to In review until the revised report is delivered.</p><label class="f">Kind'+sel("rv_kind",CORE.REVISION_KINDS,CORE.REVISION_KINDS[0])+'</label><label class="f">What needs to change<textarea id="rv_req" placeholder="Page, item and the correction needed"></textarea></label>',"Send request","dorevise"));
    if(a==="paid") return modal(sheet("Record payment",'<div class="grid3"><label class="f">Amount<input id="py_amt" type="number" inputmode="decimal" value="'+(o.fee||"")+'"></label><label class="f">Method'+sel("py_method",CORE.PAY_METHODS,"Check")+'</label><label class="f">Check or reference number<input id="py_ref"></label></div>',"Record","dopaid"));
    if(a==="docreq") return modal(sheet("Request documents from "+CORE.contactName(o),'<p class="sm muted">They get a text and an email with an upload link on their status page; what they send lands on the Documents tab.</p><label class="f">What you need<textarea id="dq_items" placeholder="Current leases, last twelve months of expenses, insurance declaration">'+esc((CORE.PRODUCTS.filter(function(x){ return x.name===o.type; })[0]||{}).needs||"")+'</textarea></label>',"Send request","dodocreq"));
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
    var body={deskCopyEmails:c.deskCopyEmails||[],days:c.days||[],daysOff:c.daysOff||[],startHour:Number(val("c_start"))||8.5,endHour:Number(val("c_end"))||16,slotMinutes:Number(val("c_slot"))||60,
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
  function prodHint(){ var h=$("prodhint"), t=val("n_type"); if(!h) return; var pr=CORE.PRODUCTS.filter(function(x){ return x.name===t; })[0]; h.innerHTML=pr?('<b>'+esc(pr.name)+'.</b> '+(pr.xml?'Usually delivered with an XML (UAD) file. ':'')+(pr.needs?('The appraiser will need: '+esc(pr.needs)):'')):''; }
  document.addEventListener("change",function(e){ if(e.target&&e.target.id==="n_type") prodHint(); });
  document.addEventListener("keydown",function(e){ if(e.key==="Escape"){ if($("modal").innerHTML){ modal(""); } if(S.menu){ S.menu=false; render(); } } });

  document.addEventListener("click",function(e){
    var t=e.target.closest("[data-stop],[data-a],[data-v],[data-open],[data-tab],[data-adv],[data-slot],[data-day],[data-dayoff],[data-copy],[data-copyoff],[data-filter],[data-mfilter],[data-msent],[data-mretry],[data-uinvite],[data-uactive],[data-dvis],[data-ddel],[data-demo]");
    if(S.menu&&!(t&&t.dataset.a==="menu")&&!(t&&t.dataset.stop)){ S.menu=false; render(); if(!t) return; t=e.target.closest("[data-a],[data-v],[data-open],[data-tab],[data-adv],[data-slot],[data-day],[data-dayoff],[data-copy],[data-copyoff],[data-filter],[data-mfilter],[data-msent],[data-mretry],[data-uinvite],[data-uactive],[data-dvis],[data-ddel]"); if(!t) return; }
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

    if(t.dataset.demo){ var dr=DEMO_ROLES.filter(function(x){ return x[0]===t.dataset.demo; })[0]; if(!dr||S.busy) return; S.busy=true;
      api("POST","/api/login",{email:dr[3],password:"FSBdemo-2026"}).then(function(d){ return api("GET","/api/session").then(function(sd){ afterSignIn(d.user,sd); toast("You are <b>"+esc(d.user.name)+"</b>, "+esc(ROLES[d.user.role].name.toLowerCase())+"."); }); }).catch(fail).then(function(){ S.busy=false; }); return; }
    if(a==="demoreset"){ if(!confirm("Reload the sample data? Everything anyone changed in the demonstration goes back to the starting point and you will be signed out.")) return; api("POST","/api/demo/reset",{}).then(function(){ location.reload(); }).catch(fail); return; }
    if(a==="menu"){ S.menu=!S.menu; render(); return; }
    if(a==="closesheet"){ modal(""); return; }
    if(a==="retry"){ S.boot="loading"; render(); boot(); return; }
    if(a==="signin"){ submitSignin(); return; }
    if(a==="acceptinvite"){ acceptInvite(); return; }
    if(a==="signout"){ api("POST","/api/logout",{}).catch(function(){}).then(function(){ S.me=null; S.sel=null; S.orders=[]; S.detail={}; S.menu=false; S.lastSync=""; S.filter="active"; S.q=""; S.view="board"; render(); }); return; }
    if(a==="changepw"){ modal(sheet("Change my password",'<label class="f">Current password<input id="cp_cur" type="password" autocomplete="current-password"></label><label class="f">New password (10 characters or more)<input id="cp_new" type="password" autocomplete="new-password"></label>',"Change","dochangepw")); return; }
    if(a==="dochangepw"){ api("POST","/api/password",{current:($("cp_cur")||{}).value||"",next:($("cp_new")||{}).value||""}).then(function(){ modal(""); toast("Password changed."); }).catch(fail); return; }
    if(a==="addperson"){ modal(personSheet()); return; }
    if(a==="addcopy"){ var ce=val("b_copy").toLowerCase(); if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ce)){ toast("Enter a valid email address."); return; } S.config=S.config||CORE.defaultConfig(); S.config.deskCopyEmails=S.config.deskCopyEmails||[]; if(S.config.deskCopyEmails.indexOf(ce)===-1) S.config.deskCopyEmails.push(ce); var bi=$("b_copy"); if(bi) bi.value=""; render(); return; }
    if(t.dataset.copyoff){ S.config.deskCopyEmails=(S.config.deskCopyEmails||[]).filter(function(x){ return x!==t.dataset.copyoff; }); render(); return; }
    if(a==="savebrand"){ var body={name:val("br_name"),short:val("br_short"),productName:val("br_product"),tagline:val("br_tagline"),timeZone:val("br_tz"),primary:val("br_primary"),accent:val("br_accent")};
      var lf=$("br_logo"); var pr=api("PUT","/api/brand",body);
      if(lf&&lf.files&&lf.files[0]){ var bfd=new FormData(); bfd.append("file",lf.files[0],lf.files[0].name); pr=pr.then(function(){ return api("POST","/api/brand/logo",bfd,true); }); }
      pr.then(function(d){ applyBrand(d.brand); render(); toast("Branding saved."); }).catch(fail); return; }
    if(a==="savebank"){ var cc=S.config||CORE.defaultConfig(); api("PUT","/api/config",cc).then(function(d){ S.config=d.config; render(); toast("Bank settings saved."); }).catch(fail); return; }
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
    if(a==="dosendreview"){ if(!o) return; act(o,"sendreview",{name:val("rv_name"),eta:val("rv_eta"),note:val("rv_note")}); return; }
    if(a==="doreviewback"){ if(!o) return; act(o,"reviewback",{text:val("rv_text")}); return; }
    if(a==="doprelim"){ if(!o) return; act(o,"prelim",{fee:val("pl_fee"),value:Number(val("pl_value"))||0}); return; }
    if(a==="dorevise"){ if(!o) return; var rt=val("rv_req"); if(!rt){ toast("Describe the revision."); return; } act(o,"revise",{kind:val("rv_kind"),text:rt}); return; }
    if(a==="dopaid"){ if(!o) return; act(o,"paid",{amount:Number(val("py_amt"))||0,method:val("py_method"),ref:val("py_ref")}); return; }
    if(a==="dodocreq"){ if(!o) return; var di=val("dq_items"); if(!di){ toast("List what you need."); return; } act(o,"docreq",{items:di}); return; }
    if(a==="assign"){ if(!o) return; modal(sheet((o.assignedTo?"Reassign":"Assign")+" this order",'<p class="sm muted">The appraiser is notified. Their own calendar is used for booking.</p><label class="f">Appraiser'+sel("as_who",S.appraisers.map(function(x){ return x.name; }),o.assignedName||"")+'</label>',"Assign","doassign")); return; }
    if(a==="doassign"){ if(!o) return; var aw=S.appraisers.filter(function(x){ return x.name===val("as_who"); })[0]; if(!aw){ toast("Pick an appraiser."); return; } act(o,"assign",{userId:aw.id,name:aw.name}); return; }
    if(a==="myprofile"){ api("GET","/api/me").then(function(d){ var m=d.me; modal(sheet("My profile",'<p class="sm muted">Your license and insurance dates are shown to the administrator, who is warned before they lapse.</p><div class="grid2"><label class="f">Mobile<input id="mp_phone" value="'+esc(m.phone||"")+'"></label><label class="f">License number<input id="mp_lic" value="'+esc(m.license_no||"")+'"></label></div><div class="grid3"><label class="f">License state<input id="mp_state" value="'+esc(m.license_state||"")+'"></label><label class="f">License expires<input id="mp_licexp" type="date" value="'+esc(m.license_expires||"")+'"></label><label class="f">E&amp;O expires<input id="mp_eoexp" type="date" value="'+esc(m.eo_expires||"")+'"></label></div><label class="f">E&amp;O carrier<input id="mp_eo" value="'+esc(m.eo_carrier||"")+'"></label>',"Save","domyprofile")); }).catch(fail); return; }
    if(a==="domyprofile"){ api("PATCH","/api/me",{phone:val("mp_phone"),licenseNo:val("mp_lic"),licenseState:val("mp_state"),licenseExpires:val("mp_licexp"),eoExpires:val("mp_eoexp"),eoCarrier:val("mp_eo")}).then(function(){ modal(""); toast("Profile saved."); }).catch(fail); return; }
    if(a==="editorder"){ if(!o) return; modal('<div class="sheet" data-a="closesheet"><div class="sheetc" data-stop="1" style="max-width:820px"><div class="stack"><div><h2 style="font-size:17px">Edit order</h2><p class="sm muted" style="margin-top:3px">Every change is written to the record. If a contact detail changes after messages went out, resend the link.</p></div>'+orderForm(o,"e")+'<div class="row"><button class="btn btn-p" data-a="doedit">Save changes</button><button class="btn" data-a="closesheet">Cancel</button></div></div></div></div>'); return; }
    if(a==="doedit"){ if(!o) return; var eb=readOrderForm("e"); if(!eb.addr){ toast("A property address is required."); return; } act(o,"edit",eb); return; }
    if(a==="reissue"){ if(!o) return; if(!confirm("Issue new client links? The old links stop working immediately. Use this if a link was sent to the wrong person.")) return; act(o,"reissue",{}); return; }
    if(a==="dohold"){ if(!o) return; act(o,"hold",{reason:val("h_reason"),note:val("h_note")},Number(t.dataset.from)); return; }
    if(a==="dodecline"){ if(!o) return; act(o,"decline",{reason:val("d_reason"),note:val("d_note")},Number(t.dataset.from)); return; }
    if(a==="docancel"){ if(!o) return; act(o,"cancel",{reason:val("x_reason"),note:val("x_note")},Number(t.dataset.from)); return; }
    if(a==="doaccept"){ if(!o) return; act(o,"accept",{fee:val("a_fee"),etaDate:val("a_eta"),note:val("a_note")},Number(t.dataset.from)); return; }
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
