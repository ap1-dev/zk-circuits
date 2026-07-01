#!/usr/bin/env node
"use strict";

/**
 * zk-proof.js
 *
 * Concourse task: zk-proof
 *
 * Inputs (relative to Concourse workspace root = process.cwd()):
 *   circuit-repo/              — git checkout (this script lives here)
 *   tee-build/pvt-witness/     — private witnesses from build-tee task
 *   src-repo/policy_register/  — declared (policy) commitments
 *   artifacts-f-source/        — compiled f_source .tgz
 *   artifacts-f-artifact/      — compiled f_artifact .tgz
 *   artifacts-f-build/         — compiled f_build .tgz
 *   artifacts-f-test/          — compiled f_test .tgz
 *   artifacts-f-deps-membership/ — compiled F_deps_membership .tgz
 *
 * Output:
 *   zk-proofs/                 — extracted artifacts + (later) generated proofs
 *
 * Override any root with env vars:
 *   TASK_ROOT   workspace root          (default: process.cwd())
 *   TEE_DIR     tee-build volume root   (default: TASK_ROOT/tee-build)
 *   SRC_DIR     src-repo root           (default: TASK_ROOT/src-repo)
 *   OUT_DIR     zk-proofs output root   (default: TASK_ROOT/zk-proofs)
 */

const fs            = require("fs");
const path          = require("path");
const { spawnSync } = require("child_process");

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const TASK_ROOT = process.env.TASK_ROOT || process.cwd();
const TEE_DIR   = process.env.TEE_DIR   || path.join(TASK_ROOT, "tee-build");
const SRC_DIR   = process.env.SRC_DIR   || path.join(TASK_ROOT, "src-repo");
const OUT_DIR   = process.env.OUT_DIR   || path.join(TASK_ROOT, "zk-proofs");

