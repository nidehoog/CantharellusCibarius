
// Minimal proj4 stub for Cantharellus - only EPSG:3006 <-> EPSG:4326 (UTM 33N GRS80)
(function(global){
  var a = 6378137.0;
  var f = 1/298.257222101;
  var e2 = 2*f - f*f;
  var e4 = e2*e2;
  var e6 = e4*e2;
  var ep2 = e2/(1-e2);
  var k0 = 0.9996;
  var lon0 = 15 * Math.PI/180; // central meridian 15E for zone 33
  var fe = 500000;
  var fn = 0;

  function toRad(d){return d*Math.PI/180;}
  function toDeg(r){return r*180/Math.PI;}

  // UTM inverse: x,y (EPSG:3006) -> lon,lat (EPSG:4326)
  function utmToLonLat(x,y){
    var x_ = x - fe;
    var y_ = y - fn;
    var m = y_ / k0;
    var mu = m / (a * (1 - e2/4 - 3*e4/64 - 5*e6/256));
    var e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
    var phi1 = mu
      + (3*e1/2 - 27*e1*e1*e1/32) * Math.sin(2*mu)
      + (21*e1*e1/16 - 55*e1*e1*e1*e1/32) * Math.sin(4*mu)
      + (151*e1*e1*e1/96) * Math.sin(6*mu)
      + (1097*e1*e1*e1*e1/512) * Math.sin(8*mu);
    var sinPhi1 = Math.sin(phi1);
    var N1 = a / Math.sqrt(1 - e2*sinPhi1*sinPhi1);
    var T1 = Math.tan(phi1)*Math.tan(phi1);
    var C1 = ep2 * Math.cos(phi1)*Math.cos(phi1);
    var R1 = a * (1 - e2) / Math.pow(1 - e2*sinPhi1*sinPhi1, 1.5);
    var D = x_ / (N1 * k0);
    var lat = phi1 - (N1*Math.tan(phi1)/R1)*(D*D/2 - (5+3*T1+10*C1-4*C1*C1-9*ep2)*D*D*D*D/24 + (61+90*T1+298*C1+45*T1*T1-252*ep2-3*C1*C1)*D*D*D*D*D*D/720);
    var lon = lon0 + (D - (1+2*T1+C1)*D*D*D/6 + (5-2*C1+28*T1-3*C1*C1+8*ep2+24*T1*T1)*D*D*D*D*D/120) / Math.cos(phi1);
    return [toDeg(lon), toDeg(lat)];
  }

  // Forward: lon,lat -> x,y (not strictly needed but implement for completeness)
  function lonLatToUtm(lon, lat){
    var phi = toRad(lat);
    var lambda = toRad(lon);
    var N = a / Math.sqrt(1 - e2*Math.sin(phi)*Math.sin(phi));
    var T = Math.tan(phi)*Math.tan(phi);
    var C = ep2 * Math.cos(phi)*Math.cos(phi);
    var A = Math.cos(phi)*(lambda - lon0);
    var M = a * ((1 - e2/4 - 3*e4/64 - 5*e6/256)*phi
      - (3*e2/8 + 3*e4/32 + 45*e6/1024)*Math.sin(2*phi)
      + (15*e4/256 + 45*e6/1024)*Math.sin(4*phi)
      - (35*e6/3072)*Math.sin(6*phi));
    var x = fe + k0*N*(A + (1 - T + C)*A*A*A/6 + (5 - 18*T + T*T + 72*C - 58*ep2)*A*A*A*A*A/120);
    var y = fn + k0*(M + N*Math.tan(phi)*(A*A/2 + (5 - T + 9*C + 4*C*C)*A*A*A*A/24 + (61 - 58*T + T*T + 600*C - 330*ep2)*A*A*A*A*A*A/720));
    return [x, y];
  }

  function proj4(from, to, point){
    // Support signatures: proj4('EPSG:3006','EPSG:4326',point) and proj4('EPSG:4326','EPSG:3006',point)
    // and proj4('EPSG:3006', point)?? For our usage, we only need first form.
    var f = from, t = to, p = point;
    // If called as proj4(from, to) returns function, not needed
    if(Array.isArray(t) && !p){ p = t; t = f; f = null; }
    // Normalize
    var fromCode = (typeof f === 'string' ? f : t);
    var toCode = (typeof t === 'string' && !Array.isArray(t) ? t : null);
    var pt = p || t;
    if(!pt) return null;
    // If point is array [x,y] or [lon,lat]
    if(typeof fromCode === 'string' && typeof toCode === 'string'){
      var fc = fromCode.toUpperCase(), tc = toCode.toUpperCase();
      if(fc.includes('3006') && tc.includes('4326')){
        return utmToLonLat(pt[0], pt[1]);
      } else if(fc.includes('4326') && tc.includes('3006')){
        return lonLatToUtm(pt[0], pt[1]);
      } else if(fc===tc){
        return [pt[0], pt[1]];
      }
    }
    // Fallback identity
    return [pt[0], pt[1]];
  }
  proj4.defs = function(){};
  // expose
  global.proj4 = proj4;
  if(typeof self !== 'undefined') self.proj4 = proj4;
  if(typeof window !== 'undefined') window.proj4 = proj4;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this);
