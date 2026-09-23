'use strict';
const $=id=>document.getElementById(id);
const INITIAL=[59.3381,14.93625],MIN_ZOOM=14;
const COLORS={veryHigh:'#f47a24',high:'#f0cf36',promising:'#b5c94b',possible:'#55a250',low:'#1b5635'};
const names={forest:'Skog · NMD2023',soil:'Jord · SGU',weather:'Tidigare väder · Open-Meteo',forecast:'Kommande väder · SMHI',avverkningar:'Avverkning · Skogsstyrelsen'};
const cache=new Map(),cellCache=new Map(),jobs=new Set();
let map,outline,gridLayer,selectionOutline,selectedBox=null;
let mapLayers,locationControl,forecastOpacity=.48,quickCamera=false;
let timer,controller,revision=0,lastStarted=0,activePacket=null,activeCells=[],cellIndex=new Map(),renderSize=50;
let searchController=null,searching=false,searchTimer=null,searchStartTime=0;
if(window.proj4)proj4.defs('EPSG:3006','+proj=utm +zone=33 +ellps=GRS80 +units=m +no_defs');
const toGeo=point=>proj4('EPSG:3006','EPSG:4326',point);
const latLng=point=>{const [lon,lat]=toGeo(point);return [lat,lon];};
const cellSize=()=>map.getZoom()>=18?10:map.getZoom()>=16?20:50;
function makeBox(x,y){
  x=Math.round(x/100)*100;y=Math.round(y/100)*100;
  const corners=[[x-500,y-500],[x+500,y-500],[x+500,y+500],[x-500,y+500]],geo=corners.map(toGeo),[lon,lat]=toGeo([x,y]);
  return {key:x+':'+y,xy:[x-500,y-500,x+500,y+500],corners:corners.map(latLng),
    geoBbox:[Math.min(...geo.map(p=>p[0])),Math.min(...geo.map(p=>p[1])),Math.max(...geo.map(p=>p[0])),Math.max(...geo.map(p=>p[1]))],
    weatherLat:(Math.round(lat/.025)*.025).toFixed(3),weatherLon:(Math.round(lon/.025)*.025).toFixed(3)};
}
function square(center){return makeBox(...proj4('EPSG:4326','EPSG:3006',[center.lng,center.lat]));}
function inCoverage(){const p=map.getCenter();return p.lat>=55.2&&p.lat<=69.2&&p.lng>=10.5&&p.lng<=24.3;}
function containsCenter(box){const [x,y]=proj4('EPSG:4326','EPSG:3006',[map.getCenter().lng,map.getCenter().lat]);return x>=box.xy[0]&&x<=box.xy[2]&&y>=box.xy[1]&&y<=box.xy[3];}
function dimensions(){const size=cellSize();$('dimensions').textContent=`1 × 1 km · ${size} × ${size} m`;}
function mapError(message){$('mapError').textContent=message;$('mapError').hidden=!message;}
function resetPanel(message='Zooma in mot rutan för att hämta underlag.'){
  $('areaName').textContent='Området i rutan';$('potential').textContent='Väntar på analys';
  for(const id of ['forest','soil','moisture','felling','structure'])$(id).textContent='Inte hämtat';
  $('reason').textContent=message;$('weather').textContent='Vädret är gemensamt för kilometerrutan.';
  $('forecast').textContent='';$('sourceStatus').replaceChildren();$('areaList').replaceChildren();
}
function updateOutline(){if(!inCoverage()){outline.setLatLngs([]);return;}outline.setLatLngs((selectedBox||square(map.getCenter())).corners);dimensions();}
function cancelSearch(message=''){
  if(!searching&&!searchController)return;
  searching=false;searchController?.abort();searchController=null;
  clearInterval(searchTimer);searchTimer=null;
  for(const id of ['findVeryHigh','findHigh']){
    const btn=$(id); if(btn){ btn.textContent = id==='findVeryHigh' ? 'Hitta mycket stor' : 'Hitta stor'; btn.setAttribute('aria-pressed','false'); }
  }
  if(message)$('searchStatus').textContent=message;
  cellIndex.clear();gridLayer?.redraw();dimensions();
}
function stopAnalysis(){
  revision++;clearTimeout(timer);controller?.abort();controller=null;
  activePacket=null;activeCells=[];cellIndex.clear();gridLayer?.redraw();selectionOutline?.setLatLngs([]);mapLayers?.clear();
  $('retry').hidden=true;resetPanel('Zooma inom rutan för fler detaljer.');
}
function scheduleAnalysis(retryMissing=false){
  clearTimeout(timer);if(searching)return;
  if(!inCoverage()){updateOutline();$('analysisStatus').textContent='Välj ett område i Sverige.';return;}
  if(!selectedBox||!containsCenter(selectedBox)){selectedBox=square(map.getCenter());}
  updateOutline();
  if(map.getZoom()<MIN_ZOOM){$('analysisStatus').textContent='Zooma in mot kilometerrutan för analys.';return;}
  const box=selectedBox,previous=cache.get(box.key);
  if(previous&&Date.now()-previous.fetched<600000&&['forest','soil','weather'].every(k=>previous.data[k])&&(previous.data.forecast||previous.errors.forecast)&&(!retryMissing||!Object.keys(previous.errors).length)){void render(previous);return;}
  $('analysisStatus').textContent='Hämtar när kartan har stannat…';
  timer=setTimeout(()=>analyze(box),Math.max(900,4000-(Date.now()-lastStarted)));
}
function sourceStatus(key,state,detail=''){let line=$('source-'+key);if(!line){line=document.createElement('li');line.id='source-'+key;$('sourceStatus').append(line);}line.textContent=names[key]+': '+state+(detail?' · '+detail:'');}
function remember(packet){cache.set(packet.box.key,packet);while(cache.size>12)cache.delete(cache.keys().next().value);}
async function loadPacket(box,signal,{progress=()=>{},search=false,weatherMemo}={}){
  const old=cache.get(box.key),fresh=old&&Date.now()-old.fetched<600000;
  const packet={box,fetched:fresh?old.fetched:Date.now(),data:fresh?{...old.data}:{},errors:fresh?{...old.errors}:{}};
  const keys=Object.keys(names).filter(key=>!search||key!=='forecast');
  await Promise.allSettled(keys.map(async key=>{
    if(packet.data[key]){progress(key,'hämtat');return;}progress(key,'hämtar…');
    try{
      const weatherKey=box.weatherLat+':'+box.weatherLon;
      let task;
      if(key==='weather'&&weatherMemo){if(!weatherMemo.has(weatherKey))weatherMemo.set(weatherKey,SvampSources.weather(box,signal));task=weatherMemo.get(weatherKey);}
      else task=SvampSources[key](box,signal);
      packet.data[key]=await task;delete packet.errors[key];if(signal.aborted)return;progress(key,'hämtat');
    }catch(error){packet.errors[key]=error.name==='AbortError'?'Tog för lång tid':error.message;if(!signal.aborted)progress(key,'saknas',packet.errors[key]);}
  }));
  if(signal.aborted)throw new DOMException('Avbruten','AbortError');
  if(Object.keys(packet.data).length)remember(packet);
  return packet;
}
async function analyze(box){
  if(map.getZoom()<MIN_ZOOM||selectedBox?.key!==box.key||searching)return;
  const token=++revision;controller?.abort();controller=new AbortController();const signal=controller.signal;
  lastStarted=Date.now();$('analysisStatus').textContent='Hämtar skog, jordart och väder…';resetPanel('Hämtar underlag.');
  try{const packet=await loadPacket(box,signal,{progress:(...args)=>{if(token===revision)sourceStatus(...args);}});if(token===revision)await render(packet);}
  catch(error){if(token===revision&&error.name!=='AbortError'){$('analysisStatus').textContent='Kunde inte slutföras.';$('retry').hidden=false;}}
}
function computeCells(packet,size,signal){
  const key=packet.box.key+':'+packet.fetched+':'+size;
  if(cellCache.has(key))return Promise.resolve(cellCache.get(key));
  return new Promise((resolve,reject)=>{
    const worker=new Worker('./analysis-worker.js?v=20261002.0');jobs.add(worker);
    worker.onmessage=event=>{jobs.delete(worker);worker.terminate();if(event.data.error)reject(new Error(event.data.error));else{cellCache.set(key,event.data.cells);while(cellCache.size>24)cellCache.delete(cellCache.keys().next().value);resolve(event.data.cells);}};
    worker.onerror=()=>{jobs.delete(worker);worker.terminate();reject(new Error('Beräkningen misslyckades'));};
    signal?.addEventListener('abort',()=>{jobs.delete(worker);worker.terminate();reject(new DOMException('Avbruten','AbortError'));},{once:true});
    worker.postMessage({packet:{box:packet.box,data:{forest:packet.data.forest,soil:packet.data.soil,weather:packet.data.weather}},size});
  });
}
async function render(packet){
  activePacket=packet;const size=cellSize();renderSize=size;dimensions();
  try{
    const cells=await computeCells(packet,size,controller?.signal);
    if(selectedBox?.key!==packet.box.key||searching)return;
    activeCells=cells;cellIndex=new Map(cells.map(cell=>[cell.id,cell]));gridLayer.redraw();mapLayers?.updatePacket(packet);
    // Update nav to box center if no cell selected yet
    try{ const [lon,lat]=toGeo([(packet.box.xy[0]+packet.box.xy[2])/2, (packet.box.xy[1]+packet.box.xy[3])/2]); updateNavLinks(lat,lon); }catch{}
    $('analysisStatus').textContent=`${cells.length} rutor · hämtat ${new Date(packet.fetched).toLocaleTimeString('sv-SE',{hour:'2-digit',minute:'2-digit'})}`;
    const av=packet.data.avverkningar;
    if(av){
      if(av.utforda?.length){
        const years=av.utforda.map(f=>f.properties._year).filter(Boolean).sort((a,b)=>a-b);
        const latest=years.at(-1);
        $('felling').textContent= latest ? `Delar av rutan avverkades ${latest}.` : `Avverkning registrerad i rutan.`;
      } else if(av.anmalda?.length){
        $('felling').textContent=`Avverkningsanmälan finns. Genomförande är inte bekräftat.`;
      } else {
        $('felling').textContent=`Ingen registrerad avverkning i rutan. Saknad registrering betyder inte att skogen är orörd.`;
      }
    }
    $('moisture').textContent = packet.data.moisture ? `Frisk mark med fuktigare stråk.` : 'Inte hämtat · visar beräknade förhållanden, inte dagens fukt.';
    $('structure').textContent = packet.data.structure ? `${packet.data.structure.text}` : 'Trädhöjd och grundyta visas när underlag finns. Vi kallar inte skogen gallrad enbart utifrån höjd/täthet.';
    if(cells.length){cellChoices(cells);selectCell(cells[0].id);}else{resetPanel('Ingen bedömning i denna ruta.');}
  }catch(error){if(error.name!=='AbortError'){$('analysisStatus').textContent='Kunde inte räkna rutor.';}}
}
function cellChoices(cells){
  $('areaList').replaceChildren();
  const levelOrder={veryHigh:0,high:1,promising:2,possible:3,low:4};
  const sorted=[...cells].sort((a,b)=>(levelOrder[a.level]??9)-(levelOrder[b.level]??9));
  for(const cell of sorted.slice(0,16)){
    const b=document.createElement('button');
    const sw=document.createElement('i'); sw.className='cell-swatch '+cell.level; sw.style.background=COLORS[cell.level]||'#555';
    const label=document.createElement('span');
    label.textContent=`Ruta ${cell.row+1}:${cell.col+1} · ${cell.size}×${cell.size} m · ${cell.label}`;
    b.append(sw,label);
    b.addEventListener('click',()=>selectCell(cell.id));
    $('areaList').append(b);
  }
}

