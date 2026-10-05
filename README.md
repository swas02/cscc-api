# Country-Level Social Cost of Carbon (CSCC) Static API & Client

[![CSV Data Census](https://img.shields.io/badge/data%20census-1.24M%20assertions-brightgreen.svg)](test_api.js)
[![User Contract Tests](https://img.shields.io/badge/contract%20tests-83%2F83%20passed-brightgreen.svg)](test_user_api.js)
[![Data Format](https://img.shields.io/badge/format-CSCC%20v1%20binary-blue.svg)](build_cscc.py)
[![Countries](https://img.shields.io/badge/countries-170%20ISO3-orange.svg)](site/v1/meta.json)
[![Release Size](https://img.shields.io/badge/release%20size-3.8%20MB-success.svg)](site/v1)

> [!IMPORTANT]
> **Data Ownership & Attribution Disclaimer**:
> The original creators and owners of the underlying CSCC dataset are **[country-level-scc](https://github.com/country-level-scc/)** (associated with the publication [Ricke et al., 2018](https://doi.org/10.1038/s41558-018-0282-y)).
> **The maintainers of this repository are NOT the owners or authors of the CSV data.** This repository solely provides an optimized binary compilation and a static API client to make their published data accessible and lightweight for web and programmatic applications.

A high-performance static API and zero-dependency client library providing fast, lightweight access to the **Country-Level Social Cost of Carbon (CSCC)** dataset ([Ricke et al., 2018](https://doi.org/10.1038/s41558-018-0282-y)).

Instead of querying a heavy database server or downloading a monolithic 27.5 MB CSV into client browsers, this project compiles the entire dataset into **170 compact binary files** (one per ISO3 country, **~22.8 KB each**). A unified metadata index enables sub-millisecond filtering, caching, and lookups in modern browsers and Node.js.

---

## Table of Contents

- [Key Features](#key-features)
- [Architecture & Design](#architecture--design)
  - [Static Release Layout](#static-release-layout)
  - [Binary Format Specification](#binary-format-specification)
  - [Key Dimension Mapping](#key-dimension-mapping)
- [Interactive Playground & Live Usage Stats](#interactive-playground--live-usage-stats)
- [Installation & Quickstart](#installation--quickstart)
  - [Node.js](#nodejs)
  - [Browser](#browser)
- [Client API Reference](#client-api-reference)
  - [`DataAPI.ready()`](#dataapiready)
  - [`DataAPI.countries()`](#dataapicountries)
  - [`DataAPI.options(filter)`](#dataapioptionsfilter)
  - [`DataAPI.getData(iso3, filter)`](#dataapigetdataiso3-filter)
  - [`DataAPI.get(iso3, key)`](#dataapigetiso3-key)
  - [`DataAPI.prefetch(iso3)`](#dataapiprefetchiso3)
  - [`DataAPI.configure(options)`](#dataapiconfigureoptions)
  - [`DataAPI.clearCache()`](#dataapiclearcache)
- [Data Model & Fields](#data-model--fields)
- [CLI & Build Pipeline](#cli--build-pipeline)
  - [Converting CSV to Binary](#converting-csv-to-binary)
  - [Running the Validation Test Suites](#running-the-validation-test-suites)
  - [Minifying JavaScript](#minifying-javascript)
- [CI/CD & GitHub Pages Deployment](#cicd--github-pages-deployment)
- [Data Verification & Integrity](#data-verification--integrity)
- [Attribution & Citation](#attribution--citation)
- [License](#license)

---

## Key Features

- **Extreme Compression**: Compiles a 27.5 MB CSV (247,860 rows) into a **3.80 MB total static release** across 170 countries.
- **Pay Only for What You Use**: Web applications only download the countries they need (~23 KB binary per country).
- **Universal JS Client**: Works seamlessly in both **Node.js (18+)** and modern **browsers** with identical syntax.
- **Deterministic & Immutable**: Every build generates deterministic cryptographic hashes (`schemaHash`, `manifest.json` SHA-256 for SRI and CDN caching).
- **Zero Runtime Dependencies**: The client library has zero external dependencies and uses standard `ArrayBuffer` and `DataView` primitives.
- **100% Data Fidelity**: All 247,860 rows and 170 countries verified round-trip against the original CSV.

---

## Architecture & Design

### Static Release Layout

The data is hosted as static files suitable for GitHub Pages, Cloudflare Pages, S3, or any HTTP web server:

```
site/
├── latest.json                     # Immutable release pointer: {"latest": "v1", ...}
└── v1/
    ├── meta.json                   # Shared dictionaries, row keys, discount mapping, layout
    ├── manifest.json               # SHA-256 checksums and exact byte sizes for all files
    └── data/
        ├── AFG.bin                 # Binary payload for Afghanistan (23,344 bytes)
        ├── IND.bin                 # Binary payload for India (23,344 bytes)
        ├── USA.bin                 # Binary payload for United States (23,344 bytes)
        └── ... (170 .bin files)
```

### Binary Format Specification

Each country `.bin` file is 23,344 bytes, formatted in little-endian binary layout:

| Offset | Type | Description |
| :--- | :--- | :--- |
| `0..3` | `char[4]` | Magic identifier: `"CSCC"` (`0x43534343`) |
| `4..5` | `uint16` | Format version: `1` |
| `6..7` | `uint16` | Reserved (`0x0000`) |
| `8..11` | `uint32` | Rows per country (`1458`) |
| `12..15`| `uint32` | Schema hash (first 4 bytes of SHA-256 schema hash) |
| `16..5847` | `float32[1458]` | **16.7% percentile** values (`NaN` represents missing / `NA`) |
| `5848..11679` | `float32[1458]` | **50.0% percentile** (median) values |
| `11680..17511`| `float32[1458]` | **83.3% percentile** values (`NaN` represents missing / `NA`) |
| `17512..23343`| `uint32[1458]`  | **N** (sample size / Monte Carlo runs) |

### Key Dimension Mapping

Because every country shares the exact same 1,458 scenario combinations in the exact same canonical order, scenario dimensions (`run`, `dmgfuncpar`, `climate`, `SSP`, `RCP`, `discount`) are stored only **once** inside `meta.json`.

---

## Interactive Playground & Live Usage Stats

The static release includes a pre-built web dashboard at [`site/index.html`](file:///E:/DesktopBackup3/3psLCCA%20is%20here/social-cost-of-carbon-api/site/index.html) designed using pure **Bootstrap 5**:

- **Live Query Tester**: Allows interactive selection of any of the 170 countries, SSP, RCP, and discount parameters with instant in-browser decoding.
- **Real-Time Browser Usage Stats**: Automatically updates after each response with:
  - **Round-Trip Execution Time** (in ms via `performance.now()`).
  - **Network Transfer & Cache Status** (differentiating 23.3 KB network fetches vs 0 KB memory cache hits).
  - **JS Heap Memory** (utilization in MB).
  - **Throughput** (records processed per second).

---

## Installation & Quickstart

The client library works identically in both **modern web browsers** and **Node.js (18+)**. Follow this step-by-step developer guide to utilize all client APIs:

### Step 1: Load and Initialize the Client (`DataAPI.ready()`)

**Browser (HTML)**:
```html
<!-- Load the zero-dependency client from GitHub Pages CDN -->
<script src="https://swas02.github.io/cscc-api/v1/index.js"></script>

<script>
  // Initialize and verify release metadata
  const meta = await DataAPI.ready();
  console.log('API Ready! Release metadata:', meta);
  // { dataVersion: 'v1', formatVersion: 1, schemaHash: 'fad69cfd...', rows: 1458, countries: 170 }
</script>
```

**Node.js (18+)**:
```javascript
const DataAPI = require('./src/index.js'); // or package

// Configure the static CDN endpoint
DataAPI.configure({
  baseUrl: 'https://swas02.github.io/cscc-api/v1/'
});

async function main() {
  const meta = await DataAPI.ready();
  console.log('Connected to CSCC API:', meta.dataVersion);
}
main();
```

---

### Step 2: List All Supported Countries (`DataAPI.countries()`)

Returns the complete sorted list of all 170 uppercase ISO-3 country codes:

```javascript
const countries = await DataAPI.countries();
console.log(`Loaded ${countries.length} countries:`, countries);
// ['AFG', 'AGO', 'ALB', ..., 'IND', ..., 'USA', ..., 'ZWE']
```

---

### Step 3: Discover Available Parameters & Dimensions (`DataAPI.options(filter)`)

Call `DataAPI.options()` to inspect all allowed dimension values, or pass a partial filter to inspect available choices constrained by prior selections:

| Parameter | Type / Format | Description & Supported Values |
| :--- | :--- | :--- |
| `run` | `string` | Damage specification: `'bhm_sr'`, `'bhm_lr'`, `'bhm_richpoor_sr'`, `'bhm_richpoor_lr'`, `'djk'` |
| `dmgfuncpar` | `string` | Damage parameterization: `'bootstrap'` (1,000 draws), `'point'` (central estimate) |
| `climate` | `string` | Climate response model: `'expected'` |
| `ssp` | `number` \| `string` | Shared Socioeconomic Pathway: `1, 2, 3, 4, 5` or `'SSP1'` - `'SSP5'` |
| `rcp` | `number` \| `string` | Representative Concentration Pathway: `4.5, 6.0, 8.5` or `'rcp45'`, `'rcp60'`, `'rcp85'` |
| `dr` | `number` \| `string` | Constant discount rate: `1.5, 2, 2.5, 3, 5` or `'1.5%'`, `'3%'` (or Ramsey `prtp`, `eta`) |

```javascript
// Get all available dimension options
const options = await DataAPI.options();
console.log('Available SSPs:', options.ssp); // ['SSP1', 'SSP2', 'SSP3', 'SSP4', 'SSP5']
console.log('Available RCPs:', options.rcp); // ['rcp45', 'rcp60', 'rcp85']
console.log('Discount Rates:', options.dr);  // [1.5, 2, 2.5, 3, 5]

// Get choices constrained by selecting SSP2
const ssp2Choices = await DataAPI.options({ ssp: 2 });
```

---

### Step 4: Query Filtered Scenarios (`DataAPI.getData(iso3, filter)`)

Fetches the 23.3 KB binary for the given country, decodes it in memory, and filters down to matching scenarios:

```javascript
// Query filtered scenarios for India (IND)
const results = await DataAPI.getData('IND', {
  ssp: 2,     // SSP2
  rcp: 4.5,   // rcp45
  dr: 3       // 3% discount rate
});

console.log(`Found ${results.length} matching scenarios:`);
results.forEach(row => {
  console.log(`Model: ${row.run} (${row.dmgfuncpar}) | Median: $${row.p50} / tCO2 | Range: [$${row.p16_7}, $${row.p83_3}] | Samples: ${row.n}`);
});
```

Each returned row contains:
- `row.iso`: ISO-3 country code (`"IND"`)
- `row.run`: Damage model specification (`"bhm_sr"`)
- `row.dmgfuncpar`: Damage function parameter (`"bootstrap"` or `"point"`)
- `row.climate`: Climate model specification (`"expected"`)
- `row.ssp`: Socioeconomic scenario (`"SSP2"`)
- `row.rcp`: Emission concentration pathway (`"rcp45"`)
- `row.dr`: Discount rate (`3`)
- `row.p50`: 50th percentile (median) Country Social Cost of Carbon ($/tCO2)
- `row.p16_7`: 16.7th percentile estimate ($/tCO2)
- `row.p83_3`: 83.3rd percentile estimate ($/tCO2)
- `row.n`: Monte Carlo bootstrap sample size (e.g. 1000)

---

### Step 5: Fast Single-Point Lookup (`DataAPI.get(iso3, exactKey)`)

Performs an instant $O(1)$ coordinate lookup without scanning row arrays. Returns the single scenario object or `null`:

```javascript
const point = await DataAPI.get('USA', {
  run: 'bhm_sr',
  dmgfuncpar: 'bootstrap',
  climate: 'expected',
  ssp: 2,
  rcp: 4.5,
  dr: 3
});

if (point) {
  console.log(`USA Median CSCC: $${point.p50} / tCO2 (n=${point.n})`);
}
```

---

### Step 6: Advanced Cache & Prefetch Controls

```javascript
// Pre-load top countries concurrently into memory cache
await DataAPI.prefetch(['USA', 'CHN', 'IND', 'DEU', 'JPN']);

// Configure timeouts, retries, and LRU memory limit
DataAPI.configure({
  timeoutMs: 10000, // 10 second timeout
  retries: 2,       // Retry network fetches twice
  maxCached: 50     // Keep at most 50 countries in memory
});

// Clear cache
DataAPI.clearCache();
```

---

## Client API Reference

### `DataAPI.ready()`
Initializes and loads metadata (`meta.json`). Returns release summary information:
```javascript
const meta = await DataAPI.ready();
// {
//   dataVersion: 'v1',
//   formatVersion: 1,
//   schemaHash: 'fad69cfd...',
//   rows: 1458,
//   countries: 170
// }
```

### `DataAPI.countries()`
Returns a sorted array of all 170 supported ISO-3 country codes:
```javascript
const list = await DataAPI.countries();
// ['AFG', 'AGO', 'ALB', ..., 'ZWE']
```

### `DataAPI.options(filter)`
Returns the available values for each dimension. When a partial filter is passed, it returns the valid choices available given that selection:
```javascript
// Unfiltered
const all = await DataAPI.options();

// Constrained by SSP
const constrained = await DataAPI.options({ ssp: 1 });
```

### `DataAPI.getData(iso3, filter)`
Fetches and decodes the country binary file, applying in-memory filters. Returns an array of matching row objects:
```javascript
const results = await DataAPI.getData('IND', {
  ssp: [1, 2],       // Accepts numbers (1, 2) or strings ('SSP1', 'SSP2')
  rcp: [4.5, 6.0],   // Accepts numbers (4.5) or strings ('rcp45')
  dr: 3              // Constant discount rate (3 or 5)
});
```

### `DataAPI.get(iso3, key)`
Fast single-row lookup. Returns a single row object or `null` if the combination does not exist:
```javascript
const row = await DataAPI.get('USA', {
  run: 'bhm_sr',
  dmgfuncpar: 'bootstrap',
  climate: 'expected',
  ssp: 2,
  rcp: 4.5,
  dr: 3
});
```

Supports Ramsey discount parameters (`prtp` and `eta`):
```javascript
const ramseyRow = await DataAPI.get('USA', {
  run: 'bhm_lr',
  dmgfuncpar: 'bootstrap',
  climate: 'expected',
  ssp: 1,
  rcp: 4.5,
  prtp: 1,
  eta: 0.7
});
```

### `DataAPI.prefetch(iso3)`
Pre-loads and decodes one or more countries into cache:
```javascript
await DataAPI.prefetch(['USA', 'IND', 'CHN']);
```

### `DataAPI.configure(options)`
Customizes library behavior:
```javascript
DataAPI.configure({
  baseUrl: 'http://localhost:8080/site/v1/', // Endpoint root with trailing slash
  timeoutMs: 15000,                          // Network timeout in ms (default: 15000)
  retries: 1,                                // Retries on 5xx / network error (default: 1)
  maxCached: Infinity,                       // LRU country cache limit (default: Infinity)
  fetch: null                                // Custom fetch implementation (optional)
});
```

### `DataAPI.clearCache()`
Clears all decoded country binaries from in-memory cache.

---

## Data Model & Fields

Each returned row contains:

| Field | Type | Description | Values / Examples |
| :--- | :--- | :--- | :--- |
| `run` | `string` | Damage model run specification | `'bhm_lr'`, `'bhm_sr'`, `'bhm_richpoor_lr'`, `'bhm_richpoor_sr'`, `'djo_richpoor'` |
| `dmgfuncpar` | `string` | Damage function parameterization | `'bootstrap'`, `'estimates'` |
| `climate` | `string` | Climate model uncertainty | `'expected'`, `'uncertain'` |
| `ssp` | `string` | Shared Socioeconomic Pathway | `'SSP1'`, `'SSP2'`, `'SSP3'`, `'SSP4'`, `'SSP5'` |
| `rcp` | `string` | Representative Concentration Pathway | `'rcp45'`, `'rcp60'`, `'rcp85'` |
| `dr` | `number \| null` | Constant discount rate (%) | `3`, `5`, or `null` (if Ramsey) |
| `prtp` | `number \| null` | Pure rate of time preference | `1`, `2`, or `null` (if constant `dr`) |
| `eta` | `number \| null` | Elasticity of marginal utility | `0.7`, `1.5`, or `null` (if constant `dr`) |
| `p16_7` | `number \| null` | 16.7th percentile CSCC ($/tCO₂) | Float or `null` if NA |
| `p50` | `number \| null` | Median (50th percentile) CSCC ($/tCO₂) | Float or `null` if NA |
| `p83_3` | `number \| null` | 83.3th percentile CSCC ($/tCO₂) | Float or `null` if NA |
| `n` | `number` | Monte Carlo sample size | Integer (e.g. `1000`) |

---

## CLI & Build Pipeline

### Converting CSV to Binary

Re-generate the static binary release from `src/cscc_db_v2.csv`:

```bash
# via npm
npm run build:data

# or directly with python
python build_cscc.py --csv src/cscc_db_v2.csv --out site --version v1 --force
```

Build arguments:
- `--csv <path>`: Source CSV path (default: `src/cscc_db_v2.csv`)
- `--out <dir>`: Target root directory (default: `site`)
- `--version <name>`: Release folder name (default: `v1`)
- `--force`: Overwrite existing release folder
- `--no-latest`: Do not update `latest.json`

### Running the Validation Test Suites

Run the full end-to-end test suite:

```bash
npm test
```

This executes both test suites sequentially:

1. **Full CSV Data Census (`npm run test:csv` / `test_api.js`)**:
   - Executes **1,241,210 assertions** across all **247,860 rows (~2.5 lakh records)**.
   - Validates all 170 `.bin` files and headers on disk.
   - Decodes every scenario cell-by-cell and verifies float32 precision against the raw CSV.

2. **User Contract & Fault-Injection Suite (`npm run test:user` / `test_user_api.js`)**:
   - Executes **83 test cases across 14 test suites** using `node:test`.
   - Tests public API invariants, partition sums, and array filter unions.
   - Simulates network drops, 503 retries, timeouts, corrupt payload recovery, and LRU cache eviction.
   - Confirms byte-for-byte parity between `src/index.js` and minified `dist/index.js`.

### Minifying JavaScript

Generate minified `dist/index.js` and compute Subresource Integrity (SRI) hashes:

```bash
npm run build:js
```

---

## CI/CD & GitHub Pages Deployment

The repository includes an automated GitHub Actions workflow at [`.github/workflows/deploy.yml`](file:///E:/DesktopBackup3/3psLCCA%20is%20here/social-cost-of-carbon-api/.github/workflows/deploy.yml):

- **Continuous Integration (CI)**: On every push and pull request to `main`, sets up Python and Node.js, re-verifies binary generation, and runs both test suites (**1.24M assertions** across all 2.5 lakh rows + **83 contract/fault tests**).
- **Continuous Deployment (CD)**: When changes merge to `main`, automatically publishes [`site/`](file:///E:/DesktopBackup3/3psLCCA%20is%20here/social-cost-of-carbon-api/site) to **GitHub Pages**, providing live static endpoints with global CDN caching.

---

## Data Verification & Integrity

The build and test pipeline enforce strict validation:

1. **Deterministic Schema**: Releases are cryptographically hashed; any layout change triggers a format version and schema hash mismatch.
2. **Exhaustive Census**: The test suite guarantees that **all 170 countries and all 247,860 scenarios** are present and accurately decoded.
3. **Float32 Precision Match**: Decoded percentile values match the IEEE 754 float32 representation of the source CSV entries with relative error $< 10^{-7}$.
4. **Manifest Hashes**: Every file in `site/v1/` is checked against `manifest.json` SHA-256 signatures.

---

## Attribution & Citation

The original data and methodology belong entirely to the authors and maintainers of the **[country-level-scc](https://github.com/country-level-scc/)** project. If you use this data in research or publications, please cite the original study:

> Ricke, K., Drouet, L., Caldeira, K. et al. Country-level social cost of carbon. *Nat. Clim. Chang.* **8**, 895–900 (2018). https://doi.org/10.1038/s41558-018-0282-y

---

## License

This repository follows a clear dual-boundary licensing structure:

- **Source Code & Tooling ([MIT License](LICENSE))**: The Python conversion scripts, build pipeline, JavaScript client library (`src/index.js`), test suites, and GitHub Actions workflows are open source under the MIT License.
- **Dataset Notice (Academic Replication Data)**: The underlying Country-Level Social Cost of Carbon (CSCC) data was published by [Ricke et al. (2018)](https://doi.org/10.1038/s41558-018-0282-y) via [country-level-scc](https://github.com/country-level-scc/) as academic supplementary replication material without an explicit open-source license. It is distributed here in good faith for scientific, educational, and academic research. Proper academic citation of the original study is required. For commercial use inquiries, please contact the original authors.
