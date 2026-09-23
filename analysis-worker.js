// Geometry and up to 10,000 predictions run off the UI thread. v20261002.0
importScripts('./vendor/proj4.js', './model.js?v=20261002.0');
proj4.defs('EPSG:3006', '+proj=utm +zone=33 +ellps=GRS80 +units=m +no_defs');
const toGeo = point => proj4('EPSG:3006','EPSG:4326',point);
function bounds(geometry) {
  let w=Infinity,s=Infinity,e=-Infinity,n=-Infinity;
  function visit(coords) { if (typeof coords[0]==='number') { w=Math.min(w,coords[0]);s=Math.min(s,coords[1]);e=Math.max(e,coords[0]);n=Math.max(n,coords[1]); } else coords.forEach(visit); }
  visit(geometry.coordinates); return [w,s,e,n];
}
function buildCells(packet, size) {
  const forest=packet.data.forest; if(!forest) return [];
  if (![10,20,50].includes(size)) throw Error('Ogiltig rutstorlek');
  const features=(packet.data.soil?.features||[]).map(feature=>({feature,bounds:bounds(feature.geometry)}));
  const soilAt=point=>features.find(item=>point[0]>=item.bounds[0]&&point[0]<=item.bounds[2]&&point[1]>=item.bounds[1]&&point[1]<=item.bounds[3]&&SvampModel.inside(point,item.feature.geometry))?.feature.properties.jg2_tx||null;
  const prefix=new Uint32Array(101*101);
  for(let y=0;y<100;y++)for(let x=0;x<100;x++){const code=forest.codes[y*100+x];prefix[(y+1)*101+x+1]=(code>=111&&code<=117?1:0)+prefix[y*101+x+1]+prefix[(y+1)*101+x]-prefix[y*101+x];}
  const cells=[], step=size/10, total=step*step, count=100/step;
  for(let row=0;row<count;row++)for(let col=0;col<count;col++){
    const counts=new Map();let wooded=0,known=0;
    for(let yy=row*step;yy<(row+1)*step;yy++)for(let xx=col*step;xx<(col+1)*step;xx++){
      const code=forest.codes[yy*100+xx];if(code!==null)known++;
      if(SvampModel.isForest(code)){wooded++;counts.set(code,(counts.get(code)||0)+1);}
    }
    if(wooded/total<0.6||known/total<0.8)continue;
    const code=[...counts].sort((a,b)=>b[1]-a[1]||a[0]-b[0])[0][0];
    const x=packet.box.xy[0]+col*size,y=packet.box.xy[3]-(row+1)*size;
    const samples=[[.5,.5],[.2,.2],[.8,.2],[.2,.8],[.8,.8]].map(([dx,dy])=>soilAt(toGeo([x+size*dx,y+size*dy])));
    const soil=samples.every(value=>value&&value===samples[0])?samples[0]:null, soils=[...new Set(samples.filter(Boolean))];
    const cx=Math.floor((col+.5)*step),cy=Math.floor((row+.5)*step);
    let contextShare=null;
    if(cx>=5&&cy>=5&&cx<=95&&cy<=95){const x1=cx-5,y1=cy-5,x2=cx+5,y2=cy+5;contextShare=(prefix[y2*101+x2]-prefix[y1*101+x2]-prefix[y2*101+x1]+prefix[y1*101+x1])/100;}
    const result=SvampModel.assess({code,forestShare:wooded/total,soil,weather:packet.data.weather,contextShare});
    cells.push({id:`${row+1}:${col+1}`,row,col,size,x,y,code,forest:forest.labels[code],forestShare:wooded/total,contextShare,soil,
      soilLabel:soil||(soils.length?soils.join(' / ')+' · gränszon':'Jordart saknas'),...result});
  }
  return SvampModel.limitTopLevels(cells).sort((a,b)=>SvampModel.rank[b.level]-SvampModel.rank[a.level]||(b.score||0)-(a.score||0)||a.row-b.row||a.col-b.col);
}
self.onmessage=event=>{try{const cells=buildCells(event.data.packet,event.data.size);self.postMessage({cells});}catch(error){self.postMessage({error:error.message});}};
