/*
  Rutas Inteligentes 2025 – Zamora & Jacona
  Desarrollado por: Dr. Héctor Arciniega
  Copyright © 2025
  Código optimizado bajo principios CMA y Unified Browser Code (UBC)
*/

// =========================
// CONFIGURACIÓN DEL MAPA
// =========================
const MAP_CENTER = [19.989, -102.283];
const MAP_ZOOM = 13;

const map = L.map("map").setView(MAP_CENTER, MAP_ZOOM);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "© OpenStreetMap"
}).addTo(map);

// =========================
// API KEY GEOAPIFY
// =========================
const GEOAPIFY_KEY = "2a2f74829e60448e8427c3cf0a502a17";

// =========================
// ESTADO GLOBAL
// =========================
let userLocation = null;
let userMarker = null;
let destinationMarker = null;
let boardMarker = null;
let alightMarker = null;

// Tramo activo animado
let suggestedSegmentPolyline = null;
let dashAnimInterval = null;

const statusBox = document.getElementById("smartRoutingStatus");
const instr = document.getElementById("instructionsBox");
const destinationInput = document.getElementById("destinationInput");
const searchButton = document.getElementById("searchButton");
const suggestionsBox = document.getElementById("destinationSuggestions");

const ROUTE_FILES = [
  { id: "cafe", file: "cafe.json" },
  { id: "morada", file: "morada.json" },
  { id: "rosa", file: "rosa.json" }
];

let ROUTES = [];
let DESTINATIONS = [];
let selectedSuggestion = null;

// =========================
// UTILIDADES
// =========================
function haversine(a, b) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function computeTotalDistance(points) {
  let dist = 0;
  for (let i = 0; i < points.length - 1; i++) {
    dist += haversine(points[i], points[i + 1]);
  }
  return dist;
}

// 4 bandas finas
function getTimeBand() {
  const h = new Date().getHours();
  if (h >= 5 && h < 11) return "morning";
  if (h >= 11 && h < 17) return "midday";
  if (h >= 17 && h < 21) return "evening";
  return "night";
}

function getDayPeriodLabel(band) {
  if (band === "morning") return "mañana";
  if (band === "night") return "noche";
  return "tarde";
}

