function parseOpml(text){
  const doc=new DOMParser().parseFromString(text,"text/xml");
  if(doc.querySelector("parsererror"))throw new Error("This file is not valid OPML or XML.");
  const body=doc.querySelector("body");
  if(!body)throw new Error("This OPML file does not contain a feed list.");
  const feeds=[];
  const walk=(node,folders=[])=>{
    Array.from(node.children||[]).filter(x=>x.tagName&&x.tagName.toLowerCase()==="outline").forEach(outline=>{
      const url=String(outline.getAttribute("xmlUrl")||outline.getAttribute("xmlurl")||"").trim();
      const label=String(outline.getAttribute("title")||outline.getAttribute("text")||"").trim();
      if(url){
        feeds.push({url,name:label,folder:folders.length?folders[folders.length-1]:""});
      }else{
        walk(outline,label?[...folders,label]:folders);
      }
    });
  };
  walk(body);
  const seen=new Set();
  return feeds.filter(feed=>{
    const key=feed.url.trim();
    if(!key||seen.has(key))return false;
    seen.add(key);
    return true;
  });
}

function opmlImportModal(){
  openModal(
    '<div class="row"><h2>Import feeds</h2><button class="btn small-btn" id="close-modal">Close</button></div>'+
    '<p class="muted small">Choose an OPML export from NetNewsWire or another RSS reader. Morning Reader reads the file in your browser, then imports the feeds you approve.</p>'+
    '<div class="field"><label for="opml-file">OPML file</label><input id="opml-file" class="input" type="file" accept=".opml,.xml,text/xml,application/xml"></div>'+
    '<div class="notice info">OPML folders are ignored. Morning Reader keeps one source list and creates fresh issue sections from the articles themselves.</div>'
  );
  document.querySelector("#close-modal").onclick=closeModal;
  document.querySelector("#opml-file").onchange=async e=>{
    const file=e.target.files&&e.target.files[0];
    if(!file)return;
    try{
      const feeds=parseOpml(await file.text());
      if(!feeds.length)throw new Error("No RSS or Atom subscriptions were found in this OPML file.");
      renderOpmlPreview(feeds,file.name);
    }catch(err){
      toast(err.message);
    }
  };
}

function renderOpmlPreview(feeds,fileName){
  const knownUrls=new Set(allSources().map(f=>String(f.url).replace(/\/$/,"")));
  const feedHtml=feeds.map(feed=>{
    const known=knownUrls.has(String(feed.url).replace(/\/$/,""));
    return '<div class="card" style="box-shadow:none">'+
      '<strong>'+esc(feed.name||feed.url)+'</strong>'+(known?' <span class="status off">Already present</span>':'')+
      (feed.folder?'<div class="tiny muted" style="margin-top:3px">OPML folder: '+esc(feed.folder)+' · folder will not become a section</div>':'')+
      '<div class="tiny muted" style="margin-top:4px;word-break:break-all">'+esc(feed.url)+'</div>'+
      '</div>';
  }).join("");

  modal.querySelector(".modal-card").innerHTML=
    '<div class="row"><div><h2>Review OPML import</h2><div class="tiny muted">'+esc(fileName)+' · '+feeds.length+
      ' feed'+(feeds.length===1?"":"s")+'</div></div><button class="btn small-btn" id="close-modal">Close</button></div>'+
    '<p class="muted small">Morning Reader will validate every feed, add it to your source list, and ignore any OPML folder taxonomy.</p>'+
    '<div class="stack" style="margin-top:16px">'+feedHtml+'</div>'+
    '<div class="row wrap" style="justify-content:flex-start;margin-top:18px">'+
      '<button class="btn primary" id="confirm-opml-import">Import '+feeds.length+' feed'+(feeds.length===1?"":"s")+'</button>'+
      '<span class="tiny muted">Feeds are checked in batches of five.</span>'+
    '</div>';

  document.querySelector("#close-modal").onclick=closeModal;
  document.querySelector("#confirm-opml-import").onclick=async()=>{
    const button=document.querySelector("#confirm-opml-import");
    button.disabled=true;
    button.textContent="Importing…";
    const payload=feeds.map(feed=>({
      url:feed.url,
      ...(feed.name?{name:feed.name}:{})
    }));

    try{
      const result=await api("/feeds/bulk",{method:"POST",body:{feeds:payload}});
      state=result.dashboard;
      dashboard();

      const summary=result.summary||{};
      const failed=(result.results||[]).filter(x=>x.status==="failed");
      const failureHtml=failed.length
        ? '<div class="notice error"><strong>'+failed.length+' failed.</strong>'+
          failed.slice(0,12).map(x=>
            '<div class="tiny" style="margin-top:7px">'+esc(x.name||x.input)+' — '+esc(x.error||"Import failed")+'</div>'
          ).join("")+
          (failed.length>12?'<div class="tiny" style="margin-top:7px">…and '+(failed.length-12)+' more.</div>':"")+
          '</div>'
        : '<div class="notice info">All selected feeds were processed successfully.</div>';

      openModal(
        '<div class="row"><h2>Import complete</h2><button class="btn small-btn" id="close-modal">Close</button></div>'+
        '<div class="stat-grid" style="margin:18px 0">'+
          '<div class="stat"><div class="tiny muted">Added</div><div class="value">'+(summary.added||0)+'</div></div>'+
          '<div class="stat"><div class="tiny muted">Already present</div><div class="value">'+(summary.duplicate||0)+'</div></div>'+
          '<div class="stat"><div class="tiny muted">Restored</div><div class="value">'+(summary.restored||0)+'</div></div>'+
        '</div>'+
        failureHtml
      );
      document.querySelector("#close-modal").onclick=closeModal;
    }catch(err){
      button.disabled=false;
      button.textContent="Import feeds";
      toast(err.message);
    }
  };
}
