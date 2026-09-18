import { processScheduledJobsOnEdge } from "../lib/devices";

export default function scheduledPlugin(nitroApp: any) {
  nitroApp.hooks.hook("cloudflare:scheduled" as any, async ({ controller, env, context }: any) => {
    try {
      await processScheduledJobsOnEdge(env);
    } catch (err) {
      console.error("Scheduled cron error on edge:", err);
    }
  });
}
