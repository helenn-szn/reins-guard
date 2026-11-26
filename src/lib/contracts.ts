import usd from "../../contracts/out/TestUSD.json";
import vault from "../../contracts/out/ReinsVault.json";
import guard from "../../contracts/out/ReinsGuardReactive.json";
import deployments from "../../deployments.json";
import type { Abi, Address, Hex } from "viem";

export const TestUSD = usd as { abi: Abi; bytecode: Hex };
export const ReinsVault = vault as { abi: Abi; bytecode: Hex };
export const ReinsGuardReactive = guard as { abi: Abi; bytecode: Hex };

export type Deployments = { usd?: Address; vault?: Address; reactive?: Address; rvm?: Address; vaultBlock?: number };
export const DEPLOYED: Deployments = {
  ...(deployments as Deployments),
  ...(process.env.USD_ADDRESS ? { usd: process.env.USD_ADDRESS as Address } : {}),
  ...(process.env.VAULT_ADDRESS ? { vault: process.env.VAULT_ADDRESS as Address } : {}),
  ...(process.env.REACTIVE_ADDRESS ? { reactive: process.env.REACTIVE_ADDRESS as Address } : {}),
};

// Demo habits and bills every new visitor starts with (amounts in rUSD, 6 decimals)
export const HABITS = [
  { id: 0, name: "Coffee", cap: 5, weekly: 25 },
  { id: 1, name: "Food delivery", cap: 15, weekly: 60 },
];
export const BILLS = [
  { name: "Rent", amount: 150, dueInDays: 10, everyDays: 30 },
  { name: "Phone", amount: 40, dueInDays: 20, everyDays: 30 },
];
export const FLOOR = 20;
export const HORIZON_DAYS = 14;
