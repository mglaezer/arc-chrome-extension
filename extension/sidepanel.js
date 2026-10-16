import { getBookmarkTrees, getLinks, setLinks, openBookmark, pinTab, unpin, tabUrl } from './lib.js';

const $ = id => document.getElementById(id);
const favicon = url => `/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`;

let windowId;
let collapsed;
let state;
let drag = null;
let editing = false;
let pendingRename = null;
let renderTimer;
const undoStack = [];

async function init() {
  windowId = (await chrome.windows.getCurrent()).id;
  connectToBackground();
  collapsed = new Set((await chrome.storage.local.get('collapsed')).collapsed ?? []);

  const events = [
    chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onUpdated, chrome.tabs.onActivated,
    chrome.tabs.onMoved, chrome.tabs.onAttached, chrome.tabs.onDetached,
    chrome.bookmarks.onCreated, chrome.bookmarks.onRemoved, chrome.bookmarks.onChanged, chrome.bookmarks.onMoved,
    chrome.storage.onChanged,
  ];
  for (const event of events) event.addListener(scheduleRender);

  $('new-folder').onclick = newFolder;
  $('archive-hours').onchange = e => chrome.storage.local.set({ archiveHours: Number(e.target.value) });
  document.addEventListener('click', hideMenu);
  document.addEventListener('keydown', e => {
    if (e.key === 'z' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !editing) {
      e.preventDefault();
      undo();
    }
  });

  makeDropZone($('favorites'), () => dropAt(state.favorites.id));
  makeDropZone($('pinned'), () => dropAt(state.pinned.id));
  makeDropZone($('today'), item => item.kind === 'bookmark' && item.node.url && unpinBookmark(item.node));

  render();
}

// The open port tells the background script this window's panel is open, so the toolbar button can close it.
// The port drops when the service worker stops, so reconnect to keep the background informed.
function connectToBackground() {
  chrome.runtime.connect({ name: `panel:${windowId}` }).onDisconnect.addListener(connectToBackground);
}

function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 30);
}

async function render() {
  // Replacing the DOM mid-drag or mid-rename would cancel the drag or drop the typed text.
  if (drag || editing) return;
  const [trees, links, tabs, { archive = [], archiveHours = 12 }] = await Promise.all([
    getBookmarkTrees(),
    getLinks(),
    chrome.tabs.query({}),
    chrome.storage.local.get(['archive', 'archiveHours']),
  ]);
  // Checked again because a rename or drag may have started while the data was loading.
  if (drag || editing) return;
  const tabsById = new Map(tabs.map(tab => [tab.id, tab]));
  const linked = new Set(Object.values(links));
  const tabFor = node => tabsById.get(links[node.id]);
  state = trees;

  $('favorites').replaceChildren(...trees.favorites.children.filter(node => node.url).map(node => favoriteTile(node, tabFor(node))));
  $('pinned').replaceChildren(...trees.pinned.children.map(node => treeItem(node, tabFor)));
  $('today').replaceChildren(...tabs
    .filter(tab => tab.windowId === windowId && !linked.has(tab.id))
    .sort((a, b) => b.id - a.id)
    .map(todayRow));
  $('archive-list').replaceChildren(...archive.map(archiveRow));
  if (document.activeElement !== $('archive-hours')) $('archive-hours').value = archiveHours;

  if (pendingRename && startRename(pendingRename)) pendingRename = null;
}

function row(title, url) {
  const el = document.createElement('div');
  el.className = 'row';
  if (url) {
    const img = document.createElement('img');
    img.src = favicon(url);
    el.append(img);
  }
  const span = document.createElement('span');
  span.className = 'title';
  span.textContent = title || url;
  el.append(span);
  return el;
}

function button(text, title, onclick, className = '') {
  const el = document.createElement('button');
  el.textContent = text;
  el.title = title;
  el.className = className;
  el.onclick = e => {
    e.stopPropagation();
    onclick();
  };
  return el;
}

