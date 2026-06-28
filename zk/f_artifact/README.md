# F_artifact Poseidon Equality Circuit

This circuit proves:

1. `declared_commitment = Poseidon(declared_artifact_hash, r1)`
2. `used_commitment = Poseidon(used_artifact_hash, r2)`
3. `declared_artifact_hash == used_artifact_hash`

Public inputs:

- `declared_commitment`
- `used_commitment`

Private witnesses:

- `declared_artifact_hash`
- `used_artifact_hash`
- `r1`
- `r2`

Meaning:

The prover proves that the artifact hash declared in the policy registry equals the artifact hash produced by the TEE build, without revealing the artifact hash itself.