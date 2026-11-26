"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Bill = { id: number; name: string; amount: number; dueAt: number; active: boolean; everyDays: number };
type Habit = { id: number; name: string; cap: number; weekly: number; enabled: boolean; allowed: boolean };
type Decision = { hash: string; block: number; safeMode: boolean; free: number; mask: number; at: number };
type State = {
  deployed: boolean;
  deployments: { usd?: string; vault?: string; reactive?: string; rvm?: string };
  user?: string;
  started?: boolean;
  wallet?: number;
  pot?: number;
  floor?: number;
  bills?: Bill[];
  habits?: Habit[];
  guard?: { evaluated: boolean; safeMode: boolean; free: number; mask: number; at: number; updatedAt: number };
  decisions?: Decision[];
};
type Step = { label: string; hash?: string; refused?: string };
type Entry = { kind: "you"; time: number; step: Step } | { kind: "guard"; time: number; d: Decision };

const BASESCAN = "https://sepolia.basescan.org";
const REACTSCAN = "https://lasna.reactscan.net";
const HORIZON = 14 * 86400;
const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
const short = (h?: string) => (h ? `${h.slice(0, 6)}…${h.slice(-4)}` : "");

function walletId() {
  let id: string | null = null;
  try { id = localStorage.getItem("reins-guard-wallet"); } catch {}
  if (!id) {
    id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    try { localStorage.setItem("reins-guard-wallet", id); } catch {}
  }
  return id;
}

