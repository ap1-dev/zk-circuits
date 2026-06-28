const fs = require("fs");
const path = require("path");

async function main() {
  const declaredSourcePath = path.resolve(
    __dirname,
    "../../../../app/policy_register/declared_source.json"
  );
  const declaredSource = JSON.parse(fs.readFileSync(declaredSourcePath, "utf8"));

  const usedSourcePath = path.resolve(__dirname, "../inputs/used_source.json");
  const usedSource = JSON.parse(fs.readFileSync(usedSourcePath, "utf8"));

  // All values are pre-computed — read directly from policy register and used_source.json.
  const declared_source_root = declaredSource.declared_source_root_poseidon;
  const r1                   = declaredSource.r1;
  const declared_commitment  = declaredSource.declared_source_commitment;

  const used_source_root  = usedSource.used_source_root_poseidon;
  const r2                = usedSource.r2;
  const used_commitment   = usedSource.used_source_commitment;

  const input = {
    declared_commitment,
    used_commitment,

    declared_source_root,
    used_source_root,

    r1,
    r2,
  };

  fs.mkdirSync("inputs", { recursive: true });
  fs.writeFileSync("inputs/input.json", JSON.stringify(input, null, 2));

  console.log("Generated inputs/input.json");
}

main();