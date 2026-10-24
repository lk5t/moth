// Child process for the crash-recovery test: runs a checkpointed job, reports after its first step has
// committed, then hangs until the parent kills it with SIGKILL (a real crash: no cleanup runs).
import { Brain } from "../../src/engine/brain.ts";

process.env.MOTH_LOG_STDERR = "0";
const dir = process.argv[2];
const b = Brain.open({ dataDir: dir, role: "test" });
const ctx = { actor: "moth" as const, reason: "crash test" };
for (const [kind, resumable] of [["intel_crash_resumable", true], ["intel_crash_once", false]] as const) {
  b.jobs.register(
    kind,
    async (job, signal, jc) => {
      await jc.step("write-memory", () => b.store.createMemory({ title: `Written by ${kind}`, content: `Step 1 of job ${job.id}` }, ctx).id);
      process.stdout.write(`STEP_DONE ${job.id}\n`);
      await new Promise((_r, rej) => signal.addEventListener("abort", () => rej(new Error("aborted"))));
    },
    { resumable },
  );
}
b.jobs.start();
