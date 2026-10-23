// Deterministic safety validator for Cortex proposals ("balanced autonomy" by default).
// Decides: apply automatically, send to the review queue, or reject. The model never decides this.
import type { Memory } from "../engine/types.ts";
import type { Comparison, Operation } from "./prompts.ts";

export type Autonomy = "cautious" | "balanced" | "autonomous";

export interface Candidate {
  index: number; // 1-based, as shown to the model
  memory: Memory;
  similarity: number;
}

export interface ValidationInput {
  proposal: Comparison;
  statement: string;
  candidates: Candidate[];
  autonomy: Autonomy;
  minConfidence: number;
  duplicateThreshold: number;
  maxSimilarityToAny: number; // statement vs every active memory (local vectors)
  sourcePresent: boolean;
  existingLink?: boolean;
}

export interface Decision {
  action: "apply" | "review" | "reject";
  operation: Operation;
  target: Memory | null;
  risk: "low" | "medium" | "high";
  checks: string[]; // human-readable trail of what was checked
  reason: string;
}

const NEEDS_TARGET: Operation[] = ["append", "update", "link", "mark_duplicate", "flag_contradiction", "none"];
const EXPECTED_OP: Record<string, Operation[]> = {
  new: ["create"],
  already_known: ["none", "mark_duplicate"],
  extends: ["append", "link"],
  correction: ["update"],
  contradiction: ["flag_contradiction", "review"],
  historical: ["append", "create"],
  uncertain: ["review"],
};

export function validateProposal(v: ValidationInput): Decision {
  const p = v.proposal;
  const checks: string[] = [];
  let op = p.operation;
  const target = p.target > 0 ? v.candidates.find((c) => c.index === p.target)?.memory ?? null : null;
  const conf = Number.isFinite(p.confidence) ? p.confidence : 0;

  // Schema-level sanity already passed (router). Now identifiers and state.
  if (p.target > 0 && !target) {
    checks.push(`target ${p.target} is not one of the memories shown → invalid identifier`);
    return { action: "reject", operation: op, target: null, risk: "high", checks, reason: "The model referred to a memory that does not exist." };
  }
  checks.push(target ? `target is "${target.title}" (version ${target.version})` : "no target memory");
  if (NEEDS_TARGET.includes(op) && !target) {
    if (op === "none") return { action: "reject", operation: op, target: null, risk: "low", checks: [...checks, "nothing to do"], reason: "No change proposed." };
    checks.push(`"${op}" needs a target memory but none was given`);
    return { action: "review", operation: "review", target: null, risk: "medium", checks, reason: "The proposal was incomplete, so a person should decide." };
  }
  if (target && target.status !== "active") {
    checks.push(`target is ${target.status}, not active`);
    return { action: "review", operation: op, target, risk: "medium", checks, reason: "The memory it refers to is no longer active." };
  }
  if (["create", "append", "update"].includes(op) && !p.content.trim()) {
    checks.push("no content for a write operation");
    return { action: "reject", operation: op, target, risk: "medium", checks, reason: "The proposal had no content to store." };
  }
  if (!v.sourcePresent && ["create", "append", "update"].includes(op)) {
    checks.push("no source recorded");
    return { action: "review", operation: op, target, risk: "medium", checks, reason: "Knowledge without a source needs your confirmation." };
  }

  // Consistency between the model's own relation and operation.
  const expected = EXPECTED_OP[p.relation] ?? [];
  if (!expected.includes(op)) {
    checks.push(`relation "${p.relation}" does not match operation "${op}"`);
    return { action: "review", operation: op, target, risk: "medium", checks, reason: "The model's reasoning was inconsistent, so it needs your review." };
  }
  checks.push(`relation "${p.relation}" is consistent with "${op}"`);

  if (conf < v.minConfidence) {
    checks.push(`confidence ${conf.toFixed(2)} below ${v.minConfidence}`);
    return { action: "review", operation: op, target, risk: "medium", checks, reason: "The model was not confident enough to change memory on its own." };
  }
  checks.push(`confidence ${conf.toFixed(2)}`);

  switch (op) {
    case "none":
    case "mark_duplicate":
      return { action: "apply", operation: op, target, risk: "low", checks: [...checks, "no content changes"], reason: "Already known; the existing memory is reinforced." };
    case "create": {
      if (v.maxSimilarityToAny >= v.duplicateThreshold) {
        checks.push(`very similar to an existing memory (${v.maxSimilarityToAny.toFixed(2)})`);
        return { action: "review", operation: op, target, risk: "medium", checks, reason: "This may duplicate an existing memory." };
      }
      if (v.autonomy === "cautious") return { action: "review", operation: op, target, risk: "low", checks: [...checks, "cautious mode"], reason: "Cautious mode: new memories wait for approval." };
      return { action: "apply", operation: op, target, risk: "low", checks: [...checks, "new sourced memory, no duplicate risk"], reason: "New, sourced information." };
    }
    case "append":
      if (v.autonomy === "cautious") return { action: "review", operation: op, target, risk: "low", checks: [...checks, "cautious mode"], reason: "Cautious mode: changes wait for approval." };
      return { action: "apply", operation: op, target, risk: "low", checks: [...checks, "adds information without replacing anything"], reason: "Adds non-conflicting detail." };
    case "link":
      if (p.link_type === "none") return { action: "reject", operation: op, target, risk: "low", checks: [...checks, "no relationship type"], reason: "No relationship type given." };
      if (v.existingLink) return { action: "reject", operation: op, target, risk: "low", checks: [...checks, "connection already exists"], reason: "Already connected." };
      if (conf < 0.6) return { action: "review", operation: op, target, risk: "low", checks, reason: "Weakly supported connection." };
      return { action: "apply", operation: op, target, risk: "low", checks: [...checks, "well-supported connection"], reason: "Well-supported relationship." };
    case "update": {
      checks.push("replaces existing content (previous version kept in history)");
      if (target!.manual_lock) return { action: "review", operation: op, target, risk: "high", checks: [...checks, "target was written or corrected by you"], reason: "It would change something you wrote yourself." };
      if (v.autonomy === "autonomous" && conf >= 0.85 && target!.importance < 0.8) return { action: "apply", operation: op, target, risk: "medium", checks: [...checks, "autonomous mode, high confidence"], reason: "High-confidence correction." };
      return { action: "review", operation: op, target, risk: "medium", checks, reason: "Replacing a stored fact needs your approval." };
    }
    case "flag_contradiction":
      return { action: "review", operation: op, target, risk: "medium", checks: [...checks, "conflicting evidence: both versions kept"], reason: "The new statement disagrees with what MOTH knows." };
    case "review":
    default:
      return { action: "review", operation: "review", target, risk: "medium", checks, reason: p.reason || "The model asked for a human decision." };
  }
}
