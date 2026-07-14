#!/usr/bin/env node
"use strict";

/**
 * TEE Build: real build executed inside the TEE enclave.
 *
 * Mirrors vanilla_build.sh: load_deps → compute_source_root → build →
 * run_tests → package_artifact → compute_artifact_hash.
 *
 * Inputs (env-overridable):
 *   REPO_DIR    root of the source checkout (must contain app/)  (default: "repo")
 *   OUT_DIR     output volume for build artifacts                 (default: "tee-build")
 *   S3_OUT_DIR  directory to write S3-bound outputs               (default: "s3-output")
 *   VCPKG_ROOT  optional — enables vcpkg toolchain flags to cmake
 *
 * Outputs:
 *   OUT_DIR/build_log.json
 *   OUT_DIR/final_build_summary.json
 *   OUT_DIR/dist/demo-hasher-linux-x64.tar.gz
 *   OUT_DIR/dist/artifact_hash.txt
 *   OUT_DIR/dist/used_deps.json
 *   OUT_DIR/dist/used_deps_root.txt
 *   OUT_DIR/pvt-witness/f_source_witness.json
 *   OUT_DIR/pvt-witness/f_artifact_witness.json
 *   OUT_DIR/pvt-witness/f_build_witness.json
 *   OUT_DIR/pvt-witness/f_test_witness.json
 *   S3_OUT_DIR/build/tee_report.json
 *   S3_OUT_DIR/build/build_log.json
 *   S3_OUT_DIR/build/final_build_summary.json
 *   S3_OUT_DIR/dist/demo-hasher-linux-x64.tar.gz
 */

const crypto        = require("crypto");
const fs            = require("fs");
const path          = require("path");
const { spawnSync } = require("child_process");
const { buildPoseidon } = require("circomlibjs");

// Shared witness parameters — must match MAX_LOG_CHUNKS / CHUNK_SIZE_BYTES in all circuits
const MAX_LOG_CHUNKS   = 16;
const CHUNK_SIZE_BYTES = 31;

function textToFieldChunks(text, maxChunks) {
  const buf    = Buffer.from(text, "utf8");
  const chunks = [];
  for (let i = 0; i < buf.length; i += CHUNK_SIZE_BYTES) {
    const chunk = buf.slice(i, i + CHUNK_SIZE_BYTES);
    const hex   = chunk.toString("hex") || "00";
    chunks.push(BigInt("0x" + hex).toString());
  }
  if (chunks.length > maxChunks) {
    throw new Error(
      `Build/Test log too large: ${chunks.length} chunks, max is ${maxChunks}.`,
    );
  }
  while (chunks.length < maxChunks) chunks.push("0");
  return chunks;
}

async function poseidonChainedHash(poseidon, F, chunks, exit1, exit2, exit3) {
  if (chunks.length < 2) throw new Error("Need at least 2 chunks");
  let acc = F.toString(poseidon([chunks[0], chunks[1]]));
  for (let i = 2; i < chunks.length; i++) {
    acc = F.toString(poseidon([acc, chunks[i]]));
  }
  return F.toString(poseidon([acc, exit1, exit2, exit3]));
}

const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function randomFieldElement() {
  let r;
  do {
    r = BigInt("0x" + crypto.randomBytes(32).toString("hex")) % FIELD_PRIME;
  } while (r === 0n);
  return r;
}

// Matches encodeToField in register_declared_deps.js exactly.
function encodeToField(s) {
  let acc = 0n;
  for (let i = 0; i < s.length; i++) {
    acc = acc * 257n + BigInt(s.charCodeAt(i));
  }
  return acc % FIELD_PRIME;
}

// Leaf = Poseidon(encode(name), encode(version)) — matches register_declared_deps.js.
function depLeaf(poseidon, dep) {
  return poseidon.F.toObject(poseidon([encodeToField(dep.name), encodeToField(dep.version)]));
}

// Poseidon over an 8-leaf array in a fixed depth-3 binary tree,
// matching UsedDepsRoot8() in used_deps_root.circom exactly.
function computeUsedDepsRoot(poseidon, leaves8) {
  const F = poseidon.F;
  const ph = (a, b) => F.toObject(poseidon([a, b]));
  const level1 = [
    ph(leaves8[0], leaves8[1]),
    ph(leaves8[2], leaves8[3]),
    ph(leaves8[4], leaves8[5]),
    ph(leaves8[6], leaves8[7]),
  ];
  const level2 = [
    ph(level1[0], level1[1]),
    ph(level1[2], level1[3]),
  ];
  return ph(level2[0], level2[1]);
}