export default function GuardApp() {
  const [id, setId] = useState<string | null>(null);
  const [s, setS] = useState<State | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<{ time: number; step: Step }[]>([]);
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => { setId(walletId()); }, []);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const r = await fetch("/api/state", { headers: { "x-guard-wallet": id }, cache: "no-store" });
      const j = (await r.json()) as State;
      setS(j);
    } catch {}
  }, [id]);

  useEffect(() => {
    load();
    timer.current = setInterval(load, 4000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [load]);

  // Stop "waiting" once a decision based on our latest action has landed
  useEffect(() => {
    if (!waitingSince || !s?.decisions?.length) return;
    if (s.decisions.some((d) => d.at >= waitingSince - 5)) setWaitingSince(null);
  }, [s, waitingSince]);
  useEffect(() => {
    if (!waitingSince) return;
    const t = setTimeout(() => setWaitingSince(null), 150_000);
    return () => clearTimeout(t);
  }, [waitingSince]);

  async function act(action: string, amount?: number, label?: string) {
    if (!id) return;
    setBusy(label ?? action);
    setError(null);
    const started = Math.floor(Date.now() / 1000);
    try {
      const r = await fetch("/api/act", { method: "POST", headers: { "content-type": "application/json", "x-guard-wallet": id }, body: JSON.stringify({ action, amount }) });
      const j = (await r.json()) as { steps?: Step[]; error?: string };
      if (!r.ok || !j.steps) throw new Error(j.error ?? "Something went wrong");
      const now = Date.now();
      setLog((l) => [...l, ...j.steps!.map((step, i) => ({ time: now + i, step }))]);
      if (j.steps.some((st) => st.hash && !st.refused)) setWaitingSince(started);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (!s) return <Shell><p className="py-24 text-center text-stone-400">Loading…</p></Shell>;
  if (!s.deployed) return <Shell><Hero /><p className="mt-8 rounded-2xl border border-stone-800 bg-stone-900/60 p-5 text-stone-300">The contracts are being deployed. Check back soon.</p></Shell>;

  if (!s.started) {
    return (
      <Shell>
        <Hero />
        <div className="mt-8 rounded-2xl border border-stone-800 bg-stone-900/60 p-5">
          <h2 className="text-lg font-semibold">Try it with a demo wallet</h2>
          <p className="mt-1 text-sm text-stone-400">
            You get your own wallet on Base Sepolia with test money and a starter budget: a ${20} safety floor, rent ($150, due in 10 days), a phone bill ($40, due in 20 days), coffee and food delivery. No sign-up or MetaMask needed.
          </p>
          <button onClick={() => act("setup", undefined, "Setting up")} disabled={!!busy} className="mt-4 rounded-full bg-brand-500 px-5 py-2.5 font-semibold text-black hover:bg-brand-400 disabled:opacity-60">
            {busy ? "Setting up your wallet… (about 30 seconds)" : "Start the demo"}
          </button>
          {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
          {log.length > 0 && <StepList steps={log.map((l) => l.step)} />}
        </div>
        <HowItWorks s={s} />
      </Shell>
    );
  }

  const g = s.guard!;
  const now = Math.floor(Date.now() / 1000);
  const billsDue = (s.bills ?? []).filter((b) => b.active && b.dueAt <= now + HORIZON);
  const need = (s.floor ?? 0) + billsDue.reduce((a, b) => a + b.amount, 0);
  const entries: Entry[] = [
    ...log.filter((l) => l.step.label && !l.step.label.startsWith("Gas")).map((l) => ({ kind: "you" as const, time: l.time, step: l.step })),
    ...(s.decisions ?? []).map((d) => ({ kind: "guard" as const, time: d.at * 1000 + 1, d })),
  ].sort((a, b) => b.time - a.time);

  return (
    <Shell>
      <header className="flex items-center justify-between gap-3">
        <Brand />
        <a href={`${BASESCAN}/address/${s.user}`} target="_blank" className="font-mono text-xs text-stone-400 hover:text-stone-200">Your wallet {short(s.user)}</a>
      </header>

      {/* Decision */}
      <section className={`mt-6 rounded-3xl p-6 ${!g.evaluated ? "bg-stone-900" : g.safeMode ? "bg-safe-600/25 ring-1 ring-safe-500/50" : "bg-stone-900 ring-1 ring-brand-500/40"}`}>
        {!g.evaluated ? (
          <p className="text-stone-300">Waiting for Reins Guard's first decision…</p>
        ) : g.safeMode ? (
          <>
            <p className="text-sm font-semibold text-safe-300">Safe Mode is on</p>
            <p className="mt-1 text-3xl font-bold">Short {money(-g.free)}</p>
            <p className="mt-2 text-sm text-stone-300">Your pot doesn't cover the next 2 weeks of bills plus your safety floor, so every habit is paused. Bills can still be paid.</p>
          </>
        ) : (
          <>
            <p className="text-sm font-semibold text-brand-400">Free to spend</p>
            <p className="mt-1 text-4xl font-bold">{money(g.free)}</p>
            <p className="mt-2 text-sm text-stone-300">After the next 2 weeks of bills and your safety floor. Habits switch back on only if this still covers their weekly amount.</p>
          </>
        )}
        <dl className="mt-5 grid grid-cols-3 gap-2 text-sm">
          <Stat label="In your pot" value={money(s.pot ?? 0)} />
          <Stat label="Bills in next 14 days" value={money(need - (s.floor ?? 0))} />
          <Stat label="Safety floor" value={money(s.floor ?? 0)} />
        </dl>
        {waitingSince && (
          <p className="mt-4 flex items-center gap-2 text-sm text-stone-300">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-brand-500" /> Reins Guard on Reactive Network is checking your pot…
          </p>
        )}
        {g.updatedAt > 0 && !waitingSince && <p className="mt-4 text-xs text-stone-500">Decided by the reactive contract, delivered {new Date(g.updatedAt * 1000).toLocaleTimeString()}</p>}
      </section>

      {/* Actions */}
      <section className="mt-6 grid gap-4 sm:grid-cols-2">
        <Card title="Money in">
          <p className="text-sm text-stone-400">Your wallet has {money(s.wallet ?? 0)} of test money. A top-up is a deposit into the vault on Base Sepolia.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {[40, 60, 100].map((n) => (
              <Btn key={n} onClick={() => act("deposit", n, `Deposit $${n}`)} busy={busy} label={`Deposit $${n}`} />
            ))}
          </div>
        </Card>
        <Card title="Habits">
          <ul className="space-y-2">
            {(s.habits ?? []).map((h) => (
              <li key={h.id} className="flex items-center justify-between gap-2">
                <div>
                  <p className="font-medium">{h.name}</p>
                  <p className="text-xs text-stone-400">Up to {money(h.cap)} a time · needs {money(h.weekly)} free</p>
                </div>
                <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${h.allowed ? "bg-brand-500/20 text-brand-400" : "bg-safe-600/30 text-safe-300"}`}>{h.allowed ? "Allowed" : "Paused"}</span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <Btn onClick={() => act("coffee", undefined, "Buy coffee")} busy={busy} label="Buy coffee $4.13" />
            <Btn onClick={() => act("food", undefined, "Order food")} busy={busy} label="Order food $12" />
          </div>
        </Card>
        <Card title="Bills" className="sm:col-span-2">
          <ul className="divide-y divide-stone-800">
            {(s.bills ?? []).map((b) => {
              const days = Math.ceil((b.dueAt - now) / 86400);
              const counted = b.active && b.dueAt <= now + HORIZON;
              return (
                <li key={b.id} className="flex items-center justify-between gap-3 py-2">
                  <div>
                    <p className="font-medium">{b.name} {money(b.amount)}</p>
                    <p className="text-xs text-stone-400">
                      {b.active ? (days <= 0 ? "Due now" : `Due in ${days} day${days === 1 ? "" : "s"}`) : "Paid"}
                      {b.active && b.everyDays > 0 ? `, then every ${b.everyDays} days` : ""}
                      {counted ? " · kept aside now" : b.active ? " · not counted yet (more than 14 days away)" : ""}
                    </p>
                  </div>
                  {b.active && <Btn onClick={() => act("payBill", b.id, `Pay ${b.name}`)} busy={busy} label="Pay" />}
                </li>
              );
            })}
          </ul>
        </Card>
      </section>
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

      {/* Activity */}
      <section className="mt-8">
        <h2 className="text-lg font-semibold">What happened</h2>
        <p className="text-sm text-stone-400">Your transactions on Base Sepolia, and the decisions Reins Guard sent back from Reactive Network.</p>
        <ul className="mt-3 space-y-2">
          {entries.slice(0, 25).map((e, i) => (
            <li key={i} className="rounded-2xl border border-stone-800 bg-stone-900/50 px-4 py-3 text-sm">
              {e.kind === "you" ? (
                <div className="flex items-center justify-between gap-3">
                  <span>
                    <span className="text-stone-400">You · </span>
                    {e.step.label}
                    {e.step.refused && <span className="text-safe-300"> · Vault refused: {e.step.refused}</span>}
                  </span>
                  {e.step.hash && <TxLink hash={e.step.hash} />}
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <span>
                    <span className="text-brand-400">Reins Guard · </span>
                    {e.d.safeMode ? `Safe Mode on, short ${money(-e.d.free)}` : `Free to spend ${money(e.d.free)}`}
                    {!e.d.safeMode && `, ${habitNames(e.d.mask, s.habits ?? [])}`}
                  </span>
                  <TxLink hash={e.d.hash} label="callback" />
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
      <HowItWorks s={s} />
    </Shell>
  );
}

function habitNames(mask: number, habits: Habit[]) {
  const on = habits.filter((h) => (mask >> h.id) & 1).map((h) => h.name.toLowerCase());
  return on.length ? `${on.join(" and ")} allowed` : "habits paused";
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto max-w-3xl px-4 pb-16 pt-6 sm:pt-10">{children}</main>;
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/icon.svg" alt="" className="h-8 w-8" />
      <span className="text-lg font-bold">Reins Guard</span>
    </div>
  );
}

function Hero() {
  return (
    <>
      <Brand />
      <h1 className="mt-10 text-4xl font-bold leading-tight sm:text-5xl">Bills first.<br />Coffee only if there's enough left.</h1>
      <p className="mt-4 max-w-xl text-lg text-stone-300">
        Reins Guard is a reactive contract on Reactive Network. Every time money comes in or goes out of your pot, it works out what's really free after the next 2 weeks of bills and your safety floor, and switches your habits on or off. It keeps working while the Reins app and its AI are offline.
      </p>
    </>
  );
}

function HowItWorks({ s }: { s: State }) {
  const d = s.deployments;
  return (
    <section className="mt-10 rounded-2xl border border-stone-800 p-5 text-sm text-stone-300">
      <h2 className="text-base font-semibold text-stone-100">How it works</h2>
      <ol className="mt-2 list-decimal space-y-1.5 pl-5">
        <li>Your pot is the <b>ReinsVault</b> contract on Base Sepolia. It holds the money, bills, safety floor and habits, and emits an event for every change.</li>
        <li><b>ReinsGuardReactive</b> on Reactive Network (Lasna) subscribes to those events and keeps its own running copy of your budget. It also wakes up on Reactive's timer, about every 2 hours, so a bill coming due is noticed with nothing else happening.</li>
        <li>It decides: bills due in the next 14 days + safety floor first; Safe Mode if the pot falls short; otherwise habits switch back on in order, each only if what's left covers its weekly amount.</li>
        <li>It calls the vault back with that decision. The vault refuses any habit purchase the guard hasn't allowed. Bills can always be paid.</li>
      </ol>
      <p className="mt-3 text-stone-400">No keepers, no relayers, no server watching your balance.</p>
      {d.vault && (
        <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs">
          <a className="text-brand-400 hover:underline" target="_blank" href={`${BASESCAN}/address/${d.vault}`}>Vault {short(d.vault)}</a>
          {d.reactive && <a className="text-brand-400 hover:underline" target="_blank" href={`${REACTSCAN}/address/${d.reactive}`}>Reactive contract {short(d.reactive)}</a>}
          {d.usd && <a className="text-brand-400 hover:underline" target="_blank" href={`${BASESCAN}/address/${d.usd}`}>rUSD {short(d.usd)}</a>}
          <a className="text-brand-400 hover:underline" target="_blank" href="https://github.com/helenn-szn/reins-guard">Code</a>
        </p>
      )}
    </section>
  );
}

function Card({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-stone-800 bg-stone-900/60 p-5 ${className}`}>
      <h2 className="mb-2 font-semibold">{title}</h2>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-black/30 px-3 py-2">
      <dt className="text-xs text-stone-400">{label}</dt>
      <dd className="font-semibold">{value}</dd>
    </div>
  );
}

function Btn({ onClick, busy, label }: { onClick: () => void; busy: string | null; label: string }) {
  return (
    <button onClick={onClick} disabled={!!busy} className="rounded-full border border-stone-700 px-3.5 py-1.5 text-sm font-medium hover:border-brand-500 hover:text-brand-400 disabled:opacity-50">
      {busy === label || busy === label.replace(/ \$[\d.]+$/, "") ? "Sending…" : label}
    </button>
  );
}

function TxLink({ hash, label = "tx" }: { hash: string; label?: string }) {
  return <a href={`${BASESCAN}/tx/${hash}`} target="_blank" className="shrink-0 font-mono text-xs text-brand-400 hover:underline">{label} {short(hash)}</a>;
}

function StepList({ steps }: { steps: Step[] }) {
  return (
    <ul className="mt-4 space-y-1 text-sm">
      {steps.map((st, i) => (
        <li key={i} className="flex justify-between gap-2">
          <span className={st.refused ? "text-red-400" : "text-stone-300"}>{st.refused ? "✗" : "✓"} {st.label}{st.refused ? `: ${st.refused}` : ""}</span>
          {st.hash && <TxLink hash={st.hash} />}
        </li>
      ))}
    </ul>
  );
}
