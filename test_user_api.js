'use strict';
/**
 * User-perspective test suite for the CSCC DataAPI.
 *
 * RULES OF THIS FILE
 *  - Only the public client API is used: ready, countries, options, getData, get, prefetch, configure, clearCache.
 *  - Never reads the CSV, the .bin files, meta.json or any internal state directly.
 *  - Correctness is judged by oracles a user could build: cross-API consistency (get vs getData vs options),
 *    partition/union properties, documented value sets, float32/NaN contracts, and the README examples.
 *  - A tiny local HTTP server serves ./site (the "environment") and can inject faults (5xx, hangs, corrupt bytes)
 *    so network behaviour can be observed from the outside.
 *
 * RUN:   node --test test_user_api.js
 * ENV:   CSCC_SITE=<dir containing v1/>   (default ./site)
 *        CSCC_CLIENT=<client module>      (default ./src/index.js)
 *
 * Tests marked [policy] assert a defensible-but-opinionated behaviour the README does not spell out.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

const SITE = path.resolve(process.env.CSCC_SITE || 'site');
const CLIENT = require.resolve(path.resolve(process.env.CSCC_CLIENT || 'src/index.js'));
const VER = 'v1';
const META = `/${VER}/meta.json`;
const BIN = (iso) => `/${VER}/data/${iso}.bin`;

// ------------------------------------------------------------------ environment: static server with fault injection
function startServer(root) {
  const log = [], counts = new Map(), faults = new Map();
  const server = http.createServer(async (req, res) => {
    const raw = req.url.split('?')[0];
    log.push(raw);
    const n = (counts.get(raw) || 0) + 1;
    counts.set(raw, n);
    let real = null;
    try {
      const file = path.join(root, decodeURIComponent(raw));
      if (file.startsWith(root + path.sep)) real = await fsp.readFile(file);
    } catch { /* 404 */ }
    const act = faults.get(raw)?.(n, real);
    if (act === 'hang') return;
    if (act === 'destroy') return req.socket.destroy();
    if (act?.delay) await new Promise((r) => setTimeout(r, act.delay));
    const status = act?.status ?? (real ? 200 : 404);
    const body = act?.body ?? (act?.status ? Buffer.from('injected fault') : real ?? Buffer.from('not found'));
    res.writeHead(status, { 'content-type': raw.endsWith('.json') ? 'application/json' : 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    base: `http://127.0.0.1:${server.address().port}/${VER}/`,
    log, counts, faults,
    fault: (p, fn) => faults.set(p, fn),
    count: (p) => counts.get(p) || 0,
    reset() { log.length = 0; counts.clear(); faults.clear(); },
    close() { server.closeAllConnections?.(); return new Promise((r) => server.close(r)); },
  })));
}

let A, B, shared, FULL, CODES;
const fresh = (cfg = {}) => {
  delete require.cache[CLIENT];
  const api = require(CLIENT);
  api.configure({ baseUrl: A.base, timeoutMs: 5000, retries: 0, maxCached: Infinity, fetch: null, ...cfg });
  return api;
};

before(async () => {
  assert.ok(fs.existsSync(path.join(SITE, VER, 'meta.json')), `no release at ${SITE}/${VER} (set CSCC_SITE)`);
  A = await startServer(SITE);
  B = await startServer(SITE);
  shared = fresh({ retries: 1 });
  CODES = await shared.countries();
  FULL = await shared.getData('USA');
});
after(async () => { await A?.close(); await B?.close(); });
beforeEach(() => { A?.reset(); B?.reset(); });

// ------------------------------------------------------------------ helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async (fn) => { try { return { ok: true, value: await fn() }; } catch (error) { return { ok: false, error }; } };
const expectNone = (fails, title) => assert.ok(fails.length === 0, `${title} — ${fails.length} problem(s):\n  ` + fails.slice(0, 25).join('\n  '));
const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const show = (x) => { try { return typeof x === 'symbol' ? x.toString() : typeof x === 'bigint' ? `${x}n` : typeof x === 'number' ? String(x) : JSON.stringify(x) ?? String(x); } catch { return Object.prototype.toString.call(x); } };

const FIELDS = ['run', 'dmgfuncpar', 'climate', 'ssp', 'rcp', 'dr', 'prtp', 'eta', 'p16_7', 'p50', 'p83_3', 'n'];
const DIMS = ['run', 'dmgfuncpar', 'climate', 'ssp', 'rcp', 'dr', 'prtp', 'eta'];
const DOC = {
  run: ['bhm_lr', 'bhm_sr', 'bhm_richpoor_lr', 'bhm_richpoor_sr', 'djo_richpoor'], dmgfuncpar: ['bootstrap', 'estimates'], climate: ['expected', 'uncertain'],
  ssp: ['SSP1', 'SSP2', 'SSP3', 'SSP4', 'SSP5'], rcp: ['rcp45', 'rcp60', 'rcp85'], dr: [3, 5], prtp: [1, 2], eta: [0.7, 1.5],
};
const nSSP = (v) => (typeof v === 'number' ? `SSP${v}` : String(v));
const nRCP = (v) => (typeof v === 'number' ? `rcp${Math.round(v * 10)}` : String(v));
const norm = (d, v) => (d === 'ssp' ? nSSP(v) : d === 'rcp' ? nRCP(v) : String(v));
const arr = (v) => (Array.isArray(v) ? v : [v]);
const keyOf = (r) => [r.run, r.dmgfuncpar, r.climate, r.ssp, r.rcp, r.dr, r.prtp, r.eta].join('|');
const lookupKey = (r) => {
  const k = { run: r.run, dmgfuncpar: r.dmgfuncpar, climate: r.climate, ssp: r.ssp, rcp: r.rcp };
  if (r.dr !== null) k.dr = r.dr; else { k.prtp = r.prtp; k.eta = r.eta; }
  return k;
};
// an independent oracle for filters, built only from rows the API itself returned
const matches = (row, f) => Object.entries(f).every(([k, v]) => arr(v).some((x) =>
  k === 'ssp' ? row.ssp === nSSP(x) : k === 'rcp' ? row.rcp === nRCP(x)
    : ['dr', 'prtp', 'eta'].includes(k) ? row[k] !== null && Math.abs(row[k] - x) < 1e-9 : row[k] === x));
