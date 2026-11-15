import type { Evidence } from "./evidence.ts";

// Text an honest finding has no reason to contain: it addresses the reviewing pipeline, not the reader.
const INSTRUCTION_PATTERNS: [string, RegExp][] = [
  ["pipeline field name", /\b(code_supports_claim|known_issue_match|severity_supported|missing_evidence|trusted_role_required|blocking_code|root_cause_line)\b/i],
  ["override request", /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(instructions?|prompts?|rules|guidelines|above|previous|prior)\b/i],
  ["system or assistant voice", /(^|\n)\s*(<!--\s*)?(system|assistant|developer)\s*(note|message|prompt)?\s*[:>-]/i],
  ["note to an automated reviewer", /\b(note|message|instructions?)\s+(to|for)\s+(the\s+)?(automated|ai|llm|model|bot|reviewer|evaluator|extractor|grader|checker|agent)\b/i],
  ["verdict dictation", /\b(output|return|set|mark|record|classify|rate|label)\b[^.\n]{0,30}\b(verdict|severity|as\s+(ready|valid|high))\b/i],
  ["verdict-shaped JSON", /\{\s*"(verdict|severity|decision)"\s*:/i],
  ["impersonated judge", /\b(c4-judge|judge|sponsor)\s+(commented|confirmed|has\s+(validated|confirmed|approved))\b/i],
  ["role play", /\b(you\s+are\s+now|pretend\s+to\s+be|stay\s+in\s+character|act\s+as\s+(a|an|the))\b/i],
  ["hidden text", /[​-‏⁠-⁤﻿]|<!--[\s\S]*?-->/],
];

export function scanInstructions(text: string): string[] {
  return INSTRUCTION_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

export type Proof = Evidence["poc"];
const PROOF_RANK: Proof[] = ["none", "narrative_only", "concrete_steps", "runnable_test"];

// What the finding itself shows, read by code. The evidence record may not claim more.
export function proofInReport(body: string): Proof {
  const blocks = [...body.matchAll(/```[\w-]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  if (blocks.some((b) => /function\s+test\w*\s*\(|\bforge\s+test\b|\b(it|describe)\(\s*["'`]/.test(b))) return "runnable_test";
  const numbered = body.match(/^\s*\d+[.)]\s+\S/gm)?.length ?? 0;
  if (numbered >= 3) return "concrete_steps";
  return "narrative_only";
}

export function capProof(claimed: Proof, shown: Proof): Proof {
  return PROOF_RANK.indexOf(claimed) > PROOF_RANK.indexOf(shown) ? shown : claimed;
}