function normalize(str) {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clearMarkers() {
  if (destinationMarker) {
    map.removeLayer(destinationMarker);
    destinationMarker = null;
  }
  if (boardMarker) {
    map.removeLayer(boardMarker);
    boardMarker = null;
  }
  if (alightMarker) {
    map.removeLayer(alightMarker);
    alightMarker = null;
  }
  if (suggestedSegmentPolyline) {
    map.removeLayer(suggestedSegmentPolyline);
    suggestedSegmentPolyline = null;
  }
  if (dashAnimInterval) {
    clearInterval(dashAnimInterval);
    dashAnimInterval = null;
  }
}

function highlightRoute(routeId) {
  ROUTES.forEach(r => {
    if (!r.polyline) return;
    r.polyline.setStyle({
      weight: r.id === routeId ? 6 : 4,
      opacity: r.id === routeId ? 0.9 : 0.2
    });
  });
}

// Velocidades fijas aproximadas
function getRouteAverageBusSpeed(route, band) {
  const speedsKmh = {
    morning: 20,
    midday: 14,
    evening: 14,
    night: 25
  };
  const v = speedsKmh[band] || 20;
  return (v * 1000) / 3600;
}

const WALK_SPEED_MS = (4.5 * 1000) / 3600;

function walkingMinutes(m) {
  return m / WALK_SPEED_MS / 60;
}

const BUS_WAIT_MINUTES = {
  morning: 3,
  midday: 4,
  evening: 4,
  night: 3
};

// tolerancias
const MAX_WALK_FROM_BUS = 2000;   // máx metros desde parada de bajada al destino
const DEST_PRIORITY_MARGIN = 150; // si una ruta deja >150 m más cerca, se prefiere

// =========================
// GEOMETRÍA SOBRE LA RUTA
// =========================
function nearestPointIndex(points, coord) {
  let bestIdx = 0;
  let bestD = Infinity;
  points.forEach((pt, i) => {
    const d = haversine(coord, pt);
    if (d < bestD) {
      bestD = d;
      bestIdx = i;
    }
  });
  return bestIdx;
}

// Parada más cercana a una coordenada
function nearestParadaToPoint(route, coord) {
  let best = null;
  route.paradas.forEach(p => {
    const d = haversine(coord, p.coords);
    if (!best || d < best.distance) best = { parada: p, distance: d };
  });
  return best;
}

function countParadasBetween(route, idxA, idxB) {
  const s = Math.min(idxA, idxB);
  const e = Math.max(idxA, idxB);
  return Math.max(
    0,
    route.paradas.filter(p => p.index >= s && p.index <= e).length - 1
  );
}

// =========================
// CARGA RUTAS
// =========================
async function loadRoutes() {
  const basePath = "assets/data/rutas/";

  const promises = ROUTE_FILES.map(async cfg => {
    const res = await fetch(basePath + cfg.file);
    const data = await res.json();

    const route = {
      id: data.name,
      label: data.label,
      color: data.color,
      meta: data.meta,
      points: data.points,
      paradas: data.paradas
    };

    route.totalDistance = computeTotalDistance(route.points);

    route.polyline = L.polyline(route.points, {
      color: route.color,
      weight: 4,
      opacity: 0.8
    }).addTo(map);

    ROUTES.push(route);

    route.paradas.forEach(p => {
      DESTINATIONS.push({
        id: `${route.id}-${p.index}`,
        label: p.nombre,
        labelFull: `${p.nombre} · ${route.label}`,
        coords: p.coords,
        routeId: route.id,
        paradaIndex: p.index
      });
    });
  });

  await Promise.all(promises);
  statusBox.textContent = "Rutas cargadas · SmartRouting listo";
}

// =========================
// AUTOCOMPLETE
// =========================
function renderSuggestions(query) {
  suggestionsBox.innerHTML = "";
  selectedSuggestion = null;

  const q = normalize(query);
  if (!q) return;

  DESTINATIONS.filter(d => normalize(d.labelFull).includes(q))
    .slice(0, 8)
    .forEach(m => {
      const div = document.createElement("div");
      div.className = "suggestion-item";
      div.textContent = m.labelFull;
      div.onclick = () => {
        destinationInput.value = m.label;
        selectedSuggestion = m;
        suggestionsBox.innerHTML = "";
      };
      suggestionsBox.appendChild(div);
    });
}

// =========================
// GEOCODING
// =========================
async function geocodeGeoapify(query) {
  const url =
    `https://api.geoapify.com/v1/geocode/search?text=${encodeURIComponent(
      query + ", Zamora, Michoacán, México"
    )}&format=json&apiKey=${GEOAPIFY_KEY}`;

  const res = await fetch(url);
  const data = await res.json();
  const f = data.results[0];

  return {
    lat: f.lat,
    lng: f.lon,
    label: f.formatted || query
  };
}

// =========================
// SMART ROUTING
// =========================
function evaluateRouteForUser(route, userPos, destPos, band) {
  // 1) Parada más cercana al usuario (subida)
  const upInfo = nearestParadaToPoint(route, userPos);
  const upParada = upInfo.parada;
  const walkToBusDist = upInfo.distance;
  const walkToBusMin = Math.max(1, Math.round(walkingMinutes(walkToBusDist)));

  // 2) Parada más cercana al destino (bajada)
  const downInfo = nearestParadaToPoint(route, destPos);
  const downParada = downInfo.parada;
  const walkFromBusDist = downInfo.distance;
  const walkFromBusMin = Math.max(1, Math.round(walkingMinutes(walkFromBusDist)));

  // Si la parada de bajada está demasiado lejos del destino, ruta descartada
  if (walkFromBusDist > MAX_WALK_FROM_BUS) {
    return {
      route,
      unusable: true,
      totalMinutes: Infinity,
      walkFromBusDist
    };
  }

  // 3) Índices de la ruta para calcular tramo en camión
  const upIdx = nearestPointIndex(route.points, upParada.coords);
  const downIdx = nearestPointIndex(route.points, downParada.coords);

  const start = Math.min(upIdx, downIdx);
  const end = Math.max(upIdx, downIdx);

  let busDist = 0;
  for (let i = start; i < end; i++) {
    busDist += haversine(route.points[i], route.points[i + 1]);
  }

  // 4) Tiempo en camión
  const busSpeed = getRouteAverageBusSpeed(route, band);
  const busMinutes = Math.max(3, Math.round((busDist / busSpeed) / 60));

  const waitMinutes = BUS_WAIT_MINUTES[band];

  const totalMinutes = Math.round(
    walkToBusMin + busMinutes + walkFromBusMin + waitMinutes
  );

  const stopsBetween = countParadasBetween(route, upParada.index, downParada.index);

  return {
    route,
    upParada,
    downParada,
    walkToBusDist,
    walkFromBusDist,
    walkToBusMin,
    walkFromBusMin,
    busMinutes,
    waitMinutes,
    totalMinutes,
    stopsBetween,
    segmentStartIdx: start,
    segmentEndIdx: end,
    unusable: false
  };
}

function chooseBestRoute(userPos, destPos) {
  const band = getTimeBand();
  let best = null;

  ROUTES.forEach(r => {
    const e = evaluateRouteForUser(r, userPos, destPos, band);
    if (e.unusable) return;

    if (!best) {
      best = { ...e, band };
      return;
    }

    // 1) Prioridad: la ruta que deja más cerca del destino
    const betterDest =
      e.walkFromBusDist + DEST_PRIORITY_MARGIN < best.walkFromBusDist;

    // 2) Si dejan casi igual de cerca, priorizar menor tiempo total
    const similarDest =
      Math.abs(e.walkFromBusDist - best.walkFromBusDist) <= DEST_PRIORITY_MARGIN;
    const faster = e.totalMinutes < best.totalMinutes;

    if (betterDest || (similarDest && faster)) {
      best = { ...e, band };
    }
  });

  return best;
}

// =========================
// BÚSQUEDA PRINCIPAL
// =========================
async function buscar() {
  const q = destinationInput.value.trim();
  if (!q) return;

  instr.textContent = "Buscando destino…";
  statusBox.textContent = "Procesando…";

  clearMarkers();
  searchButton.disabled = true;

  try {
    let dest;
    if (selectedSuggestion) {
      dest = {
        lat: selectedSuggestion.coords[0],
        lng: selectedSuggestion.coords[1],
        label: selectedSuggestion.labelFull
      };
    } else {
      dest = await geocodeGeoapify(q);
    }

    // Marcador de destino con popup
    destinationMarker = L.circleMarker([dest.lat, dest.lng], {
      radius: 8,
      color: "#16a34a",
      fillColor: "#bbf7d0",
      fillOpacity: 0.9
    })
      .addTo(map)
      .bindPopup(`
        <b>Destino:</b> ${dest.label}
      `);

    if (!userLocation) {
      instr.textContent = "Destino encontrado pero no tenemos tu ubicación.";
      statusBox.textContent = "Sin ubicación del usuario";
      return;
    }

    const userPos = [userLocation.lat, userLocation.lng];
    const destPos = [dest.lat, dest.lng];

    const best = chooseBestRoute(userPos, destPos);

    // Si no hay ninguna ruta válida
    if (!best) {
      map.fitBounds([userPos, destPos], { padding: [30, 30] });

      instr.innerHTML = `
        Destino: <strong>${dest.label}</strong><br><br>
        <strong>No encontramos una ruta de camión que te deje razonablemente cerca del destino.</strong><br>
        Puedes considerar caminar, usar otro medio de transporte
        o revisar si existen más rutas por agregar al sistema.
      `;
      statusBox.textContent = "Sin ruta óptima disponible";
      return;
    }

    const {
      route,
      upParada,
      downParada,
      walkToBusDist,
      walkFromBusDist,
      walkToBusMin,
      walkFromBusMin,
      busMinutes,
      waitMinutes,
      totalMinutes,
      stopsBetween,
      segmentStartIdx,
      segmentEndIdx,
      band
    } = best;

    highlightRoute(route.id);

    // ===============================
    // TRAMO ACTIVO ANIMADO
    // ===============================
    const segmentPoints = route.points.slice(segmentStartIdx, segmentEndIdx + 1);

    suggestedSegmentPolyline = L.polyline(segmentPoints, {
      color: route.color,
      weight: 6,
      opacity: 1,
      dashArray: "14 20",
      dashOffset: "0"
    }).addTo(map);

    const lineElem = suggestedSegmentPolyline.getElement();
    if (lineElem) {
      lineElem.setAttribute("filter", "url(#glow-line)");
    }

    let offset = 0;
    dashAnimInterval = setInterval(() => {
      offset++;
      suggestedSegmentPolyline.setStyle({
        dashOffset: offset.toString()
      });
    }, 45);

    // Marcadores de subida y bajada con popups
    boardMarker = L.circleMarker(upParada.coords, {
      radius: 7,
      color: "#f97316",
      fillColor: "#fed7aa",
      fillOpacity: 0.9
    })
      .addTo(map)
      .bindPopup(`
        <b>Parada de subida:</b> ${upParada.nombre}<br>
        Ruta: <b>${route.label}</b><br>
        Caminas: <b>${Math.round(walkToBusDist)} m</b> (${walkToBusMin} min)
      `);

    alightMarker = L.circleMarker(downParada.coords, {
      radius: 7,
      color: "#dc2626",
      fillColor: "#fecaca",
      fillOpacity: 0.9
    })
      .addTo(map)
      .bindPopup(`
        <b>Parada de bajada:</b> ${downParada.nombre}<br>
        Caminas: <b>${Math.round(walkFromBusDist)} m</b> (${walkFromBusMin} min)
      `);

    map.fitBounds([userPos, destPos], { padding: [30, 30] });

    setTimeout(() => {
      if (boardMarker) {
        boardMarker.openPopup();
      }
    }, 300);

    const label = getDayPeriodLabel(band);

    instr.innerHTML = `
      Destino: <strong>${dest.label}</strong><br><br>
      Ruta sugerida: <strong>${route.label}</strong><br><br>

      1. Camina <strong>${Math.round(walkToBusDist)} m</strong> (${walkToBusMin} min) hasta la parada <strong>${upParada.nombre}</strong>.<br>
      2. Toma la ruta <strong>${route.label}</strong>${
        stopsBetween > 0 ? ` (${stopsBetween} paradas aproximadas)` : ""
      }, tiempo aproximado en camión: <strong>${busMinutes} min</strong>.<br>
      3. Baja en <strong>${downParada.nombre}</strong> y camina <strong>${Math.round(
        walkFromBusDist
      )} m</strong> (${walkFromBusMin} min).<br><br>

      Tiempo estimado en camión (${label}): <strong>${busMinutes} min</strong>.<br>
      Tiempo estimado de espera: <strong>${waitMinutes} min</strong>.<br>
      <strong>Tiempo total puerta a puerta: ${totalMinutes} min</strong>.
    `;

    statusBox.textContent = "Ruta calculada";

  } catch (err) {
    instr.textContent = "No se pudo calcular la ruta.";
    statusBox.textContent = "Error en el cálculo";
    console.error(err);
  } finally {
    searchButton.disabled = false;
  }
}

// =========================
// GEOLOCALIZACIÓN
// =========================
function initGeolocation() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(pos => {
    userLocation = {
      lat: pos.coords.latitude,
      lng: pos.coords.longitude
    };

    userMarker = L.circleMarker([userLocation.lat, userLocation.lng], {
      radius: 7,
      color: "#2563eb",
      fillColor: "#bfdbfe",
      fillOpacity: 0.9
    })
      .addTo(map)
      .bindPopup(`
        <b>Tu ubicación actual.</b><br>
        Cuando calcules una ruta, aquí se mostrará la parada recomendada de subida.
      `);

    setTimeout(() => {
      if (userMarker) {
        userMarker.openPopup();
      }
    }, 300);
  });
}

// =========================
// EVENTOS Y ARRANQUE
// =========================
destinationInput.addEventListener("input", e => renderSuggestions(e.target.value));
destinationInput.addEventListener("keydown", e => {
  if (e.key === "Enter") buscar();
});
searchButton.addEventListener("click", buscar);

(async function init() {
  await loadRoutes();
  initGeolocation();
})();
