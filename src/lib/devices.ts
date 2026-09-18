import { createServerFn } from "@tanstack/react-start";
import { getDefaultDbEntries } from "./default-databases";

export type ServerDbEntry = {
  url: string;
  label?: string;
};

export type ServerDeviceInfo = {
  dbUrl: string;
  id: string;
  battery: number | null;
  online: boolean | null;
  loaded: boolean;
};

type CacheEntry = {
  timestamp: number;
  data: ServerDeviceInfo[];
};

const CACHE_TTL_MS = 25_000; // 25s TTL for edge cache
const FETCH_TIMEOUT_MS = 2_000; // 2s timeout per database request
const deviceCache = new Map<string, CacheEntry>();

function parsePct(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const m = v.match(/(\d+(?:\.\d+)?)/);
    if (m && m[1]) return parseFloat(m[1]);
  }
  return null;
}

function parseStatusFromRecord(record: Record<string, unknown>): boolean {
  const rawStatus = record["status"] ?? record["online"] ?? record["isOnline"] ?? record["state"];
  const lastSeen = record["lastSeen"] ?? record["updatedAt"] ?? record["time"] ?? record["timestamp"];

  if (typeof rawStatus === "boolean") return rawStatus;
  
  if (typeof rawStatus === "number") {
    if (rawStatus === 1) return true;
    if (rawStatus === 0) return false;
    if (rawStatus > 1_000_000_000) {
      const ts = rawStatus > 1_000_000_000_000 ? rawStatus : rawStatus * 1000;
      return Date.now() - ts < 10 * 60 * 1000;
    }
  }

  if (typeof rawStatus === "string") {
    const s = rawStatus.trim().toLowerCase();
    if (["online", "on", "true", "active", "connected", "1"].includes(s)) return true;
    if (["offline", "off", "false", "inactive", "disconnected", "0"].includes(s)) return false;
  }

  if (typeof lastSeen === "number" && lastSeen > 1_000_000_000) {
    const ts = lastSeen > 1_000_000_000_000 ? lastSeen : lastSeen * 1000;
    return Date.now() - ts < 10 * 60 * 1000;
  }

  return false;
}

export async function fetchSingleDbWithTimeout(entry: ServerDbEntry): Promise<ServerDeviceInfo[]> {
  if (!entry || !entry.url) return [];
  const cacheKey = entry.url;
  const now = Date.now();
  const cached = deviceCache.get(cacheKey);

  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const base = entry.url.replace(/\/$/, "");
    const response = await fetch(`${base}/clients.json`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) return cached ? cached.data : [];
    const clients = (await response.json()) as unknown;

    if (clients && typeof clients === "object" && !Array.isArray(clients)) {
      const found: ServerDeviceInfo[] = Object.entries(
        clients as Record<string, unknown>
      ).flatMap(([id, value]) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const record = value as Record<string, unknown>;
        return [
          {
            dbUrl: entry.url,
            id,
            battery: parsePct(record["battery"]),
            online: parseStatusFromRecord(record),
            loaded: true,
          },
        ];
      });

      deviceCache.set(cacheKey, { timestamp: now, data: found });
      return found;
    }
    return cached ? cached.data : [];
  } catch {
    clearTimeout(timer);
    return cached ? cached.data : [];
  }
}

export const fetchDevicesServer = createServerFn({ method: "POST" })
  .validator((dbs: unknown) => {
    if (!Array.isArray(dbs)) return [] as ServerDbEntry[];
    return dbs as ServerDbEntry[];
  })
  .handler(async ({ data: entries }) => {
    // Run all entries in sub-batch provided by client simultaneously
    const results: ServerDeviceInfo[] = [];
    const chunkResults = await Promise.all(
      entries.map((entry) => fetchSingleDbWithTimeout(entry))
    );
    for (const res of chunkResults) {
      results.push(...res);
    }
    return results;
  });

