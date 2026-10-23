// v0.2.5 First Flight & Adaptation — engine tests (no AI inference involved; these are not proof of AI quality).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Database } from "../src/db/database.ts";
import { MIGRATIONS } from "../src/db/migrations.ts";
import { rpcMethods } from "../src/api/rpc.ts";
import { pulse, timeline } from "../src/api/pulse.ts";
import { Brain } from "../src/engine/brain.ts";
import { parseFile } from "../src/engine/folders.ts";
import { claude, openBrain, tmpDir, user } from "./helpers.ts";

function rpc(b: () => Brain, reopen: () => void = () => {}) {
  return rpcMethods({ brain: b, reopen, setHttpMcp: async () => ({ running: false }), httpMcpRunning: () => false });
}

test("migration v3 upgrades an existing v2 database without losing data", () => {
  const dir = tmpDir();
  const file = path.join(dir, "moth.db");
  const raw = new DatabaseSync(file);
  const db = { exec: (q: string) => raw.exec(q), run: (q: string, p: unknown[]) => raw.prepare(q).run(...(p as never[])), close: () => raw.close() };
  db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  for (const m of MIGRATIONS.filter((x) => x.version <= 2)) {
    db.exec(m.sql);
    db.run("INSERT INTO schema_migrations VALUES (?,?,?)", [m.version, m.name, new Date().toISOString()]);
  }
  const t = new Date().toISOString();
  db.run("INSERT INTO users(id, kind, name, created_at) VALUES ('local','local','Local user',?)", [t]);
  db.run("INSERT INTO projects(id, user_id, name, slug, created_at, updated_at) VALUES ('prj_1','local','Old Game','old-game',?,?)", [t, t]);
  db.run(`INSERT INTO memories(id, user_id, title, content, category, project_id, created_at, updated_at) VALUES ('mem_a','local','Inventory','Inventory has 6 slots','decision','prj_1',?,?)`, [t, t]);
  db.run(`INSERT INTO memories(id, user_id, title, content, category, created_at, updated_at) VALUES ('mem_b','local','Fix','Server validates moves','solution',?,?)`, [t, t]);
  db.run(`INSERT INTO review_queue(user_id, operation, proposal, statement, reason, risk, created_at) VALUES ('local','update','{}','x','y','high',?)`, [t]);
  db.close();

  const b = Brain.open({ dataDir: dir, role: "test" });
  assert.equal(Number(b.db.value("SELECT MAX(version) FROM schema_migrations")), 3);
  const a = b.store.requireMemory("mem_a");
  assert.equal(a.content, "Inventory has 6 slots");
  assert.equal(a.memory_type, "project");
  assert.equal(a.scope, "project");
  assert.equal(a.pinned, false);
  assert.equal(b.store.requireMemory("mem_b").memory_type, "procedural");
  assert.equal(b.store.requireProject("prj_1").transfer_enabled, true);
  assert.equal(b.inbox.list().length, 1);
  assert.equal(b.inbox.list()[0].kind, "cortex");
  b.close();
});

test("explicit preferences persist across restart; inferred ones stay tentative until confirmed", () => {
  const dir = tmpDir();
  let b = openBrain(dir);
  const p = b.adaptation.recordPreference({ content: "I prefer clean, dark UI with lavender accents.", explicit: true }, "claude");
  assert.equal(p.status, "confirmed");
  assert.equal(p.explicit, true);
  assert.equal(p.area, "ui");
  const inf = b.adaptation.recordPreference({ content: "Likes step-by-step implementation with testing after each feature", explicit: false, observation: "asked to test after the inventory step" }, "claude");
  assert.equal(inf.status, "tentative");
  assert.equal(inf.explicit, false);
  b.close();

  b = openBrain(dir);
  const all = b.adaptation.listPreferences();
  assert.equal(all.length, 2);
  assert.equal(all.find((x) => x.id === p.id)!.status, "confirmed");
  // Repeated observations reinforce the same preference, never create duplicates, and only ask the user.
  b.adaptation.recordPreference({ content: "Likes step-by-step implementation with testing after each feature.", explicit: false }, "claude");
  const third = b.adaptation.recordPreference({ content: "likes step by step implementation, testing after each feature", explicit: false }, "claude");
  assert.equal(third.action, "reinforced");
  assert.equal(third.status, "tentative", "an inference is never auto-confirmed");
  assert.equal(third.evidence_count, 3);
  assert.equal(b.adaptation.listPreferences().length, 2);
  const review = b.inbox.list({ kind: "preference" });
  assert.equal(review.length, 1);
  b.inbox.approve(Number(review[0].id));
  assert.equal(b.adaptation.getPreference(String(inf.id)).status, "confirmed");
  assert.ok((b.adaptation.getPreference(String(inf.id)).versions as unknown[]).length >= 2, "version history kept");
  b.close();
});

