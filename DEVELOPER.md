# CSCC Developer Guide: Maintaining & Updating `cscc-local` and `cscc-api`

This guide explains how to develop, test, update, and deploy changes across both repositories:
- **`cscc-local`**: Standalone, zero-network Node.js / Bun client and offline dataset package.
- **`cscc-api` (`social-cost-of-carbon-api`)**: Vite-powered web portal and GitHub Pages static CDN.

---

## 1. Architecture & Repository Layout

```text
├── cscc-local/                         <-- Primary repository for the npm package
│   ├── src/
│   │   ├── index.js                    (CommonJS module for require())
│   │   ├── index.mjs                   (ESM module for import / Vite / bundlers)
│   │   └── index.d.ts                  (TypeScript definitions)
│   ├── data/                           (Pre-compiled 170 country binary files *.bin)
│   ├── meta.json                       (Dataset metadata, dictionary, layout schema)
│   ├── build_cscc.py                   (Python binary dataset compiler)
│   ├── test.js                         (CommonJS test suite)
│   └── test_esm.mjs                    (ESM test suite)
│
└── social-cost-of-carbon-api/          <-- Web portal & static CDN
    ├── cscc-local/                     (Cloned subfolder / local dependency: file:./cscc-local)
    ├── public/v1/                      (Static files served by CDN: meta.json, data/*.bin)
    ├── src/main.js                     (Web application entry point)
    ├── index.html                      (Bootstrap 5 interactive explorer)
    └── vite.config.js                  (Vite build configuration)
```

---

## 2. Updating `cscc-local`

### Scenario A: Updating Code / Client Methods

1. **Navigate to the standalone `cscc-local` repo**:
   ```powershell
   cd path/to/cscc-local
   ```

2. **Make your changes**:
   - For CommonJS (`require`), edit `src/index.js`.
   - For ES Modules (`import`), edit `src/index.mjs`.
   - For TypeScript types, edit `src/index.d.ts`.
   > **Note on ESM (`src/index.mjs`)**: Keep top-level Node imports safe for bundlers. Use:
   > ```javascript
   > import * as nodeFs from 'node:fs';
   > import * as nodePath from 'node:path';
   > const isNode = typeof process !== 'undefined' && process.versions && !!process.versions.node;
   > let fs = isNode ? nodeFs : null;
   > let path = isNode ? nodePath : null;
   > ```
   > This enables Vite and browser bundlers to externalize Node builtins without breaking browser runtime.

3. **Run the test suite**:
   ```powershell
   npm test
   ```
   Ensure both `node test.js` and `node test_esm.mjs` pass with zero errors.

4. **Commit & Push to GitHub**:
   ```powershell
   git add .
   git commit -m "Your update message"
   git push origin main
   ```

---

### Scenario B: Updating Underlying Dataset (New CSV Data)

If a new version of `cscc_db_v2.csv` is released:

1. **Place new CSV** into `cscc-local/src/cscc_db_v2.csv`.
2. **Re-compile binary data**:
   ```powershell
   cd path/to/cscc-local
   npm run build:data
   ```
   This regenerates `data/*.bin` and `meta.json`.
3. **Verify tests**:
   ```powershell
   npm test
   ```
4. **Commit & Push**:
   ```powershell
   git add data/ meta.json src/
   git commit -m "Update binary datasets to vX.X"
   git push origin main
   ```

---

## 3. Pulling `cscc-local` Updates into `cscc-api`

Whenever `cscc-local` is updated, pull the changes into `social-cost-of-carbon-api`:

### Step 1: Pull Latest in the Cloned Subfolder

```powershell
cd path/to/social-cost-of-carbon-api/cscc-local
git fetch origin
git pull origin main
```

*(Optional: verify tests inside the subfolder)*:
```powershell
npm test
```

---

### Step 2: Sync Static CDN Files (If Data Was Recompiled)

If `meta.json` or `data/*.bin` were modified in `cscc-local`, sync them to `public/v1/` for browser CDN hosting:

```powershell
cd path/to/social-cost-of-carbon-api

# Copy updated meta.json
Copy-Item "cscc-local/meta.json" "public/v1/meta.json" -Force

# Copy updated binary files
Copy-Item "cscc-local/data/*" "public/v1/data/" -Force
```

---

### Step 3: Test and Build Web Application

1. **Run development server** (optional preview during development):
   ```powershell
   npm run dev
   ```

2. **Run production Vite build**:
   ```powershell
   npm run build
   ```
   Vite will bundle `src/main.js` and `cscc-local` into `dist/`.

3. **Preview production build locally**:
   ```powershell
   npm run preview
   ```

---

### Step 4: Commit & Deploy

```powershell
cd path/to/social-cost-of-carbon-api
git add .
git commit -m "Update cscc-local dependency and rebuild web portal"
git push origin main
```

The GitHub Actions workflow (`.github/workflows/deploy.yml`) will automatically run `npm run build` and publish the updated portal to GitHub Pages.

---

## 4. Quick Reference Cheatsheet

| Task | Command | Directory |
|------|---------|-----------|
| Run `cscc-local` tests | `npm test` | `cscc-local/` |
| Recompile raw CSV to binaries | `npm run build:data` | `cscc-local/` |
| Fetch latest `cscc-local` into API | `git fetch origin; git pull origin main` | `social-cost-of-carbon-api/cscc-local/` |
| Sync CDN binaries to API | `Copy-Item "cscc-local/data/*" "public/v1/data/" -Force` | `social-cost-of-carbon-api/` |
| Build Web Portal with Vite | `npm run build` | `social-cost-of-carbon-api/` |
| Preview Built Web Portal | `npm run preview` | `social-cost-of-carbon-api/` |
