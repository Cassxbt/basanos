import type { IncomingMessage, ServerResponse } from "node:http";
import { CONTESTS, loadContest } from "../contests.ts";
import { precheck } from "../precheck.ts";
import { toReport } from "../format.ts";
import { configureClients } from "../llm.ts";

const MAX_REPORT = 60_000;
const MAX_TITLE = 300;
const WINDOW_MS = 10 * 60_000;
const PER_ADDRESS = 12;
// One instance never spends more than this per window, whoever is asking.
const INSTANCE_BUDGET_USD = 0.5;

configureClients({ timeout: 40_000, maxRetries: 1 });

const hits = new Map<string, number[]>();
let spent: { at: number; usd: number }[] = [];

function addressOf(req: IncomingMessage): string {
  const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  return forwarded || String(req.headers["x-real-ip"] ?? "") || req.socket.remoteAddress || "unknown";
}

function overLimit(address: string, now: number): boolean {
  const recent = (hits.get(address) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(address, recent);
  return recent.length > PER_ADDRESS;
}

function overBudget(now: number): boolean {
  spent = spent.filter((s) => now - s.at < WINDOW_MS);
  return spent.reduce((sum, s) => sum + s.usd, 0) >= INSTANCE_BUDGET_USD;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage & { body?: unknown }): Promise<unknown> {
  if (req.body !== undefined) return req.body;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
}

export default async function handler(req: IncomingMessage & { body?: unknown }, res: ServerResponse) {
  if (req.method !== "POST") return send(res, 405, { error: "POST only." });
  const now = Date.now();
  if (overLimit(addressOf(req), now)) return send(res, 429, { error: "Too many checks from this address. Try again in a few minutes." });
  if (overBudget(now)) return send(res, 503, { error: "The public demo has reached its spending limit for now. Try again shortly, or run it locally." });

  let input: unknown;
  try {
    input = await readBody(req);
  } catch {
    return send(res, 400, { error: "Body must be JSON." });
  }
  if (!input || typeof input !== "object") return send(res, 400, { error: "Body must be a JSON object." });
  const { contest = "karak", title = "", report = "" } = input as Record<string, unknown>;
  if (typeof report !== "string" || !report.trim()) return send(res, 400, { error: "Paste a finding first." });
  if (report.length > MAX_REPORT) return send(res, 413, { error: `Findings are capped at ${MAX_REPORT.toLocaleString()} characters.` });
  if (typeof title !== "string" || title.length > MAX_TITLE) return send(res, 400, { error: `Titles are capped at ${MAX_TITLE} characters.` });
  if (typeof contest !== "string" || !CONTESTS.some((c) => c.id === contest)) {
    return send(res, 400, { error: `Unknown contest. Known: ${CONTESTS.map((c) => c.id).join(", ")}.` });
  }

  try {
    const { contest: c, policy } = loadContest(contest);
    const result = await precheck({ title, body: report }, c, policy);
    spent.push({ at: now, usd: result.usd });
    return send(res, 200, { ...toReport(result, contest, c.auditedCommit, title, report), ms: Date.now() - now });
  } catch (err) {
    console.error(err);
    return send(res, 502, { error: "The check failed upstream. Nothing was stored; try again." });
  }
}