test("preferences can be edited, pinned, rejected, outdated and deleted only with confirmation", () => {
  const b = openBrain();
  const p = b.adaptation.recordPreference({ content: "Always explain things in simple words", explicit: true }, "claude");
  const e = b.adaptation.edit(String(p.id), { content: "Explain in simple words, no jargon", pinned: true, area: "communication" });
  assert.equal(e.content, "Explain in simple words, no jargon");
  assert.equal(e.pinned, true);
  assert.equal(e.area, "communication");
  const o = b.adaptation.markOutdated(String(p.id));
  assert.equal(o.status, "outdated");
  assert.equal(b.adaptation.relevantPreferences("explain the code", null).length, 0, "outdated preferences are not used");
  const r = b.adaptation.reject(String(p.id));
  assert.equal(r.status, "rejected");
  assert.equal(r.memory_status, "archived", "rejected = archived, not deleted");
  assert.throws(() => b.adaptation.deletePreference(String(p.id), false), /permanent/);
  b.adaptation.deletePreference(String(p.id), true);
  assert.equal(b.store.getMemory(String(p.id)), null);
  b.close();
});

test("relevant preferences are scoped: project preferences never leak into other projects", () => {
  const b = openBrain();
  b.store.createProject({ name: "Cursed RNG" }, user);
  b.store.createProject({ name: "Ironbound Arena" }, user);
  b.adaptation.recordPreference({ content: "Use a red and black colour theme for Cursed RNG UI", explicit: true, project: "Cursed RNG" }, "claude");
  b.adaptation.recordPreference({ content: "Prefers modular Roblox scripts, one ModuleScript per system", explicit: true }, "claude");
  b.adaptation.recordPreference({ content: "Wants testing after each feature", explicit: true, area: "workflow" }, "claude");
  const ib = b.store.requireProject("Ironbound Arena");
  const rel = b.adaptation.relevantPreferences("Build the UI theme and scripts for the arena shop", ib.id);
  assert.ok(rel.length >= 1);
  assert.ok(rel.every((x) => !/red and black/.test(String(x.preference))), JSON.stringify(rel));
  assert.ok(rel.some((x) => /modular Roblox scripts/.test(String(x.preference))));
  const crng = b.store.requireProject("Cursed RNG");
  const rel2 = b.adaptation.relevantPreferences("Build the UI theme for the shop", crng.id);
  assert.ok(rel2.some((x) => /red and black/.test(String(x.preference))));
  for (const x of rel) assert.ok(x.source && typeof x.confidence === "number" && x.scope);
  b.close();
});

