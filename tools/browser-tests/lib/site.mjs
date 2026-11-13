// Assemble a minimal static site around the REAL overlay files, following the way image/rebrand/rebrand.py
// stitches them into index.html. Fixture parts (not the product): the page skeleton, the router stand-in,
// the native settings adapter and the empty chat module. The upstream application bundle is not available here.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function buildSite(repo, out, { voice = false } = {}) {
  const overlay = path.join(repo, 'image/rebrand/overlay');
  const brand = path.join(out, 'brand');
  const site = path.join(out, 'static');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(site, 'assets'), { recursive: true });
  execFileSync(process.execPath, [path.join(repo, 'gateway/organization/materialize-appearance.mjs'), brand],
    { stdio: 'inherit', env: { PATH: process.env.PATH } });
  const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');
  const skin = JSON.parse(read(brand, 'skin.json'));
  const copy = skin.copy;
  const css = read(overlay, 'wp-overlay.css').replaceAll('__WP_APPEARANCE_NAME__', copy.appearanceName)
    .replaceAll('__WP_AVATAR_COLOR__', skin.avatarColor) + '\n' + read(brand, 'wp-pet.css').trimEnd() + '\n\n';
  let js = read(overlay, 'wp-archive.js') + '\n' + read(overlay, 'wp-overlay.js')
    .replaceAll('__WP_WORKDIR__', '/data/work').replaceAll('__WP_PERMISSION__', 'bypassPermissions')
    .replace('  /* __WP_COPY__ */', read(brand, 'copy.js').trimEnd());
  // Fixture: the real chat module and styles come from the upstream bundle.
  js = js.replaceAll('__WP_CHAT_MODULE__', './assets/fixture-chat.js').replaceAll('__WP_CHAT_STYLES__', '[]');
  for (const file of ['wp-skills.js', 'wp-tools.js', 'wp-data-tools.js', 'wp-mcp-tools.js']) js += '\n' + read(overlay, file);
  js += '\n' + read(overlay, 'wp-slash-skills.js')
    .replace('__WP_SKILLS_ZH__', JSON.stringify(JSON.parse(read(repo, 'image/skills-zh.json'))));
  if (skin.bridgeEnabled) js += '\n' + read(overlay, 'wp-feishu-auth.js');
  const feishu = skin.bridgeEnabled ? read(overlay, 'wp-feishu.js') : '/* Messaging bridge is disabled for this organization. */\n';
  let smooth = read(repo, 'image/streaming/smooth-text.mjs');
  smooth = smooth.slice(smooth.indexOf('export class SmoothText {'),
    smooth.indexOf('/** Create a component once per module, sharing the existing React and Markdown renderer identities. */'));
  for (const name of ['export class SmoothText', 'export function protectedLines', 'export function repairStreamingMarkdown']) {
    smooth = smooth.replace(name, name.replace('export ', ''));
  }
  smooth = copy.streamingComment + '\n(() => {\n' + smooth
    + 'window.WpSmoothText = { SmoothText, protectedLines, repairStreamingMarkdown };\n})();\n';
  // Fixture: drives the real wp-settings-bridge.js with stand-ins for the upstream config and i18n objects.
  // The appearance goes to html[data-theme]; the language goes to localStorage.i18nextLng and html[lang].
  const shim = `
const listeners = { theme: new Set(), lang: new Set() };
const root = document.documentElement;
function applyTheme(id) {
  const dark = id === 'dark' || (id === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
}
let theme = localStorage.getItem('fixture-theme') || 'light';
applyTheme(theme);
const config = { get: key => key === 'theme.activeId' ? theme : undefined, whenReady: () => Promise.resolve(),
  subscribe: (key, fn) => { listeners.theme.add(fn); return () => listeners.theme.delete(fn); } };
const setTheme = async value => { await new Promise(done => setTimeout(done, 30)); theme = value; localStorage.setItem('fixture-theme', value); applyTheme(value); listeners.theme.forEach(fn => fn()); };
const i18n = { language: localStorage.getItem('i18nextLng') || 'zh-CN',
  on: (event, fn) => listeners.lang.add(fn), off: (event, fn) => listeners.lang.delete(fn) };
root.lang = i18n.language;
const setLanguage = async value => { await new Promise(done => setTimeout(done, 30)); i18n.language = value; localStorage.setItem('i18nextLng', value); root.lang = value; listeners.lang.forEach(fn => fn()); };
${read(overlay, 'wp-settings-bridge.js').trim()}(config, setTheme, setLanguage, i18n, Promise.resolve(), Promise.resolve());
`;
  // Script order in <head> follows rebrand.py: client.js, web tools, css, pet, smooth, overlay, feishu.
  const index = `<!doctype html>
<html lang="zh-CN" data-color-scheme="default" data-theme="light">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Fixture</title>
    <style>
      @media(max-width:767px) {
        html.fixture-feishu-bot #root > aside { display:none !important; }
        html.fixture-feishu-bot #root > main { padding:16px !important; }
      }
      html.fixture-feishu-bot [class*="_guidContainer_"] { display:flex; flex-direction:column; justify-content:center; height:100%; min-height:100%; overflow:hidden; }
    </style>
    ${voice ? `<style>
      #voice-composer { width:100%; max-width:680px; margin-top:32px; }
      #voice-composer textarea { box-sizing:border-box; width:100%; min-height:80px; }
      #voice-composer .sendbox-actions, #voice-composer .fixture-home-actions { display:flex; align-items:center; justify-content:flex-end; }
      #voice-composer .sendbox-tools-mobile-compact { display:none; }
      #voice-composer [data-testid="send"] { flex:0 0 auto; width:48px; height:32px; }
      @media(max-width:767px) {
        #voice-composer .sendbox-actions { display:none; }
        #voice-composer .sendbox-tools-mobile-compact { display:flex; justify-content:flex-end; align-items:center; }
        #root > aside { display:none !important; }
        #root > main { padding:16px !important; }
      }
    </style>` : ''}
    <script type="module" src="./assets/native-shim.js"></script>
    <script src="/_wp/preview/client.js"></script>
    <script src="./wp-web-tools.js?v=test"></script>
    <link rel="stylesheet" href="./wp-overlay.css?v=test" />
    <script src="./wp-pet.js?v=test"></script>
    <script src="./wp-smooth.js?v=test"></script>
    <script src="./wp-overlay.js?v=test"></script>
    <script src="./wp-feishu.js?v=test"></script>
  </head>
  <body style="margin:0">
    <div id="root" style="display:flex;height:100vh;overflow:hidden">
      <aside class="arco-layout-sider layout-sider" style="width:240px;flex:none;display:flex;flex-direction:column">
        <div class="arco-layout-sider-children" style="display:flex;flex-direction:column;height:100%">
          <header class="arco-layout-header" style="height:40px"></header>
          <div class="fixture-scroll-area" style="flex:1;overflow:auto"></div>
        </div>
      </aside>
      <main style="flex:1;min-width:0;box-sizing:border-box;padding:24px;overflow:hidden">
        <h1 id="fixture-route" style="font-size:16px;overflow-wrap:anywhere">route</h1>
        <div id="fixture-input-container" style="box-sizing:border-box;max-width:100%;padding:12px;border:1px solid #ddd;border-radius:12px">
          <input id="fixture-input" type="text" placeholder="state probe" style="box-sizing:border-box;max-width:100%" />
        </div>
        <a id="fixture-market" href="#/market">market</a>
        ${voice ? `<form id="voice-composer"><div class="sendbox-panel">
          <textarea data-testid="sendbox-input" aria-label="消息"></textarea>
          <div class="sendbox-actions"><button type="submit" data-testid="send">发送</button></div>
          <div class="sendbox-tools-mobile-compact"></div>
        </div></form>` : ''}
      </main>
    </div>
    <script>
      // Fixture router: shows the current hash and records every URL it is asked to route.
      window.__routes = [];
      function showRoute() { document.getElementById('fixture-route').textContent = 'route=' + location.hash; window.__routes.push(location.href); }
      addEventListener('hashchange', showRoute); showRoute();
      ${voice ? `
      window.__sent = 0; window.__voiceInputs = [];
      const form = document.querySelector('#voice-composer');
      form.addEventListener('submit', event => { event.preventDefault(); window.__sent++; });
      function composer() {
        const home = location.hash === '#/guid';
        form.innerHTML = home
          ? '<div class="fixture_guidInputInner"><textarea data-testid="guid-input" aria-label="消息"></textarea><div class="fixture-home-actions"><button class="fixture_actionSubmit" type="submit" data-testid="send">发送</button></div></div>'
          : '<div class="sendbox-panel"><textarea data-testid="sendbox-input" aria-label="消息"></textarea><div class="sendbox-actions"><button type="submit" data-testid="send">发送</button></div><div class="sendbox-tools-mobile-compact"></div></div>';
        const area = form.querySelector('textarea'), native = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
        let tracked = '';
        Object.defineProperty(area, 'value', { get() { return native.get.call(this); }, set(value) { tracked = value; native.set.call(this, value); } });
        area.addEventListener('input', () => { if (area.value !== tracked) { tracked = area.value; window.__voiceInputs.push(tracked); } });
        if (!home && innerWidth < 768) form.querySelector('.sendbox-tools-mobile-compact').append(form.querySelector('[data-testid="send"]'));
      }
      window.__renderComposer = composer;
      addEventListener('hashchange', composer); composer();
      ` : ''}
    </script>
  </body>
</html>
`;
  fs.writeFileSync(path.join(site, 'index.html'), index);
  fs.writeFileSync(path.join(site, 'wp-overlay.css'), css);
  fs.writeFileSync(path.join(site, 'wp-overlay.js'), js);
  fs.writeFileSync(path.join(site, 'wp-pet.js'), read(brand, 'wp-pet.js'));
  fs.writeFileSync(path.join(site, 'wp-smooth.js'), smooth);
  fs.writeFileSync(path.join(site, 'wp-feishu.js'), feishu);
  fs.writeFileSync(path.join(site, 'wp-web-tools.js'), read(overlay, 'wp-web-tools.js'));
  fs.writeFileSync(path.join(site, 'assets/native-shim.js'), shim);
  fs.writeFileSync(path.join(site, 'assets/fixture-chat.js'), 'export {};\n');
  return site;
}
