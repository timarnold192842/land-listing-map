# Land Listing Map

A lightweight land real estate listing map tool that:

- culls listings from multiple source types (JSON, CSV, RSS),
- normalizes them into one file,
- renders acreage-scaled circles or squares for each listing on an interactive map.

Current default live source:

- LandSale4U WordPress land listing endpoint (`wp/v2/rei_land`)

## Quick start

```bash
npm install
npm run fetch
npm run serve
```

Then open `http://localhost:5173`.

## Data flow

1. Configure source adapters in `data/sources.json`.
2. Run `npm run fetch`.
3. The script writes `data/listings.json`.
4. `index.html` + `app.js` load `data/listings.json` and render map overlays.

## Source catalog

The initial source catalog from your shared LandSalesList post is stored in:

- `data/source-catalog.json`

That catalog is a discovery list, while `data/sources.json` is the active ingestion config.

## Source config format (`data/sources.json`)

```json
{
  "name": "Sample JSON Listings",
  "type": "json",
  "path": "data/sample-listings.json",
  "enabled": true,
  "mappings": {
    "id": "id",
    "title": "title",
    "price": "price",
    "acreage": "acreage",
    "lat": "lat",
    "lon": "lon",
    "url": "url",
    "description": "description",
    "city": "city",
    "state": "state"
  }
}
```

Supported source `type` values:

- `json`: Reads from a local JSON array file.
- `csv`: Reads from a local CSV file with headers.
- `rss`: Pulls feed items from a remote RSS URL.
- `wp_rei_land`: Pulls live land listings from a WordPress custom post endpoint such as `wp/v2/rei_land`.

## Notes for real websites

Many listing sites block scraping or require authentication. This starter is designed for legal/API/feed-based ingestion first. For each provider, prefer:

1. Official APIs,
2. Feeds/exports they publish,
3. Manual CSV exports where needed.

## Hosting

This is a static site, so it can be hosted on GitHub Pages.

Typical deploy pattern:

1. Push this folder to a GitHub repo.
2. Enable Pages with source = `main` branch, root folder.
3. Re-run `npm run fetch` and commit updated `data/listings.json` whenever source data changes.
