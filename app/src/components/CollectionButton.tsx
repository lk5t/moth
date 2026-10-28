// Add a note, memory or project to collections (groups that don't move anything).
import { Layers } from "lucide-react";
import { useState } from "react";
import { rpc } from "../lib/api";
import { useApp } from "../lib/app";
import { useLive } from "../lib/hooks";
import { Button, Dialog, Input, Switch } from "./ui";

export function CollectionButton({ kind, id }: { kind: "document" | "memory" | "project"; id: string }) {
  const { toast } = useApp();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const { data: cols, reload } = useLive<any[]>("collections.list", {}, { entities: ["collection"], enabled: open });
  const { data: mine, reload: reloadMine } = useLive<string[]>("collections.of", { kind, id }, { entities: ["collection"], enabled: open });
  const set = async (cid: string, inIt: boolean) => {
    try {
      await rpc("collections.set", { id: cid, kind, entity_id: id, in: inIt });
      void reloadMine();
      void reload();
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    }
  };
  return (
    <>
      <button title="Collections" aria-label="Collections" onClick={() => setOpen(true)} className="grid size-7 place-items-center rounded-[6px] text-ink-3 hover:bg-surface-2 hover:text-ink [&_svg]:size-3.5">
        <Layers />
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Collections" width={420}>
        <div className="grid gap-2">
          {(cols ?? []).map((c) => (
            <label key={c.id} className="flex items-center justify-between text-[13px] text-ink-2">
              {c.name}
              <Switch checked={(mine ?? []).includes(c.id)} onChange={(v) => void set(c.id, v)} label={c.name} />
            </label>
          ))}
          {cols && !cols.length ? <p className="text-[12.5px] text-ink-3">No collections yet.</p> : null}
          <div className="mt-1 flex gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New collection" aria-label="New collection name" />
            <Button
              disabled={!name.trim()}
              onClick={() =>
                void rpc<any>("collections.create", { name: name.trim() })
                  .then((c) => (setName(""), set(c.id, true)))
                  .catch((e) => toast({ kind: "error", text: e.message }))
              }
            >
              Add
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
