import { $, $$, esc, drawStreak, enter, ready } from "./site.ts";
import { runCheck, renderVerdict, loading, type CheckResult } from "./check.ts";

interface Attack {
  key: string;
  contest: string;
  title: string;
  report: string;
}

const EXPECT: Record<string, (r: CheckResult) => boolean> = {
  fabricated: (r) => r.verdict === "CITATION_BROKEN" && r.votes.length === 0,
  known: (r) => r.verdict === "KNOWN_OR_OUT_OF_SCOPE",
  injected: (r) => r.verdict !== "READY" && r.route === "human",
  patched: (r) => r.verdict === "BLOCKED_BY_CODE",
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
      const ok = EXPECT[a.key](r);
      out.innerHTML = `${renderVerdict(r, true)}
        <p class="mono ${ok ? "check-ok" : "check-miss"}" style="margin-top:14px;font-size:13px">${ok ? "✓ as expected" : "✗ not what we expected: this is a real miss"} · $${r.usd.toFixed(5)} · ${(r.ms / 1000).toFixed(1)}s</p>
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
  $("#run-all").addEventListener("click", () => {
    $("#attacks").scrollIntoView({ behavior: "smooth", block: "start" });
    cards.forEach((c, i) => setTimeout(() => run(c), i * 400));
  });
}

main();
