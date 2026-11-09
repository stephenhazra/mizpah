import { createServer } from "node:http";

export const DEMO_HOST = "news.example";

const AD_SCRIPTS = [
  "https://securepubads.g.doubleclick.net/tag/js/gpt.js",
  "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js",
  "https://www.google-analytics.com/analytics.js",
  "https://connect.facebook.net/en_US/fbevents.js",
  "https://static.criteo.net/js/ld/publishertag.js",
  "https://c.amazon-adsystem.com/aax2/apstag.js",
  "https://cdn.taboola.com/libtrc/demo/loader.js",
  "https://widgets.outbrain.com/outbrain.js"
];

const article = (title) => `<article><h2>${title}</h2><p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Integer posuere erat a ante venenatis dapibus, posuere velit aliquet. Donec sed odio dui, cras mattis consectetur purus sit amet fermentum.</p></article>`;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>The Daily Example</title>
<style>body{font:17px/1.5 Georgia,serif;margin:0;color:#222}header{padding:18px 32px;border-bottom:3px solid #222;font:800 30px system-ui}main{display:grid;grid-template-columns:1fr 300px;gap:32px;padding:24px 32px}.ad-banner,.adsbygoogle{display:block;background:#f3d7d2;border:1px dashed #b33;min-height:250px}</style>
${AD_SCRIPTS.map((src) => `<script async src="${src}"></script>`).join("")}
</head><body><header>The Daily Example</header><main><div>
${["Local library extends weekend hours", "City council approves new bike lanes", "Farmers market returns for the season"].map(article).join("")}
</div><aside><ins class="adsbygoogle"></ins><div class="ad-banner"></div></aside></main></body></html>`;

export async function startDemoSite({ anyHost = false, port: listenPort = 0 } = {}) {
  const server = createServer((req, res) => {
    const host = (req.headers.host || "").split(":")[0];
    if (host !== DEMO_HOST && !anyHost) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
  });
  await new Promise((resolve) => server.listen(listenPort, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://${DEMO_HOST}:${port}/`,
    chromeArgs: [`--host-resolver-rules=MAP * 127.0.0.1:${port}`],
    close: () => server.close()
  };
}