function isIOS(){
  const ua = navigator.userAgent || navigator.vendor || window.opera;
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function isAndroid(){
  return /Android/.test(navigator.userAgent);
}
function updateNavLinks(lat, lon){
  const nav = document.getElementById('navLinks');
  const coordsEl = document.getElementById('navCoords');
  const appleEl = document.getElementById('appleMapsLink');
  const googleEl = document.getElementById('googleMapsLink');
  const w3wLink = document.getElementById('w3wLink');
  const w3wWords = document.getElementById('w3wWords');
  if(!nav || !appleEl || !googleEl) return;
  if(typeof lat !== 'number' || typeof lon !== 'number'){ nav.hidden = true; return; }
  const latFixed = lat.toFixed(5);
  const lonFixed = lon.toFixed(5);
  const label = 'Kantarellställe';
  const encodedLabel = encodeURIComponent(label);
  // Apple Maps - daddr for navigation, q for pin name
  appleEl.href = `https://maps.apple.com/?daddr=${lat},${lon}&q=${encodedLabel}`;
  // Google Maps - dir for navigation
  googleEl.href = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&query=${encodedLabel}%20${lat},${lon}`;
  // what3words link with coords - will show words on their site
  w3wLink.href = `https://what3words.com/${lat},${lon}?q=${lat},${lon}`;
  if(coordsEl) coordsEl.textContent = `${latFixed}, ${lonFixed}`;
  // Platform handling: both on iPhone, only Google on Android, both on desktop
  if(isAndroid() && !isIOS()){
    appleEl.hidden = true;
    googleEl.hidden = false;
  } else if(isIOS()){
    appleEl.hidden = false;
    googleEl.hidden = false;
  } else {
    appleEl.hidden = false;
    googleEl.hidden = false;
  }
  nav.hidden = false;
  // Try to fetch what3words words if API key available or via free conversion (attempt)
  if(w3wWords){
    // Try to get from API if key stored
    const tryFetchW3W = async () => {
      try{
        const key = localStorage.getItem('w3w_key') || window.W3W_API_KEY || '';
        if(!key){
          // No key - try what3words without key via their API? will fail, so show placeholder that link shows words
          w3wWords.textContent = 'öppna länken för att se 3 ord';
          // Attempt public conversion via what3words API proxy if allowed? fallback to showing coords
          // Try fetching from api.what3words.com without key via demo? It will error, catch below
          // As last resort, try to use what3words.com API that sometimes allows anonymous? we skip
          return;
        }
        const url = `https://api.what3words.com/v3/convert-to-3wa?coordinates=${lat},${lon}&key=${key}&language=sv`;
        const res = await fetch(url);
        if(!res.ok) throw new Error('w3w fetch failed');
        const data = await res.json();
        if(data.words){
          w3wWords.textContent = data.words;
          w3wLink.href = `https://what3words.com/${data.words}`;
          w3wLink.textContent = `Öppna ${data.words} i what3words`;
        }
      }catch(e){
        // Keep placeholder, link still works with coords
        if(w3wWords && !w3wWords.textContent) w3wWords.textContent = 'öppna länken för att se 3 ord';
      }
    };
    tryFetchW3W();
  }
}

function selectCell(id){

  const cell=cellIndex.get(id)||activeCells.find(c=>c.id===id);
  if(!cell)return;
  $('areaName').textContent=`Ruta ${cell.row+1}:${cell.col+1} · ${cell.size} × ${cell.size} m`;
  $('potential').textContent=cell.label;$('potential').className='potential '+cell.level;
  $('forest').textContent=`${cell.forest||'Okänd'}${cell.code?' · kod '+cell.code:''} · ${Math.round(cell.forestShare*100)}% skog`;
  $('soil').textContent=cell.soilLabel||'Jordart saknas';
  $('reason').textContent=cell.reason||'';
  $('weather').textContent=activePacket?.data?.weather?`14 dagar: ${activePacket.data.weather.rain14.toFixed(1)} mm, ${activePacket.data.weather.wetDays14} dygn ≥1 mm, medel ${activePacket.data.weather.temp7.toFixed(1)}°C`:'Väder saknas';
  if(activePacket?.data?.forecast){$('forecast').textContent=`Prognos 24h: ${activePacket.data.forecast.min.toFixed(1)}–${activePacket.data.forecast.max.toFixed(1)}°C`;}
  const corners=[[cell.x,cell.y],[cell.x+cell.size,cell.y],[cell.x+cell.size,cell.y+cell.size],[cell.x,cell.y+cell.size]].map(p=>{const [lon,lat]=toGeo(p);return [lat,lon];});
  selectionOutline.setLatLngs(corners);
  const centerLonLat = toGeo([cell.x+cell.size/2, cell.y+cell.size/2]);
  updateNavLinks(centerLonLat[1], centerLonLat[0]);
}

// Ny funktion: Hitta "mycket stor" - går i cirklar utåt från vald ruta

async function findLevel(targetLevel){
  const levelLabel = targetLevel==='veryHigh' ? 'mycket stor' : targetLevel==='high' ? 'stor' : targetLevel;
  const btnId = targetLevel==='veryHigh' ? 'findVeryHigh' : 'findHigh';
  const btn=$(btnId);
  if(searching){ cancelSearch('Avbrutet'); return; }
  if(!selectedBox){ $('searchStatus').textContent='Välj en kilometerruta först.'; return; }
  searching=true;
  searchController=new AbortController();
  const signal=searchController.signal;
  searchStartTime=Date.now();
  if(btn){ btn.textContent='Avbryt'; btn.setAttribute('aria-pressed','true'); }
  $('searchStatus').textContent=`Letar ${levelLabel}…`;
  $('analysisStatus').textContent=`Söker ${levelLabel} från centrum…`;
  searchTimer=setInterval(()=>{ if(searching){ $('searchStatus').textContent=`Letar ${levelLabel} ${Math.floor((Date.now()-searchStartTime)/1000)}s…`; } },1000);

  const weatherMemo=new Map();
  const centerX=(selectedBox.xy[0]+selectedBox.xy[2])/2, centerY=(selectedBox.xy[1]+selectedBox.xy[3])/2;
  const centerBox=selectedBox;
  let found=null;
  const maxRadius=15;
  const radiusSteps=[0,1,2,3,5,8,12,15];

  try{
    for(const radius of radiusSteps){
      if(found||signal.aborted) break;
      const boxes=[];
      if(radius===0){ boxes.push(centerBox); }
      else{
        const steps=radius*2;
        for(let dx=-radius; dx<=radius; dx++){
          for(let dy=-radius; dy<=radius; dy++){
            if(Math.abs(dx)!==radius && Math.abs(dy)!==radius) continue;
            const x=centerX+dx*1000, y=centerY+dy*1000;
            if(x<260000||x>950000||y<6100000||y>7700000) continue;
            boxes.push(makeBox(x,y));
          }
        }
        boxes.sort((a,b)=>{
          const ax=a.xy[0]-centerBox.xy[0], ay=a.xy[1]-centerBox.xy[1];
          const bx=b.xy[0]-centerBox.xy[0], by=b.xy[1]-centerBox.xy[1];
          return Math.atan2(ay,ax)-Math.atan2(by,bx);
        });
      }
      for(let i=0;i<boxes.length && !found && searching;i+=2){
        const batch=boxes.slice(i,i+2);
        const results=await Promise.all(batch.map(async box=>{
          try{
            if(signal.aborted)return null;
            const packet=await loadPacket(box,signal,{search:false,weatherMemo});
            if(signal.aborted)return null;
            if(!packet.data.forest||!packet.data.soil||!packet.data.weather)return null;
            const cells50=await computeCells(packet,50,signal);
            let match=cells50.filter(c=>c.level===targetLevel);
            if(!match.length && targetLevel==='high'){
              // also accept veryHigh as at least high
              match=cells50.filter(c=>c.level==='veryHigh');
            }
            if(!match.length){
              try{
                const cells20=await computeCells(packet,20,signal);
                let m2=cells20.filter(c=>c.level===targetLevel);
                if(!m2.length && targetLevel==='high') m2=cells20.filter(c=>c.level==='veryHigh');
                if(m2.length)return {packet,cell:m2[0],box};
              }catch{}
              return null;
            }
            return {packet,cell:match[0],box};
          }catch{return null;}
        }));
        for(const r of results){ if(r){ found=r; break; } }
        if(found)break;
        if(radius>0 && i%6===0){
          $('analysisStatus').textContent=`Letar ${Math.floor((Date.now()-searchStartTime)/1000)}s · söker ${radius} km från start · ${boxes.length} rutor i ring`;
        }
      }
    }

    clearInterval(searchTimer);searchTimer=null;
    searching=false;
    searchController=null;
    for(const id of ['findVeryHigh','findHigh']){
      const b=$(id); if(b){ b.textContent = id==='findVeryHigh' ? 'Hitta mycket stor' : 'Hitta stor'; b.setAttribute('aria-pressed','false'); }
    }

    if(found){
      const cell=found.cell;
      const newCenterX=cell.x+cell.size/2, newCenterY=cell.y+cell.size/2;
      const newBox=makeBox(newCenterX,newCenterY);
      selectedBox=newBox;
      activePacket=found.packet;
      map.setView(latLng([newCenterX,newCenterY]), Math.max(map.getZoom(),16), {animate:true});
      await render(found.packet);
      setTimeout(()=>selectCell(cell.id),300);
      $('searchStatus').textContent=`Hittade ${levelLabel} efter ${Math.floor((Date.now()-searchStartTime)/1000)}s · ${Math.round(Math.hypot(newCenterX-centerX,newCenterY-centerY)/1000)} km bort`;
      $('analysisStatus').textContent=`Hittade ${levelLabel.charAt(0).toUpperCase()+levelLabel.slice(1)} · flyttade boxen till rutan`;
    } else {
      $('searchStatus').textContent=`Ingen ${levelLabel} hittades inom ${maxRadius} km · ${Math.floor((Date.now()-searchStartTime)/1000)}s sökt`;
    }

  } catch(e){
    if(e.name!=='AbortError'){
      clearInterval(searchTimer);searching=false;
      for(const id of ['findVeryHigh','findHigh']){
        const b=$(id); if(b){ b.textContent = id==='findVeryHigh' ? 'Hitta mycket stor' : 'Hitta stor'; b.setAttribute('aria-pressed','false'); }
      }
      $('searchStatus').textContent='Sökningen avbröts: '+e.message;
    }
  }
}
function findVeryHigh(){ return findLevel('veryHigh'); }
function findHigh(){ return findLevel('high'); }

if(window.L&&window.proj4){
  map=L.map('map',{scrollWheelZoom:true}).setView(INITIAL,12);
  map.zoomControl.setPosition('topright');
  L.control.scale({imperial:false,position:'bottomleft'}).addTo(map);
  mapLayers=initMapLayers({map,L,container:$('mapLayers'),onForecastOpacity(alpha){forecastOpacity=alpha;gridLayer?.redraw();}});
  const Grid=L.Layer.extend({
    onAdd(map){this._map=map;this.canvas=L.DomUtil.create('canvas','forecast-canvas');this.canvas.style.position='absolute';this.canvas.style.pointerEvents='none';this.canvas.style.mixBlendMode='normal';map.getPanes().overlayPane.append(this.canvas);map.on('moveend zoomend resize',this.redraw,this);this.redraw();},
    onRemove(map){map.off('moveend zoomend resize',this.redraw,this);this.canvas.remove();},
    redraw(){
      if(!this.canvas)return;
      const size=this._map.getSize(),ratio=Math.min(window.devicePixelRatio||1,2),canvas=this.canvas;
      canvas.width=size.x*ratio;canvas.height=size.y*ratio;canvas.style.width=size.x+'px';canvas.style.height=size.y+'px';L.DomUtil.setPosition(canvas,this._map.containerPointToLayerPoint([0,0]));
      const context=canvas.getContext('2d');context.setTransform(ratio,0,0,ratio,0,0);context.clearRect(0,0,size.x,size.y);
      const results=activePacket?[{packet:activePacket,cells:activeCells}]:[];
      for(const {packet,cells} of results){
        const [w,s,e,n]=packet.box.xy,nw=this._map.latLngToContainerPoint(latLng([w,n])),ne=this._map.latLngToContainerPoint(latLng([e,n])),sw=this._map.latLngToContainerPoint(latLng([w,s]));
        context.save();context.transform((ne.x-nw.x)/1000,(ne.y-nw.y)/1000,(sw.x-nw.x)/1000,(sw.y-nw.y)/1000,nw.x,nw.y);
        for(const cell of cells){
          if(!COLORS[cell.level])continue;
          context.globalAlpha=forecastOpacity;context.fillStyle=COLORS[cell.level];context.fillRect(cell.col*cell.size,cell.row*cell.size,cell.size,cell.size);
          if(forecastOpacity>0){context.globalAlpha=Math.min(.22,forecastOpacity);context.strokeStyle='#fff0b0';context.lineWidth=.5/(Math.hypot(ne.x-nw.x,ne.y-nw.y)/1000);context.strokeRect(cell.col*cell.size,cell.row*cell.size,cell.size,cell.size);}
        }
        context.restore();
      }
    }
  });
  gridLayer=new Grid().addTo(map);
  // Outline pane - always visible, normal blend, above multiply layers
  const outlinePane = map.getPane('outlinePane') || map.createPane('outlinePane');
  outlinePane.style.zIndex = '650';
  outlinePane.style.mixBlendMode = 'normal';
  outlinePane.style.pointerEvents = 'none';
  outline=L.polygon([],{pane:'outlinePane',color:'#82701e',weight:4,fill:false,dashArray:'10 6',interactive:false}).addTo(map);
  selectionOutline=L.polygon([],{pane:'outlinePane',color:'#fff6ca',weight:4,fill:false,interactive:false}).addTo(map);
  map.on('movestart',()=>{if(searching)return;stopAnalysis();});
  map.on('moveend',()=>{if(!searching)scheduleAnalysis();});
  map.on('click',event=>{
    const [x,y]=proj4('EPSG:4326','EPSG:3006',[event.latlng.lng,event.latlng.lat]);
    if(!activePacket)return;const box=activePacket.box,col=Math.floor((x-box.xy[0])/renderSize),row=Math.floor((box.xy[3]-y)/renderSize);selectCell((row+1)+':'+(col+1));
  });
  locationControl=initLocation({map,L,onFirstFix(point){selectedBox=null;map.setView(point,16);}});
  new ResizeObserver(()=>map.invalidateSize()).observe($('map'));resetPanel();scheduleAnalysis();
}else{for(const id of ['locate','findVeryHigh'])$(id).disabled=true;}
$('findVeryHigh').addEventListener('click',findVeryHigh);
$('findHigh').addEventListener('click',findHigh);
$('retry').addEventListener('click',()=>{stopAnalysis();scheduleAnalysis(true);});
window.addEventListener('pagehide',()=>{cancelSearch('');stopAnalysis();locationControl?.stop();mapLayers?.destroy();cache.clear();cellCache.clear();jobs.forEach(w=>w.terminate());jobs.clear();SvampSources.clear();selectedBox=null;});
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
