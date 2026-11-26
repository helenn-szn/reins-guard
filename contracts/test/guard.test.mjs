// End-to-end simulation of the Reins Guard loop on a local chain:
// vault event -> ReinsGuardReactive.react() (as the ReactVM would) -> Callback -> vault.applyGuard() (as the proxy would)
import ganache from "ganache";
import { createTestClient, createWalletClient, createPublicClient, custom, parseUnits, decodeEventLog, encodeAbiParameters, keccak256, toHex, formatUnits } from "viem";
import { readFileSync } from "fs";
import assert from "assert/strict";

const art = (n) => JSON.parse(readFileSync(new URL(`../out/${n}.json`, import.meta.url)));
const USD = art("TestUSD"), VAULT = art("ReinsVault"), GUARD = art("ReinsGuardReactive");
const provider = ganache.provider({ logging: { quiet: true }, chain: { hardfork: "merge", chainId: 84532 }, wallet: { totalAccounts: 4 }, miner: { blockGasLimit: 30_000_000 } });
const chain = { id: 84532, name: "local", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["http://x"] } } };
const pub = createPublicClient({ chain, transport: custom(provider) });
const test = createTestClient({ chain, mode: "ganache", transport: custom(provider) });
const [deployer, proxy, user, shop] = await createWalletClient({ chain, transport: custom(provider) }).getAddresses();
const w = (account) => createWalletClient({ account, chain, transport: custom(provider) });
const u = (x) => parseUnits(String(x), 6);
const DAY = 86400n;

async function deploy(a, from, args, value = 0n) {
  const hash = await w(from).deployContract({ abi: a.abi, bytecode: a.bytecode, args, value, gas: 8_000_000n });
  return (await pub.waitForTransactionReceipt({ hash })).contractAddress;
}
const usd = await deploy(USD, deployer, []);
const vault = await deploy(VAULT, deployer, [proxy, usd]);
const guard = await deploy(GUARD, deployer, [84532n, vault, 0n]); // same deployer = ReactVM id

const send = async (from, address, abi, functionName, args) => {
  const hash = await w(from).writeContract({ address, abi, functionName, args, gas: 3_000_000n });
  const r = await pub.waitForTransactionReceipt({ hash });
  assert.equal(r.status, "success", functionName);
  return r;
};
const reverts = async (from, functionName, args, msg) => {
  await assert.rejects(pub.simulateContract({ account: from, address: vault, abi: VAULT.abi, functionName, args }), (e) => String(e).includes(msg));
};

let callbacks = 0;
// Feed each vault log to the reactive contract as Reactive Network would, then deliver its callbacks.
async function relay(receipt) {
  for (const log of receipt.logs.filter((l) => l.address.toLowerCase() === vault.toLowerCase())) {
    const t = log.topics.map((x) => BigInt(x));
    const rec = { chain_id: 84532n, _contract: vault, topic_0: t[0] ?? 0n, topic_1: t[1] ?? 0n, topic_2: t[2] ?? 0n, topic_3: t[3] ?? 0n, data: log.data, block_number: receipt.blockNumber, op_code: BigInt(t.length), block_hash: 0n, tx_hash: BigInt(receipt.transactionHash), log_index: BigInt(log.logIndex) };
    await deliver(await send(deployer, guard, GUARD.abi, "react", [rec]));
  }
}
async function deliver(reactReceipt) {
  for (const l of reactReceipt.logs) {
    let ev; try { ev = decodeEventLog({ abi: GUARD.abi, data: l.data, topics: l.topics }); } catch { continue; }
    if (ev.eventName !== "Callback") continue;
    assert.equal(ev.args._contract.toLowerCase(), vault.toLowerCase());
    // The proxy replaces the first argument with the ReactVM id (the deployer)
    const payload = ev.args.payload.slice(0, 10) + encodeAbiParameters([{ type: "address" }], [deployer]).slice(2) + ev.args.payload.slice(10 + 64);
    const hash = await w(proxy).sendTransaction({ to: vault, data: payload, gas: 500_000n });
    assert.equal((await pub.waitForTransactionReceipt({ hash })).status, "success", "applyGuard");
    callbacks++;
  }
}
const act = async (fn, args, from = user) => relay(await send(from, vault, VAULT.abi, fn, args));
const guardOf = async () => { const [evaluated, safe, free, mask] = await pub.readContract({ address: vault, abi: VAULT.abi, functionName: "guardOf", args: [user] }); return { evaluated, safe, free: Number(formatUnits(free, 6)), mask: Number(mask) }; };
const now = async () => (await pub.getBlock()).timestamp;
const step = async (label) => { const g = await guardOf(); console.log(`${label.padEnd(46)} safe=${g.safe} free=${g.free.toFixed(2)} mask=${g.mask} callbacks=${callbacks}`); return g; };

// Setup: test money, rules
await send(user, usd, USD.abi, "mint", [user, u(1000)]);
await send(user, usd, USD.abi, "approve", [vault, 2n ** 256n - 1n]);
const t0 = await now();
await act("setFloor", [u(20)]);
await act("addBill", ["Rent", shop, u(150), t0 + 10n * DAY, 30n * DAY]);
await act("addBill", ["Phone", shop, u(40), t0 + 20n * DAY, 30n * DAY]);
await act("setHabit", [0n, "Coffee", u(5), u(25), true]);
await act("setHabit", [1n, "Food delivery", u(15), u(60), true]);
let g = await step("rules set, pot empty");
assert.equal(g.safe, true); assert.equal(g.mask, 0);
await reverts(user, "spend", [user, 0n, shop, u(4.13)], "paused by Reins Guard");