test("research: sourced insights keep provenance; missing citations are never fabricated", () => {
  const b = openBrain();
  const r = b.adaptation.submitResearch({
    topic: "Getting more players on a Roblox game",
    domain: "Roblox / Game Design / Retention",
    project: "Cursed RNG",
    summary: "Early retention matters most.",
    findings: [
      { title: "Improving Early Roblox Player Retention", insight: "Research suggests that a clear and engaging introduction helps players understand the game's goal and keep playing.", basis: "evidence", sources: [{ url: "https://create.roblox.com/docs/production/analytics/retention", title: "Retention", publisher: "Roblox Creator Hub", retrieved_at: "2026-10-23" }] },
      { insight: "Daily rewards always double your player count.", basis: "evidence", sources: [] },
      { insight: "A short cinematic might make the opening more memorable.", basis: "speculation" },
      { insight: "Thumbnails with clear characters improve click-through rate on the discover page.", basis: "evidence", sources: [{ url: "not a url", title: "" }] },
    ],
  });
  assert.equal(r.stored.length, 2);
  assert.equal(r.needs_review.length, 2, "two insights claimed evidence without usable sources");
  const sourced = b.store.requireMemory(String(r.stored[0].id));
  assert.equal(sourced.memory_type, "research");
  assert.equal(sourced.evidence, "sourced");
  assert.equal(sourced.scope, "global", "research is reusable by default");
  const src = b.adaptation.sourcesOf(sourced.id);
  assert.equal(src.length, 1);
  assert.equal(src[0].url, "https://create.roblox.com/docs/production/analytics/retention");
  const spec = b.store.requireMemory(String(r.stored[1].id));
  assert.equal(spec.evidence, "speculative");
  assert.match(spec.content, /Speculation/);
  assert.ok(spec.confidence < 0.5);
  // No URL was invented anywhere.
  const urls = b.db.all("SELECT url FROM memory_sources WHERE url IS NOT NULL").map((x) => x.url);
  assert.deepEqual(urls, ["https://create.roblox.com/docs/production/analytics/retention"]);
  // The unsourced claim is in the inbox, not stored as fact; approving keeps it labelled.
  const item = b.inbox.list({ kind: "research" }).find((i) => /Daily rewards/.test(String(i.statement)))!;
  const ap = b.inbox.approve(Number(item.id));
  const stored = b.store.requireMemory(String(ap.memory_id));
  assert.notEqual(stored.evidence, "sourced");
  assert.match(stored.content, /not guaranteed|Speculation/);
  // Hub + link
  const hub = b.store.requireMemory(String(r.hub_id));
  assert.match(hub.title, /^Research: /);
  assert.ok(b.store.relationshipsOf(sourced.id).some((x) => x.other_id === hub.id));
  // Submitting the same insight again adds sources instead of duplicating.
  const again = b.adaptation.submitResearch({ topic: "Getting more players on a Roblox game", findings: [{ insight: "Research suggests that a clear and engaging introduction helps players understand the game's goal and keep playing.", basis: "evidence", sources: [{ url: "https://example.org/onboarding-study", title: "Onboarding study" }] }] });
  assert.equal(again.stored[0].id, sourced.id);
  assert.equal(b.adaptation.sourcesOf(sourced.id).length, 2);
  b.close();
});

test("knowledge transfer: relevant lessons/research reach a new project; decisions and private projects do not", () => {
  const b = openBrain();
  b.store.createProject({ name: "Skyforge", description: "Roblox survival game with an inventory and crafting" }, user);
  b.store.createMemory({ title: "Inventory uses 6x5 grid", content: "Skyforge inventory decision: a 6x5 grid stored server-side.", category: "decision", project_id: b.store.requireProject("Skyforge").id }, claude);
  b.adaptation.recordLesson({ problem: "Inventory trusted client-reported item quantities", correction: "Server validates every inventory change", lesson: "Important inventory changes in Roblox games should be validated on the server instead of trusting client values.", verified: true, project: "Skyforge", scope: "global", domain: "Roblox / Security" });
  b.adaptation.submitResearch({ topic: "Roblox retention", domain: "Roblox / Retention", findings: [{ insight: "A clear introduction in the first minutes of a Roblox game helps new players understand the goal and keep playing.", basis: "evidence", sources: [{ url: "https://example.org/roblox-retention", title: "Retention notes" }] }] });
  const secret = b.store.createProject({ name: "Secret Client Work", description: "private roblox inventory contract" }, user);
  b.store.updateProject(secret.id, { private: true }, user);
  b.adaptation.recordLesson({ problem: "Client inventory exploit in the contract game", correction: "Server-side inventory validation added for the contract", lesson: "Roblox inventory validation for the private client game must run on the server.", verified: true, project: "Secret Client Work", scope: "global" });

  const sim = b.store.createProject({ name: "Pet Simulator", description: "New Roblox simulator game with an inventory of pets and early player retention goals" }, user);
  const cands = b.adaptation.transferCandidates(sim.id);
  const titles = cands.map((c) => String(c.title));
  assert.ok(cands.some((c) => c.memory_type === "lesson" && /validated on the server/.test(String(c.summary))), JSON.stringify(titles));
  assert.ok(cands.some((c) => c.memory_type === "research"), JSON.stringify(titles));
  assert.ok(!titles.some((t) => /6x5 grid/.test(t)), "old project decisions are not transferred");
  assert.ok(!cands.some((c) => /private client game/.test(String(c.summary))), "private projects never leak");
  for (const c of cands) assert.ok(typeof c.confidence === "number" && c.source && c.reason);

  const r = b.adaptation.refreshTransfer(sim.id);
  assert.ok((r.suggestions as unknown[]).length >= 2);
  const first = (r.suggestions as any[])[0];
  b.adaptation.decideTransfer(first.id, "dismissed");
  assert.ok(!b.adaptation.transferCandidates(sim.id).some((c) => c.memory_id === first.memory_id), "dismissed suggestions stay dismissed");

  b.store.updateProject(sim.id, { transfer_enabled: false }, user);
  assert.equal(b.adaptation.transferCandidates(sim.id).length, 0);
  b.close();
});

