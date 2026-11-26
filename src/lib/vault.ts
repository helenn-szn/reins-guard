import { BaseError, ContractFunctionRevertedError, formatUnits, parseEther, parseUnits, type Address, type Hex } from "viem";
import { deployerAccount, originClient, originWallet } from "./chains";
import { BILLS, DEPLOYED, FLOOR, HABITS, ReinsVault, TestUSD } from "./contracts";

export const usd = (n: number) => parseUnits(n.toFixed(6), 6);
export const fromUsd = (v: bigint) => Number(formatUnits(v, 6));

export type Step = { label: string; hash?: Hex; refused?: string };

function reason(e: unknown) {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (r?.reason) return r.reason;
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}

/** Send one vault/token call from the visitor's wallet. Refusals are caught before sending. */
export async function call(key: Hex, label: string, address: Address, abi: typeof ReinsVault.abi, functionName: string, args: unknown[]): Promise<Step> {
  const pub = originClient();
  const w = originWallet(key);
  try {
    const { request } = await pub.simulateContract({ account: w.account, address, abi, functionName, args });
    const hash = await w.writeContract(request);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") return { label, hash, refused: "reverted" };
    return { label, hash };
  } catch (e) {
    return { label, refused: reason(e) };
  }
}

/** Why the vault would refuse a habit purchase right now (same checks as ReinsVault.spend). */
export async function spendRefusal(user: Address, habitId: number, amount: number): Promise<string | null> {
  const pub = originClient();
  const V = { address: DEPLOYED.vault!, abi: ReinsVault.abi } as const;
  const [h, g, bal] = await Promise.all([
    pub.readContract({ ...V, functionName: "habitOf", args: [user, BigInt(habitId)] }) as Promise<[string, bigint, bigint, boolean]>,
    pub.readContract({ ...V, functionName: "guardOf", args: [user] }) as Promise<[boolean, boolean, bigint, bigint, bigint, bigint]>,
    pub.readContract({ ...V, functionName: "balanceOf", args: [user] }) as Promise<bigint>,
  ]);
  if (!h[3]) return "habit switched off";
  if (usd(amount) > h[1]) return "over habit limit";
  if (!g[0] || ((g[3] >> BigInt(habitId)) & BigInt(1)) === BigInt(0)) return g[1] ? "paused by Reins Guard (Safe Mode)" : "paused by Reins Guard (not enough left this week)";
  if (bal < usd(amount)) return "not enough in pot";
  return null;
}

/** First visit: a little gas, test dollars, and the starter rules (floor, two bills, two habits). */
export async function setup(key: Hex, user: Address): Promise<Step[]> {
  const pub = originClient();
  const steps: Step[] = [];
  const [gas, price] = await Promise.all([pub.getBalance({ address: user }), pub.getGasPrice()]);
  // Enough for ~30 demo transactions at today's gas price, never less than 0.0003 ETH
  const want = price * BigInt(6_000_000) > parseEther("0.0003") ? price * BigInt(6_000_000) : parseEther("0.0003");
  if (gas < want / BigInt(3)) {
    const dw = originWallet(process.env.DEPLOYER_PRIVATE_KEY as Hex);
    const hash = await dw.sendTransaction({ to: user, value: want });
    await pub.waitForTransactionReceipt({ hash });
    steps.push({ label: "Gas for your demo wallet", hash });
  }
  void deployerAccount;
  const V = DEPLOYED.vault!, U = DEPLOYED.usd!;
  steps.push(await call(key, "Test money: 400 rUSD to your wallet", U, TestUSD.abi, "mint", [user, usd(400)]));
  steps.push(await call(key, "Let the vault take deposits", U, TestUSD.abi, "approve", [V, BigInt(2) ** BigInt(256) - BigInt(1)]));
  steps.push(await call(key, `Safety floor: $${FLOOR}`, V, ReinsVault.abi, "setFloor", [usd(FLOOR)]));
  const now = BigInt(Math.floor(Date.now() / 1000));
  for (const b of BILLS)
    steps.push(await call(key, `Bill: ${b.name} $${b.amount}, due in ${b.dueInDays} days`, V, ReinsVault.abi, "addBill",
      [b.name, deployerAccount().address, usd(b.amount), now + BigInt(b.dueInDays * 86400), BigInt(b.everyDays * 86400)]));
  for (const h of HABITS)
    steps.push(await call(key, `Habit: ${h.name}, up to $${h.cap} a time, $${h.weekly} a week`, V, ReinsVault.abi, "setHabit",
      [BigInt(h.id), h.name, usd(h.cap), usd(h.weekly), true]));
  return steps;
}
