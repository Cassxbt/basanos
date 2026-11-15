import { z } from "zod";

// What a judge needs to accept a finding. Every missing item names the one it affects.
export const OBLIGATIONS: Record<number, string> = {
  1: "the affected code is in scope and the causal references resolve",
  2: "the path is reachable under the allowed actors and preconditions in the contest policy",
  3: "the demonstrated effect supports the stated impact and severity",
  4: "no known issue or explicit policy exclusion applies",
  5: "the reproduction evidence supports this particular claim, with no unresolved contradictory premise",
};

export const PIPELINE_VERSION = "obligations-v2";

export const MissingItemZ = z.object({
  item: z.string(),
  category: z.enum(["required", "strengthens"]),
  obligation: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  why: z.string(),
  resolves_when: z.string(),
});

export type MissingItem = z.infer<typeof MissingItemZ>;

export const MISSING_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["item", "category", "obligation", "why", "resolves_when"],
  properties: {
    item: { type: "string" },
    category: { type: "string", enum: ["required", "strengthens"] },
    obligation: { type: "integer", enum: [1, 2, 3, 4, 5] },
    why: { type: "string" },
    resolves_when: { type: "string" },
  },
};

export const OBLIGATIONS_PROMPT = `A finding is acceptable when all five obligations hold:
${Object.entries(OBLIGATIONS).map(([k, v]) => `${k}. ${v}.`).join("\n")}

Every missing item you list must name the obligation it affects and be classified:
- "required": the claim cannot be accepted without it. Explain in "why" how its absence breaks that obligation.
- "strengthens": a judge might like it, but its absence does not undermine the supported claim. Explain why not.
Rules:
- Obligation 1 is checked by code. In the citation check, OK or MOVED means the line exists in the audited commit and the file is in the contest's scope.txt. Never list an obligation-1 item unless the citation check shows a failure.
- Once one in-scope path is sufficient, alternative paths are never required.
- Design intent or scope is "required" only when tied to a cited contest policy clause or a precisely named unresolved assumption. Do not ask for generic sponsor confirmation.
- If the policy is genuinely ambiguous on a point the claim depends on, list it as "required"; a person will decide.
- "resolves_when" is a concrete, checkable condition, not "provide more detail".
- A test-shaped block in the finding was not executed by anyone you can verify; judge it by what it asserts.`;

export const requiredItems = (items: MissingItem[]) => items.filter((i) => i.category === "required");