const isRow = (v) => v && typeof v === 'object' && 'p50' in v;
const setStr = (d, vs) => [...new Set(vs.filter((v) => v !== null && v !== undefined).map((v) => norm(d, v)))].sort().join(',');

// =====================================================================================================================
describe('first contact (README examples run as written)', () => {
  it('ready() returns the documented release summary', async () => {
    const m = await fresh().ready();
    assert.equal(m.formatVersion, 1);
    assert.equal(m.rows, 1458);
    assert.equal(m.countries, 170);
    assert.match(m.dataVersion, /^v\d+/);
    assert.match(m.schemaHash, /^[0-9a-f]{8,}/);
  });

  it('every method works as the FIRST call (no ready() required)', async () => {
    const fails = [];
    const calls = {
      countries: (a) => a.countries(), options: (a) => a.options(), getData: (a) => a.getData('USA', { ssp: 2 }),
      get: (a) => a.get('USA', lookupKey(FULL[0])), prefetch: (a) => a.prefetch('USA'),
    };
    for (const [name, fn] of Object.entries(calls)) {
      const r = await settle(() => fn(fresh()));
      if (!r.ok) fails.push(`${name}() as first call rejected: ${r.error.message}`);
    }
    expectNone(fails, 'lazy init');
  });

  it('Node quickstart: getData("IND", {ssp:2, rcp:4.5, dr:3})', async () => {
    const rows = await fresh().getData('IND', { ssp: 2, rcp: 4.5, dr: 3 });
    assert.ok(rows.length > 0);
    for (const r of rows) { assert.equal(r.ssp, 'SSP2'); assert.equal(r.rcp, 'rcp45'); assert.equal(r.dr, 3); }
  });

  it('browser quickstart: get("USA", constant-discount key) → row with numeric p50', async () => {
    const row = await fresh().get('USA', { run: 'bhm_sr', dmgfuncpar: 'bootstrap', climate: 'expected', ssp: 'SSP2', rcp: 'rcp45', dr: 3 });
    assert.ok(row, 'documented example returned null');
    assert.equal(typeof row.p50, 'number');
  });

  it('Ramsey example: get("USA", {bhm_lr, prtp:1, eta:0.7}) → row', async () => {
    const row = await fresh().get('USA', { run: 'bhm_lr', dmgfuncpar: 'bootstrap', climate: 'expected', ssp: 1, rcp: 4.5, prtp: 1, eta: 0.7 });
    assert.ok(row, 'documented Ramsey example returned null');
    assert.equal(row.dr, null); assert.equal(row.prtp, 1); assert.equal(row.eta, 0.7);
  });

  it('array filters from the README: ssp [1,2], rcp [4.5, 6.0], dr 3', async () => {
    const rows = await fresh().getData('IND', { ssp: [1, 2], rcp: [4.5, 6.0], dr: 3 });
    assert.ok(rows.length > 0);
    assert.deepEqual([...new Set(rows.map((r) => r.ssp))].sort(), ['SSP1', 'SSP2']);
    assert.deepEqual([...new Set(rows.map((r) => r.rcp))].sort(), ['rcp45', 'rcp60']);
  });
});

// =====================================================================================================================
describe('countries() and options()', () => {
  it('countries(): 170 unique, sorted ISO3 codes incl. USA/IND/CHN', () => {
    assert.equal(CODES.length, 170);
    assert.equal(new Set(CODES).size, 170);
    assert.ok(CODES.every((c) => /^[A-Z]{3}$/.test(c)));
    assert.deepEqual([...CODES], [...CODES].sort());
    for (const c of ['USA', 'IND', 'CHN']) assert.ok(CODES.includes(c), c);
  });

  it('options(): documented value sets for every dimension', async () => {
    const o = await fresh().options();
    const fails = [];
    for (const d of DIMS) {
      if (!Array.isArray(o[d])) { fails.push(`options().${d} is not an array`); continue; }
      const got = setStr(d, o[d]), want = setStr(d, DOC[d]);
      if (got !== want) fails.push(`${d}: got {${got}} documented {${want}}`);
    }
    expectNone(fails, 'options()');
  });

  it('options() agrees with the values that actually occur in data', async () => {
    const o = await shared.options(), fails = [];
    for (const d of DIMS) {
      const seen = setStr(d, FULL.map((r) => r[d]));
      if (setStr(d, o[d]) !== seen) fails.push(`${d}: options {${setStr(d, o[d])}} vs data {${seen}}`);
    }
    expectNone(fails, 'options vs data');
  });

  it('options(filter): never hides a valid choice, never invents one (seeded random filters)', async () => {
    const R = rng(99), fails = [], all = await shared.options();
    for (let i = 0; i < 40 && fails.length < 10; i++) {
      const f = {};
      const base = FULL[Math.floor(R() * FULL.length)];
      for (const d of DIMS.sort(() => R() - 0.5).slice(0, 1 + Math.floor(R() * 3))) if (base[d] !== null) f[d] = base[d];
      const rows = await shared.getData('USA', f), opts = await shared.options(f);
      for (const d of DIMS) {
        const got = setStr(d, opts[d] ?? []);
        const exact = setStr(d, rows.map((r) => r[d]));
        const ok = d in f
          ? got === exact || got === setStr(d, (await shared.getData('USA', Object.fromEntries(Object.entries(f).filter(([k]) => k !== d)))).map((r) => r[d]))
          : got === exact;
        if (!ok) fails.push(`options(${show(f)}).${d} = {${got}} but data shows {${exact}}`);
        if (!got.split(',').every((v) => !v || setStr(d, all[d]).split(',').includes(v))) fails.push(`options(${show(f)}).${d} contains values outside options()`);
      }
    }
    expectNone(fails, 'options(filter)');
  });

  it('options(): number and string spellings of a filter are equivalent', async () => {
    assert.deepEqual(await shared.options({ ssp: 1 }), await shared.options({ ssp: 'SSP1' }));
    assert.deepEqual(await shared.options({ rcp: 4.5 }), await shared.options({ rcp: 'rcp45' }));
  });

  it('[policy] options() with a filter that matches nothing is empty, not the full set', async () => {
    const r = await settle(() => shared.options({ ssp: 99 }));
    if (!r.ok) return; // rejecting is acceptable
    const full = await shared.options();
    assert.ok(DIMS.some((d) => setStr(d, r.value[d] ?? []) !== setStr(d, full[d])), 'options({ssp:99}) returned everything');
    assert.ok(!(r.value.ssp ?? []).length || !(r.value.ssp ?? []).map((v) => nSSP(v)).includes('SSP99'));
  });
});

