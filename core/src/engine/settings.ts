import type { Database } from "../db/database.ts";
import { nowIso } from "../db/database.ts";

export const DEFAULT_SETTINGS = {
  "onboarding.completed": false,
  "auth.currentUser": "local",
  "ai.enabled": false,
  "ai.provider": "anthropic",
  "ai.model": "claude-haiku-5-5",
  "ai.reflectionModel": "claude-sonnet-5-5",
  "ai.disclosureAccepted": false,
  "ai.useForLearning": true,
  "ai.useForReflection": true,
  "ai.maxCallsPerHour": 60,
  "embeddings.provider": "local" as "local" | "openai-compatible" | "voyage",
  "embeddings.model": "",
  "embeddings.baseUrl": "",
  "automation.autoLearn": true,
  "automation.autoLink": true,
  "automation.autoMerge": true,
  "automation.mergeThreshold": 0.95,
  "automation.duplicateThreshold": 0.88,
  "automation.linkThreshold": 0.42,
  "automation.reflectIntervalMin": 30,
  "automation.learnFromTranscripts": false,
  "automation.paused": false,
  // v0.4.0 proactive intelligence: background analysis (Awareness, Knowledge Health, Discovery, agents) on idle.
  "intelligence.background": true,
  "mcp.permissions": { read: true, write: true, merge: true, archive: true, delete: false },
  "mcp.http.enabled": false,
  "mcp.http.port": 47821,
  "mcp.http.token": "",
  "retrieval.tokenBudget": 2500,
  "retrieval.minScore": 0.2,
  "retrieval.maxItems": 12,
  "privacy.redactSecrets": true,
  "privacy.flagInjections": true,
  "backup.auto": true,
  "backup.keep": 7,
  "backup.intervalHours": 24,
  "backup.location": "",
  "backup.lastOk": "",
  "backup.lastError": "",
  // v0.2.5 First Flight & Adaptation
  "firstFlight": { step: 0, completed: false, skipped: [] as string[], startedAt: "", finishedAt: "", firstMemoryId: "" },
  "privacy.mode": false,
  "resources.profile": "balanced" as "eco" | "balanced" | "performance",
  "quickCapture.enabled": true,
  "quickCapture.shortcut": "Ctrl+Alt+M",
  "notifications.level": "important" as "important" | "all" | "silent",
  "sleep.mode": "idle" as "idle" | "after_session" | "manual",
  "sleep.idleMinutes": 10,
  "sleep.lastRun": "",
  "transfer.enabled": true,
  "adaptation.enabled": true,
  "adaptation.inferAfter": 3,
  "adaptation.maxInContext": 6,
  "inbox.enabled": false,
  "inbox.folder": "",
  "inbox.learn": true,
  "inbox.lastScan": "",
  "vault.sync": false,
  "vault.folder": "",
  "vault.lastSync": "",
  "google.clientId": "",
  "cortex.enabled": true,
  "cortex.paused": false,
  "cortex.modelId": "",
  "cortex.runtimeVariant": "cpu" as "cpu" | "vulkan",
  "cortex.idleTimeoutMin": 5,
  "cortex.contextSize": 4096,
  "cortex.threads": 0,
  "cortex.gpuLayers": 0,
  "cortex.autonomy": "balanced" as "cautious" | "balanced" | "autonomous",
  "cortex.minConfidence": 0.35,
  "cortex.maxRetries": 2,
  "cortex.cloudFallback": false,
  "cortex.cloudBlockedProjects": [] as string[],
  "notifications.enabled": true,
  "notifications.learning": true,
  "updates.check": true,
  "appearance.reduceMotion": false,
  /** auto = Balanced, or Minimal when Windows asks apps to reduce motion. */
  "appearance.motion": "auto" as "auto" | "full" | "balanced" | "minimal",
  "appearance.ambient": true,
  // v0.4.0 Session Continuity: write a handoff automatically when a Claude Code session ends (reads the transcript;
  // needs the local AI). Off by default.
  "sessions.autoHandoff": false,
  // v0.4.0 Discovery (quiet mode): only suggestions at least this confident are shown.
  "discovery.minConfidence": 0.6,
  "discovery.maxPerKind": 30,
  "graph.maxDocuments": 3000,
  "updates.autoCheck": true,
  "updates.lastCheck": "",
  "updates.deferredVersion": "",
  // v0.4.0 Agents: per-agent { enabled, background, everyHours, maxItems } overrides (defaults in agents.ts).
  "agents.config": {} as Record<string, { enabled?: boolean; background?: boolean; everyHours?: number; maxItems?: number }>,
  "appearance.sidebarCollapsed": false,
  "appearance.contextPanel": true,
  "app.launchOnStartup": false,
  "app.closeToTray": true,
  "graph": {
    centerForce: 0.12,
    repelForce: 180,
    linkForce: 0.35,
    linkDistance: 42,
    nodeSize: 1,
    linkThickness: 1,
    textFadeThreshold: 1.6,
    showLabels: true,
    animate: true,
    colorBy: "none" as "none" | "category" | "project",
    showArrows: false,
    showOrphans: true,
    showArchived: false,
    recentDays: 0,
    categories: [] as string[],
    projects: [] as string[],
    tags: [] as string[],
    localDepth: 1,
  },
};

export type Settings = typeof DEFAULT_SETTINGS;
export type SettingKey = keyof Settings;

const SECRET_LIKE = /(api[_-]?key|secret|password|token)$/i;

export class SettingsStore {
  constructor(private db: Database) {}

  get<K extends SettingKey>(key: K): Settings[K] {
    const row = this.db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", [key]);
    if (!row) return structuredClone(DEFAULT_SETTINGS[key]);
    try {
      const v = JSON.parse(row.value);
      const def = DEFAULT_SETTINGS[key];
      if (def && typeof def === "object" && !Array.isArray(def) && v && typeof v === "object") return { ...def, ...v };
      return v;
    } catch {
      return structuredClone(DEFAULT_SETTINGS[key]);
    }
  }

  set<K extends SettingKey>(key: K, value: Settings[K]): void {
    if (!(key in DEFAULT_SETTINGS)) throw new Error(`Unknown setting ${String(key)}`);
    if (SECRET_LIKE.test(String(key)) && key !== "mcp.http.token") throw new Error("Secrets are never stored in the database");
    this.db.run(
      "INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      [key, JSON.stringify(value), nowIso()],
    );
  }

  all(): Settings {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(DEFAULT_SETTINGS) as SettingKey[]) out[k] = this.get(k);
    return out as Settings;
  }
}
