#!/usr/bin/env python3
"""
build_cscc.py - convert cscc_db_v2.csv into the static-API release format (stage 2).

Release layout (immutable once published):
    <out>/latest.json                 {"latest": "<version>", ...}  <- the only mutable file
    <out>/<version>/meta.json         shared key table, dictionaries, countries, schema hash
    <out>/<version>/manifest.json     size + sha256 of every file in the release (for deploy checks / SRI)
    <out>/<version>/data/<ISO3>.bin   one file per country

Each .bin file (little-endian), rows = rows per country:
    16-byte header: "CSCC" | u16 formatVersion | u16 reserved(0) | u32 rows | u32 schemaHash[:4 bytes]
    float32[rows]  16.7%   (NaN = NA)
    float32[rows]  50%     (NaN = NA, never occurs in this data set)
    float32[rows]  83.3%   (NaN = NA)
    uint32 [rows]  N

Key columns: run, dmgfuncpar, climate, SSP, RCP, discount. "discount" merges dr / prtp / eta into one
label (dr3, dr5, prtp1_eta0p7, ...). Every country has the same keys in the same order (N is excluded:
it is a per-country result value, not a key), so keys are stored once in meta.json.

Validation (any failure aborts with a non-zero exit code and leaves nothing half-published):
  1. totals: rows, countries, rows per country match the expected numbers
  2. every row uses either dr, or prtp+eta (never both, never partial); ISO3 codes well-formed
  3. key table identical across all countries, no duplicate keys
  4. NA counts per column and per country match between the CSV and the decoded files
  5. round-trip: files are re-read from disk with an independent decoder (header checked), and every
     decoded value must equal float32(source value) exactly; N must match exactly
  6. discount label -> (dr, prtp, eta) mapping reproduces every source row
  7. manifest hashes match the files on disk

The build is deterministic (no timestamps): the same CSV gives byte-identical output.
An existing release folder is never overwritten unless --force is given.

Usage:
    python3 build_cscc.py --csv cscc_db_v2.csv --out site --version v1
Requires: pandas, numpy
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import struct
import sys

import numpy as np
import pandas as pd

FORMAT_VERSION = 1
MAGIC = b"CSCC"
HEADER_FMT = "<4sHHII"  # magic, formatVersion, reserved, rows, schemaHash32
HEADER_BYTES = struct.calcsize(HEADER_FMT)  # 16
KEY_COLS = ["run", "dmgfuncpar", "climate", "SSP", "RCP", "discount"]
PCT_COLS = ["16.7%", "50%", "83.3%"]
VALUE_ORDER = ["p16_7", "p50", "p83_3", "n"]
REQUIRED_COLS = ["run", "dmgfuncpar", "climate", "SSP", "RCP", "N", "ISO3", "prtp", "eta", "dr"] + PCT_COLS


def fail(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def expect(name, actual, wanted):
    if actual != wanted:
        fail(f"{name}: got {actual}, expected {wanted}")


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def to_float(series):
    """'NA' -> NaN, anything else -> float64. Raises on unparseable text; rejects inf."""
    cleaned = series.where(series != "NA")
    parsed = pd.to_numeric(cleaned, errors="coerce")
    bad = cleaned.notna() & parsed.isna()
    if bad.any():
        fail(f"{int(bad.sum())} unparseable value(s) in column '{series.name}', first: {cleaned[bad].iloc[0]!r}")
    out = parsed.to_numpy(dtype="float64")
    if np.isinf(out).any():
        fail("infinite value in data")
    return out


def token_to_number(tok):
    """'NA' -> None, '3' -> 3, '0p7' -> 0.7"""
    if tok == "NA":
        return None
    x = float(tok.replace("p", "."))
    return int(x) if x.is_integer() else x


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", default="cscc_db_v2.csv")
    ap.add_argument("--out", default="site")
    ap.add_argument("--version", default="v1", help="release folder name, e.g. v1 or v1.1.0")
    ap.add_argument("--expect-rows", type=int, default=247860, help="total CSV rows (change for new data versions)")
    ap.add_argument("--expect-countries", type=int, default=170)
    ap.add_argument("--expect-per-country", type=int, default=1458)
    ap.add_argument("--force", action="store_true", help="overwrite an existing release folder")
    ap.add_argument("--no-latest", action="store_true", help="do not update latest.json")
    args = ap.parse_args()

    if not re.fullmatch(r"[A-Za-z0-9._-]+", args.version):
        fail("version may only contain letters, digits, '.', '_' and '-'")
    out_dir = os.path.join(args.out, args.version)
    if os.path.exists(out_dir) and not args.force:
        fail(f"{out_dir} already exists; releases are immutable. Use a new --version, or --force to overwrite.")

    # ---- read -------------------------------------------------------------------------------------
    df = pd.read_csv(args.csv, dtype=str, keep_default_na=False)
    missing = [c for c in REQUIRED_COLS if c not in df.columns]
    if missing:
        fail(f"missing columns: {missing}")
    src_rows = len(df)
    countries = sorted(df["ISO3"].unique())
    print(f"read {src_rows} rows, {len(countries)} countries")

    # ---- check 1 and 2: totals and row shape ------------------------------------------------------
    expect("total rows", src_rows, args.expect_rows)
    expect("country count", len(countries), args.expect_countries)
    bad_iso = [c for c in countries if not re.fullmatch(r"[A-Z]{3}", c)]
    if bad_iso:
        fail(f"malformed ISO3 codes: {bad_iso}")
    per_country = df.groupby("ISO3").size()
    off = per_country[per_country != args.expect_per_country]
    if len(off):
        fail(f"countries without exactly {args.expect_per_country} rows: {off.to_dict()}")

    dr_na, prtp_na, eta_na = df["dr"] == "NA", df["prtp"] == "NA", df["eta"] == "NA"
    valid_dr = (~dr_na) & prtp_na & eta_na
    valid_pe = dr_na & (~prtp_na) & (~eta_na)
    if not (valid_dr | valid_pe).all():
        fail(f"{int((~(valid_dr | valid_pe)).sum())} rows use neither dr alone nor prtp+eta together")
    df["discount"] = np.where(valid_dr, "dr" + df["dr"], "prtp" + df["prtp"] + "_eta" + df["eta"])

    # ---- dictionaries, codes, canonical row order -------------------------------------------------
    dicts = {c: sorted(df[c].unique()) for c in KEY_COLS}
    for c, d in dicts.items():
        if len(d) > 255:
            fail(f"{c} has {len(d)} values; does not fit in uint8")
    code = {c: df[c].map({v: i for i, v in enumerate(dicts[c])}).to_numpy(dtype=np.int64) for c in KEY_COLS}
    mult, m = {}, 1
    for c in reversed(KEY_COLS):
        mult[c] = m
        m *= len(dicts[c])
    df["_key_id"] = sum(code[c] * mult[c] for c in KEY_COLS)

    # ---- check 3: identical key table across countries --------------------------------------------
    ref_iso = countries[0]
    ref = df[df["ISO3"] == ref_iso].sort_values("_key_id")
    ref_ids = ref["_key_id"].to_numpy()
    rows = len(ref)
    if len(np.unique(ref_ids)) != rows:
        fail(f"{ref_iso} has duplicate keys")
    for iso in countries[1:]:
        ids = np.sort(df.loc[df["ISO3"] == iso, "_key_id"].to_numpy())
        if not np.array_equal(ids, ref_ids):
            fail(f"{iso} does not have the same key table as {ref_iso}")
    print(f"key table identical across all {len(countries)} countries ({rows} unique keys)")

    # ---- discount label -> (dr, prtp, eta), verified against every source row (check 6) -----------
    discount_detail = {}
    for lab in dicts["discount"]:
        first = df[df["discount"] == lab].iloc[0]
        discount_detail[lab] = {
            "dr": token_to_number(first["dr"]),
            "prtp": token_to_number(first["prtp"]),
            "eta": token_to_number(first["eta"]),
        }
    for col in ("dr", "prtp", "eta"):
        want = [discount_detail[lab][col] for lab in df["discount"]]
        got = [token_to_number(t) for t in df[col]]
        if want != got:
            fail(f"discount mapping does not reproduce column {col}")
    print(f"discount labels: {', '.join(dicts['discount'])}")

    # ---- schema hash: covers everything the .bin layout depends on --------------------------------
    keys_json = {c: code[c][ref.index.to_numpy()].tolist() for c in KEY_COLS}
    layout = {
        "headerBytes": HEADER_BYTES,
        "order": VALUE_ORDER,
        "types": ["float32", "float32", "float32", "uint32"],
        "bytesPerFile": HEADER_BYTES + rows * 16,
        "endianness": "little",
        "na": "NaN in the three float columns",
    }
    schema_core = {"formatVersion": FORMAT_VERSION, "rows": rows, "dict": dicts, "keys": keys_json, "layout": layout}
    schema_hash = sha256_bytes(json.dumps(schema_core, sort_keys=True, separators=(",", ":")).encode())
    schema_u32 = int(schema_hash[:8], 16)
    header = struct.pack(HEADER_FMT, MAGIC, FORMAT_VERSION, 0, rows, schema_u32)

    # ---- write ------------------------------------------------------------------------------------
    if os.path.exists(out_dir):
        shutil.rmtree(out_dir)
    os.makedirs(os.path.join(out_dir, "data"))

    expected32 = {}  # iso -> (3 x float32 array, N int64 array, NaN counts)
    for iso in countries:
        g = df[df["ISO3"] == iso].sort_values("_key_id")
        vals64 = np.stack([to_float(g[c]) for c in PCT_COLS])
        n_src = g["N"].astype("int64").to_numpy()
        if n_src.min() < 0 or n_src.max() >= 2**32:
            fail(f"{iso}: N outside uint32 range")
        v32 = vals64.astype("<f4")
        blob = header + v32.tobytes() + n_src.astype("<u4").tobytes()
        with open(os.path.join(out_dir, "data", f"{iso}.bin"), "wb") as f:
            f.write(blob)
        expected32[iso] = (v32, vals64, n_src, [(g[c] == "NA").sum() for c in PCT_COLS])

    meta = {
        "formatVersion": FORMAT_VERSION,
        "dataVersion": args.version,
        "rows": rows,
        "countries": countries,
        "dict": dicts,
        "keys": keys_json,
        "discountDetail": discount_detail,
        "layout": layout,
        "schemaHash": schema_hash,
        "source": {"file": os.path.basename(args.csv), "rows": src_rows, "sha256": sha256_file(args.csv)},
    }
    with open(os.path.join(out_dir, "meta.json"), "w") as f:
        json.dump(meta, f, separators=(",", ":"))

    # ---- check 4 and 5: decode from disk with an independent reader -------------------------------
    max_rel = 0.0
    nan_total = [0, 0, 0]
    for iso in countries:
        path = os.path.join(out_dir, "data", f"{iso}.bin")
        with open(path, "rb") as f:
            raw = f.read()
        expect(f"{iso}: file size", len(raw), layout["bytesPerFile"])
        magic, fmt, reserved, n_rows, h32 = struct.unpack_from(HEADER_FMT, raw, 0)
        expect(f"{iso}: magic", magic, MAGIC)
        expect(f"{iso}: format version", fmt, FORMAT_VERSION)
        expect(f"{iso}: header rows", n_rows, rows)
        expect(f"{iso}: header schema hash", h32, schema_u32)
        dec = np.frombuffer(raw, dtype="<f4", count=rows * 3, offset=HEADER_BYTES).reshape(3, rows)
        dec_n = np.frombuffer(raw, dtype="<u4", count=rows, offset=HEADER_BYTES + rows * 12)
        v32, vals64, n_src, na_src = expected32[iso]
        if not np.array_equal(dec, v32, equal_nan=True):
            fail(f"{iso}: decoded values differ from float32(source)")
        if not np.array_equal(dec_n.astype("int64"), n_src):
            fail(f"{iso}: N did not round-trip")
        for k in range(3):
            expect(f"{iso}: NA count in {PCT_COLS[k]}", int(np.isnan(dec[k]).sum()), int(na_src[k]))
            nan_total[k] += int(na_src[k])
            ok = ~np.isnan(vals64[k])
            s, d = vals64[k][ok], dec[k][ok].astype("float64")
            nz = s != 0
            if (d[~nz] != 0).any():
                fail(f"{iso}: a zero changed in {PCT_COLS[k]}")
            if nz.any():
                max_rel = max(max_rel, float((np.abs(d[nz] - s[nz]) / np.abs(s[nz])).max()))
    for k, c in enumerate(PCT_COLS):
        expect(f"total NA count in {c}", nan_total[k], int((df[c] == "NA").sum()))

    # ---- manifest (check 7) -----------------------------------------------------------------------
    files = {}
    for root, _, names in os.walk(out_dir):
        for name in sorted(names):
            p = os.path.join(root, name)
            files[os.path.relpath(p, out_dir).replace(os.sep, "/")] = {"bytes": os.path.getsize(p), "sha256": sha256_file(p)}
    manifest = {"dataVersion": args.version, "formatVersion": FORMAT_VERSION, "schemaHash": schema_hash,
                "files": dict(sorted(files.items()))}
    with open(os.path.join(out_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    for rel, info in manifest["files"].items():
        if sha256_file(os.path.join(out_dir, rel)) != info["sha256"]:
            fail(f"manifest hash mismatch for {rel}")

    if not args.no_latest:
        with open(os.path.join(args.out, "latest.json"), "w") as f:
            json.dump({"latest": args.version, "formatVersion": FORMAT_VERSION, "schemaHash": schema_hash}, f)

    total_bytes = sum(i["bytes"] for i in manifest["files"].values())
    print(f"wrote {len(countries)} country files ({layout['bytesPerFile'] / 1024:.1f} KB each) "
          f"+ meta.json ({files['meta.json']['bytes'] / 1024:.1f} KB) + manifest.json")
    print(f"total rows written: {len(countries) * rows} (source {src_rows})")
    print(f"NA cells preserved per column: " + ", ".join(f"{c}={n}" for c, n in zip(PCT_COLS, nan_total)))
    print(f"max relative error vs source (float32): {max_rel:.2e}")
    print(f"schema hash: {schema_hash[:16]}...")
    print(f"release size: {total_bytes / 1048576:.2f} MB -> {out_dir}")
    print("ALL VALIDATION CHECKS PASSED")


if __name__ == "__main__":
    main()