// =====================================================================================================================
describe('row contract', () => {
  it('unfiltered getData(USA): exactly 1458 rows, exactly the 12 documented fields', () => {
    assert.equal(FULL.length, 1458);
    const bad = FULL.filter((r) => Object.keys(r).sort().join() !== [...FIELDS].sort().join());
    assert.equal(bad.length, 0, `rows with wrong field set, e.g. ${show(bad[0] && Object.keys(bad[0]))}`);
  });

  it('types, documented value sets, discount exclusivity, NaN→null, float32, percentile order, n', async () => {
    const sample = ['USA', 'IND', 'CHN', CODES[0], CODES[CODES.length - 1]];
    const fails = [], push = (m) => fails.length < 25 && fails.push(m);
    for (const iso of sample) {
      const rows = await shared.getData(iso);
      if (rows.length !== 1458) push(`${iso}: ${rows.length} rows`);
      for (const r of rows) {
        for (const d of ['run', 'dmgfuncpar', 'climate', 'ssp', 'rcp']) if (!DOC[d].includes(r[d])) push(`${iso}: ${d}=${show(r[d])} not documented`);
        const ramsey = r.dr === null;
        if (ramsey ? !(DOC.prtp.includes(r.prtp) && DOC.eta.includes(r.eta)) : !(DOC.dr.includes(r.dr) && r.prtp === null && r.eta === null)) push(`${iso}: bad discount fields ${show([r.dr, r.prtp, r.eta])}`);
        for (const p of ['p16_7', 'p50', 'p83_3']) {
          const v = r[p];
          if (v !== null && !(typeof v === 'number' && Number.isFinite(v))) push(`${iso}: ${p}=${show(v)} (NaN/Infinity/undefined leaked)`);
          else if (v !== null && Math.fround(v) !== v) push(`${iso}: ${p}=${v} is not a float32 value`);
        }
        if (r.p16_7 !== null && r.p50 !== null && r.p16_7 > r.p50 + 1e-4 * Math.abs(r.p50) + 1e-6) push(`${iso}: p16_7 ${r.p16_7} > p50 ${r.p50}`);
        if (r.p50 !== null && r.p83_3 !== null && r.p50 > r.p83_3 + 1e-4 * Math.abs(r.p83_3) + 1e-6) push(`${iso}: p50 ${r.p50} > p83_3 ${r.p83_3}`);
        if (!Number.isInteger(r.n) || r.n < 0) push(`${iso}: n=${show(r.n)}`);
      }
      if (!rows.some((r) => r.p50 !== null)) push(`${iso}: every p50 is null`);
      if (JSON.stringify(rows).includes('NaN')) push(`${iso}: NaN in JSON`);
    }
    expectNone(fails, 'row contract');
  });

  it('scenario keys are unique within a country', () => {
    assert.equal(new Set(FULL.map(keyOf)).size, FULL.length);
  });

  it('different countries return different numbers (no wrong-file / wrong-cache-key mixups)', async () => {
    const sigs = new Map();
    for (const iso of CODES.slice(0, 12)) {
      const rows = await shared.getData(iso);
      sigs.set(iso, rows.slice(0, 200).map((r) => r.p50).join(','));
    }
    const nonEmpty = [...sigs].filter(([, s]) => /\d/.test(s));
    assert.equal(new Set(nonEmpty.map(([, s]) => s)).size, nonEmpty.length, 'two countries returned identical data');
  });
});

