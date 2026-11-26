// Compiles src/*.sol with solc-js into out/<Name>.json {abi, bytecode}
const solc = require("solc"), fs = require("fs"), path = require("path");
const root = __dirname, sources = {};
for (const f of fs.readdirSync(path.join(root, "src"))) if (f.endsWith(".sol")) sources[`src/${f}`] = { content: fs.readFileSync(path.join(root, "src", f), "utf8") };
const input = { language: "Solidity", sources, settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "paris", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } };
const findImports = (p) => { const full = path.join(root, p.replace(/^(\.\.\/)+/, "")); return fs.existsSync(full) ? { contents: fs.readFileSync(full, "utf8") } : { error: "not found " + p }; };
const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
let bad = false;
for (const e of out.errors ?? []) { if (e.severity === "error") bad = true; if (!/SPDX|unreachable/.test(e.message)) console.error(e.formattedMessage); }
if (bad) process.exit(1);
fs.mkdirSync(path.join(root, "out"), { recursive: true });
for (const [file, cs] of Object.entries(out.contracts)) if (file.startsWith("src/")) for (const [name, c] of Object.entries(cs))
  fs.writeFileSync(path.join(root, "out", `${name}.json`), JSON.stringify({ abi: c.abi, bytecode: "0x" + c.evm.bytecode.object }, null, 1));
console.log("compiled", fs.readdirSync(path.join(root, "out")).join(", "));