test("lessons: verified lessons are stored with problem/correction; unverified wait for review", () => {
  const b = openBrain();
  const u = b.adaptation.recordLesson({ problem: "Spawner leaked parts", correction: "Destroy parts on despawn", lesson: "Always clean up spawned parts", verified: false });
  assert.equal(u.stored, false);
  assert.ok(u.review_id);
  assert.equal(b.adaptation.listLessons().length, 0);
  const v = b.adaptation.recordLesson({ problem: "Inventory trusted client quantities", correction: "Server-side validation", lesson: "Validate inventory changes on the server", verified: true, project: "Skyforge" });
  assert.equal(v.stored, true);
  assert.equal(v.scope, "project", "lessons are project-scoped unless marked global");
  const l = b.adaptation.listLessons()[0];
  assert.equal(l.problem, "Inventory trusted client quantities");
  assert.equal(l.verified, true);
  b.inbox.reject(Number(u.review_id));
  assert.equal(b.adaptation.listLessons().length, 1, "rejected lesson was not applied");
  b.close();
});

test("Privacy Mode blocks automatic learning, research capture and cloud fallback; user actions still work", () => {
  const b = openBrain();
  b.setPrivacyMode(true);
  assert.equal(b.learningHeld(), true);
  return (async () => {
    await assert.rejects(() => b.commitLearning({ summary: "x" } as any, "claude"), /Privacy Mode/);
    assert.throws(() => b.adaptation.submitResearch({ topic: "t", findings: [{ insight: "something long enough", basis: "speculation" }] }), /Privacy Mode/);
    assert.throws(() => b.cortex.enqueueLearn({ text: "remember this please" } as any, "mcp"), /Privacy Mode/);
    assert.equal((b.cortex as any).router.status().cloud.ok, false);
    assert.match(String((b.cortex as any).router.status().cloud.reason), /Privacy Mode|switched off/);
    assert.match(String(b.ai.available().reason), /turned off|Privacy/);
    // Jobs from Claude are held, the user's own are not.
    const held = b.heldJobsSql()!;
    b.jobs.enqueue("cortex_learn", { text: "a", origin: "mcp" });
    b.jobs.enqueue("cortex_learn", { text: "b", origin: "user" });
    b.jobs.enqueue("reflect", {});
    const runnable = b.db.all(`SELECT kind, json_extract(payload,'$.origin') AS origin FROM jobs WHERE status = 'pending' AND ${held}`);
    assert.deepEqual(runnable.map((r) => `${r.kind}:${r.origin}`), ["cortex_learn:user"]);
    // Manual memories still work and stay visible.
    const q = b.quickCapture({ text: "Manual note while private", analyze: true });
    assert.equal(q.persisted, true);
    assert.match(String(q.analysis), /not ready|paused/);
    // Turning it off is explicit; nothing resumes by itself.
    assert.equal(b.privacyMode(), true);
    b.setPrivacyMode(false);
    assert.equal(b.heldJobsSql() === null || !/cortex_learn/.test(b.heldJobsSql()!), true);
    b.close();
  })();
});

