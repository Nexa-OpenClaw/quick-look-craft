import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clearJobsServer,
  deleteJobServer,
  executeBroadcastServer,
  fetchDevicesServer,
  getJobsServer,
  getSavedDbsServer,
  saveDbsServer,
  saveJobServer,
  updateJobServer,
} from "../lib/devices";
import { getDefaultDbEntries } from "../lib/default-databases";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Ghost SMS — Silent delivery through your device network" },
      { name: "description", content: "Ghost SMS: broadcast SMS through your Firebase-connected device fleet in realtime." },
      { property: "og:title", content: "Ghost SMS" },
      { property: "og:description", content: "Realtime SMS broadcasts through your device fleet." },
      { property: "og:type", content: "website" },

      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: GhostSmsPage,
});

/* ============================================================
 * Types / storage
 * ============================================================ */

export type DbEntry = { url: string; label?: string };

type DeviceInfo = {
  dbUrl: string;
  id: string;
  battery: number | null;
  online: boolean | null;
  loaded: boolean;
};

export type LogEntry = {
  id: string;
  ts: number;
  jobId: string;
  dbUrl: string;
  deviceId: string;
  number: string;
  message: string;
  sim: "0" | "1";
  request: { url: string; method: string; body: unknown };
  status: "ok" | "failed";
  httpStatus?: number;
  response?: string;
  error?: string;
};

export type ScheduledJob = {
  id: string;
  number: string;
  message: string;
  sim: "0" | "1";
  runAt: number;
  createdAt: number;
  status: "pending" | "running" | "done" | "cancelled";
  kind?: "realtime" | "schedule" | "cron";
  cronId?: string;
  totalTargets?: number;
  okCount?: number;
  failCount?: number;
};

export type CronJob = {
  id: string;
  number: string;
  message: string;
  sim: "0" | "1";
  startAt: number;
  intervalSec: number;
  runsSoFar: number;
  nextRunAt: number;
  createdAt: number;
  status: "active" | "paused";
};

export const LS_DBS = "ghost:dbs";
export const LS_JOBS = "ghost:jobs";
export const LS_LOG = "ghost:log";
export const LS_CRONS = "ghost:crons";
export const LS_DEVICES_CACHE = "ghost:cached_devices";

/* ============================================================
 * Helpers
 * ============================================================ */

export function extractFirebaseUrls(text: string): string[] {
  const re = /https?:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:firebaseio\.com|firebasedatabase\.app)(?:\/[^\s"',<>)]*)?/gi;
  const set = new Set<string>();
  for (const m of text.matchAll(re)) {
    let u = m[0].replace(/[),.;]+$/g, "");
    u = u.replace(/\/$/, "");
    set.add(u);
  }
  return [...set];
}

function parsePct(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const m = v.match(/(\d+(?:\.\d+)?)/);
    if (m && m[1]) return parseFloat(m[1]);
  }
  return null;
}
function parseStatus(v: unknown): boolean | null {
  return Boolean(v);
}
async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  try {
    const r = await fetch(url, signal ? { signal } : {});
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

export function labelForDb(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/\.firebaseio\.com$|\.firebasedatabase\.app$/, "");
  } catch { return url; }
}

export function loadDbs(): DbEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LS_DBS);
    if (!raw) return [];
    const arr = JSON.parse(raw) as DbEntry[];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
export function saveDbs(dbs: DbEntry[]) {
  window.localStorage.setItem(LS_DBS, JSON.stringify(dbs));
}
export function loadJobs(): ScheduledJob[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LS_JOBS);
    const arr = raw ? (JSON.parse(raw) as ScheduledJob[]) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
export function saveJobs(jobs: ScheduledJob[]) {
  window.localStorage.setItem(LS_JOBS, JSON.stringify(jobs));
}
export function loadLog(): LogEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LS_LOG);
    const arr = raw ? (JSON.parse(raw) as LogEntry[]) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
export function saveLog(log: LogEntry[]) {
  const trimmed = log.slice(0, 500);
  window.localStorage.setItem(LS_LOG, JSON.stringify(trimmed));
}
export function loadCrons(): CronJob[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LS_CRONS);
    const arr = raw ? (JSON.parse(raw) as CronJob[]) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
