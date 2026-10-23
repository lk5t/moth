// MOCK llama-server used ONLY by mocked lifecycle/plumbing tests. It is NOT a language model:
// it answers with deterministic JSON so MOTH's runtime manager, router and pipeline can be
// tested without a real model. Real inference is tested separately (test-real/).
import http from "node:http";
import fs from "node:fs";

const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const loadMs = Number(process.env.FAKE_LOAD_MS ?? 300);
const started = Date.now();
let calls = 0;

function reply(res, obj, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}
function completion(content) {
  return { choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
}

http
  .createServer((req, res) => {
    if (req.url === "/health") return Date.now() - started < loadMs ? reply(res, { status: "loading" }, 503) : reply(res, { status: "ok" });
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      calls++;
      if (process.env.FAKE_COUNTER) fs.writeFileSync(process.env.FAKE_COUNTER, String(calls));
      const j = JSON.parse(body || "{}");
      const sys = j.messages?.[0]?.content ?? "";
      const user = j.messages?.[1]?.content ?? "";
      if (process.env.FAKE_GARBAGE_FIRST && calls === 1) return reply(res, completion("this is not json"));
      if (sys.includes("extract durable knowledge")) {
        const text = (user.match(/"""\n([\s\S]*)\n"""/) ?? [, ""])[1];
        const statements = text.split(/(?<=[.!?])\s+/).filter((t) => t.trim()).map((t) => ({ text: t.trim(), kind: /upgrad|changed|now/i.test(t) ? "change" : "fact", entities: (t.match(/inventory|slots|Roblox/gi) ?? []).map((x) => x.toLowerCase()), project: "" }));
        return reply(res, completion(JSON.stringify({ statements })));
      }
      if (sys.includes("compare ONE new statement")) {
        const statement = (user.match(/New statement: "([\s\S]*)"$/) ?? [, ""])[1];
        const mem = user.match(/\[1\] ([^:]+): ([^\n]*?) \(updated/);
        const shares = mem && /inventory/i.test(mem[2]) && /inventory/i.test(statement);
        if (shares && /upgraded|now/i.test(statement)) {
          const n = (statement.match(/(\w+) slots/) ?? [, "?"])[1];
          return reply(res, completion(JSON.stringify({ relation: "correction", target: 1, operation: "update", title: mem[1], content: mem[2].replace(/\w+ slots/, `${n} slots`), link_type: "none", reason: "The slot count changed.", confidence: 0.9 })));
        }
        if (shares && mem[2].includes(statement.replace(/\.$/, ""))) return reply(res, completion(JSON.stringify({ relation: "already_known", target: 1, operation: "none", title: mem[1], content: "", link_type: "none", reason: "Same fact.", confidence: 0.9 })));
        return reply(res, completion(JSON.stringify({ relation: "new", target: 0, operation: "create", title: statement.slice(0, 40), content: statement, link_type: "none", reason: "Nothing similar stored.", confidence: 0.8 })));
      }
      if (sys.includes("prepare a short briefing")) return reply(res, completion(JSON.stringify({ brief: "MOCK brief.", relevant: [1] })));
      reply(res, completion("{}"));
    });
  })
  .listen(port, "127.0.0.1");
