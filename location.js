(function () {
  'use strict';
  window.initLocation = function initLocation({ map, L, onFirstFix } = {}) {
    const get = id => document.getElementById(id);
    const button = get('locate'), dialog = get('consent'), status = get('locationStatus');
    const compassButton = get('compass'), compassStatus = get('compassStatus'), recenter = get('recenter');
    let active = false, watchId = null, generation = 0, firstFix = true;
    let marker = null, circle = null, point = null, heading = null, fixTime = 0;
    let compassActive = false, compassPending = false, compassGeneration = 0, compassTimer = null, headingTime = 0;
    const normalise = angle => (angle % 360 + 360) % 360;
    const say = text => { if (status) status.textContent = text; };
    const sayCompass = text => { if (compassStatus) compassStatus.textContent = text; };
    const screenAngle = () => Number.isFinite(window.screen?.orientation?.angle) ? window.screen.orientation.angle : Number.isFinite(window.orientation) ? window.orientation : 0;
    function updateButtons() {
      if (button) { button.disabled = !map; button.textContent = active ? 'Stäng av position' : 'Visa min position'; button.setAttribute('aria-pressed', String(active)); }
      if (compassButton) { compassButton.disabled = !active || compassPending; compassButton.textContent = compassPending ? 'Väntar…' : compassActive ? 'Stäng av kompass' : 'Aktivera kompass'; compassButton.setAttribute('aria-pressed', String(compassActive)); }
      if (recenter) recenter.disabled = !point || !active;
    }
    function drawHeading() {
      const element = marker?.getElement(); if (!element) return;
      const arrow = element.querySelector('.location-direction'), dot = element.querySelector('.location-point');
      const hasHeading = heading !== null && compassActive && !document.hidden;
      arrow.hidden = !hasHeading; dot.hidden = hasHeading;
      if (hasHeading) { arrow.style.transform = `rotate(${heading}deg)`; }
    }
    function invalidateHeading(message) { heading = null; headingTime = 0; drawHeading(); if (message) sayCompass(message); }
    function readHeading(event) {
      const angle = screenAngle();
      if (Number.isFinite(event.webkitCompassHeading) && event.webkitCompassHeading >= 0 && event.webkitCompassHeading < 360) {
        if (Number.isFinite(event.webkitCompassAccuracy) && (event.webkitCompassAccuracy < 0 || event.webkitCompassAccuracy > 45)) return null;
        return normalise(event.webkitCompassHeading + angle);
      }
      if (event.absolute !== true || ![event.alpha, event.beta, event.gamma].every(Number.isFinite)) return null;
      const rad = Math.PI / 180, a = event.alpha * rad, b = event.beta * rad, g = event.gamma * rad, s = angle * rad;
      const east = Math.sin(s) * (Math.cos(a) * Math.cos(g) - Math.sin(a) * Math.sin(b) * Math.sin(g)) - Math.cos(s) * Math.cos(b) * Math.sin(a);
      const north = Math.sin(s) * (Math.sin(a) * Math.cos(g) + Math.cos(a) * Math.sin(b) * Math.sin(g)) + Math.cos(s) * Math.cos(a) * Math.cos(b);
      if (Math.hypot(east, north) < .25) return null;
      return normalise(Math.atan2(east, north) / rad);
    }
    function orientation(event) {
      if (!active || !compassActive || document.hidden) return;
      const value = readHeading(event);
      if (value === null) { if (event.absolute || Number.isFinite(event.webkitCompassHeading)) invalidateHeading('Riktningen är osäker.'); return; }
      heading = value; headingTime = Date.now(); drawHeading(); sayCompass('Röd pil: mobilens överkant.');
    }
    function stopCompass(message = '') { compassGeneration++; compassActive = false; compassPending = false; clearInterval(compassTimer); compassTimer = null; window.removeEventListener('deviceorientation', orientation); window.removeEventListener('deviceorientationabsolute', orientation); invalidateHeading(); sayCompass(message); updateButtons(); }
    async function toggleCompass() {
      if (!active || compassPending) return; if (compassActive) { stopCompass('Kompassen av.'); return; }
      const Orientation = window.DeviceOrientationEvent; if (!window.isSecureContext || !Orientation) { sayCompass('Kompassen stöds inte här.'); return; }
      const token = ++compassGeneration; compassPending = true; updateButtons();
      try {
        const permission = typeof Orientation.requestPermission === 'function' ? await Orientation.requestPermission(true) : 'granted';
        if (!active || token !== compassGeneration) return; compassPending = false;
        if (permission !== 'granted') { sayCompass('Ingen kompassåtkomst.'); updateButtons(); return; }
        compassActive = true; window.addEventListener('deviceorientation', orientation); window.addEventListener('deviceorientationabsolute', orientation);
        sayCompass('Väntar på kompass.'); const started = Date.now();
        compassTimer = setInterval(() => { if (!active || !compassActive) return; if (!document.hidden && Date.now() - (headingTime || started) > 8000) invalidateHeading('Ingen kompassriktning.'); }, 2000);
        updateButtons();
      } catch (_) { if (token !== compassGeneration) return; stopCompass('Kunde inte starta kompass.'); }
    }
    function stop(message = 'Positionen avstängd.') { generation++; active = false; if (watchId !== null) navigator.geolocation?.clearWatch(watchId); watchId = null; stopCompass(); marker?.remove(); circle?.remove(); marker = circle = point = null; fixTime = 0; firstFix = true; say(message); updateButtons(); }
    function start() {
      dialog?.close(); if (!map || active) return;
      if (!navigator.geolocation || !window.isSecureContext) { say('Plats kräver HTTPS. Kartan fungerar utan.'); return; }
      const token = ++generation; active = true; firstFix = true; say('Söker position…'); updateButtons();
      try {
        const id = navigator.geolocation.watchPosition(position => {
          if (!active || token !== generation) return;
          const { latitude, longitude, accuracy } = position.coords;
          if (![latitude, longitude, accuracy].every(Number.isFinite)) { say('Ingen användbar position.'); return; }
          point = [latitude, longitude]; fixTime = Date.now();
          if (!marker) {
            const icon = L.divIcon({ className: 'location-marker', iconSize: [40, 40], iconAnchor: [20, 20], html: '<span class="location-point" aria-hidden="true"></span><span class="location-direction" hidden aria-hidden="true"><svg viewBox="0 0 40 40" focusable="false"><path d="M20 3L33 34L20 28L7 34Z" fill="#ed3838" stroke="#fff4d0" stroke-width="2.5" stroke-linejoin="round"/></svg></span>' });
            circle = L.circle(point, { radius: accuracy, color: '#ed3838', weight: 1, fillOpacity: .08, interactive: false }).addTo(map);
            marker = L.marker(point, { icon, interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(map);
          } else { marker.setLatLng(point); circle.setLatLng(point).setRadius(accuracy); }
          marker.getElement().classList.remove('location-stale'); marker.setOpacity(1); drawHeading();
          say(`Position · ~${Math.round(accuracy)} m · ${new Date().toLocaleTimeString('sv-SE',{hour:'2-digit',minute:'2-digit'})}.`); updateButtons();
          if (firstFix) { firstFix = false; if (typeof onFirstFix === 'function') onFirstFix([...point]); else map.setView(point, Math.max(16, map.getZoom())); }
        }, error => {
          if (!active || token !== generation) return;
          if (error.code === 1) { stop('Plats nekades. Kartan fungerar utan.'); return; }
          marker?.setOpacity(.45); invalidateHeading(); say('Väntar på ny position.');
        }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
        if (active && token === generation) watchId = id; else navigator.geolocation.clearWatch(id);
      } catch (_) { if (token === generation) stop('Kunde inte starta position.'); }
    }
    button?.addEventListener('click', () => { if (active) { stop(); return; } if (dialog && !dialog.open) dialog.showModal(); });
    get('decline')?.addEventListener('click', () => { dialog?.close(); say('Utan position.'); });
    get('allow')?.addEventListener('click', start);
    compassButton?.addEventListener('click', toggleCompass);
    recenter?.addEventListener('click', () => { if (active && point) map.setView(point, Math.max(16, map.getZoom())); });
    document.addEventListener('visibilitychange', () => { if (!active) return; if (document.hidden || Date.now() - fixTime > 30000) { marker?.setOpacity(.45); say('Uppdateringar kan pausas i bakgrunden.'); } });
    window.addEventListener('pagehide', () => { stop(''); if (dialog?.open) dialog.close(); });
    updateButtons(); return { stop };
  };
})();
