#!/usr/bin/env node
"use strict";

/**
 * zk-proof.js
 *
 * Concourse task: zk-proof
 *
 * Inputs (relative to Concourse workspace root = process.cwd()):
 *   cicd-repo/                — git checkout (this script lives here)
 *   tee-build/pvt-witness/       — private witnesses from build-tee task
 *   src-repo/policy_register/    — declared (policy) commitments
 *   artifacts-f-source/          — compiled f_source .tgz
 *   artifacts-f-artifact/        — compiled f_artifact .tgz
 *   artifacts-f-build/           — compiled f_build .tgz
 *   artifacts-f-test/            — compiled f_test .tgz
 *   artifacts-f-deps-membership/ — compiled F_deps_membership .tgz
 *
 * Output:
 *   zk-proofs/zk-proofs-<BUILD_NAME>.tgz
 *     f_source/proof.json
 *     f_source/public.json
 *     f_source/verification_key.json
 *     f_artifact/proof.json
 *     f_artifact/public.json
 *     f_artifact/verification_key.json
 *     f_build/proof.json
 *     f_build/public.json
 *     f_build/verification_key.json
 *     f_test/proof.json
 *     f_test/public.json
 *     f_test/verification_key.json
 *     f_deps_membership/proof.json
 *     f_deps_membership/public.json
 *     f_deps_membership/verification_key.json
 *
 * Env overrides:
 *   TASK_ROOT    workspace root         (default: process.cwd())
 *   TEE_DIR      tee-build volume root  (default: TASK_ROOT/tee-build)
 *   SRC_DIR      src-repo root          (default: TASK_ROOT/src-repo)
 *   OUT_DIR      zk-proofs output root  (default: TASK_ROOT/zk-proofs)
 *   BUILD_NAME   version tag for bundle (default: Date.now())
 */

const fs            = require("fs");
const path          = require("path");
const { spawnSync } = require("child_process");
const snarkjs       = require("snarkjs");

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const TASK_ROOT  = process.env.TASK_ROOT  || process.cwd();
const TEE_DIR    = process.env.TEE_DIR    || path.join(TASK_ROOT, "tee-build");
const SRC_DIR    = process.env.SRC_DIR    || path.join(TASK_ROOT, "src-repo");
const OUT_DIR    = process.env.OUT_DIR    || path.join(TASK_ROOT, "zk-proofs");
const BUILD_NAME = process.env.BUILD_NAME || String(Date.now());

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

// Map circuit name → { wasmPath, zkeyPath, vkeyPath }
const circuitArtifacts = {};

// Circuit names as they appear in the compiled filenames inside the tgz.
// compile-circuits.bash names the template with the original casing.
const CIRCUIT_FILE_NAMES = {
  f_source:          "f_source",
  f_artifact:        "f_artifact",
  f_build:           "f_build",
  f_test:            "f_test",
  f_deps_membership: "F_deps_membership",
};

for (const def of CIRCUIT_DEFS) {
  const artDir  = path.join(TASK_ROOT, def.artifactSubDir);
  const destDir = path.join(OUT_DIR, "extracted", def.name);
  try {
    const { tgz, dir } = extractArtifact(artDir, destDir);
    const fname = CIRCUIT_FILE_NAMES[def.name];
    const wasmPath = path.join(dir, `${fname}.wasm`);
    const zkeyPath = path.join(dir, `${fname}_final.zkey`);
    const vkeyPath = path.join(dir, "verification_key.json");

    for (const [label, p] of [["wasm", wasmPath], ["zkey", zkeyPath], ["vkey", vkeyPath]]) {
      if (!fs.existsSync(p)) throw new Error(`Missing ${label}: ${p}`);
    }

    circuitArtifacts[def.name] = { wasmPath, zkeyPath, vkeyPath };
    console.log(`  [OK] ${def.name}: extracted ${tgz}`);
    console.log(`       wasm: ${wasmPath}`);
    console.log(`       zkey: ${zkeyPath}`);
    console.log(`       vkey: ${vkeyPath}`);
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
// Step 4: Assemble circuit inputs
// ---------------------------------------------------------------------------
console.log("\n=== Step 4: Assembling circuit inputs ===");

// --- f_source ---------------------------------------------------------------
const fSourceInput = {
  declared_commitment:  declSource.declared_source_commitment,
  used_commitment:      fSourcePvt.used_source_commitment,
  declared_source_root: declSource.declared_source_root_poseidon,
  used_source_root:     fSourcePvt.used_source_root_poseidon,
  r1:                   declSource.r1,
  r2:                   fSourcePvt.r2,
};

// --- f_artifact -------------------------------------------------------------
const fArtifactInput = {
  declared_commitment:    declArtifact.declared_artifact_commitment,
  used_commitment:        fArtifactPvt.used_artifact_commitment,
  declared_artifact_hash: declArtifact.declared_artifact_root_poseidon,
  used_artifact_hash:     fArtifactPvt.used_artifact_root_poseidon,
  r1:                     declArtifact.r1,
  r2:                     fArtifactPvt.r2,
};

// --- f_build ----------------------------------------------------------------
const fBuildInput = {
  build_log_hash:    fBuildPvt.build_log_hash,
  build_log_chunks:  fBuildPvt.build_log_chunks,
  stage_1_exit_code: fBuildPvt.stage_1_exit_code,
  stage_2_exit_code: fBuildPvt.stage_2_exit_code,
  stage_3_exit_code: fBuildPvt.stage_3_exit_code,
};

// --- f_test -----------------------------------------------------------------
const fTestInput = {
  test_log_hash:     fTestPvt.test_log_hash,
  test_log_chunks:   fTestPvt.test_log_chunks,
  stage_1_exit_code: fTestPvt.stage_1_exit_code,
  stage_2_exit_code: fTestPvt.stage_2_exit_code,
  stage_3_exit_code: fTestPvt.stage_3_exit_code,
};

// --- f_deps_membership ------------------------------------------------------
const APPROVED_TREE_DEPTH = 3;

// Alphabetical sort order used in both register_declared_deps.js and tee_build.js
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
    merklePathElements.push([...entry.pathElements]);
    merklePathIndices.push([...entry.pathIndices]);
  } else {
    merklePathElements.push(Array(APPROVED_TREE_DEPTH).fill("0"));
    merklePathIndices.push(Array(APPROVED_TREE_DEPTH).fill(0));
  }
}

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

