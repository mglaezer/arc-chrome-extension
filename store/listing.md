# Chrome Web Store listing

Paste each section into the matching field of the developer dashboard.

## Store listing

**Category:** Productivity → Workflow & Planning

**Language:** English

**Summary** (max 132 characters):

Arc-style sidebar: favorites, pinned folders of bookmarks that open as tabs, and a Today list that archives idle tabs.

**Description:**

A sidebar in Chrome's side panel that treats bookmarks as tabs.

Favorites: a row of icons for the sites you use every day. Click one to open it, or switch to it if it is already open.

Pinned: folders of bookmarks. A pinned entry opens as a tab, and clicking it again focuses that tab instead of opening a duplicate. If you navigate away, ↩ takes the tab back to the pinned URL. Closing the tab keeps the bookmark. Entries without an open tab are shown dimmed.

Today: your other open tabs. Tabs you haven't used for 12 hours (configurable) move to Archive, where one click reopens them.

Drag tabs into Pinned or Favorites to keep them, or drag a pinned entry onto Today to unpin it. Cmd/Ctrl+Z undoes closing, unpinning and deleting folders.

Pinned items are stored as normal Chrome bookmarks under Other bookmarks → Arc, so they sync when Chrome sync is on and stay if you remove the extension.

Shortcuts: Alt+S opens and closes the sidebar, Alt+Shift+P pins or unpins the current tab.

**Screenshot:** screenshot-1280x800.png

**Icon:** extension/icons/icon128.png

## Privacy practices

**Single purpose:**

Show the user's tabs and bookmarks in a side panel, where bookmarks open and focus tabs.

**Permission justifications:**

- sidePanel: the whole interface is a side panel.
- tabs: list open tabs with titles and URLs, focus, open, close, and move tabs from the sidebar.
- bookmarks: Favorites and Pinned are bookmark folders that the sidebar reads, creates, moves, and deletes.
- storage: remember which tab belongs to which bookmark, folder collapse state, archive settings, and the archive list.
- alarms: check every 10 minutes for idle tabs to archive.
- favicon: show site icons next to tabs and bookmarks.
- sessions: undo closing a tab by restoring it from recently closed tabs.

**Remote code:** No, I am not using remote code.

**Data usage:** check none of the data types. Tab and bookmark data is read and stored only on this device, never sent anywhere. Then tick all three certifications.

## Distribution

**Visibility:** Unlisted (only people with the link can install it).
