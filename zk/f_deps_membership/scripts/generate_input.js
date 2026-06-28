const fs = require("fs");
const path = require("path");
const { buildPoseidon } = require("circomlibjs");

const MAX_DEPS = 8;
const APPROVED_TREE_DEPTH = 4;

function poseidonHash(poseidon, inputs) {
  const F = poseidon.F;
  return F.toObject(poseidon(inputs.map(BigInt))).toString();
}

function hashDepToField(dep) {
  // Demo-only deterministic encoding.
  // Production should use canonical package metadata encoding.
  const s = `${dep.name}@${dep.version}:${dep.integrity}`;

  let acc = BigInt(0);
  for (let i = 0; i < s.length; i++) {
    acc = acc * BigInt(257) + BigInt(s.charCodeAt(i));
  }

  return acc.toString();
}

function buildMerkleTree(poseidon, leaves, depth) {
  const leafCount = 2 ** depth;

  if (leaves.length > leafCount) {
    throw new Error(`Too many approved leaves. Max allowed = ${leafCount}`);
  }

  const paddedLeaves = [...leaves];

  while (paddedLeaves.length < leafCount) {
    paddedLeaves.push("0");
  }

  const levels = [];
  levels.push(paddedLeaves);

  for (let d = 0; d < depth; d++) {
    const prev = levels[d];
    const next = [];

    for (let i = 0; i < prev.length; i += 2) {
      next.push(poseidonHash(poseidon, [prev[i], prev[i + 1]]));
    }

    levels.push(next);
  }

  return {
    root: levels[depth][0],
    levels
  };
}

function getMerklePath(tree, leafIndex, depth) {
  const pathElements = [];
  const pathIndices = [];

  let index = leafIndex;

  for (let d = 0; d < depth; d++) {
    const siblingIndex = index ^ 1;

    pathElements.push(tree.levels[d][siblingIndex]);
    pathIndices.push(index % 2);

    index = Math.floor(index / 2);
  }

  return {
    pathElements,
    pathIndices
  };
}

async function main() {
  const poseidon = await buildPoseidon();

  // Approved dependency allowlist.
  // Max size = 16 because APPROVED_TREE_DEPTH = 4.
  const approvedDeps = [
    { name: "openssl", version: "3.2.1", integrity: "sha256-openssl" },
    { name: "zlib", version: "1.3.1", integrity: "sha256-zlib" },
    { name: "curl", version: "8.7.1", integrity: "sha256-curl" },
    { name: "cmake", version: "3.29.0", integrity: "sha256-cmake" },
    { name: "ninja", version: "1.11.1", integrity: "sha256-ninja" },
    { name: "boost", version: "1.84.0", integrity: "sha256-boost" },
    { name: "fmt", version: "10.2.1", integrity: "sha256-fmt" },
    { name: "spdlog", version: "1.13.0", integrity: "sha256-spdlog" }
  ];

  // This is what the TEE actually used.
  const teeUsedDeps = [
    approvedDeps[0],
    approvedDeps[1],
    approvedDeps[2]
  ];

  const used_deps_count = teeUsedDeps.length.toString();

  if (teeUsedDeps.length > MAX_DEPS) {
    throw new Error(`Too many used deps. Max allowed = ${MAX_DEPS}`);
  }

  const approvedLeaves = approvedDeps.map(hashDepToField);
  const usedLeavesRaw = teeUsedDeps.map(hashDepToField);

  const paddedUsedLeaves = [...usedLeavesRaw];
  while (paddedUsedLeaves.length < MAX_DEPS) {
    paddedUsedLeaves.push("0");
  }

  const approvedTree = buildMerkleTree(
    poseidon,
    approvedLeaves,
    APPROVED_TREE_DEPTH
  );

  const usedTree = buildMerkleTree(
    poseidon,
    paddedUsedLeaves,
    3
  );

  const approved_deps_root = approvedTree.root;
  const used_deps_root = usedTree.root;

  const r1 = "111111";
  const r2 = "222222";

  const approved_deps_commitment = poseidonHash(poseidon, [
    approved_deps_root,
    r1
  ]);

  const used_deps_commitment = poseidonHash(poseidon, [
    used_deps_root,
    r2
  ]);

  const merkle_path_elements = [];
  const merkle_path_indices = [];

  for (let i = 0; i < MAX_DEPS; i++) {
    if (i < teeUsedDeps.length) {
      const usedLeaf = usedLeavesRaw[i];
      const approvedIndex = approvedLeaves.findIndex((x) => x === usedLeaf);

      if (approvedIndex === -1) {
        throw new Error(`Used dependency is not approved: ${teeUsedDeps[i].name}`);
      }

      const path = getMerklePath(
        approvedTree,
        approvedIndex,
        APPROVED_TREE_DEPTH
      );

      merkle_path_elements.push(path.pathElements);
      merkle_path_indices.push(path.pathIndices);
    } else {
      merkle_path_elements.push(Array(APPROVED_TREE_DEPTH).fill("0"));
      merkle_path_indices.push(Array(APPROVED_TREE_DEPTH).fill(0));
    }
  }

  const input = {
    approved_deps_commitment,
    used_deps_commitment,

    approved_deps_root,
    r1,

    used_deps_root,
    r2,

    used_deps_count,

    deps: paddedUsedLeaves,

    merkle_path_elements,
    merkle_path_indices
  };

  const outPath = path.join(__dirname, "../inputs/input.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(input, null, 2));

  console.log("Generated inputs/input.json");
  console.log("used_deps_count:", used_deps_count);
  console.log("approved_deps_commitment:", approved_deps_commitment);
  console.log("used_deps_commitment:", used_deps_commitment);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});