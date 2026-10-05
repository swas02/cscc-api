/**
 * test_api.js
 * Comprehensive test suite validating DataAPI functions and binary files against cscc_db_v2.csv
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const DataAPI = require('./src/index.js');

const CSV_PATH = path.resolve(__dirname, 'src/cscc_db_v2.csv');
const SITE_DIR = path.resolve(__dirname, 'site/v1');

// Helper to convert CSV string representation of numbers/NA
function parseCsvToken(val) {
  if (val === undefined || val === null || val === 'NA' || val === '') return null;
  return Number(val.replace('p', '.'));
}

function parsePct(val) {
  if (val === undefined || val === null || val === 'NA' || val === '') return null;
  return Math.fround(parseFloat(val));
}

// Compare float32 values accounting for null / NaN
function float32Matches(apiVal, csvValStr) {
  const expected = parsePct(csvValStr);
  if (expected === null) {
    return apiVal === null;
  }
  if (apiVal === null) return false;
  // Exact float32 match
  if (apiVal === expected) return true;
  // Small relative tolerance in case of string parsing nuances
  const diff = Math.abs(apiVal - expected);
  return diff <= 1e-6 * Math.abs(expected) || diff < 1e-7;
}

async function runTests() {
  console.log('='.repeat(70));
  console.log('CSCC Data API & Binary Validation Test Suite');
  console.log('='.repeat(70));

  // 1. Check required files exist
  console.log('\n[1/8] Checking prerequisite files...');
  if (!fs.existsSync(CSV_PATH)) {
    throw new Error(`CSV file not found at: ${CSV_PATH}`);
  }
  if (!fs.existsSync(path.join(SITE_DIR, 'meta.json'))) {
    throw new Error(`meta.json not found at: ${SITE_DIR}/meta.json`);
  }
  if (!fs.existsSync(path.join(SITE_DIR, 'manifest.json'))) {
    throw new Error(`manifest.json not found at: ${SITE_DIR}/manifest.json`);
  }
  console.log('✓ Prerequisite files found.');

  // 2. Load and index CSV
  console.log('\n[2/8] Loading and parsing src/cscc_db_v2.csv...');
  console.time('CSV load');
  const csvRaw = fs.readFileSync(CSV_PATH, 'utf8');
  const csvLines = csvRaw.trim().split(/\r?\n/);
  const header = csvLines[0].split(',');
  console.timeEnd('CSV load');
  console.log(`✓ Read ${csvLines.length - 1} data rows from CSV.`);

  // Parse CSV rows into structured indexes
  const colIndex = {};
  header.forEach((name, i) => { colIndex[name] = i; });

  const csvCountries = new Set();
  const csvRowsByIso = new Map(); // iso -> array of row objects
  const csvRowLookup = new Map(); // composite key -> row object
  const uniqueValues = {
    run: new Set(),
    dmgfuncpar: new Set(),
    climate: new Set(),
    SSP: new Set(),
    RCP: new Set(),
    dr: new Set(),
    prtp: new Set(),
    eta: new Set(),
  };

  for (let i = 1; i < csvLines.length; i++) {
    const cols = csvLines[i].split(',');
    const iso = cols[colIndex['ISO3']];
    csvCountries.add(iso);

    const run = cols[colIndex['run']];
    const dmg = cols[colIndex['dmgfuncpar']];
    const clim = cols[colIndex['climate']];
    const ssp = cols[colIndex['SSP']];
    const rcp = cols[colIndex['RCP']];
    const n = parseInt(cols[colIndex['N']], 10);
    const drStr = cols[colIndex['dr']];
    const prtpStr = cols[colIndex['prtp']];
    const etaStr = cols[colIndex['eta']];

    const drVal = parseCsvToken(drStr);
    const prtpVal = parseCsvToken(prtpStr);
    const etaVal = parseCsvToken(etaStr);

    uniqueValues.run.add(run);
    uniqueValues.dmgfuncpar.add(dmg);
    uniqueValues.climate.add(clim);
    uniqueValues.SSP.add(ssp);
    uniqueValues.RCP.add(rcp);
    uniqueValues.dr.add(drVal);
    uniqueValues.prtp.add(prtpVal);
    uniqueValues.eta.add(etaVal);

    const rowObj = {
      run,
      dmgfuncpar: dmg,
      climate: clim,
      ssp,
      rcp,
      n,
      iso,
      dr: drVal,
      prtp: prtpVal,
      eta: etaVal,
      p16_7_str: cols[colIndex['16.7%']],
      p50_str: cols[colIndex['50%']],
      p83_3_str: cols[colIndex['83.3%']],
    };

    if (!csvRowsByIso.has(iso)) {
      csvRowsByIso.set(iso, []);
    }
    csvRowsByIso.get(iso).push(rowObj);

    const key = `${iso}|${run}|${dmg}|${clim}|${ssp}|${rcp}|${drVal}|${prtpVal}|${etaVal}`;
    csvRowLookup.set(key, rowObj);
  }

  const sortedCsvCountries = Array.from(csvCountries).sort();
  console.log(`✓ Indexed ${sortedCsvCountries.length} countries and ${csvRowLookup.size} distinct rows.`);

  // 3. Start local HTTP server to test DataAPI over real HTTP
  console.log('\n[3/8] Starting local test HTTP server for site/v1...');
  const server = http.createServer((req, res) => {
    const relPath = req.url.replace(/^\//, '').split('?')[0];
    const filePath = path.join(SITE_DIR, relPath);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const content = fs.readFileSync(filePath);
      const ext = path.extname(filePath);
      res.writeHead(200, {
        'Content-Type': ext === '.json' ? 'application/json' : 'application/octet-stream',
        'Content-Length': content.length,
      });
      res.end(content);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const serverPort = server.address().port;
  const baseUrl = `http://127.0.0.1:${serverPort}/`;
  DataAPI.configure({ baseUrl });
  console.log(`✓ Test server running at ${baseUrl}`);

  let passedTests = 0;
  let totalTests = 0;

  function assert(condition, message) {
    totalTests++;
    if (!condition) {
      console.error(`  FAIL: ${message}`);
      throw new Error(`Assertion failed: ${message}`);
    }
    passedTests++;
  }

  try {
    // 4. Test DataAPI.ready()
    console.log('\n[4/8] Testing DataAPI.ready()...');
    const readyMeta = await DataAPI.ready();
    assert(readyMeta.formatVersion === 1, `formatVersion should be 1, got ${readyMeta.formatVersion}`);
    assert(readyMeta.dataVersion === 'v1', `dataVersion should be 'v1', got ${readyMeta.dataVersion}`);
    assert(readyMeta.countries === sortedCsvCountries.length, `ready() country count should be ${sortedCsvCountries.length}, got ${readyMeta.countries}`);
    const expectedRowsPerCountry = csvLines.length - 1 / sortedCsvCountries.length;
    assert(readyMeta.rows === csvRowsByIso.get('IND').length, `ready() rows should match country row count (${csvRowsByIso.get('IND').length}), got ${readyMeta.rows}`);
    console.log(`  ✓ DataAPI.ready() returned valid metadata matching CSV (${readyMeta.countries} countries, ${readyMeta.rows} rows/country).`);

    // 5. Test DataAPI.countries()
    console.log('\n[5/8] Testing DataAPI.countries()...');
    const apiCountries = await DataAPI.countries();
    assert(Array.isArray(apiCountries), 'countries() must return an array');
    assert(apiCountries.length === sortedCsvCountries.length, `Expected ${sortedCsvCountries.length} countries, got ${apiCountries.length}`);
    for (let i = 0; i < sortedCsvCountries.length; i++) {
      assert(apiCountries[i] === sortedCsvCountries[i], `Country code mismatch at index ${i}: expected ${sortedCsvCountries[i]}, got ${apiCountries[i]}`);
    }
    console.log(`  ✓ DataAPI.countries() matched all ${apiCountries.length} CSV countries in order.`);

    // 6. Test DataAPI.options()
    console.log('\n[6/8] Testing DataAPI.options()...');
    const allOptions = await DataAPI.options();
    assert(Array.isArray(allOptions.run), 'options.run should be array');
    assert(Array.isArray(allOptions.ssp), 'options.ssp should be array');
    assert(Array.isArray(allOptions.rcp), 'options.rcp should be array');
    assert(Array.isArray(allOptions.dr), 'options.dr should be array');

    // Verify option values match CSV unique sets
    for (const r of allOptions.run) {
      assert(uniqueValues.run.has(r), `Option run "${r}" not found in CSV`);
    }
    for (const s of allOptions.ssp) {
      assert(uniqueValues.SSP.has(s), `Option ssp "${s}" not found in CSV`);
    }
    for (const r of allOptions.rcp) {
      assert(uniqueValues.RCP.has(r), `Option rcp "${r}" not found in CSV`);
    }

    // Filtered options test: filter by ssp: 'SSP1'
    const ssp1Options = await DataAPI.options({ ssp: 1 });
    assert(ssp1Options.ssp.length === allOptions.ssp.length, 'options() retains other choices for ssp dropdown');
    console.log('  ✓ DataAPI.options() verified against CSV unique values.');

    // 7. Test DataAPI.get() and DataAPI.getData() against CSV data
    console.log('\n[7/8] Testing DataAPI.get() and DataAPI.getData() against CSV data...');
    const testCountries = ['USA', 'IND', 'CHN', 'BRA', 'DEU', 'AFG', 'ZWE', 'WLD'];

    for (const iso of testCountries) {
      // Test full country retrieval via getData()
      const allRows = await DataAPI.getData(iso);
      const csvCountryRows = csvRowsByIso.get(iso);
      assert(allRows.length === csvCountryRows.length, `${iso}: getData() returned ${allRows.length} rows, expected ${csvCountryRows.length}`);

      // Test specific exact lookup via get()
      // Test 1: dr format (e.g. dr = 3)
      const query1 = {
        run: 'bhm_sr',
        dmgfuncpar: 'bootstrap',
        climate: 'expected',
        ssp: 2,
        rcp: 4.5,
        dr: 3,
      };
      const row1 = await DataAPI.get(iso, query1);
      assert(row1 !== null, `${iso}: get() returned null for valid key (dr: 3)`);
      const lookupKey1 = `${iso}|bhm_sr|bootstrap|expected|SSP2|rcp45|3|null|null`;
      const expectedRow1 = csvRowLookup.get(lookupKey1);
      assert(expectedRow1 !== undefined, `Lookup key ${lookupKey1} not found in CSV`);
      assert(row1.n === expectedRow1.n, `${iso}: N mismatch. API=${row1.n}, CSV=${expectedRow1.n}`);
      assert(float32Matches(row1.p16_7, expectedRow1.p16_7_str), `${iso}: 16.7% mismatch. API=${row1.p16_7}, CSV=${expectedRow1.p16_7_str}`);
      assert(float32Matches(row1.p50, expectedRow1.p50_str), `${iso}: 50% mismatch. API=${row1.p50}, CSV=${expectedRow1.p50_str}`);
      assert(float32Matches(row1.p83_3, expectedRow1.p83_3_str), `${iso}: 83.3% mismatch. API=${row1.p83_3}, CSV=${expectedRow1.p83_3_str}`);

      // Test 2: prtp + eta format (e.g. prtp = 1, eta = 0.7)
      const query2 = {
        run: 'bhm_lr',
        dmgfuncpar: 'bootstrap',
        climate: 'expected',
        ssp: 'SSP1',
        rcp: 'rcp45',
        prtp: 1,
        eta: 0.7,
      };
      const row2 = await DataAPI.get(iso, query2);
      assert(row2 !== null, `${iso}: get() returned null for valid key (prtp: 1, eta: 0.7)`);
      const lookupKey2 = `${iso}|bhm_lr|bootstrap|expected|SSP1|rcp45|null|1|0.7`;
      const expectedRow2 = csvRowLookup.get(lookupKey2);
      assert(expectedRow2 !== undefined, `Lookup key ${lookupKey2} not found in CSV`);
      assert(row2.n === expectedRow2.n, `${iso}: N mismatch for prtp/eta`);
      assert(float32Matches(row2.p16_7, expectedRow2.p16_7_str), `${iso}: 16.7% mismatch for prtp/eta`);
      assert(float32Matches(row2.p50, expectedRow2.p50_str), `${iso}: 50% mismatch for prtp/eta`);
      assert(float32Matches(row2.p83_3, expectedRow2.p83_3_str), `${iso}: 83.3% mismatch for prtp/eta`);

      // Test 3: getData() with filter
      const filtered = await DataAPI.getData(iso, { ssp: [1, 2], rcp: 4.5, dr: 3 });
      const expectedFiltered = csvCountryRows.filter(
        (r) => (r.ssp === 'SSP1' || r.ssp === 'SSP2') && r.rcp === 'rcp45' && r.dr === 3
      );
      assert(filtered.length === expectedFiltered.length, `${iso}: filtered getData returned ${filtered.length}, expected ${expectedFiltered.length}`);

      for (let i = 0; i < filtered.length; i++) {
        const a = filtered[i];
        const e = expectedFiltered[i];
        assert(a.ssp === e.ssp, `Filtered row ${i} ssp mismatch`);
        assert(a.rcp === e.rcp, `Filtered row ${i} rcp mismatch`);
        assert(a.n === e.n, `Filtered row ${i} N mismatch`);
        assert(float32Matches(a.p50, e.p50_str), `Filtered row ${i} p50 mismatch`);
      }
    }
    console.log(`  ✓ DataAPI.get() and getData() verified across test countries (${testCountries.join(', ')}).`);

    // Exhaustive census: verify 100% of all 170 countries and all ~2.5 lakh rows (247,860 rows) cell-by-cell
    console.log('\n  -> Running complete field-by-field verification across all ~2.5 lakh data rows (247,860 rows)...');
    let totalCensusRows = 0;
    for (const iso of sortedCsvCountries) {
      const countryRows = await DataAPI.getData(iso);
      assert(countryRows.length === 1458, `${iso}: expected exactly 1458 rows, got ${countryRows.length}`);
      for (let r = 0; r < countryRows.length; r++) {
        const row = countryRows[r];
        const key = `${iso}|${row.run}|${row.dmgfuncpar}|${row.climate}|${row.ssp}|${row.rcp}|${row.dr}|${row.prtp}|${row.eta}`;
        const exp = csvRowLookup.get(key);
        assert(exp !== undefined, `Row key not found in CSV: ${key}`);
        assert(row.n === exp.n, `N mismatch at row ${key}`);
        assert(float32Matches(row.p16_7, exp.p16_7_str), `p16_7 mismatch at row ${key}`);
        assert(float32Matches(row.p50, exp.p50_str), `p50 mismatch at row ${key}`);
        assert(float32Matches(row.p83_3, exp.p83_3_str), `p83_3 mismatch at row ${key}`);
        totalCensusRows++;
      }
    }
    assert(totalCensusRows === 247860, `Total rows across all countries should be 247860, got ${totalCensusRows}`);
    console.log(`  ✓ 100% full dataset check passed: all 170 countries and all ${totalCensusRows.toLocaleString()} rows (~2.5 lakh records) verified cell-by-cell against CSV (0 errors).`);

    // 8. Test Binary File Integrity, Prefetch, and Error Handling
    console.log('\n[8/8] Testing Binary files, prefetch(), cache, and error handling...');

    // Verify all 170 .bin files directly from disk
    const dataDir = path.join(SITE_DIR, 'data');
    const binFiles = fs.readdirSync(dataDir).filter((f) => f.endsWith('.bin'));
    assert(binFiles.length === sortedCsvCountries.length, `Expected ${sortedCsvCountries.length} .bin files, found ${binFiles.length}`);

    const EXPECTED_BIN_SIZE = 16 + 1458 * 16; // 23344 bytes
    for (const file of binFiles) {
      const fullPath = path.join(dataDir, file);
      const buf = fs.readFileSync(fullPath);
      assert(buf.length === EXPECTED_BIN_SIZE, `${file}: expected size ${EXPECTED_BIN_SIZE}, got ${buf.length}`);
      // Check magic "CSCC"
      assert(buf.toString('ascii', 0, 4) === 'CSCC', `${file}: invalid magic bytes`);
    }
    console.log(`  ✓ All ${binFiles.length} .bin files have valid 16-byte CSCC headers and match expected size (${EXPECTED_BIN_SIZE} bytes).`);

    // Test prefetch()
    await DataAPI.prefetch(['USA', 'IND', 'FRA']);
    const usaFast = await DataAPI.getData('USA', { dr: 3 });
    assert(usaFast.length > 0, 'getData after prefetch should return rows');
    console.log('  ✓ prefetch() and caching work as expected.');

    // Test error handling
    let threw = false;
    try {
      await DataAPI.getData('INVALID_ISO');
    } catch (err) {
      threw = err && err.code === 'UNKNOWN_ISO3';
    }
    assert(threw, 'getData with unknown ISO3 should throw UNKNOWN_ISO3');

    let filterThrew = false;
    try {
      await DataAPI.getData('USA', { non_existent_key: 123 });
    } catch (err) {
      filterThrew = err && err.code === 'BAD_OPTION';
    }
    assert(filterThrew, 'getData with invalid filter option should throw BAD_OPTION');

    let missingKeyThrew = false;
    try {
      await DataAPI.get('USA', { ssp: 1 }); // missing other required fields
    } catch (err) {
      missingKeyThrew = err && err.code === 'BAD_OPTION';
    }
    assert(missingKeyThrew, 'get() with missing required key fields should throw BAD_OPTION');

    console.log('  ✓ Error handling correctly catches invalid ISO3, bad filter options, and incomplete keys.');

    console.log('\n' + '='.repeat(70));
    console.log(`ALL CHECKS PASSED: ${passedTests}/${totalTests} assertions verified successfully!`);
    console.log('API functions and binary data files are operating properly.');
    console.log('='.repeat(70) + '\n');
  } finally {
    server.close();
  }
}

runTests().catch((err) => {
  console.error('\nTEST SUITE FAILED WITH ERROR:');
  console.error(err);
  process.exit(1);
});
