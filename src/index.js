/*! DataAPI 1.0.0 - client for the static data release it is published with */
/*
 * Browser:
 *   <script src="https://<user>.github.io/<repo>/v1/index.js"
 *           integrity="sha384-..." crossorigin="anonymous"></script>
 *   <script>
 *     DataAPI.getData('IND', { run: 'bhm_sr', ssp: [1, 2], rcp: 4.5, dr: 3 }).then(console.log);
 *   </script>
 *   The data base URL is the folder index.js was loaded from. Override with
 *   data-base-url="..." on the script tag, or DataAPI.configure({ baseUrl }).
 *
 * Node 18+ (no script tag, so baseUrl is required):
 *   const DataAPI = require('./index.js');
 *   DataAPI.configure({ baseUrl: 'https://<user>.github.io/<repo>/v1/' });
 *
 * Results use the dataset's own labels (ssp: 'SSP2', rcp: 'rcp45'); inputs also accept 2 and 4.5.
 * NA values come back as null. A valid filter with no matching rows returns [].
 */
(function (root) {
  'use strict';

  const LIB_VERSION = '1.0.0';
  const SUPPORTED_FORMAT = 1;
  const HEADER_BYTES = 16;
  const MAGIC = 0x43534343; // "CSCC", read big-endian
  const KEY_COLS = ['run', 'dmgfuncpar', 'climate', 'SSP', 'RCP', 'discount'];
  const KEY5 = ['run', 'dmgfuncpar', 'climate', 'ssp', 'rcp']; // public names that map 1:1 to a key column
  const COL_OF = { run: 'run', dmgfuncpar: 'dmgfuncpar', climate: 'climate', ssp: 'SSP', rcp: 'RCP' };
  const DISC = ['dr', 'prtp', 'eta']; // derived from the single "discount" key column
  const FIELDS = KEY5.concat(DISC);
  const IS_LE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

  const ERROR_CODES = Object.freeze({
    UNKNOWN_ISO3: 'UNKNOWN_ISO3',
    BAD_OPTION: 'BAD_OPTION',
    NETWORK: 'NETWORK',
    BAD_FILE: 'BAD_FILE',
    VERSION_MISMATCH: 'VERSION_MISMATCH',
  });

  class DataApiError extends Error {
    constructor(code, message, details) {
      super(message);
      this.name = 'DataApiError';
      this.code = code;
      this.details = details || {};
    }
  }
  const bad = (msg, details) => new DataApiError('BAD_OPTION', msg, details);

  // ---- configuration --------------------------------------------------------------------------
  const cfg = { baseUrl: null, timeoutMs: 15000, retries: 1, maxCached: Infinity, fetch: null };
  let state = newState(); // replaced when baseUrl changes or clearCache() is called
  function newState() {
    return { metaP: null, cache: new Map() };
  }

  const withSlash = (u) => (u.charAt(u.length - 1) === '/' ? u : u + '/');

  // Read the script tag synchronously: document.currentScript is null once loading has finished.
  try {
    const cs = root.document && root.document.currentScript;
    if (cs) {
      const attr = cs.getAttribute && cs.getAttribute('data-base-url');
      if (attr) cfg.baseUrl = withSlash(new URL(attr, root.document.baseURI).href);
      else if (cs.src) cfg.baseUrl = cs.src.split(/[?#]/)[0].replace(/[^/]*$/, '');
    }
  } catch (e) {
    /* leave baseUrl unset; configure({ baseUrl }) can still set it */
  }

  function requireBase() {
    if (!cfg.baseUrl) {
      throw bad('baseUrl is not set. Load index.js with a <script> tag, or call DataAPI.configure({ baseUrl }).');
    }
    return cfg.baseUrl;
  }

  function getFetch() {
    if (cfg.fetch) return cfg.fetch;
    if (typeof root.fetch === 'function') return root.fetch.bind(root);
    throw bad('No fetch available. Use Node 18+ or pass configure({ fetch }).');
  }

  // ---- network --------------------------------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Retries once (configurable) on network errors, timeouts and 5xx. A 4xx (e.g. Pages' HTML 404) is final.
  async function request(url, asText) {
    const f = getFetch();
    let lastErr = null;
    for (let i = 0; i <= cfg.retries; i++) {
      if (i > 0) await sleep(300);
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctrl && cfg.timeoutMs > 0 ? setTimeout(() => ctrl.abort(), cfg.timeoutMs) : 0;
      try {
        const res = await f(url, ctrl ? { signal: ctrl.signal } : undefined);
        if (res.ok) return asText ? await res.text() : await res.arrayBuffer();
        if (res.status < 500) {
          throw new DataApiError('BAD_FILE', `HTTP ${res.status} for ${url} (wrong baseUrl, or file missing)`, { url, status: res.status });
        }
        lastErr = new DataApiError('NETWORK', `HTTP ${res.status} from ${url}`, { url, status: res.status });
      } catch (e) {
        if (e instanceof DataApiError && e.code === 'BAD_FILE') throw e;
        lastErr = new DataApiError('NETWORK', `Could not fetch ${url}` + (e ? `: ${e.message || e}` : '') + (e && e.name === 'AbortError' ? ' (timed out)' : ''), { url, cause: e });
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  // ---- shared key table (meta.json) -----------------------------------------------------------
  function loadMeta(st) {
    if (!st.metaP) {
      const base = requireBase();
      const p = (async () => {
        const text = await request(base + 'meta.json', true);
        let raw;
        try {
          raw = JSON.parse(text);
        } catch (e) {
          throw new DataApiError('BAD_FILE', 'meta.json is not valid JSON', { url: base + 'meta.json' });
        }
        return prepareMeta(raw);
      })();
      st.metaP = p;
      p.catch(() => {
        if (st.metaP === p) st.metaP = null; // allow a retry after failure
      });
    }
    return st.metaP;
  }

  function prepareMeta(raw) {
    if (raw.formatVersion !== SUPPORTED_FORMAT) {
      throw new DataApiError('VERSION_MISMATCH', `Data format ${raw.formatVersion} is not supported (this library reads format ${SUPPORTED_FORMAT})`, {
        found: raw.formatVersion,
        supported: SUPPORTED_FORMAT,
      });
    }
    const m = { rows: raw.rows, dataVersion: raw.dataVersion, formatVersion: raw.formatVersion, schemaHash: raw.schemaHash };
    try {
      m.layout = raw.layout;
      m.countries = raw.countries;
      m.countrySet = new Set(raw.countries);
      m.dict = {};
      m.codes = {};
      m.ci = {}; // lowercase label -> code, for case-insensitive input
      for (const c of KEY_COLS) {
        m.dict[c] = raw.dict[c];
        m.codes[c] = Uint8Array.from(raw.keys[c]);
        if (m.codes[c].length !== m.rows) throw new Error('key length');
        m.ci[c] = new Map(raw.dict[c].map((v, i) => [v.toLowerCase(), i]));
      }
      // mixed-radix id of a full key -> row index (-1 if that combination does not exist)
      m.mult = {};
      let size = 1;
      for (let i = KEY_COLS.length - 1; i >= 0; i--) {
        m.mult[KEY_COLS[i]] = size;
        size *= m.dict[KEY_COLS[i]].length;
      }
      m.lookup = new Int32Array(size).fill(-1);
      for (let r = 0; r < m.rows; r++) {
        let id = 0;
        for (const c of KEY_COLS) id += m.codes[c][r] * m.mult[c];
        m.lookup[id] = r;
      }
      // discount label -> { dr, prtp, eta }
      m.disc = m.dict.discount.map((lab) => {
        const d = raw.discountDetail[lab];
        return { dr: d.dr, prtp: d.prtp, eta: d.eta };
      });
      m.discIndex = new Map(m.disc.map((d, i) => [`${d.dr}|${d.prtp}|${d.eta}`, i]));
      m.discValues = {};
      for (const f of DISC) m.discValues[f] = sortVals(Array.from(new Set(m.disc.map((d) => d[f]))));
      m.schemaU32 = parseInt(String(raw.schemaHash).slice(0, 8), 16);
    } catch (e) {
      throw new DataApiError('BAD_FILE', 'meta.json is missing expected fields', { cause: e });
    }
    return m;
  }

  // ---- per-country values ---------------------------------------------------------------------
  function decode(m, iso, buf) {
    const rows = m.rows;
    const url = `data/${iso}.bin`;
    if (buf.byteLength !== m.layout.bytesPerFile) {
      throw new DataApiError('BAD_FILE', `${url} is ${buf.byteLength} bytes, expected ${m.layout.bytesPerFile}`, { file: url });
    }
    const dv = new DataView(buf);
    if (dv.getUint32(0, false) !== MAGIC) throw new DataApiError('BAD_FILE', `${url} is not a data file (bad header)`, { file: url });
    const fmt = dv.getUint16(4, true);
    const hRows = dv.getUint32(8, true);
    const schema = dv.getUint32(12, true);
    if (fmt !== m.formatVersion || hRows !== rows || schema !== m.schemaU32) {
      throw new DataApiError('VERSION_MISMATCH', `${url} does not match meta.json (files from different releases?)`, {
        file: url,
        fileFormat: fmt,
        fileRows: hRows,
        fileSchema: schema,
        metaSchema: m.schemaU32,
      });
    }
    const at = (k) => HEADER_BYTES + rows * 4 * k;
    if (IS_LE) {
      return {
        p16: new Float32Array(buf, at(0), rows),
        p50: new Float32Array(buf, at(1), rows),
        p83: new Float32Array(buf, at(2), rows),
        n: new Uint32Array(buf, at(3), rows),
      };
    }
    const f32 = (k) => Float32Array.from({ length: rows }, (_, i) => dv.getFloat32(at(k) + 4 * i, true)); // big-endian host
    return { p16: f32(0), p50: f32(1), p83: f32(2), n: Uint32Array.from({ length: rows }, (_, i) => dv.getUint32(at(3) + 4 * i, true)) };
  }

  // Promise cache: concurrent callers share one fetch; Map insertion order doubles as LRU order.
  function loadCountry(st, m, iso) {
    const hit = st.cache.get(iso);
    if (hit) {
      st.cache.delete(iso);
      st.cache.set(iso, hit);
      return hit;
    }
    const base = requireBase();
    const p = (async () => decode(m, iso, await request(`${base}data/${iso}.bin`, false)))();
    st.cache.set(iso, p);
    p.catch(() => {
      if (st.cache.get(iso) === p) st.cache.delete(iso); // never cache failures
    });
    trim(st);
    return p;
  }

  function trim(st) {
    while (st.cache.size > cfg.maxCached) st.cache.delete(st.cache.keys().next().value);
  }

  // ---- input normalisation and validation -----------------------------------------------------
  const normSsp = (v) => (/^\d+$/.test(String(v)) ? 'SSP' + v : String(v));
  const normRcp = (v) => {
    const s = String(v);
    if (!/^\d+(\.\d+)?$/.test(s)) return s;
    const n = parseFloat(s);
    return 'rcp' + (n < 10 ? Math.round(n * 10) : n); // 4.5 -> rcp45, 6 -> rcp60, 45 -> rcp45
  };

  function normNum(field, v) {
    if (v === null || v === 'NA') return null;
    const n = typeof v === 'number' ? v : Number(String(v).replace('p', '.')); // '0p7' -> 0.7
    if (!Number.isFinite(n)) throw bad(`Invalid ${field} "${v}"`, { field, value: v });
    return n;
  }

  function sortVals(a) {
    return a.sort((x, y) => (x === null) - (y === null) || x - y); // numbers ascending, null last
  }

  function keyCode(m, field, v) {
    const col = COL_OF[field];
    const s = field === 'ssp' ? normSsp(v) : field === 'rcp' ? normRcp(v) : String(v);
    const c = m.dict[col].indexOf(s);
    if (c < 0) throw bad(`Unknown ${field} "${v}"`, { field, value: v, valid: m.dict[col].slice() });
    return c;
  }

  function checkIso(m, iso3) {
    const iso = typeof iso3 === 'string' ? iso3.trim().toUpperCase() : '';
    if (!m.countrySet.has(iso)) {
      throw new DataApiError('UNKNOWN_ISO3', `Unknown ISO3 code "${iso3}"`, { value: iso3, valid: m.countries.slice() });
    }
    return iso;
  }

  // filter -> { field: Uint8Array mask }. Key fields mask over their own dictionary; dr/prtp/eta mask over discount codes.
  function compile(m, filter) {
    const masks = {};
    if (filter === undefined || filter === null) return masks;
    if (typeof filter !== 'object' || Array.isArray(filter)) throw bad('filter must be an object like { ssp: 2, rcp: [4.5, 6] }');
    for (const key of Object.keys(filter)) {
      if (key === 'n') throw bad('"n" is a result value and cannot be used as a filter', { field: 'n', valid: FIELDS.slice() });
      if (FIELDS.indexOf(key) < 0) throw bad(`Unknown filter field "${key}"`, { field: key, valid: FIELDS.slice() });
      if (filter[key] === undefined) continue;
      const vals = Array.isArray(filter[key]) ? filter[key] : [filter[key]];
      if (!vals.length) throw bad(`Filter "${key}" is an empty array`, { field: key });
      if (DISC.indexOf(key) >= 0) {
        const nums = vals.map((v) => normNum(key, v));
        for (const x of nums) {
          if (m.discValues[key].indexOf(x) < 0) throw bad(`Unknown ${key} "${x}"`, { field: key, value: x, valid: m.discValues[key].slice() });
        }
        const mask = new Uint8Array(m.disc.length);
        m.disc.forEach((d, i) => {
          if (nums.indexOf(d[key]) >= 0) mask[i] = 1;
        });
        masks[key] = mask;
      } else {
        const mask = new Uint8Array(m.dict[COL_OF[key]].length);
        for (const v of vals) mask[keyCode(m, key, v)] = 1;
        masks[key] = mask;
      }
    }
    return masks;
  }

  // Row test on integer codes (AND across fields, OR within a field). `exclude` skips one field's filter.
  function matcher(m, masks, exclude) {
    const tests = [];
    for (const f of KEY5) if (f !== exclude && masks[f]) tests.push([m.codes[COL_OF[f]], masks[f]]);
    let dm = null;
    for (const f of DISC) {
      if (f === exclude || !masks[f]) continue;
      dm = dm ? dm.map((x, i) => x & masks[f][i]) : masks[f];
    }
    if (dm) tests.push([m.codes.discount, dm]);
    return (r) => {
      for (let i = 0; i < tests.length; i++) if (!tests[i][1][tests[i][0][r]]) return false;
      return true;
    };
  }

  const nn = (x) => (x !== x ? null : x);
  function makeRow(m, c, r) {
    const d = m.disc[m.codes.discount[r]];
    return {
      run: m.dict.run[m.codes.run[r]],
      dmgfuncpar: m.dict.dmgfuncpar[m.codes.dmgfuncpar[r]],
      climate: m.dict.climate[m.codes.climate[r]],
      ssp: m.dict.SSP[m.codes.SSP[r]],
      rcp: m.dict.RCP[m.codes.RCP[r]],
      dr: d.dr,
      prtp: d.prtp,
      eta: d.eta,
      p16_7: nn(c.p16[r]),
      p50: nn(c.p50[r]),
      p83_3: nn(c.p83[r]),
      n: c.n[r],
    };
  }

  // ---- public API -----------------------------------------------------------------------------
  async function ready() {
    const m = await loadMeta(state);
    return { dataVersion: m.dataVersion, formatVersion: m.formatVersion, schemaHash: m.schemaHash, rows: m.rows, countries: m.countries.length };
  }

  async function countries() {
    return (await loadMeta(state)).countries.slice();
  }

  /** Values still available per field. Each field is computed with its own filter ignored, so a dropdown can still change it. */
  async function options(filter) {
    const m = await loadMeta(state);
    const masks = compile(m, filter);
    const out = {};
    for (const f of FIELDS) {
      const ok = matcher(m, masks, f);
      if (DISC.indexOf(f) >= 0) {
        const seen = new Set();
        for (let r = 0; r < m.rows; r++) if (ok(r)) seen.add(m.disc[m.codes.discount[r]][f]);
        out[f] = sortVals(Array.from(seen));
      } else {
        const col = COL_OF[f];
        const seen = new Uint8Array(m.dict[col].length);
        for (let r = 0; r < m.rows; r++) if (ok(r)) seen[m.codes[col][r]] = 1;
        out[f] = m.dict[col].filter((_, i) => seen[i]);
      }
    }
    return out;
  }

  /** All rows for a country, optionally narrowed by a filter. Filtering happens in memory; no extra requests. */
  async function getData(iso3, filter) {
    const st = state;
    const m = await loadMeta(st);
    const iso = checkIso(m, iso3);
    const masks = compile(m, filter);
    const c = await loadCountry(st, m, iso);
    const ok = matcher(m, masks, null);
    const out = [];
    for (let r = 0; r < m.rows; r++) if (ok(r)) out.push(makeRow(m, c, r));
    return out;
  }

  /** One exact row: run, dmgfuncpar, climate, ssp, rcp plus either dr, or prtp and eta. Returns null if that combination does not exist. */
  async function get(iso3, key) {
    const st = state;
    const m = await loadMeta(st);
    const iso = checkIso(m, iso3);
    if (!key || typeof key !== 'object' || Array.isArray(key)) throw bad('key must be an object');
    for (const k of Object.keys(key)) {
      if (FIELDS.indexOf(k) < 0) throw bad(`Unknown field "${k}"`, { field: k, valid: FIELDS.slice() });
    }
    for (const f of KEY5) if (key[f] === undefined) throw bad(`${f} is required`, { field: f });
    const part = (f) => (key[f] === undefined ? null : normNum(f, key[f]));
    const dcode = m.discIndex.get(`${part('dr')}|${part('prtp')}|${part('eta')}`);
    if (dcode === undefined) {
      return null;
    }
    let id = dcode * m.mult.discount;
    for (const f of KEY5) id += keyCode(m, f, key[f]) * m.mult[COL_OF[f]];
    const c = await loadCountry(st, m, iso);
    const r = m.lookup[id];
    return r < 0 ? null : makeRow(m, c, r);
  }

  /** Start loading one or more countries (string or array). */
  async function prefetch(iso3) {
    const st = state;
    const m = await loadMeta(st);
    const list = Array.isArray(iso3) ? iso3 : [iso3];
    await Promise.all(list.map((i) => loadCountry(st, m, checkIso(m, i))));
  }

  function configure(opts) {
    if (opts !== undefined) {
      if (!opts || typeof opts !== 'object') throw bad('configure() takes an object');
      const known = ['baseUrl', 'timeoutMs', 'retries', 'maxCached', 'fetch'];
      for (const k of Object.keys(opts)) if (known.indexOf(k) < 0) throw bad(`Unknown option "${k}"`, { valid: known });
      if ('baseUrl' in opts && (typeof opts.baseUrl !== 'string' || !opts.baseUrl)) throw bad('baseUrl must be a non-empty string');
      if ('timeoutMs' in opts && !(opts.timeoutMs >= 0)) throw bad('timeoutMs must be a number >= 0 (0 disables the timeout)');
      if ('retries' in opts && !(Number.isInteger(opts.retries) && opts.retries >= 0 && opts.retries <= 5)) throw bad('retries must be an integer from 0 to 5');
      if ('maxCached' in opts && !(opts.maxCached === Infinity || (Number.isInteger(opts.maxCached) && opts.maxCached >= 1))) throw bad('maxCached must be an integer >= 1 or Infinity');
      if ('fetch' in opts && opts.fetch !== null && typeof opts.fetch !== 'function') throw bad('fetch must be a function or null');
      for (const k of ['timeoutMs', 'retries', 'maxCached', 'fetch']) if (k in opts) cfg[k] = opts[k];
      if ('baseUrl' in opts) {
        const nb = withSlash(opts.baseUrl);
        if (nb !== cfg.baseUrl) {
          cfg.baseUrl = nb;
          state = newState(); // different release: drop everything loaded from the old one
        }
      }
      trim(state);
    }
    return { baseUrl: cfg.baseUrl, timeoutMs: cfg.timeoutMs, retries: cfg.retries, maxCached: cfg.maxCached };
  }

  function clearCache() {
    state = newState();
  }

  const api = Object.freeze({
    version: LIB_VERSION,
    ready,
    countries,
    options,
    getData,
    get,
    prefetch,
    configure,
    clearCache,
    DataApiError,
    ERROR_CODES,
  });

  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.DataAPI = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this);
