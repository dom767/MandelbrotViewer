/**
 * Cross-algorithm probe comparison.
 *
 *   node js/test/run.js
 *   node js/test/run.js --band=f32-edge
 *   node js/test/run.js --json
 *
 * Ground truth: cpuRef (BigInt fixed-point). Reports abs smooth-iter error and
 * interior/exterior mismatches per algorithm and band.
 */

import { allProbes, BANDS } from "./probes.js";
import { ALGOS } from "./samples.js";

const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const bandArg = args.find((a) => a.startsWith("--band="));
const bandFilter = bandArg ? bandArg.slice("--band=".length) : null;

const COMPARE = ALGOS.filter((a) => a.id !== "cpuRef");
const REF = ALGOS.find((a) => a.id === "cpuRef");

function err(ref, val) {
  if (ref < 0 && val < 0) return { kind: "bothInterior", abs: 0 };
  if (ref < 0 || val < 0) return { kind: "mismatch", abs: Infinity };
  return { kind: "ok", abs: Math.abs(ref - val) };
}

function pct(n, d) {
  return d ? ((100 * n) / d).toFixed(1) + "%" : "—";
}

function fmt(n) {
  if (!Number.isFinite(n)) return "inf";
  if (n === 0) return "0";
  if (n < 1e-3 || n >= 1e3) return n.toExponential(2);
  return n.toFixed(4);
}

function run() {
  let probes = allProbes();
  if (bandFilter) {
    probes = probes.filter((p) => p.band === bandFilter);
    if (!probes.length) {
      console.error(`Unknown band "${bandFilter}". Known: ${BANDS.map((b) => b.id).join(", ")}`);
      process.exit(1);
    }
  }

  /** @type {Record<string, any>} */
  const perBand = {};
  for (const b of BANDS) {
    if (bandFilter && b.id !== bandFilter) continue;
    perBand[b.id] = {
      label: b.label,
      n: 0,
      algos: Object.fromEntries(
        COMPARE.map((a) => [
          a.id,
          { maxAbs: 0, sumAbs: 0, mismatch: 0, ok: 0 },
        ])
      ),
    };
  }

  /** @type {object[]} */
  const rows = [];

  for (const p of probes) {
    const refVal = REF.sample(p);
    const band = perBand[p.band];
    band.n += 1;

    const row = {
      id: p.id,
      band: p.band,
      cx: p.cx,
      cy: p.cy,
      maxIter: p.maxIter,
      cpuRef: refVal,
      results: {},
    };

    for (const algo of COMPARE) {
      const val = algo.sample(p);
      const e = err(refVal, val);
      const st = band.algos[algo.id];
      if (e.kind === "mismatch") {
        st.mismatch += 1;
      } else {
        st.ok += 1;
        st.sumAbs += e.abs;
        st.maxAbs = Math.max(st.maxAbs, e.abs);
      }
      row.results[algo.id] = { value: val, absErr: e.abs, kind: e.kind };
    }
    rows.push(row);
  }

  if (jsonOut) {
    console.log(JSON.stringify({ bands: perBand, rows }, null, 2));
    return;
  }

  console.log("Mandelbrot algorithm probe comparison");
  console.log(`Ground truth: cpuRef | probes: ${probes.length}\n`);

  for (const b of BANDS) {
    if (bandFilter && b.id !== bandFilter) continue;
    const st = perBand[b.id];
    const meta = BANDS.find((x) => x.id === b.id);
    console.log(`══ ${b.id} — ${st.label}`);
    console.log(
      `   center=(${meta.centerX}, ${meta.centerY})  scale=${meta.scale}  maxIter=${meta.maxIter}  n=${st.n}`
    );
    console.log(
      "   " +
        "algo".padEnd(14) +
        "mismatch".padStart(10) +
        "mean|err|".padStart(12) +
        "max|err|".padStart(12)
    );
    for (const algo of COMPARE) {
      const a = st.algos[algo.id];
      const mean = a.ok ? a.sumAbs / a.ok : 0;
      console.log(
        "   " +
          algo.id.padEnd(14) +
          `${a.mismatch}/${st.n}`.padStart(10) +
          fmt(mean).padStart(12) +
          fmt(a.maxAbs).padStart(12)
      );
    }
    console.log("");
  }

  // Flag worst mismatches for debugging
  const bad = rows.filter((r) =>
    COMPARE.some((a) => r.results[a.id].kind === "mismatch")
  );
  if (bad.length) {
    console.log(`Interior/exterior mismatches: ${bad.length} probe(s)`);
    for (const r of bad.slice(0, 12)) {
      const parts = COMPARE.filter((a) => r.results[a.id].kind === "mismatch")
        .map((a) => `${a.id}=${fmt(r.results[a.id].value)}`)
        .join(" ");
      console.log(
        `  ${r.id}  ref=${fmt(r.cpuRef)}  ${parts}  c=${r.cx} + ${r.cy}i`
      );
    }
    if (bad.length > 12) console.log(`  … +${bad.length - 12} more`);
  } else {
    console.log("No interior/exterior mismatches against cpuRef.");
  }

  // Exit non-zero if overview/medium have fp32/cpuF64 mismatches (sanity)
  const sanityBands = ["overview", "medium"];
  let failed = false;
  for (const id of sanityBands) {
    if (bandFilter && bandFilter !== id) continue;
    const st = perBand[id];
    if (!st) continue;
    for (const algoId of ["cpuF64", "fp32", "floatFloat"]) {
      if (st.algos[algoId]?.mismatch > 0) {
        console.error(
          `\nSanity fail: ${algoId} mismatches on ${id} (${st.algos[algoId].mismatch})`
        );
        failed = true;
      }
    }
  }
  if (failed) process.exit(2);
}

run();
