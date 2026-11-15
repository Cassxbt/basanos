import Lenis from "lenis";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const fine = matchMedia("(hover: hover) and (pointer: fine)").matches;
const EXPO = "expo.out";

export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)!;
export const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll<T>(sel)];

let claims: Record<string, any> | null = null;
export async function getClaims(): Promise<Record<string, any>> {
  if (!claims) claims = await fetch("/data/claims.json").then((r) => r.json());
  return claims!;
}

export const pick = (obj: any, path: string) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);

function format(v: unknown, fmt: string | undefined): string {
  if (v == null) return "—";
  if (fmt === "usd3") return Number(v).toFixed(3);
  if (fmt === "usd4") return Number(v).toFixed(4);
  if (fmt === "auc") return Number(v).toFixed(3);
  if (fmt === "pct") return `${(Number(v) * 100).toFixed(1)}%`;
  if (fmt === "per1000") return (Number(v) * 1000).toFixed(2);
  return String(v);
}

async function bindClaims() {
  const c = await getClaims();
  for (const el of $$("[data-claim]")) {
    const v = pick(c, el.dataset.claim!);
    el.textContent = format(v, el.dataset.format);
    if (v == null) el.closest("[data-hide-if-missing]")?.setAttribute("hidden", "");
  }
}

function header() {
  const h = $(".site-header");
  const set = () => h.classList.toggle("is-scrolled", scrollY > 24);
  set();
  addEventListener("scroll", set, { passive: true });
  const toggle = $(".menu-toggle");
  const nav = $("#nav");
  toggle?.addEventListener("click", () => {
    const open = nav.classList.toggle("is-open");
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = open ? "Close" : "Menu";
  });
}

function smoothScroll() {
  if (reduce) return;
  const lenis = new Lenis({ duration: 1.15, easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)), smoothWheel: true });
  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add((time) => lenis.raf(time * 1000));
  gsap.ticker.lagSmoothing(0);
  for (const a of $$<HTMLAnchorElement>('a[href^="#"], a[href^="/#"]')) {
    a.addEventListener("click", (e) => {
      const id = a.getAttribute("href")!.split("#")[1];
      const target = id && document.getElementById(id);
      if (!target || (a.pathname !== location.pathname && a.getAttribute("href")!.startsWith("/"))) return;
      e.preventDefault();
      lenis.scrollTo(target, { offset: -80 });
    });
  }
}

// Wraps each rendered line of a heading in a mask so it can rise into view.
function splitLines(el: HTMLElement) {
  const words = el.innerHTML.trim().split(/\s+(?![^<]*>)/);
  el.innerHTML = words.map((w) => `<span class="w" style="display:inline-block">${w}</span>`).join(" ");
  const lines: HTMLElement[][] = [];
  let top = -1;
  for (const w of $$<HTMLElement>(".w", el)) {
    if (Math.abs(w.offsetTop - top) > 4) { lines.push([]); top = w.offsetTop; }
    lines[lines.length - 1].push(w);
  }
  el.innerHTML = lines.map((ws) => `<span class="split-line"><span>${ws.map((w) => w.innerHTML).join(" ")}</span></span>`).join("");
  return $$<HTMLElement>(".split-line > span", el);
}

function reveals() {
  for (const el of $$("[data-split]")) {
    if (reduce) continue;
    const inner = splitLines(el);
    gsap.from(inner, {
      yPercent: 108,
      rotate: 1.5,
      duration: 1.25,
      ease: EXPO,
      stagger: 0.09,
      scrollTrigger: { trigger: el, start: "top 88%" },
    });
  }
  for (const el of $$("[data-reveal]")) {
    if (reduce) continue;
    gsap.from(el, {
      y: 28,
      opacity: 0,
      filter: "blur(6px)",
      duration: 1.1,
      ease: EXPO,
      scrollTrigger: { trigger: el, start: "top 90%" },
    });
  }
  for (const group of $$("[data-stagger]")) {
    if (reduce) continue;
    gsap.from(group.children, {
      y: 22,
      opacity: 0,
      duration: 1,
      ease: EXPO,
      stagger: 0.08,
      delay: 0.5,
      scrollTrigger: { trigger: group, start: "top 92%" },
    });
  }
}

// Each word of a statement lights up as it crosses the reading line.
function scrubWords() {
  for (const el of $$("[data-scrub]")) {
    const accents = new Set($$(".accent", el).map((a) => a.textContent!.trim()));
    const text = el.textContent!.trim().split(/\s+/);
    el.innerHTML = text.map((w) => `<span class="scrub-word${accents.has(w) ? " accent" : ""}">${w}</span>`).join(" ");
    const words = $$(".scrub-word", el);
    if (reduce) { words.forEach((w) => w.classList.add("lit")); continue; }
    ScrollTrigger.create({
      trigger: el,
      start: "top 78%",
      end: "bottom 45%",
      scrub: true,
      onUpdate: (st) => {
        const n = Math.round(st.progress * words.length);
        words.forEach((w, i) => w.classList.toggle("lit", i < n));
      },
    });
  }
}