// =====================================================================================================================
describe('getData(filter)', () => {
  it('matches an independent oracle for a battery of filters (incl. order)', async () => {
    const battery = [{}, undefined, null, { ssp: 2 }, { ssp: 'SSP2' }, { ssp: [1, 2] }, { ssp: ['SSP1', 'SSP5'] }, { rcp: 4.5 }, { rcp: 'rcp45' },
      { rcp: [4.5, 6.0] }, { rcp: 8.5 }, { dr: 3 }, { dr: 5 }, { dr: [3, 5] }, { prtp: 1 }, { prtp: 2, eta: 0.7 }, { eta: 1.5 },
      { run: 'bhm_lr' }, { run: ['bhm_lr', 'bhm_sr'] }, { climate: 'expected' }, { dmgfuncpar: 'estimates' },
      { ssp: [1, 2], rcp: [4.5, 6], dr: 3 }, { run: 'djo_richpoor', ssp: 3, rcp: 8.5, climate: 'uncertain', dmgfuncpar: 'bootstrap' }];
    const fails = [];
    for (const f of battery) {
      const got = await shared.getData('USA', f);
      const want = FULL.filter((r) => matches(r, f ?? {}));
      if (got.length !== want.length) { fails.push(`${show(f)}: ${got.length} rows, expected ${want.length}`); continue; }
      if (got.some((r, i) => keyOf(r) !== keyOf(want[i]))) fails.push(`${show(f)}: rows differ or are out of canonical order`);
      if (got.some((r, i) => r.p50 !== want[i].p50)) fails.push(`${show(f)}: values differ from unfiltered rows`);
    }
    expectNone(fails, 'filter oracle');
  });

  it('partition: the slices of every dimension add back up to the whole', async () => {
    const fails = [];
    for (const d of ['run', 'dmgfuncpar', 'climate', 'ssp', 'rcp']) {
      const vals = [...new Set(FULL.map((r) => r[d]))];
      let total = 0;
      for (const v of vals) {
        const rows = await shared.getData('USA', { [d]: v });
        total += rows.length;
        if (rows.some((r) => r[d] !== v)) fails.push(`${d}=${v}: slice contains foreign rows`);
      }
      if (total !== FULL.length) fails.push(`${d}: slices sum to ${total}, expected ${FULL.length}`);
    }
    const c3 = (await shared.getData('USA', { dr: 3 })).length, c5 = (await shared.getData('USA', { dr: 5 })).length;
    const ram = FULL.filter((r) => r.dr === null).length;
    if (c3 + c5 + ram !== FULL.length) fails.push(`dr slices ${c3}+${c5}+Ramsey ${ram} ≠ ${FULL.length}`);
    expectNone(fails, 'partition');
  });

  it('array filter equals the union of its single-value filters', async () => {
    const u = [...(await shared.getData('USA', { ssp: 1 })), ...(await shared.getData('USA', { ssp: 4 }))].map(keyOf).sort();
    const a = (await shared.getData('USA', { ssp: [1, 4] })).map(keyOf).sort();
    assert.deepEqual(a, u);
  });

  it('[policy] unknown filter keys are rejected or match nothing — never silently return everything', async () => {
    const fails = [];
    for (const f of [{ foo: 1 }, { SSP: 2 }, { Ssp: 2 }, { constructor: 1 }, { toString: 1 }, { rcp45: true }, { p50: 1 }, { ssp: 2, typo: 1 }]) {
      const r = await settle(() => shared.getData('USA', f));
      if (r.ok && r.value.length === FULL.length) fails.push(`${show(f)} → returned all ${FULL.length} rows`);
      if (r.ok && f.ssp === 2 && r.value.length === (FULL.filter((x) => x.ssp === 'SSP2')).length) fails.push(`${show(f)} → typo silently ignored`);
      if (!r.ok && !(r.error instanceof Error)) fails.push(`${show(f)} rejected with non-Error`);
    }
    expectNone(fails, 'unknown keys');
  });

  it('[policy] undocumented values match nothing (or reject) — never everything, never a partial guess', async () => {
    const fails = [];
    for (const f of [{ ssp: 99 }, { ssp: 0 }, { ssp: 'SSP9' }, { rcp: 2.6 }, { rcp: 'rcp26' }, { dr: 4 }, { dr: 0 }, { prtp: 3 }, { eta: 1 }, { run: 'nope' },
      { climate: 'EXPECTED' }, { ssp: NaN }, { ssp: {} }, { ssp: true }, { ssp: Infinity }, { dr: '3%' }, { dr: 3.0000001 }]) {
      const r = await settle(() => shared.getData('USA', f));
      if (r.ok && r.value.length > 0) fails.push(`${show(f)} → ${r.value.length} rows`);
    }
    expectNone(fails, 'invalid values');
  });

  it('dr filter excludes Ramsey rows and vice-versa', async () => {
    assert.ok((await shared.getData('USA', { dr: 3 })).every((r) => r.dr === 3 && r.prtp === null));
    assert.ok((await shared.getData('USA', { prtp: 1 })).every((r) => r.dr === null && r.prtp === 1));
  });

  it('a filter value taken from a returned row is accepted back as a filter (round-trip)', async () => {
    const fails = [];
    for (const r of [FULL[0], FULL[500], FULL[1457]]) {
      const got = await shared.getData('USA', lookupKey(r));
      if (got.length !== 1 || keyOf(got[0]) !== keyOf(r)) fails.push(`row ${keyOf(r)}: filter by its own key returned ${got.length} rows`);
    }
    expectNone(fails, 'self round-trip');
  });
});

// =====================================================================================================================
describe('get(iso3, key)', () => {
  it('returns exactly the row getData lists — for all 1,458 scenarios of USA and a sample of IND', async () => {
    const fails = [];
    for (const r of FULL) {
      const g = await shared.get('USA', lookupKey(r));
      if (!g || JSON.stringify(g) !== JSON.stringify(r)) { fails.push(`USA ${keyOf(r)} → ${show(g)}`); if (fails.length > 10) break; }
    }
    const ind = await shared.getData('IND');
    for (let i = 0; i < ind.length; i += 7) {
      const g = await shared.get('IND', lookupKey(ind[i]));
      if (!g || JSON.stringify(g) !== JSON.stringify(ind[i])) fails.push(`IND ${keyOf(ind[i])} mismatch`);
    }
    expectNone(fails, 'get vs getData');
  });

  it('number and string spellings address the same row', async () => {
    const r = FULL.find((x) => x.dr === 3 && x.ssp === 'SSP2' && x.rcp === 'rcp45');
    const a = await shared.get('USA', lookupKey(r));
    const b = await shared.get('USA', { ...lookupKey(r), ssp: 2, rcp: 4.5 });
    assert.ok(a && b);
    assert.deepEqual(a, b);
    const r85 = FULL.find((x) => x.rcp === 'rcp85' && x.dr === 5);
    assert.deepEqual(await shared.get('USA', { ...lookupKey(r85), rcp: 8.5 }), r85);
  });

  it('returns null for EVERY combination that does not exist (full cartesian product of options)', async () => {
    const o = await shared.options(), exist = new Set(FULL.map(keyOf));
    const disc = [...o.dr.map((d) => ({ dr: d })), ...o.prtp.flatMap((p) => o.eta.map((e) => ({ prtp: p, eta: e })))];
    const fails = [];
    let missing = 0;
    for (const run of o.run) for (const dmgfuncpar of o.dmgfuncpar) for (const climate of o.climate) for (const ssp of o.ssp) for (const rcp of o.rcp) for (const d of disc) {
      const key = { run, dmgfuncpar, climate, ssp, rcp, ...d };
      const k = [run, dmgfuncpar, climate, nSSP(ssp), nRCP(rcp), d.dr ?? null, d.prtp ?? null, d.eta ?? null].join('|');
      if (exist.has(k)) continue;
      missing++;
      const g = await shared.get('USA', key);
      if (g !== null) fails.push(`non-existent ${k} → ${show(g && keyOf(g))}`);
    }
    expectNone(fails, `get on ${missing} non-existent combinations`);
  });

  it('[policy] ambiguous / incomplete / over-specified keys never resolve to a row', async () => {
    const dr = FULL.find((r) => r.dr === 3), ram = FULL.find((r) => r.dr === null);
    const k = lookupKey(dr), kr = lookupKey(ram), fails = [];
    const variants = {
      'no run': { ...k, run: undefined }, 'no dmgfuncpar': { ...k, dmgfuncpar: undefined }, 'no climate': { ...k, climate: undefined },
      'no ssp': { ...k, ssp: undefined }, 'no rcp': { ...k, rcp: undefined },
      'no discount at all': { ...k, dr: undefined }, 'dr AND prtp': { ...k, prtp: 1 }, 'dr AND eta': { ...k, eta: 0.7 },
      'prtp without eta': { ...kr, eta: undefined }, 'eta without prtp': { ...kr, prtp: undefined }, 'dr null + no ramsey': { ...k, dr: null },
      'unknown extra field': { ...k, foo: 1 }, 'wrong run': { ...k, run: 'nope' }, 'empty key': {}, 'null key': null, 'undefined key': undefined,
      'array value': { ...k, ssp: ['SSP1', 'SSP2'] }, 'string dr': { ...k, dr: '3' === 3 ? 3 : 'three' },
    };
    for (const [label, key] of Object.entries(variants)) {
      const r = await settle(() => shared.get('USA', key));
      if (r.ok && isRow(r.value)) fails.push(`${label} → returned a row`);
      if (!r.ok && !(r.error instanceof Error)) fails.push(`${label} rejected with non-Error`);
    }
    expectNone(fails, 'ambiguous keys');
  });

  it('get() agrees with the same country regardless of fetch order', async () => {
    const a = fresh(), b = fresh();
    await a.getData('IND'); // warm a different file first
    const r = FULL[321];
    assert.deepEqual(await a.get('USA', lookupKey(r)), await b.get('USA', lookupKey(r)));
  });
});

