#!/usr/bin/env bash
set -euo pipefail

# Inputs (set by Concourse task environment):
#   repo/            — git checkout (circom sources + shared ptau keys)
#   circuit-artifacts/ — output directory for per-circuit bundles

REPO=repo/zk
KEYS=$REPO/keys
OUT=circuit-artifacts

# ---------------------------------------------------------------------------
# compile_circuit <circuit_dir> <circuit_name> <ptau_file>
#
#   circuit_dir   directory under zk/  e.g. f_artifact
#   circuit_name  main .circom template name (capital-sensitive)
#                 e.g. f_artifact | F_deps_membership
#   ptau_file     filename under $KEYS  e.g. pot12_final.ptau
# ---------------------------------------------------------------------------
compile_circuit() {
  local dir=$1 name=$2 ptau=$3
  local src=$REPO/$dir
  local bld=$src/build
  local kys=$src/keys

  echo "=== Compiling $name ==="

  mkdir -p "$bld" "$kys"

  # 1. Compile circom → r1cs + wasm
  circom "$src/circuits/${name}.circom" \
    --r1cs --wasm --sym \
    -o "$bld"

  # 2. Groth16 setup using shared ptau (pre-computed, committed to repo)
  snarkjs groth16 setup \
    "$bld/${name}.r1cs" \
    "$KEYS/$ptau" \
    "$kys/${name}_0000.zkey"

  # 3. Key contribution (non-interactive; entropy from /dev/urandom)
  snarkjs zkey contribute \
    "$kys/${name}_0000.zkey" \
    "$kys/${name}_final.zkey" \
    --name="ci-contribution" \
    -e="$(head -c 32 /dev/urandom | base64)"

  # 4. Export verification key
  snarkjs zkey export verificationkey \
    "$kys/${name}_final.zkey" \
    "$kys/verification_key.json"

  # 5. Bundle: wasm + final.zkey + verification_key.json
  local bundle_dir=$OUT/$(echo "$dir" | tr '[:upper:]' '[:lower:]')
  mkdir -p "$bundle_dir"

  # wasm lives one level deeper inside <name>_js/
  local wasm_js_dir=$bld/${name}_js
  tar -czf "$bundle_dir/${dir}-artifacts.tgz" \
    -C "$wasm_js_dir" "${name}.wasm" \
    -C "$(cd "$kys" && pwd)" "${name}_final.zkey" "verification_key.json"

  echo "=== Done: $name ==="
}

# ---------------------------------------------------------------------------
# Install node dependencies in each circuit directory
# ---------------------------------------------------------------------------
for circuit_dir in f_source f_artifact f_build f_test f_deps_membership; do
  echo "--- npm ci: $circuit_dir ---"
  (cd "$REPO/$circuit_dir" && npm ci --prefer-offline 2>&1 | tail -5)
done

# ---------------------------------------------------------------------------
# Compile each circuit
#   pot12 → f_source, f_artifact
#   pot14 → f_build, f_test
#   pot16 → f_deps_membership
# ---------------------------------------------------------------------------
compile_circuit f_source          f_source          pot12_final.ptau
compile_circuit f_artifact        f_artifact        pot12_final.ptau
compile_circuit f_build           f_build           pot14_final.ptau
compile_circuit f_test            f_test            pot14_final.ptau
compile_circuit f_deps_membership F_deps_membership pot16_final.ptau

echo ""
echo "All circuits compiled. Artifact bundles:"
find "$OUT" -name "*.tgz" | sort