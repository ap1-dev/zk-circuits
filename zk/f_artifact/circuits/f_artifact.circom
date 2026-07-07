pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/poseidon.circom";

template FArtifact() {
    // Public inputs
    signal input declared_commitment;
    signal input used_commitment;

    // Private witnesses
    signal input declared_artifact_hash;
    signal input built_artifact_hash;
    signal input r1;
    signal input r2;

    // Commit(declared_artifact_hash, r1)
    component declaredHasher = Poseidon(2);
    declaredHasher.inputs[0] <== declared_artifact_hash;
    declaredHasher.inputs[1] <== r1;

    // Commit(built_artifact_hash, r2)
    component usedHasher = Poseidon(2);
    usedHasher.inputs[0] <== built_artifact_hash;
    usedHasher.inputs[1] <== r2;

    // Check commitment openings
    declaredHasher.out === declared_commitment;
    usedHasher.out === used_commitment;

    // Core equality constraint
    declared_artifact_hash === built_artifact_hash;
}

component main { public [declared_commitment, used_commitment] } = FArtifact();