// =====================================================================================================================
describe('invalid countries', () => {
  const BAD = ['', ' ', 'US', 'USAA', 'U$A', '../meta', '../manifest', 'USA.bin', 'USA?x=1', 'USA#x', '%55SA', '%2e%2e/meta', 'USA/', '/USA', 'USA/../IND',
    'ＵＳＡ', 'ATA', 'XXX', 'ZZZ', '000', null, undefined, 123, {}, true, ['USA'], ['USA', 'IND']];

  it('getData / get reject every malformed or unsupported code, with an Error, before any data request', async () => {
    const api = fresh(), fails = [];
    await api.ready();
    A.reset();
    for (const bad of BAD) {
      for (const [name, fn] of [['getData', () => api.getData(bad)], ['get', () => api.get(bad, lookupKey(FULL[0]))]]) {
        const r = await settle(fn);
        if (r.ok) fails.push(`${name}(${show(bad)}) resolved`);
        else if (!(r.error instanceof Error) || !r.error.message) fails.push(`${name}(${show(bad)}) rejected without a message`);
      }
    }
    const dataReqs = A.log.filter((p) => p.includes('/data/'));
    if (dataReqs.length) fails.push(`bad codes reached the network: ${dataReqs.slice(0, 5).join(', ')}`);
    const stray = A.log.filter((p) => !new RegExp(`^/(${VER}/(meta\\.json|manifest\\.json|data/[A-Z]{3}\\.bin)|latest\\.json)$`).test(p));
    if (stray.length) fails.push(`requests outside the release layout: ${stray.slice(0, 5).join(', ')}`);
    expectNone(fails, 'invalid iso3');
  });

  it('prefetch rejects invalid codes (including inside a list) and resolves for an empty list', async () => {
    const api = fresh(), fails = [];
    for (const bad of ['XXXX', '../meta', null, ['USA', 'XXXX'], ['USA', null], 123]) {
      const r = await settle(() => api.prefetch(bad));
      if (r.ok) fails.push(`prefetch(${show(bad)}) resolved`);
    }
    if (!(await settle(() => api.prefetch([]))).ok) fails.push('prefetch([]) rejected');
    expectNone(fails, 'prefetch validation');
  });

  it('[policy] lowercase / padded codes are either normalised to the same data or rejected', async () => {
    const api = fresh(), fails = [];
    for (const v of ['usa', ' USA ', 'Usa', 'USA\n']) {
      const r = await settle(() => api.getData(v));
      if (r.ok && JSON.stringify(r.value) !== JSON.stringify(FULL)) fails.push(`getData(${show(v)}) resolved with DIFFERENT data`);
    }
    expectNone(fails, 'lenient codes');
  });

  it('unsupported-but-well-formed code gives a readable error naming the code', async () => {
    const r = await settle(() => fresh().getData('ATA'));
    assert.ok(!r.ok);
    assert.match(r.error.message, /ATA|unsupported|unknown|not found|404/i);
  });
});

