import { DEPLOYED, ReinsVault } from "@/lib/contracts";
import { addressOf, visitorKey } from "@/lib/wallets";
import { call, setup, spendRefusal, usd } from "@/lib/vault";
import { deployerAccount } from "@/lib/chains";

export const maxDuration = 120;

const recent = new Map<string, number[]>(); // per-IP setup limit

// Demo actions, sent from the visitor's own wallet. Each one is a real Base Sepolia transaction;
// Reins Guard on Reactive Network sees it and calls the vault back with its decision.
export async function POST(req: Request) {
  const key = visitorKey(req);
  if (!key || !DEPLOYED.vault) return Response.json({ error: "Reload the page and try again." }, { status: 400 });
  const user = addressOf(key);
  const { action, amount } = (await req.json()) as { action: string; amount?: number };
  const V = DEPLOYED.vault;

  if (action === "setup") {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0] ?? "?";
    const times = (recent.get(ip) ?? []).filter((t) => Date.now() - t < 3600_000);
    if (times.length >= 5) return Response.json({ error: "Too many new demo wallets from here this hour. Try again later." }, { status: 429 });
    recent.set(ip, [...times, Date.now()]);
    return Response.json({ steps: await setup(key, user) });
  }
  if (action === "deposit") {
    const n = Math.min(Math.max(Number(amount) || 0, 1), 300);
    return Response.json({ steps: [await call(key, `Deposit $${n}`, V, ReinsVault.abi, "deposit", [usd(n)])] });
  }
  if (action === "coffee" || action === "food") {
    const [habit, price, label] = action === "coffee" ? [0, 4.13, "Buy coffee $4.13"] : [1, 12, "Order food $12.00"];
    const refused = await spendRefusal(user, habit, price);
    if (refused) return Response.json({ steps: [{ label, refused }] });
    return Response.json({ steps: [await call(key, label, V, ReinsVault.abi, "spend", [user, BigInt(habit), deployerAccount().address, usd(price)])] });
  }
  if (action === "payBill") {
    const id = Number(amount) || 0;
    return Response.json({ steps: [await call(key, id === 0 ? "Pay rent" : "Pay phone bill", V, ReinsVault.abi, "payBill", [user, BigInt(id)])] });
  }
  return Response.json({ error: "Unknown action" }, { status: 400 });
}