const isActive = tab => !!tab?.active && tab.windowId === windowId;
// Chrome's Memory Saver discards idle tabs; they still exist but show as unloaded, like in Arc.
const isLoaded = tab => !!tab && !tab.discarded;

function favoriteTile(node, tab) {
  const el = document.createElement('div');
  el.className = 'tile';
  el.title = node.title;
  el.classList.toggle('loaded', isLoaded(tab));
  el.classList.toggle('active', isActive(tab));
  const img = document.createElement('img');
  img.src = favicon(node.url);
  el.append(img);
  el.onclick = () => openBookmark(node, windowId);
  el.oncontextmenu = e => showMenu(e, [
    ...(tab ? [['Close tab', () => closeTab(tab, node.id)]] : []),
    ...(tab && tabUrl(tab) !== node.url ? [['Back to pinned URL', () => chrome.tabs.update(tab.id, { url: node.url })]] : []),
    ...(tab ? [['Replace pinned URL with current', () => chrome.bookmarks.update(node.id, { url: tabUrl(tab) })]] : []),
    ['Remove from Favorites', () => unpinBookmark(node)],
  ]);
  makeDraggable(el, { kind: 'bookmark', node });
  makeDropTarget(el, node, 'horizontal');
  return el;
}

const INDENT = 24;
const ROW_PADDING = 8;

function treeItem(node, tabFor, depth = 0) {
  const li = document.createElement('li');
  if (node.url) {
    li.append(bookmarkRow(node, tabFor(node), depth));
    return li;
  }
  const isCollapsed = collapsed.has(node.id);
  const el = row(node.title);
  el.classList.add('folder');
  el.dataset.id = node.id;
  // Indenting inside the row, not the list, leaves no gaps where a drop would miss every row.
  el.style.paddingLeft = `${ROW_PADDING + depth * INDENT}px`;
  el.prepend(folderIcon(isCollapsed));
  el.onclick = () => toggleFolder(node.id);
  el.oncontextmenu = e => showMenu(e, [
    ['Rename', () => startRename(node.id)],
    ['Delete folder and its bookmarks', () => deleteFolder(node)],
  ]);
  makeDraggable(el, { kind: 'bookmark', node });
  makeDropTarget(el, node, 'vertical', depth);
  li.append(el);
  if (!isCollapsed) {
    const ul = document.createElement('ul');
    ul.append(...node.children.map(child => treeItem(child, tabFor, depth + 1)));
    li.append(ul);
  }
  return li;
}

const FOLDER_PATHS = {
  closed: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
  open: 'm6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2',
};

function folderIcon(isCollapsed) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.classList.add('folder-icon');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', isCollapsed ? FOLDER_PATHS.closed : FOLDER_PATHS.open);
  svg.append(path);
  return svg;
}

function bookmarkRow(node, tab, depth) {
  const el = row(node.title, node.url);
  el.classList.add('bookmark');
  el.dataset.id = node.id;
  el.style.paddingLeft = `${ROW_PADDING + depth * INDENT}px`;
  el.classList.toggle('loaded', isLoaded(tab));
  el.classList.toggle('active', isActive(tab));
  if (tab && tabUrl(tab) !== node.url) {
    el.append(button('↩', 'Back to pinned URL', () => chrome.tabs.update(tab.id, { url: node.url }), 'reset'));
  }
  if (tab) el.append(button('✕', 'Close tab', () => closeTab(tab, node.id)));
  el.onclick = () => openBookmark(node, windowId);
  el.oncontextmenu = e => showMenu(e, [
    ['Rename', () => startRename(node.id)],
    ...(tab ? [['Replace pinned URL with current', () => chrome.bookmarks.update(node.id, { url: tabUrl(tab) })]] : []),
    ['Unpin', () => unpinBookmark(node)],
  ]);
  makeDraggable(el, { kind: 'bookmark', node });
  makeDropTarget(el, node, 'vertical', depth);
  return el;
}

