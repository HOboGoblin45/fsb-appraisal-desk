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
    admin:{name:"Lender admin",hint:"Manages who can sign in and what they may do. Sees every order. Does not place orders."},
    desk:{name:"Appraisal desk",hint:"Loan officer assistant. Places, edits and cancels orders, uploads documents, sends questions."},
    officer:{name:"Loan officer",hint:"Read only. Sees status, downloads the finished report. Cannot touch the order, which keeps the independence record clean."},
    appraiser:{name:"Appraiser",hint:"Accepts, schedules, inspects, delivers the report and invoice, sets availability."}
  };
  /* Who the client is. Lenders need the recusal attestation and lending vocabulary; estate attorneys and wealth
     managers order the same appraisals for estates, trusts, gifting and planning, with their own titles and no
     credit decision to recuse from. The four roles keep their keys; only their names, hints and wording change. */
  var CLIENT_TYPES = {
    lender:{key:"lender",word:"lender",staff:"loan officer",refLabel:"Loan number",refHint:"2026-004417",attest:true,
      roles:{admin:["Lender admin","Manages who can sign in and what they may do. Sees every order. Does not place orders."],
             desk:["Appraisal desk","Loan officer assistant. Places, edits and cancels orders, uploads documents, sends questions."],
             officer:["Loan officer","Read only. Sees status, downloads the finished report. Cannot touch the order, which keeps the independence record clean."]},
      deliveredLabel:"Report delivered to your lender",recordName:"independence record",recordTitle:"APPRAISER INDEPENDENCE RECORD"},
    firm:{key:"firm",word:"attorney's office",staff:"attorney",refLabel:"Matter or file number",refHint:"2026-EST-0117",attest:false,
      roles:{admin:["Firm administrator","Manages who can sign in and what they may do. Sees every matter. Does not place orders."],
             desk:["Paralegal","Places, edits and cancels orders, uploads documents, keeps the appraiser supplied with what they need."],
             officer:["Attorney","Read only. Sees the status of every appraisal the firm has ordered and downloads the finished report."]},
      deliveredLabel:"Report delivered to your attorney",recordName:"order record",recordTitle:"APPRAISAL ORDER RECORD"},
    wealth:{key:"wealth",word:"advisor's office",staff:"advisor",refLabel:"Client or account reference",refHint:"Trust 2026-044",attest:false,
      roles:{admin:["Firm administrator","Manages who can sign in and what they may do. Sees every order. Does not place orders."],
             desk:["Coordinator","Places, edits and cancels orders, uploads documents, keeps the appraiser supplied with what they need."],
             officer:["Advisor","Read only. Sees the status of every appraisal ordered for a client and downloads the finished report."]},
      deliveredLabel:"Report delivered to your advisor",recordName:"order record",recordTitle:"APPRAISAL ORDER RECORD"}
  };
  var CT = CLIENT_TYPES.lender;
  function setClientType(t){
    CT = CLIENT_TYPES[t] || CLIENT_TYPES.lender;
    ["admin","desk","officer"].forEach(function(k){ ROLES[k].name = CT.roles[k][0]; ROLES[k].hint = CT.roles[k][1]; });
    CLIENT_LABEL.Delivered = CT.deliveredLabel;
    return CT;
  }
  function clientType(){ return CT; }
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
  var PURPOSES = ["Purchase","Refinance","Construction","Purchase and improvement","Home equity","Additional collateral","Estate","Trust or gift","Divorce or partition","Tax appeal","Other"];
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
    admin:    {view:true, people:true, config:true, brand:true, cancel:true, note:true, docs:true, outbox:true, assign:true, paid:true, revise:true, post:true},
    desk:     {view:true, place:true, edit:true, cancel:true, ask:true, note:true, docs:true, outbox:true, hold:true, renotify:true, reissue:true, book:true, assign:true, paid:true, revise:true, docreq:true, post:true, postclient:true},
    officer:  {view:true, docs:false, outbox:true},
    appraiser:{view:true, accept:true, decline:true, schedule:true, renotify:true, book:true, inspect:true, review:true, deliver:true, invoice:true, hold:true, fee:true, config:true, docs:true, note:true, outbox:true, prelim:true, reviewer:true, docreq:true, post:true, postclient:true}
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

  /* ---------- time, always in the lender's zone ---------- */
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
  function contactLine(cfg){ var p=((cfg&&cfg.appraiserPhone)||"").trim(); return p?("Questions? Call "+aprLower(cfg)+" at "+p+"."):("Questions? Contact your "+CT.staff+" at "+lenderName(cfg)+"."); }
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
       body:"A copy of the appraisal for "+o.addr+" is available to you at no charge: [link]. You are receiving this electronically because you agreed to electronic delivery. To receive a paper copy instead at no charge, reply to this message or call your "+CT.staff+" at "+lenderName(c)+"."}
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
    /* conversation: one thread per order. p.to is "staff" or "client"; p.role is the sender's role. */
    post:function(o,c,p){
      var text=(p&&p.text)||"", by=(p&&p.by)||"", role=(p&&p.role)||"";
      if(p&&p.to==="client"){
        var cp=contactParty(o);
        return [
          {channel:"sms",party:cp,body:(role==="appraiser"?aprCap(c):lenderName(c))+" about "+o.addr+": "+text.slice(0,240)+(text.length>240?"...":"")+" Reply here: [link]"},
          {channel:"email",party:cp,subject:"Message about your appraisal: "+o.addr,body:text+"\n\nFrom "+by+(role==="appraiser"?"":(" at "+lenderName(c)))+". You can reply on your status page: [link]"}
        ];
      }
      if(role==="client"){
        var m=[{channel:"email",party:"appraiser",subject:"Message from "+by+" on "+o.addr,body:text+"\n\nSent by "+by+" from their status page. Reply in the portal: [portal]"}];
        m.push({channel:"email",party:"desk",subject:"Message from "+by+" on "+o.addr,body:text+"\n\nSent by "+by+" from their status page. [portal]"});
        return m;
      }
      if(role==="appraiser") return [
        {channel:"email",party:"desk",subject:"Message on "+o.addr,body:text+"\n\nFrom "+by+" ("+aprLower(c)+") through the portal. Reply there: [portal]"}
      ];
      return [
        {channel:"email",party:"appraiser",subject:"Message on "+o.addr,body:text+"\n\nSent by "+by+" ("+lenderName(c)+") through the portal. Logged on the independence record. Reply there: [portal]"}
      ];
    },
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
      case "ask": case "reply": case "post": {
        /* one conversation per order. Staff post to each other (and, when p.to==="client", to the borrower or agent);
           the client posts from their status page. Every entry is logged on the independence record. */
        var to=p.to==="client"?"client":"staff";
        if(role==="client"){ to="staff"; }
        else if(!can(role,"post")) fail("forbidden",ROLES.officer.name+"s read the conversation but do not take part; route anything through the "+ROLES.desk.name.toLowerCase()+".");
        if(to==="client"&&!can(role,"postclient")) fail("forbidden","Only the desk or the appraiser messages the client.");
        if(to==="client"&&!o.clientContacted) fail("stale","The client has not been contacted yet; the appraiser accepts the order first.");
        var text=String(p.text||"").trim().slice(0,2000);
        if(!text) fail("bad","Write a message first.");
        if(!o.thread) o.thread=[];
        o.thread.push({at:now,who:who,role:role,to:to,text:text,via:p.via||"portal"});
        if(o.thread.length>300) o.thread=o.thread.slice(-300);
        log((role==="client"?"Message from "+who+" (client"+(p.via&&p.via!=="portal"?", by "+p.via:"")+"): ":(to==="client"?"Message to the client from "+who+": ":"Message from "+who+" ("+(ROLES[role]?ROLES[role].name:role)+"): "))+text);
        send("post",{text:text,by:who,role:role,to:to});
        reply=to==="client"?"Sent to "+contactName(o)+" by text and email, and logged.":"Sent and logged."; break; }
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

  return {STEPS:STEPS,CLIENT_LABEL:CLIENT_LABEL,ROLES:ROLES,CLIENT_TYPES:CLIENT_TYPES,setClientType:setClientType,clientType:clientType,PRODUCTS:PRODUCTS,REPORT_TYPES:REPORT_TYPES,PURPOSES:PURPOSES,ACCESS:ACCESS,
    LOAN_TYPES:LOAN_TYPES,PREMISES:PREMISES,OCCUPANCY:OCCUPANCY,PROPERTY_TYPES:PROPERTY_TYPES,DELIVERY_FORMATS:DELIVERY_FORMATS,REVISION_KINDS:REVISION_KINDS,PAY_METHODS:PAY_METHODS,
    lenderName:lenderName,nudgesDue:nudgesDue,
    DOC_KINDS:DOC_KINDS,HOLD_REASONS:HOLD_REASONS,DECLINE_REASONS:DECLINE_REASONS,CANCEL_REASONS:CANCEL_REASONS,PERM:PERM,can:can,
    statusOf:statusOf,isOpen:isOpen,TZ:TZ,fmtDay:fmtDay,fmtHr:fmtHr,fmtTime:fmtTime,fmtDate:fmtDate,defaultConfig:defaultConfig,
    genSlots:genSlots,slotClashes:slotClashes,zonedToUtc:zonedToUtc,applyAction:applyAction,nextActions:nextActions,contactParty:contactParty,contactName:contactName,
    aprCap:aprCap,aprLower:aprLower,contactLine:contactLine,money:money,templates:T};
})();
export default CORE;
