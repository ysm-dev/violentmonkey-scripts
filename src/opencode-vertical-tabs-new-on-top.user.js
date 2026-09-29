// ==UserScript==
// @name         OpenCode: New Sessions on Top in Vertical Tabs
// @namespace    opencode-vertical-tabs-new-on-top
// @version      1.0.1
// @description  Put new OpenCode sessions at the top of the vertical tab sidebar instead of the bottom.
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
  // crypto.randomUUID(), or by a click on the sidebar's New Session button.
  const installed = Symbol.for('opencode-vertical-tabs-new-on-top');
  if (window[installed]) return;
  window[installed] = true;

  const SIDEBAR = '[data-slot="vertical-tabs-sidebar"]';
  const NEW_SESSION = `${SIDEBAR} [data-action="vertical-tabs-new-session"]`;
  const SLOTS = `${SIDEBAR} [data-titlebar-tab-slot]`;
  const SIGNAL_MS = 1000;
  const REVEAL_MS = 5000;

  const nativePush = Array.prototype.push;
  const nativeUnshift = Array.prototype.unshift;
  const apply = Reflect.apply;

  const draftIds = new Map(); // id from crypto.randomUUID() -> expiry
  const clicks = []; // expiry of every New Session click that has not produced a tab yet
  const moved = new Set(); // ids of the drafts placed on top
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
  const slotOf = (id) => slots().find((slot) => keyOf(slot).includes(id));
  const draftKeys = () => new Set(slots().map(keyOf).filter((key) => key.startsWith('draft:')));

  // A push qualifies when a new-session signal is pending for that draft, the vertical
  // sidebar is showing, and the array looks like the tab list.
  function match(list, item) {
    if (item === null || typeof item !== 'object' || item.type !== 'draft') return false;
    const id = item.draftID;
    if (typeof id !== 'string' || id === '' || !Array.isArray(list) || !hasSidebar()) return false;
    // A click alone carries no id, so it only matches a draft that is not on screen yet.
    if (!draftIds.has(id) && !(clicks.length && !slotOf(id))) return false;
    for (let index = 0; index < list.length; index++) {
      const tab = list[index];
      if (tab === null || typeof tab !== 'object' || typeof tab.type !== 'string' || tab.draftID === id) return false;
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
          settle(item.draftID);
        } catch (error) {
          warn('Could not finish moving the new tab:', error);
        }
        return length;
      }
    }
    return apply(nativePush, this, arguments);
  }

  function settle(id) {
    draftIds.delete(id);
    clicks.shift();
    moved.add(id);
    if (moved.size > 50) moved.delete(moved.values().next().value);
    schedule();
    reveal(id);
  }

  // The tab may render later than the store changes, and the list may be scrolled away from it.
  function reveal(id) {
    const deadline = performance.now() + REVEAL_MS;
    const check = () => {
      try {
        const slot = slotOf(id);
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
      before = draftKeys();
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
    // A draft appeared while watching but was not moved, so OpenCode probably changed.
    try {
      for (const key of draftKeys()) {
        if (before.has(key) || Array.from(moved).some((id) => key.includes(id))) continue;
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
    const next = Math.min(draftIds.values().next().value ?? Infinity, clicks[0] ?? Infinity);
    if (next === Infinity) disarm();
    else timer = setTimeout(expire, Math.max(0, next - performance.now()));
  }

  function expire() {
    timer = 0;
    const limit = performance.now() + 1;
    for (const [id, until] of draftIds) if (until <= limit) draftIds.delete(id);
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

  // Capture phase, so the signal exists before the app's own click handler creates the draft.
  window.addEventListener('click', (event) => {
    try {
      if (event.target instanceof Element && event.target.closest(NEW_SESSION)) track();
    } catch (error) {
      warn('Could not watch the New Session button:', error);
    }
  }, true);
})();
