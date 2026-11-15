import { $, $$, esc, drawStreak, enter, ready } from "./site.ts";
import { runCheck, renderVerdict, loading, type CheckResult } from "./check.ts";

interface Attack {
  key: string;
  contest: string;
  title: string;
  report: string;
}

// Each check asserts every promise written on its card, and names the first one that fails.
const EXPECT: Record<string, (r: CheckResult) => string | null> = {
  fabricated: (r) =>
    r.verdict !== "CITATION_BROKEN" ? `verdict was ${r.verdict}`
    : r.votes.length !== 0 ? "a model was called"
    : r.route !== "automatic" ? "it was not routed automatically"
    : r.usd !== 0 ? `it cost $${r.usd}`
    : null,
  known: (r) => {
    const named = [r.evidence?.known_issue_match ?? "", r.reason, JSON.stringify(r.grounds ?? ""), ...r.missing.map((m) => (typeof m === "string" ? m : m.item))].some((t) => /M-1/.test(t));
    return r.verdict === "READY" ? "it reached READY" : !named ? "M-1 was not named" : null;
  },
  injected: (r) => (r.verdict === "READY" ? "it reached READY" : r.route !== "human" ? "it was routed automatically" : null),
  patched: (r) =>
    r.verdict !== "BLOCKED_BY_CODE" ? `verdict was ${r.verdict}`
    : !r.evidence?.blocking_code.some((b) => b.file === "src/NativeVault.sol") ? "no blocking line in NativeVault.sol"
    : null,
};

async function main() {
  await ready;
  const attacks: Attack[] = await fetch("/data/attacks.json").then((r) => r.json());
  const run = async (card: HTMLElement) => {
    const a = attacks.find((x) => x.key === card.dataset.attack)!;
    const out = $(".out", card);
    const btn = $<HTMLButtonElement>("[data-run]", card);
    btn.disabled = true;
    const stop = loading(out);
    try {
      const r = await runCheck(a.contest, a.title, a.report);
      stop();
      const miss = EXPECT[a.key](r);
      const blocking = r.evidence?.blocking_code.map((b) => `${b.file}:${b.line}`).join(", ");
      out.innerHTML = `${renderVerdict(r, true)}
        ${blocking ? `<p class="fine">blocking code: ${esc(blocking)}</p>` : ""}
        <p class="mono ${miss ? "check-miss" : "check-ok"}" style="margin-top:14px;font-size:13px">${miss ? `✗ not what we promised: ${esc(miss)}` : "✓ every promise on this card held"} · $${r.usd.toFixed(5)} · ${(r.ms / 1000).toFixed(1)}s</p>
        ${r.votes.some((v) => v.request_id) ? `<p class="fine">SERV requests: ${r.votes.map((v) => esc(v.request_id ?? "held")).join(" · ")}</p>` : ""}`;
      drawStreak(out.querySelector("svg")!);
      enter([...out.children].slice(1));
    } catch (err) {
      stop();
      out.innerHTML = `<p class="check-miss">${esc((err as Error).message)}</p>`;
    } finally {
      btn.disabled = false;
    }
  };
  const cards = $$("[data-attack]");
  for (const card of cards) $("[data-run]", card).addEventListener("click", () => run(card));
  const all = $<HTMLButtonElement>("#run-all");
  all.addEventListener("click", async () => {
    all.disabled = true;
    $("#attacks").scrollIntoView({ behavior: "smooth", block: "start" });
    await Promise.all(cards.map((c, i) => new Promise((r) => setTimeout(r, i * 400)).then(() => run(c))));
    all.disabled = false;
  });
}

main();