export function saveCrons(crons: CronJob[]) {
  window.localStorage.setItem(LS_CRONS, JSON.stringify(crons));
}
export function loadCachedDevices(): DeviceInfo[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LS_DEVICES_CACHE);
    const arr = raw ? (JSON.parse(raw) as DeviceInfo[]) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
export function saveCachedDevices(devices: DeviceInfo[]) {
  if (typeof window === "undefined") return;
  try {
    const trimmed = devices.slice(0, 3000);
    window.localStorage.setItem(LS_DEVICES_CACHE, JSON.stringify(trimmed));
  } catch { /* ignore */ }
}

/* ============================================================
 * Cloud mirror
 * ============================================================ */

function cloudBase(): string | null {
  const dbs = loadDbs();
  if (dbs.length === 0) return null;
  const first = dbs[0];
  return first ? first.url.replace(/\/$/, "") : null;
}
function cloudPut(path: string, body: unknown) {
  const base = cloudBase();
  if (!base) return;
  void fetch(`${base}/ghostSms/${path}.json`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).catch(() => {});
}
function cloudPatch(path: string, body: unknown) {
  const base = cloudBase();
  if (!base) return;
  void fetch(`${base}/ghostSms/${path}.json`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).catch(() => {});
}
async function cloudGet<T>(path: string): Promise<T | null> {
  const base = cloudBase();
  if (!base) return null;
  try {
    const r = await fetch(`${base}/ghostSms/${path}.json`);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch { return null; }
}
async function cloudDelete(path: string): Promise<void> {
  const base = cloudBase();
  if (!base) return;
  try { await fetch(`${base}/ghostSms/${path}.json`, { method: "DELETE" }); } catch { /* ignore */ }
}

/* ============================================================
 * Dispatch
 * ============================================================ */

async function dispatchToDevice(
  dbUrl: string, deviceId: string, number: string, message: string, sim: "0" | "1",
): Promise<{ ok: boolean; httpStatus?: number; error?: string; response?: string; request: { url: string; method: string; body: unknown } }> {
  const base = dbUrl.replace(/\/$/, "");
  const from = (Number(sim) + 1) as 1 | 2;
  const payload = { from, to: number, message, isSended: false };
  const request = { url: `${base}/clients/${deviceId}/webhookEvent/sendSms.json`, method: "PUT", body: payload };
  try {
    const primary = await fetch(request.url, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const responseText = await primary.text().catch(() => "");
    if (!primary.ok) return { ok: false, httpStatus: primary.status, error: `HTTP ${primary.status}`, response: responseText, request };
    return { ok: true, httpStatus: primary.status, response: responseText, request };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg, request };
  }
}

/* ============================================================
 * Root page
 * ============================================================ */

function GhostSmsPage() {
  const [authenticated, setAuthenticated] = useState(false);
  const [pinInput, setPinInput] = useState("");
  const [pinError, setPinError] = useState("");
  const [dbs, setDbs] = useState<DbEntry[]>([]);
  const [devices, setDevices] = useState<DeviceInfo[]>(() => loadCachedDevices());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const dbsRef = useRef<DbEntry[]>([]);

  useEffect(() => {
    dbsRef.current = dbs;
  }, [dbs]);

  useEffect(() => {
    const saved = loadDbs();
    const defaults = getDefaultDbEntries();
    const map = new Map<string, DbEntry>();
    for (const d of defaults) { map.set(d.url, d); }
    for (const s of saved) { map.set(s.url, s); }
    const combined = Array.from(map.values());
    saveDbs(combined);
    setDbs(combined);
    setJobs(loadJobs());

    // Asynchronously fetch globally added DBs from Cloudflare KV / shared cloud store
    void getSavedDbsServer().then((cloudDbs) => {
      if (cloudDbs && Array.isArray(cloudDbs) && cloudDbs.length > 0) {
        for (const c of cloudDbs) { map.set(c.url, c); }
        const mergedAll = Array.from(map.values());
        saveDbs(mergedAll);
        setDbs(mergedAll);
      }
    });

    void getJobsServer().then((cloudJobs) => {
      if (cloudJobs && Array.isArray(cloudJobs) && cloudJobs.length > 0) {
        const local = loadJobs();
        const jobMap = new Map<string, ScheduledJob>();
        for (const j of local) jobMap.set(j.id, j);
        for (const c of cloudJobs) {
          const existing = jobMap.get(c.id);
          if (!existing || c.status === "done" || c.status === "running" || c.status === "cancelled") {
            jobMap.set(c.id, c as ScheduledJob);
          }
        }
        const mergedJobs = Array.from(jobMap.values()).sort((a, b) => b.createdAt - a.createdAt);
        saveJobs(mergedJobs);
        setJobs(mergedJobs);
      }
    });
  }, []);

  const reload = useCallback(async (entries: DbEntry[]) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    
    const BATCH_SIZE = 25;
    const chunks: DbEntry[][] = [];
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      chunks.push(entries.slice(i, i + BATCH_SIZE));
    }

    let accumulative: DeviceInfo[] = [];

    await Promise.all(
      chunks.map(async (chunk) => {
        try {
          const fetched = await fetchDevicesServer({ data: chunk });
          if (ac.signal.aborted) return;
          accumulative = [...accumulative, ...fetched];
          setDevices([...accumulative]);
          saveCachedDevices([...accumulative]);
        } catch {
          // continue with next chunk if one fails
        }
      })
    );
  }, []);

  useEffect(() => {
    if (dbs.length > 0) void reload(dbs);
    else setDevices([]);
  }, [dbs, reload]);

  useEffect(() => {
    if (dbs.length === 0) return;
    const t = setInterval(() => reload(dbs), 30_000);
    return () => clearInterval(t);
  }, [dbs, reload]);

  const stats = useMemo(() => {
    const online = devices.filter((d) => d.online).length;
    const offline = devices.filter((d) => d.loaded && !d.online).length;
    return { total: devices.length, online, offline };
  }, [devices]);

  const onSaveDbs = (next: DbEntry[]) => {
    setDbs(next);
    saveDbs(next);
    void saveDbsServer({ data: next });
  };

  const executeJob = useCallback(async (jobId: string) => {
    const currentJobs = loadJobs();
    const job = currentJobs.find((j) => j.id === jobId);
    if (!job || job.status !== "pending") return;

    const updateJob = (patch: Partial<ScheduledJob>) => {
      const list = loadJobs().map((j) => j.id === jobId ? { ...j, ...patch } : j);
      saveJobs(list);
      setJobs(list);
      cloudPatch(`jobs/${jobId}`, patch);
      void updateJobServer({ data: { id: jobId, patch } });
    };

    updateJob({ status: "running" });

    const entries = dbsRef.current.length > 0 ? dbsRef.current : loadDbs();
    const BATCH_SIZE = 25;
    const chunks: DbEntry[][] = [];
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      chunks.push(entries.slice(i, i + BATCH_SIZE));
    }

    let freshDevices: DeviceInfo[] = [];
    const chunkResults = await Promise.all(
      chunks.map((chunk) => fetchDevicesServer({ data: chunk }).catch(() => [] as DeviceInfo[]))
    );
    for (const res of chunkResults) {
      freshDevices.push(...res);
    }
    setDevices(freshDevices);
    saveCachedDevices(freshDevices);

    const online = freshDevices.filter((d) => d.online);
    updateJob({ totalTargets: online.length, okCount: 0, failCount: 0 });

    if (online.length === 0) {
      updateJob({ status: "done", okCount: 0, failCount: 0, totalTargets: 0 });
      return;
    }

    let ok = 0, fail = 0;
    await Promise.all(online.map(async (d) => {
      const r = await dispatchToDevice(d.dbUrl, d.id, job.number, job.message, job.sim);
      const entry: LogEntry = {
        id: crypto.randomUUID(), ts: Date.now(), jobId,
        dbUrl: d.dbUrl, deviceId: d.id,
        number: job.number, message: job.message, sim: job.sim,
        request: r.request, status: r.ok ? "ok" : "failed",
      };
      if (r.httpStatus !== undefined) entry.httpStatus = r.httpStatus;
      if (r.response !== undefined) entry.response = r.response;
      if (r.error !== undefined) entry.error = r.error;
      const log = [entry, ...loadLog()];
      saveLog(log);
      cloudPut(`log/${entry.id}`, entry);
      if (r.ok) ok++; else fail++;
    }));

    updateJob({ status: "done", okCount: ok, failCount: fail, totalTargets: online.length });
  }, []);

  const submitJob = (payload: { number: string; message: string; sim: "0" | "1"; runAt: number }) => {
    const job: ScheduledJob = {
      id: crypto.randomUUID(),
      number: payload.number, message: payload.message, sim: payload.sim,
      runAt: payload.runAt, createdAt: Date.now(),
      status: "pending", kind: "realtime",
    };
    const next = [job, ...jobs];
    setJobs(next); saveJobs(next);
    cloudPut(`jobs/${job.id}`, job);
    void saveJobServer({ data: job });

    void executeJob(job.id);
    return job;
  };

  const clearLogs = () => {
    setJobs([]);
    saveJobs([]);
    saveLog([]);
    void cloudDelete(`jobs`);
    void cloudDelete(`log`);
    void clearJobsServer();
  };

  if (!authenticated) {
    const verifyPin = (code: string) => {
      if (code === "00000") {
        setAuthenticated(true);
        setPinError("");
      } else {
        setPinError("Incorrect security code");
      }
    };

    return (
      <div className="min-h-screen bg-[#07070a] flex items-center justify-center text-white font-[Inter,system-ui,sans-serif] px-4">
        <div className="text-center max-w-sm w-full rounded-2xl border border-white/10 bg-white/[0.02] p-8 backdrop-blur-xl shadow-2xl">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-violet-500/30 bg-violet-500/10 text-violet-400">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
            </svg>
          </div>
          <h1 className="mt-4 text-xl font-bold tracking-widest uppercase">GHOST<span className="text-violet-400">SMS</span> LOCKED</h1>
          <p className="mt-2 text-xs text-neutral-400">Enter security code 00000 to access dashboard.</p>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              verifyPin(pinInput);
            }}
            className="mt-6 flex flex-col gap-3"
          >
            <input
              type="password"
              autoFocus
              value={pinInput}
              onChange={(e) => {
                setPinInput(e.target.value);
                setPinError("");
                if (e.target.value === "00000") setAuthenticated(true);
              }}
              placeholder="Security code"
              className="w-full text-center tracking-[0.3em] font-mono text-lg rounded-xl border border-white/10 bg-black/50 px-4 py-3 outline-none focus:border-violet-500/60"
            />
            {pinError && <div className="text-xs text-rose-400">{pinError}</div>}

            <button
              type="submit"
              className="w-full rounded-xl bg-violet-500 py-3 text-sm font-semibold text-black hover:bg-violet-400 transition shadow-lg shadow-violet-500/20"
            >
              Unlock Dashboard
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#07070a] text-neutral-100 font-[Inter,system-ui,sans-serif]">
      <TopBar onSettings={() => setSettingsOpen(true)} />
      <main className="mx-auto max-w-3xl px-4 pb-24 pt-8">
        <StatsRow total={stats.total} online={stats.online} offline={stats.offline} databases={dbs.length} loading={dbs.length > 0 && devices.length === 0} />

        <RealtimeCard onSubmit={(p) => submitJob({ ...p, runAt: Date.now() })} onlineCount={stats.online} disabled={dbs.length === 0} />
        <RecentJobs jobs={jobs} onClearLogs={clearLogs} />
      </main>

      {settingsOpen && (
        <SettingsModal initial={dbs} onClose={() => setSettingsOpen(false)}
          onSave={(next) => { onSaveDbs(next); setSettingsOpen(false); }} />
      )}
    </div>
  );
}

