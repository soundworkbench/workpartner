/* AionUi 2.1.47 native settings adapter, inserted into its entry module by rebrand.py. */
(function (config, selectTheme, changeLanguage, i18n, themeReady, languageReady) {
  var ready = Promise.all([themeReady, languageReady, config.whenReady()]);
  window.wpSettings = {
    ready: ready,
    get: function () {
      return { theme: config.get('theme.activeId') || 'light', language: i18n.language };
    },
    subscribe: function (notify) {
      i18n.on('languageChanged', notify);
      var unsubscribe = config.subscribe('theme.activeId', notify);
      return function () { i18n.off('languageChanged', notify); unsubscribe(); };
    },
    set: async function (kind, value) {
      await ready;
      if (kind === 'theme' && ['system', 'light', 'dark'].indexOf(value) >= 0) return selectTheme(value);
      if (kind === 'language' && ['zh-CN', 'en-US'].indexOf(value) >= 0) return changeLanguage(value);
      throw new Error('Unsupported WorkPartner setting');
    }
  };
  window.dispatchEvent(new Event('wp-settings-ready'));
})