console.log("  [OK] all 5 circuit inputs assembled");

// ---------------------------------------------------------------------------
// Step 5: Print assembled witnesses
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

// ---------------------------------------------------------------------------
// Step 6: Generate Groth16 proofs for all 5 circuits
// ---------------------------------------------------------------------------
console.log("\n=== Step 6: Generating Groth16 proofs ===");

async function generateProofs() {
  const proofCircuits = [
    { name: "f_source",          input: fSourceInput   },
    { name: "f_artifact",        input: fArtifactInput },
    { name: "f_build",           input: fBuildInput    },
    { name: "f_test",            input: fTestInput     },
    { name: "f_deps_membership", input: fDepsInput     },
  ];

  // bundle-root: a staging dir that will become the .tgz contents
  const bundleRoot = path.join(OUT_DIR, "bundle");
  fs.mkdirSync(bundleRoot, { recursive: true });

  for (const { name, input } of proofCircuits) {
    console.log(`\n  --- ${name} ---`);
    const { wasmPath, zkeyPath, vkeyPath } = circuitArtifacts[name];

    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
    console.log(`  [OK] proof generated`);

    const vkey = loadJSON(vkeyPath);
    const valid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
    if (!valid) throw new Error(`Proof verification failed for ${name}`);
    console.log(`  [OK] proof verified`);

    const circuitDir = path.join(bundleRoot, name);
    fs.mkdirSync(circuitDir, { recursive: true });

    fs.writeFileSync(path.join(circuitDir, "proof.json"),            JSON.stringify(proof,         null, 2));
    fs.writeFileSync(path.join(circuitDir, "public.json"),           JSON.stringify(publicSignals, null, 2));
    fs.copyFileSync(vkeyPath, path.join(circuitDir, "verification_key.json"));

    console.log(`  [OK] written to bundle/${name}/`);
  }

  // ---------------------------------------------------------------------------
  // Step 7: Bundle all proofs into a single .tgz
  // ---------------------------------------------------------------------------
  console.log("\n=== Step 7: Creating proof bundle ===");

  const bundleName = `zk-proofs-${BUILD_NAME}.tgz`;
  const bundlePath = path.join(OUT_DIR, bundleName);

  const tarResult = spawnSync(
    "tar",
    ["-czf", bundlePath, "-C", bundleRoot, "."],
    { encoding: "utf8" },
  );
  if (tarResult.status !== 0) {
    throw new Error(`tar failed (exit ${tarResult.status}): ${tarResult.stderr}`);
  }

  console.log(`  [OK] bundle: ${bundlePath}`);
  console.log("\nBundle contents:");
  const listResult = spawnSync("tar", ["-tzf", bundlePath], { encoding: "utf8" });
  console.log(listResult.stdout.trim());

  console.log("\n=== zk-proof.js: all proofs generated and bundled ===");
  console.log(`Bundle: ${bundlePath}`);

  // snarkjs spawns ffjavascript worker threads that never self-terminate;
  // without this the Node process hangs and Concourse never sees task exit.
  process.exit(0);
}

generateProofs().catch((err) => { console.error(err); process.exit(1); });
