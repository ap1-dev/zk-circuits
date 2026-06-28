# F_source Poseidon Equality Circuit

This circuit proves:

1. `declared_commitment = Poseidon(declared_source_root, r1)`
2. `used_commitment = Poseidon(used_source_root, r2)`
3. `declared_source_root == used_source_root`

Public inputs:

- `declared_commitment`
- `used_commitment`

Private witnesses:

- `declared_source_root`
- `used_source_root`
- `r1`
- `r2`

Meaning:

The prover proves that the policy-registered source root and the TEE-used source root are equal, without revealing the root itself.