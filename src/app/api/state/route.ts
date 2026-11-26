import { parseAbiItem, type Address } from "viem";
import { DEPLOYED, HABITS, ReinsVault, TestUSD } from "@/lib/contracts";
import { addressOf, visitorKey } from "@/lib/wallets";
import { originClient } from "@/lib/chains";
import { fromUsd } from "@/lib/vault";

export const dynamic = "force-dynamic";

type Bill = { name: string; payee: Address; amount: bigint; dueAt: bigint; interval: bigint; active: boolean };
const GUARD_APPLIED = parseAbiItem("event GuardApplied(address indexed user, bool safeMode, int256 free, uint256 allowedMask, uint256 at)");

// Everything the page shows, read straight from the vault on Base Sepolia.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const key = visitorKey(req);
  const user = (url.searchParams.get("address") as Address | null) ?? (key ? addressOf(key) : null);
  if (!user || !DEPLOYED.vault) return Response.json({ deployed: !!DEPLOYED.vault, deployments: DEPLOYED });
  const pub = originClient();
  const V = { address: DEPLOYED.vault, abi: ReinsVault.abi } as const;

  const [pot, floor, bills, guard, wallet, gas, block, ...habits] = await Promise.all([
    pub.readContract({ ...V, functionName: "balanceOf", args: [user] }) as Promise<bigint>,
    pub.readContract({ ...V, functionName: "floorOf", args: [user] }) as Promise<bigint>,
    pub.readContract({ ...V, functionName: "billsOf", args: [user] }) as Promise<Bill[]>,
    pub.readContract({ ...V, functionName: "guardOf", args: [user] }) as Promise<[boolean, boolean, bigint, bigint, bigint, bigint]>,
    pub.readContract({ address: DEPLOYED.usd!, abi: TestUSD.abi, functionName: "balanceOf", args: [user] }) as Promise<bigint>,
    pub.getBalance({ address: user }),
    pub.getBlockNumber(),
    ...HABITS.map((h) => pub.readContract({ ...V, functionName: "habitOf", args: [user, BigInt(h.id)] }) as Promise<[string, bigint, bigint, boolean]>),
  ]);

  // Recent decisions the guard sent back (about the last 5 hours of Base Sepolia blocks)
  let decisions: unknown[] = [];
  try {
    const from = block > BigInt(9000) ? block - BigInt(9000) : BigInt(0);
    const logs = await pub.getLogs({ address: DEPLOYED.vault, event: GUARD_APPLIED, args: { user }, fromBlock: from > BigInt(DEPLOYED.vaultBlock ?? 0) ? from : BigInt(DEPLOYED.vaultBlock ?? 0), toBlock: block });
    decisions = logs.slice(-30).map((l) => ({
      hash: l.transactionHash, block: Number(l.blockNumber),
      safeMode: l.args.safeMode, free: fromUsd(l.args.free!), mask: Number(l.args.allowedMask), at: Number(l.args.at),
    }));
  } catch (e) {
    console.error("logs", e);
  }

  const [evaluated, safeMode, free, mask, at, updatedAt] = guard;
  return Response.json({
    deployed: true,
    deployments: DEPLOYED,
    user,
    started: bills.length > 0,
    wallet: fromUsd(wallet),
    gas: Number(gas),
    pot: fromUsd(pot),
    floor: fromUsd(floor),
    bills: bills.map((b, id) => ({ id, name: b.name, amount: fromUsd(b.amount), dueAt: Number(b.dueAt), active: b.active, everyDays: Number(b.interval) / 86400 })),
    habits: HABITS.map((h, i) => ({ id: h.id, name: habits[i][0] || h.name, cap: fromUsd(habits[i][1]), weekly: fromUsd(habits[i][2]), enabled: habits[i][3], allowed: ((Number(mask) >> h.id) & 1) === 1 })),
    guard: { evaluated, safeMode, free: fromUsd(free), mask: Number(mask), at: Number(at), updatedAt: Number(updatedAt) },
    decisions,
  });
}
