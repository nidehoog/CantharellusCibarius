// Cloudflare Worker - Cantharellus v5.5 - ny Lantmäteriet API (2024+)
// Stödjer både gammal token-URL och ny: LM_USERNAME (systemkonto) + LM_PASSWORD (API-nyckel)
// Ny metod: hämtar Bearer token från https://api.lantmateriet.se/token

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    const baseCors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: baseCors });

    function getCreds() {
      const user = (env.LM_USERNAME || env.LANTMATERIET_USERNAME || "").trim();
      const pass = (env.LM_PASSWORD || env.LANTMATERIET_PASSWORD || "").trim();
      if (!user || !pass) return null;
      return { user, pass };
    }

    async function getLantmaterietBearerToken(creds) {
      // Cache token i Workers KV? Vi använder enkel in-memory cache via caches API
      // För enkelhet: försök hämta token varje gång men cacha 1h i Cache API
      const cacheKeyUrl = `https://api.lantmateriet.se/token-cache/${creds.user}`;
      try {
        const cache = caches.default;
        const cachedReq = new Request(cacheKeyUrl);
        const cached = await cache.match(cachedReq);
        if (cached) {
          const data = await cached.json();
          if (data.exp && Date.now() < data.exp - 60000) return data.token;
        }
      } catch {}

      // Hämta ny token - enligt docs: https://api.lantmateriet.se/token med Basic auth + X-API-Key
      // Curl: curl -u "SYSTEMUSER:API_KEY" -H "X-API-Key: API_KEY" https://api.lantmateriet.se/token
      const basic = btoa(`${creds.user}:${creds.pass}`);
      const tokenRes = await fetch("https://api.lantmateriet.se/token", {
        method: "GET",
        headers: {
          "Authorization": `Basic ${basic}`,
          "X-API-Key": creds.pass,
          "User-Agent": "Cantharellus/5.5"
        }
      });

      if (!tokenRes.ok) {
        const txt = await tokenRes.text();
        throw new Error(`Token fetch ${tokenRes.status}: ${txt.slice(0,500)}`);
      }

      const tokenData = await tokenRes.json().catch(async () => {
        const t = await tokenRes.text();
        return { access_token: t.trim() };
      });

      const token = tokenData.access_token || tokenData.token || tokenData;
      if (!token || typeof token !== "string") throw new Error("No token in response");

      // Cacha token 55 min
      try {
        const cache = caches.default;
        const exp = Date.now() + 55 * 60 * 1000;
        const resp = new Response(JSON.stringify({ token, exp }), { headers: { "Cache-Control": "public, max-age=3300" } });
        ctx.waitUntil(cache.put(new Request(cacheKeyUrl), resp.clone()));
      } catch {}

      return token;
    }

    try {
      if (path === "/" || path === "") {
        const creds = getCreds();
        return new Response(`Cantharellus worker v5.5 OK\nHas LM_USERNAME: ${!!creds?.user}\nHas LM_PASSWORD: ${!!creds?.pass}\nHas TOKEN: ${!!(env.LANTMATERIET_TOKEN||"").trim()}\n\nEndpoints:\n/lm/catalog - historiska\n/lm/wms - tiles\n/lm/features/... - öppna geodata`, { headers: baseCors });
      }

      // Historiska ortofoton
      if (path === "/lm/wms" || path === "/lm/wms/" || path === "/lm/catalog") {
        const tokenEnv = (env.LANTMATERIET_TOKEN || "").trim();
        const creds = getCreds();
        let upstreamUrl;
        let headers = { "User-Agent": "Cantharellus/5.5" };

        if (tokenEnv) {
          // Gammal metod - token direkt i URL
          const base = `https://api.lantmateriet.se/historiska-ortofoton/wms/v1/token/${tokenEnv}/`;
          upstreamUrl = new URL(base);
        } else if (creds) {
          // Ny metod - hämta Bearer token och använd /historiskaortofoton/wms/v1 eller /historiska-ortofoton/wms/v1
          try {
            const bearer = await getLantmaterietBearerToken(creds);
            // Prova nya endpointen först (utan bindestreck i vissa docs)
            const base = "https://api.lantmateriet.se/historiska-ortofoton/wms/v1/";
            upstreamUrl = new URL(base);
            headers["Authorization"] = `Bearer ${bearer}`;
            headers["X-API-Key"] = creds.pass;
          } catch (e) {
            // Fallback: försök utan Bearer, bara Basic (äldre API)
            const base = "https://api.lantmateriet.se/historiska-ortofoton/wms/v1/";
            upstreamUrl = new URL(base);
            const basic = btoa(`${creds.user}:${creds.pass}`);
            headers["Authorization"] = `Basic ${basic}`;
            headers["X-API-Key"] = creds.pass;
          }
        } else {
          return new Response("Missing auth: Set LANTMATERIET_TOKEN or LM_USERNAME+LM_PASSWORD", { status: 500, headers: baseCors });
        }

        url.searchParams.forEach((v,k)=>upstreamUrl.searchParams.set(k,v));
        if (path === "/lm/catalog") {
          upstreamUrl.searchParams.set("SERVICE","WMS");
          upstreamUrl.searchParams.set("VERSION","1.1.1");
          upstreamUrl.searchParams.set("REQUEST","GetCapabilities");
          return await proxyWithCache(upstreamUrl.toString(), headers, {...baseCors, "Cache-Control":"public, max-age=3600"}, ctx, 3600, true);
        }
        return await proxyWithCache(upstreamUrl.toString(), headers, {...baseCors, "Cache-Control":"public, max-age=86400"}, ctx, 86400, true);
      }

      if (path.startsWith("/lm/features/")) {
        const remainder = path.replace("/lm/features/", ""); // ex: marktacke/collections eller hydrografi/items?bbox=...
        const slashIdx = remainder.indexOf("/");
        let product = slashIdx >= 0 ? remainder.slice(0, slashIdx) : remainder;
        let rest = slashIdx >= 0 ? remainder.slice(slashIdx+1) : "";
        // Normalisera produktnamn: marktacke -> marktacke, hydrografi -> hydrografi, topowebb -> topowebb-ccby etc
        product = product.toLowerCase();
        // Bygg korrekt OGC API Features URL: /open/{product}/v1/{rest}
        // Fallback om rest tom
        let baseUrl;
        if (rest) {
          baseUrl = `https://api.lantmateriet.se/open/${product}/v1/${rest}`;
        } else {
          baseUrl = `https://api.lantmateriet.se/open/${product}/v1/`;
        }
        const upstreamUrl = new URL(baseUrl);
        // Lägg till query params från inkommande request (bbox, collection etc)
        url.searchParams.forEach((v,k)=>upstreamUrl.searchParams.set(k,v));
        let headers = { "User-Agent": "Cantharellus/5.5" };
        const creds = getCreds();
        if (creds) {
          try {
            const bearer = await getLantmaterietBearerToken(creds);
            headers["Authorization"] = `Bearer ${bearer}`;
            headers["X-API-Key"] = creds.pass;
          } catch {
            const basic = btoa(`${creds.user}:${creds.pass}`);
            headers["Authorization"] = `Basic ${basic}`;
            headers["X-API-Key"] = creds.pass;
          }
        }
        // Prova även fallback till gamla geodata-base om nya ger 404
        const primaryRes = await proxyWithCache(upstreamUrl.toString(), headers, {...baseCors, "Cache-Control":"public, max-age=600"}, ctx, 600, false);
        if (primaryRes.status === 404) {
          // Fallback: gamla strukturen /open/geodata/{remainder}
          const fallbackBase = (env.LANTMATERIET_FEATURES_BASE || "https://api.lantmateriet.se/open/geodata/").trim();
          const fallbackUrl = new URL(fallbackBase + remainder);
          url.searchParams.forEach((v,k)=>fallbackUrl.searchParams.set(k,v));
          return await proxyWithCache(fallbackUrl.toString(), headers, {...baseCors, "Cache-Control":"public, max-age=600"}, ctx, 600, false);
        }
        return primaryRes;
      }

      // Sentinel
      if (path.startsWith("/sentinel/eox/")) {
        const parts = path.replace("/sentinel/eox/", "").split("/");
        const date = parts.shift();
        const tilePath = parts.join("/");
        const s2a = `https://tiles.maps.eox.at/wmts/1.0.0/s2a_3857/default/${date}/g/${tilePath}`;
        const s2b = `https://tiles.maps.eox.at/wmts/1.0.0/s2b_3857/default/${date}/g/${tilePath}`;
        let res = await fetchWithCache(s2a, ctx, 43200);
        if (res.status === 404) res = await fetchWithCache(s2b, ctx, 43200);
        const headers = new Headers(res.headers);
        Object.entries(baseCors).forEach(([k,v])=>headers.set(k,v));
        headers.set("Cache-Control","public, max-age=43200");
        return new Response(res.body, {status: res.status, headers});
      }

      if (path.startsWith("/sentinel/esri/")) {
        const tilePath = path.replace("/sentinel/esri/", "");
        const upstream = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${tilePath}`;
        return await proxyWithCache(upstream, {}, {...baseCors, "Cache-Control":"public, max-age=86400"}, ctx, 86400, false);
      }

      return new Response("Not found: "+path, {status:404, headers: baseCors});

    } catch (e) {
      return new Response("Worker error: "+e.message+"\n"+(e.stack||""), {status:502, headers: baseCors});
    }
  }
};

async function fetchWithCache(upstreamUrl, ctx, cacheSeconds){
  try {
    const cache = caches.default;
    const req = new Request(upstreamUrl);
    const cached = await cache.match(req);
    if(cached) return cached;
    const res = await fetch(upstreamUrl, {headers:{"User-Agent":"Cantharellus/5.5"}});
    if(!res.ok && res.status!==404) return res;
    const h = new Headers(res.headers);
    h.set("Cache-Control",`public, max-age=${cacheSeconds}`);
    const out = new Response(res.body, {status: res.status, headers: h});
    ctx.waitUntil(cache.put(req, out.clone()));
    return out;
  } catch {
    return await fetch(upstreamUrl, {headers:{"User-Agent":"Cantharellus/5.5-fallback"}});
  }
}

async function proxyWithCache(upstreamUrl, extraHeaders, corsHeaders, ctx, cacheSeconds, tryAlternatePath=false) {
  const fetchUpstream = async (urlToFetch) => {
    try {
      const cache = caches.default;
      const cacheKey = new Request(urlToFetch);
      const cached = await cache.match(cacheKey);
      if (cached) {
        const nh = new Headers(cached.headers);
        Object.entries(corsHeaders).forEach(([k,v])=>nh.set(k,v));
        return new Response(cached.body, {status: cached.status, headers: nh});
      }
      const headers = {"User-Agent":"Cantharellus/5.5", ...extraHeaders};
      const res = await fetch(urlToFetch, {headers});
      if (!res.ok) {
        const txt = await res.text();
        // Om 520 och vi inte provat alternate path, prova annan variant av URL
        if (tryAlternatePath && res.status===520) {
          // Prova utan bindestreck: historiskaortofoton istället för historiska-ortofoton
          if (urlToFetch.includes("historiska-ortofoton")) {
            const alt = urlToFetch.replace("historiska-ortofoton", "historiskaortofoton");
            const res2 = await fetch(alt, {headers});
            if (res2.ok) {
              const h2 = new Headers(res2.headers);
              Object.entries(corsHeaders).forEach(([k,v])=>{ if(k.toLowerCase()!=="cache-control") h2.set(k,v); });
              h2.set("Cache-Control",`public, max-age=${cacheSeconds}`);
              const out2 = new Response(res2.body, {status: res2.status, headers: h2});
              ctx.waitUntil(cache.put(new Request(alt), out2.clone()));
              return out2;
            }
          }
        }
        return new Response(`Upstream ${res.status}: ${txt.slice(0,1000)}\nURL: ${urlToFetch}`, {status: res.status, headers: {...corsHeaders, "Content-Type":"text/plain"}});
      }
      const rh = new Headers(res.headers);
      Object.entries(corsHeaders).forEach(([k,v])=>{ if(k.toLowerCase()!=="cache-control") rh.set(k,v); });
      rh.set("Cache-Control",`public, max-age=${cacheSeconds}`);
      const out = new Response(res.body, {status: res.status, headers: rh});
      ctx.waitUntil(cache.put(cacheKey, out.clone()));
      return out;
    } catch (e) {
      // Fallback utan cache
      try {
        const headers = {"User-Agent":"Cantharellus/5.5-fallback", ...extraHeaders};
        const res = await fetch(urlToFetch, {headers});
        if (!res.ok) {
          const txt = await res.text();
          return new Response(`Upstream ${res.status} (no cache): ${txt.slice(0,1000)}\nURL: ${urlToFetch}\nErr: ${e.message}`, {status: res.status, headers: {...corsHeaders, "Content-Type":"text/plain"}});
        }
        const rh = new Headers(res.headers);
        Object.entries(corsHeaders).forEach(([k,v])=>rh.set(k,v));
        return new Response(res.body, {status: res.status, headers: rh});
      } catch (e2) {
        return new Response(`Proxy failed: ${e.message} / ${e2.message}\nURL: ${urlToFetch}`, {status:502, headers: corsHeaders});
      }
    }
  };
  return await fetchUpstream(upstreamUrl);
}
