# F_test Circuit

This circuit proves that a private test log record matches a public test log hash and that all test stages exited with code 0.

## Claim

The prover knows:

```text
private test_log_chunks
private stage_1_exit_code
private stage_2_exit_code
private stage_3_exit_code
```
such that:

```
Poseidon(test_log_chunks, stage_1_exit_code, stage_2_exit_code, stage_3_exit_code) == public test_log_hash
stage_1_exit_code == 0
stage_2_exit_code == 0
stage_3_exit_code == 0
```
