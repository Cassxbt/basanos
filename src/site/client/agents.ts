import { ScrollTrigger } from "gsap/ScrollTrigger";
import { $, $$, ready } from "./site.ts";

const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

function tabs() {
  const ink = $("#tab-ink");
  const tabs = $$<HTMLButtonElement>("[data-tab]");
  const place = (t: HTMLElement) => {
    ink.style.width = `${t.offsetWidth}px`;
    ink.style.transform = `translateX(${t.offsetLeft}px)`;
  };
  for (const t of tabs) {
    t.addEventListener("click", () => {
      tabs.forEach((x) => x.setAttribute("aria-selected", String(x === t)));
      $$("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== t.dataset.tab));
      place(t);
    });
  }
  place(tabs[0]);
  addEventListener("resize", () => place(tabs.find((t) => t.getAttribute("aria-selected") === "true")!));
}

// Replays a recorded run: the command types out, then the real output streams in line by line.
async function terminal() {
  const pre = $("#term");
  const output = await fetch("/data/cli-93.txt").then((r) => r.text());
  const command = "$ npx tsx src/cli.ts finding-93.md --contest karak";
  const play = async () => {
    if (reduce) { pre.textContent = `${command}\n\n${output}`; return; }
    pre.innerHTML = "";
    const text = document.createTextNode("");
    const cursor = Object.assign(document.createElement("span"), { className: "cursor" });
    pre.append(text, cursor);
    for (const ch of command) {
      text.data += ch;
      await new Promise((r) => setTimeout(r, 28 + Math.random() * 40));
    }
    text.data += "\n\n";
    await new Promise((r) => setTimeout(r, 900));
    for (const line of output.split("\n")) {
      text.data += `${line}\n`;
      await new Promise((r) => setTimeout(r, line.trim() ? 90 : 40));
    }
  };
  ScrollTrigger.create({ trigger: pre, start: "top 80%", once: true, onEnter: play });
}

ready.then(() => {
  tabs();
  terminal();
});
