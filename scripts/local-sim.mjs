// Local stand-in for the full system: a ganache chain with chain id 84532, the three contracts,
// and a loop that plays Reactive Network (feeds vault logs to react(), delivers callbacks).
// Usage: node scripts/local-sim.mjs  -> prints env vars for `next dev`
import ganache from "ganache";
import { createPublicClient, createWalletClient, http, decodeEventLog, encodeAbiParameters } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "fs";

const art = (n) => JSON.parse(readFileSync(new URL(`../contracts/out/${n}.json`, import.meta.url)));
const USD = art("TestUSD"), VAULT = art("ReinsVault"), GUARD = art("ReinsGuardReactive");
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const PROXY_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const server = ganache.server({ logging: { quiet: true }, chain: { chainId: 84532, hardfork: "merge" }, miner: { blockGasLimit: 30_000_000 },
  wallet: { accounts: [{ secretKey: KEY, balance: "0x56BC75E2D63100000" }, { secretKey: PROXY_KEY, balance: "0x56BC75E2D63100000" }] } });
await new Promise((r) => server.listen(8545, r));
const chain = { id: 84532, name: "local", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } } };
const pub = createPublicClient({ chain, transport: http(), pollingInterval: 250 });
const dep = createWalletClient({ account: privateKeyToAccount(KEY), chain, transport: http() });
const prx = createWalletClient({ account: privateKeyToAccount(PROXY_KEY), chain, transport: http() });
const deploy = async (a, args) => (await pub.waitForTransactionReceipt({ hash: await dep.deployContract({ abi: a.abi, bytecode: a.bytecode, args, gas: 8_000_000n }) })).contractAddress;
const usd = await deploy(USD, []);
const vault = await deploy(VAULT, [prx.account.address, usd]);
const guard = await deploy(GUARD, [84532n, vault, 0n]);
console.log(`BASE_SEPOLIA_RPC=http://127.0.0.1:8545 DEPLOYER_PRIVATE_KEY=${KEY} USD_ADDRESS=${usd} VAULT_ADDRESS=${vault} REACTIVE_ADDRESS=${guard}`);

let from = 0n;
setInterval(async () => {
  try {
    const head = await pub.getBlockNumber();
    if (head < from) return;
    const logs = await pub.getLogs({ address: vault, fromBlock: from, toBlock: head });
    from = head + 1n;
    for (const log of logs) {
      const t = log.topics.map((x) => BigInt(x));
      const rec = { chain_id: 84532n, _contract: vault, topic_0: t[0], topic_1: t[1] ?? 0n, topic_2: t[2] ?? 0n, topic_3: t[3] ?? 0n, data: log.data, block_number: log.blockNumber, op_code: BigInt(t.length), block_hash: 0n, tx_hash: 0n, log_index: 0n };
      const rr = await pub.waitForTransactionReceipt({ hash: await dep.writeContract({ address: guard, abi: GUARD.abi, functionName: "react", args: [rec], gas: 3_000_000n }) });
      for (const l of rr.logs) {
        let ev; try { ev = decodeEventLog({ abi: GUARD.abi, data: l.data, topics: l.topics }); } catch { continue; }
        if (ev.eventName !== "Callback") continue;
        await new Promise((r) => setTimeout(r, 1500)); // a little latency, like the real network
        const payload = ev.args.payload.slice(0, 10) + encodeAbiParameters([{ type: "address" }], [dep.account.address]).slice(2) + ev.args.payload.slice(74);
        await pub.waitForTransactionReceipt({ hash: await prx.sendTransaction({ to: vault, data: payload, gas: 500_000n }) });
      }
    }
  } catch (e) { console.error("sim", e.shortMessage ?? e.message); }
}, 1000);
