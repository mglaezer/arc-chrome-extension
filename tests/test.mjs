import { chromium } from 'playwright';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('../extension', import.meta.url));

const server = http.createServer((req, res) => {
  const name = req.url.slice(1);
  res.setHeader('content-type', 'text/html');
  res.end(`<title>Page ${name.toUpperCase()}</title><h1>${name}</h1>`);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = name => `http://127.0.0.1:${server.address().port}/${name}`;

let failed = 0;
const errors = [];
async function check(name, fn) {
  try {
    await fn();
    console.log('PASS', name);
  } catch (e) {
    failed++;
    console.log('FAIL', name, '-', e.message.split('\n')[0]);
  }
}
async function until(fn, message, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(message);
}

const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
const panel = context.pages()[0] ?? await context.newPage();
panel.on('pageerror', e => errors.push(`panel: ${e.message}`));
panel.on('console', m => m.type() === 'error' && errors.push(`panel console: ${m.text()}`));
await panel.goto(`chrome-extension://${extId}/sidepanel.html`);

const run = (fn, arg) => panel.evaluate(fn, arg);
const folder = name => run(async name => {
  const [arc] = await chrome.bookmarks.search({ title: 'Arc' });
  const found = (await chrome.bookmarks.getChildren(arc.id)).find(c => c.title === name);
  return (await chrome.bookmarks.getSubTree(found.id))[0];
}, name);
const links = () => run(async () => (await chrome.storage.session.get('links')).links ?? {});
const tabs = () => run(() => chrome.tabs.query({}));
const openTab = u => run(async u => {
  const w = await chrome.windows.getCurrent();
  return chrome.tabs.create({ windowId: w.id, url: u, active: false });
}, u);
const row = (section, text) => panel.locator(`#${section} .row`, { hasText: text });
const menu = label => panel.locator('#menu button', { hasText: label });
const pinnedBookmark = async () => (await folder('Pinned')).children.find(c => c.url);

let bookmarkId;

await check('creates Arc/Favorites and Arc/Pinned folders', async () => {
  await until(async () => (await folder('Pinned')) && (await folder('Favorites')), 'folders missing');
});

await check('Today lists open tabs', async () => {
  await openTab(url('a'));
  await openTab(url('b'));
  await until(async () => await row('today', 'Page A').count() === 1 && await row('today', 'Page B').count() === 1, 'tabs not in Today');
});

await check('Pin from context menu creates a linked bookmark', async () => {
  await row('today', 'Page A').click({ button: 'right' });
  await menu(/^Pin$/).click();
  await until(async () => (await pinnedBookmark())?.url === url('a'), 'bookmark not created');
  bookmarkId = (await pinnedBookmark()).id;
  await until(async () => (await links())[bookmarkId], 'not linked');
  await until(async () => await panel.locator('#pinned .bookmark.loaded', { hasText: 'Page A' }).count() === 1, 'pinned row not loaded');
  await until(async () => await row('today', 'Page A').count() === 0, 'still in Today');
});

await check('✕ closes the tab and keeps the bookmark', async () => {
  const pinnedRow = panel.locator('#pinned .bookmark', { hasText: 'Page A' });
  await pinnedRow.hover();
  await pinnedRow.locator('button[title="Close tab"]').click();
  await until(async () => !(await tabs()).some(t => t.url === url('a')), 'tab still open');
  await until(async () => !(await links())[bookmarkId], 'link not removed');
  await until(async () => await panel.locator('#pinned .bookmark:not(.loaded)', { hasText: 'Page A' }).count() === 1, 'row not dimmed');
  if (!(await pinnedBookmark())) throw new Error('bookmark deleted');
});

await check('Clicking an unloaded entry opens and links a tab', async () => {
  await panel.locator('#pinned .bookmark', { hasText: 'Page A' }).click();
  await until(async () => (await links())[bookmarkId], 'not linked');
  await panel.bringToFront();
  await until(async () => await panel.locator('#pinned .bookmark.loaded', { hasText: 'Page A' }).count() === 1, 'row not loaded');
});

await check('Clicking a loaded entry focuses its tab, no duplicate', async () => {
  await panel.bringToFront();
  await panel.locator('#pinned .bookmark', { hasText: 'Page A' }).click();
  await new Promise(r => setTimeout(r, 500));
  const count = (await tabs()).filter(t => (t.pendingUrl || t.url) === url('a')).length;
  if (count !== 1) throw new Error(`${count} tabs for Page A`);
  await panel.bringToFront();
});

await check('Navigating away shows ↩, which returns to the pinned URL', async () => {
  const tabId = (await links())[bookmarkId];
  await run(([id, u]) => chrome.tabs.update(id, { url: u }), [tabId, url('c')]);
  const reset = panel.locator('#pinned .bookmark button.reset');
  await until(async () => await reset.isVisible(), '↩ not shown');
  await reset.click();
  await until(async () => (await run(id => chrome.tabs.get(id), tabId)).url === url('a'), 'tab not reset');
  await until(async () => await reset.count() === 0, '↩ still shown');
});

await check('Replace pinned URL with current', async () => {
  const tabId = (await links())[bookmarkId];
  await run(([id, u]) => chrome.tabs.update(id, { url: u }), [tabId, url('c')]);
  await until(async () => await panel.locator('#pinned .bookmark button.reset').count() === 1, '↩ not shown');
  await panel.locator('#pinned .bookmark').first().click({ button: 'right' });
  await menu('Replace pinned URL').click();
  await until(async () => (await pinnedBookmark()).url === url('c'), 'URL not replaced');
  await until(async () => await panel.locator('#pinned .bookmark button.reset').count() === 0, '↩ still shown');
});

await check('Rename from context menu', async () => {
  await panel.locator('#pinned .bookmark').first().click({ button: 'right' });
  await menu('Rename').click();
  await panel.keyboard.type('Renamed');
  await panel.keyboard.press('Enter');
  await until(async () => (await pinnedBookmark()).title === 'Renamed', 'title not updated');
});

let folderId;
await check('+ creates a folder and starts renaming it', async () => {
  await panel.locator('#new-folder').click();
  await until(async () => await panel.locator('#pinned .folder input').count() === 1, 'rename input not shown');
  await panel.keyboard.type('Work');
  await panel.keyboard.press('Enter');
  await until(async () => (await folder('Pinned')).children.some(c => !c.url && c.title === 'Work'), 'folder missing');
  folderId = (await folder('Pinned')).children.find(c => c.title === 'Work').id;
});

await check('Drag a bookmark into a folder', async () => {
  const folderRow = panel.locator('#pinned .folder', { hasText: 'Work' });
  const box = await folderRow.boundingBox();
  await panel.locator('#pinned .bookmark', { hasText: 'Renamed' }).dragTo(folderRow, { targetPosition: { x: 20, y: box.height / 2 } });
  await until(async () => (await run(id => chrome.bookmarks.get(id), bookmarkId))[0].parentId === folderId, 'not moved into folder');
});

await check('Clicking a folder collapses and expands it', async () => {
  const folderRow = panel.locator('#pinned .folder', { hasText: 'Work' });
  await folderRow.click();
  await until(async () => await panel.locator('#pinned .bookmark', { hasText: 'Renamed' }).count() === 0, 'not collapsed');
  await folderRow.click();
  await until(async () => await panel.locator('#pinned .bookmark', { hasText: 'Renamed' }).count() === 1, 'not expanded');
});

await check('Dropping into a collapsed folder expands it', async () => {
  await openTab(url('g'));
  await until(async () => await row('today', 'Page G').count() === 1, 'G not in Today');
  const folderRow = panel.locator('#pinned .folder', { hasText: 'Work' });
  await folderRow.click();
  await until(async () => await panel.locator('#pinned .bookmark', { hasText: 'Renamed' }).count() === 0, 'not collapsed');
  const box = await folderRow.boundingBox();
  await row('today', 'Page G').dragTo(folderRow, { targetPosition: { x: 20, y: box.height / 2 } });
  await until(async () => await panel.locator('#pinned .bookmark', { hasText: 'Page G' }).count() === 1, 'not expanded after drop');
  const g = (await run(id => chrome.bookmarks.getChildren(id), folderId)).find(c => c.url === url('g'));
  if (!g) throw new Error('G not in folder');
});

const workChildren = async () => (await run(id => chrome.bookmarks.getChildren(id), folderId)).map(c => c.url);

await check('Dragging below a sibling reorders within the folder and shows a straight line', async () => {
  const target = panel.locator('#pinned .bookmark', { hasText: 'Page G' });
  const box = await target.boundingBox();
  await panel.locator('#pinned .bookmark', { hasText: 'Renamed' }).hover();
  await panel.mouse.down();
  await panel.mouse.move(box.x + 40, box.y + box.height * 0.9, { steps: 5 });
  const line = await run(() => { const l = document.getElementById('drop-line'); return { hidden: l.hidden, rect: l.getBoundingClientRect().toJSON() }; });
  await panel.mouse.up();
  if (line.hidden) throw new Error('drop line not shown');
  if (Math.abs(line.rect.top + 1 - (box.y + box.height)) > 1) throw new Error(`line at ${line.rect.top}, row bottom ${box.y + box.height}`);
  if (line.rect.left < box.x + 24) throw new Error('line not indented to the child level');
  await until(async () => (await workChildren()).join() === [url('g'), url('c')].join(), 'order not G, C');
});

await check('Dropping on the indent of a child row stays inside the folder', async () => {
  await openTab(url('h'));
  await until(async () => await row('today', 'Page H').count() === 1, 'H not in Today');
  const target = panel.locator('#pinned .bookmark', { hasText: 'Renamed' });
  const box = await target.boundingBox();
  await row('today', 'Page H').dragTo(target, { targetPosition: { x: 4, y: box.height * 0.2 } });
  await until(async () => (await workChildren()).join() === [url('g'), url('h'), url('c')].join(), 'H not placed between G and C');
});

await check('Dropping below an open folder row puts the item first inside it', async () => {
  await openTab(url('i'));
  await until(async () => await row('today', 'Page I').count() === 1, 'I not in Today');
  const folderRow = panel.locator('#pinned .folder', { hasText: 'Work' });
  const box = await folderRow.boundingBox();
  await row('today', 'Page I').dragTo(folderRow, { targetPosition: { x: 40, y: box.height * 0.9 } });
  await until(async () => (await workChildren())[0] === url('i'), 'I not first in folder');
  // The next test drags a Today row, so wait for this drop's re-render to finish replacing the rows.
  await until(async () => await row('today', 'Page I').count() === 0, 'I still in Today');
});

await check('Drag a Today tab into Favorites', async () => {
  await row('today', 'Page B').dragTo(panel.locator('#favorites'));
  await until(async () => (await folder('Favorites')).children?.some(c => c.url === url('b')), 'favorite not created');
  await until(async () => await panel.locator('#favorites .tile.loaded').count() === 1, 'tile not loaded');
  await until(async () => await row('today', 'Page B').count() === 0, 'still in Today');
});

await check('Drag a pinned entry onto Today unpins it and keeps the tab', async () => {
  const tabId = (await links())[bookmarkId];
  await panel.locator('#pinned .bookmark', { hasText: 'Renamed' }).dragTo(panel.locator('#today'));
  await until(async () => (await run(async id => (await chrome.bookmarks.get(id).catch(() => [])).length, bookmarkId)) === 0, 'bookmark not removed');
  await until(async () => (await tabs()).some(t => t.id === tabId), 'tab closed');
  await until(async () => await row('today', 'Page C').count() === 1, 'tab not in Today');
});

await check('Links are rebuilt by URL after session storage is cleared', async () => {
  await run(() => chrome.storage.session.clear());
  await panel.reload();
  await until(async () => await panel.locator('#favorites .tile.loaded').count() === 1, 'favorite not relinked');
});

await check('Auto-archive closes idle Today tabs; clicking restores', async () => {
  await openTab(url('d'));
  await until(async () => await row('today', 'Page D').count() === 1, 'D not in Today');
  await run(() => chrome.storage.local.set({ archiveHours: 0.000001 }));
  await sw.evaluate(() => chrome.alarms.create('archive', { when: Date.now() + 200 }));
  await until(async () => !(await tabs()).some(t => t.url === url('d')), 'D not closed', 8000);
  if (!(await tabs()).some(t => t.url === url('b'))) throw new Error('favorite tab was archived');
  await run(() => chrome.storage.local.set({ archiveHours: 0 }));
  await panel.locator('#archive summary').click();
  await until(async () => await row('archive-list', 'Page D').count() === 1, 'D not in archive list');
  await row('archive-list', 'Page D').click();
  await until(async () => (await tabs()).some(t => (t.pendingUrl || t.url) === url('d')), 'D not restored');
  await panel.bringToFront();
  await until(async () => await row('archive-list', 'Page D').count() === 0, 'D still in archive');
});

let eId;
const eRow = () => panel.locator('#pinned .bookmark', { hasText: 'Page E' });
const eBookmark = async () => (await folder('Pinned')).children.find(c => c.url === url('e'));

await check('Pin Page E for the undo tests', async () => {
  await panel.bringToFront();
  await openTab(url('e'));
  await until(async () => await row('today', 'Page E').count() === 1, 'E not in Today');
  await row('today', 'Page E').click({ button: 'right' });
  await menu(/^Pin$/).click();
  await until(async () => await panel.locator('#pinned .bookmark.loaded', { hasText: 'Page E' }).count() === 1, 'E not loaded');
  eId = (await eBookmark()).id;
});

await check('Cmd+Z undoes unpin and relinks the open tab', async () => {
  await panel.bringToFront();
  const tabId = (await links())[eId];
  await eRow().click({ button: 'right' });
  await menu('Unpin').click();
  await until(async () => !(await eBookmark()), 'not unpinned');
  await panel.locator('body').click({ position: { x: 5, y: 5 } });
  await panel.keyboard.press('Meta+z');
  await until(async () => (await eBookmark())?.title === 'Page E', 'bookmark not restored');
  eId = (await eBookmark()).id;
  await until(async () => (await links())[eId] === tabId, 'tab not relinked');
});

await check('Cmd+Z undoes closing a pinned tab', async () => {
  await panel.bringToFront();
  await eRow().hover();
  await eRow().locator('button[title="Close tab"]').click();
  await until(async () => !(await links())[eId], 'not closed');
  await panel.keyboard.press('Meta+z');
  await until(async () => (await tabs()).some(t => (t.pendingUrl || t.url) === url('e')), 'tab not restored');
  await until(async () => (await links())[eId], 'not relinked');
});

await check('Cmd+Z undoes deleting a folder with its bookmarks', async () => {
  await panel.bringToFront();
  await run(async ([u]) => {
    const [arc] = await chrome.bookmarks.search({ title: 'Arc' });
    const pinned = (await chrome.bookmarks.getChildren(arc.id)).find(c => c.title === 'Pinned');
    const f = await chrome.bookmarks.create({ parentId: pinned.id, title: 'Temp' });
    await chrome.bookmarks.create({ parentId: f.id, title: 'Inside', url: u });
  }, [url('f')]);
  const folderRow = panel.locator('#pinned .folder', { hasText: 'Temp' });
  await until(async () => await folderRow.count() === 1, 'folder not shown');
  await folderRow.click({ button: 'right' });
  await menu('Delete folder').click();
  await until(async () => !(await folder('Pinned')).children.some(c => c.title === 'Temp'), 'not deleted');
  await panel.keyboard.press('Meta+z');
  await until(async () => {
    const temp = (await folder('Pinned')).children.find(c => c.title === 'Temp');
    return temp?.children?.[0]?.url === url('f');
  }, 'folder not restored');
});

await check('No errors in the panel', async () => {
  if (errors.length) throw new Error(errors.join(' | '));
});

await context.close();
server.close();
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