fs.mkdirSync(OUT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function loadJSON(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

// Find the single .tgz in artifactDir, extract to destDir, return destDir.
function extractArtifact(artifactDir, destDir) {
  const files = fs.readdirSync(artifactDir).filter(f => f.endsWith(".tgz"));
  if (files.length === 0) throw new Error(`No .tgz found in ${artifactDir}`);
  if (files.length  > 1) throw new Error(`Multiple .tgz in ${artifactDir}: ${files.join(", ")}`);

  const tgzPath = path.join(artifactDir, files[0]);
  fs.mkdirSync(destDir, { recursive: true });

  const result = spawnSync("tar", ["-xzf", tgzPath, "-C", destDir], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`tar failed (exit ${result.status}): ${result.stderr}`);
  }
  return { tgz: files[0], dir: destDir };
}

// ---------------------------------------------------------------------------
// Step 1: Extract compiled circuit artifacts
// ---------------------------------------------------------------------------
console.log("\n=== Step 1: Extracting circuit artifacts ===");

const CIRCUIT_DEFS = [
  { name: "f_source",          artifactSubDir: "artifacts-f-source"          },
  { name: "f_artifact",        artifactSubDir: "artifacts-f-artifact"        },
  { name: "f_build",           artifactSubDir: "artifacts-f-build"           },
  { name: "f_test",            artifactSubDir: "artifacts-f-test"            },
  { name: "f_deps_membership", artifactSubDir: "artifacts-f-deps-membership" },
];

const extracted = {};

for (const def of CIRCUIT_DEFS) {
  const artDir  = path.join(TASK_ROOT, def.artifactSubDir);
  const destDir = path.join(OUT_DIR, "extracted", def.name);
  try {
    const { tgz, dir } = extractArtifact(artDir, destDir);
    extracted[def.name] = dir;
    console.log(`  [OK] ${def.name}: extracted ${tgz} → ${dir}`);
    const files = fs.readdirSync(dir);
    console.log(`       Contents: ${files.join(", ")}`);
  } catch (e) {
    console.error(`  [ERR] ${def.name}: ${e.message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Step 2: Load private witnesses (from build-tee task output)
// ---------------------------------------------------------------------------
console.log("\n=== Step 2: Loading private witnesses from tee-build/pvt-witness/ ===");

const pvtDir = path.join(TEE_DIR, "pvt-witness");

const fSourcePvt   = loadJSON(path.join(pvtDir, "f_source_witness.json"));
const fArtifactPvt = loadJSON(path.join(pvtDir, "f_artifact_witness.json"));
const fBuildPvt    = loadJSON(path.join(pvtDir, "f_build_witness.json"));
const fTestPvt     = loadJSON(path.join(pvtDir, "f_test_witness.json"));
const fDepsPvt     = loadJSON(path.join(pvtDir, "f_deps_witness.json"));

for (const name of ["f_source", "f_artifact", "f_build", "f_test", "f_deps"]) {
  console.log(`  [OK] ${name}_witness.json`);
}

// ---------------------------------------------------------------------------
// Step 3: Load declared (policy) commitments from src-repo/policy_register/
// ---------------------------------------------------------------------------
console.log("\n=== Step 3: Loading policy register from src-repo/policy_register/ ===");

const policyDir    = path.join(SRC_DIR, "policy_register");
const declSource   = loadJSON(path.join(policyDir, "declared_source.json"));
const declArtifact = loadJSON(path.join(policyDir, "declared_artifact.json"));
const declDeps     = loadJSON(path.join(policyDir, "declared_deps.json"));

for (const name of ["declared_source", "declared_artifact", "declared_deps"]) {
  console.log(`  [OK] ${name}.json`);
}

// ---------------------------------------------------------------------------
// Step 4: Assemble circuit inputs (full witness) for each circuit
//
// The assembled objects match the snarkjs input JSON format:
//   all signal names exactly as declared in the .circom template.
// ---------------------------------------------------------------------------
console.log("\n=== Step 4: Assembling circuit inputs ===");

// --- f_source ---------------------------------------------------------------
// Template FSource():
//   public:  declared_commitment, used_commitment
//   private: declared_source_root, used_source_root, r1, r2
const fSourceInput = {
  declared_commitment:  declSource.declared_source_commitment,
  used_commitment:      fSourcePvt.used_source_commitment,
  declared_source_root: declSource.declared_source_root_poseidon,
  used_source_root:     fSourcePvt.used_source_root_poseidon,
  r1:                   declSource.r1,
  r2:                   fSourcePvt.r2,
};

// --- f_artifact -------------------------------------------------------------
// Template FArtifact():
//   public:  declared_commitment, used_commitment
//   private: declared_artifact_hash, used_artifact_hash, r1, r2
const fArtifactInput = {
  declared_commitment:    declArtifact.declared_artifact_commitment,
  used_commitment:        fArtifactPvt.used_artifact_commitment,
  declared_artifact_hash: declArtifact.declared_artifact_root_poseidon,
  used_artifact_hash:     fArtifactPvt.used_artifact_root_poseidon,
  r1:                     declArtifact.r1,
  r2:                     fArtifactPvt.r2,
};

// --- f_build ----------------------------------------------------------------
// Template FBuild(MAX_LOG_CHUNKS=16):
//   public:  build_log_hash
//   private: build_log_chunks[16], stage_1_exit_code, stage_2_exit_code, stage_3_exit_code
const fBuildInput = {
  build_log_hash:    fBuildPvt.build_log_hash,
  build_log_chunks:  fBuildPvt.build_log_chunks,
  stage_1_exit_code: fBuildPvt.stage_1_exit_code,
  stage_2_exit_code: fBuildPvt.stage_2_exit_code,
  stage_3_exit_code: fBuildPvt.stage_3_exit_code,
};

// --- f_test -----------------------------------------------------------------
// Template FTest(MAX_LOG_CHUNKS=16):
//   public:  test_log_hash
//   private: test_log_chunks[16], stage_1_exit_code, stage_2_exit_code, stage_3_exit_code
const fTestInput = {
  test_log_hash:     fTestPvt.test_log_hash,
  test_log_chunks:   fTestPvt.test_log_chunks,
  stage_1_exit_code: fTestPvt.stage_1_exit_code,
  stage_2_exit_code: fTestPvt.stage_2_exit_code,
  stage_3_exit_code: fTestPvt.stage_3_exit_code,
};

// --- f_deps_membership ------------------------------------------------------
// Template FDepsMembership(APPROVED_TREE_DEPTH=4):
//   public:  approved_deps_commitment, used_deps_commitment
//   private: approved_deps_root, r1,
//            used_deps_root, r2, used_deps_count,
//            deps[8],
//            merkle_path_elements[8][APPROVED_TREE_DEPTH],
//            merkle_path_indices[8][APPROVED_TREE_DEPTH]
//
// deps[] order follows phaseComputeUsedDepsWitness in tee_build.js:
//   depsSorted (alphabetical by name), then zero-padded to 8 slots.
// Disabled slots (index >= used_deps_count) carry zero deps and zero paths
//   because the circuit constrains: (1 - enabled[i]) * deps[i] === 0
//   and MerkleMembershipMasked skips verification when enabled=0.
const APPROVED_TREE_DEPTH = 3;

// Same sort order used in tee_build.js phaseComputeUsedDepsWitness
const DEPS_SORTED_KEYS = [
  "catch2@3.5.2",
  "fmt@10.2.1",
  "nlohmann-json@3.11.3",
  "openssl@3.2.1",
];

const merklePathElements = [];
const merklePathIndices  = [];

for (let i = 0; i < 8; i++) {
  if (i < DEPS_SORTED_KEYS.length) {
    const key   = DEPS_SORTED_KEYS[i];
    const entry = declDeps.paths[key];
    if (!entry) throw new Error(`Missing Merkle path for dep: ${key}`);

    // Pad path arrays to APPROVED_TREE_DEPTH (declared_deps.json uses depth 3,
    // circuit instantiated at depth 4 — pad with zero to bridge the gap).
    const elems   = [...entry.pathElements];
    const indices = [...entry.pathIndices];
    while (elems.length   < APPROVED_TREE_DEPTH) elems.push("0");
    while (indices.length < APPROVED_TREE_DEPTH) indices.push(0);

    merklePathElements.push(elems);
    merklePathIndices.push(indices);
  } else {
    // Disabled slot
    merklePathElements.push(Array(APPROVED_TREE_DEPTH).fill("0"));
    merklePathIndices.push(Array(APPROVED_TREE_DEPTH).fill(0));
  }
}

// fDepsPvt.used_deps holds only the active leaves (not padded to 8).
// Pad to 8 with "0" to match the circuit's deps[8] signal array.
const depsLeaves = [...fDepsPvt.used_deps];
while (depsLeaves.length < 8) depsLeaves.push("0");

const fDepsInput = {
  approved_deps_commitment: declDeps.approved_deps_commitment,
  used_deps_commitment:     fDepsPvt.used_deps_commitment,
  approved_deps_root:       declDeps.approved_deps_root,
  r1:                       declDeps.r1,
  used_deps_root:           fDepsPvt.used_deps_root_poseidon,
  r2:                       fDepsPvt.r2,
  used_deps_count:          fDepsPvt.used_deps_count,
  deps:                     depsLeaves,
  merkle_path_elements:     merklePathElements,
  merkle_path_indices:      merklePathIndices,
};

// ---------------------------------------------------------------------------
// Step 5: Print all assembled witnesses
// ---------------------------------------------------------------------------
console.log("\n=== Step 5: Circuit inputs (private witnesses) for all 5 circuits ===\n");

const ALL_INPUTS = {
  f_source:          fSourceInput,
  f_artifact:        fArtifactInput,
  f_build:           fBuildInput,
  f_test:            fTestInput,
  f_deps_membership: fDepsInput,
};

for (const [circuit, input] of Object.entries(ALL_INPUTS)) {
  console.log(`${"─".repeat(60)}`);
  console.log(`Circuit: ${circuit}`);
  console.log(`${"─".repeat(60)}`);
  console.log(JSON.stringify(input, null, 2));
  console.log();
}

console.log("=== zk-proof.js: witness assembly complete ===");
