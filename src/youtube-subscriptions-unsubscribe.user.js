// ==UserScript==
// @name         YouTube Subscriptions: Unsubscribe in Video Menu
// @namespace    youtube-subscriptions-unsubscribe
// @version      1.0.2
// @description  Add Unsubscribe to video menus in the subscriptions feed, using YouTube's own confirmation dialog.
// @homepageURL  https://github.com/ysm-dev/violentmonkey-scripts
// @downloadURL  https://raw.githubusercontent.com/ysm-dev/violentmonkey-scripts/main/src/youtube-subscriptions-unsubscribe.user.js
// @updateURL    https://raw.githubusercontent.com/ysm-dev/violentmonkey-scripts/main/src/youtube-subscriptions-unsubscribe.user.js
// @match        https://www.youtube.com/*
// @grant        none
// @inject-into  page
// @run-at       document-start
// @noframes
// @license      MIT
// ==/UserScript==

(() => {
  'use strict';

  // Match all YouTube pages so client-side navigation into Subscriptions works.
  // Only the activated card is inspected; no polling or whole-page observer.
  const installed = Symbol.for('youtube-subscriptions-unsubscribe');
  if (window[installed]) return;
  window[installed] = true;

  const additions = new Map();
  const validChannelId = (id) => typeof id === 'string' && /^UC[\w-]{22}$/.test(id);
  const commandOf = (model) => model?.rendererContext?.commandContext?.onTap?.innertubeCommand;
  const textOf = (text) => text?.simpleText || text?.runs?.map((run) => run.text).join('') || '';

  function channelOf(metadata) {
    const text = metadata?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text;
    const name = text?.content;
    if (!name) return null;

    const direct = text.commandRuns?.map((run) => run.onTap?.innertubeCommand?.browseEndpoint?.browseId)
      .find(validChannelId);
    const avatar = commandOf(metadata.image?.decoratedAvatarViewModel)?.browseEndpoint?.browseId;
    if (validChannelId(direct || avatar)) return { id: direct || avatar, name };

    // Collaboration cards expose their primary publisher in the first row of
    // the collaborator dialog. Never pick an arbitrary nested channel endpoint.
    const collaborators = commandOf(metadata.image?.avatarStackViewModel)
      ?.showDialogCommand?.panelLoadingStrategy?.inlineContent?.dialogViewModel
      ?.customContent?.listViewModel?.listItems;
    const primary = collaborators?.[0]?.listItemViewModel;
    const id = commandOf(primary)?.browseEndpoint?.browseId;
    if (validChannelId(id) && primary.title?.content === name) return { id, name };
    return null;
  }

  function menuContext(button) {
    const card = button.closest('ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer');
    if (!card) return null;
    const data = card.data;
    const lockup = data?.content?.lockupViewModel;
    if (lockup) {
      if (lockup.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO' || !button.closest('yt-lockup-metadata-view-model')) return null;
      const metadata = lockup.metadata?.lockupMetadataViewModel;
      const menu = metadata?.menuButton?.buttonViewModel;
      if (menu?.iconName !== 'MORE_VERT') return null;
      const command = menu.onTap?.innertubeCommand;
      const items = command?.showSheetCommand?.panelLoadingStrategy?.inlineContent
        ?.sheetViewModel?.content?.listViewModel?.listItems;
      return { items, channel: channelOf(metadata), modern: true };
    }

    // Older/list-layout renderers use menuServiceItemRenderer instead.
    if (!button.closest('ytd-menu-renderer')) return null;
    const video = data?.content?.videoRenderer || data?.content?.gridVideoRenderer || data;
    const byline = video?.ownerText || video?.shortBylineText || video?.longBylineText;
    const owner = byline?.runs?.find((run) => validChannelId(run.navigationEndpoint?.browseEndpoint?.browseId));
    return {
      items: video?.menu?.menuRenderer?.items,
      channel: owner ? { id: owner.navigationEndpoint.browseEndpoint.browseId, name: owner.text } : null,
      modern: false,
    };
  }

  function labels() {
    const language = window.ytcfg?.get('HL') || document.documentElement.lang || 'en';
    return /^ko(?:-|$)/i.test(language)
      ? { unsubscribe: '구독 취소', cancel: '취소', question: (name) => `${name} 채널 구독을 취소하시겠습니까?` }
      : { unsubscribe: 'Unsubscribe', cancel: 'Cancel', question: (name) => `Unsubscribe from ${name}?` };
  }

  function confirmation(channel, label) {
    return {
      signalServiceEndpoint: {
        signal: 'CLIENT_SIGNAL',
        actions: [{
          openPopupAction: {
            popupType: 'DIALOG',
            popup: {
              confirmDialogRenderer: {
                dialogMessages: [{ runs: [{ text: label.question(channel.name) }] }],
                confirmButton: {
                  buttonRenderer: {
                    style: 'STYLE_BLUE_TEXT',
                    size: 'SIZE_DEFAULT',
                    text: { runs: [{ text: label.unsubscribe }] },
                    serviceEndpoint: {
                      commandMetadata: { webCommandMetadata: { sendPost: true, apiUrl: '/youtubei/v1/subscription/unsubscribe' } },
                      unsubscribeEndpoint: { channelIds: [channel.id] },
                    },
                  },
                },
                cancelButton: {
                  buttonRenderer: {
                    style: 'STYLE_TEXT',
                    size: 'SIZE_DEFAULT',
                    text: { runs: [{ text: label.cancel }] },
                  },
                },
              },
            },
          },
        }],
      },
    };
  }

  function removeAddition(items) {
    const entry = additions.get(items);
    if (!entry) return;
    const index = items.indexOf(entry);
    if (index !== -1) items.splice(index, 1);
    additions.delete(items);
  }

  // Run before YouTube's target/bubbling click handlers read the menu data.
  // Keyboard activation of a button also generates a click.
  window.addEventListener('click', (event) => {
    const target = event.composedPath().find((node) => node instanceof Element);
    const button = target?.closest('button, yt-icon-button, [role="button"]');
    if (!button) return;
    try {
      const context = menuContext(button);
      if (!Array.isArray(context?.items)) return;
      const { items, channel, modern } = context;
      removeAddition(items);
      if (location.pathname.replace(/\/$/, '') !== '/feed/subscriptions' || !window.ytcfg?.get('LOGGED_IN') || !channel) return;

      const label = labels();
      // Leave a future native Unsubscribe entry alone.
      if (items.some((item) => {
        const title = item.listItemViewModel?.title?.content || textOf(item.menuServiceItemRenderer?.text);
        return title === label.unsubscribe || title === 'Unsubscribe' || title === '구독 취소';
      })) return;

      const command = confirmation(channel, label);
      const entry = modern ? {
        listItemViewModel: {
          title: { content: label.unsubscribe },
          leadingImage: { sources: [{ clientResource: { imageName: 'PERSON_MINUS' } }] },
          rendererContext: { commandContext: { onTap: { innertubeCommand: command } } },
        },
      } : {
        menuServiceItemRenderer: {
          text: { runs: [{ text: label.unsubscribe }] },
          icon: { iconType: 'UNSUBSCRIBE' },
          serviceEndpoint: command,
        },
      };
      items.push(entry);
      additions.set(items, entry);
    } catch (error) {
      // An unfamiliar renderer must not interfere with YouTube's original menu.
      console.warn('[YouTube subscriptions unsubscribe] Could not extend menu:', error);
    }
  }, true);

  document.addEventListener('yt-navigate-start', () => {
    for (const items of additions.keys()) removeAddition(items);
  });
})();