test("Quick Capture persists before any AI and works without a model", () => {
  const dir = tmpDir();
  let b = openBrain(dir);
  b.store.createProject({ name: "Swing and Grow" }, user);
  const r = b.quickCapture({ text: "I'm building a Roblox game about swinging.", project: "Swing and Grow" });
  assert.equal(r.persisted, true);
  assert.match(String(r.analysis), /Cortex not ready/);
  b.close();
  b = openBrain(dir);
  const m = b.store.requireMemory(String((r.memory as any).id));
  assert.equal(m.source, "quick-capture");
  assert.equal(m.project_id, b.store.requireProject("Swing and Grow").id);
  const g = b.graph({});
  assert.ok((g.nodes as any[]).some((n) => n.id === m.id), "the memory is a node in The Mind");
  assert.ok((g.links as any[]).some((l) => l.source_id === m.id), "linked to its project hub");
  b.close();
});

test("Memory Inbox: defer hides an item, reject applies nothing, approve preserves history", () => {
  const b = openBrain();
  const a = b.store.createMemory({ title: "Spawn rate", content: "Zombies spawn every 30 seconds." }, claude);
  const n = b.store.createMemory({ title: "Spawn rate new", content: "Zombies spawn every 10 seconds now." }, claude);
  const id1 = b.inbox.add({ kind: "conflict", operation: "supersede", statement: n.content, target_memory_id: a.id, affected_ids: [a.id, n.id], reason: "conflict", proposal: { handler: "supersede_capture", target_id: a.id, new_id: n.id } });
  const id2 = b.inbox.add({ kind: "duplicate", operation: "merge", statement: n.content, target_memory_id: a.id, affected_ids: [a.id, n.id], reason: "dup", proposal: { handler: "merge_capture", target_id: a.id, new_id: n.id } });
  assert.equal(b.inbox.add({ kind: "duplicate", operation: "merge", statement: n.content, target_memory_id: a.id, reason: "dup again" }), id2, "duplicate proposals are not queued twice");
  b.inbox.defer(id2, 24);
  assert.deepEqual(b.inbox.list().map((x) => x.id), [id1]);
  assert.equal(b.inbox.list({ include_deferred: true }).length, 2);
  assert.equal(b.inbox.counts().deferred, 1);
  b.inbox.reject(id2, "keep both");
  assert.equal(b.store.requireMemory(n.id).status, "active", "rejected merge not applied");
  const before = b.store.versions(a.id).length;
  b.inbox.approve(id1);
  assert.equal(b.store.requireMemory(a.id).status, "superseded");
  assert.ok(b.store.versions(a.id).length > before, "history preserved");
  assert.ok(b.db.value("SELECT 1 FROM feedback WHERE subject_id = ? AND verdict = 'incorrect'", [String(id2)]), "rejection informs future decisions");
  b.close();
});

test("backups are integrity-checked, honour location/retention and restore a valid database", () => {
  const dir = tmpDir();
  const loc = tmpDir("moth-backups");
  let b = openBrain(dir);
  b.settings.set("backup.location", loc);
  b.settings.set("backup.keep", 2);
  const m = b.store.createMemory({ content: "Before backup: the hub is in the sky." }, user);
  b.adaptation.recordPreference({ content: "Prefers dark UI", explicit: true }, "user");
  const bk = b.backup("manual");
  assert.equal(bk.integrity, "ok");
  assert.equal(path.dirname(bk.path), loc);
  for (let i = 0; i < 4; i++) b.backup("auto");
  assert.equal(fs.readdirSync(loc).filter((f) => f.startsWith("auto-")).length, 2, "keeps only the newest automatic backups");
  const info = b.inspectBackup(bk.name);
  assert.equal(info.ok, true);
  assert.equal(info.memories, 2);
  assert.equal(info.schema_version, 3);
  b.store.updateMemory(m.id, { content: "After backup: changed." }, user);
  const methods = rpc(() => b, () => {
    b.close();
    b = openBrain(dir);
  });
  methods["backup.restore"]({ name: bk.name });
  assert.equal(b.store.requireMemory(m.id).content, "Before backup: the hub is in the sky.");
  assert.equal(b.adaptation.listPreferences().length, 1, "preferences restored too");
  assert.equal(b.db.value("PRAGMA quick_check"), "ok");
  b.close();
});

