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
    '<div class="notice info">Folders in the OPML file can become sections in your daily issue. Ungrouped feeds default to your first existing section.</div>'
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
  const groups=[],byFolder=new Map();
  for(const feed of feeds){
    const key=feed.folder||"";
    if(!byFolder.has(key)){
      const group={folder:key,feeds:[]};
      byFolder.set(key,group);
      groups.push(group);
    }
    byFolder.get(key).feeds.push(feed);
  }

  const existingByName=new Map(state.sections.map(s=>[String(s.name).trim().toLowerCase(),s]));
  let remainingNew=Math.max(0,12-state.sections.length);
  const defaults=new Map();
  for(const group of groups){
    const match=group.folder?existingByName.get(group.folder.toLowerCase()):null;
    if(match){
      defaults.set(group.folder,match.id);
    }else if(group.folder&&remainingNew>0){
      defaults.set(group.folder,"new:"+encodeURIComponent(group.folder.slice(0,80)));
      remainingNew--;
    }else{
      defaults.set(group.folder,state.sections[0]?state.sections[0].id:"");
    }
  }

  const knownUrls=new Set(
    state.sections.flatMap(s=>s.feeds).map(f=>String(f.url).replace(/\/$/,""))
  );

  const optionHtml=group=>{
    const selected=defaults.get(group.folder);
    const existing=state.sections.map(s=>
      '<option value="'+esc(s.id)+'" '+(selected===s.id?"selected":"")+'>'+esc(s.name)+'</option>'
    ).join("");
    let create="";
    if(group.folder&&!existingByName.has(group.folder.toLowerCase())){
      const newValue="new:"+encodeURIComponent(group.folder.slice(0,80));
      create='<option value="'+esc(newValue)+'" '+(selected===newValue?"selected":"")+'>'+
        'Create “'+esc(group.folder.slice(0,80))+'” section</option>';
    }
    return create+existing;
  };

  const groupHtml=groups.map((group,i)=>{
    const feedHtml=group.feeds.map(feed=>{
      const known=knownUrls.has(String(feed.url).replace(/\/$/,""));
      return '<div class="tiny" style="padding:5px 0;word-break:break-word">'+
        esc(feed.name||feed.url)+(known?' <span class="status off">Already present</span>':'')+
        '<div class="muted" style="margin-top:2px">'+esc(feed.url)+'</div></div>';
    }).join("");
    return '<div class="card" style="box-shadow:none">'+
      '<div class="row wrap">'+
        '<div><strong>'+esc(group.folder||"Ungrouped")+'</strong><div class="tiny muted">'+
          group.feeds.length+' feed'+(group.feeds.length===1?"":"s")+'</div></div>'+
        '<select class="select opml-section" data-group="'+i+'" style="width:auto;min-width:190px">'+optionHtml(group)+'</select>'+
      '</div>'+
      '<div style="margin-top:10px">'+feedHtml+'</div>'+
    '</div>';
  }).join("");

  modal.querySelector(".modal-card").innerHTML=
    '<div class="row"><div><h2>Review OPML import</h2><div class="tiny muted">'+esc(fileName)+' · '+feeds.length+
      ' feed'+(feeds.length===1?"":"s")+'</div></div><button class="btn small-btn" id="close-modal">Close</button></div>'+
    '<p class="muted small">Choose the section for each OPML folder. Morning Reader will validate every feed before adding it.</p>'+
    '<div class="stack" style="margin-top:16px">'+groupHtml+'</div>'+
    '<div class="row wrap" style="justify-content:flex-start;margin-top:18px">'+
      '<button class="btn primary" id="confirm-opml-import">Import '+feeds.length+' feed'+(feeds.length===1?"":"s")+'</button>'+
      '<span class="tiny muted">Feeds are checked in batches of five.</span>'+
    '</div>';

  document.querySelector("#close-modal").onclick=closeModal;
  document.querySelector("#confirm-opml-import").onclick=async()=>{
    const button=document.querySelector("#confirm-opml-import");
    button.disabled=true;
    button.textContent="Importing…";
    const payload=[];

    groups.forEach((group,i)=>{
      const choice=document.querySelector('.opml-section[data-group="'+i+'"]').value;
      for(const feed of group.feeds){
        const item={url:feed.url};
        if(feed.name)item.name=feed.name;
        if(choice.startsWith("new:"))item.section_name=decodeURIComponent(choice.slice(4));
        else item.section_id=choice;
        payload.push(item);
      }
    });

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
