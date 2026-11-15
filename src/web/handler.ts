import type { IncomingMessage, ServerResponse } from "node:http";
import { loadContest } from "../contests.ts";
import { precheck } from "../precheck.ts";
import { toJson } from "../format.ts";

const MAX_REPORT = 60_000;
const WINDOW_MS = 10 * 60_000;
const PER_WINDOW = 20;
const hits = new Map<string, number[]>();

function limited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > PER_WINDOW;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage & { body?: unknown }): Promise<any> {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export default async function handler(req: IncomingMessage & { body?: unknown }, res: ServerResponse) {
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  const ip = String(req.headers["x-forwarded-for"] ?? "").split(",")[0] || "unknown";
  if (limited(ip)) return send(res, 429, { error: "Too many checks from this address. Try again in a few minutes." });

  let input: { contest?: string; title?: string; report?: string };
  try {
    input = await readBody(req);
  } catch {
    return send(res, 400, { error: "Body must be JSON." });
  }
  const report = String(input.report ?? "");
  if (!report.trim()) return send(res, 400, { error: "Paste a finding first." });
  if (report.length > MAX_REPORT) return send(res, 413, { error: `Findings are capped at ${MAX_REPORT.toLocaleString()} characters.` });

  try {
    const { contest, policy } = loadContest(String(input.contest ?? "karak"));
    const started = Date.now();
    const result = await precheck({ title: String(input.title ?? ""), body: report }, contest, policy);
    return send(res, 200, { ...toJson(result), ms: Date.now() - started });
  } catch (err) {
    console.error(err);
    return send(res, 502, { error: "The check failed upstream. Nothing was stored; try again." });
  }
}
