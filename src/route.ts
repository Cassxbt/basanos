// The API, CLI, evaluation, site export and the browser recompute all call this one function.
// Only a unanimous verdict on text that addresses no one but the reader is routed without a human.
// A decider that claimed READY and was overruled by code is exactly the case a person should see.
export interface Routable {
  verdict: string;
  agreement: string | null;
  flags: string[];
  votes: { caps: string[] }[];
}

const overruled = (p: Routable) => p.votes.some((v) => v.caps.some((c) => c.startsWith("READY capped") || c.startsWith("layers disagree")));

export const route = (p: Routable): "automatic" | "human" =>
  p.verdict === "CITATION_BROKEN" || (p.agreement === "unanimous" && p.flags.length === 0 && !overruled(p)) ? "automatic" : "human";
