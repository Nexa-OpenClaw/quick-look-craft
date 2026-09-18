import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { GhostLogo, labelForDb, loadJobs, loadLog, type LogEntry, type ScheduledJob } from "./index";

export const Route = createFileRoute("/terminal")({
  head: () => ({
    meta: [
      { title: "Terminal — Ghost SMS" },
      { name: "description", content: "Live terminal for the Ghost SMS fleet: success/fail counters and the raw commands dispatched to each device." },
      { property: "og:title", content: "Ghost SMS · Terminal" },
      { property: "og:description", content: "Live command feed and delivery stats for the Ghost SMS fleet." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: TerminalPage,
});

function TerminalPage() {
  const [log, setLog] = useState<LogEntry[]>([]);
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [filter, setFilter] = useState<"all" | "ok" | "failed">("all");

  useEffect(() => {
    const refresh = () => { setLog(loadLog()); setJobs(loadJobs()); };
    refresh();
    const t = setInterval(refresh, 1000);
    const onStorage = () => refresh();
    window.addEventListener("storage", onStorage);
    return () => { clearInterval(t); window.removeEventListener("storage", onStorage); };
  }, []);

  const stats = useMemo(() => {
    const ok = log.filter((e) => e.status === "ok").length;
    const fail = log.filter((e) => e.status === "failed").length;
    const pendingJobs = jobs.filter((j) => j.status === "pending").length;
    return { ok, fail, total: log.length, pendingJobs };
  }, [log, jobs]);

  const filtered = useMemo(() => {
    if (filter === "all") return log;
    return log.filter((e) => e.status === filter);
  }, [log, filter]);

  const clearLog = () => {
    window.localStorage.setItem("ghost:log", "[]");
    setLog([]);
  };

  return (
    <div className="min-h-screen bg-[#07070a] text-neutral-100 font-[Inter,system-ui,sans-serif]">
      <header className="border-b border-white/5">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-4">
          <GhostLogo />
          <div className="leading-tight">
            <div className="text-base font-semibold tracking-[0.2em]">GHOST<span className="text-violet-400">SMS</span> · <span className="text-emerald-400">TERMINAL</span></div>
            <div className="text-[10px] uppercase tracking-widest text-neutral-500">Live command feed</div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Link to="/" className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-neutral-200 hover:bg-white/10">
              ← Dashboard
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-24 pt-6">
        {/* stats */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatBox label="Sent OK" value={stats.ok} tone="emerald" />
          <StatBox label="Failed" value={stats.fail} tone="rose" />
          <StatBox label="Total dispatched" value={stats.total} tone="neutral" />
          <StatBox label="Pending jobs" value={stats.pendingJobs} tone="sky" />
        </div>

        {/* controls */}
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <div className="flex rounded-full border border-white/10 bg-white/5 p-1 text-xs">
            {(["all","ok","failed"] as const).map((f) => (
              <button key={f} onClick={() => setFilter(f)}
                className={"rounded-full px-3 py-1 capitalize " +
                  (filter === f
                    ? f === "ok" ? "bg-emerald-500 text-black"
                    : f === "failed" ? "bg-rose-500 text-black"
                    : "bg-white text-black"
                    : "text-neutral-400 hover:text-neutral-200")}>
                {f}
              </button>
            ))}
          </div>
          <span className="text-xs text-neutral-500">{filtered.length} entries</span>
          <button onClick={clearLog} className="ml-auto rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs hover:bg-white/10">Clear log</button>
        </div>

        {/* terminal */}
        <div className="mt-4 overflow-hidden rounded-2xl border border-white/10 bg-black shadow-inner">
          <div className="flex items-center gap-2 border-b border-white/5 bg-white/[0.02] px-4 py-2">
            <span className="h-2.5 w-2.5 rounded-full bg-rose-500" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
            <span className="ml-3 font-mono text-[11px] text-neutral-500">ghost@fleet ~ tail -f dispatch.log</span>
          </div>
          <div className="max-h-[70vh] overflow-y-auto p-4 font-mono text-[12px] leading-relaxed">
            {filtered.length === 0 && (
              <div className="py-10 text-center text-neutral-600">no log entries yet — dispatch a broadcast from the dashboard.</div>
            )}
            {filtered.map((e) => <LogRow key={e.id} e={e} />)}
          </div>
        </div>
      </main>
    </div>
  );
}

function StatBox({ label, value, tone }: { label: string; value: number; tone: "emerald" | "rose" | "neutral" | "sky" }) {
  const map = {
    emerald: "border-emerald-500/25 bg-emerald-500/[0.06] text-emerald-100",
    rose:    "border-rose-500/25 bg-rose-500/[0.06] text-rose-100",
    neutral: "border-white/10 bg-white/[0.02] text-neutral-100",
    sky:     "border-sky-500/25 bg-sky-500/[0.06] text-sky-100",
  } as const;
  return (
    <div className={"rounded-2xl border p-4 " + map[tone]}>
      <div className="text-[10px] uppercase tracking-widest text-neutral-400">{label}</div>
      <div className="mt-1 text-3xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function LogRow({ e }: { e: LogEntry }) {
  const [open, setOpen] = useState(false);
  const time = new Date(e.ts).toLocaleTimeString();
  const okColor = e.status === "ok" ? "text-emerald-400" : "text-rose-400";
  const marker = e.status === "ok" ? "✓" : "✗";
  return (
    <div className="border-b border-white/[0.03] py-1.5">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-start gap-3 text-left hover:bg-white/[0.02]">
        <span className="text-neutral-600">{time}</span>
        <span className={okColor}>{marker}</span>
        <span className="text-neutral-300">PUT</span>
        <span className="truncate text-violet-300">{e.request.url.replace(/^https?:\/\//, "")}</span>
        <span className="ml-auto text-neutral-500">
          → <span className="text-neutral-300">{e.number}</span> · SIM {Number(e.sim) + 1} · {labelForDb(e.dbUrl)}
        </span>
      </button>
      {open && (
        <div className="mt-1 space-y-1 rounded-md bg-white/[0.02] p-3 text-[11px] text-neutral-300">
          <div><span className="text-neutral-500">device</span> {e.deviceId}</div>
          <div><span className="text-neutral-500">message</span> {JSON.stringify(e.message)}</div>
          <div><span className="text-neutral-500">http</span> {e.httpStatus ?? "—"} {e.error ? <span className="text-rose-400">· {e.error}</span> : null}</div>
          <div>
            <div className="text-neutral-500">request body</div>
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded bg-black/60 p-2 text-neutral-300">{JSON.stringify(e.request.body, null, 2)}</pre>
          </div>
          {e.response && (
            <div>
              <div className="text-neutral-500">response</div>
              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded bg-black/60 p-2 text-neutral-300">{e.response.slice(0, 500)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