test("Claude Inbox folder imports notes once, moves them to Imported, never deletes, and respects Privacy Mode", () => {
  const b = openBrain();
  const inbox = tmpDir("moth-inbox");
  b.folders.setupInbox(inbox);
  const note = path.join(inbox, "2026-10-23 chat.md");
  fs.writeFileSync(note, "---\nmoth_project: MOTH\ntags: [moth, chat]\n---\n# MOTH build chat\n\nWe decided to use llama.cpp instead of Ollama.");
  fs.writeFileSync(path.join(inbox, "research.json"), JSON.stringify({ type: "research", topic: "Tray apps", findings: [{ insight: "Windows tray apps should keep running when the window closes.", basis: "evidence", sources: [{ url: "https://learn.microsoft.com/windows/apps/design/shell/tiles-and-notifications/", title: "Notifications" }] }] }));
  const past = Date.now() / 1000 - 60;
  for (const f of fs.readdirSync(inbox)) fs.utimesSync(path.join(inbox, f), past, past);
  b.setPrivacyMode(true);
  assert.match(String(b.folders.scanInbox().skipped), /Privacy Mode/);
  assert.ok(fs.existsSync(note), "files wait while private");
  b.setPrivacyMode(false);
  const r = b.folders.scanInbox();
  assert.equal(r.failed, 0, JSON.stringify(r));
  assert.ok(Number(r.imported) >= 3);
  assert.ok(!fs.existsSync(note));
  const imported = fs.readdirSync(path.join(inbox, "Imported"), { recursive: true }).map(String);
  assert.ok(imported.some((f) => f.endsWith("2026-10-23 chat.md")), "moved, not deleted");
  const m = b.store.listMemories({ source: "claude-inbox" }).items.find((x) => x.title === "MOTH build chat")!;
  assert.equal(m.title, "MOTH build chat");
  assert.equal(m.project_id, b.store.requireProject("MOTH").id);
  // Same file dropped again: no duplicate memory.
  fs.writeFileSync(note, fs.readFileSync(path.join(inbox, "Imported", imported.find((f) => f.endsWith("chat.md"))!), "utf8"));
  fs.utimesSync(note, past, past);
  const again = b.folders.scanInbox();
  assert.equal(again.duplicates, 1);
  assert.equal(b.store.listMemories({ source: "claude-inbox" }).items.filter((x) => x.title === "MOTH build chat").length, 1);
  // Unknown JSON is rejected rather than guessed.
  assert.throws(() => parseFile("x.json", JSON.stringify({ hello: 1 })), /no memories found/);
  b.close();
});

test("import of single MD / TXT / JSON files avoids duplicates", () => {
  const b = openBrain();
  const d = tmpDir("moth-import");
  fs.writeFileSync(path.join(d, "note.txt"), "Plain text note about the hub world.");
  fs.writeFileSync(path.join(d, "list.json"), JSON.stringify([{ title: "A", content: "First imported memory" }, { title: "B", content: "Second imported memory", category: "idea" }]));
  const r1 = b.folders.importFiles([path.join(d, "note.txt"), path.join(d, "list.json")]);
  assert.equal(r1.imported, 3);
  const r2 = b.folders.importFiles([path.join(d, "note.txt"), path.join(d, "list.json")]);
  assert.equal(b.store.listMemories({ source: "import" }).total, 3, JSON.stringify(r2));
  assert.equal(b.store.listMemories({ source: "import", category: "idea" }).total, 1);
  b.close();
});