function todayRow(tab) {
  const el = row(tab.title, tabUrl(tab));
  el.classList.toggle('active', isActive(tab));
  el.append(button('✕', 'Close tab', () => closeTab(tab)));
  el.onclick = () => chrome.tabs.update(tab.id, { active: true });
  el.oncontextmenu = e => showMenu(e, [
    ['Pin', () => pinTab(tab, state.pinned.id)],
    ['Add to Favorites', () => pinTab(tab, state.favorites.id)],
    ['Close', () => closeTab(tab)],
  ]);
  makeDraggable(el, { kind: 'tab', tab });
  return el;
}

function archiveRow(entry) {
  const el = row(entry.title, entry.url);
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = ago(entry.closedAt);
  el.append(time);
  el.onclick = () => restore(entry);
  return el;
}

function ago(time) {
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

async function restore(entry) {
  await chrome.tabs.create({ windowId, url: entry.url });
  const { archive = [] } = await chrome.storage.local.get('archive');
  await chrome.storage.local.set({
    archive: archive.filter(e => !(e.url === entry.url && e.closedAt === entry.closedAt)),
  });
}

async function closeTab(tab, bookmarkId) {
  undoStack.push({ type: 'close', url: tabUrl(tab), bookmarkId });
  await chrome.tabs.remove(tab.id);
}

async function unpinBookmark(node) {
  undoStack.push({ type: 'restore', node, links: await getLinks() });
  await unpin(node.id);
}

async function deleteFolder(node) {
  const [tree] = await chrome.bookmarks.getSubTree(node.id);
  undoStack.push({ type: 'restore', node: tree, links: await getLinks() });
  await chrome.bookmarks.removeTree(node.id);
}

async function undo() {
  const action = undoStack.pop();
  if (!action) return;
  if (action.type === 'close') {
    // Restoring from the session keeps the tab's back history, unlike opening the URL again.
    const closed = await chrome.sessions.getRecentlyClosed();
    const entry = closed.find(session => session.tab?.url === action.url);
    const tab = entry
      ? (await chrome.sessions.restore(entry.tab.sessionId)).tab
      : await chrome.tabs.create({ windowId, url: action.url });
    if (action.bookmarkId) await setLinks({ ...await getLinks(), [action.bookmarkId]: tab.id });
    return;
  }
  const relinks = {};
  await recreate(action.node, action.node.parentId, action.links, relinks);
  const openTabIds = new Set((await chrome.tabs.query({})).map(tab => tab.id));
  const links = await getLinks();
  const linkedTabIds = new Set(Object.values(links));
  for (const [bookmarkId, tabId] of Object.entries(relinks)) {
    if (openTabIds.has(tabId) && !linkedTabIds.has(tabId)) links[bookmarkId] = tabId;
  }
  await setLinks(links);
}

async function recreate(node, parentId, oldLinks, relinks) {
  const created = await chrome.bookmarks.create({ parentId, index: node.index, title: node.title, url: node.url });
  if (oldLinks[node.id]) relinks[created.id] = oldLinks[node.id];
  for (const child of node.children ?? []) await recreate(child, created.id, oldLinks, relinks);
}

function toggleFolder(id) {
  if (collapsed.has(id)) collapsed.delete(id);
  else collapsed.add(id);
  chrome.storage.local.set({ collapsed: [...collapsed] });
}

async function newFolder() {
  const folder = await chrome.bookmarks.create({ parentId: state.pinned.id, title: 'New folder' });
  pendingRename = folder.id;
}

function startRename(id) {
  const title = document.querySelector(`[data-id="${id}"] .title`);
  if (!title) return false;
  editing = true;
  const el = title.closest('.row');
  el.draggable = false;
  const input = document.createElement('input');
  input.value = title.textContent;
  title.replaceWith(input);
  input.focus();
  input.select();

  const finish = async save => {
    if (!editing) return;
    editing = false;
    const value = input.value.trim();
    if (save && value) await chrome.bookmarks.update(id, { title: value });
    scheduleRender();
  };
  input.onkeydown = e => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  };
  input.onblur = () => finish(true);
  input.onclick = e => e.stopPropagation();
  return true;
}

