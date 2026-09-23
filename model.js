/* Preliminär, ej kalibrerad regelmodell. Inga procentsannolikheter. v20261002.0 */
(function (root) {
  'use strict';
  function insideRing(point, ring) {
    let inside = false; const [x, y] = point;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    } return inside;
  }
  function inside(point, geometry) {
    if (!geometry) return false;
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
    return polygons.some(rings => insideRing(point, rings[0]) && !rings.slice(1).some(ring => insideRing(point, ring)));
  }
  function isForest(code) { return (code >= 111 && code <= 117) || (code >= 121 && code <= 127); }
  function summarizeWeather(data, today) {
    const daily = data.daily; if (!daily || !Array.isArray(daily.time)) throw new Error('Väderformat saknas');
    const rows = daily.time.map((date, i) => ({ date, rain: daily.precipitation_sum?.[i], temp: daily.temperature_2m_mean?.[i] }));
    const past = rows.filter(row => row.date < today).slice(-14);
    const expected = new Date(today + 'T12:00:00Z'); expected.setUTCDate(expected.getUTCDate() - 14);
    if (past.length !== 14 || past.some((row, i) => { const day = new Date(expected); day.setUTCDate(day.getUTCDate() + i); return row.date !== day.toISOString().slice(0, 10) || !Number.isFinite(row.rain) || row.rain < 0 || !Number.isFinite(row.temp); })) throw new Error('14 hela dagar saknas');
    const rain14 = past.reduce((sum, row) => sum + row.rain, 0);
    return { rain14, wetDays14: past.filter(row => row.rain >= 1).length, maxRainShare: rain14 > 0 ? Math.max(...past.map(row => row.rain)) / rain14 : 1, temp7: past.slice(-7).reduce((sum, row) => sum + row.temp, 0) / 7, start: past[0].date, end: past[13].date };
  }
  function assess({ code, forestShare, soil, weather, contextShare = null }) {
    if (!isForest(code) || forestShare < 0.6) return { level: 'none', label: 'Ingen tydlig skogsyta', reason: 'Mindre än 60 % skog. Ingen bedömning.' };
    if (!soil || !weather) return { level: 'unknown', label: 'Underlag saknas', reason: 'Både jordart och 14 dagar väder behövs.' };
    if (/vatten/i.test(soil)) return { level: 'unknown', label: 'Motstridiga underlag', reason: 'Skogskartan och jordartskartan stämmer inte överens.' };
    const wet = code >= 121; let habitat = wet ? 1 : 3;
    let soilPoints = /morän/i.test(soil) ? 2 : /sand|grus|isälv/i.test(soil) ? 1 : 0;
    let weatherPoints = weather.rain14 >= 15 && weather.rain14 <= 80 && weather.temp7 >= 7 && weather.temp7 <= 18 ? 2 : weather.rain14 >= 5 && weather.temp7 >= 3 && weather.temp7 <= 22 ? 1 : 0;
    const stress = weather.rain14 < 5 || weather.temp7 < 3 || weather.temp7 > 22;
    const score = habitat + soilPoints + weatherPoints;
    let level = stress || /torv|lera|silt|berg/i.test(soil) || wet ? 'low' : score >= 7 ? 'promising' : 'possible';
    const strongWeather = weather.rain14 >= 25 && weather.rain14 <= 65 && weather.temp7 >= 8 && weather.temp7 <= 17 && weather.wetDays14 >= 5 && weather.maxRainShare <= 0.4;
    if (level === 'promising' && [112,113,114].includes(code) && forestShare >= 0.9 && contextShare >= 0.9 && strongWeather) level = 'high';
    if (level === 'high' && code === 114 && contextShare >= 0.97 && weather.rain14 >= 35 && weather.rain14 <= 50 && weather.temp7 >= 10 && weather.temp7 <= 14 && weather.wetDays14 >= 7 && weather.maxRainShare <= 0.25) level = 'veryHigh';
    const reason = (wet ? 'Skog på våtmark prioriteras lägre. ' : 'Skog på fastmark ger grund. ') + (/morän/i.test(soil) ? 'Morän höjer. ' : /sand|grus|isälv/i.test(soil) ? 'Grövre jord ger mindre bidrag. ' : 'Jordarten ger inget positivt bidrag. ') + (stress ? 'Torrt/ogynnsamt väder sänker.' : weatherPoints === 2 ? 'Vädret ger positivt bidrag.' : 'Vädret ger begränsat stöd.');
    return { level, rawLevel: level, score: score + (contextShare || 0) + forestShare / 10, label: labels[level], reason };
  }
  const labels = { low: 'Svag indikation', promising: 'Lovande indikation', possible: 'Möjlig indikation', high: 'Stor indikation', veryHigh: 'Mycket stor indikation' };
  const rank = { veryHigh: 5, high: 4, promising: 3, possible: 2, low: 1, unknown: 0, none: -1 };
  function limitTopLevels(cells) {
    const known = cells.filter(cell => rank[cell.level] > 0);
    const eligible = known.filter(cell => ['high','veryHigh'].includes(cell.level)).sort((a,b) => rank[b.level]-rank[a.level] || b.score-a.score || a.row-b.row || a.col-b.col);
    const topCap = Math.floor(known.length * 0.05), veryCap = Math.floor(known.length * 0.01);
    let veryUsed = 0;
    eligible.forEach((cell, i) => {
      cell.level = i >= topCap ? 'promising' : cell.level === 'veryHigh' && veryUsed++ < veryCap ? 'veryHigh' : 'high';
      cell.label = labels[cell.level];
      if (cell.level === 'high' || cell.level === 'veryHigh') cell.reason += ' Extra stöd: sammanhängande skog och jämn nederbörd. Toppnivåerna begränsas av försiktighetsregler.';
    });
    return cells;
  }
  root.SvampModel = { inside, isForest, summarizeWeather, assess, limitTopLevels, rank };
})(typeof window === 'undefined' ? globalThis : window);
