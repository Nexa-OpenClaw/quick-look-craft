import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { fetchSingleDbWithTimeout, type ServerDbEntry } from "./lib/devices";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

import { getDefaultDbEntries } from "./lib/default-databases";

import { getGhostKV } from "./lib/kv";

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      if (env && typeof env === "object") {
        (globalThis as any).__env__ = env;
        (globalThis as any).__CF_ENV = env;
        if ("GHOST_KV" in env) {
          (globalThis as any).GHOST_KV = (env as any).GHOST_KV;
        }
      }

      const url = new URL(request.url);

      if (url.pathname === "/api/save-dbs" && (request.method === "POST" || request.method === "PUT")) {
        try {
          const body = (await request.json()) as { dbs?: ServerDbEntry[] } | ServerDbEntry[];
          const entries = Array.isArray(body) ? body : Array.isArray(body?.dbs) ? body.dbs : [];
          
          const kv = getGhostKV(env);
          let kvWritten = false;
          let kvError: string | null = null;

          if (kv && typeof kv.put === "function") {
            try {
              await kv.put("custom_dbs", JSON.stringify(entries));
              kvWritten = true;
            } catch (err: any) {
              kvError = String(err?.message || err);
              console.error("GHOST_KV put error:", err);
            }
          } else {
            kvError = "GHOST_KV binding not found on request environment";
            console.error(kvError);
          }

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

          return new Response(JSON.stringify({ ok: true, kvWritten, kvError, count: entries.length }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (err) {
          return new Response(JSON.stringify({ ok: false, error: String(err) }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      if (url.pathname === "/api/get-dbs" && request.method === "GET") {
        try {
          const kv = getGhostKV(env);
          if (kv && typeof kv.get === "function") {
            const raw = await kv.get("custom_dbs", "json");
            if (Array.isArray(raw)) {
              return new Response(JSON.stringify(raw), {
                headers: { "Content-Type": "application/json" },
              });
            }
          }

          const defaults = getDefaultDbEntries();
          const primaryUrl = defaults[0]?.url.replace(/\/$/, "");
          if (primaryUrl) {
            const r = await fetch(`${primaryUrl}/ghostSms/custom_dbs.json`);
            if (r.ok) {
              const val = await r.json();
              let arr: ServerDbEntry[] = [];
              if (Array.isArray(val)) arr = val;
              else if (val && typeof val === "object") arr = Object.values(val) as ServerDbEntry[];

              if (arr.length > 0) {
                if (kv && typeof kv.put === "function") {
                  try { await kv.put("custom_dbs", JSON.stringify(arr)); } catch {}
                }
                return new Response(JSON.stringify(arr), {
                  headers: { "Content-Type": "application/json" },
                });
              }
            }
          }

          return new Response(JSON.stringify([]), {
            headers: { "Content-Type": "application/json" },
          });
        } catch {
          return new Response(JSON.stringify([]), {
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      if (url.pathname === "/api/fetch-dbs-chunk" && request.method === "POST") {
        try {
          const body = (await request.json()) as { dbs: ServerDbEntry[] };
          const dbs = Array.isArray(body?.dbs) ? body.dbs : [];
          const results = await Promise.all(dbs.map((entry) => fetchSingleDbWithTimeout(entry)));
          return new Response(JSON.stringify(results.flat()), {
            headers: { "Content-Type": "application/json" },
          });
        } catch {
          return new Response(JSON.stringify([]), {
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};