// =====================================================================================================================
describe('caching, prefetch and concurrency (observed through request counts)', () => {
  it('a country is downloaded once, however it is used afterwards', async () => {
    const api = fresh();
    await api.getData('USA'); await api.getData('USA', { ssp: 1 }); await api.get('USA', lookupKey(FULL[0])); await api.prefetch('USA');
    assert.equal(A.count(BIN('USA')), 1);
  });

  it('50 concurrent mixed calls share one metadata fetch and one country fetch', async () => {
    const api = fresh();
    await Promise.all(Array.from({ length: 50 }, (_, i) => [() => api.ready(), () => api.getData('USA', { ssp: 1 + (i % 5) }), () => api.get('USA', lookupKey(FULL[i])), () => api.options(), () => api.prefetch('USA')][i % 5]()));
    assert.equal(A.count(META), 1, 'meta fetched more than once');
    assert.equal(A.count(BIN('USA')), 1, 'USA fetched more than once');
  });

  it('prefetch: list, string and duplicates; later getData makes no request', async () => {
    const api = fresh();
    await api.prefetch(['USA', 'IND', 'USA', 'CHN']); await api.prefetch('USA');
    assert.equal(A.count(BIN('USA')), 1); assert.equal(A.count(BIN('IND')), 1); assert.equal(A.count(BIN('CHN')), 1);
    const before = A.log.length;
    await Promise.all(['USA', 'IND', 'CHN'].map((c) => api.getData(c)));
    assert.equal(A.log.length, before, 'prefetched countries triggered more requests');
  });

  it('clearCache() forces a re-download and the data is identical afterwards', async () => {
    const api = fresh();
    const a = await api.getData('USA'); api.clearCache();
    const b = await api.getData('USA');
    assert.equal(A.count(BIN('USA')), 2);
    assert.deepEqual(a, b);
  });

  it('clearCache() while a download is in flight neither crashes nor corrupts results', async () => {
    const api = fresh();
    A.fault(BIN('USA'), (n) => (n === 1 ? { delay: 300 } : undefined));
    const p = api.getData('USA');
    await sleep(60); api.clearCache();
    const r = await p;
    assert.equal(r.length, 1458);
    assert.deepEqual(await api.getData('USA'), r);
  });

  it('30 different countries in parallel: one request each, 30 distinct results', async () => {
    const api = fresh(), codes = CODES.slice(0, 30);
    const res = await Promise.all(codes.map((c) => api.getData(c, { ssp: 2, rcp: 4.5, dr: 3 })));
    for (const c of codes) assert.equal(A.count(BIN(c)), 1, c);
    assert.ok(res.every((r) => r.length > 0));
  });

  it('[maxCached] LRU: oldest country is evicted, recently used one survives', async () => {
    const api = fresh({ maxCached: 2 });
    await api.getData('USA'); await api.getData('IND'); await api.getData('CHN'); // cache {IND, CHN}
    await api.getData('CHN'); await api.getData('IND');
    assert.equal(A.count(BIN('CHN')), 1); assert.equal(A.count(BIN('IND')), 1);
    await api.getData('USA'); // USA evicted earlier → refetch
    assert.equal(A.count(BIN('USA')), 2, 'USA should have been evicted');
  });

  it('[maxCached] LRU touch: using a country protects it from eviction', async () => {
    A.reset();
    const api = fresh({ maxCached: 2 });
    await api.getData('USA'); await api.getData('IND'); await api.getData('USA'); // touch USA
    await api.getData('CHN');                                                      // evicts IND, not USA
    await api.getData('USA');
    assert.equal(A.count(BIN('USA')), 1, 'recently used USA was evicted');
    await api.getData('IND');
    assert.equal(A.count(BIN('IND')), 2, 'IND should have been the eviction victim');
  });

  it('[maxCached] 1 still works; evicted data is re-decoded identically', async () => {
    const api = fresh({ maxCached: 1 });
    const a = await api.getData('USA'); await api.getData('IND');
    assert.deepEqual(await api.getData('USA'), a);
  });
});

