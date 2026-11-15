const BASE = "https://eval.reppo.xyz/api/v1/agents/evals";

export interface ReppoResult {
  id: string;
  status: "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED";
  score: number | null;
  route: "ship" | "review" | "block" | null;
  creditsCharged: number;
  result: { decision: "accept" | "reject"; confidence: string; reason: string; rubric_scores: Record<string, number> } | null;
}

function headers() {
  const key = process.env.REPPO_API_KEY;
  if (!key) throw new Error("missing REPPO_API_KEY");
  return { authorization: `Bearer ${key}`, "content-type": "application/json" };
}

// Reppo publishes every submission. Only send public material (closed-contest findings), never an unsubmitted one.
export async function submitAction(input: string): Promise<string> {
  const res = await fetch(BASE, { method: "POST", headers: headers(), body: JSON.stringify({ taskType: "action", input }) });
  const body = await res.json();
  if (!res.ok) throw new Error(`reppo ${res.status}: ${JSON.stringify(body)}`);
  return body.id;
}

export async function waitFor(id: string, timeoutMs = 600_000): Promise<ReppoResult> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${BASE}/${id}`, { headers: headers(), signal: AbortSignal.timeout(30_000) });
      const body = (await res.json()) as ReppoResult;
      if (body.status === "COMPLETED" || body.status === "FAILED") return body;
    } catch {
      // A dropped poll is retried; the evaluation keeps running on Reppo's side.
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error(`reppo ${id} still pending after ${timeoutMs / 1000}s`);
}