await act("deposit", [u(100)]);
g = await step("deposit 100 (need 170)");
assert.equal(g.safe, true);
await act("deposit", [u(60)]);
g = await step("partial top-up 60 -> 160, still short");
assert.equal(g.safe, true); assert.equal(g.free, -10);

await act("deposit", [u(40)]);
g = await step("top-up 40 -> 200: free 30, coffee back on");
assert.equal(g.safe, false); assert.equal(g.mask, 1);
await act("spend", [user, 0n, shop, u(4.13)]);
g = await step("coffee 4.13 paid");
assert.equal(g.mask, 1);
await reverts(user, "spend", [user, 1n, shop, u(12)], "paused by Reins Guard");
await reverts(user, "spend", [user, 0n, shop, u(6)], "over habit limit");
await act("spend", [user, 0n, shop, u(4.5)]);
g = await step("coffee 4.50 paid: 21.37 left < 25 weekly");
assert.equal(g.mask, 0); assert.equal(g.safe, false);

await act("payBill", [user, 0n]);
g = await step("rent paid: counted once, next due in 40 days");
assert.equal(g.safe, false); // need = floor 20 only
await act("deposit", [u(100)]);
g = await step("deposit 100: coffee + food on");
assert.equal(g.mask, 3);

// Time passes with no events: the phone bill (40, due day 20) enters the 14-day window on day 6+.
// The timer tick (Reactive's cron event) re-checks everyone.
const SERVICE = "0x0000000000000000000000000000000000fffFfF";
const tick = async () => deliver(await send(deployer, guardT, GUARD.abi, "react", [{ chain_id: 5318007n, _contract: SERVICE, topic_0: CRON, topic_1: 0n, topic_2: 0n, topic_3: 0n, data: "0x", block_number: 0n, op_code: 1n, block_hash: 0n, tx_hash: 0n, log_index: 0n }]));
// Use a second vault+guard pair with a timer, and a tighter budget so the bill matters
const CRON = BigInt(keccak256(toHex("Cron100()")));
const vaultT = await deploy(VAULT, deployer, [proxy, usd]);
const guardT = await deploy(GUARD, deployer, [84532n, vaultT, CRON]);
const actT = async (fn, args) => { const r = await send(user, vaultT, VAULT.abi, fn, args);
  for (const log of r.logs.filter((l) => l.address.toLowerCase() === vaultT.toLowerCase())) { const t = log.topics.map((x) => BigInt(x));
    await deliverT(await send(deployer, guardT, GUARD.abi, "react", [{ chain_id: 84532n, _contract: vaultT, topic_0: t[0], topic_1: t[1] ?? 0n, topic_2: t[2] ?? 0n, topic_3: t[3] ?? 0n, data: log.data, block_number: r.blockNumber, op_code: BigInt(t.length), block_hash: 0n, tx_hash: 0n, log_index: 0n }])); } };
const deliverT = async (rr) => { for (const l of rr.logs) { let ev; try { ev = decodeEventLog({ abi: GUARD.abi, data: l.data, topics: l.topics }); } catch { continue; }
  if (ev.eventName !== "Callback") continue; const payload = ev.args.payload.slice(0, 10) + encodeAbiParameters([{ type: "address" }], [deployer]).slice(2) + ev.args.payload.slice(74);
  await pub.waitForTransactionReceipt({ hash: await w(proxy).sendTransaction({ to: vaultT, data: payload, gas: 500_000n }) }); callbacks++; } };
await send(user, usd, USD.abi, "approve", [vaultT, 2n ** 256n - 1n]);
const t1 = await now();
await actT("setFloor", [u(20)]);
await actT("addBill", ["Phone", shop, u(40), t1 + 20n * DAY, 30n * DAY]);
await actT("setHabit", [0n, "Coffee", u(5), u(25), true]);
await actT("deposit", [u(70)]);
const gT = async () => { const [, safe, free, mask] = await pub.readContract({ address: vaultT, abi: VAULT.abi, functionName: "guardOf", args: [user] }); return { safe, free: Number(formatUnits(free, 6)), mask: Number(mask) }; };
let h = await gT(); console.log("timer vault: pot 70, phone due in 20 days     ", h);
assert.equal(h.mask, 1);
await test.increaseTime({ seconds: Number(7n * DAY) }); await test.mine({ blocks: 1 });
// tick() calls react with the cron log; block.timestamp in this local chain is now day 7
await (async () => { const rr = await send(deployer, guardT, GUARD.abi, "react", [{ chain_id: 5318007n, _contract: SERVICE, topic_0: CRON, topic_1: 0n, topic_2: 0n, topic_3: 0n, data: "0x", block_number: 0n, op_code: 1n, block_hash: 0n, tx_hash: 0n, log_index: 0n }]); await deliverT(rr); })();
h = await gT(); console.log("7 days later, timer tick: phone now in window  ", h);
assert.equal(h.safe, false); assert.equal(h.mask, 0); assert.equal(h.free, 10); // 70 - 20 - 40


// Agent can spend for the user once set; others can't
await act("setAgent", [proxy]);
await reverts(shop, "spend", [user, 0n, shop, u(1)], "not your pot");
console.log(`\nall checks passed, ${callbacks} callbacks delivered`);
