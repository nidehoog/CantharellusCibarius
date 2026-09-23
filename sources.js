/* Alla anrop avser en avrundad analysruta, aldrig geolocation-objektet.
   Inga nycklar, proxyer, cookies eller beständig lagring. v2 med avverkning */
(function (root) {
  'use strict';
  const NMD = 'https://geodata.naturvardsverket.se/inspire/lc-nmd/ows';
  const LAYER = 'LC.LandCoverRaster.Bas_2.0';
  const SGU = 'https://api.sgu.se/oppnadata/jordarter25k-100k/ogc/features/v1/collections/grundlager/items';
  const SKOGSSTYRELSEN_WFS = 'https://geodataservice.skogsstyrelsen.se/geoserver/Avverkning/ows';
  let legendCache;
  function url(base, params) { return base + '?' + new URLSearchParams(params); }
  async function response(address, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 20000);
    try {
      const result = await fetch(address, { signal: controller.signal, credentials: 'omit', cache: 'no-store' });
      if (!result.ok) throw new Error('Tjänsten svarade ' + result.status);
      const buffer = await result.arrayBuffer();
      if (buffer.byteLength > 12000000) throw new Error('För stort datauttag');
      return { buffer, type: result.headers.get('content-type') || '' };
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async function json(address, signal) {
    const r = await response(address, signal);
    return JSON.parse(new TextDecoder().decode(r.buffer));
  }
  async function forest(box, signal) {
    const common = { SERVICE: 'WMS', VERSION: '1.1.1', LAYERS: LAYER, STYLES: '', SRS: 'EPSG:3006', BBOX: box.xy.join(','), WIDTH: 100, HEIGHT: 100 };
    const [legend, imageData] = await Promise.all([
      legendCache ? Promise.resolve(legendCache) : json(url(NMD, { SERVICE: 'WMS', VERSION: '1.1.1', REQUEST: 'GetLegendGraphic', LAYER, FORMAT: 'application/json' }), signal),
      response(url(NMD, { ...common, REQUEST: 'GetMap', FORMAT: 'image/png', TRANSPARENT: 'true', FORMAT_OPTIONS: 'antialiasing:off' }), signal)
    ]);
    const entries = legend.Legend?.[0]?.rules?.flatMap(rule => rule.symbolizers || []).flatMap(symbolizer => symbolizer.Raster?.colormap?.entries || []);
    if (!entries?.length || !imageData.type.includes('image/png')) throw new Error('Skogstjänstens format har ändrats');
    legendCache = legend;
    const palette = new Map(), labels = {};
    for (const entry of entries) {
      const rgb = entry.color.toUpperCase();
      const code = Number(entry.quantity);
      palette.set(rgb, palette.has(rgb) ? null : code);
      labels[code] = entry.label.replace(/^[\d\s]+/, '').trim();
    }
    const bitmap = await createImageBitmap(new Blob([imageData.buffer], { type: 'image/png' }));
    const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 100;
    if (bitmap.width !== 100 || bitmap.height !== 100) { bitmap.close(); throw new Error('Fel rasterstorlek'); }
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0); bitmap.close();
    const pixels = context.getImageData(0, 0, 100, 100).data;
    const codes = new Array(10000).fill(null);
    for (let i = 0; i < codes.length; i++) {
      if (pixels[i * 4 + 3] !== 255) continue;
      const hex = '#' + Array.from(pixels.slice(i * 4, i * 4 + 3), value => value.toString(16).padStart(2, '0')).join('').toUpperCase();
      codes[i] = palette.get(hex) ?? null;
    }
    const checkIndex = codes.findIndex(code => SvampModel.isForest(code));
    if (checkIndex >= 0) {
      const check = await json(url(NMD, { ...common, REQUEST: 'GetFeatureInfo', QUERY_LAYERS: LAYER, X: checkIndex % 100, Y: Math.floor(checkIndex / 100), INFO_FORMAT: 'application/json', FEATURE_COUNT: 1 }), signal);
      const value = Number(check.features?.[0]?.properties?.['Värde_kod']);
      if (value !== codes[checkIndex]) throw new Error('Skogsklassningen kunde inte verifieras');
    }
    if (!codes.some(code => code !== null)) throw new Error('NMD2023 v2.0 saknar täckning här');
    return { codes, labels, source: 'NMD2023 v2.0 · Naturvårdsverket', fetched: Date.now() };
  }
  async function soil(box, signal) {
    const data = await json(url(SGU, { f: 'json', bbox: box.geoBbox.join(','), limit: 1000 }), signal);
    if (!Array.isArray(data.features)) throw new Error('Jordartsformat saknas');
    if (data.numberMatched > data.features.length || data.links?.some(link => link.rel === 'next') || data.features.length >= 1000) throw new Error('Jordartsuttaget är ofullständigt');
    return { features: data.features, source: 'SGU · grundlager', fetched: Date.now() };
  }
  async function weather(box, signal) {
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const data = await json(url('https://api.open-meteo.com/v1/forecast', { latitude: box.weatherLat, longitude: box.weatherLon, daily: 'precipitation_sum,temperature_2m_mean', past_days: 14, forecast_days: 1, timezone: 'Europe/Stockholm' }), signal);
    return { ...SvampModel.summarizeWeather(data, today), source: 'Open-Meteo', fetched: Date.now() };
  }
  async function forecast(box, signal) {
    const address = `https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1/geotype/point/lon/${box.weatherLon}/lat/${box.weatherLat}/data.json?timeseries=48&parameters=air_temperature`;
    const data = await json(address, signal);
    const issued = Date.parse(data.referenceTime);
    if (!Number.isFinite(issued) || Date.now() - issued > 24 * 3600000) throw new Error('SMHI-prognosen är för gammal');
    const rows = data.timeSeries?.filter(row => Date.parse(row.time) > Date.now() && Date.parse(row.time) <= Date.now() + 24 * 3600000);
    const temperatures = rows.map(row => row.data.air_temperature);
    return { min: Math.min(...temperatures), max: Math.max(...temperatures), issued, source: 'SMHI SNOW · 24h', fetched: Date.now() };
  }
  async function avverkningar(box, signal) {
    // Buffert 200m runt 1km-rutan
    const bbox = [box.xy[0]-200, box.xy[1]-200, box.xy[2]+200, box.xy[3]+200].join(',');
    const common = { service:'WFS', version:'2.0.0', request:'GetFeature', srsName:'EPSG:3006', bbox, outputFormat:'application/json', count: 100 };
    try {
      const [utforda, anmalda] = await Promise.all([
        json(url(SKOGSSTYRELSEN_WFS, {...common, typeNames:'Avverkning:UtfordAvverkning'}), signal).catch(()=>({features:[]})),
        json(url(SKOGSSTYRELSEN_WFS, {...common, typeNames:'Avverkning:Avverkningsanmalan'}), signal).catch(()=>({features:[]}))
      ]);
      function yearFrom(f){
        const p=f.properties||{};
        const cand=[p.avverkad_ar,p.avverkningssasong,p.anmalningsar,p.AR,p.avverkadAr,p.AvverkadAr,p.avverkad_ar];
        for(const c of cand){ if(c){ const y=parseInt(String(c).slice(0,4)); if(y>1900&&y<2100) return y; } }
        // Försök datumfält
        const d=p.avverkningstidpunkt||p.registreringsdatum||p.anmalningsdatum;
        if(d){ const y=parseInt(String(d).slice(0,4)); if(y>1900&&y<2100) return y; }
        return null;
      }
      const cleanU = (utforda.features||[]).filter(f=>f.geometry).map(f=>({type:'Feature',geometry:f.geometry,properties:{...f.properties,_year:yearFrom(f)}}));
      const cleanA = (anmalda.features||[]).filter(f=>f.geometry).map(f=>({type:'Feature',geometry:f.geometry,properties:{...f.properties,_year:yearFrom(f)}}));
      return { utforda: cleanU, anmalda: cleanA, source: 'Skogsstyrelsen · Avverkningar', fetched: Date.now() };
    } catch(e) {
      // Om tjänsten saknas, returnera tom men inte fel - så att karta ändå fungerar
      return { utforda: [], anmalda: [], source: 'Skogsstyrelsen · ingen data', fetched: Date.now(), error: e.message };
    }
  }
  root.SvampSources = { forest, soil, weather, forecast, avverkningar, clear: () => { legendCache = undefined; } };
})(window);