async function phaseComputeUsedDepsWitness(depsSorted) {
  const poseidon = await buildPoseidon();
  const F        = poseidon.F;

  const leafBigInts = depsSorted.map(d => depLeaf(poseidon, d));

  // Pad to 8 with zeros (matches circuit MAX_DEPS = 8).
  const padded = [...leafBigInts];
  while (padded.length < 8) padded.push(0n);

  const used_deps_count = depsSorted.length;

  const used_deps_root_poseidon = computeUsedDepsRoot(poseidon, padded);
  const r2                      = randomFieldElement();
  const used_deps_commitment    = F.toObject(poseidon([used_deps_root_poseidon, r2])).toString();

  return {
    used_deps_root_poseidon: used_deps_root_poseidon.toString(),
    r2:                      r2.toString(),
    used_deps_commitment,
    used_deps_count:         used_deps_count.toString(),
    used_deps:               leafBigInts.map(x => x.toString()),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function H(...items) {
  return crypto.createHash("sha256").update(items.join("|")).digest("hex");
}

function fileHash(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function merkleRoot(leaves, { sort = true } = {}) {
  let level = sort ? [...leaves].sort() : [...leaves];
  if (level.length === 0) return H("EMPTY");
  while (level.length > 1) {
    const nxt = [];
    for (let i = 0; i < level.length; i += 2) {
      const left  = level[i];
      const right = i + 1 < level.length ? level[i + 1] : left;
      nxt.push(H(left, right));
    }
    level = nxt;
  }
  return level[0];
}

function walkFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkFiles(full));
    else if (entry.isFile()) results.push(full);
  }
  return results;
}

// Run a subprocess and return { exitCode, output } where output combines
// stdout + stderr in the order they appear (both piped, not interleaved live).
function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    encoding:  "utf8",
    maxBuffer: 50 * 1024 * 1024,
    ...opts,
  });
  const stdout = (result.stdout || "").trim();
  const stderr = (result.stderr || "").trim();
  const output = [stdout, stderr].filter(Boolean).join("\n");
  return {
    exitCode: result.status ?? 1,
    output,
    spawnError: result.error,
  };
}

// ---------------------------------------------------------------------------
// Phase 1: load_deps  (mirrors load_deps.sh)
// Dep install is still simulated ("In real pipeline, vcpkg install happens here").
// Merkle root computation is real.
// ---------------------------------------------------------------------------

const USED_DEPS = [
  { name: "catch2",        version: "3.5.2"  },
  { name: "fmt",           version: "10.2.1" },
  { name: "nlohmann-json", version: "3.11.3" },
  { name: "openssl",       version: "3.2.1"  },
];

function phaseLoadDeps(distDir) {
  const log = [
    "[LOAD_DEPS] Starting dependency loading",
    "[LOAD_DEPS] Reading vcpkg.json",
    "[LOAD_DEPS] Raw log: resolving fmt, nlohmann-json, openssl, catch2",
    "[LOAD_DEPS] In real pipeline, vcpkg install happens here",
    "[LOAD_DEPS] Completed",
  ];

  const depsSorted   = [...USED_DEPS].sort((a, b) => a.name.localeCompare(b.name));
  const leaves       = depsSorted.map(d => H("dep", d.name, d.version));
  const usedDepsRoot = merkleRoot(leaves, { sort: false });

  fs.writeFileSync(
    path.join(distDir, "used_deps.json"),
    JSON.stringify({ used_dependencies: depsSorted }, null, 2) + "\n",
  );
  fs.writeFileSync(path.join(distDir, "used_deps_root.txt"), usedDepsRoot + "\n");

  return {
    stage:          "LOAD_DEPS",
    status:         "success",
    exit_code:      0,
    timestamp:      new Date().toISOString(),
    used_deps:      depsSorted,
    used_deps_root: usedDepsRoot,
    log,
  };
}

// ---------------------------------------------------------------------------
// Phase 2: compute_source_root  (mirrors compute_source_root.sh)
// ---------------------------------------------------------------------------

const SOURCE_EXCLUDED_DIRS = new Set([
  "build", "dist", "logs", "vcpkg_installed", ".vcpkg", "commitments", "policy_register",
]);

