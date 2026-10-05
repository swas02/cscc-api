# Country-Level Social Cost of Carbon (CSCC) - Web Portal & Static API

[![Live Demo](https://img.shields.io/badge/live%20portal-swas02.github.io%2Fcscc--api-brightgreen.svg)](https://swas02.github.io/cscc-api/)
[![Data Format](https://img.shields.io/badge/format-CSCC%20v1%20binary-blue.svg)](https://swas02.github.io/cscc-api/v1/meta.json)
[![Countries](https://img.shields.io/badge/countries-170%20ISO3-orange.svg)](https://swas02.github.io/cscc-api/v1/meta.json)
[![Release Size](https://img.shields.io/badge/dataset%20size-3.8%20MB-success.svg)](https://swas02.github.io/cscc-api/v1/data/IND.bin)
[![Node & Bun Package](https://img.shields.io/badge/node%20%7C%20bun-cscc--local-black.svg)](https://github.com/swas02/cscc-local)
[![Build Tool](https://img.shields.io/badge/built%20with-Vite-646CFF.svg)](https://vitejs.dev/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> [!IMPORTANT]
> **Data Ownership & Attribution Disclaimer**:
> The original creators and owners of the underlying CSCC dataset are **[country-level-scc](https://github.com/country-level-scc/)** (associated with the publication [Ricke et al., 2018](https://doi.org/10.1038/s41558-018-0282-y)).
> **The maintainers of this repository are NOT the owners or authors of the CSV data.** This repository provides the public web portal, static CDN endpoints, and documentation. For offline programmatic usage in Node.js and Bun, see **[cscc-local](https://github.com/swas02/cscc-local)**.

A modern, **Vite-powered** interactive web portal and static CDN providing instant, client-side access to the **Country-Level Social Cost of Carbon (CSCC)** dataset across 170 countries.

---

## Live Web Portal

Explore data interactively with real-time performance metrics (execution latency, memory cache hits, throughput, and heap utilization):

👉 **[https://swas02.github.io/cscc-api/](https://swas02.github.io/cscc-api/)**

---

## Two Ways to Use This Project

| Environment | Recommended Solution | Setup |
| :--- | :--- | :--- |
| **Node.js & Bun (Backend / Offline)** | **[cscc-local](https://github.com/swas02/cscc-local)** | `npm install github:swas02/cscc-local#v1.0.0`<br>`const cscc = require('cscc-local');`<br>*100% offline, zero network calls* |
| **Web Browsers (Frontend / CDN)** | **`cscc-api` CDN** | `<script src="https://swas02.github.io/cscc-api/v1/index.js"></script>`<br>*Loads lightweight ~23 KB per country* |

---

## Browser Quickstart

Include the zero-dependency client in any HTML page:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>CSCC Browser Quickstart</title>
  <!-- Load client from static CDN -->
  <script src="https://swas02.github.io/cscc-api/v1/index.js"></script>
</head>
<body>
  <script>
    DataAPI.ready().then(async () => {
      // Query scenarios for India (IND)
      const results = await DataAPI.getData('IND', {
        ssp: 2,     // SSP2
        rcp: 4.5,   // rcp45
        dr: 3       // 3% discount rate
      });

      console.log('Returned scenarios:', results.length);
      console.log('Sample scenario:', results[0]);
    });
  </script>
</body>
</html>
```

---

## Local Development with Vite

This repository uses **Vite** for rapid local development, Hot Module Replacement (HMR), and optimized production builds.

### 1. Install Dependencies
```bash
npm install
```

### 2. Start Vite Development Server
```bash
npm run dev
```
Launches the local development server at `http://localhost:5173/` with instant live reload.

### 3. Build for Production
```bash
npm run build
```
Compiles the web portal, static assets, and pre-built binaries into `dist/` ready for deployment to GitHub Pages or any static web host.

### 4. Preview Production Build
```bash
npm run preview
```

---

## Public Static API Endpoints

All release assets are hosted statically with immutable cryptographic hashes:

| Endpoint | Type | Description |
| :--- | :--- | :--- |
| `https://swas02.github.io/cscc-api/latest.json` | JSON | Pointer to latest active release |
| `https://swas02.github.io/cscc-api/v1/meta.json` | JSON | Dictionaries, row index, schema metadata |
| `https://swas02.github.io/cscc-api/v1/manifest.json` | JSON | SHA-256 integrity checksums for all files |
| `https://swas02.github.io/cscc-api/v1/index.js` | JS | Standalone minified browser client (~10 KB) |
| `https://swas02.github.io/cscc-api/v1/data/<ISO3>.bin` | Binary | Little-endian country binary (23,344 bytes each) |

---

## Attribution & Citation

If using this dataset for research or policy analysis, please cite:

> **Ricke, K., Drouet, L., Caldeira, K. et al.** Country-level social cost of carbon. *Nature Climate Change* 8, 895–900 (2018).  
> DOI: [10.1038/s41558-018-0282-y](https://doi.org/10.1038/s41558-018-0282-y)

---

## License

MIT License. Dataset terms and academic replication rights remain with Ricke et al. (2018).
