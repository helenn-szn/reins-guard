import { formatEther, parseEther, type Address, type Hex } from "viem";
import {
  CALLBACK_PROXY_BASE_SEPOLIA, CRON_1000, LASNA_FAUCET_BASE_SEPOLIA, deployerAccount, lasnaClient, lasnaWallet, origin, originClient, originWallet,
} from "@/lib/chains";
import { DEPLOYED, ReinsGuardReactive, ReinsVault, TestUSD } from "@/lib/contracts";

export const maxDuration = 120;

// One-off deployment steps, run from the server because it can reach both chains.
// Guarded by ADMIN_KEY. Steps: status | faucet | usd | vault | reactive | fund-vault | fund-reactive
export async function GET(req: Request) {
  const url = new URL(req.url);
  if (!process.env.ADMIN_KEY || url.searchParams.get("key") !== process.env.ADMIN_KEY) return Response.json({ error: "Not found" }, { status: 404 });
  const step = url.searchParams.get("step") ?? "status";
  const key = process.env.DEPLOYER_PRIVATE_KEY as Hex;
  const me = deployerAccount().address;
  const pub = originClient(), lpub = lasnaClient();
  const ow = originWallet(key), lw = lasnaWallet(key);
  const arg = (n: string) => url.searchParams.get(n);

  try {
    if (step === "status") {
      const [eth, react] = await Promise.all([pub.getBalance({ address: me }), lpub.getBalance({ address: me }).catch(() => BigInt(-1))]);
      const out: Record<string, unknown> = { deployer: me, baseSepoliaEth: formatEther(eth), lasnaReact: react < 0 ? "unreachable" : formatEther(react), deployed: DEPLOYED };
      if (DEPLOYED.vault) out.vaultEth = formatEther(await pub.getBalance({ address: DEPLOYED.vault }));
      if (DEPLOYED.reactive) out.reactiveReact = formatEther(await lpub.getBalance({ address: DEPLOYED.reactive }));
      return Response.json(out);
    }
    if (step === "faucet") {
      // Base Sepolia ETH -> Lasna REACT (1 ETH = 100 lREACT)
      const hash = await ow.writeContract({
        address: LASNA_FAUCET_BASE_SEPOLIA, value: parseEther(arg("eth") ?? "0.04"),
        abi: [{ type: "function", name: "request", stateMutability: "payable", inputs: [{ name: "addr", type: "address" }], outputs: [] }],
        functionName: "request", args: [me],
      });
      const r = await pub.waitForTransactionReceipt({ hash });
      return Response.json({ hash, status: r.status });
    }
    if (step === "usd") {
      const hash = await ow.deployContract({ abi: TestUSD.abi, bytecode: TestUSD.bytecode, args: [] });
      const r = await pub.waitForTransactionReceipt({ hash });
      return Response.json({ hash, usd: r.contractAddress, block: Number(r.blockNumber) });
    }
    if (step === "vault") {
      const usd = (arg("usd") ?? DEPLOYED.usd) as Address;
      const hash = await ow.deployContract({ abi: ReinsVault.abi, bytecode: ReinsVault.bytecode, args: [CALLBACK_PROXY_BASE_SEPOLIA, usd], value: parseEther(arg("eth") ?? "0.01") });
      const r = await pub.waitForTransactionReceipt({ hash });
      return Response.json({ hash, vault: r.contractAddress, block: Number(r.blockNumber) });
    }
    if (step === "reactive") {
      const vault = (arg("vault") ?? DEPLOYED.vault) as Address;
      const cron = arg("cron") === "0" ? BigInt(0) : CRON_1000;
      const hash = await lw.deployContract({ abi: ReinsGuardReactive.abi, bytecode: ReinsGuardReactive.bytecode, args: [BigInt(origin.id), vault, cron], value: parseEther(arg("react") ?? "2") });
      const r = await lpub.waitForTransactionReceipt({ hash });
      return Response.json({ hash, reactive: r.contractAddress, status: r.status });
    }
    if (step === "fund-vault") {
      const hash = await ow.sendTransaction({ to: DEPLOYED.vault!, value: parseEther(arg("eth") ?? "0.005") });
      return Response.json({ hash, status: (await pub.waitForTransactionReceipt({ hash })).status });
    }
    if (step === "fund-reactive") {
      const hash = await lw.sendTransaction({ to: DEPLOYED.reactive!, value: parseEther(arg("react") ?? "1") });
      return Response.json({ hash, status: (await lpub.waitForTransactionReceipt({ hash })).status });
    }
    if (step === "cover-debt") {
      // Settle any debt from the contract's own balance (Reactive stops serving a contract in debt)
      const abi = [{ type: "function", name: "coverDebt", stateMutability: "nonpayable", inputs: [], outputs: [] }] as const;
      const which = arg("on") === "reactive" ? "reactive" : "vault";
      const hash = which === "reactive"
        ? await lw.writeContract({ address: DEPLOYED.reactive!, abi, functionName: "coverDebt" })
        : await ow.writeContract({ address: DEPLOYED.vault!, abi, functionName: "coverDebt" });
      return Response.json({ which, hash });
    }
    return Response.json({ error: "unknown step" }, { status: 400 });
  } catch (e) {
    return Response.json({ step, error: e instanceof Error ? e.message.split("\n").slice(0, 3).join(" ") : String(e) }, { status: 500 });
  }
}
