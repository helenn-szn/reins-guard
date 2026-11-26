import { concat, keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Every visitor gets their own demo wallet on Base Sepolia, derived on the server from a
// random id kept in their browser. Keys never reach the browser.
export const WALLET_HEADER = "x-guard-wallet";

export function visitorKey(req: Request): Hex | null {
  const id = req.headers.get(WALLET_HEADER);
  const secret = process.env.DEPLOYER_PRIVATE_KEY as Hex | undefined;
  if (!id || !/^[0-9a-f]{32}$/.test(id) || !secret) return null;
  return keccak256(concat([secret, toHex(`reins-guard-user:${id}`)]));
}

export const addressOf = (key: Hex) => privateKeyToAccount(key).address;
