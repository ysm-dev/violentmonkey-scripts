// ==UserScript==
// @name         OpenCode: New Sessions on Top in Vertical Tabs
// @namespace    opencode-vertical-tabs-new-on-top
// @version      1.1.1
// @description  Put new and Home-opened sessions on top of OpenCode's vertical tabs, navigate with Option/Alt+Up/Down, and reserve Cmd+1–9 for browser tabs.
// @homepageURL  https://github.com/ysm-dev/violentmonkey-scripts
// @downloadURL  https://raw.githubusercontent.com/ysm-dev/violentmonkey-scripts/main/src/opencode-vertical-tabs-new-on-top.user.js
// @updateURL    https://raw.githubusercontent.com/ysm-dev/violentmonkey-scripts/main/src/opencode-vertical-tabs-new-on-top.user.js
// @match        https://chris-mini.pug-mohs.ts.net/*
// @grant        none
// @inject-into  page
// @run-at       document-start
// @noframes
// @license      MIT
// ==/UserScript==

(() => {
  'use strict';

  // OpenCode keeps its tabs in a persisted Solid store and appends a new session with
  // `tabs.push(tab)`. Shortcuts, drag and drop and the saved order all follow that array, so
  // the insertion itself is moved to the front instead of reordering the DOM. `push` is only
  // replaced for a moment after a new session is signalled: by its draft id coming out of
  // crypto.randomUUID(), a click on the sidebar's New Session button, or opening a session
  // from Home's Recent Sessions list/search. Session signals carry the clicked session id.
  const installed = Symbol.for('opencode-vertical-tabs-new-on-top');
  if (window[installed]) return;
  window[installed] = true;

  // Run before OpenCode's document-capture handler so Cmd+1–9 stays with the browser.
  window.addEventListener('keydown', (event) => {
    if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    if (!/^[1-9]$/.test(event.key)) return;

    event.stopImmediatePropagation();
    // Do not preventDefault(): the browser should perform its native tab switching.
  }, true);

  const SIDEBAR = '[data-slot="vertical-tabs-sidebar"]';
  const NEW_SESSION = `${SIDEBAR} [data-action="vertical-tabs-new-session"]`;
  const SLOTS = `${SIDEBAR} [data-titlebar-tab-slot]`;
  const HOME_ROW = '[data-component="home-session-row"]';
  const SEARCH_ROW = '[data-component="home-session-search-row"]';
  const SEARCH_INPUT = '[data-component="home-session-search"] input[aria-activedescendant]';
  const SIGNAL_MS = 1000;
  const REVEAL_MS = 5000;

  const nativePush = Array.prototype.push;
  const nativeUnshift = Array.prototype.unshift;
  const apply = Reflect.apply;

  const draftIds = new Map(); // id from crypto.randomUUID() -> expiry
  const sessionIds = new Map(); // id opened from Home -> expiry
  const watchedSessions = new Set(); // session ids to check for missed insertions when disarming
  const clicks = []; // expiry of every New Session click that has not produced a tab yet
  const moved = new Set(); // tab keys placed on top during this watch
  let armed = false;
  let before = new Set();
  let timer = 0;
  let warned = false;

  const warn = (...details) => {
    if (warned) return;
    warned = true;
    console.warn('[OpenCode new sessions on top]', ...details);
  };
  const hasSidebar = () => document.querySelector(SIDEBAR) !== null;
  const slots = () => Array.from(document.querySelectorAll(SLOTS));
  const keyOf = (slot) => slot.getAttribute('data-tab-key') || '';
  const isTabKey = (key, tab) => tab.type === 'draft'
    ? key === `draft:${tab.draftID}`
    : key.startsWith(`${tab.server}\n`) && key.endsWith(`/session/${tab.sessionId}`);
  const slotOf = (tab) => slots().find((slot) => isTabKey(keyOf(slot), tab));
  const tabKeys = () => new Set(slots().map(keyOf));
  const identity = (tab) => tab.type === 'draft' ? `draft:${tab.draftID}` : `${tab.server}\n${tab.sessionId}`;
  const identityOfKey = (key) => key.startsWith('draft:')
    ? key : `${key.split('\n')[0]}\n${key.slice(key.lastIndexOf('/session/') + 9)}`;
  const isTab = (tab) => tab !== null && typeof tab === 'object' && typeof tab.server === 'string'
    && (tab.type === 'draft' ? typeof tab.draftID === 'string' && tab.draftID !== ''
      : tab.type === 'session' && typeof tab.sessionId === 'string' && tab.sessionId !== '');

  // A push qualifies when a signal is pending for that tab, the vertical
  // sidebar is showing, and the array looks like the tab list.
  function match(list, item) {
    if (!isTab(item) || !Array.isArray(list) || !hasSidebar()) return false;
    const now = performance.now();
    if (item.type === 'session') {
      if (!(sessionIds.get(item.sessionId) > now)) return false;
    } else {
      // A click alone carries no id, so it only matches a draft that is not on screen yet.
      if (!(draftIds.get(item.draftID) > now) && !(clicks.some((until) => until > now) && !slotOf(item))) return false;
    }
    for (let index = 0; index < list.length; index++) {
      const tab = list[index];
      if (!isTab(tab) || identity(tab) === identity(item)) return false;
    }
    return true;
  }

  function push(item) {
    if (arguments.length === 1) {
      let hit = false;
      try {
        hit = match(this, item);
      } catch (error) {
        warn('Could not inspect a pushed tab:', error);
      }
      if (hit) {
        const length = apply(nativeUnshift, this, [item]);
        try {
          settle(item);
        } catch (error) {
          warn('Could not finish moving the new tab:', error);
        }
        return length;
      }
    }
    return apply(nativePush, this, arguments);
  }

  function settle(tab) {
    if (tab.type === 'session') sessionIds.delete(tab.sessionId);
    else {
      draftIds.delete(tab.draftID);
      clicks.shift();
    }
    moved.add(identity(tab));
    schedule();
    reveal(tab);
  }

  // The tab may render later than the store changes, and the list may be scrolled away from it.
  function reveal(tab) {
    const deadline = performance.now() + REVEAL_MS;
    const check = () => {
      try {
        const slot = slotOf(tab);
        if (slot) slot.scrollIntoView({ behavior: 'instant', block: 'nearest' });
        else if (performance.now() < deadline) requestAnimationFrame(check);
      } catch (error) {
        warn('Could not scroll the new tab into view:', error);
      }
    };
    requestAnimationFrame(check);
  }

  function arm() {
    if (armed) return true;
    // Never overwrite another script's patch of `push`.
    if (Array.prototype.push !== nativePush && Array.prototype.push !== push) {
      warn('Array.prototype.push was replaced by something else, so new tabs stay at the bottom.');
      return false;
    }
    try {
      // Anything that can fail comes before the patch, so a failure never leaves it behind.
      before = tabKeys();
      moved.clear();
      watchedSessions.clear();
      Array.prototype.push = push;
    } catch (error) {
      warn('Could not watch new tabs:', error);
      return false;
    }
    armed = true;
    return true;
  }

  function disarm() {
    if (!armed) return;
    armed = false;
    try {
      if (Array.prototype.push === push) Array.prototype.push = nativePush;
    } catch (error) {
      warn('Could not restore Array.prototype.push:', error);
    }
    // A signalled tab appeared while watching but was not moved, so OpenCode probably changed.
    try {
      for (const key of tabKeys()) {
        if (before.has(key) || moved.has(identityOfKey(key))) continue;
        if (!key.startsWith('draft:') && !watchedSessions.has(key.slice(key.lastIndexOf('/session/') + 9))) continue;
        warn('A new session tab was not moved to the top; OpenCode may have changed how it adds tabs.');
        break;
      }
    } catch (error) {
      warn('Could not check for a missed tab:', error);
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = 0;
    const next = Math.min(...draftIds.values(), ...sessionIds.values(), clicks[0] ?? Infinity);
    if (next === Infinity) disarm();
    else timer = setTimeout(expire, Math.max(0, next - performance.now()));
  }

  function expire() {
    timer = 0;
    const limit = performance.now() + 1;
    for (const [id, until] of draftIds) if (until <= limit) draftIds.delete(id);
    for (const [id, until] of sessionIds) if (until <= limit) sessionIds.delete(id);
    while (clicks.length && clicks[0] <= limit) clicks.shift();
    schedule();
  }

  function track(id) {
    if (!arm()) return;
    const until = performance.now() + SIGNAL_MS;
    if (id === undefined) clicks.push(until);
    else draftIds.set(id, until);
    schedule();
  }

  function trackSession(row) {
    if (!row || !hasSidebar()) return;
    const id = row.matches(SEARCH_ROW)
      ? row.getAttribute('data-key')?.split(':').pop()
      : row.closest('[data-component="home-session-row-container"]')?.getAttribute('data-session-id');
    if (!id || !arm()) return;
    sessionIds.set(id, performance.now() + SIGNAL_MS);
    watchedSessions.add(id);
    schedule();
  }

  // OpenCode only binds left/right tab cycling, even with a vertical sidebar.
  // Click its existing links so drafts, routing and saved active-tab state use the app's handlers.
  function navigateTab(event) {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    if (!hasSidebar()) return;
    const visible = (element) => element.checkVisibility({ visibilityProperty: true });
    if (Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"], dialog[open]'))
      .some(visible)) return;
    if (document.querySelector(`${SIDEBAR} [data-editing="true"], ${SIDEBAR} [data-dragging="true"]`)) return;

    // Off-screen tabs still count; only unrendered/hidden tabs are skipped.
    const tabs = slots().filter(visible);
    const current = tabs.findIndex((slot) => slot.getAttribute('data-active') === 'true');
    if (current === -1 || tabs.length < 2) return;
    const offset = event.key === 'ArrowUp' ? -1 : 1;
    const next = tabs[(current + offset + tabs.length) % tabs.length];
    const link = next.querySelector('a[data-titlebar-tab-link]');
    if (!link || !visible(link)) return;

    event.preventDefault();
    event.stopPropagation();
    // HTMLElement.click() has detail 0, which OpenCode treats as keyboard activation.
    link.click();
    next.scrollIntoView({ behavior: 'instant', block: 'nearest' });
  }

  const cryptoObject = window.crypto;
  const nativeRandomUUID = cryptoObject?.randomUUID;
  if (typeof nativeRandomUUID === 'function') {
    const randomUUID = function randomUUID() {
      const id = apply(nativeRandomUUID, this, arguments);
      try {
        if (hasSidebar()) track(id);
      } catch (error) {
        warn('Could not track a new session id:', error);
      }
      return id;
    };
    try {
      Object.defineProperty(cryptoObject, 'randomUUID', {
        value: randomUUID,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    } catch (error) {
      warn('Could not watch crypto.randomUUID:', error);
    }
  }

  // Capture phase, so the signal exists before the app's own handlers add the tab.
  window.addEventListener('click', (event) => {
    try {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest(NEW_SESSION)) track();
      trackSession(event.target.closest(`${HOME_ROW}, ${SEARCH_ROW}`));
    } catch (error) {
      warn('Could not watch a session click:', error);
    }
  }, true);

  window.addEventListener('auxclick', (event) => {
    try {
      if (event.button === 1 && event.target instanceof Element) {
        trackSession(event.target.closest(`${HOME_ROW}, ${SEARCH_ROW}`));
      }
    } catch (error) {
      warn('Could not watch a session middle-click:', error);
    }
  }, true);

  window.addEventListener('keydown', (event) => {
    try {
      navigateTab(event);
    } catch (error) {
      warn('Could not navigate vertical tabs:', error);
    }
  }, true);

  window.addEventListener('keydown', (event) => {
    try {
      if (event.key !== 'Enter' || event.isComposing || event.altKey || event.metaKey) return;
      if (!(event.target instanceof Element) || !event.target.matches(SEARCH_INPUT)) return;
      if (event.target.getAttribute('aria-expanded') !== 'true') return;
      const row = document.getElementById(event.target.getAttribute('aria-activedescendant'));
      if (row?.matches(SEARCH_ROW)) trackSession(row);
    } catch (error) {
      warn('Could not watch Home search selection:', error);
    }
  }, true);
})();
