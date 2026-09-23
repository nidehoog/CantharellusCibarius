/* Kartlager v5 - kompakt, multiply som Photoshop, Dubbel Sentinel, Ånnaboda */
(function(root){
'use strict';
const DEFAULT_PROXY='https://cantharellus-historical.erik-d93.workers.dev';
const CATALOG=[
 {id:'OI.Histortho_60',label:'Cirka 1960 · svartvitt'},
 {id:'OI.Histortho_75',label:'Cirka 1975 · svartvitt'},
 ...Array.from({length:13},(_,i)=>({id:`OI.Histortho_bw_${1993+i}`,label:`${1993+i} · svartvitt`})),
 ...Array.from({length:4},(_,i)=>({id:`OI.Histortho_color_${2002+i}`,label:`${2002+i} · färg`})),
 ...Array.from({length:3},(_,i)=>({id:`OI.Histortho_ir_${2003+i}`,label:`${2003+i} · infrarött`}))
];
function el(tag,props={},parent){const e=document.createElement(tag);for(const [k,v]of Object.entries(props)){if(k==='text')e.textContent=v;else if(k==='class')e.className=v;else if(k==='html')e.innerHTML=v;else e.setAttribute(k,v);}if(parent)parent.append(e);return e;}

function todayLocal(){const n=new Date(); const y=n.getFullYear(), m=n.getMonth()+1, d=n.getDate(); return new Date(y,m-1,d);}
function fmt(d){ const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), day=String(d.getDate()).padStart(2,'0'); return `${y}-${m}-${day}`; }
function addDays(date,delta){ const d=new Date(date); d.setDate(d.getDate()+delta); return d; }

function generateSentinelOptions(){
  const now=todayLocal();
  const opts=[];
  const push=(label,date)=>{ if(date<=now) opts.push({label:`${label} · ${fmt(date)}`, date:fmt(date)}); };
  push('Senaste molnfria', addDays(now,-2));
  push('1 vecka sedan', addDays(now,-7));
  push('2 veckor sedan', addDays(now,-14));
  push('3 veckor sedan', addDays(now,-21));
  push('1 månad sedan', addDays(now,-30));
  push('2 månader sedan', addDays(now,-60));
  push('3 månader sedan', addDays(now,-90));
  push('6 månader sedan', addDays(now,-180));
  const year=now.getFullYear();
  const seasonal=[
    {m:1,d:15,label:'Vinter i år'},
    {m:3,d:15,label:'Tidig vår i år'},
    {m:4,d:15,label:'Vår i år'},
    {m:6,d:1,label:'Försommar i år'},
    {m:8,d:1,label:'Högsommar i år'},
    {m:9,d:1,label:'Tidig höst i år'},
  ];
  for(const s of seasonal){ const d=new Date(year,s.m-1,s.d); if(d<=now) push(s.label,d); }
  const lastYear=year-1;
  for(const s of [{m:6,d:1,label:`Försommar ${lastYear}`},{m:8,d:1,label:`Högsommar ${lastYear}`} ]){
    const d=new Date(lastYear,s.m-1,s.d); push(s.label,d);
  }
  const seen=new Set(); const uniq=[];
  for(const o of opts){ if(!seen.has(o.date)){ seen.add(o.date); uniq.push(o); } }
  return uniq;
}

root.initMapLayers=function({map,L,container,onForecastOpacity=()=>{},proxy=DEFAULT_PROXY}){
 if(!map||!L)return null;
 let disposed=false,activeImages=[],catalogChecked=false,imageRevision=0,packet=null,timer;
 const pending=new Set(),states=new Map();
 const makePane=(name,z)=>{const pane=map.getPane(name)||map.createPane(name);pane.style.zIndex=String(z);pane.style.pointerEvents='none';pane.style.mixBlendMode=(name==='osmBase'||name==='forecastPane'||name==='pictureBase'||name==='sentinelBase'||name==='sentinelBase2')?'normal':'multiply';return pane;};
 makePane('pictureBase',150);
 makePane('sentinelBase',160);
 makePane('sentinelBase2',165);
 makePane('osmBase',300);
 makePane('forecastPane',350);
 makePane('landcoverLines',410);makePane('soilLines',420);makePane('waterLines',430);
 makePane('fellingLines',440);makePane('plannedFelling',445);

 const historicalHost=document.getElementById('historicalPanelHost');
 const sentinelHost=document.getElementById('sentinelPanelHost');
 const sentinel2Host=document.getElementById('sentinel2PanelHost');
 const vectorHost=container;

 const filterState={
   picture:{invert:false,bw:false,opacity:100, enabled:false},
   sentinel:{invert:false,bw:false,opacity:100, date: fmt(addDays(todayLocal(),-2)), enabled:false},
   sentinel2:{invert:false,bw:false,opacity:100, date: fmt(addDays(todayLocal(),-30)), enabled:false}
 };

 function applyPaneFilter(paneName,state){
   const pane=map.getPane(paneName);
   if(!pane) return;
   const filters=[];
   if(state.invert) filters.push('invert(1)');
   if(state.bw) filters.push('grayscale(1)');
   pane.style.filter=filters.join(' ')||'';
 }

 // ---- HISTORICAL COMPACT ROW ----
 let historicalLayer=null;
 let histState=null;
 if(historicalHost){
   const wrap=el('div',{class:'vector-row compact graphic-row'},historicalHost);
   const control=el('label',{class:'vector-toggle',for:'layer-historical'},wrap);
   const check=el('input',{type:'checkbox',id:'layer-historical'},control);
   el('span',{text:'Lantmäteriets historiska'},control);
   const right=el('div',{class:'row-right'},wrap);
   const imageSelect=el('select',{id:'imageLayer',class:'mini-select'},right);
   el('option',{value:'none',text:'Ingen'},imageSelect);
   const optgroup=el('optgroup',{label:'Historiska år'},imageSelect);
   for(const entry of CATALOG) el('option',{value:entry.id,text:entry.label},optgroup);
   const fade=el('input',{type:'range',class:'fade-short',min:'0',max:'100',step:'1',value:'100','aria-label':'Genomskinlighet historisk'},right);
   const out=el('output',{class:'mini-output',text:'100 %'},right);
   const invBtn=el('button',{type:'button',class:'mini-btn',id:'historicalInvert',text:'Invertera'},right);
   const bwBtn=el('button',{type:'button',class:'mini-btn',id:'historicalBW',text:'Svartvit'},right);
   const status=el('p',{class:'layer-status',text:'Avstängt'},historicalHost);
   histState={check,fade,out,invBtn,bwBtn,status,select:imageSelect};

   function updateHistOpacity(){ const v=Number(fade.value); out.textContent=`${v} %`; filterState.picture.opacity=v; if(historicalLayer) historicalLayer.setOpacity(v/100); }
   function updateHistFilter(){ applyPaneFilter('pictureBase',filterState.picture); invBtn.setAttribute('aria-pressed', filterState.picture.invert ? 'true':'false'); bwBtn.setAttribute('aria-pressed', filterState.picture.bw ? 'true':'false'); }

   function imageTile(layerId){ return L.tileLayer.wms(proxy+'/lm/wms',{version:'1.1.1',layers:layerId,styles:'OI.OrthoimageCoverage.Default',format:'image/jpeg',transparent:false,crs:L.CRS.EPSG3857,maxZoom:20,pane:'pictureBase',attribution:'© Lantmäteriet, CC0'}); }

   async function checkCatalog(){
     if(catalogChecked||disposed) return; catalogChecked=true;
     const controller=new AbortController(); pending.add(controller);
     const t=setTimeout(()=>controller.abort(),15000);
     try{
       const r=await fetch(proxy+'/lm/catalog',{signal:controller.signal,credentials:'omit',cache:'no-store'});
       if(!r.ok) return;
       const xml=new DOMParser().parseFromString(await r.text(),'application/xml');
       const avail=new Set(Array.from(xml.querySelectorAll('Layer > Name'),n=>n.textContent.trim()));
       for(const o of optgroup.children){ if(!avail.has(o.value)){ o.disabled=true; o.textContent+=' · saknas'; } }
     }catch{}finally{clearTimeout(t); pending.delete(controller);}
   }

   function setImage(){
     imageRevision++; const rev=imageRevision;
     for(const old of activeImages) map.removeLayer(old); activeImages=[]; historicalLayer=null;
     const choice=imageSelect.value;
     if(choice==='none' || !filterState.picture.enabled){ status.textContent='Avstängt'; return; }
     void checkCatalog();
     const layer=imageTile(choice);
     activeImages=[layer]; historicalLayer=layer;
     status.textContent='Hämtar flygbild…';
     layer.on('tileerror',()=>{ if(rev!==imageRevision) return; status.textContent='Kunde inte hämta – saknas här.'; });
     layer.on('load',()=>{ if(rev===imageRevision) status.textContent='Historisk bild inläst'; });
     layer.setOpacity(Number(fade.value)/100);
     layer.addTo(map);
   }

   check.addEventListener('change',()=>{ filterState.picture.enabled=check.checked; if(check.checked) setImage(); else { for(const old of activeImages) map.removeLayer(old); activeImages=[]; historicalLayer=null; status.textContent='Avstängt'; } });
   fade.addEventListener('input',updateHistOpacity);
   invBtn.addEventListener('click',()=>{ filterState.picture.invert=!filterState.picture.invert; updateHistFilter(); });
   bwBtn.addEventListener('click',()=>{ filterState.picture.bw=!filterState.picture.bw; updateHistFilter(); });
   imageSelect.addEventListener('change',()=>{ if(filterState.picture.enabled) setImage(); });
   updateHistFilter();
 }

 // ---- SENTINEL COMPACT ROWS ----
 let sentinelLayer=null, sentinelLayer2=null;
 const sentinelOptions=generateSentinelOptions();

 function createSentinelTile(dateStr, paneName){
   const url=`https://tiles.maps.eox.at/wmts/1.0.0/s2a_3857/default/${dateStr}/g/{z}/{y}/{x}.jpg`;
   return L.tileLayer(url,{maxZoom:18,maxNativeZoom:14,pane:paneName,attribution:'© EOX, Sentinel-2, ESA',opacity:0.95});
 }
 function createFallbackTile(paneName){
   return L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxZoom:19,pane:paneName,attribution:'© Esri'});
 }

 if(sentinelHost){
   const wrap=el('div',{class:'vector-row compact graphic-row'},sentinelHost);
   const control=el('label',{class:'vector-toggle',for:'layer-sentinel'},wrap);
   const check=el('input',{type:'checkbox',id:'layer-sentinel'},control);
   el('span',{text:'Copernicus Sentinel-2A/2B'},control);
   const right=el('div',{class:'row-right'},wrap);
   const dateInput=el('input',{type:'date',class:'mini-date'},right);
   dateInput.max=fmt(todayLocal()); dateInput.value=filterState.sentinel.date;
   const menuSelect=el('select',{class:'mini-select sentinel-menu'},right);
   for(const opt of sentinelOptions){ el('option',{value:opt.date, text:opt.label},menuSelect); }
   if(sentinelOptions.length) menuSelect.value=sentinelOptions[0].date;
   const fade=el('input',{type:'range',class:'fade-short',min:'0',max:'100',step:'1',value:'100','aria-label':'Genomskinlighet Sentinel'},right);
   const out=el('output',{class:'mini-output',text:'100 %'},right);
   const invBtn=el('button',{type:'button',class:'mini-btn',text:'Invertera'},right);
   const bwBtn=el('button',{type:'button',class:'mini-btn',text:'Svartvit'},right);
   const doubleBtn=el('button',{type:'button',class:'mini-btn double-btn',text:'Dubbel'},right);
   const status=el('p',{class:'layer-status',text:'Avstängt'},sentinelHost);

   let revCounter=0;
   function updateOpacity(){ const v=Number(fade.value); out.textContent=`${v} %`; filterState.sentinel.opacity=v; if(sentinelLayer) sentinelLayer.setOpacity(v/100); }
   function updateFilter(){ applyPaneFilter('sentinelBase',filterState.sentinel); invBtn.setAttribute('aria-pressed', filterState.sentinel.invert ? 'true':'false'); bwBtn.setAttribute('aria-pressed', filterState.sentinel.bw ? 'true':'false'); }

   function setSentinel(dateStr){
     revCounter++; const rev=revCounter;
     if(sentinelLayer){ map.removeLayer(sentinelLayer); sentinelLayer=null; }
     filterState.sentinel.date=dateStr; dateInput.value=dateStr;
     if(!filterState.sentinel.enabled){ status.textContent='Avstängt'; return; }
     status.textContent=`Hämtar ${dateStr}…`;
     const layer=createSentinelTile(dateStr,'sentinelBase');
     let err=0;
     layer.on('tileerror',()=>{ err++; if(err>6 && rev===revCounter){ status.textContent=`Ingen S2A för ${dateStr} – Esri fallback.`; map.removeLayer(layer); const fb=createFallbackTile('sentinelBase'); fb.setOpacity(Number(fade.value)/100); fb.addTo(map); sentinelLayer=fb; }});
     layer.on('load',()=>{ if(rev===revCounter) status.textContent=`${dateStr} · Sentinel-2 10 m`; });
     layer.setOpacity(Number(fade.value)/100);
     layer.addTo(map); sentinelLayer=layer;
   }

   check.addEventListener('change',()=>{ filterState.sentinel.enabled=check.checked; if(check.checked) setSentinel(filterState.sentinel.date); else { if(sentinelLayer) map.removeLayer(sentinelLayer); sentinelLayer=null; status.textContent='Avstängt'; } });
   fade.addEventListener('input',updateOpacity);
   invBtn.addEventListener('click',()=>{ filterState.sentinel.invert=!filterState.sentinel.invert; updateFilter(); });
   bwBtn.addEventListener('click',()=>{ filterState.sentinel.bw=!filterState.sentinel.bw; updateFilter(); });
   dateInput.addEventListener('change',()=>{ if(dateInput.value) setSentinel(dateInput.value); });
   menuSelect.addEventListener('change',()=>{ if(menuSelect.value) setSentinel(menuSelect.value); });
   doubleBtn.addEventListener('click',()=>{
     if(sentinel2Host){ sentinel2Host.hidden=false; const c2=sentinel2Host.querySelector('input[type=checkbox]'); if(c2){ c2.checked=true; c2.dispatchEvent(new Event('change')); } sentinel2Host.scrollIntoView({behavior:'smooth', block:'nearest'}); }
   });
   updateFilter();
 }

 // Sentinel #2
 if(sentinel2Host){
   const wrap=el('div',{class:'vector-row compact graphic-row'},sentinel2Host);
   const control=el('label',{class:'vector-toggle',for:'layer-sentinel2'},wrap);
   const check=el('input',{type:'checkbox',id:'layer-sentinel2'},control);
   el('span',{text:'Copernicus Sentinel-2A/2B #2'},control);
   const right=el('div',{class:'row-right'},wrap);
   const dateInput=el('input',{type:'date',class:'mini-date'},right);
   dateInput.max=fmt(todayLocal()); dateInput.value=filterState.sentinel2.date;
   const menuSelect=el('select',{class:'mini-select sentinel-menu'},right);
   for(const opt of sentinelOptions){ el('option',{value:opt.date, text:opt.label},menuSelect); }
   const fade=el('input',{type:'range',class:'fade-short',min:'0',max:'100',step:'1',value:'100'},right);
   const out=el('output',{class:'mini-output',text:'100 %'},right);
   const invBtn=el('button',{type:'button',class:'mini-btn',text:'Invertera'},right);
   const bwBtn=el('button',{type:'button',class:'mini-btn',text:'Svartvit'},right);
   const closeBtn=el('button',{type:'button',class:'mini-btn',text:'Ta bort'},right);
   const status=el('p',{class:'layer-status',text:'Avstängt'},sentinel2Host);

   let revCounter2=0;
   function updateOpacity2(){ const v=Number(fade.value); out.textContent=`${v} %`; filterState.sentinel2.opacity=v; if(sentinelLayer2) sentinelLayer2.setOpacity(v/100); }
   function updateFilter2(){ applyPaneFilter('sentinelBase2',filterState.sentinel2); invBtn.setAttribute('aria-pressed', filterState.sentinel2.invert ? 'true':'false'); bwBtn.setAttribute('aria-pressed', filterState.sentinel2.bw ? 'true':'false'); }
   function setSentinel2(dateStr){
     revCounter2++; const rev=revCounter2;
     if(sentinelLayer2){ map.removeLayer(sentinelLayer2); sentinelLayer2=null; }
     filterState.sentinel2.date=dateStr; dateInput.value=dateStr;
     if(!filterState.sentinel2.enabled){ status.textContent='Avstängt'; return; }
     status.textContent=`Hämtar ${dateStr}…`;
     const layer=createSentinelTile(dateStr,'sentinelBase2');
     let err=0;
     layer.on('tileerror',()=>{ err++; if(err>6 && rev===revCounter2){ status.textContent=`Ingen S2A för ${dateStr} – Esri fallback.`; map.removeLayer(layer); const fb=createFallbackTile('sentinelBase2'); fb.setOpacity(Number(fade.value)/100); fb.addTo(map); sentinelLayer2=fb; }});
     layer.on('load',()=>{ if(rev===revCounter2) status.textContent=`${dateStr} · Sentinel-2 #2 10 m`; });
     layer.setOpacity(Number(fade.value)/100);
     layer.addTo(map); sentinelLayer2=layer;
   }
   check.addEventListener('change',()=>{ filterState.sentinel2.enabled=check.checked; if(check.checked) setSentinel2(filterState.sentinel2.date); else { if(sentinelLayer2) map.removeLayer(sentinelLayer2); sentinelLayer2=null; status.textContent='Avstängt'; } });
   fade.addEventListener('input',updateOpacity2);
   invBtn.addEventListener('click',()=>{ filterState.sentinel2.invert=!filterState.sentinel2.invert; updateFilter2(); });
   bwBtn.addEventListener('click',()=>{ filterState.sentinel2.bw=!filterState.sentinel2.bw; updateFilter2(); });
   dateInput.addEventListener('change',()=>{ if(dateInput.value) setSentinel2(dateInput.value); });
   menuSelect.addEventListener('change',()=>{ if(menuSelect.value) setSentinel2(menuSelect.value); });
   closeBtn.addEventListener('click',()=>{ if(sentinelLayer2) map.removeLayer(sentinelLayer2); sentinelLayer2=null; filterState.sentinel2.enabled=false; check.checked=false; sentinel2Host.hidden=true; });
   updateFilter2();
 }

 // --- VECTOR LAYERS ---
 function row(id,label,checked,opacity,note, layerRef){
  const wrap=el('div',{class:'vector-row compact'},vectorHost),control=el('label',{class:'vector-toggle',for:`layer-${id}`},wrap);
  const check=el('input',{type:'checkbox',id:`layer-${id}`},control);check.checked=checked;
  el('span',{text:label},control);
  const right=el('div',{class:'row-right'},wrap);
  const fade=el('input',{type:'range',class:'fade-short',min:'0',max:'100',step:'1',value:String(opacity),'aria-label':`Synlighet för ${label}`},right);
  const output=el('output',{class:'mini-output',text:`${opacity} %`},right);
  const status=el('p',{class:'layer-status',text:note},vectorHost);
  const state={id,wrap,check,fade,output,status,layer:layerRef||null,controller:null,collections:null,revision:0, right};states.set(id,state);
  fade.addEventListener('input',()=>{output.textContent=`${fade.value} %`;applyOpacity(state);});
  return state;
 }

 const osmLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:20,maxNativeZoom:19,pane:'osmBase',attribution:'© OpenStreetMap',updateWhenIdle:true, keepBuffer:2});
 osmLayer.addTo(map);

 const osm=row('osm','OpenStreetMap · karta',true,35,'Vector över grafiska, multiply.');
 const forecast=row('forecast','Kantarellprognos',true,48,'Färgrutor · multiply.');
 const soil=row('soil','Jordarter · SGU',false,65,'Gränser.');
 const fellingDone=row('fellingDone','Utförda avverkningar',false,75,'Hyggen och årtal.');
 const fellingPlanned=row('fellingPlanned','Avverkningsanmälda',false,65,'Möjliga kommande.');
 const hydro=row('hydrografi','Vatten · Hydrografi',false,85,'Vattendrag.');
 const cover=row('marktacke','Marktäcke',false,55,'Markslag.');

 function alpha(s){return s.check.checked?Number(s.fade.value)/100:0;}
 function applyOpacity(s){
  const a=alpha(s);
  if(s===forecast){onForecastOpacity(a);return;}
  if(s===osm){s.layer.setOpacity(a);return;}
  if(s.layer)s.layer.setStyle({opacity:a,fillOpacity:a*(s===soil?0.12:0.2)});
 }
 function removeVector(s){if(s===osm)return; s.revision++;s.controller?.abort();s.controller=null;if(s.layer){map.removeLayer(s.layer);s.layer=null;}}
 function addFeatures(s,features){
  const pane=s===soil?'soilLines':s===hydro?'waterLines':s===fellingDone?'fellingLines':s===fellingPlanned?'plannedFelling':'landcoverLines';
  const color=s===soil?'#d5a463':s===hydro?'#5ad8ff':s===fellingDone?'#ff6b35':s===fellingPlanned?'#ffd54f':'#b7dd82';
  const clean=features.filter(f=>f&&f.type==='Feature'&&f.geometry);
  s.layer=L.geoJSON({type:'FeatureCollection',features:clean},{pane,interactive:false,style:{color,weight:s===fellingDone?2.5:s===fellingPlanned?2:1.5,dashArray:s===fellingPlanned?'6 6':null},pointToLayer:(_,latlng)=>L.circleMarker(latlng,{pane,radius:3,color})}).addTo(map);applyOpacity(s);
 }
 function drawSoil(){removeVector(soil);if(!soil.check.checked){soil.status.textContent='Avstängt';return;}const features=packet?.data?.soil?.features;if(!features){soil.status.textContent='Väntar på data.';return;}addFeatures(soil,features);soil.status.textContent=`${features.length} områden`;}
 function drawFelling(){
   for(const s of [fellingDone,fellingPlanned]){
     removeVector(s);if(!s.check.checked){s.status.textContent='Avstängt';continue;}
     const av=packet?.data?.avverkningar;if(!av){s.status.textContent='Väntar.';continue;}
     const feats=s===fellingDone?av.utforda:av.anmalda;if(!feats?.length){s.status.textContent='Inget i rutan.';continue;}
     addFeatures(s,feats);s.status.textContent=`${feats.length} områden`;
   }
 }
 async function json(path,controller){
  const timeout=setTimeout(()=>controller.abort(),25000);
  try{const r=await fetch(proxy+path,{signal:controller.signal,credentials:'omit',cache:'no-store'});if(!r.ok)throw new Error('Kunde inte hämta');return await r.json();}finally{clearTimeout(timeout);}
 }
 function queryBox(){
  const c=map.getCenter(),lat=Math.round(c.lat*1000)/1000,lon=Math.round(c.lng*1000)/1000,dy=1500/111320,dx=1500/(111320*Math.cos(lat*Math.PI/180));
  return [lon-dx,lat-dy,lon+dx,lat+dy].map(v=>Number(v.toFixed(6)));
 }
 async function refresh(s){
  if(s===osm||s===forecast||s===soil||s===fellingDone||s===fellingPlanned)return;
  removeVector(s);if(!s.check.checked||disposed)return;
  if(map.getZoom()<13){s.status.textContent='Zooma in.';return;}
  const bbox=queryBox();const rev=s.revision,controller=new AbortController();s.controller=controller;s.status.textContent='Hämtar…';
  try{
   if(!s.collections){const cat=await json(`/lm/features/${s.id}/collections`,controller);s.collections=cat.collections?.filter(c=>/^[A-Za-z0-9_.:-]{1,120}$/.test(c.id))||[];}
   const cols=s.collections.slice(0,16),features=[];for(const col of cols){const params=new URLSearchParams({collection:col.id,bbox:bbox.join(',')});const data=await json(`/lm/features/${s.id}/items?${params}`,controller);features.push(...(data.features||[]));if(features.length>=6000)break;}
   if(disposed||rev!==s.revision)return;addFeatures(s,features);s.status.textContent=`${features.length} objekt`;
  }catch(e){if(rev===s.revision)s.status.textContent='Kunde inte hämta';}
 }

 osm.check.addEventListener('change',()=>{if(osm.check.checked){osmLayer.addTo(map);applyOpacity(osm);}else{map.removeLayer(osmLayer);}});
 osm.fade.addEventListener('input',()=>applyOpacity(osm));
 forecast.check.addEventListener('change',()=>applyOpacity(forecast));
 forecast.fade.addEventListener('input',()=>applyOpacity(forecast));
 soil.check.addEventListener('change',drawSoil); soil.fade.addEventListener('input',()=>applyOpacity(soil));
 for(const s of [fellingDone,fellingPlanned]){ s.check.addEventListener('change',drawFelling); s.fade.addEventListener('input',()=>applyOpacity(s)); }
 for(const s of [hydro,cover]) s.check.addEventListener('change',()=>{if(s.check.checked)void refresh(s);else{removeVector(s);s.status.textContent='Avstängt';}}), s.fade.addEventListener('input',()=>applyOpacity(s));

 function moveStart(){clearTimeout(timer);for(const s of [hydro,cover]){removeVector(s);if(s.check.checked)s.status.textContent='Hämtas när kartan stannar.';}}
 function moveEnd(){clearTimeout(timer);timer=setTimeout(()=>{for(const s of [hydro,cover])if(s.check.checked)void refresh(s);},650);}
 map.on('movestart',moveStart);map.on('moveend',moveEnd);

 applyOpacity(osm);applyOpacity(forecast);

 return {
  updatePacket(v){packet=v;drawSoil();drawFelling();},
  clear(){packet=null;drawSoil();drawFelling();},
  destroy(){disposed=true;clearTimeout(timer);for(const c of pending)c.abort();for(const s of states.values())if(s!==osm)removeVector(s);for(const l of activeImages)map.removeLayer(l);if(sentinelLayer)map.removeLayer(sentinelLayer);if(sentinelLayer2)map.removeLayer(sentinelLayer2);map.off('movestart',moveStart);map.off('moveend',moveEnd);packet=null;if(vectorHost)vectorHost.replaceChildren();if(historicalHost)historicalHost.replaceChildren();if(sentinelHost)sentinelHost.replaceChildren();if(sentinel2Host)sentinel2Host.replaceChildren();}
 };
};
})(window);
