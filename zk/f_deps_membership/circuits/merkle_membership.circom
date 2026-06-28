pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/poseidon.circom";

template MerkleMembershipMasked(DEPTH) {
    signal input leaf;
    signal input root;
    signal input enabled;

    signal input pathElements[DEPTH];
    signal input pathIndices[DEPTH];

    signal cur[DEPTH + 1];
    cur[0] <== leaf;

    component hashers[DEPTH];

    signal left[DEPTH];
    signal right[DEPTH];

    signal leftDiff[DEPTH];
    signal rightDiff[DEPTH];

    for (var i = 0; i < DEPTH; i++) {
        // pathIndices[i] must be 0 or 1
        pathIndices[i] * (pathIndices[i] - 1) === 0;

        // if path index = 0:
        //   left = current node
        //   right = sibling
        //
        // if path index = 1:
        //   left = sibling
        //   right = current node

        leftDiff[i] <== cur[i] - pathElements[i];
        rightDiff[i] <== pathElements[i] - cur[i];

        left[i] <== pathElements[i] + leftDiff[i] * (1 - pathIndices[i]);
        right[i] <== cur[i] + rightDiff[i] * (1 - pathIndices[i]);

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== left[i];
        hashers[i].inputs[1] <== right[i];

        cur[i + 1] <== hashers[i].out;
    }

    // If enabled = 1, enforce computed root == approved root.
    // If enabled = 0, skip membership check.
    enabled * (cur[DEPTH] - root) === 0;
}