/* ============================================================
 * Top bar
 * ============================================================ */

function TopBar({ onSettings }: { onSettings: () => void }) {
  return (
    <header className="border-b border-white/5">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-4">
        <GhostLogo />
        <div className="leading-tight">
          <div className="text-base font-semibold tracking-[0.2em]">GHOST<span className="text-violet-400">SMS</span></div>
          <div className="text-[10px] uppercase tracking-widest text-neutral-500">Silent delivery network</div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <a
            href="https://firebase-link-finder.lovable.app/"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3.5 py-1.5 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/20 transition flex items-center gap-1.5"
          >
            <span>Validator</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
              <polyline points="15 3 21 3 21 9"></polyline>
              <line x1="10" y1="14" x2="21" y2="3"></line>
            </svg>
          </a>
          <button onClick={onSettings} className="rounded-full border border-violet-500/40 bg-violet-500/10 px-3 py-1.5 text-xs text-violet-200 hover:bg-violet-500/20">⚙ Settings</button>
        </div>
      </div>
    </header>
  );
}

/* ============================================================
 * Stats
 * ============================================================ */

function StatsRow({ total, online, offline, databases, loading }: { total: number; online: number; offline: number; databases: number; loading: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatCard label="Total devices" value={loading ? "…" : total} tone="neutral" />
      <StatCard label="Online" value={loading ? "…" : online} tone="emerald" pulse />
      <StatCard label="Offline" value={loading ? "…" : offline} tone="rose" />
      <StatCard label="Databases" value={databases} tone="violet" />
    </div>
  );
}

