// vsc-search: Bootstrap hook for MonacoBootstrapWindow
// Must load BEFORE modal.js — intercepts the AMD loader setup
// to capture `require` and ensure workbench modules are available.
'use strict';
(function () {
  console.log('[vsc-search] bootstrap.js loaded');

  function patchBootstrapWindow(bootstrapWindow) {
    console.log('[vsc-search] patching MonacoBootstrapWindow.load');

    var originalLoad = bootstrapWindow.load;

    function patchedLoad(modulePaths, resultCallback, options) {
      var prevBeforeLoaderConfig = options.beforeLoaderConfig;

      function beforeLoaderConfig(configuration, loaderConfig) {
        if (!loaderConfig) loaderConfig = configuration;

        // Call previous hook if any
        if (typeof prevBeforeLoaderConfig === 'function') {
          prevBeforeLoaderConfig(configuration, loaderConfig);
        }

        // Capture AMD require globally for modal.js
        if (typeof require === 'function' && typeof require.config === 'function') {
          window.__vscSearchAmdRequire = require;
          console.log('[vsc-search] AMD require captured');
        } else {
          console.warn('[vsc-search] require not available in beforeLoaderConfig');
        }

        // Register a loader plugin that fires after the workbench module loads
        // This ensures all VS Code AMD modules are defined before we use them
        require.define('vsc-search-bridge', {
          load: function (name, req, onload) {
            req([name], function (value) {
              window.__vscSearchWorkbenchReady = true;
              console.log('[vsc-search] workbench loaded, bridge ready');
              onload(value);
            }, function (error) {
              console.error('[vsc-search] workbench load error:', error);
              window.__vscSearchWorkbenchReady = true;
              onload(error);
            });
          }
        });
      }

      options.beforeLoaderConfig = beforeLoaderConfig;

      // Prepend our loader plugin to the workbench module path
      if (modulePaths[0] && modulePaths[0].indexOf('workbench') !== -1) {
        console.log('[vsc-search] wrapping module:', modulePaths[0]);
        modulePaths[0] = 'vsc-search-bridge!' + modulePaths[0];
      }

      return originalLoad(modulePaths, resultCallback, options);
    }

    bootstrapWindow.load = patchedLoad;
  }

  // MonacoBootstrapWindow may or may not exist yet
  if (window.MonacoBootstrapWindow) {
    patchBootstrapWindow(window.MonacoBootstrapWindow);
  } else {
    Object.defineProperty(window, 'MonacoBootstrapWindow', {
      set: function (value) {
        patchBootstrapWindow(value);
        window._vscSearchMonacoBootstrapWindow = value;
      },
      get: function () {
        return window._vscSearchMonacoBootstrapWindow;
      }
    });
    console.log('[vsc-search] waiting for MonacoBootstrapWindow via defineProperty');
  }
})();
