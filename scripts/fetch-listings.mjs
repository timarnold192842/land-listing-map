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

async function loadSourceRows(source) {
  const type = String(source.type || "").toLowerCase();
  if (type === "json") return loadJsonSource(source);
  if (type === "csv") return loadCsvSource(source);
  if (type === "rss") return loadRssSource(source);
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
      const rows = await loadSourceRows(source);
      rows.forEach((row, index) => {
        rawListings.push(mapRecord(row, source, index));
      });
      stats.push({ source: source.name, status: "ok", loaded: rows.length });
    } catch (error) {
      stats.push({ source: source.name, status: "error", message: error.message });
    }
  }

  const normalized = rawListings
    .filter((listing) => isValidListing(listing))
    .map((listing) => ({
      ...listing,
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