test("First Flight progress survives restart and can be restarted", () => {
  const dir = tmpDir();
  let b = openBrain(dir);
  let m = rpc(() => b);
  m["firstFlight.save"]({ step: 2, skipped: ["model"] });
  b.close();
  b = openBrain(dir);
  m = rpc(() => b);
  const ff = m["firstFlight.get"]({}) as any;
  assert.equal(ff.step, 2);
  assert.deepEqual(ff.skipped, ["model"]);
  assert.equal(b.settings.get("onboarding.completed"), false);
  const cap = m["capture.save"]({ text: "I'm building a Roblox game.", source: "first-flight" }) as any;
  m["firstFlight.save"]({ step: 5, completed: true, firstMemoryId: cap.memory.id });
  assert.equal(b.settings.get("onboarding.completed"), true);
  assert.equal(b.store.requireMemory(cap.memory.id).source, "first-flight");
  m["firstFlight.restart"]({});
  assert.equal((m["firstFlight.get"]({}) as any).step, 0);
  assert.equal(b.settings.get("onboarding.completed"), false);
  b.close();
});

test("Pulse and Timeline report real stored numbers and filter correctly", () => {
  const b = openBrain();
  b.store.createProject({ name: "Ironbound Arena" }, user);
  const a = b.store.createMemory({ content: "Arena uses round based combat", project_id: b.store.requireProject("Ironbound Arena").id }, claude);
  const c = b.store.createMemory({ content: "Combat uses a stamina bar" }, claude);
  b.store.link(a.id, c.id, "RELATED_TO", "both about combat", claude);
  b.adaptation.recordPreference({ content: "Prefers dark UI", explicit: true }, "user");
  const p = pulse(b);
  const t = p.totals as any;
  assert.equal(t.memories, Number(b.db.value("SELECT COUNT(*) FROM memories WHERE status = 'active'")));
  assert.equal(t.preferences, 1);
  assert.equal(t.projects, 1);
  assert.ok(t.relationships >= 2);
  assert.ok((p.feed as any[]).some((e) => e.label === "Connection discovered"));
  assert.equal((p.mcp as any).last_success, null, "no Claude interaction recorded, none claimed");
  const tl = timeline(b, { memory_type: "preference" });
  assert.ok((tl.items as any[]).length >= 1);
  assert.ok((tl.items as any[]).every((i) => i.memory_type === "preference"));
  const byProject = timeline(b, { project_id: b.store.requireProject("Ironbound Arena").id });
  assert.ok((byProject.items as any[]).every((i) => i.project_id === b.store.requireProject("Ironbound Arena").id));
  const byActor = timeline(b, { source: "user" });
  assert.ok((byActor.items as any[]).every((i) => i.actor === "user"));
  b.close();
});

test("pinning boosts retrieval slightly; smart search filters by type, source, confidence and pinned", async () => {
  const b = openBrain();
  const x = b.store.createMemory({ title: "Lobby music", content: "The lobby plays calm piano music." }, claude);
  const y = b.store.createMemory({ title: "Lobby lighting", content: "The lobby uses calm warm lighting." }, user);
  b.store.updateMemory(x.id, { pinned: true }, user);
  const res = await b.search.hybrid("calm lobby", { pinned: true });
  assert.deepEqual(res.map((r) => r.memory.id), [x.id]);
  assert.ok(res[0].why.includes("pinned"));
  const bySource = await b.search.hybrid("calm lobby", { source: "user" });
  assert.deepEqual(bySource.map((r) => r.memory.id), [y.id]);
  const conf = await b.search.hybrid("calm lobby", { min_confidence: 0.9 });
  assert.deepEqual(conf.map((r) => r.memory.id), [y.id]);
  const typed = await b.search.hybrid("calm lobby", { memory_type: "semantic" });
  assert.equal(typed.length, 2);
  b.close();
});

test("begin_task returns relevant preferences and knowledge transfer with provenance", async () => {
  const b = openBrain();
  b.adaptation.recordPreference({ content: "Prefers modular Roblox scripts", explicit: true, area: "coding" }, "user");
  b.adaptation.recordLesson({ problem: "Client trusted for coins", correction: "Server validates coin changes", lesson: "Validate currency and inventory changes on the server in Roblox games", verified: true, project: "Old Obby", scope: "global" });
  b.store.createProject({ name: "Coin Simulator", description: "Roblox simulator with coins and an inventory" }, user);
  const r = await b.beginTask({ task: "Add a coin shop to Coin Simulator with an inventory" });
  assert.equal(r.project?.name, "Coin Simulator");
  assert.ok(r.preferences.some((p) => /modular Roblox scripts/.test(String(p.preference))));
  assert.ok(r.knowledge_transfer, "transfer section present");
  assert.ok((r.knowledge_transfer!.items as any[]).some((i) => i.memory_type === "lesson"));
  assert.match(String(r.knowledge_transfer!.note), /not rules/);
  b.close();
});