// =====================================================================================================================
describe('network behaviour', () => {
  it('retries=1: a single 503 is survived (exactly 2 attempts)', async () => {
    const api = fresh({ retries: 1 });
    A.fault(BIN('USA'), (n) => (n === 1 ? { status: 503 } : undefined));
    assert.equal((await api.getData('USA')).length, 1458);
    assert.equal(A.count(BIN('USA')), 2);
  });

  it('retries=1: persistent 5xx fails after exactly 2 attempts; retries=2 → 3 attempts', async () => {
    for (const [retries, attempts] of [[1, 2], [2, 3]]) {
      A.reset();
      const api = fresh({ retries });
      A.fault(BIN('USA'), () => ({ status: 502 }));
      assert.ok(!(await settle(() => api.getData('USA'))).ok);
      assert.equal(A.count(BIN('USA')), attempts, `retries=${retries}`);
    }
  });

  it('retries=0: no retry at all', async () => {
    const api = fresh({ retries: 0 });
    A.fault(BIN('USA'), (n) => (n === 1 ? { status: 503 } : undefined));
    assert.ok(!(await settle(() => api.getData('USA'))).ok);
    assert.equal(A.count(BIN('USA')), 1);
  });

  it('4xx is not retried and the error mentions the failure', async () => {
    const api = fresh({ retries: 3 });
    A.fault(BIN('USA'), () => ({ status: 404 }));
    const r = await settle(() => api.getData('USA'));
    assert.ok(!r.ok);
    assert.equal(A.count(BIN('USA')), 1, '404 was retried');
    assert.match(r.error.message, /404|not found|USA/i);
  });

  it('a dropped connection is retried', async () => {
    const api = fresh({ retries: 1 });
    A.fault(BIN('USA'), (n) => (n === 1 ? 'destroy' : undefined));
    assert.equal((await api.getData('USA')).length, 1458);
    assert.equal(A.count(BIN('USA')), 2);
  });

  it('metadata requests get the same retry treatment', async () => {
    const api = fresh({ retries: 1 });
    A.fault(META, (n) => (n === 1 ? { status: 500 } : undefined));
    assert.equal((await api.ready()).rows, 1458);
    assert.equal(A.count(META), 2);
  });

  it('timeoutMs aborts a hanging server promptly', async () => {
    const api = fresh({ timeoutMs: 300, retries: 0 });
    A.fault(BIN('USA'), () => 'hang');
    const t0 = Date.now();
    const r = await settle(() => api.getData('USA'));
    assert.ok(!r.ok);
    assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms for a 300 ms timeout`);
  });

  it('a hanging metadata request also times out', async () => {
    const api = fresh({ timeoutMs: 300, retries: 0 });
    A.fault(META, () => 'hang');
    const t0 = Date.now();
    assert.ok(!(await settle(() => api.ready())).ok);
    assert.ok(Date.now() - t0 < 3000);
  });

  it('failures are not cached: after a timeout / 5xx the next call succeeds', async () => {
    const api = fresh({ timeoutMs: 300, retries: 0 });
    A.fault(BIN('USA'), (n) => (n === 1 ? 'hang' : n === 2 ? { status: 500 } : undefined));
    assert.ok(!(await settle(() => api.getData('USA'))).ok);
    assert.ok(!(await settle(() => api.getData('USA'))).ok);
    assert.equal((await api.getData('USA')).length, 1458);
  });

  it('5 concurrent callers during an outage all fail together, then all recover', async () => {
    const api = fresh();
    A.fault(BIN('USA'), (n) => (n === 1 ? { status: 503 } : undefined));
    const r = await Promise.all(Array.from({ length: 5 }, () => settle(() => api.getData('USA'))));
    assert.ok(r.every((x) => !x.ok));
    assert.equal(A.count(BIN('USA')), 1, 'concurrent callers did not share the single attempt');
    assert.equal((await api.getData('USA')).length, 1458);
  });

  it('ready() failure is not sticky: reject once, then succeed', async () => {
    const api = fresh();
    A.fault(META, (n) => (n === 1 ? { status: 500 } : undefined));
    assert.ok(!(await settle(() => api.ready())).ok);
    assert.equal((await api.ready()).countries, 170);
  });
});

// =====================================================================================================================
describe('corrupt or hostile server responses', () => {
  const mut = (fn) => (n, real) => (n === 1 && real ? { body: fn(Buffer.from(real)) } : undefined);
  const cases = {
    'truncated to 1000 bytes': mut((b) => b.subarray(0, 1000)), 'empty body': mut(() => Buffer.alloc(0)),
    'HTML page with 200 (SPA fallback)': mut(() => Buffer.from('<!doctype html><html><body>Not Found</body></html>')),
    'wrong magic': mut((b) => { b.write('XXXX', 0); return b; }),
    'unsupported format version 2': mut((b) => { b.writeUInt16LE(2, 4); return b; }),
    'row count 1457 in header': mut((b) => { b.writeUInt32LE(1457, 8); return b; }),
    'schema hash mismatch': mut((b) => { b.writeUInt32LE((b.readUInt32LE(12) ^ 0xdeadbeef) >>> 0, 12); return b; }),
    '4 trailing bytes': mut((b) => Buffer.concat([b, Buffer.alloc(4)])),
    'one byte short': mut((b) => b.subarray(0, b.length - 1)),
  };
  for (const [name, fault] of Object.entries(cases)) {
    it(`bin: ${name} → rejects with Error, is not cached, next call recovers`, async () => {
      const api = fresh();
      A.fault(BIN('USA'), fault);
      const r = await settle(() => api.getData('USA'));
      assert.ok(!r.ok, 'corrupt payload was accepted');
      assert.ok(r.error instanceof Error && r.error.message);
      assert.equal((await api.getData('USA')).length, 1458);
    });
  }

  const meta = { 'invalid JSON': () => ({ body: Buffer.from('{not json') }), 'truncated JSON': (n, real) => ({ body: real.subarray(0, real.length >> 1) }),
    'empty object': () => ({ body: Buffer.from('{}') }), 'HTML with 200': () => ({ body: Buffer.from('<html></html>') }), 'empty body': () => ({ body: Buffer.alloc(0) }) };
  for (const [name, fn] of Object.entries(meta)) {
    it(`meta: ${name} → ready() rejects, next ready() recovers`, async () => {
      const api = fresh();
      A.fault(META, (n, real) => (n === 1 ? fn(n, real) : undefined));
      assert.ok(!(await settle(() => api.ready())).ok, 'bad metadata accepted');
      assert.equal((await api.ready()).rows, 1458);
    });
  }

  it('a corrupt file for one country does not poison other countries', async () => {
    const api = fresh();
    A.fault(BIN('IND'), mut((b) => { b.write('XXXX', 0); return b; }));
    assert.ok(!(await settle(() => api.getData('IND'))).ok);
    assert.equal((await api.getData('USA')).length, 1458);
  });
});

// =====================================================================================================================
describe('configure()', () => {
  it('baseUrl without trailing slash still works', async () => {
    const api = fresh({ baseUrl: A.base.replace(/\/$/, '') });
    assert.equal((await api.getData('USA')).length, 1458);
  });

  it('options merge: later configure() calls do not reset earlier ones', async () => {
    const api = fresh({ retries: 1 });
    api.configure({ timeoutMs: 4000 });
    A.fault(BIN('USA'), (n) => (n === 1 ? { status: 503 } : undefined));
    assert.equal((await api.getData('USA')).length, 1458, 'retries was reset by the second configure()');
  });

  it('custom fetch handles ALL traffic; global fetch is never touched', async () => {
    const real = globalThis.fetch, seen = [];
    globalThis.fetch = () => { throw new Error('global fetch used'); };
    try {
      const api = fresh({ fetch: (url, init) => { seen.push(String(url)); return real(url, init); } });
      assert.equal((await api.getData('USA')).length, 1458);
      assert.ok(seen.some((u) => u.endsWith('meta.json')) && seen.some((u) => u.endsWith('USA.bin')), `seen: ${seen}`);
    } finally { globalThis.fetch = real; }
  });

  it('custom fetch errors and non-ok responses surface as rejections', async () => {
    const a = fresh({ fetch: async () => { throw new Error('boom-from-fetch'); } });
    const r1 = await settle(() => a.ready());
    assert.ok(!r1.ok); assert.match(r1.error.message, /boom-from-fetch/);
    const b = fresh({ fetch: async () => new Response('nope', { status: 500 }) });
    assert.ok(!(await settle(() => b.ready())).ok);
  });

  it('changing baseUrl makes the client talk to the new host', async () => {
    const api = fresh();
    await api.ready();
    api.configure({ baseUrl: B.base });
    const m = await api.ready();
    assert.equal(m.countries, 170);
    assert.ok(B.count(META) >= 1, 'metadata was not re-fetched from the new baseUrl');
    await api.getData('CHN');
    assert.equal(B.count(BIN('CHN')), 1);
    assert.equal(A.count(BIN('CHN')), 0, 'request still went to the old host');
  });

  it('[policy] invalid options throw synchronously and leave the client usable', async () => {
    const api = fresh(), fails = [];
    const bad = [{ baseUrl: 123 }, { baseUrl: null }, { timeoutMs: -1 }, { timeoutMs: NaN }, { timeoutMs: 'fast' }, { retries: -1 }, { retries: NaN },
      { retries: 'two' }, { maxCached: -1 }, { maxCached: NaN }, { maxCached: 'all' }, { fetch: 'nope' }, { fetch: 5 }];
    for (const o of bad) {
      try { api.configure(o); fails.push(`configure(${show(o)}) accepted`); api.configure({ baseUrl: A.base, timeoutMs: 5000, retries: 0, maxCached: Infinity, fetch: null }); } catch (e) { if (!(e instanceof Error)) fails.push(`${show(o)} threw non-Error`); }
    }
    expectNone(fails, 'configure validation');
    assert.equal((await api.getData('USA')).length, 1458, 'client broken by rejected configure()');
  });

  it('a relative / unusable baseUrl fails with an Error, not a hang', async () => {
    const t0 = Date.now();
    const r = await settle(async () => { const api = fresh({ baseUrl: '/v1/', timeoutMs: 1000 }); return api.ready(); });
    assert.ok(!r.ok); assert.ok(r.error instanceof Error); assert.ok(Date.now() - t0 < 4000);
  });
});

// =====================================================================================================================
describe('isolation, immutability and determinism', () => {
  it('results are copies: mutating any returned value cannot affect later calls', async () => {
    const api = fresh();
    const c = await api.countries(); c.pop(); c[0] = 'XXX';
    const c2 = await api.countries();
    assert.equal(c2.length, 170); assert.notEqual(c2[0], 'XXX');
    const o = await api.options(); o.ssp.push('SSP9'); delete o.rcp;
    const o2 = await api.options();
    assert.ok(!o2.ssp.includes('SSP9') && Array.isArray(o2.rcp));
    const m = await api.ready(); m.rows = 1; m.countries = 0;
    assert.equal((await api.ready()).rows, 1458);
    const r = await api.getData('USA', { ssp: 1 }); const snap = JSON.stringify(r);
    r[0].p50 = -123; r[0].run = 'hacked'; r.length = 0;
    const r2 = await api.getData('USA', { ssp: 1 });
    assert.equal(JSON.stringify(r2), snap);
    const g = await api.get('USA', lookupKey(FULL[0])); g.p50 = -1;
    assert.notEqual((await api.get('USA', lookupKey(FULL[0]))).p50, -1);
  });

  it('two calls return equal-but-distinct objects in the same canonical order', async () => {
    const a = await shared.getData('USA', { rcp: 6 }), b = await shared.getData('USA', { rcp: 6 });
    assert.deepEqual(a, b); assert.notEqual(a[0], b[0]);
  });

  it('canonical row order is identical across countries', async () => {
    const usa = FULL.map(keyOf).join('\n');
    for (const c of [CODES[0], 'IND', CODES.at(-1)]) assert.equal((await shared.getData(c)).map(keyOf).join('\n'), usa, c);
  });

  it('two independent client instances do not share state', async () => {
    const a = fresh(), b = fresh();
    await a.getData('USA');
    const before = A.count(BIN('USA'));
    await b.getData('USA');
    // instances may legitimately share a module-level cache; if they do not, each fetches once
    assert.ok(A.count(BIN('USA')) - before <= 1);
    a.clearCache();
    assert.equal((await b.getData('USA')).length, 1458);
  });

  it('sparse arguments: getData/options accept missing, undefined and null filters identically', async () => {
    const a = await shared.getData('USA'), b = await shared.getData('USA', undefined), c = await shared.getData('USA', null), d = await shared.getData('USA', {});
    assert.deepEqual(a, b); assert.deepEqual(a, c); assert.deepEqual(a, d);
    assert.deepEqual(await shared.options(), await shared.options(null));
    assert.deepEqual(await shared.options(), await shared.options({}));
  });
});

// =====================================================================================================================
describe('whole-dataset census (prefetch everything)', () => {
  it('all 170 countries: 1458 rows, identical key order, unique keys, valid values, distinct data', async () => {
    const api = fresh({ retries: 1 });
    await api.prefetch(CODES);
    for (const c of CODES) assert.equal(A.count(BIN(c)), 1, `${c} fetched ${A.count(BIN(c))}×`);
    const ref = FULL.map(keyOf).join('\n'), fails = [], sigs = new Set();
    let nonNull = 0, total = 0;
    for (const c of CODES) {
      const rows = await api.getData(c);
      if (rows.length !== 1458) { fails.push(`${c}: ${rows.length} rows`); continue; }
      if (rows.map(keyOf).join('\n') !== ref) fails.push(`${c}: key order differs from USA`);
      let sig = 0;
      for (const r of rows) {
        total++;
        for (const p of ['p16_7', 'p50', 'p83_3']) {
          const v = r[p];
          if (v !== null && !Number.isFinite(v)) fails.push(`${c}: ${p}=${v}`);
        }
        if (r.p50 !== null) { nonNull++; sig = (sig * 31 + Math.fround(r.p50 * 1000)) % 1e12; }
        if (r.p16_7 !== null && r.p50 !== null && r.p50 !== null && r.p16_7 > r.p50 + 1e-4 * Math.abs(r.p50) + 1e-6) fails.push(`${c}: percentile order`);
        if (!Number.isInteger(r.n) || r.n < 0) fails.push(`${c}: n=${r.n}`);
      }
      sigs.add(sig);
      if (fails.length > 20) break;
    }
    expectNone(fails, 'census');
    assert.ok(nonNull > total * 0.5, `only ${nonNull}/${total} rows have a median`);
    assert.ok(sigs.size > 150, `only ${sigs.size} distinct country signatures out of 170`);
  });
});

// =====================================================================================================================
describe('performance smoke (generous limits; catches accidental O(n²))', () => {
  it('2000 cached get() calls and 100 cached filtered getData() calls are fast', async () => {
    const api = fresh(); await api.getData('USA');
    let t0 = Date.now();
    for (let i = 0; i < 2000; i++) await api.get('USA', lookupKey(FULL[i % FULL.length]));
    const tGet = Date.now() - t0;
    t0 = Date.now();
    for (let i = 0; i < 100; i++) await api.getData('USA', { ssp: [1, 2, 3], rcp: [4.5, 8.5], dr: 3 });
    const tFilter = Date.now() - t0;
    assert.ok(tGet < 3000, `2000 get() took ${tGet} ms`);
    assert.ok(tFilter < 3000, `100 getData() took ${tFilter} ms`);
  });

  it('single country download+decode finishes well under a second locally', async () => {
    const api = fresh(); await api.ready();
    const t0 = Date.now(); await api.getData('CHN');
    assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
  });
});

// =====================================================================================================================
const DIST = path.resolve('dist/index.js');
describe('dist/index.js parity', { skip: !fs.existsSync(DIST) && 'dist/index.js not built (npm run build:js)' }, () => {
  it('minified build returns identical results to the source build', async () => {
    const src = fresh();
    const want = await src.getData('IND', { ssp: 2, rcp: 4.5, dr: 3 });
    delete require.cache[DIST];
    const dist = require(DIST);
    dist.configure({ baseUrl: A.base, retries: 0 });
    assert.deepEqual(await dist.getData('IND', { ssp: 2, rcp: 4.5, dr: 3 }), want);
    assert.deepEqual(await dist.countries(), await src.countries());
    assert.deepEqual(await dist.options(), await src.options());
  });
});