export function getGhostKV(env?: unknown): any {
  if (env && typeof env === "object" && (env as any).GHOST_KV) {
    return (env as any).GHOST_KV;
  }
  if (typeof globalThis !== "undefined") {
    const g = globalThis as any;
    if (g.GHOST_KV) return g.GHOST_KV;
    if (g.__env__ && g.__env__.GHOST_KV) return g.__env__.GHOST_KV;
    if (g.__CF_ENV && g.__CF_ENV.GHOST_KV) return g.__CF_ENV.GHOST_KV;
  }
  if (typeof process !== "undefined" && (process as any).env) {
    const p = process as any;
    if (p.env?.GHOST_KV) return p.env.GHOST_KV;
    if (p.GHOST_KV) return p.GHOST_KV;
  }
  return undefined;
}