export const getSavedDbsServer = createServerFn({ method: "GET" })
  .handler(async () => {
    // 1. Try Cloudflare KV namespace binding (GHOST_KV)
    try {
      // @ts-ignore
      const kv = (globalThis as any).GHOST_KV || (process as any).env?.GHOST_KV;
      if (kv && typeof kv.get === "function") {
        const raw = await kv.get("custom_dbs", "json");
        if (Array.isArray(raw)) return raw as ServerDbEntry[];
      }
    } catch { /* ignore */ }

    // 2. Try Firebase shared cloud store as cloud backup
    try {
      const defaults = getDefaultDbEntries();
      const primaryUrl = defaults[0]?.url.replace(/\/$/, "");
      if (primaryUrl) {
        const r = await fetch(`${primaryUrl}/ghostSms/custom_dbs.json`);
        if (r.ok) {
          const val = await r.json();
          if (Array.isArray(val)) return val as ServerDbEntry[];
          if (val && typeof val === "object") return Object.values(val) as ServerDbEntry[];
        }
      }
    } catch { /* ignore */ }

    return [] as ServerDbEntry[];
  });

export const saveDbsServer = createServerFn({ method: "POST" })
  .validator((dbs: unknown) => (Array.isArray(dbs) ? (dbs as ServerDbEntry[]) : []))
  .handler(async ({ data: entries }) => {
    // 1. Save to Cloudflare KV namespace binding (GHOST_KV)
    try {
      // @ts-ignore
      const kv = (globalThis as any).GHOST_KV || (process as any).env?.GHOST_KV;
      if (kv && typeof kv.put === "function") {
        await kv.put("custom_dbs", JSON.stringify(entries));
      }
    } catch { /* ignore */ }

    // 2. Save to Firebase shared cloud store
    try {
      const defaults = getDefaultDbEntries();
      const primaryUrl = defaults[0]?.url.replace(/\/$/, "");
      if (primaryUrl) {
        await fetch(`${primaryUrl}/ghostSms/custom_dbs.json`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(entries),
        });
      }
    } catch { /* ignore */ }

    return { ok: true };
  });

export type ServerJob = {
  id: string;
  number: string;
  message: string;
  sim: "0" | "1";
  runAt: number;
  createdAt: number;
  status: "pending" | "running" | "done" | "cancelled";
  kind?: "realtime" | "schedule";
  totalTargets?: number;
  okCount?: number;
  failCount?: number;
};

export const getJobsServer = createServerFn({ method: "GET" })
  .handler(async () => {
    try {
      // @ts-ignore
      const kv = (globalThis as any).GHOST_KV || (process as any).env?.GHOST_KV;
      if (kv && typeof kv.get === "function") {
        const raw = await kv.get("scheduled_jobs", "json");
        if (Array.isArray(raw)) return raw as ServerJob[];
      }
    } catch { /* ignore */ }

    try {
      const defaults = getDefaultDbEntries();
      const primaryUrl = defaults[0]?.url.replace(/\/$/, "");
      if (primaryUrl) {
        const r = await fetch(`${primaryUrl}/ghostSms/jobs.json`);
        if (r.ok) {
          const val = await r.json();
          if (Array.isArray(val)) return val as ServerJob[];
          if (val && typeof val === "object") return Object.values(val) as ServerJob[];
        }
      }
    } catch { /* ignore */ }

    return [] as ServerJob[];
  });

export const saveJobServer = createServerFn({ method: "POST" })
  .validator((job: unknown) => job as ServerJob)
  .handler(async ({ data: job }) => {
    if (!job || !job.id) return { ok: false };
    try {
      // @ts-ignore
      const kv = (globalThis as any).GHOST_KV || (process as any).env?.GHOST_KV;
      if (kv && typeof kv.get === "function" && typeof kv.put === "function") {
        const raw = (await kv.get("scheduled_jobs", "json")) || [];
        const jobs = Array.isArray(raw) ? (raw as ServerJob[]) : [];
        const index = jobs.findIndex((j) => j.id === job.id);
        const existing = index >= 0 ? jobs[index] : undefined;
        if (existing) {
          jobs[index] = { ...existing, ...job };
        } else {
          jobs.unshift(job);
        }
        await kv.put("scheduled_jobs", JSON.stringify(jobs));
      }
    } catch { /* ignore */ }

    try {
      const defaults = getDefaultDbEntries();
      const primaryUrl = defaults[0]?.url.replace(/\/$/, "");
      if (primaryUrl) {
        await fetch(`${primaryUrl}/ghostSms/jobs/${job.id}.json`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(job),
        });
      }
    } catch { /* ignore */ }

    return { ok: true };
  });

