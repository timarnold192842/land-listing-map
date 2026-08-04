import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Parser from "rss-parser";
import { parse } from "csv-parse/sync";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const sourcesPath = path.join(dataDir, "sources.json");
const outputPath = path.join(dataDir, "listings.json");
const REQUEST_HEADERS = {
  "user-agent": "Mozilla/5.0 (compatible; land-listing-map/1.0)"
};

const US_STATE_SLUG_TO_ABBR = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new-hampshire": "NH",
  "new-jersey": "NJ",
  "new-mexico": "NM",
  "new-york": "NY",
  "north-carolina": "NC",
  "north-dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode-island": "RI",
  "south-carolina": "SC",
  "south-dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west-virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
  "district-of-columbia": "DC"
};

const US_STATE_NAME_TO_ABBR = Object.fromEntries(
  Object.entries(US_STATE_SLUG_TO_ABBR).map(([slug, abbr]) => [slug.replace(/-/g, " ").toUpperCase(), abbr])
);

const rssParser = new Parser();

function toNumber(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const cleaned = String(value).replace(/[^0-9.-]/g, "");
  if (!cleaned) return null;
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePrice(value) {
  if (value == null || value === "") return null;
  const number = toNumber(value);
  if (number == null) return null;
  return Math.round(number);
}

function parseAcreage(value) {
  if (value == null || value === "") return null;
  const parsed = toNumber(value);
  if (parsed == null || parsed <= 0) return null;
  return parsed;
}

function stripHtml(html) {
  if (!html) return "";
  const text = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#8211;/g, "-")
    .replace(/&#8212;/g, "-")
    .replace(/&#8217;/g, "'")
    .replace(/&#8230;/g, "...")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

function extractCoordinatePair(text) {
  if (!text) return { lat: null, lon: null };
  const matches = text.match(/(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/g);
  if (!matches || !matches.length) return { lat: null, lon: null };

  for (const pair of matches) {
    const [latRaw, lonRaw] = pair.split(",").map((part) => part.trim());
    const lat = toNumber(latRaw);
    const lon = toNumber(lonRaw);
    if (lat == null || lon == null) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    return { lat, lon };
  }

  return { lat: null, lon: null };
}

function extractAcreageFromText(title, text) {
  const joined = `${title || ""} ${text || ""}`;
  const match = joined.match(/(\d+(?:\.\d+)?)\s*(?:acre|acres|ac)\b/i);
  if (!match) return null;
  return parseAcreage(match[1]);
}

function extractPriceFromText(title, text) {
  const joined = `${title || ""} ${text || ""}`;
  if (!joined.trim()) return null;

  const patterns = [
    /(?:cash purchase price|sale\s*-\s*cash purchase price|sale price|list price|asking price|purchase price)\s*[:\-]?\s*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
    /for\s+just\s*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
    /\$\s*([\d,]+(?:\.\d{1,2})?)\s*(?:cash|usd)?\s*(?:price|asking)/i
  ];

  for (const pattern of patterns) {
    const match = joined.match(pattern);
    if (!match) continue;
    const price = parsePrice(match[1]);
    if (price != null) return price;
  }

  return null;
}

function extractCityState(title, text) {
  const joined = `${title || ""} ${text || ""}`;
  const inCityPattern = /\bin\s+([A-Z][a-zA-Z.'\-\s]{1,40}),\s*([A-Z]{2})\b/;
  const fallbackPattern = /\b([A-Z][a-zA-Z.'\-\s]{1,40}),\s*([A-Z]{2})\b/;
  const match = joined.match(inCityPattern) || joined.match(fallbackPattern);

  if (!match) {
    return { city: "", state: "" };
  }

  const cityCandidate = String(match[1]).trim();
  const state = String(match[2]).trim();

  if (/\bcounty\b/i.test(cityCandidate)) {
    return { city: "", state };
  }

  const city = cityCandidate
    .replace(/\b(acre|acres|lot|lots|land|property|in)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    city,
    state
  };
}

function parseCoordString(value) {
  const match = String(value || "").match(/(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/);
  if (!match) return { lat: null, lon: null };
  const lat = toNumber(match[1]);
  const lon = toNumber(match[2]);
  if (lat == null || lon == null) return { lat: null, lon: null };
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return { lat: null, lon: null };
  return { lat, lon };
}

function shouldSkipTitle(title) {
  const value = String(title || "").toLowerCase();
  if (!value) return true;
  return /(please ignore|demo|test|placeholder|sample|sold!|\bsold\b|pending|under contract)/i.test(value);
}

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&ndash;/g, "-")
    .replace(/&mdash;/g, "-")
    .replace(/&nbsp;/g, " ");
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractStateFromSlug(pathSlug) {
  const lower = String(pathSlug || "").toLowerCase();
  for (const [nameSlug, abbr] of Object.entries(US_STATE_SLUG_TO_ABBR)) {
    if (lower.includes(`-${nameSlug}-`) || lower.endsWith(`-${nameSlug}`)) {
      return abbr;
    }
  }
  const abbrMatch = lower.match(/-([a-z]{2})-\d{5}\b/);
  if (abbrMatch) {
    return String(abbrMatch[1]).toUpperCase();
  }
  return "";
}

function normalizeState(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const upper = raw.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper)) return upper;

  const compact = upper.replace(/[.]/g, "").replace(/\s+/g, " ").trim();
  if (US_STATE_NAME_TO_ABBR[compact]) {
    return US_STATE_NAME_TO_ABBR[compact];
  }

  return raw;
}

function statusLooksAvailable(status) {
  const value = String(status || "").toLowerCase();
  if (!value) return true;
  if (/(sold|pending|under contract|inactive|off market)/i.test(value)) return false;
  return /(active|available|for sale)/i.test(value) || value.length > 0;
}

function getByPath(obj, dotPath) {
  if (!dotPath) return undefined;
  if (!dotPath.includes(".")) return obj[dotPath];
  return dotPath.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function mapRecord(record, source, index) {
  const mappings = source.mappings || {};
  const defaults = source.defaults || {};

  const rawId = getByPath(record, mappings.id) ?? `${source.name}-${index}`;
  const rawTitle = getByPath(record, mappings.title) ?? "Untitled listing";
  const rawPrice = getByPath(record, mappings.price);
  const rawAcreage = getByPath(record, mappings.acreage);
  const rawLat = getByPath(record, mappings.lat);
  const rawLon = getByPath(record, mappings.lon);

  const listing = {
    id: String(rawId),
    source: source.name,
    title: String(rawTitle),
    url: String(getByPath(record, mappings.url) ?? defaults.url ?? ""),
    description: String(getByPath(record, mappings.description) ?? defaults.description ?? "").trim(),
    city: String(getByPath(record, mappings.city) ?? defaults.city ?? "").trim(),
    state: String(getByPath(record, mappings.state) ?? defaults.state ?? "").trim(),
    county: String(getByPath(record, mappings.county) ?? defaults.county ?? "").trim(),
    listedAt: String(getByPath(record, mappings.listedAt) ?? defaults.listedAt ?? "").trim(),
    price: parsePrice(rawPrice),
    acreage: parseAcreage(rawAcreage),
    lat: toNumber(rawLat),
    lon: toNumber(rawLon)
  };

  return listing;
}

function isValidListing(listing) {
  if (listing.lat == null || listing.lon == null) return false;
  if (listing.lat < -90 || listing.lat > 90) return false;
  if (listing.lon < -180 || listing.lon > 180) return false;
  return true;
}

function dedupe(listings) {
  const seen = new Set();
  const out = [];
  for (const listing of listings) {
    const dedupeKey = listing.url || `${listing.source}:${listing.id}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(listing);
  }
  return out;
}

async function loadJsonSource(source) {
  const sourcePath = path.isAbsolute(source.path) ? source.path : path.join(rootDir, source.path);
  const text = await fs.readFile(sourcePath, "utf8");
  const data = JSON.parse(text);
  if (!Array.isArray(data)) {
    throw new Error(`JSON source ${source.name} did not contain an array.`);
  }
  return data;
}

async function loadCsvSource(source) {
  const sourcePath = path.isAbsolute(source.path) ? source.path : path.join(rootDir, source.path);
  const text = await fs.readFile(sourcePath, "utf8");
  return parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  });
}

async function loadRssSource(source) {
  if (!source.url) {
    throw new Error(`RSS source ${source.name} is missing a url.`);
  }
  const feed = await rssParser.parseURL(source.url);
  return feed.items || [];
}

async function loadWpReiLandSource(source) {
  if (!source.url) {
    throw new Error(`wp_rei_land source ${source.name} is missing a url.`);
  }

  const perPage = Number.parseInt(String(source.perPage ?? 50), 10);
  const maxPages = Number.parseInt(String(source.maxPages ?? 5), 10);
  const rows = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const url = `${source.url}${source.url.includes("?") ? "&" : "?"}per_page=${perPage}&page=${page}`;
    const response = await fetch(url, { headers: REQUEST_HEADERS });
    if (!response.ok) {
      throw new Error(`wp_rei_land request failed: ${response.status} ${response.statusText}`);
    }

    const pageRows = await response.json();
    if (!Array.isArray(pageRows) || !pageRows.length) {
      break;
    }

    rows.push(...pageRows);
    const totalPages = Number.parseInt(response.headers.get("x-wp-totalpages") || "1", 10);
    if (page >= totalPages) break;
  }

  return rows.map((row) => {
    const title = stripHtml(row?.title?.rendered || "Untitled land listing");
    const description = stripHtml(row?.excerpt?.rendered || row?.content?.rendered || "");
    const bodyText = stripHtml(row?.content?.rendered || "");
    const mergedText = `${description} ${bodyText}`;
    const coords = extractCoordinatePair(mergedText);
    const cityState = extractCityState(title, mergedText);
    const acreage = extractAcreageFromText(title, mergedText);
    const price = extractPriceFromText(title, mergedText);

    return {
      id: String(row?.id ?? row?.slug ?? "unknown"),
      source: source.name,
      title,
      url: String(row?.link || ""),
      description,
      city: cityState.city,
      state: cityState.state,
      county: "",
      listedAt: String(row?.date || ""),
      price,
      acreage,
      lat: coords.lat,
      lon: coords.lon
    };
  });
}

function coerceLandElevatedRow(raw) {
  if (!raw || typeof raw !== "object") return null;

  const title = stripHtml(raw["Property Name"] || raw.property_name || raw.Title || "").trim();
  if (shouldSkipTitle(title)) return null;

  const status = String(raw.Status || raw.status || "").trim();
  if (!statusLooksAvailable(status)) return null;

  const coordString = raw["GPS Coordinates"] || raw.gps_coordinates || "";
  const coords = parseCoordString(coordString);
  if (coords.lat == null || coords.lon == null) return null;

  const city = String(raw.City || raw.city || "").trim();
  const state = String(raw["State Abbreviation"] || raw.State || raw.state || "").trim();
  const county = String(raw.County || raw.county || "").trim();
  const acreage = parseAcreage(raw.Acreage || raw.acreage || "");
  const price = parsePrice(raw["Cash Purchase Price"] || raw.Price || raw.price || "");
  const listedAt = String(raw["Created Date"] || raw["Date"] || "").trim();

  const urlCandidate = [
    raw.URL,
    raw.url,
    raw["Property URL"],
    raw["Listing URL"],
    raw.Permalink,
    raw.Link,
    raw.link
  ].find((value) => typeof value === "string" && /^https?:\/\//i.test(value.trim()));

  return {
    id: String(raw.ID || raw.id || `${title}:${coords.lat},${coords.lon}`),
    source: "LandElevated (Live Land Listings)",
    title,
    url: urlCandidate ? String(urlCandidate).trim() : "",
    description: stripHtml(raw.Description || raw["Property Details"] || "").trim(),
    city,
    state,
    county,
    listedAt,
    price,
    acreage,
    lat: coords.lat,
    lon: coords.lon
  };
}

async function loadLandElevatedHomeSource(source) {
  if (!source.url) {
    throw new Error(`landelevated_home source ${source.name} is missing a url.`);
  }

  const response = await fetch(source.url, { headers: REQUEST_HEADERS });
  if (!response.ok) {
    throw new Error(`landelevated_home request failed: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  const maxMentions = Number.parseInt(String(source.maxMentions ?? 300), 10);
  const parsedRows = [];

  let cursor = 0;
  let mentionCount = 0;
  while (mentionCount < maxMentions) {
    const needle = html.indexOf("GPS Coordinates", cursor);
    if (needle === -1) break;
    mentionCount += 1;

    const candidateRaw = html.slice(Math.max(0, needle - 2800), Math.min(html.length, needle + 5200));
    const candidate = candidateRaw
      .replace(/\\/g, "")
      .replace(/\s+/g, " ")
      .trim();

    const raw = {
      "Property Name": (candidate.match(/"Property Name":"([^"]+)"/) || [])[1] || "",
      Status: (candidate.match(/"Status":"([^"]+)"/) || [])[1] || "",
      County: (candidate.match(/"County":"([^"]+)"/) || [])[1] || "",
      State: (candidate.match(/"State":"([^"]+)"/) || [])[1] || "",
      "State Abbreviation": (candidate.match(/"State Abbreviation":"([^"]+)"/) || [])[1] || "",
      Acreage: (candidate.match(/"Acreage":"([^"]+)"/) || [])[1] || "",
      "Cash Purchase Price": (candidate.match(/"Cash Purchase Price":"([^"]+)"/) || [])[1] || "",
      "GPS Coordinates": (candidate.match(/"GPS Coordinates":"([^"]+)"/) || [])[1] || "",
      Description: (candidate.match(/"Description":"([^"]*)"/) || [])[1] || ""
    };

    const listing = coerceLandElevatedRow(raw);
    if (listing) parsedRows.push(listing);

    cursor = needle + 1;
  }

  const uniqueByGeoAndTitle = new Map();
  for (const row of parsedRows) {
    const key = `${row.title.toLowerCase()}|${row.lat.toFixed(6)}|${row.lon.toFixed(6)}`;
    if (!uniqueByGeoAndTitle.has(key)) {
      uniqueByGeoAndTitle.set(key, row);
    }
  }

  return [...uniqueByGeoAndTitle.values()].map((row, index) => ({
    ...row,
    id: String(row.id || `${source.name}-${index}`),
    source: source.name
  }));
}

function parseLandmodoPage(html, sourceName) {
  const rows = [];
  const tagMatches = html.match(/<span class="google-pin-location"[^>]*>/g) || [];

  for (const tag of tagMatches) {
    const lat = toNumber((tag.match(/data-lat="([^"]+)"/) || [])[1]);
    const lon = toNumber((tag.match(/data-lng="([^"]+)"/) || [])[1]);
    const titleRaw = (tag.match(/data-name="([^"]+)"/) || [])[1] || "Untitled land listing";
    const filenameRaw = (tag.match(/data-filename="([^"]+)"/) || [])[1] || "";

    const title = decodeHtmlEntities(titleRaw).trim();
    const filename = filenameRaw.replace(/^\/+/, "").trim();
    if (!filename) continue;
    if (lat == null || lon == null) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    if (shouldSkipTitle(title)) continue;

    const state = extractStateFromSlug(filename);
    const detailsAnchorRe = new RegExp(`href=\"/${escapeRegExp(filename)}\"`, "i");
    const detailsAnchor = html.search(detailsAnchorRe);
    const detailsChunk = detailsAnchor >= 0 ? html.slice(detailsAnchor, detailsAnchor + 1400) : "";
    const detailsText = stripHtml(decodeHtmlEntities(detailsChunk));

    const acreage = extractAcreageFromText(title, detailsText);
    const price = extractPriceFromText(title, detailsText);

    rows.push({
      id: `${sourceName}:${filename}`,
      source: sourceName,
      title,
      url: `https://www.landmodo.com/${filename}`,
      description: detailsText,
      city: "",
      state,
      county: "",
      listedAt: "",
      price,
      acreage,
      lat,
      lon
    });
  }

  return rows;
}

async function loadLandmodoSource(source) {
  if (!source.url) {
    throw new Error(`landmodo source ${source.name} is missing a url.`);
  }

  const maxPages = Number.parseInt(String(source.maxPages ?? 50), 10);
  const rows = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const pageUrl = `${source.url}${source.url.includes("?") ? "&" : "?"}page=${page}`;
    let response = await fetch(pageUrl, { headers: REQUEST_HEADERS });
    if (!response.ok) {
      response = await fetch(pageUrl, { headers: REQUEST_HEADERS });
    }
    if (!response.ok) {
      if (rows.length) {
        break;
      }
      throw new Error(`landmodo request failed on page ${page}: ${response.status} ${response.statusText}`);
    }
    const html = await response.text();
    const pageRows = parseLandmodoPage(html, source.name);
    if (!pageRows.length) {
      break;
    }
    rows.push(...pageRows);
  }

  return rows;
}

function toUsdFromCents(value) {
  const amount = toNumber(value);
  if (amount == null) return null;
  return parsePrice(amount / 100);
}

function parseLandCenturyPayload(html) {
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return { rows: [], total: 0, page: 1 };

  let payload;
  try {
    payload = JSON.parse(match[1]);
  } catch {
    return { rows: [], total: 0, page: 1 };
  }

  const data = payload?.props?.pageProps?.data;
  const rows = Array.isArray(data?.properties) ? data.properties : [];
  const total = Number.parseInt(String(data?.total ?? rows.length), 10) || rows.length;
  const page = Number.parseInt(String(data?.page ?? 1), 10) || 1;
  return { rows, total, page };
}

function normalizeLandCenturyRow(row, sourceName) {
  if (!row || typeof row !== "object") return null;
  if (row.isSold) return null;
  if (row.isPublished === false) return null;

  const lat = toNumber(row.lat);
  const lon = toNumber(row.lng);
  if (lat == null || lon == null) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  const title = String(row.name || "Untitled land listing").trim();
  if (shouldSkipTitle(title)) return null;

  const acreage = parseAcreage(row?.info?.sizeAcres ?? row?.sizeAcres ?? "") || extractAcreageFromText(title, "");
  const price = toUsdFromCents(row.cashPrice) ?? toUsdFromCents(row.ownerFinancePrice);
  const slug = String(row.slug || "").trim();

  const descriptionParts = [
    row?.info?.zoning,
    row?.info?.roadAccess,
    row?.info?.utilities,
    row?.info?.legalDescription
  ]
    .filter(Boolean)
    .map((part) => stripHtml(part));

  return {
    id: `${sourceName}:${row.id ?? slug}`,
    source: sourceName,
    title,
    url: slug ? `https://www.landcentury.com/land-for-sale/${slug}` : "https://www.landcentury.com/land-for-sale",
    description: descriptionParts.join(" | "),
    city: String(row.city || "").trim(),
    state: String(row.stateRegion || "").trim(),
    county: String(row.county || "").trim(),
    listedAt: String(row.updated_at || row.created_at || "").trim(),
    price,
    acreage,
    lat,
    lon
  };
}

async function loadLandCenturySource(source) {
  if (!source.url) {
    throw new Error(`landcentury source ${source.name} is missing a url.`);
  }

  const maxPages = Number.parseInt(String(source.maxPages ?? 170), 10);
  const rows = [];
  let totalHint = null;

  for (let page = 1; page <= maxPages; page += 1) {
    const pageUrl = `${source.url}${source.url.includes("?") ? "&" : "?"}page=${page}`;
    const response = await fetch(pageUrl, { headers: REQUEST_HEADERS });
    if (!response.ok) {
      if (rows.length) break;
      throw new Error(`landcentury request failed on page ${page}: ${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    const parsed = parseLandCenturyPayload(html);
    if (totalHint == null) totalHint = parsed.total;

    const pageRows = parsed.rows
      .map((row) => normalizeLandCenturyRow(row, source.name))
      .filter(Boolean);

    if (!pageRows.length) break;
    rows.push(...pageRows);

    if (totalHint != null && rows.length >= totalHint) {
      break;
    }
  }

  return rows;
}

function extractRuralVacantLandIndexLinks(html) {
  const urls = (html.match(/https:\/\/ruralvacantland\.com\/properties\/[^"\s#?]+\/?/g) || [])
    .map((value) => value.trim())
    .filter((value) => value && !/\/properties\/?$/.test(value) && !/\/feed\/?$/.test(value) && !/\/page\//.test(value));
  return [...new Set(urls)];
}

function parseRuralVacantLandDetails(html, url, sourceName) {
  const title = stripHtml((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || "Untitled land listing");
  if (shouldSkipTitle(title)) return null;

  const detailBlock = (label) => {
    const re = new RegExp(`<dt>\\s*${label}\\s*<\\/dt>\\s*<dd>([\\s\\S]*?)<\\/dd>`, "i");
    return stripHtml((html.match(re) || [])[1] || "");
  };

  const contract = detailBlock("Contract");
  if (/sold|pending|under contract/i.test(contract)) return null;

  const location = detailBlock("Location");
  const locationParts = location
    .split("/")
    .map((value) => value.trim())
    .filter(Boolean);
  const state = normalizeState(locationParts[0] || "");
  const county = locationParts.length > 1 ? locationParts[1] : "";

  const price = parsePrice(detailBlock("Price"));
  const acreage = parseAcreage(detailBlock("Area")) || extractAcreageFromText(title, html);

  const lat = toNumber((html.match(/data-latitude="([^"]+)"/i) || [])[1]);
  const lon = toNumber((html.match(/data-longitude="([^"]+)"/i) || [])[1]);
  let coords = { lat, lon };
  if (coords.lat == null || coords.lon == null) {
    coords = extractCoordinatePair(stripHtml(html));
  }
  if (coords.lat == null || coords.lon == null) return null;

  const address = stripHtml((html.match(/<th[^>]*>\s*Address:\s*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/i) || [])[1] || "");
  const city = address.split(",")[0]?.trim() || "";

  const body = stripHtml((html.match(/<div class="post-content"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || "");
  const listedAt = String((html.match(/property-detail-created"[^>]*>([^<]+)/i) || [])[1] || "").trim();

  return {
    id: `${sourceName}:${url}`,
    source: sourceName,
    title,
    url,
    description: body,
    city,
    state,
    county,
    listedAt,
    price,
    acreage,
    lat: coords.lat,
    lon: coords.lon
  };
}

async function loadRuralVacantLandSource(source) {
  const indexUrl = source.url || "https://ruralvacantland.com/properties/?filter-id=&filter-location=&filter-property-type=&filter-contract-type=46&filter-price-from=&filter-price-to=&filter-area=";
  const maxPages = Number.parseInt(String(source.maxPages ?? 25), 10);
  const concurrency = Number.parseInt(String(source.detailConcurrency ?? 6), 10);

  const listingUrls = new Set();
  for (let page = 1; page <= maxPages; page += 1) {
    const pageUrl = page === 1
      ? indexUrl
      : `${indexUrl}${indexUrl.includes("?") ? "&" : "?"}paged=${page}`;
    const response = await fetch(pageUrl, { headers: REQUEST_HEADERS });
    if (!response.ok) {
      if (page > 1) break;
      throw new Error(`ruralvacantland index request failed: ${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    const urls = extractRuralVacantLandIndexLinks(html);
    if (!urls.length) break;
    urls.forEach((value) => listingUrls.add(value));

    const hasNext = /next page-numbers/i.test(html) || /class="next/i.test(html);
    if (!hasNext) break;
  }

  const allUrls = [...listingUrls];
  const rows = [];
  for (let i = 0; i < allUrls.length; i += Math.max(1, concurrency)) {
    const batch = allUrls.slice(i, i + Math.max(1, concurrency));
    const parsed = await Promise.all(batch.map(async (url) => {
      try {
        const response = await fetch(url, { headers: REQUEST_HEADERS });
        if (!response.ok) return null;
        const html = await response.text();
        return parseRuralVacantLandDetails(html, url, source.name);
      } catch {
        return null;
      }
    }));
    parsed.filter(Boolean).forEach((item) => rows.push(item));
  }

  return rows;
}

async function loadSourceRows(source) {
  const type = String(source.type || "").toLowerCase();
  if (type === "json") return loadJsonSource(source);
  if (type === "csv") return loadCsvSource(source);
  if (type === "rss") return loadRssSource(source);
  if (type === "wp_rei_land") return loadWpReiLandSource(source);
  if (type === "landelevated_home") return loadLandElevatedHomeSource(source);
  if (type === "landmodo") return loadLandmodoSource(source);
  if (type === "landcentury") return loadLandCenturySource(source);
  if (type === "ruralvacantland") return loadRuralVacantLandSource(source);
  throw new Error(`Unsupported source type: ${source.type}`);
}

async function main() {
  const startedAt = new Date();
  const sourceConfigText = await fs.readFile(sourcesPath, "utf8");
  const sources = JSON.parse(sourceConfigText);

  if (!Array.isArray(sources)) {
    throw new Error("data/sources.json must contain an array");
  }

  const rawListings = [];
  const stats = [];

  for (const source of sources) {
    const enabled = source.enabled !== false;
    if (!enabled) {
      stats.push({ source: source.name, status: "skipped", reason: "disabled" });
      continue;
    }

    try {
      const type = String(source.type || "").toLowerCase();
      const rows = await loadSourceRows(source);
      if (type === "wp_rei_land" || type === "landelevated_home" || type === "landmodo" || type === "landcentury" || type === "ruralvacantland") {
        rawListings.push(...rows);
      } else {
        rows.forEach((row, index) => {
          rawListings.push(mapRecord(row, source, index));
        });
      }
      stats.push({ source: source.name, status: "ok", loaded: rows.length });
    } catch (error) {
      stats.push({ source: source.name, status: "error", message: error.message });
    }
  }

  const normalized = rawListings
    .filter((listing) => isValidListing(listing))
    .map((listing) => ({
      ...listing,
      state: normalizeState(listing.state),
      acreage: listing.acreage ?? 1
    }));

  const deduped = dedupe(normalized);
  const output = {
    generatedAt: startedAt.toISOString(),
    count: deduped.length,
    listings: deduped,
    sourceStats: stats
  };

  await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");

  const summary = {
    output: path.relative(rootDir, outputPath),
    totalRows: rawListings.length,
    mappedListings: deduped.length,
    droppedForMissingCoords: rawListings.length - normalized.length,
    sourceStats: stats
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
