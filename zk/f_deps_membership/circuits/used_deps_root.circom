pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/poseidon.circom";

template UsedDepsRoot8() {
    signal input deps[8];
    signal output root;

    component h0[4];
    signal level1[4];

    component h1[2];
    signal level2[2];

    component h2;

    for (var i = 0; i < 4; i++) {
        h0[i] = Poseidon(2);
        h0[i].inputs[0] <== deps[2 * i];
        h0[i].inputs[1] <== deps[2 * i + 1];
        level1[i] <== h0[i].out;
    }

    for (var i = 0; i < 2; i++) {
        h1[i] = Poseidon(2);
        h1[i].inputs[0] <== level1[2 * i];
        h1[i].inputs[1] <== level1[2 * i + 1];
        level2[i] <== h1[i].out;
    }

    h2 = Poseidon(2);
    h2.inputs[0] <== level2[0];
    h2.inputs[1] <== level2[1];

    root <== h2.out;
}