function showMenu(e, items) {
  e.preventDefault();
  const menu = $('menu');
  menu.replaceChildren(...items.map(([label, action]) => {
    const item = document.createElement('button');
    item.textContent = label;
    item.onclick = () => {
      hideMenu();
      action();
    };
    return item;
  }));
  menu.hidden = false;
  menu.style.left = `${Math.max(4, Math.min(e.clientX, innerWidth - menu.offsetWidth - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(e.clientY, innerHeight - menu.offsetHeight - 4))}px`;
}

function hideMenu() {
  $('menu').hidden = true;
}

function makeDraggable(el, item) {
  el.draggable = true;
  el.ondragstart = e => {
    drag = item;
    e.dataTransfer.effectAllowed = 'move';
  };
  el.ondragend = () => {
    drag = null;
    clearDropMarks();
    scheduleRender();
  };
}

function clearDropMarks() {
  for (const el of document.querySelectorAll('.drop-into')) el.classList.remove('drop-into');
  $('drop-line').hidden = true;
}

function dropTarget(e, el, node, axis, depth) {
  const rect = el.getBoundingClientRect();
  const fraction = axis === 'horizontal'
    ? (e.clientX - rect.left) / rect.width
    : (e.clientY - rect.top) / rect.height;
  if (!node.url && fraction > 0.25 && fraction < 0.75) return { parentId: node.id, into: true };
  const after = fraction >= 0.5;
  // Below an open folder's row the line is drawn above its first child, so the drop must go there too.
  if (after && !node.url && !collapsed.has(node.id) && node.children?.length) {
    return { parentId: node.id, index: 0, after, depth: depth + 1 };
  }
  return { parentId: node.parentId, index: node.index + (after ? 1 : 0), after, depth };
}

function showDropLine(rect, after, axis, depth = 0) {
  const line = $('drop-line');
  line.hidden = false;
  line.classList.toggle('vertical', axis === 'horizontal');
  if (axis === 'horizontal') {
    // Centered in the 6px gap between tiles.
    line.style.left = `${after ? rect.right + 2 : rect.left - 4}px`;
    line.style.top = `${rect.top}px`;
    line.style.width = '';
    line.style.height = `${rect.height}px`;
  } else {
    const indent = ROW_PADDING + depth * INDENT;
    line.style.left = `${rect.left + indent}px`;
    line.style.top = `${(after ? rect.bottom : rect.top) - 1}px`;
    line.style.width = `${rect.width - indent}px`;
    line.style.height = '';
  }
}

function makeDropTarget(el, node, axis, depth = 0) {
  el.ondragover = e => {
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    clearDropMarks();
    const target = dropTarget(e, el, node, axis, depth);
    if (target.into) el.classList.add('drop-into');
    else showDropLine(el.getBoundingClientRect(), target.after, axis, target.depth);
  };
  el.ondrop = e => {
    e.preventDefault();
    e.stopPropagation();
    const target = dropTarget(e, el, node, axis, depth);
    if (target.into && collapsed.has(node.id)) toggleFolder(node.id);
    dropAt(target.parentId, target.index);
  };
}

function makeDropZone(el, onDrop) {
  el.ondragover = e => {
    if (!drag) return;
    e.preventDefault();
    clearDropMarks();
    el.classList.add('drop-into');
  };
  el.ondragleave = e => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('drop-into');
  };
  el.ondrop = e => {
    e.preventDefault();
    onDrop(drag);
  };
}

async function dropAt(parentId, index) {
  const item = drag;
  if (item.kind === 'tab') return pinTab(item.tab, parentId, index);
  // Favorites show only bookmarks, so a folder dropped there would disappear from view.
  if (parentId === state.favorites.id && !item.node.url) return;
  await chrome.bookmarks.move(item.node.id, { parentId, index }).catch(console.warn);
}

init();