test("Sleep Cycle scheduling follows the chosen mode and never runs while paused", async () => {
  const b = openBrain();
  b.settings.set("sleep.mode", "manual");
  assert.equal(b.sleepDue(), false);
  b.settings.set("sleep.mode", "idle");
  b.system = { idleSeconds: 30, onBattery: false, batterySaver: false, updatedAt: Date.now() };
  assert.equal(b.sleepDue(), false, "PC in use");
  b.system = { idleSeconds: 3600, onBattery: false, batterySaver: false, updatedAt: Date.now() };
  assert.equal(b.sleepDue(), true);
  b.settings.set("sleep.mode", "after_session");
  assert.equal(b.sleepDue(), false, "no Claude session finished yet");
  const t = b.store.beginTask("work", null, "claude-code", []);
  b.store.endTask(t, "completed", "done");
  assert.equal(b.sleepDue(), true);
  b.setLearningPaused(true);
  const r = await b.sleepCycle();
  assert.match(String(r.skipped), /paused/);
  b.setLearningPaused(false);
  b.system = { idleSeconds: 3600, onBattery: true, batterySaver: true, updatedAt: Date.now() };
  assert.match(String((await b.sleepCycle()).skipped), /Battery saver/);
  b.system = { idleSeconds: 3600, onBattery: false, batterySaver: false, updatedAt: Date.now() };
  const done = await b.sleepCycle(undefined, true);
  assert.equal(done.sleep_cycle, true);
  assert.ok(b.settings.get("sleep.lastRun"));
  assert.equal(b.sleepDue(), false, "just ran");
  b.close();
});

test("resource profiles change the model's idle unload time; notifications follow the chosen level", () => {
  const b = openBrain();
  b.settings.set("cortex.idleTimeoutMin", 5);
  b.settings.set("resources.profile", "eco");
  assert.equal(b.cortex.effectiveIdleMs(), 2 * 60_000);
  b.settings.set("resources.profile", "balanced");
  assert.equal(b.cortex.effectiveIdleMs(), 5 * 60_000);
  b.settings.set("resources.profile", "performance");
  assert.equal(b.cortex.effectiveIdleMs(), 15 * 60_000);
  b.settings.set("notifications.level", "important");
  b.notify("info", "routine", "x");
  b.notify("important", "Backup failed", "disk full", "k1");
  b.notify("important", "Backup failed", "disk full", "k1");
  b.settings.set("notifications.level", "silent");
  b.notify("important", "silent", "x");
  const n = b.store.listActivity({ kind: "notification" });
  assert.equal(n.length, 1);
  assert.equal((n[0].detail as any).title, "Backup failed");
  b.close();
});

test("full quit drains jobs, re-queues unfinished work and closes the database", async () => {
  const b = openBrain();
  let started = false;
  b.jobs.register("slow", async (_j, signal) => {
    started = true;
    await new Promise((r, rej) => {
      const t = setTimeout(r, 30_000);
      signal.addEventListener("abort", () => (clearTimeout(t), rej(new Error("aborted"))));
    });
  });
  b.jobs.start();
  b.jobs.enqueue("slow", {});
  b.jobs.enqueue("slow", {});
  while (!started) await new Promise((r) => setTimeout(r, 20));
  const r = await b.shutdownGracefully(300);
  assert.ok(Number(r.ms) < 6000);
  const db = new Database(b.db.file);
  const rows = db.all("SELECT status FROM jobs WHERE kind = 'slow'");
  assert.ok(rows.every((x) => x.status === "pending" || x.status === "failed"), JSON.stringify(rows));
  assert.ok(rows.some((x) => x.status === "pending"), "unfinished work is kept for the next start");
  db.close();
});