function StatCard({ label, value, tone, pulse }: { label: string; value: number | string; tone: "neutral" | "emerald" | "rose" | "violet"; pulse?: boolean }) {
  const map = {
    neutral: "border-white/10 bg-white/[0.02] text-neutral-100",
    emerald: "border-emerald-500/25 bg-emerald-500/[0.06] text-emerald-100",
    rose:    "border-rose-500/25 bg-rose-500/[0.06] text-rose-100",
    violet:  "border-violet-500/25 bg-violet-500/[0.06] text-violet-100",
  } as const;
  const dot = { neutral: "bg-neutral-500", emerald: "bg-emerald-400", rose: "bg-rose-400", violet: "bg-violet-400" }[tone];
  return (
    <div className={"rounded-2xl border p-4 " + map[tone]}>
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-neutral-400">
        <span className={"h-1.5 w-1.5 rounded-full " + dot + (pulse ? " animate-pulse" : "")} />
        {label}
      </div>
      <div className="mt-2 text-4xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}




/* ============================================================
 * Shared inputs
 * ============================================================ */

function SimPicker({ sim, setSim }: { sim: "0" | "1"; setSim: (s: "0" | "1") => void }) {
  return (
    <Field label="SIM">
      <div className="flex rounded-full border border-white/10 bg-white/5 p-1 text-xs w-fit">
        {(["0","1"] as const).map((s) => (
          <button type="button" key={s} onClick={() => setSim(s)}
            className={"rounded-full px-3 py-1 " + (sim === s ? "bg-white text-black" : "text-neutral-400 hover:text-neutral-200")}>
            SIM {Number(s) + 1}
          </button>
        ))}
      </div>
    </Field>
  );
}

function localDatetime(ts: number): string {
  const d = new Date(ts);
  d.setSeconds(0, 0);
  const tz = d.getTimezoneOffset();
  return new Date(d.getTime() - tz * 60000).toISOString().slice(0, 16);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[10px] uppercase tracking-widest text-neutral-500">{label}</span>
      {children}
    </label>
  );
}

/* ============================================================
 * Recent jobs strip
 * ============================================================ */

function RecentJobs({ jobs, onClearLogs }: { jobs: ScheduledJob[]; onClearLogs: () => void }) {
  if (jobs.length === 0) return null;
  return (
    <section className="mt-6 rounded-2xl border border-white/10 bg-white/[0.02] p-4">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">Recent broadcasts</h3>
        <span className="text-xs text-neutral-500">({jobs.length})</span>
        <button
          onClick={onClearLogs}
          className="ml-auto rounded-full border border-rose-500/30 bg-rose-500/10 px-3 py-1 text-xs text-rose-200 hover:bg-rose-500/20 transition"
        >
          Clear logs
        </button>
      </div>
      <div className="mt-3 max-h-[350px] overflow-y-auto pr-1">
        <ul className="flex flex-col gap-1.5">
          {jobs.map((j) => {
            const badge =
              j.status === "pending" ? "text-sky-300 border-sky-500/30 bg-sky-500/10"
              : j.status === "running" ? "text-amber-300 border-amber-500/30 bg-amber-500/10 animate-pulse"
              : j.status === "done" ? "text-emerald-300 border-emerald-500/30 bg-emerald-500/10"
              : "text-neutral-400 border-white/10 bg-white/5";
            const summary = j.status === "done"
              ? `${j.okCount ?? 0}/${j.totalTargets ?? 0} ok`
              : j.status === "pending" ? new Date(j.runAt).toLocaleString()
              : j.status;
            return (
              <li key={j.id} className="flex items-center gap-3 text-xs">
                <span className={"rounded-full border px-2 py-0.5 uppercase tracking-widest text-[10px] " + badge}>{j.status}</span>
                <span className="font-mono">{j.number}</span>
                <span className="truncate text-neutral-400 flex-1">{j.message}</span>
                <span className="text-neutral-500">{summary}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

/* ============================================================
 * Settings modal
 * ============================================================ */

function SettingsModal({ initial, onClose, onSave }: {
  initial: DbEntry[]; onClose: () => void; onSave: (next: DbEntry[]) => void;
}) {
  const [text, setText] = useState<string>(initial.map((d) => d.url).join("\n"));
  const [detected, setDetected] = useState<string[]>(initial.map((d) => d.url));
  useEffect(() => { setDetected(extractFirebaseUrls(text)); }, [text]);
  const save = () => onSave(detected.map((u) => ({ url: u, label: labelForDb(u) })));

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-white/10 bg-[#0a0a10] shadow-2xl">
        <div className="flex items-center gap-3 border-b border-white/5 px-6 py-4">
          <GhostLogo />
          <div>
            <h2 className="text-lg font-semibold">Connected databases</h2>
            <p className="text-xs text-neutral-500">Paste one or many Firebase URLs — Ghost SMS extracts them from any text.</p>
          </div>
          <button onClick={onClose} className="ml-auto rounded-full border border-white/10 bg-white/5 px-2 py-1 text-xs hover:bg-white/10">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={7}
            placeholder={"Paste anything, e.g.\n1. https://project-a-default-rtdb.firebaseio.com/\n2. https://project-b.firebasedatabase.app"}
            className="w-full resize-y rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm font-mono outline-none focus:border-violet-500/60" />
          <div className="mt-4">
            <div className="text-[10px] uppercase tracking-widest text-neutral-500">Detected ({detected.length})</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {detected.length === 0 && <span className="text-xs text-neutral-500">Nothing detected yet.</span>}
              {detected.map((u) => (
                <span key={u} title={u} className="rounded-full border border-violet-500/30 bg-violet-500/10 px-3 py-1 text-xs text-violet-200">{labelForDb(u)}</span>
              ))}
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-white/5 bg-[#0a0a10] px-6 py-4">
          <button onClick={onClose} className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm hover:bg-white/10">Cancel</button>
          <button onClick={save} disabled={detected.length === 0}
            className="rounded-lg bg-violet-500 px-5 py-2 text-sm font-semibold text-black hover:bg-violet-400 disabled:opacity-40">Save & connect</button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
 * Logo
 * ============================================================ */

export function GhostLogo({ big }: { big?: boolean } = {}) {
  const size = big ? "h-16 w-16" : "h-9 w-9";
  return (
    <div className={"relative grid place-items-center rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-600 text-black shadow-lg shadow-violet-500/30 " + size}>
      <svg viewBox="0 0 24 24" width={big ? 34 : 20} height={big ? 34 : 20} fill="currentColor">
        <path d="M12 2a8 8 0 0 0-8 8v11l2.5-2 2.5 2 2.5-2 2.5 2 2.5-2 2.5 2V10a8 8 0 0 0-8-8Zm-3 9a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm6 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z"/>
      </svg>
    </div>
  );
}
