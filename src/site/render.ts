import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";

interface Page {
  slug: string;
  title: string;
  description: string;
  nav: string;
  body: string;
  script: string | null;
}

const NAV = [
  { href: "/", label: "Check", key: "home" },
  { href: "/judges/", label: "Judges", key: "judges" },
  { href: "/proof/", label: "Proof", key: "proof" },
  { href: "/how/", label: "How it works", key: "how" },
  { href: "/agents/", label: "For agents", key: "agents" },
];

// {{loc:path:text}} becomes path:line for the first line containing text, so call sites never go stale.
function resolveLocations(html: string): string {
  return html.replace(/\{\{loc:([^:}]+):([^}]+)\}\}/g, (_, path: string, needle: string) => {
    const line = readFileSync(path, "utf8").split("\n").findIndex((l) => l.includes(needle));
    if (line < 0) throw new Error(`call site not found: ${path} :: ${needle}`);
    return `${path}:${line + 1}`;
  });
}

// Page files start with an HTML comment holding `key: value` lines.
function parse(file: string): Page {
  const raw = readFileSync(file, "utf8");
  const head = /^<!--([\s\S]*?)-->\n/.exec(raw);
  if (!head) throw new Error(`${file}: missing front matter`);
  const meta = Object.fromEntries(
    head[1].trim().split("\n").map((l) => {
      const i = l.indexOf(":");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
  );
  return {
    slug: meta.slug,
    title: meta.title,
    description: meta.description,
    nav: meta.nav,
    script: meta.script || null,
    body: resolveLocations(raw.slice(head[0].length)),
  };
}

function layout(p: Page): string {
  const nav = NAV.map((n) => `<a href="${n.href}"${n.key === p.nav ? ' aria-current="page"' : ""}>${n.label}</a>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${p.title}</title>
<meta name="description" content="${p.description}">
<meta property="og:title" content="${p.title}">
<meta property="og:description" content="${p.description}">
<meta name="theme-color" content="#0c0c0d">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='%230c0c0d'/><path d='M12 40 C 24 26, 36 44, 52 24' stroke='%23d4a853' stroke-width='6' fill='none' stroke-linecap='round'/></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/site.css">
</head>
<body data-page="${p.nav}">
<header class="site-header">
  <div class="wrap">
    <a class="brand" href="/" aria-label="Basanos home"><b>Basanos</b><i>βάσανος</i></a>
    <button class="menu-toggle" aria-expanded="false" aria-controls="nav">Menu</button>
    <nav class="nav" id="nav">${nav}<a class="btn sm" href="/#check">Run a check <span class="arrow">→</span></a></nav>
  </div>
</header>
<main>
${p.body}
</main>
<footer class="site-footer">
  <div class="wrap">
    <p class="footer-mark" aria-hidden="true">Basanos</p>
    <div class="footer-grid">
      <div>
        <p>An evidence check for audit-contest findings. Code checks the citations, an open model on Dolphin reads the whole source, SERV guards the text and makes one bounded call. It never submits anything.</p>
        <p>Built for SERV Hackathon 02 · Dolphin track · by <a href="https://x.com/cassxbt">@cassxbt</a></p>
      </div>
      <ul>${NAV.map((n) => `<li><a href="${n.href}">${n.label}</a></li>`).join("")}</ul>
      <ul>
        <li>Labels are contest outcomes, not ground truth about bugs.</li>
        <li>Shown on a closed contest. Nothing is posted back.</li>
        <li>Every number on this site is read from <a href="/data/claims.json">claims.json</a>.</li>
      </ul>
    </div>
  </div>
</footer>
<script type="module" src="/assets/${p.script ?? "site"}.js"></script>
</body>
</html>
`;
}

export function renderPages(srcDir: string, outDir: string): string[] {
  const written: string[] = [];
  for (const f of readdirSync(srcDir).filter((f) => f.endsWith(".html"))) {
    const page = parse(`${srcDir}/${f}`);
    const dir = page.slug === "" ? outDir : `${outDir}/${page.slug}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/index.html`, layout(page));
    written.push(`/${page.slug}`);
  }
  return written;
}
