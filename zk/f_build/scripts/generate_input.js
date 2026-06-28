const fs = require("fs");
const path = require("path");
const { buildPoseidon } = require("circomlibjs");

const MAX_LOG_CHUNKS = 16;
const CHUNK_SIZE_BYTES = 31;

function textToFieldChunks(text, maxChunks) {
  const buf = Buffer.from(text, "utf8");
  const chunks = [];

  for (let i = 0; i < buf.length; i += CHUNK_SIZE_BYTES) {
    const chunk = buf.slice(i, i + CHUNK_SIZE_BYTES);
    const hex = chunk.toString("hex") || "00";
    chunks.push(BigInt("0x" + hex).toString());
  }

  if (chunks.length > maxChunks) {
    throw new Error(
      `Build log too large. Got ${chunks.length} chunks, max is ${maxChunks}. Increase MAX_LOG_CHUNKS in the circuit.`
    );
  }

  while (chunks.length < maxChunks) {
    chunks.push("0");
  }

  return chunks;
}

/*
  Chained hashing pattern:

    h0 = Poseidon(chunk_1, chunk_2)
    h1 = Poseidon(h0, chunk_3)
    h2 = Poseidon(h1, chunk_4)
    ...
    final_hash = Poseidon(h_last, exit_1, exit_2, exit_3)

  This avoids high-arity Poseidon over all log chunks.
*/
function poseidonChainedBuildLogHash(poseidon, F, chunks, exit1, exit2, exit3) {
  if (chunks.length < 2) {
    throw new Error("Need at least 2 chunks for initial Poseidon(chunk_1, chunk_2)");
  }

  // h0 = Poseidon(chunk_1, chunk_2)
  let acc = F.toString(poseidon([chunks[0], chunks[1]]));

  // h_i = Poseidon(h_{i-1}, chunk_i)
  for (let i = 2; i < chunks.length; i++) {
    acc = F.toString(poseidon([acc, chunks[i]]));
  }

  // final_hash = Poseidon(h_last, exit_1, exit_2, exit_3)
  const finalHash = F.toString(poseidon([acc, exit1, exit2, exit3]));

  return finalHash;
}

async function main() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  /*
    Mock TEE build log.

    In real pipeline:
      - TEE build script emits this log.
      - TEE extracts the structured exit codes.
      - TEE computes build_log_hash.
      - TEE puts build_log_hash into report_data.
  */
  const rawBuildLog = `
random compiler output...
[STAGE 1]: Completed
more random logs...
[STAGE 2]: Completed
more random logs...
[STAGE 3]: Completed

__STRUCTURED_BUILD_RESULT__
{
  "stage_1_exit_code": 0,
  "stage_2_exit_code": 0,
  "stage_3_exit_code": 0
}
`;

  const buildLogChunks = textToFieldChunks(rawBuildLog, MAX_LOG_CHUNKS);

  const stage1 = "0";
  const stage2 = "0";
  const stage3 = "0";

  const buildLogHash = poseidonChainedBuildLogHash(
    poseidon,
    F,
    buildLogChunks,
    stage1,
    stage2,
    stage3
  );

  const input = {
    build_log_chunks: buildLogChunks,
    stage_1_exit_code: stage1,
    stage_2_exit_code: stage2,
    stage_3_exit_code: stage3,
    build_log_hash: buildLogHash
  };

  const outPath = path.join(__dirname, "..", "inputs", "input.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(input, null, 2));

  console.log("Generated inputs/input.json");
  console.log("Public build_log_hash:", buildLogHash);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});