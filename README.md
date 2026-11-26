# Reins Guard

**Bills first. Coffee only if there's enough left.**

Reins Guard is a reactive contract that protects a spending pot while the AI agent that spends from it is offline. Every time money comes into or goes out of the pot, it works out what is really free to spend after the next 2 weeks of bills and the user's safety floor, then switches the user's habits on or off. No keepers, no relayers, no server watching the balance.

Built for the [Reactive Omni Buildathon](https://dorahacks.io/hackathon/reactive-omni-buildathon), **Set It and Forget It** track.

- **Live demo:** _link coming after deployment_
- **Demo video:** _coming soon_

## The problem

[Reins](https://github.com/helenn-szn/reins) is an AI agent that pays for your everyday habits, such as your morning coffee, within limits you set. It already has a Safe Mode: if your money can't cover the next 2 weeks of bills plus a safety floor, it pauses lifestyle spending.

But that check lives in the Reins app. If the app is closed, nothing notices when:

- a deposit lands while you're in Safe Mode. How much of it is actually free to spend?
- a bill gets paid. It should stop being counted.
- time passes and a bill comes within the 2-week window.

And a rule that only lives in the AI's server is only as strong as that server.

## What Reins Guard does

```
 Base Sepolia                         Reactive Network (Lasna)
┌───────────────────────┐   events   ┌──────────────────────────────┐
│ ReinsVault            │ ─────────▶ │ ReinsGuardReactive           │
│ pot, bills, floor,    │            │ keeps its own copy of the    │
│ habits; pays bills    │            │ budget (persistent state),   │
│ and habit purchases   │ ◀───────── │ decides, and calls back      │
└───────────────────────┘  callback  └──────────────────────────────┘
                                        ▲ Cron1000 timer (~2 h)
```

1. **ReinsVault** (Base Sepolia) holds the user's money, their bills (amount, due date, repeat interval), safety floor and habits (max per purchase, and how much to keep aside each week before it may run). It emits an event for every change: `Deposited`, `Withdrawn`, `FloorSet`, `BillSet`, `BillPaid`, `HabitSet`, `Spent`.
2. **ReinsGuardReactive** (Reactive Lasna) subscribes to those events and keeps a running copy of each user's budget in its ReactVM. After every event, and on Reactive's `Cron1000` timer, it decides:
   - `need` = safety floor + every unpaid bill due in the next 14 days
   - `free` = pot - need
   - `free < 0`: **Safe Mode on**, every habit paused
   - otherwise Safe Mode is off, and habits switch back on in order, each only if what's left still covers its weekly amount
3. It calls `applyGuard()` on the vault with the decision. It calls back only when the decision or the free amount changes, and a timer tick calls back only if the decision itself changes.
4. The vault **refuses any habit purchase the guard hasn't allowed** (`paused by Reins Guard`). Bills can always be paid, because they are what Safe Mode protects.

### Cases it handles

| What happens | What the guard does |
| --- | --- |
| Deposit while in Safe Mode, but not enough | Safe Mode stays on, and the shortfall updates (short $70, then short $10) |
| Deposit that covers bills + floor + coffee's weekly amount | Safe Mode off, coffee back on, food still paused |
| A bill is paid | It's counted once; a repeating bill moves to its next due date and leaves the 14-day window |
| Coffee purchases eat into the weekly amount | Coffee pauses itself before the money runs out |
| Nothing happens, but a bill comes within 14 days | The timer notices and pauses habits |
| A late callback arrives after a newer one | The vault ignores it (`at` is older than the current decision) |

## How it fits with Reins and AI

Reins' AI (SERV Reasoning) still decides whether a purchase looks like you. Reins Guard is the layer underneath that the AI can't overrule and doesn't need to be online for: the agent can call `vault.spend()` for the user (`setAgent`), and the vault only lets it through if the guard says the money is really free.

## Try it

Open the live demo and click **Start the demo**. You get your own wallet on Base Sepolia with 400 test dollars (rUSD) and a starter budget: a $20 floor, rent ($150, due in 10 days), a phone bill ($40, due in 20 days), coffee (up to $5, $25 a week) and food delivery (up to $15, $60 a week). No sign-up or MetaMask is needed.

Then try:

1. **Buy coffee** with an empty pot: the vault refuses it, *paused by Reins Guard (Safe Mode)*.
2. **Deposit $100**: still short ($100 < $150 rent + $20 floor), so Safe Mode stays on, short $70.
3. **Deposit $100** again: free is $30, so coffee comes back on (it needs $25) and food stays paused (it needs $60).
4. **Buy coffee** twice: once free drops under $25, coffee pauses itself.
5. **Pay rent**: it's paid once and its next due date is 40 days away, so it stops being counted.

Every row in *What happened* links to the Base Sepolia transaction, and every *Reins Guard* row is a callback transaction delivered by Reactive Network.

## Deployed contracts

| Contract | Network | Address |
| --- | --- | --- |
| ReinsVault | Base Sepolia (84532) | _pending_ |
| TestUSD (rUSD) | Base Sepolia (84532) | _pending_ |
| ReinsGuardReactive | Reactive Lasna (5318007) | _pending_ |

### The full loop on-chain

_Transaction hashes: origin event on Base Sepolia → reactive transaction on Lasna → callback on Base Sepolia. Added after deployment._

## Run it yourself

```bash
npm install
npm run compile          # compiles contracts/src with solc 0.8.28 into contracts/out
npm run test:contracts   # simulates the whole loop on a local chain
```

The contract test runs the vault and the reactive contract on a local chain and plays the part of Reactive Network: it feeds each vault log to `react()` and delivers each `Callback` to the vault through a stand-in proxy. It checks every case in the table above, including the timer.

To run the web app against a local chain:

```bash
node scripts/local-sim.mjs     # prints the env vars to use
env <those vars> npm run dev
```

To deploy, set the variables in `.env.example`, fund the deployer with Base Sepolia ETH, and call the protected `/api/admin` steps in order: `faucet` (Base Sepolia ETH to Lasna REACT), `usd`, `vault`, then `reactive`. The same wallet must deploy both the vault and the reactive contract, because its address is the ReactVM id that the vault trusts for callbacks.

## Project map

| Path | What it does |
| --- | --- |
| `contracts/src/ReinsVault.sol` | The pot: deposits, bills, floor, habits, payments; origin of events and destination of callbacks |
| `contracts/src/ReinsGuardReactive.sol` | The reactive contract: subscriptions, persistent budget state, decision, callbacks, timer |
| `contracts/src/TestUSD.sol` | Test dollar with a public mint for the demo |
| `contracts/test/guard.test.mjs` | End-to-end simulation of the loop |
| `src/app/api/act` | Demo actions from each visitor's own wallet |
| `src/app/api/state` | Reads the pot, rules and the guard's decisions from the vault |
| `src/app/api/admin` | Protected deployment steps |
| `src/components/GuardApp.tsx` | The demo page |

Contracts build on [reactive-lib](https://github.com/Reactive-Network/reactive-lib) (`AbstractReactive`, `AbstractCallback`).

## Honest limits

- The demo wallets are created and paid for by the server so anyone can try it in one click. In Reins, the user's own wallet or Kite Agent Passport would own the pot.
- The guard only knows what the vault tells it. Bills paid outside the vault aren't seen.
- One timer (about every 2 hours) re-checks every user, which is fine for a demo but would need batching for many users.

## License

[MIT](LICENSE)
