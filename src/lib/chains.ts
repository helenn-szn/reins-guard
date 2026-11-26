import { createPublicClient, createWalletClient, defineChain, http, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

export const lasna = defineChain({
  id: 5318007,
  name: "Reactive Lasna",
  nativeCurrency: { name: "Lasna REACT", symbol: "lREACT", decimals: 18 },
  rpcUrls: { default: { http: ["https://lasna-rpc.rnk.dev/"] } },
  blockExplorers: { default: { name: "Reactscan", url: "https://lasna.reactscan.net" } },
});

export const origin = baseSepolia;
export const ORIGIN_RPC = process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org";

// Reactive Network addresses (dev.reactive.network/origins-and-destinations, /reactive-mainnet)
export const CALLBACK_PROXY_BASE_SEPOLIA = "0x476F44b11F5C942c58f4c8E3d0300E5710743585";
export const LASNA_FAUCET_BASE_SEPOLIA = "0x2afaFD298b23b62760711756088F75B7409f5967";
// Reactive CRON topics: Cron1000 fires every 1,000 Reactive blocks (about 2 hours)
export const CRON_1000 = BigInt("0xe20b31294d84c3661ddc8f423abb9c70310d0cf172aa2714ead78029b325e3f4");

export const BASESCAN = "https://sepolia.basescan.org";
export const REACTSCAN = "https://lasna.reactscan.net";

export const originClient = () => createPublicClient({ chain: origin, transport: http(ORIGIN_RPC) });
export const lasnaClient = () => createPublicClient({ chain: lasna, transport: http() });

export function deployerAccount() {
  const k = process.env.DEPLOYER_PRIVATE_KEY as Hex | undefined;
  if (!k) throw new Error("DEPLOYER_PRIVATE_KEY is not set");
  return privateKeyToAccount(k);
}
export const originWallet = (key: Hex) => createWalletClient({ account: privateKeyToAccount(key), chain: origin, transport: http(ORIGIN_RPC) });
export const lasnaWallet = (key: Hex) => createWalletClient({ account: privateKeyToAccount(key), chain: lasna, transport: http() });
