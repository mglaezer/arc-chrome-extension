const ROOT_TITLE = 'Arc';

export const tabUrl = tab => tab.pendingUrl || tab.url;

export const linkedBookmarkId = (links, tabId) => Object.keys(links).find(id => links[id] === tabId);

export async function getFolders() {
  const roots = await chrome.bookmarks.getChildren('0');
  const other = roots.find(node => node.folderType === 'other') ?? roots.find(node => node.id === '2');
  const root = await findOrCreateFolder(other.id, ROOT_TITLE);
  return {
    favorites: await findOrCreateFolder(root.id, 'Favorites'),
    pinned: await findOrCreateFolder(root.id, 'Pinned'),
  };
}

async function findOrCreateFolder(parentId, title) {
  const children = await chrome.bookmarks.getChildren(parentId);
  return children.find(child => !child.url && child.title === title) ?? chrome.bookmarks.create({ parentId, title });
}

export async function getBookmarkTrees() {
  const { favorites, pinned } = await getFolders();
  const [[favoritesTree], [pinnedTree]] = await Promise.all([
    chrome.bookmarks.getSubTree(favorites.id),
    chrome.bookmarks.getSubTree(pinned.id),
  ]);
  return { favorites: favoritesTree, pinned: pinnedTree };
}

const bookmarksIn = node => node.url ? [node] : (node.children ?? []).flatMap(bookmarksIn);

export async function getLinks() {
  const { links } = await chrome.storage.session.get('links');
  return links ?? rebuildLinks();
}

export const setLinks = links => chrome.storage.session.set({ links });

// Tab ids change when Chrome restarts and session storage is cleared, so links are rebuilt by matching URLs.
async function rebuildLinks() {
  const { favorites, pinned } = await getBookmarkTrees();
  const tabs = await chrome.tabs.query({});
  const links = {};
  for (const bookmark of [...bookmarksIn(favorites), ...bookmarksIn(pinned)]) {
    const tab = tabs.find(t => tabUrl(t) === bookmark.url && !Object.values(links).includes(t.id));
    if (tab) links[bookmark.id] = tab.id;
  }
  await setLinks(links);
  return links;
}

export async function openBookmark(bookmark, windowId) {
  const tabId = (await getLinks())[bookmark.id];
  const tab = tabId && await chrome.tabs.get(tabId).catch(() => null);
  if (tab) {
    if (tab.windowId !== windowId) await chrome.tabs.move(tab.id, { windowId, index: -1 });
    await chrome.tabs.update(tab.id, { active: true });
    return;
  }
  const created = await chrome.tabs.create({ windowId, url: bookmark.url });
  await setLinks({ ...await getLinks(), [bookmark.id]: created.id });
}

export async function pinTab(tab, parentId, index) {
  const bookmark = await chrome.bookmarks.create({ parentId, index, title: tab.title, url: tabUrl(tab) });
  await setLinks({ ...await getLinks(), [bookmark.id]: tab.id });
}

export async function unpin(bookmarkId) {
  const links = await getLinks();
  delete links[bookmarkId];
  await setLinks(links);
  await chrome.bookmarks.remove(bookmarkId);
}
