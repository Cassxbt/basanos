import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { $, $$, esc, getClaims, streakSVG, VERDICT, ready } from "./site.ts";

interface Arm { score: number; verdict: string; agreement: string | null; reason: string | null; missing: string[]; overruled: boolean; votes: { verdict: string; id: string | null; caps: string[] }[] }
interface Row { id: string; n: number; title: string; family: number; awarded: boolean; final: string | null; len: number; flags: string[]; held: boolean; vetoed: boolean; serv: Arm; dolphin: Arm }

// Same estimator, same seed and same resampling order as src/eval/score.ts, so results match to the digit.
function auroc(scores: number[], labels: boolean[]) {
  const pos = scores.filter((_, i) => labels[i]);
  const neg = scores.filter((_, i) => !labels[i]);
  if (!pos.length || !neg.length) return NaN;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

function clusterBootstrap(scores: number[], labels: boolean[], clusters: number[], iters = 2000, seed = 7): [number, number] {
  const ids = [...new Set(clusters)];
  const members = new Map(ids.map((id) => [id, clusters.flatMap((c, i) => (c === id ? [i] : []))]));
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const stats: number[] = [];
  for (let k = 0; k < iters; k++) {
    const s: number[] = [], l: boolean[] = [];
    for (let n = 0; n < ids.length; n++) for (const i of members.get(ids[Math.floor(rand() * ids.length)])!) { s.push(scores[i]); l.push(labels[i]); }
    const a = auroc(s, l);
    if (!Number.isNaN(a)) stats.push(a);
  }
  stats.sort((a, b) => a - b);
  return [stats[Math.floor(0.025 * stats.length)], stats[Math.floor(0.975 * stats.length)]];
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
type State = "recomputed" | "null" | "reported" | "public";
const STATE: Record<State, [string, string]> = {
  recomputed: ["check-ok", "recomputed here"],
  null: ["c-amber", "null result"],
  reported: ["c-sky", "reported, not verifiable here"],
  public: ["c-gold", "public elsewhere"],
};

interface Claim { what: string; note: string; state: State; published: string; computed?: () => string }

async function main() {
  await ready;
  const claims = await getClaims();
  const data = await fetch("/data/proof.json").then((r) => r.json());
  let rows: Row[] = data.rows;
  let tampered = false;

  const ledgerEntries = (): Claim[] => {
    const labels = rows.map((r) => r.awarded);
    const clusters = rows.map((r) => r.family);
    const aucFmt = (scores: number[]) => {
      const [lo, hi] = clusterBootstrap(scores, labels, clusters);
      return `${r3(auroc(scores, labels)).toFixed(3)} [${r3(lo).toFixed(3)}, ${r3(hi).toFixed(3)}]`;
    };
    const pub = (a: { auroc: number; ci95: number[] }) => `${a.auroc.toFixed(3)} [${a.ci95[0].toFixed(3)}, ${a.ci95[1].toFixed(3)}]`;
    const s = claims.shipped;
    const p = claims.bug_fix_pairs;
    const h3 = claims.hostile_v3_defended_blind;
    const pairs: any[] = data.pairs;
    const injected: any[] = data.hostile3.filter((r: any) => r.injected);
    return [
      {
        what: "Bug fixed → verdict becomes “blocked by code” (SERV decides)",
        note: "9 awarded findings × 2 runs, citation check hidden",
        state: "recomputed",
        published: `${p.blocked_original.serv}/${p.blocked_original.of} → ${p.blocked_patched.serv}/${p.blocked_patched.of}`,
        computed: () => `${p.blocked_original.serv}/${p.blocked_original.of} → ${pairs.filter((x) => x.serv === "BLOCKED_BY_CODE").length}/${pairs.length}`,
      },
      {
        what: "Blocking code named is in the file the fix changed",
        note: "every case where the evidence named blocking code",
        state: "recomputed",
        published: `${p.blocking_names_patched_file.hits}/${p.blocking_names_patched_file.of}`,
        computed: () => { const named = pairs.filter((x) => x.blocking.length); return `${named.filter((x) => x.blocking.some((f: string) => x.fixFiles.includes(f))).length}/${named.length}`; },
      },
      {
        what: "Blind attacks reaching READY and routed automatically",
        note: "60 injected findings, defenses committed before the payloads were read",
        state: "recomputed",
        published: `${h3.ready_routed_automatically.serv}/${h3.injected}`,
        computed: () => `${injected.filter((r) => r.servVerdict === "READY" && r.servAgreement === "unanimous" && !r.flagged).length}/${injected.length}`,
      },
      {
        what: "Genuine findings held or flagged by the defenses",
        note: "shipped pipeline, all 94 clean findings",
        state: "recomputed",
        published: `${s.front_door_held + s.flagged}/${claims.dataset.reports}`,
        computed: () => `${rows.filter((r) => r.held || r.flags.length).length}/${rows.length}`,
      },
      {
        what: "Automatic rejects the contest judge also rejected (SERV decides)",
        note: "unanimous zero-score verdicts with no flags, plus code vetoes",
        state: "recomputed",
        published: `${s.serv.automatic_rejects_not_awarded}/${s.serv.automatic_rejects}`,
        computed: () => {
          const auto = rows.filter((r) => (r.vetoed || (r.serv.agreement === "unanimous" && !r.flags.length && !r.serv.overruled)) && r.serv.score === 0);
          return `${auto.filter((r) => !r.awarded).length}/${auto.length}`;
        },
      },
      {
        what: "Predicting the contest outcome, SERV decides (AUROC, 95% CI)",
        note: "consensus score vs “awarded”, clustered by duplicate family",
        state: "null",
        published: pub(s.serv),
        computed: () => aucFmt(rows.map((r) => r.serv.score)),
      },
      {
        what: "…Dolphin decides",
        note: "same evidence, different decider",
        state: "null",
        published: pub(s.dolphin),
        computed: () => aucFmt(rows.map((r) => r.dolphin.score)),
      },
      {
        what: "…report length alone",
        note: "the baseline both have to beat",
        state: "recomputed",
        published: pub(claims.baseline_body_length),
        computed: () => aucFmt(rows.map((r) => r.len)),
      },
      {
        what: "SERV request ids on every decision",
        note: "visible only in the OpenServ console of the issuing workspace",
        state: "reported",
        published: `${rows.reduce((t, r) => t + r.serv.votes.filter((v) => v.id).length, 0)} ids`,
      },
      {
        what: "Reppo audit: sampled verdicts accepted",
        note: `Reppo evaluation ids ${claims.reppo_audit.ids.slice(0, 2).join(", ")}…`,
        state: "public",
        published: `${claims.reppo_audit.accepted}/${claims.reppo_audit.completed}`,
      },
    ];
  };

  const ledger = $("#ledger");
  const renderLedger = () => {
    const entries = ledgerEntries();
    let mismatches = 0;
    ledger.innerHTML = entries.map((c) => {
      const computed = c.computed?.();
      const bad = computed !== undefined && computed !== c.published;
      if (bad) mismatches++;
      const [cls, label] = bad ? ["check-miss", "does not match"] : STATE[c.state];
      return `<div class="claim${bad ? " mismatch" : ""}">
        <div class="what">${esc(c.what)}<small>${esc(c.note)}</small></div>
        <div class="val">${esc(computed ?? c.published)}${bad ? `<small class="muted" style="display:block;font-size:12px">published ${esc(c.published)}</small>` : ""}</div>
        <span class="chip state ${cls}">${label}</span>
      </div>`;
    }).join("");
    $("#ledger-state").textContent = mismatches ? `${mismatches} claims no longer match the data` : "every recomputed claim matches";
    $("#ledger-state").className = mismatches ? "check-miss" : "check-ok";
    gsap.from($$(".claim", ledger), { opacity: 0, y: 10, duration: 0.6, ease: "expo.out", stagger: 0.04 });
  };
  renderLedger();

  $("#recompute").addEventListener("click", renderLedger);
  $("#tamper").addEventListener("click", () => {
    tampered = !tampered;
    rows = tampered ? data.rows.map((r: Row, i: number) => (i % 9 === 0 ? { ...r, awarded: !r.awarded } : r)) : data.rows;
    $("#tamper").textContent = tampered ? "Restore the data" : "Tamper with the data";
    renderLedger();
  });

  // Specimen tray
  let decider: "serv" | "dolphin" = "serv";
  let filter = "all";
  const tray = $("#specimens");
  const renderTray = () => {
    tray.innerHTML = data.rows.map((r: Row) => {
      const v = VERDICT[r[decider].verdict] ?? VERDICT.NEEDS_PROOF;
      return `<button class="specimen" data-id="${r.id}" title="#${r.n} · ${esc(r.title)}">
        <span class="n">#${r.n}</span><span class="award${r.awarded ? " on" : ""}"></span>
        ${streakSVG(v.color, 34)}
      </button>`;
    }).join("");
    applyFilter();
    $$(".specimen", tray).forEach((el, i) => { el.style.setProperty("--i", String(i)); el.classList.add("enter"); });
  };
  const applyFilter = () => {
    for (const el of $$(".specimen", tray)) {
      const r = data.rows.find((x: Row) => x.id === el.dataset.id)!;
      const a = r[decider];
      const show =
        filter === "all" ||
        (filter === "awarded" && r.awarded) ||
        (filter === "not" && !r.awarded) ||
        (filter === "unanimous" && a.agreement === "unanimous") ||
        (filter === "miss" && r.awarded && a.score === 0 && (r.vetoed || (a.agreement === "unanimous" && !r.flags.length && !a.overruled))) ||
        a.verdict === filter;
      el.classList.toggle("dim", !show);
    }
  };
  for (const b of $$("[data-filter]")) b.addEventListener("click", () => {
    filter = b.dataset.filter!;
    $$("[data-filter]").forEach((x) => x.classList.toggle("is-active", x === b));
    applyFilter();
  });
  for (const b of $$("[data-decider]")) b.addEventListener("click", () => {
    decider = b.dataset.decider as "serv" | "dolphin";
    $$("[data-decider]").forEach((x) => x.classList.toggle("is-active", x === b));
    renderTray();
  });
  ScrollTrigger.create({ trigger: tray, start: "top 85%", once: true, onEnter: renderTray });

  const drawer = $("#drawer"), scrim = $("#scrim");
  let opener: HTMLElement | null = null;
  const close = () => {
    if (!drawer.classList.contains("open")) return;
    drawer.classList.remove("open"); scrim.classList.remove("open"); drawer.setAttribute("aria-hidden", "true");
    opener?.focus();
  };
  $("#drawer-close").addEventListener("click", close);
  scrim.addEventListener("click", close);
  addEventListener("keydown", (e) => {
    if (!drawer.classList.contains("open")) return;
    if (e.key === "Escape") return close();
    if (e.key !== "Tab") return;
    const focusable = $$<HTMLElement>("button, a[href]", drawer);
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  tray.addEventListener("click", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".specimen");
    if (!el) return;
    const r: Row = data.rows.find((x: Row) => x.id === el.dataset.id);
    const arm = (name: string, a: Arm) => {
      const v = VERDICT[a.verdict] ?? VERDICT.NEEDS_PROOF;
      return `<div class="block-title">${name}</div>${streakSVG(v.color, 48)}
        <p style="font:500 28px/1 var(--display);color:${v.color};margin:4px 0 12px">${esc(v.label)}</p>
        ${a.reason ? `<p class="reason" style="font-size:15px;margin:0 0 12px">${esc(a.reason)}</p>` : ""}
        ${a.missing.length ? `<ol class="missing">${a.missing.map((m) => `<li>${esc(m)}</li>`).join("")}</ol>` : ""}
        ${a.votes.map((x, i) => `<div class="leader"><span>pass ${i + 1}: ${esc((VERDICT[x.verdict] ?? { label: x.verdict }).label)}</span><span class="dots"></span><span class="mono" style="user-select:all">${esc(x.id ?? "—")}</span></div>`).join("")}
        <div class="leader"><span>agreement</span><span class="dots"></span><span>${esc(a.agreement ?? "code veto")}${a.overruled ? " · code overruled a READY" : ""}</span></div>`;
    };
    opener = el;
    $("#drawer-body").innerHTML = `<span class="eyebrow">Karak #${r.n} · family ${r.family}</span>
      <h3 class="display h3" id="drawer-title" style="margin:18px 0 14px">${esc(r.title)}</h3>
      <div class="verdict-meta"><span class="chip ${r.awarded ? "c-gold" : "c-ash"}">${r.awarded ? "awarded by the judge" : "not awarded"}</span>${r.final ? `<span class="chip c-ash">final severity: ${esc(r.final)}</span>` : ""}</div>
      ${arm("SERV decides (shipped)", r.serv)}${arm("Dolphin decides", r.dolphin)}
      <p class="fine" style="margin-top:22px"><a class="gold" href="https://github.com/code-423n4/2024-07-karak-findings/issues/${r.n}">Open the original finding on GitHub →</a></p>`;
    drawer.classList.add("open"); scrim.classList.add("open"); drawer.setAttribute("aria-hidden", "false");
    $("#drawer-close").focus({ preventScroll: true });
    gsap.from($$("#drawer-body > *"), { opacity: 0, x: 20, duration: 0.6, ease: "expo.out", stagger: 0.04, delay: 0.1 });
  });

  // Pairs
  const pc = claims.bug_fix_pairs;
  const bar = (label: string, n: number, of: number, ash = false) =>
    `<div class="bar"><span>${label}</span><div class="track"><div class="fill${ash ? " ash" : ""}" style="--v:0" data-v="${n / of}"></div></div><b>${n}/${of}</b></div>`;
  $("#pair-bars").innerHTML = [
    bar("Original code · SERV decides", pc.blocked_original.serv, pc.blocked_original.of, true),
    bar("Patched code · SERV decides", pc.blocked_patched.serv, pc.blocked_patched.of),
    bar("Original code · Dolphin decides", pc.blocked_original.dolphin, pc.blocked_original.of, true),
    bar("Patched code · Dolphin decides", pc.blocked_patched.dolphin, pc.blocked_patched.of),
  ].join("");
  $("#pair-table").innerHTML = `<tr><th>Finding</th><th>The fix</th><th>Patched: SERV, Dolphin (2 runs)</th></tr>` +
    data.fixes.map((f: any) => {
      const runs = data.pairs.filter((x: any) => x.number === f.number);
      return `<tr><td>#${f.number}</td><td>${esc(f.summary)}</td><td>${runs.map((x: any) => `${esc((VERDICT[x.serv] ?? { label: x.serv }).label)}, ${esc((VERDICT[x.dolphin] ?? { label: x.dolphin }).label)}`).join("<br>")}</td></tr>`;
    }).join("");

  const h2 = claims.hostile_v2_undefended, h3 = claims.hostile_v3_defended_blind;
  $("#v2-bars").innerHTML = [
    bar("Reached READY · SERV", h2.ready.serv, h2.injected, true),
    bar("Reached READY · Dolphin", h2.ready.dolphin, h2.injected, true),
    bar("…and routed automatically · SERV", h2.ready_routed_automatically.serv, h2.injected, true),
  ].join("");
  $("#v3-bars").innerHTML = [
    bar("Reached READY · SERV", h3.ready.serv, h3.injected),
    bar("Reached READY · Dolphin", h3.ready.dolphin, h3.injected),
    bar("…and routed automatically · SERV", h3.ready_routed_automatically.serv, h3.injected),
    bar("Flagged by the instruction scan", h3.flagged, h3.injected),
  ].join("");
  const ab = claims.ablation;
  if (ab) {
    const label: Record<string, string> = { full: "Everything on", no_front_door: "No SERV front door", no_scan: "No instruction scan", no_proof_cap: "No proof cap" };
    $("#ablation-table").innerHTML = `<tr><th>Arm</th><th>Injected → READY + automatic (SERV / Dolphin)</th><th>Clean findings held or flagged</th><th>Cost</th></tr>` +
      Object.entries(ab.arms).map(([k, a]: [string, any]) =>
        `<tr><td>${label[k]}</td><td>${a.unsafe.serv}/${a.injected} · ${a.unsafe.dolphin}/${a.injected}</td><td>${a.clean_held + a.clean_flagged}/${a.clean}</td><td>$${a.usd.toFixed(3)}</td></tr>`).join("");
    const saves = Object.entries(ab.unique_saves).map(([k, v]: [string, any]) => `${k.replaceAll("_", " ")}: ${v.serv.length} (SERV deciding), ${v.dolphin.length} (Dolphin deciding)`);
    $("#ablation-note").textContent = `Unique saves — ${saves.join(" · ")}.`;
  } else $("#ablation").hidden = true;

  const rl = claims.repair_loop;
  if (rl) {
    const vl = (v: string | null) => (v ? (VERDICT[v] ?? { label: v }).label : "—");
    $("#repair-table").innerHTML = `<tr><th>Finding</th><th>Judge</th><th>Before</th><th>Executed test</th><th>After</th></tr>` +
      rl.map((r: any) => `<tr><td>#${r.number}</td><td>${r.awarded ? "awarded" : "not awarded"}</td><td>${esc(vl(r.before))}</td><td>${r.poc_passed === null ? "not attempted" : r.poc_passed ? "passed" : "no passing test"}${r.summary ? `<br><span class="muted">${esc(r.summary)}</span>` : ""}</td><td>${esc(vl(r.after))}${r.after_route ? ` · ${esc(r.after_route)}` : ""}</td></tr>`).join("");
  } else $("#repair").hidden = true;

  for (const f of $$(".fill")) {
    ScrollTrigger.create({ trigger: f, start: "top 92%", once: true, onEnter: () => f.style.setProperty("--v", f.dataset.v!) });
  }
  ScrollTrigger.refresh();
}

main();