function pass() {
  const root = $("[data-pass]");
  if (!root) return;
  const num = $("[data-pass-num]", root);
  const bar = $("[data-pass-bar]", root);
  const steps = $$("[data-step]", root);
  let current = "01";
  const show = (n: string) => {
    if (n === current) return;
    const up = Number(n) > Number(current);
    current = n;
    if (reduce) { num.textContent = n; return; }
    gsap.to(num, {
      yPercent: up ? -100 : 100,
      opacity: 0,
      duration: 0.3,
      ease: "power2.in",
      onComplete: () => {
        num.textContent = n;
        gsap.fromTo(num, { yPercent: up ? 100 : -100, opacity: 0 }, { yPercent: 0, opacity: 1, duration: 0.7, ease: EXPO });
      },
    });
  };
  for (const s of steps) {
    ScrollTrigger.create({ trigger: s, start: "top 55%", end: "bottom 55%", onToggle: (st) => st.isActive && show(s.dataset.step!) });
  }
  ScrollTrigger.create({
    trigger: $(".pass-steps", root),
    start: "top 55%",
    end: "bottom 60%",
    scrub: true,
    onUpdate: (st) => { bar.style.height = `${st.progress * 100}%`; },
  });
}

function counters() {
  for (const el of $$("[data-count]")) {
    if (reduce) continue;
    ScrollTrigger.create({
      trigger: el,
      start: "top 92%",
      once: true,
      onEnter: () => {
        const target = Number(el.textContent);
        if (!Number.isFinite(target)) return;
        const o = { v: 0 };
        gsap.to(o, { v: target, duration: 1.6, ease: "power3.out", onUpdate: () => { el.textContent = String(Math.round(o.v)); } });
      },
    });
  }
}

function magnetic() {
  if (!fine || reduce) return;
  for (const el of $$("[data-magnetic]")) {
    const xTo = gsap.quickTo(el, "x", { duration: 0.6, ease: "elastic.out(1, 0.45)" });
    const yTo = gsap.quickTo(el, "y", { duration: 0.6, ease: "elastic.out(1, 0.45)" });
    el.addEventListener("pointermove", (e) => {
      const r = el.getBoundingClientRect();
      xTo((e.clientX - r.left - r.width / 2) * 0.22);
      yTo((e.clientY - r.top - r.height / 2) * 0.3);
    });
    el.addEventListener("pointerleave", () => { xTo(0); yTo(0); });
  }
}

function hero() {
  const h = $("[data-hero]");
  if (!h) return;
  const light = $(".stone-light", h);
  if (fine && !reduce) {
    let raf = 0;
    h.addEventListener("pointermove", (e) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = h.getBoundingClientRect();
        light.style.setProperty("--lx", `${((e.clientX - r.left) / r.width) * 100}%`);
        light.style.setProperty("--ly", `${((e.clientY - r.top) / r.height) * 100}%`);
      });
    });
  }
  const paths = $$<SVGPathElement>(".stone-streak path", h);
  const stone = $(".stone", h);
  if (reduce) return;
  for (const p of paths) {
    const len = p.getTotalLength();
    gsap.fromTo(p, { strokeDasharray: len, strokeDashoffset: len }, { strokeDashoffset: 0, duration: 2.4, delay: 0.55, ease: "power3.inOut" });
  }
  gsap.from(stone, { opacity: 0, scale: 1.06, rotate: -12, duration: 2.2, ease: EXPO });
  gsap.to(stone, { yPercent: 14, rotate: -4, ease: "none", scrollTrigger: { trigger: h, start: "top top", end: "bottom top", scrub: true } });
}

// The footer wordmark fills with gold, letter by letter, as it scrolls into view.
function footerMark() {
  const el = $(".footer-mark");
  if (!el) return;
  el.innerHTML = [...el.textContent!.trim()].map((c) => `<span class="ch">${c}</span>`).join("");
  const chars = $$(".ch", el);
  if (reduce) { chars.forEach((c) => c.classList.add("lit")); return; }
  ScrollTrigger.create({
    trigger: el,
    start: "top 95%",
    end: "max",
    scrub: true,
    onUpdate: (st) => {
      const n = Math.round(st.progress * chars.length);
      chars.forEach((c, i) => c.classList.toggle("lit", i < n));
    },
  });
}

