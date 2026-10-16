import { getFolders, getLinks, setLinks, pinTab, unpin, linkedBookmarkId, tabUrl } from './lib.js';

const ARCHIVE_SIZE = 100;
const DEFAULT_ARCHIVE_HOURS = 12;

const panelPorts = new Map();

chrome.runtime.onConnect.addListener(port => {
  const windowId = Number(port.name.split(':')[1]);
  panelPorts.set(windowId, port);
  port.onDisconnect.addListener(() => panelPorts.get(windowId) === port && panelPorts.delete(windowId));
});

// The toolbar button toggles the panel, so Chrome's built-in open-only click behavior is turned off.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });

// sidePanel.open must run synchronously inside the click, so the open state comes from memory, not storage.
chrome.action.onClicked.addListener(tab => {
  if (panelPorts.has(tab.windowId)) chrome.sidePanel.close({ windowId: tab.windowId });
  else chrome.sidePanel.open({ windowId: tab.windowId });
});

chrome.runtime.onInstalled.addListener(() => getFolders());

// Alarms are not guaranteed to survive a browser restart, so recreate on every service worker start.
chrome.alarms.get('archive').then(alarm => alarm || chrome.alarms.create('archive', { periodInMinutes: 10 }));

chrome.tabs.onRemoved.addListener(async tabId => {
  const links = await getLinks();
  const bookmarkId = linkedBookmarkId(links, tabId);
  if (!bookmarkId) return;
  delete links[bookmarkId];
  await setLinks(links);
});

// Discarding or prerendering can swap a tab for a new one with a different id.
chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  const links = await getLinks();
  const bookmarkId = linkedBookmarkId(links, removedTabId);
  if (!bookmarkId) return;
  links[bookmarkId] = addedTabId;
  await setLinks(links);
});

const nodeIds = node => [node.id, ...(node.children ?? []).flatMap(nodeIds)];

chrome.bookmarks.onRemoved.addListener(async (id, { node }) => {
  const links = await getLinks();
  const removed = nodeIds(node).filter(nodeId => nodeId in links);
  if (!removed.length) return;
  for (const nodeId of removed) delete links[nodeId];
  await setLinks(links);
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-pin') return;
  const bookmarkId = linkedBookmarkId(await getLinks(), tab.id);
  if (bookmarkId) await unpin(bookmarkId);
  else await pinTab(tab, (await getFolders()).pinned.id);
});

chrome.alarms.onAlarm.addListener(async ({ name }) => {
  if (name !== 'archive') return;
  const { archiveHours = DEFAULT_ARCHIVE_HOURS, archive = [] } = await chrome.storage.local.get(['archiveHours', 'archive']);
  if (!archiveHours) return;
  const linked = new Set(Object.values(await getLinks()));
  const cutoff = Date.now() - archiveHours * 3600 * 1000;
  const stale = (await chrome.tabs.query({})).filter(tab =>
    !linked.has(tab.id) && !tab.active && !tab.pinned && !tab.audible && tab.lastAccessed < cutoff);
  if (!stale.length) return;
  const closedAt = Date.now();
  const entries = stale.map(tab => ({ title: tab.title, url: tabUrl(tab), closedAt }));
  await chrome.storage.local.set({ archive: [...entries, ...archive].slice(0, ARCHIVE_SIZE) });
  await chrome.tabs.remove(stale.map(tab => tab.id));
});
