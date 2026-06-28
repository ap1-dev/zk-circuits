pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";

include "./merkle_membership.circom";
include "./used_deps_root.circom";

template FDepsMembership(APPROVED_TREE_DEPTH) {
    // -------------------------------------------------
    // Public inputs
    // -------------------------------------------------
    signal input approved_deps_commitment;
    signal input used_deps_commitment;

    // -------------------------------------------------
    // Private inputs from policy/prover side
    // -------------------------------------------------
    signal input approved_deps_root;
    signal input r1;

    // -------------------------------------------------
    // Private inputs from TEE/prover side
    // -------------------------------------------------
    signal input used_deps_root;
    signal input r2;

    signal input used_deps_count;

    // MAX_DEPS = 8
    signal input deps[8];

    // Membership paths against approved_deps_root
    signal input merkle_path_elements[8][APPROVED_TREE_DEPTH];
    signal input merkle_path_indices[8][APPROVED_TREE_DEPTH];

    // -------------------------------------------------
    // 1. Verify approved_deps_commitment = Poseidon(root, r1)
    // -------------------------------------------------
    component approvedCommitmentHasher = Poseidon(2);
    approvedCommitmentHasher.inputs[0] <== approved_deps_root;
    approvedCommitmentHasher.inputs[1] <== r1;

    approvedCommitmentHasher.out === approved_deps_commitment;

    // -------------------------------------------------
    // 2. Verify used_deps_commitment = Poseidon(root, r2)
    // -------------------------------------------------
    component usedCommitmentHasher = Poseidon(2);
    usedCommitmentHasher.inputs[0] <== used_deps_root;
    usedCommitmentHasher.inputs[1] <== r2;

    usedCommitmentHasher.out === used_deps_commitment;

    // -------------------------------------------------
    // 3. Enforce used_deps_count <= 8
    // -------------------------------------------------
    component countLt9 = LessThan(5);
    countLt9.in[0] <== used_deps_count;
    countLt9.in[1] <== 9;
    countLt9.out === 1;

    // -------------------------------------------------
    // 4. Compute enabled[i] = i < used_deps_count
    // -------------------------------------------------
    component isEnabled[8];
    signal enabled[8];

    for (var i = 0; i < 8; i++) {
        isEnabled[i] = LessThan(5);
        isEnabled[i].in[0] <== i;
        isEnabled[i].in[1] <== used_deps_count;

        enabled[i] <== isEnabled[i].out;

        // If slot disabled, dep must be zero.
        (1 - enabled[i]) * deps[i] === 0;
    }

    // -------------------------------------------------
    // 5. Verify every enabled dep belongs to approved root
    // -------------------------------------------------
    component membership[8];

    for (var i = 0; i < 8; i++) {
        membership[i] = MerkleMembershipMasked(APPROVED_TREE_DEPTH);

        membership[i].leaf <== deps[i];
        membership[i].root <== approved_deps_root;
        membership[i].enabled <== enabled[i];

        for (var j = 0; j < APPROVED_TREE_DEPTH; j++) {
            membership[i].pathElements[j] <== merkle_path_elements[i][j];
            membership[i].pathIndices[j] <== merkle_path_indices[i][j];
        }
    }

    // -------------------------------------------------
    // 6. Compute MerkleRoot(padded deps[8]) == used_deps_root
    // -------------------------------------------------
    component usedRootComputer = UsedDepsRoot8();

    for (var i = 0; i < 8; i++) {
        usedRootComputer.deps[i] <== deps[i];
    }

    usedRootComputer.root === used_deps_root;
}

component main { public [approved_deps_commitment, used_deps_commitment] } = FDepsMembership(4);