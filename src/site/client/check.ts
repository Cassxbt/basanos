import { $, $$, esc, enter, drawStreak, streakSVG, checklist, VERDICT, ready, type Item } from "./site.ts";

export interface CheckResult {
  verdict: string;
  agreement: string | null;
  route: "automatic" | "human";
  severity_supported: string | null;
  missing: (string | Item)[];
  reason: string;
  caps: string[];
  flags: string[];
  citations: { status: string; path: string; lines: [number, number]; audited_lines: [number, number] | null }[];
  votes: { verdict: string; severity: string | null; request_id: string | null }[];
  evidence: { model: string; tokens_read: number; code_supports_claim: string; poc: string; known_issue_match: string; blocking_code: { file: string; line: number; why: string }[] } | null;
  certificate: Record<string, unknown>;
  seal: string;
  usd: number;
  ms: number;
  error?: string;
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
export const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

export async function runCheck(contest: string, title: string, report: string): Promise<CheckResult> {
  const res = await fetch("/api/precheck", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contest, title, report }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

const STATUS_CHIP: Record<string, string> = {
  OK: "c-ok", MOVED: "c-ok", CHANGED: "c-bad", BAD_LINES: "c-bad", NO_FILE: "c-bad", NO_COMMIT: "c-bad", UNRELATED: "c-bad", OUT_OF_SCOPE: "c-ash",
};

export function renderVerdict(r: CheckResult, compact = false): string {
  const v = VERDICT[r.verdict] ?? { label: r.verdict, color: "#8e8c86", chip: "c-ash" };
  const meta = [
    r.agreement && `<span class="chip ${v.chip}">${esc(r.agreement)}</span>`,
    `<span class="chip ${r.route === "automatic" ? "c-ok" : "c-sky"}">${r.route === "automatic" ? "routes automatically" : "goes to a human"}</span>`,
    r.severity_supported && `<span class="chip c-ash">evidence supports: ${esc(r.severity_supported.replaceAll("_", " "))}</span>`,
  ].filter(Boolean).join("");
  const votes = r.votes.length
    ? `<div class="block-title">Three passes</div><div class="votes">${r.votes.map((x, i) => {
        const vv = VERDICT[x.verdict] ?? VERDICT.NEEDS_PROOF;
        return `<div class="vote"><span class="mono muted" style="font-size:11px">pass ${i + 1}</span><span class="chip ${vv.chip}" style="justify-self:start">${esc(vv.label)}</span><span class="id">${x.request_id ? `SERV ${esc(x.request_id)}` : "no SERV request"}</span></div>`;
      }).join("")}</div>`
    : "";
  if (compact) {
    return `${streakSVG(v.color, 64)}<p class="verdict-word" style="color:${v.color}">${esc(v.label)}</p><div class="verdict-meta">${meta}</div><p class="reason">${esc(r.reason)}</p>`;
  }
  const missing = r.missing.length
    ? `<div class="block-title">What a judge would still need</div>${checklist(r.missing)}`
    : "";
  const notes = [...r.caps, ...(r.flags.length ? [`text addressed to the reviewer: ${r.flags.join(", ")}`] : [])];
  const cites = r.citations.length
    ? `<div class="block-title">Citations, resolved against the audited commit</div><table class="data">${r.citations.map((c) =>
        `<tr><td><span class="chip ${STATUS_CHIP[c.status] ?? "c-ash"}">${esc(c.status.replaceAll("_", " ").toLowerCase())}</span></td><td>${esc(c.path)}#L${c.lines[0]}${c.lines[1] !== c.lines[0] ? `-L${c.lines[1]}` : ""}</td><td class="muted">${c.audited_lines ? `audited L${c.audited_lines[0]}` : ""}</td></tr>`).join("")}</table>`
    : "";
  const e = r.evidence;
  const evidence = e
    ? `<div class="block-title">Evidence record · ${esc(e.model)} read ${e.tokens_read.toLocaleString()} tokens</div>
       <div class="leader"><span>code supports the claim</span><span class="dots"></span><span>${esc(e.code_supports_claim)}</span></div>
       <div class="leader"><span>proof in the finding</span><span class="dots"></span><span>${esc(e.poc.replaceAll("_", " "))}</span></div>
       <div class="leader"><span>known issue</span><span class="dots"></span><span>${esc(e.known_issue_match || "none found")}</span></div>
       ${e.blocking_code.map((b) => `<div class="leader"><span>blocked at</span><span class="dots"></span><span>${esc(b.file)}:${esc(b.line)}</span></div>`).join("")}`
    : "";
  return `${streakSVG(v.color)}
    <p class="verdict-word" style="color:${v.color}">${esc(v.label)}</p>
    <div class="verdict-meta">${meta}</div>
    <p class="reason">${esc(r.reason)}</p>
    ${notes.length ? `<p class="fine" style="margin-top:10px;color:var(--amber)">${notes.map(esc).join("<br>")}</p>` : ""}
    ${missing}${votes}${cites}${evidence}
    ${certificate(r)}`;
}

function certificate(r: CheckResult): string {
  const c = r.certificate as Record<string, any>;
  const row = (k: string, v: unknown) => `<div class="leader"><span>${k}</span><span class="dots"></span><span>${esc(v)}</span></div>`;
  return `<div class="cert" data-cert>
    <div class="cert-head"><b>Assay Receipt</b><span class="seal" data-seal-state><i></i>verifying</span></div>
    ${row("contest", c.contest)}
    ${row("audited commit", String(c.audited_commit).slice(0, 12))}
    ${row("finding sha-256", String(c.finding_sha256).slice(0, 24) + "…")}
    ${row("verdict", c.verdict)}
    ${row("decider", c.decider ?? "code only")}
    ${row("cost", `$${Number(c.usd).toFixed(5)} · ${(r.ms / 1000).toFixed(1)}s`)}
    ${row("sha-256 checksum", r.seal.slice(0, 24) + "…")}
    <p class="fine" style="margin-top:10px">A checksum detects edits to this receipt. It does not prove who issued it or that the verdict is right.</p>
    <div class="cert-actions">
      <button class="btn sm ghost" type="button" data-tamper>Tamper with it</button>
      <button class="btn sm ghost" type="button" data-download>Download JSON</button>
    </div>
  </div>`;
}

// The browser rebuilds the certificate bytes and the finding digest; any edit breaks the seal.
export async function verifyCertificate(root: HTMLElement, r: CheckResult, title: string, body: string) {
  const el = $("[data-cert]", root);
  const state = $("[data-seal-state]", el);
  const cert = { ...(r.certificate as Record<string, unknown>) };
  const check = async () => {
    const sealOk = (await sha256(JSON.stringify(cert))) === r.seal;
    const findingOk = (await sha256(`${title}\n\n${body}`)) === cert.finding_sha256;
    const ok = sealOk && findingOk;
    el.classList.toggle("tampered", !ok);
    state.className = `seal ${ok ? "check-ok" : "check-miss"}`;
    state.innerHTML = `<i></i>${ok ? "checksum matches in your browser" : sealOk ? "finding text changed" : "checksum broken"}`;
  };
  await check();
  const original = cert.verdict;
  const tamper = $<HTMLButtonElement>("[data-tamper]", el);
  tamper.addEventListener("click", async () => {
    const restoring = cert.verdict !== original;
    cert.verdict = restoring ? original : original === "READY" ? "BLOCKED_BY_CODE" : "READY";
    tamper.textContent = restoring ? "Tamper with it" : "Restore it";
    await check();
  });
  $("[data-download]", el).addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({ certificate: r.certificate, seal: r.seal }, null, 2)], { type: "application/json" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `basanos-${String(cert.finding_sha256).slice(0, 10)}.json` });
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

export function loading(el: HTMLElement) {
  el.innerHTML = `<div class="reading">
    <span data-phase>resolving citations against the audited commit…</span>
    <div class="loading-line" style="width:92%"></div><div class="loading-line" style="width:76%"></div><div class="loading-line" style="width:84%"></div>
  </div>`;
  const phases = [
    "SERV Prompt Guard is screening the finding…",
    "Dolphin is reading 20 source files, three times…",
    "SERV is making three bounded decisions…",
    "code is capping the verdicts and sealing the certificate…",
  ];
  let i = 0;
  const t = setInterval(() => {
    const p = el.querySelector("[data-phase]");
    if (!p || i >= phases.length) return clearInterval(t);
    p.textContent = phases[i++];
  }, 2600);
  return () => clearInterval(t);
}

async function main() {
  await ready;
  const form = document.getElementById("check-form") as HTMLFormElement | null;
  if (!form) return;
  const out = $("#result");
  const title = $<HTMLInputElement>("#title");
  const report = $<HTMLTextAreaElement>("#report");
  const run = $<HTMLButtonElement>("#run");
  const samples = await fetch("/data/examples.json").then((r) => r.json());
  const box = $("#samples");
  for (const s of samples) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sample";
    b.textContent = s.label;
    b.title = s.note;
    b.addEventListener("click", () => {
      title.value = s.title;
      report.value = s.report;
      $$(".sample", box).forEach((x) => x.classList.toggle("is-active", x === b));
    });
    box.append(b);
  }
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!report.value.trim()) return report.focus();
    run.disabled = true;
    const stop = loading(out);
    try {
      const t = title.value, b = report.value;
      const r = await runCheck("karak", t, b);
      stop();
      out.innerHTML = renderVerdict(r);
      drawStreak(out.querySelector("svg")!);
      enter([...out.children].slice(1));
      await verifyCertificate(out, r, t, b);
    } catch (err) {
      stop();
      out.innerHTML = `<p class="verdict-word" style="color:var(--copper);font-size:36px">The check failed.</p><p class="reason">${esc((err as Error).message)}</p>`;
    } finally {
      run.disabled = false;
    }
  });
}

main();
