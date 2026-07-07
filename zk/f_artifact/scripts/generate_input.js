const fs = require("fs");
const path = require("path");

async function main() {
  const declaredArtifactPath = path.resolve(
    __dirname,
    "../../../../app/policy_register/declared_artifact.json"
  );
  const declaredArtifact = JSON.parse(fs.readFileSync(declaredArtifactPath, "utf8"));

  const usedArtifactPath = path.resolve(__dirname, "../inputs/built_artifact.json");
  const usedArtifact = JSON.parse(fs.readFileSync(usedArtifactPath, "utf8"));

  // All values are pre-computed — read directly from policy register and built_artifact.json.
  const declared_artifact_hash = declaredArtifact.declared_artifact_root_poseidon;
  const r1                     = declaredArtifact.r1;
  const declared_commitment    = declaredArtifact.declared_artifact_commitment;

  const built_artifact_hash = usedArtifact.built_artifact_root_poseidon;
  const r2                 = usedArtifact.r2;
  const used_commitment    = usedArtifact.built_artifact_commitment;

  const input = {
    declared_commitment,
    used_commitment,

    declared_artifact_hash,
    built_artifact_hash,

    r1,
    r2,
  };

  fs.mkdirSync("inputs", { recursive: true });
  fs.writeFileSync("inputs/input.json", JSON.stringify(input, null, 2));

  console.log("Generated inputs/input.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
