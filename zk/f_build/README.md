# F_build Circuit

This circuit proves that a private build log record matches a public build log hash and that all build stages exited with code 0.

## Claim

The prover knows:

```text
private build_log_chunks
private stage_1_exit_code
private stage_2_exit_code
private stage_3_exit_code
```
such that:

```
Poseidon(build_log_chunks, stage_1_exit_code, stage_2_exit_code, stage_3_exit_code) == public build_log_hash
stage_1_exit_code == 0
stage_2_exit_code == 0
stage_3_exit_code == 0
```