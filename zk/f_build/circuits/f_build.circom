pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/poseidon.circom";

/*
  F_build

  Private:
    build_log_chunks[MAX_LOG_CHUNKS]
    stage_1_exit_code
    stage_2_exit_code
    stage_3_exit_code

  Public:
    build_log_hash

  Hash style:
    h0 = Poseidon(chunk_1, chunk_2)
    h1 = Poseidon(h0, chunk_3)
    h2 = Poseidon(h1, chunk_4)
    ...
    final_hash = Poseidon(h_last, exit_1, exit_2, exit_3)

  Claim:
    Poseidon-chained private build log == public build_log_hash
    stage_1_exit_code == 0
    stage_2_exit_code == 0
    stage_3_exit_code == 0
*/

template FBuild(MAX_LOG_CHUNKS) {
    signal input build_log_chunks[MAX_LOG_CHUNKS];

    signal input stage_1_exit_code;
    signal input stage_2_exit_code;
    signal input stage_3_exit_code;

    signal input build_log_hash;

    /*
      Need at least 2 chunks because:
        h0 = Poseidon(chunk_1, chunk_2)
    */

    // Number of intermediate hashes:
    // 1 initial hash for chunk_1 + chunk_2
    // plus one hash for each remaining chunk
    component chunk_hashes[MAX_LOG_CHUNKS - 1];

    // h0 = Poseidon(chunk_1, chunk_2)
    chunk_hashes[0] = Poseidon(2);
    chunk_hashes[0].inputs[0] <== build_log_chunks[0];
    chunk_hashes[0].inputs[1] <== build_log_chunks[1];

    // h_i = Poseidon(h_{i-1}, chunk_{i+2})
    for (var i = 1; i < MAX_LOG_CHUNKS - 1; i++) {
        chunk_hashes[i] = Poseidon(2);
        chunk_hashes[i].inputs[0] <== chunk_hashes[i - 1].out;
        chunk_hashes[i].inputs[1] <== build_log_chunks[i + 1];
    }

    // final_hash = Poseidon(h_last, exit_1, exit_2, exit_3)
    component final_hasher = Poseidon(4);
    final_hasher.inputs[0] <== chunk_hashes[MAX_LOG_CHUNKS - 2].out;
    final_hasher.inputs[1] <== stage_1_exit_code;
    final_hasher.inputs[2] <== stage_2_exit_code;
    final_hasher.inputs[3] <== stage_3_exit_code;

    // Public hash check
    build_log_hash === final_hasher.out;

    // Exit-code constraints
    stage_1_exit_code === 0;
    stage_2_exit_code === 0;
    stage_3_exit_code === 0;
}

component main { public [build_log_hash] } = FBuild(16);