// The pipeline draws itself stage by stage as the reader scrolls through it, in either direction.
function flow() {
  const svg = $("[data-flow]");
  if (!svg) return;
  const nodes = $$<SVGGElement>("[data-stage]", svg).filter((n) => n.classList.contains("node"));
  const live = $$<SVGPathElement>(".seg-live", svg);
  if (reduce) return;
  const stages = 1 + Math.max(...nodes.map((n) => Number(n.dataset.stage)));
  for (const p of live) {
    const len = p.getTotalLength();
    p.style.strokeDasharray = `${len}`;
    p.style.strokeDashoffset = `${len}`;
  }
  const tl = gsap.timeline({ paused: true });
  for (const p of live) tl.to(p, { strokeDashoffset: 0, duration: 1, ease: "none" }, Number(p.dataset.stage));
  ScrollTrigger.create({
    trigger: svg,
    start: "top 78%",
    end: "bottom 40%",
    scrub: 0.6,
    onUpdate: (st) => {
      const at = st.progress * stages;
      tl.progress(Math.min(1, at / Math.max(1, tl.duration())));
      nodes.forEach((n) => n.classList.toggle("dim", Number(n.dataset.stage) > at));
    },
  });
  nodes.forEach((n) => n.classList.add("dim"));
}

export function drawStreak(svg: SVGSVGElement) {
  for (const p of $$<SVGPathElement>("path", svg)) {
    const len = p.getTotalLength();
    if (reduce) continue;
    gsap.fromTo(p, { strokeDasharray: len, strokeDashoffset: len }, { strokeDashoffset: 0, duration: 1.4, ease: "power3.inOut" });
  }
}

export function enter(el: Element | Element[], delay = 0) {
  if (reduce) return;
  gsap.from(el, { y: 10, opacity: 0, duration: 0.45, ease: EXPO, stagger: 0.04, delay });
}

let streakId = 0;
// A rubbed streak whose colour carries the verdict.
export function streakSVG(color: string, h = 90): string {
  const id = `r${++streakId}`;
  const y = (n: number) => (h * n).toFixed(1);
  const d = `M6 ${y(0.62)} C 120 ${y(0.3)}, 230 ${y(0.78)}, 360 ${y(0.48)} S 560 ${y(0.3)}, 634 ${y(0.42)}`;
  return `<svg class="streak-svg" viewBox="0 0 640 ${h}" preserveAspectRatio="none" aria-hidden="true" style="height:${h}px">
    <defs><filter id="${id}" x="-5%" y="-60%" width="110%" height="220%">
      <feTurbulence type="fractalNoise" baseFrequency="0.55 0.04" numOctaves="2" seed="${streakId}"/>
      <feDisplacementMap in="SourceGraphic" scale="6" xChannelSelector="R" yChannelSelector="G"/></filter></defs>
    <path d="${d}" stroke="${color}" stroke-width="26" fill="none" stroke-linecap="round" opacity=".18"/>
    <path d="${d}" stroke="${color}" stroke-width="12" fill="none" stroke-linecap="round" filter="url(#${id})"/>
  </svg>`;
}

export const VERDICT = {
  READY: { label: "Ready", color: "#d4a853", chip: "c-gold" },
  NEEDS_PROOF: { label: "Needs proof", color: "#cf8d40", chip: "c-amber" },
  BLOCKED_BY_CODE: { label: "Blocked by code", color: "#8e8c86", chip: "c-ash" },
  KNOWN_OR_OUT_OF_SCOPE: { label: "Known or out of scope", color: "#8e8c86", chip: "c-ash" },
  CITATION_BROKEN: { label: "Citation broken", color: "#c75a40", chip: "c-bad" },
  GUARD_HELD: { label: "Held for a human", color: "#86a3c6", chip: "c-sky" },
} as Record<string, { label: string; color: string; chip: string }>;

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function copyButtons(root: ParentNode = document) {
  for (const b of $$<HTMLButtonElement>("[data-copy]", root)) {
    b.addEventListener("click", async () => {
      const src = document.getElementById(b.dataset.copy!)!;
      await navigator.clipboard.writeText(src.textContent!.trim());
      b.textContent = "Copied";
      b.classList.add("done");
      setTimeout(() => { b.textContent = "Copy"; b.classList.remove("done"); }, 1600);
    });
  }
}

export const ready = (async () => {
  header();
  await bindClaims();
  await document.fonts.ready;
  smoothScroll();
  hero();
  reveals();
  scrubWords();
  pass();
  counters();
  magnetic();
  copyButtons();
  footerMark();
  flow();
  ScrollTrigger.refresh();
})();