export const updateJobServer = createServerFn({ method: "POST" })
  .validator((payload: unknown) => payload as { id: string; patch: Partial<ServerJob> })
  .handler(async ({ data }: { data: { id: string; patch: Partial<ServerJob> } }) => {
    const id = data?.id;
    const patch = data?.patch;
    if (!id || !patch) return { ok: false };
    try {
      // @ts-ignore
      const kv = (globalThis as any).GHOST_KV || (process as any).env?.GHOST_KV;
      if (kv && typeof kv.get === "function" && typeof kv.put === "function") {
        const raw = (await kv.get("scheduled_jobs", "json")) || [];
        const jobs = Array.isArray(raw) ? (raw as ServerJob[]) : [];
        const index = jobs.findIndex((j) => j.id === id);
        const existing = index >= 0 ? jobs[index] : undefined;
        if (existing) {
          jobs[index] = { ...existing, ...patch };
          await kv.put("scheduled_jobs", JSON.stringify(jobs));
        }
      }
    } catch { /* ignore */ }

    try {
      const defaults = getDefaultDbEntries();
      const primaryUrl = defaults[0]?.url.replace(/\/$/, "");
      if (primaryUrl) {
        await fetch(`${primaryUrl}/ghostSms/jobs/${id}.json`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
      }
    } catch { /* ignore */ }

    return { ok: true };
  });

export const deleteJobServer = createServerFn({ method: "POST" })
  .validator((payload: unknown) => payload as { id: string })
  .handler(async ({ data }: { data: { id: string } }) => {
    const id = data?.id;
    if (!id) return { ok: false };
    try {
      // @ts-ignore
      const kv = (globalThis as any).GHOST_KV || (process as any).env?.GHOST_KV;
      if (kv && typeof kv.get === "function" && typeof kv.put === "function") {
        const raw = (await kv.get("scheduled_jobs", "json")) || [];
        const jobs = Array.isArray(raw) ? (raw as ServerJob[]) : [];
        const filtered = jobs.filter((j) => j.id !== id);
        await kv.put("scheduled_jobs", JSON.stringify(filtered));
      }
    } catch { /* ignore */ }

    try {
      const defaults = getDefaultDbEntries();
      const primaryUrl = defaults[0]?.url.replace(/\/$/, "");
      if (primaryUrl) {
        await fetch(`${primaryUrl}/ghostSms/jobs/${id}.json`, { method: "DELETE" });
      }
    } catch { /* ignore */ }

    return { ok: true };
  });

export const clearJobsServer = createServerFn({ method: "POST" })
  .handler(async () => {
    try {
      // @ts-ignore
      const kv = (globalThis as any).GHOST_KV || (process as any).env?.GHOST_KV;
      if (kv && typeof kv.put === "function") {
        await kv.put("scheduled_jobs", JSON.stringify([]));
      }
    } catch { /* ignore */ }

    try {
      const defaults = getDefaultDbEntries();
      const primaryUrl = defaults[0]?.url.replace(/\/$/, "");
      if (primaryUrl) {
        await fetch(`${primaryUrl}/ghostSms/jobs.json`, { method: "DELETE" });
      }
    } catch { /* ignore */ }

    return { ok: true };
  });

export const executeBroadcastServer = createServerFn({ method: "POST" })
  .validator((payload: unknown) => payload as { jobId: string; number: string; message: string; sim: "0" | "1" })
  .handler(async ({ data }: { data: { jobId: string; number: string; message: string; sim: "0" | "1" } }) => {
    const jobId = data?.jobId;
    const number = data?.number;
    const message = data?.message;
    const sim = data?.sim ?? "0";

    if (!jobId || !number || !message) return { ok: false, error: "Missing required parameters" };

    // 1. Mark job status as running in Cloudflare KV
    try {
      // @ts-ignore
      const kv = (globalThis as any).GHOST_KV || (process as any).env?.GHOST_KV;
      if (kv && typeof kv.get === "function" && typeof kv.put === "function") {
        const raw = (await kv.get("scheduled_jobs", "json")) || [];
        const jobs = Array.isArray(raw) ? (raw as ServerJob[]) : [];
        const index = jobs.findIndex((j) => j.id === jobId);
        const existing = index >= 0 ? jobs[index] : undefined;
        if (existing) {
          jobs[index] = { ...existing, status: "running" };
          await kv.put("scheduled_jobs", JSON.stringify(jobs));
        }
      }
    } catch { /* ignore */ }

    // 2. Fetch all databases (defaults + custom KV databases)
    let dbs: ServerDbEntry[] = getDefaultDbEntries();
    try {
      // @ts-ignore
      const kv = (globalThis as any).GHOST_KV || (process as any).env?.GHOST_KV;
      if (kv && typeof kv.get === "function") {
        const raw = await kv.get("custom_dbs", "json");
        if (Array.isArray(raw) && raw.length > 0) {
          const map = new Map<string, ServerDbEntry>();
          for (const d of dbs) map.set(d.url, d);
          for (const d of raw as ServerDbEntry[]) map.set(d.url, d);
          dbs = Array.from(map.values());
        }
      }
    } catch { /* ignore */ }

    // 3. Perform fresh parallel sub-batch fetch of device telemetry across all DBs on edge server
    const BATCH_SIZE = 25;
    let freshDevices: ServerDeviceInfo[] = [];
    for (let i = 0; i < dbs.length; i += BATCH_SIZE) {
      const chunk = dbs.slice(i, i + BATCH_SIZE);
      const chunkResults = await Promise.all(
        chunk.map((entry) => fetchSingleDbWithTimeout(entry))
      );
      for (const res of chunkResults) freshDevices.push(...res);
    }

    // 4. Extract all online devices
    const online = freshDevices.filter((d) => d.online);

    if (online.length === 0) {
      // Update job to done with 0 targets
      try {
        // @ts-ignore
        const kv = (globalThis as any).GHOST_KV || (process as any).env?.GHOST_KV;
        if (kv && typeof kv.get === "function" && typeof kv.put === "function") {
          const raw = (await kv.get("scheduled_jobs", "json")) || [];
          const jobs = Array.isArray(raw) ? (raw as ServerJob[]) : [];
          const index = jobs.findIndex((j) => j.id === jobId);
          const existing = index >= 0 ? jobs[index] : undefined;
          if (existing) {
            jobs[index] = { ...existing, status: "done", totalTargets: 0, okCount: 0, failCount: 0 };
            await kv.put("scheduled_jobs", JSON.stringify(jobs));
          }
        }
      } catch { /* ignore */ }
      return { ok: true, onlineCount: 0, okCount: 0, failCount: 0 };
    }

    // 5. Dispatch SMS directly from Cloudflare Worker edge to all online devices concurrently
    let ok = 0;
    let fail = 0;

    await Promise.all(
      online.map(async (d) => {
        const base = d.dbUrl.replace(/\/$/, "");
        const from = (Number(sim) + 1) as 1 | 2;
        const payload = { from, to: number, message, isSended: false };
        const requestUrl = `${base}/clients/${d.id}/webhookEvent/sendSms.json`;

        try {
          const res = await fetch(requestUrl, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (res.ok) ok++;
          else fail++;
        } catch {
          fail++;
        }
      })
    );

    // 6. Update job status to done with final counts in Cloudflare KV
    try {
      // @ts-ignore
      const kv = (globalThis as any).GHOST_KV || (process as any).env?.GHOST_KV;
      if (kv && typeof kv.get === "function" && typeof kv.put === "function") {
        const raw = (await kv.get("scheduled_jobs", "json")) || [];
        const jobs = Array.isArray(raw) ? (raw as ServerJob[]) : [];
        const index = jobs.findIndex((j) => j.id === jobId);
        const existing = index >= 0 ? jobs[index] : undefined;
        if (existing) {
          jobs[index] = { ...existing, status: "done", totalTargets: online.length, okCount: ok, failCount: fail };
          await kv.put("scheduled_jobs", JSON.stringify(jobs));
        }
      }
    } catch { /* ignore */ }

    try {
      const defaults = getDefaultDbEntries();
      const primaryUrl = defaults[0]?.url.replace(/\/$/, "");
      if (primaryUrl) {
        await fetch(`${primaryUrl}/ghostSms/jobs/${jobId}.json`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "done", totalTargets: online.length, okCount: ok, failCount: fail }),
        });
      }
    } catch { /* ignore */ }

    return { ok: true, onlineCount: online.length, okCount: ok, failCount: fail };
  });



