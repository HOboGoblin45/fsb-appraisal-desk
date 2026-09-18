/* apprifi.com: the walkthrough request form and the sign-in router. No frameworks, no tracking. */
(function(){
  "use strict";
  /* reveal on scroll; everything is visible without it (no-JS, reduced motion, old browsers) */
  var rv=document.querySelectorAll(".rv");
  if("IntersectionObserver" in window && !window.matchMedia("(prefers-reduced-motion: reduce)").matches){
    var io=new IntersectionObserver(function(es){ es.forEach(function(e){ if(e.isIntersecting){ e.target.classList.add("in"); io.unobserve(e.target); } }); },{rootMargin:"0px 0px -8% 0px",threshold:.08});
    rv.forEach(function(el){ io.observe(el); });
  } else { rv.forEach(function(el){ el.classList.add("in"); }); }
  var mt=document.querySelector(".menu-toggle"); if(mt){ mt.querySelectorAll("a").forEach(function(a){ a.addEventListener("click",function(){ mt.removeAttribute("open"); }); }); }
  var req=document.getElementById("req");
  if(req){
    var msg=document.getElementById("reqmsg");
    req.addEventListener("submit",function(e){
      e.preventDefault();
      var f=new FormData(req), body={}; f.forEach(function(v,k){ body[k]=String(v||"").trim(); });
      if(!body.name||!body.org||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)){ msg.className="notice err"; msg.textContent="Name, institution and a work email are required."; return; }
      var btn=req.querySelector("button[type=submit]"); btn.disabled=true; msg.className="notice"; msg.textContent="Sending...";
      fetch("/api/contact",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)})
        .then(function(r){ return r.json().then(function(d){ if(!r.ok) throw new Error(d.error||"Something went wrong."); return d; }); })
        .then(function(){ msg.className="notice"; msg.textContent="Thank you. We will reply within one business day."; req.reset(); })
        .catch(function(err){ msg.className="notice err"; msg.textContent=err.message; })
        .then(function(){ btn.disabled=false; });
    });
  }
  var si=document.getElementById("signin");
  if(si){
    var out=document.getElementById("simsg");
    si.addEventListener("submit",function(e){
      e.preventDefault();
      var email=String(si.email.value||"").trim().toLowerCase();
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ out.className="notice err"; out.textContent="Enter your work email."; return; }
      out.className="notice"; out.textContent="Looking up your institution...";
      fetch("/api/lender?email="+encodeURIComponent(email)).then(function(r){ return r.json(); }).then(function(d){
        if(d.found){ out.textContent="Taking you to "+d.name+"..."; location.href=d.portal+"/"; }
        else { out.className="notice err"; out.textContent="We do not recognise that email domain. Use the portal address your administrator gave you, or ask them for it."; }
      }).catch(function(){ out.className="notice err"; out.textContent="Could not reach the server. Try again."; });
    });
  }
})();