async function phaseComputeSourceRoot(appRoot) {
  if (!fs.existsSync(appRoot)) {
    throw new Error(`tee_build: app source dir not found: ${appRoot}`);
  }

  const entries = walkFiles(appRoot)
    .filter(p => {
      const topDir = path.relative(appRoot, p).split(path.sep)[0];
      return !SOURCE_EXCLUDED_DIRS.has(topDir) && path.basename(p) !== ".DS_Store";
    })
    .map(p => [path.relative(appRoot, p), fileHash(p)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const leaves         = entries.map(([rel, fh]) => H(rel, fh));
  const usedSourceRoot = merkleRoot(leaves, { sort: false });

  const poseidon = await buildPoseidon();
  const F        = poseidon.F;
  const used_source_root_poseidon = BigInt("0x" + usedSourceRoot) % FIELD_PRIME;
  const r2                        = randomFieldElement();
  const used_source_commitment    = F.toString(poseidon([used_source_root_poseidon, r2]));

  return {
    stage:                     "COMPUTE_SOURCE_ROOT",
    status:                    "success",
    exit_code:                 0,
    timestamp:                 new Date().toISOString(),
    used_source_root:          usedSourceRoot,
    used_source_root_poseidon: used_source_root_poseidon.toString(),
    r2:                        r2.toString(),
    used_source_commitment,
    source_files_hashed:       entries.length,
    log: [
      "[SOURCE_ROOT] Computing Merkle root over app/ source tree",
      `[SOURCE_ROOT] ${entries.length} files hashed`,
      `[SOURCE_ROOT] used_source_root=${usedSourceRoot}`,
      `[SOURCE_ROOT] used_source_root_poseidon=${used_source_root_poseidon}`,
      `[SOURCE_ROOT] used_source_commitment=${used_source_commitment}`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Phase 3: build  (mirrors build.sh — configure then compile)
// ---------------------------------------------------------------------------

function phaseBuild(appRoot, buildDir) {
  const ts = new Date().toISOString();

  // Flags for f_build witness: set true when each stage completes successfully.
  let stage1_configure_ok = false;
  let stage2_compile_ok   = false;
  // stage3 = overall build success (both stages above combined)

  // --- Configure ---
  const cmakeConfigArgs = [
    "-S", appRoot,
    "-B", buildDir,
    "-DCMAKE_BUILD_TYPE=Release",
  ];
  const vcpkgLog = process.env.VCPKG_ROOT
    ? `[CONFIGURE_BUILD] VCPKG_ROOT detected: ${process.env.VCPKG_ROOT}`
    : "[CONFIGURE_BUILD] VCPKG_ROOT not set; expecting system packages or preconfigured toolchain";

  let vcpkg_fetch_ms = 0;

  if (process.env.VCPKG_ROOT) {
    const installedDir = process.env.VCPKG_INSTALLED_DIR || path.join(appRoot, "vcpkg_installed");
    cmakeConfigArgs.push(
      `-DCMAKE_TOOLCHAIN_FILE=${process.env.VCPKG_ROOT}/scripts/buildsystems/vcpkg.cmake`,
      `-DVCPKG_MANIFEST_DIR=${appRoot}`,
      `-DVCPKG_INSTALLED_DIR=${installedDir}`,
    );

    // Run vcpkg install explicitly and time it so the caller can subtract
    // the registry fetch (network I/O) from the pure build time.
    const vcpkgStart = Date.now();
    run(
      `${process.env.VCPKG_ROOT}/vcpkg`,
      ["install", `--x-manifest-root=${appRoot}`, `--x-install-root=${installedDir}`],
      { env: process.env },
    );
    vcpkg_fetch_ms = Date.now() - vcpkgStart;
  }

  const configureLog = [
    "[CONFIGURE_BUILD] Starting CMake configure",
    "[CONFIGURE_BUILD] Raw text: generating build files",
    "[CONFIGURE_BUILD] Using CMAKE_BUILD_TYPE=Release",
    vcpkgLog,
  ];

  const configureResult = run("cmake", cmakeConfigArgs, { env: { ...process.env, SOURCE_DATE_EPOCH: "0" } });
  configureLog.push(...configureResult.output.split("\n").filter(Boolean));
  configureLog.push(`[CONFIGURE_BUILD] cmake exit_code=${configureResult.exitCode}`);

  if (configureResult.exitCode === 0) {
    stage1_configure_ok = true;
    configureLog.push("[CONFIGURE_BUILD] stage1_configure_ok=true");
  }

  if (configureResult.exitCode !== 0) {
    const stage3_overall_ok = false;
    return {
      stage:     "BUILD",
      status:    "failure",
      exit_code: configureResult.exitCode,
      stage1_configure_ok,
      stage2_compile_ok,
      stage3_overall_ok,
      vcpkg_fetch_ms,
      configure: {
        stage: "CONFIGURE_BUILD", status: "failure",
        exit_code: configureResult.exitCode, cmake_build_type: "Release",
        timestamp: ts, log: configureLog,
      },
      compile: {
        stage: "COMPILE_BUILD", status: "skipped", exit_code: null,
        timestamp: ts, log: ["[COMPILE_BUILD] Skipped due to configure failure"],
      },
    };
  }

  // --- Compile ---
  const compileLog = [
    "[COMPILE_BUILD] Starting compile",
  ];

  const compileResult = run("cmake", ["--build", buildDir, "--config", "Release"], { env: { ...process.env, SOURCE_DATE_EPOCH: "0" } });
  compileLog.push(...compileResult.output.split("\n").filter(Boolean));
  compileLog.push(`[COMPILE_BUILD] cmake --build exit_code=${compileResult.exitCode}`);
  if (compileResult.exitCode === 0) {
    stage2_compile_ok = true;
    compileLog.push("[COMPILE_BUILD] stage2_compile_ok=true");
    compileLog.push(`[COMPILE_BUILD] binary: ${path.join(buildDir, "demo-hasher")}`);
  }

  const stage3_overall_ok = stage1_configure_ok && stage2_compile_ok;
  if (stage3_overall_ok) {
    compileLog.push("[COMPILE_BUILD] stage3_overall_ok=true");
  }

  const status = compileResult.exitCode === 0 ? "success" : "failure";
  return {
    stage:     "BUILD",
    status,
    exit_code: compileResult.exitCode,
    stage1_configure_ok,
    stage2_compile_ok,
    stage3_overall_ok,
    vcpkg_fetch_ms,
    configure: {
      stage: "CONFIGURE_BUILD", status: "success", exit_code: 0,
      cmake_build_type: "Release", timestamp: ts, log: configureLog,
    },
    compile: {
      stage:     "COMPILE_BUILD",
      status,
      exit_code: compileResult.exitCode,
      timestamp: ts,
      binary:    compileResult.exitCode === 0 ? path.join(buildDir, "demo-hasher") : null,
      log:       compileLog,
    },
  };
}

// ---------------------------------------------------------------------------
// Phase 4: run_tests  (mirrors run_tests.sh — ctest)
// ---------------------------------------------------------------------------

function phaseRunTests(buildDir) {
  const log = [
    "[TEST] Starting tests",
  ];

  const result = run("ctest", ["--test-dir", buildDir, "--output-on-failure"]);
  log.push(...result.output.split("\n").filter(Boolean));
  log.push(`[TEST] ctest exit_code=${result.exitCode}`);

  // Parse CTest summary: "X% tests passed, Y tests failed out of Z"
  const m = result.output.match(/(\d+)% tests passed,\s+(\d+) tests? failed out of (\d+)/);
  let tests_expected = 0, tests_passed = 0, tests_failed = 0;
  if (m) {
    tests_expected = parseInt(m[3], 10);
    tests_failed   = parseInt(m[2], 10);
    tests_passed   = tests_expected - tests_failed;
  }
  log.push(`[TEST] ${tests_passed}/${tests_expected} tests passed`);

  return {
    stage:          "TEST",
    status:         result.exitCode === 0 ? "success" : "failure",
    exit_code:      result.exitCode,
    timestamp:      new Date().toISOString(),
    tests_expected,
    tests_passed,
    tests_failed,
    log,
  };
}

// ---------------------------------------------------------------------------
// Phase 5: package_artifact  (mirrors package_artifact.sh)
// ---------------------------------------------------------------------------

function findGNUTar() {
  for (const t of ["tar", "gtar"]) {
    const r = run(t, ["--version"]);
    if (r.exitCode === 0 && r.output.includes("GNU")) return t;
  }
  return "tar";
}

function phasePackageArtifact(buildDir, distDir, usedDepsRoot) {
  const log = [
    "[PACKAGE_ARTIFACT] Starting package",
    "[PACKAGE_ARTIFACT] Raw text: copying binary and metadata",
  ];

  // Locate binary — single-config (Linux) or multi-config (Windows/MSVC)
  let binaryPath = path.join(buildDir, "demo-hasher");
  if (!fs.existsSync(binaryPath)) {
    const alt = path.join(buildDir, "Release", "demo-hasher");
    if (fs.existsSync(alt)) {
      binaryPath = alt;
    } else {
      throw new Error(`[PACKAGE_ARTIFACT] binary not found at ${binaryPath} or ${alt}`);
    }
  }

  const pkgRoot      = path.join(distDir, "package-root");
  const artifactName = "demo-hasher-linux-x64.tar.gz";
  const artifactPath = path.join(distDir, artifactName);

  fs.rmSync(pkgRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(pkgRoot, "bin"), { recursive: true });
  fs.copyFileSync(binaryPath, path.join(pkgRoot, "bin", "demo-hasher"));

  const manifest = {
    name:         "demo-hasher",
    version:      "0.1.0",
    binary:       "bin/demo-hasher",
    build_type:   "Release",
    dependencies: ["fmt", "nlohmann-json", "openssl"],
  };
  fs.writeFileSync(path.join(pkgRoot, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  // Use GNU tar flags for reproducible output; fall back to BSD tar for local dev
  const tarBin  = findGNUTar();
  const isGNU   = run(tarBin, ["--version"]).output.includes("GNU");
  const tarArgs = isGNU
    ? ["--sort=name", "--mtime=UTC 2024-01-01", "--owner=0", "--group=0",
       "--numeric-owner", "-czf", artifactPath, "-C", pkgRoot, "."]
    : ["-czf", artifactPath, "-C", pkgRoot, "."];

  const tarResult = run(tarBin, tarArgs);
  if (tarResult.exitCode !== 0) {
    throw new Error(`[PACKAGE_ARTIFACT] tar failed (exit ${tarResult.exitCode}): ${tarResult.output}`);
  }

  const artifactHash = fileHash(artifactPath);
  fs.writeFileSync(path.join(distDir, "artifact_hash.txt"), artifactHash + "\n");
  log.push(`[PACKAGE_ARTIFACT] artifact_hash=${artifactHash}`);

  return {
    stage:         "PACKAGE_ARTIFACT",
    status:        "success",
    exit_code:     0,
    timestamp:     new Date().toISOString(),
    artifact_path: `dist/${artifactName}`,
    artifact_hash: artifactHash,
    manifest,
    dependency_measurement: { used_deps_root: usedDepsRoot },
    log,
  };
}

// ---------------------------------------------------------------------------
// Phase 6: compute_artifact_hash  (mirrors compute_artifact_hash.sh)
// ---------------------------------------------------------------------------

async function phaseComputeArtifactHash(artifactHash) {
  const poseidon = await buildPoseidon();
  const F        = poseidon.F;

  const built_artifact_root_poseidon = BigInt("0x" + artifactHash) % FIELD_PRIME;
  const r2                          = randomFieldElement();
  const built_artifact_commitment    = F.toString(poseidon([built_artifact_root_poseidon, r2]));

  return {
    stage:                       "COMPUTE_ARTIFACT_HASH",
    status:                      "success",
    exit_code:                   0,
    timestamp:                   new Date().toISOString(),
    built_artifact_root:          artifactHash,
    built_artifact_root_poseidon: built_artifact_root_poseidon.toString(),
    r2:                          r2.toString(),
    built_artifact_commitment,
    log: [
      "[ARTIFACT_HASH] Computing Poseidon commitment over artifact hash",
      `[ARTIFACT_HASH] built_artifact_root=${artifactHash}`,
      `[ARTIFACT_HASH] built_artifact_root_poseidon=${built_artifact_root_poseidon}`,
      `[ARTIFACT_HASH] r2=${r2}`,
      `[ARTIFACT_HASH] built_artifact_commitment=${built_artifact_commitment}`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const repoDir  = process.env.REPO_DIR   || "repo";
  const outDir   = process.env.OUT_DIR    || "tee-build";
  const s3OutDir = process.env.S3_OUT_DIR || "s3-output";

  const s3BuildDir = path.resolve(s3OutDir, "build");
  const s3DistDir  = path.resolve(s3OutDir, "dist");

  // appRoot = <src-repo>/app — mirrors APP_ROOT in common.sh
  const appRoot  = path.resolve(repoDir, "app");
  // Build and dist dirs live inside the output volume (src-repo input is read-only)
  const buildDir = path.resolve(outDir, "build");
  const distDir  = path.resolve(outDir, "dist");

  for (const d of [outDir, s3BuildDir, s3DistDir, buildDir, distDir]) {
    fs.mkdirSync(d, { recursive: true });
  }

  console.log("[TEE_BUILD] Starting build sequence");
  console.log(`[TEE_BUILD] app root:  ${appRoot}`);
  console.log(`[TEE_BUILD] build dir: ${buildDir}`);
  console.log(`[TEE_BUILD] dist dir:  ${distDir}`);

  // ── Pure build phases (equivalent to vanilla build) ──────────────────────
  const PURE_BUILD_START = Date.now();

  const depsResult = phaseLoadDeps(distDir);
  console.log(`[TEE_BUILD] load_deps: ${depsResult.status}`);

  const buildResult = phaseBuild(appRoot, buildDir);
  console.log(`[TEE_BUILD] build: ${buildResult.status}`);
  if (buildResult.status !== "success") {
    console.error("[TEE_BUILD] Build failed — aborting");
    for (const line of (buildResult.configure?.log ?? [])) console.error("[CONFIGURE]", line);
    for (const line of (buildResult.compile?.log   ?? [])) console.error("[COMPILE]",   line);
    process.exit(1);
  }

  const testResult = phaseRunTests(buildDir);
  console.log(`[TEE_BUILD] run_tests: ${testResult.status} (${testResult.tests_passed}/${testResult.tests_expected} passed)`);
  if (testResult.status !== "success") {
    console.error("[TEE_BUILD] Tests failed — aborting");
    process.exit(1);
  }

  const pkgResult = phasePackageArtifact(buildDir, distDir, depsResult.used_deps_root);
  console.log(`[TEE_BUILD] package_artifact: ${pkgResult.status}`);
  console.log(`[TEE_BUILD] artifact_hash=${pkgResult.artifact_hash}`);

  const PURE_BUILD_ELAPSED_RAW = Date.now() - PURE_BUILD_START;
  const PURE_BUILD_ELAPSED = ((PURE_BUILD_ELAPSED_RAW - buildResult.vcpkg_fetch_ms) / 1000).toFixed(2);
  const VCPKG_FETCH_ELAPSED = (buildResult.vcpkg_fetch_ms / 1000).toFixed(2);

  // ── ZK overhead phases (Poseidon hashing + witness generation) ───────────
  const ZK_OVERHEAD_START = Date.now();

  const depsWitness = await phaseComputeUsedDepsWitness(depsResult.used_deps);
  console.log(`[TEE_BUILD] used_deps_root_poseidon=${depsWitness.used_deps_root_poseidon}`);
  console.log(`[TEE_BUILD] used_deps_commitment=${depsWitness.used_deps_commitment}`);

  const sourceResult = await phaseComputeSourceRoot(appRoot);
  console.log(`[TEE_BUILD] compute_source_root: ${sourceResult.status}`);
  console.log(`[TEE_BUILD] used_source_root=${sourceResult.used_source_root}`);
  console.log(`[TEE_BUILD] used_source_root_poseidon=${sourceResult.used_source_root_poseidon}`);
  console.log(`[TEE_BUILD] r2=${sourceResult.r2}`);
  console.log(`[TEE_BUILD] used_source_commitment=${sourceResult.used_source_commitment}`);

  const artifactHashResult = await phaseComputeArtifactHash(pkgResult.artifact_hash);
  console.log(`[TEE_BUILD] compute_artifact_hash: ${artifactHashResult.status}`);
  console.log(`[TEE_BUILD] built_artifact_root=${artifactHashResult.built_artifact_root}`);
  console.log(`[TEE_BUILD] built_artifact_root_poseidon=${artifactHashResult.built_artifact_root_poseidon}`);
  console.log(`[TEE_BUILD] r2=${artifactHashResult.r2}`);
  console.log(`[TEE_BUILD] built_artifact_commitment=${artifactHashResult.built_artifact_commitment}`);

  const buildLog = {
    build_id:     "tee-build-001",
    app:          "demo-hasher",
    version:      "0.1.0",
    stages: {
      load_deps:             depsResult,
      compute_source_root:   sourceResult,
      build:                 buildResult,
      test:                  testResult,
      package_artifact:      pkgResult,
      compute_artifact_hash: artifactHashResult,
    },
    final_status: "success",
  };

  const summary = {
    build_id: buildLog.build_id,
    app:      buildLog.app,
    version:  buildLog.version,
    stages: {
      load_deps:             { status: depsResult.status,            exit_code: depsResult.exit_code },
      configure_build:       { status: buildResult.configure.status, exit_code: buildResult.configure.exit_code },
      compile_build:         { status: buildResult.compile.status,   exit_code: buildResult.compile.exit_code },
      test: {
        status:       testResult.status,
        exit_code:    testResult.exit_code,
        tests_passed: testResult.tests_passed,
        tests_failed: testResult.tests_failed,
      },
      package_artifact:      { status: pkgResult.status,             exit_code: pkgResult.exit_code },
      compute_artifact_hash: { status: artifactHashResult.status,    exit_code: artifactHashResult.exit_code },
    },
    dependency_measurement: {
      used_deps_root: depsResult.used_deps_root,
    },
    artifact: {
      path:          pkgResult.artifact_path,
      artifact_hash: pkgResult.artifact_hash,
    },
    source: {
      used_source_root: sourceResult.used_source_root,
    },
    artifact_measurement: {
      built_artifact_root: artifactHashResult.built_artifact_root,
    },
  };

  fs.writeFileSync(path.join(outDir,    "build_log.json"),           JSON.stringify(buildLog, null, 2));
  fs.writeFileSync(path.join(outDir,    "final_build_summary.json"), JSON.stringify(summary,  null, 2));
  fs.writeFileSync(path.join(s3BuildDir, "build_log.json"),           JSON.stringify(buildLog, null, 2));
  fs.writeFileSync(path.join(s3BuildDir, "final_build_summary.json"), JSON.stringify(summary,  null, 2));

  // ------------------------------------------------------------------
  // Generate f_build private witness
  // Combines configure + compile log lines into one string, chunks it,
  // then hashes it using the same chained-Poseidon scheme as the circuit.
  // ------------------------------------------------------------------
  const buildPhaseLogText = [
    ...buildResult.configure.log,
    ...buildResult.compile.log,
  ].filter(l => l.startsWith("[CONFIGURE_BUILD]") || l.startsWith("[COMPILE_BUILD]")).join("\n");

  const buildLogChunks = textToFieldChunks(buildPhaseLogText, MAX_LOG_CHUNKS);

  const stage1ExitCode = buildResult.stage1_configure_ok ? "0" : "1";
  const stage2ExitCode = buildResult.stage2_compile_ok   ? "0" : "1";
  const stage3ExitCode = buildResult.stage3_overall_ok   ? "0" : "1";

  const poseidonForWitness = await buildPoseidon();
  const buildLogHash = await poseidonChainedHash(
    poseidonForWitness,
    poseidonForWitness.F,
    buildLogChunks,
    stage1ExitCode,
    stage2ExitCode,
    stage3ExitCode,
  );

  const fBuildWitness = {
    build_log_chunks:   buildLogChunks,
    stage_1_exit_code:  stage1ExitCode,
    stage_2_exit_code:  stage2ExitCode,
    stage_3_exit_code:  stage3ExitCode,
    build_log_hash:     buildLogHash,
  };

  const pvtWitnessDir = path.resolve(outDir, "pvt-witness");
  fs.mkdirSync(pvtWitnessDir, { recursive: true });

  const fSourceWitness = {
    used_source_root_poseidon: sourceResult.used_source_root_poseidon,
    r2:                        sourceResult.r2,
    used_source_commitment:    sourceResult.used_source_commitment,
  };
  fs.writeFileSync(
    path.join(pvtWitnessDir, "f_source_witness.json"),
    JSON.stringify(fSourceWitness, null, 2),
  );

  const fArtifactWitness = {
    built_artifact_root_poseidon: artifactHashResult.built_artifact_root_poseidon,
    r2:                          artifactHashResult.r2,
    built_artifact_commitment:    artifactHashResult.built_artifact_commitment,
  };
  fs.writeFileSync(
    path.join(pvtWitnessDir, "f_artifact_witness.json"),
    JSON.stringify(fArtifactWitness, null, 2),
  );

  fs.writeFileSync(
    path.join(pvtWitnessDir, "f_build_witness.json"),
    JSON.stringify(fBuildWitness, null, 2),
  );

  fs.writeFileSync(
    path.join(pvtWitnessDir, "f_deps_witness.json"),
    JSON.stringify(depsWitness, null, 2),
  );

  console.log("[TEE_BUILD] Completed successfully");
  console.log(`[TEE_BUILD] Final summary: ${outDir}/final_build_summary.json`);
  console.log(`[TEE_BUILD] Artifact hash: ${pkgResult.artifact_hash}`);
  console.log(`[TEE_BUILD] f_source witness: ${pvtWitnessDir}/f_source_witness.json`);
  console.log(`[TEE_BUILD] f_artifact witness: ${pvtWitnessDir}/f_artifact_witness.json`);
  console.log(`[TEE_BUILD] f_build witness: ${pvtWitnessDir}/f_build_witness.json`);
  console.log(`[TEE_BUILD] f_build build_log_hash: ${buildLogHash}`);
  console.log(`[TEE_BUILD] f_deps witness: ${pvtWitnessDir}/f_deps_witness.json`);

  // ------------------------------------------------------------------
  // Generate f_test private witness
  // Chunks and hashes phase 4 (test) logs. Stage exit codes are fixed
  // at "0" for now (all tests must pass for the build to reach here).
  // ------------------------------------------------------------------
  const testPhaseLogText = testResult.log.filter(l => l.startsWith("[TEST]")).join("\n");
  const testLogChunks    = textToFieldChunks(testPhaseLogText, MAX_LOG_CHUNKS);

  const testStage1ExitCode = "0";
  const testStage2ExitCode = "0";
  const testStage3ExitCode = "0";

  const poseidonForTestWitness = await buildPoseidon();
  const testLogHash = await poseidonChainedHash(
    poseidonForTestWitness,
    poseidonForTestWitness.F,
    testLogChunks,
    testStage1ExitCode,
    testStage2ExitCode,
    testStage3ExitCode,
  );

  const fTestWitness = {
    test_log_chunks:   testLogChunks,
    stage_1_exit_code: testStage1ExitCode,
    stage_2_exit_code: testStage2ExitCode,
    stage_3_exit_code: testStage3ExitCode,
    test_log_hash:     testLogHash,
  };

  fs.writeFileSync(
    path.join(pvtWitnessDir, "f_test_witness.json"),
    JSON.stringify(fTestWitness, null, 2),
  );

  console.log(`[TEE_BUILD] f_test witness: ${pvtWitnessDir}/f_test_witness.json`);
  console.log(`[TEE_BUILD] f_test test_log_hash: ${testLogHash}`);

  // ------------------------------------------------------------------
  // Generate tee_report
  // report_data = sha256(used_source_commitment|used_deps_commitment|
  //                      buildLogHash|testLogHash|built_artifact_commitment)
  // ------------------------------------------------------------------
  const reportData = H(
    sourceResult.used_source_commitment,
    depsWitness.used_deps_commitment,
    buildLogHash,
    testLogHash,
    artifactHashResult.built_artifact_commitment,
  );

  const teeReport = {
    measurement:       "sha256:bca64153c63d6547f333fe5147e1843f1eccf155ae069a3487aade436b5ae03a",
    report_data:       "sha256:" + reportData,
    nonce:             "dummy-nonce",
    signature:         "dummy-signature",
    certificate_chain: ["dummy-certificate"],
  };

  fs.writeFileSync(
    path.join(s3BuildDir, "tee_report.json"),
    JSON.stringify(teeReport, null, 2),
  );
  console.log(`[TEE_BUILD] tee_report written: ${s3BuildDir}/tee_report.json`);
  console.log(`[TEE_BUILD] tee_report.report_data=${teeReport.report_data}`);

  // Copy the artifact tarball into the s3-output dist dir for S3 upload
  const artifactName    = "demo-hasher-linux-x64.tar.gz";
  const artifactSrcPath = path.join(distDir, artifactName);
  const artifactDstPath = path.join(s3DistDir, artifactName);
  fs.copyFileSync(artifactSrcPath, artifactDstPath);
  console.log(`[TEE_BUILD] artifact staged for S3: ${artifactDstPath}`);

  const ZK_OVERHEAD_ELAPSED = ((Date.now() - ZK_OVERHEAD_START) / 1000).toFixed(2);
  const TOTAL_ELAPSED = ((Date.now() - TEE_BUILD_START) / 1000).toFixed(2);

  console.log("");
  console.log("[TEE_BUILD] --- Time Measurements ---");
  console.log(`[TEE_BUILD] vcpkg registry fetch time (excluded):              ${VCPKG_FETCH_ELAPSED}s`);
  console.log(`[TEE_BUILD] Pure build time (configure+compile+test+package):  ${PURE_BUILD_ELAPSED}s`);
  console.log(`[TEE_BUILD] ZK overhead (Poseidon hashing + witness gen):      ${ZK_OVERHEAD_ELAPSED}s`);
  console.log(`[TEE_BUILD] Total tee_build.js time:                           ${TOTAL_ELAPSED}s`);
}

const TEE_BUILD_START = Date.now();
main().catch((err) => { console.error(err); process.exit(1); });
