// Runs inside the embedded tone3000.com page (isolated world). Adds an "Add to Fretforge"
// button next to every download control; clicking it arms the next download so the main
// process puts the file in the rig library, then presses the site's own button.
import { ipcRenderer } from 'electron';

const MARK = 'data-fretforge';

function pageInfo() {
  const creator = document.querySelector('a[href*="/users/"], a[href^="/u/"], [data-username]')?.textContent?.trim()
    || document.querySelector('meta[name="author"]')?.getAttribute('content') || undefined;
  return { url: location.href, title: document.title, creator };
}

function isDownload(el: Element): boolean {
  if (el.closest(`[${MARK}]`)) return false;
  const a = el as HTMLAnchorElement;
  if (el.tagName === 'A' && (a.hasAttribute('download') || /\/download\b/i.test(a.getAttribute('href') ?? ''))) return true;
  const label = `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''} ${(el.textContent ?? '').trim().slice(0, 40)}`;
  return /\bdownload\b/i.test(label);
}

function addButton(target: HTMLElement) {
  if (target.getAttribute(`${MARK}-done`)) return;
  target.setAttribute(`${MARK}-done`, '1');
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute(MARK, 'add');
  b.textContent = '＋ Fretforge';
  b.title = 'Add this to your Fretforge rig library';
  b.style.cssText = 'margin-left:6px;padding:4px 10px;border-radius:999px;border:1px solid #f0a33a;background:#f0a33a;color:#111;'
    + 'font:600 12px/1.4 system-ui,sans-serif;cursor:pointer;vertical-align:middle;white-space:nowrap;z-index:5;position:relative';
  b.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    ipcRenderer.send('ff:t3k:arm', pageInfo());
    b.textContent = 'Adding…';
    setTimeout(() => { b.textContent = '＋ Fretforge'; }, 4000);
    target.click();
  });
  target.insertAdjacentElement('afterend', b);
}

function scan(root: ParentNode) {
  root.querySelectorAll('a, button, [role="button"]').forEach((el) => { if (isDownload(el)) addButton(el as HTMLElement); });
}

function start() {
  scan(document);
  new MutationObserver((muts) => {
    for (const m of muts) m.addedNodes.forEach((n) => { if (n.nodeType === 1) scan(n as Element); });
  }).observe(document.body, { childList: true, subtree: true });
  ipcRenderer.send('ff:t3k:page', pageInfo());
  // single-page navigation
  let last = location.href;
  setInterval(() => { if (location.href !== last) { last = location.href; ipcRenderer.send('ff:t3k:page', pageInfo()); scan(document); } }, 800);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
