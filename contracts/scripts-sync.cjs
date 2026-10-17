// Copies compiled ExitBox artifacts into the server. Run after `npx hardhat compile`.
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "artifacts/contracts/ExitBox.sol");
const box = require(path.join(dir, "ExitBox.json"));
const fac = require(path.join(dir, "ExitBoxFactory.json"));
const out =
  "// Generated from contracts/ by `npm run sync-artifacts` — do not edit.\n" +
  `export const exitBoxBytecode = ${JSON.stringify(box.bytecode)} as const;\n` +
  `export const exitBoxFactoryAbi = ${JSON.stringify(fac.abi, null, 2)} as const;\n` +
  `export const exitBoxFactoryBytecode = ${JSON.stringify(fac.bytecode)} as const;\n`;
fs.writeFileSync(path.join(__dirname, "../server/src/generated/exitbox.ts"), out);
console.log("synced ExitBox artifacts → server/src/generated/exitbox.ts");
