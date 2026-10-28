// Child process for the agent restart test: runs the Research Analyst with a stand-in model that hangs on its second
// call, reports after the first insight was proposed, then waits to be killed with SIGKILL (a real crash).
import { Brain } from "../../src/engine/brain.ts";
import { useFakeModel } from "./fake-model.ts";

process.env.MOTH_LOG_STDERR = "0";
const b = Brain.open({ dataDir: process.argv[2], role: "test" });
let n = 0;
useFakeModel(b, async (req) => {
  n++;
  if (n === 1) {
    setTimeout(() => process.stdout.write("FIRST_DONE\n"), 300);
    const quote = /Cats sleep about 15 hours a day/.test(req.user) ? "Cats sleep about 15 hours a day" : "Dogs need daily walks";
    return JSON.stringify({ insights: [{ text: `Insight: ${quote}.`, quote, source: 1 }] });
  }
  return new Promise(() => {}); // hangs: the parent kills us here
});
b.registerIntelligenceJobs();
b.jobs.start();
