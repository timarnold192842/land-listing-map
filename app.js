const ACRE_TO_M2 = 4046.8564224;

const state = {
  listings: [],
  filtered: [],
  shapes: [],
  markers: [],
  shapeMode: "circle"
};

const map = L.map("map", {
  zoomControl: true,
  zoomSnap: 0.25,
  zoomDelta: 0.5
}).setView([39.8283, -98.5795], 4);

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 20,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);

const layerGroup = L.layerGroup().addTo(map);
const markerLayer = L.layerGroup().addTo(map);

const el = {
  sourceFilter: document.getElementById("sourceFilter"),
  searchInput: document.getElementById("searchInput"),
  minAcres: document.getElementById("minAcres"),
  maxAcres: document.getElementById("maxAcres"),
  shapeMode: document.getElementById("shapeMode"),
  fitBtn: document.getElementById("fitBtn"),
  listingList: document.getElementById("listingList"),
  resultCount: document.getElementById("resultCount"),
  metaLine: document.getElementById("metaLine")
};

function fmtPrice(value) {
  if (value == null) return "Price unavailable";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

function fmtAcres(value) {
  if (!Number.isFinite(value)) return "n/a";
  return `${value.toFixed(2)} ac`;
}

function metersToDegreeDelta(lat, meters) {
  const latDelta = meters / 111320;
  const lonDelta = meters / (111320 * Math.cos((lat * Math.PI) / 180));
  return { latDelta, lonDelta };
}

function shapeForListing(listing, mode) {
  const areaM2 = Math.max(0.2, listing.acreage || 1) * ACRE_TO_M2;
  const center = [listing.lat, listing.lon];

  if (mode === "square") {
    const side = Math.sqrt(areaM2);
    const half = side / 2;
    const delta = metersToDegreeDelta(listing.lat, half);
    const bounds = [
      [listing.lat - delta.latDelta, listing.lon - delta.lonDelta],
      [listing.lat + delta.latDelta, listing.lon + delta.lonDelta]
    ];
    return L.rectangle(bounds, {
      color: "#14532d",
      weight: 1,
      fillColor: "#22c55e",
      fillOpacity: 0.22
    });
  }

  const radius = Math.sqrt(areaM2 / Math.PI);
  return L.circle(center, {
    radius,
    color: "#0f766e",
    weight: 1,
    fillColor: "#14b8a6",
    fillOpacity: 0.2
  });
}

function listingPopupHtml(listing) {
  const location = [listing.city, listing.state].filter(Boolean).join(", ");
  return `
    <div class="popupTitle">${listing.title}</div>
    <div class="popupMeta">${fmtAcres(listing.acreage)} • ${fmtPrice(listing.price)}</div>
    <div class="popupMeta">${location || "Location unavailable"}</div>
    <div class="popupMeta">Source: ${listing.source}</div>
    ${listing.url ? `<a class="popupLink" href="${listing.url}" target="_blank" rel="noopener">Open listing</a>` : ""}
  `;
}

function markerRadiusForZoom(zoom) {
  const scaled = 4 + (zoom - 4) * 0.8;
  return Math.max(4, Math.min(14, scaled));
}

function markerForListing(listing) {
  return L.circleMarker([listing.lat, listing.lon], {
    radius: markerRadiusForZoom(map.getZoom()),
    color: "#083344",
    weight: 2,
    fillColor: "#f59e0b",
    fillOpacity: 0.95,
    opacity: 1
  });
}

function updateMarkerSizes() {
  const radius = markerRadiusForZoom(map.getZoom());
  state.markers.forEach((entry) => {
    entry.marker.setRadius(radius);
  });
}

function drawListings() {
  layerGroup.clearLayers();
  markerLayer.clearLayers();
  state.shapes = [];
  state.markers = [];

  state.filtered.forEach((listing) => {
    const shape = shapeForListing(listing, state.shapeMode);
    const marker = markerForListing(listing);
    shape.bindPopup(listingPopupHtml(listing));
    marker.bindPopup(listingPopupHtml(listing));
    shape.addTo(layerGroup);
    marker.addTo(markerLayer);
    state.shapes.push({ listing, shape, marker });
    state.markers.push({ listing, marker });
  });

  updateMarkerSizes();
}

function listingMatchesFilters(listing) {
  const source = el.sourceFilter.value;
  if (source !== "all" && listing.source !== source) return false;

  const minAcres = Number.parseFloat(el.minAcres.value || "0");
  const maxAcres = Number.parseFloat(el.maxAcres.value || "999999");
  if (listing.acreage < minAcres || listing.acreage > maxAcres) return false;

  const query = el.searchInput.value.trim().toLowerCase();
  if (!query) return true;

  const haystack = [
    listing.title,
    listing.source,
    listing.city,
    listing.state,
    listing.description
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return haystack.includes(query);
}

function ruralScore(listing) {
  const acreage = Number.isFinite(listing.acreage) ? listing.acreage : 0;
  const text = [listing.title, listing.description, listing.county, listing.city]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  let score = 0;
  score += Math.min(60, acreage * 2.5);
  if (acreage >= 1) score += 8;
  if (acreage >= 5) score += 8;
  if (/(rural|unrestricted|off-grid|hunting|recreational|vacant|county)/i.test(text)) score += 10;
  if (/\b(city|downtown|subdivision|commercial lot)\b/i.test(text)) score -= 8;
  if (listing.city && acreage < 0.5) score -= 6;
  return score;
}

function renderList() {
  el.listingList.innerHTML = "";
  state.filtered.forEach((listing) => {
    const item = document.createElement("li");
    item.className = "listing";
    item.innerHTML = `
      <strong>${listing.title}</strong>
      <div class="sub">${fmtAcres(listing.acreage)} • ${fmtPrice(listing.price)}</div>
      <div class="sub">${[listing.city, listing.state].filter(Boolean).join(", ") || "Unknown location"}</div>
      <div class="sub">${listing.source}</div>
    `;
    item.addEventListener("click", () => {
      map.setView([listing.lat, listing.lon], 13);
      const found = state.shapes.find((entry) => entry.listing.id === listing.id && entry.listing.source === listing.source);
      if (found) {
        if (found.marker) {
          found.marker.openPopup();
        } else {
          found.shape.openPopup();
        }
      }
    });
    el.listingList.appendChild(item);
  });
  el.resultCount.textContent = `${state.filtered.length} listing${state.filtered.length === 1 ? "" : "s"}`;
}

function fitMapToResults() {
  if (!state.filtered.length) return;
  const bounds = L.latLngBounds(state.filtered.map((item) => [item.lat, item.lon]));
  map.fitBounds(bounds, { padding: [30, 30] });
}

function applyFilters() {
  state.filtered = state.listings
    .filter(listingMatchesFilters)
    .sort((a, b) => {
      const scoreDelta = ruralScore(b) - ruralScore(a);
      if (scoreDelta !== 0) return scoreDelta;
      return (b.acreage || 0) - (a.acreage || 0);
    });
  drawListings();
  renderList();
}

function uniqueSources(listings) {
  return [...new Set(listings.map((item) => item.source))].sort();
}

async function loadListings() {
  const res = await fetch("data/listings.json", { cache: "no-store" });
  if (!res.ok) throw new Error("Could not load data/listings.json");
  const payload = await res.json();
  state.listings = payload.listings || [];

  const sources = uniqueSources(state.listings);
  sources.forEach((source) => {
    const opt = document.createElement("option");
    opt.value = source;
    opt.textContent = source;
    el.sourceFilter.appendChild(opt);
  });

  el.metaLine.textContent = `Generated ${new Date(payload.generatedAt).toLocaleString()} • ${payload.count} listings`;
  applyFilters();
  fitMapToResults();
}

function wireEvents() {
  [el.sourceFilter, el.searchInput, el.minAcres, el.maxAcres].forEach((node) => {
    node.addEventListener("input", applyFilters);
    node.addEventListener("change", applyFilters);
  });

  el.shapeMode.addEventListener("change", () => {
    state.shapeMode = el.shapeMode.value;
    drawListings();
  });

  el.fitBtn.addEventListener("click", fitMapToResults);
  map.on("zoomend", updateMarkerSizes);
}

wireEvents();
loadListings().catch((error) => {
  el.metaLine.textContent = `Failed to load listings: ${error.message}`;
});
