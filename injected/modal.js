// vsc-search: Injected modal script
// Runs in VS Code's Renderer process after workbench.html patch
// Communicates with the Extension Host via WebSocket (with DOM nonce verification)
(function () {
  "use strict";

  console.log("[vsc-search] modal.js loaded");

  // ---------------------------------------------------------------------------
  // State (closure variables — session-scoped)
  // ---------------------------------------------------------------------------
  var ws = null;
  var connected = false;
  var rpcId = 0;
  var rpcCallbacks = {};
  var windowId = null;
  var state = {
    query: "",
    directory: "",
    caseSensitive: false,
    wholeWord: false,
    useRegex: false,
    results: [],
    selectedIndex: 0,
    fileCount: 0,
    totalHits: 0,
    previewCache: {},
    searchRequestId: 0,
  };

  var els = {};
  var searchTimer = null;
  var DEBOUNCE_MS = 300;
  var PREVIEW_CTX = 8;

  // ---------------------------------------------------------------------------
  // Trusted Types safe DOM helpers
  // ---------------------------------------------------------------------------

  function clearChildren(el) {
    while (el.firstChild) {
      el.removeChild(el.firstChild);
    }
  }

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (k === "className") {
          el.className = attrs[k];
        } else if (k.indexOf("on") === 0) {
          el.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        } else {
          el.setAttribute(k, attrs[k]);
        }
      }
    }
    if (children != null) {
      if (typeof children === "string") {
        el.textContent = children;
      } else if (Array.isArray(children)) {
        for (var i = 0; i < children.length; i++) {
          if (children[i]) {
            el.appendChild(
              typeof children[i] === "string"
                ? document.createTextNode(children[i])
                : children[i]
            );
          }
        }
      } else {
        el.appendChild(children);
      }
    }
    return el;
  }

  // ---------------------------------------------------------------------------
  // Window ID discovery
  // ---------------------------------------------------------------------------

  function getWindowId() {
    try {
      if (window.vscode && window.vscode.context && window.vscode.context.configuration) {
        var config = window.vscode.context.configuration();
        if (config && config.windowId != null) {
          return config.windowId;
        }
      }
    } catch (e) {
      console.warn("[vsc-search] Failed to get windowId:", e);
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // DOM nonce verification
  // ---------------------------------------------------------------------------

  function findNonceInDom(nonce) {
    var searchText = "vsc-s:" + nonce;

    // Strategy 1: querySelector for status bar items
    var items = document.querySelectorAll(
      ".statusbar-item, .statusbar-entry, [class*='statusbar']"
    );
    for (var i = 0; i < items.length; i++) {
      var text = items[i].textContent || "";
      if (text.indexOf(searchText) >= 0) {
        return true;
      }
    }

    // Strategy 2: broader search in status bar footer
    var footer = document.querySelector(
      ".part.statusbar, #workbench\\.parts\\.statusbar, footer"
    );
    if (footer) {
      var fullText = footer.textContent || "";
      if (fullText.indexOf(searchText) >= 0) {
        return true;
      }
    }

    return false;
  }

  // ---------------------------------------------------------------------------
  // WebSocket Connection with DOM Verification
  // ---------------------------------------------------------------------------

  function tryConnect() {
    windowId = getWindowId();
    console.log("[vsc-search] windowId =", windowId);

    // Try fast-path first (reconnection via bridge-w{id}.json)
    if (windowId != null) {
      tryFastPath();
    } else {
      // windowId not yet available, wait and retry
      setTimeout(tryConnect, 1000);
    }
  }

  function tryFastPath() {
    fetch("vsc-search/bridge-w" + windowId + ".json")
      .then(function (resp) {
        if (!resp.ok) throw new Error("not found");
        return resp.json();
      })
      .then(function (data) {
        if (data && data.port) {
          console.log("[vsc-search] Fast path: port " + data.port);
          connectWebSocket(data.port, true);
        } else {
          fullScan();
        }
      })
      .catch(function () {
        fullScan();
      });
  }

  function fullScan() {
    fetchBridgesJson(0);
  }

  function fetchBridgesJson(attempt) {
    var maxAttempts = 15; // 30 seconds total (2s interval)
    fetch("vsc-search/bridges.json")
      .then(function (resp) {
        if (!resp.ok) throw new Error("not found");
        return resp.json();
      })
      .then(function (entries) {
        if (!Array.isArray(entries) || entries.length === 0) {
          throw new Error("empty");
        }
        // Sort by timestamp descending (newest first)
        entries.sort(function (a, b) { return b.timestamp - a.timestamp; });
        tryEntries(entries, 0);
      })
      .catch(function () {
        if (attempt < maxAttempts) {
          setTimeout(function () {
            fetchBridgesJson(attempt + 1);
          }, 2000);
        } else {
          console.error("[vsc-search] bridges.json not available after " + maxAttempts + " attempts");
        }
      });
  }

  function tryEntries(entries, index) {
    if (index >= entries.length) {
      // All entries exhausted, retry from bridges.json
      console.log("[vsc-search] No matching bridge found, retrying in 3s...");
      setTimeout(fullScan, 3000);
      return;
    }

    var entry = entries[index];
    console.log("[vsc-search] Trying port " + entry.port + " (nonce=" + entry.nonce + ")");
    connectAndVerify(entry.port, entry.nonce, function (success) {
      if (!success) {
        tryEntries(entries, index + 1);
      }
    });
  }

  function connectAndVerify(port, expectedNonce, callback) {
    var socket;
    try {
      socket = new WebSocket("ws://127.0.0.1:" + port);
    } catch (e) {
      callback(false);
      return;
    }

    var verified = false;
    var timer = setTimeout(function () {
      if (!verified) {
        socket.close();
        callback(false);
      }
    }, 5000);

    socket.onopen = function () {
      console.log("[vsc-search] WebSocket opened on port " + port);
    };

    socket.onmessage = function (event) {
      var msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg.type === "welcome" && msg.nonce) {
        // Verify nonce exists in this window's DOM
        var found = findNonceInDom(msg.nonce);
        if (found) {
          verified = true;
          clearTimeout(timer);
          console.log("[vsc-search] Nonce verified in DOM: " + msg.nonce);

          // Send verification with windowId
          socket.send(JSON.stringify({
            type: "verified",
            windowId: windowId,
          }));

          // Connection established
          onConnected(socket);
          callback(true);
        } else {
          console.log("[vsc-search] Nonce NOT in DOM: " + msg.nonce + " (wrong window)");
          clearTimeout(timer);
          socket.close();
          callback(false);
        }
      }
    };

    socket.onerror = function () {
      clearTimeout(timer);
      if (!verified) {
        callback(false);
      }
    };

    socket.onclose = function () {
      clearTimeout(timer);
      if (!verified) {
        callback(false);
      }
    };
  }

  function connectWebSocket(port, isReconnect) {
    var socket;
    try {
      socket = new WebSocket("ws://127.0.0.1:" + port);
    } catch (e) {
      if (isReconnect) fullScan();
      return;
    }

    var accepted = false;

    socket.onopen = function () {
      if (isReconnect) {
        socket.send(JSON.stringify({
          type: "reconnect",
          windowId: windowId,
        }));
      }
    };

    socket.onmessage = function (event) {
      var msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg.type === "welcome" && !accepted) {
        accepted = true;
        onConnected(socket);
        return;
      }

      // If already connected, delegate to message handler
      if (connected) {
        handleMessage(msg);
      }
    };

    socket.onerror = function () {
      if (!accepted && isReconnect) {
        fullScan();
      }
    };

    socket.onclose = function () {
      if (accepted) {
        onDisconnected();
      } else if (isReconnect) {
        fullScan();
      }
    };
  }

  function onConnected(socket) {
    ws = socket;
    connected = true;
    console.log("[vsc-search] WebSocket bridge connected");

    if (!els.modal) {
      buildDOM();
    }

    // Set up message handler for future messages
    socket.onmessage = function (event) {
      var msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      handleMessage(msg);
    };

    socket.onclose = function () {
      onDisconnected();
    };
  }

  function onDisconnected() {
    ws = null;
    connected = false;
    rpcCallbacks = {};
    console.warn("[vsc-search] WebSocket disconnected, reconnecting in 1s...");
    setTimeout(function () {
      if (windowId != null) {
        tryFastPath();
      } else {
        fullScan();
      }
    }, 1000);
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case "rpc_result":
        if (rpcCallbacks[msg.id]) {
          rpcCallbacks[msg.id].resolve(msg.result);
          delete rpcCallbacks[msg.id];
        }
        break;
      case "rpc_error":
        if (rpcCallbacks[msg.id]) {
          rpcCallbacks[msg.id].reject(new Error(msg.error));
          delete rpcCallbacks[msg.id];
        }
        break;
      case "notify":
        handleNotification(msg.method, msg.params);
        break;
    }
  }

  function handleNotification(method, params) {
    if (method === "showModal") {
      showModal(params);
    } else if (method === "hideModal") {
      hideModal();
    }
  }

  // ---------------------------------------------------------------------------
  // RPC (Renderer -> Extension Host)
  // ---------------------------------------------------------------------------

  function rpcCall(method, params) {
    if (!connected || !ws) {
      return Promise.reject(new Error("Not connected"));
    }
    var id = ++rpcId;
    return new Promise(function (resolve, reject) {
      rpcCallbacks[id] = { resolve: resolve, reject: reject };
      ws.send(JSON.stringify({
        type: "rpc",
        id: id,
        method: method,
        params: params,
      }));
    });
  }

  // ---------------------------------------------------------------------------
  // Extension Host RPC helpers
  // ---------------------------------------------------------------------------

  function rpcSearch(params) {
    return rpcCall("search", params).catch(function () {
      return { results: [], fileCount: 0, totalHits: 0, searchTimeMs: 0 };
    });
  }

  function rpcGetFileContent(filePath) {
    return rpcCall("getFileContent", { filePath: filePath }).catch(function () {
      return { content: "", languageId: "plaintext" };
    });
  }

  function rpcOpenFile(filePath, lineNumber, column) {
    return rpcCall("openFile", {
      filePath: filePath,
      lineNumber: lineNumber,
      column: column,
    }).catch(function () {});
  }

  function rpcPickFolder() {
    return rpcCall("pickFolder").catch(function () {
      return null;
    });
  }

  // ---------------------------------------------------------------------------
  // DOM Construction
  // ---------------------------------------------------------------------------

  function buildDOM() {
    els.backdrop = h("div", { className: "vsc-search-backdrop" });
    els.backdrop.addEventListener("click", function () {
      hideModal();
    });

    els.modal = h("div", { className: "vsc-search-modal" });

    // --- Header ---
    els.header = h("div", { className: "vsc-search-header" });

    // Search row
    var searchRow = h("div", { className: "vsc-search-row" });
    searchRow.appendChild(h("span", { className: "vsc-search-icon" }, "\uD83D\uDD0D"));

    els.searchInput = h("input", {
      className: "vsc-search-input",
      type: "text",
      placeholder: "\u691C\u7D22...",
      spellcheck: "false",
      autocomplete: "off",
    });
    els.searchInput.addEventListener("input", onSearchInput);
    els.searchInput.addEventListener("keydown", onKeyDown);
    searchRow.appendChild(els.searchInput);

    els.toggleCc = createToggle("Cc", "\u5927\u6587\u5B57/\u5C0F\u6587\u5B57\u3092\u533A\u5225", function () {
      state.caseSensitive = !state.caseSensitive;
      els.toggleCc.classList.toggle("active", state.caseSensitive);
      triggerSearch();
    });
    searchRow.appendChild(els.toggleCc);

    els.toggleW = createToggle("W", "\u5358\u8A9E\u5358\u4F4D\u3067\u30DE\u30C3\u30C1", function () {
      state.wholeWord = !state.wholeWord;
      els.toggleW.classList.toggle("active", state.wholeWord);
      triggerSearch();
    });
    searchRow.appendChild(els.toggleW);

    els.toggleRx = createToggle(".*", "\u6B63\u898F\u8868\u73FE\u3092\u4F7F\u7528", function () {
      state.useRegex = !state.useRegex;
      els.toggleRx.classList.toggle("active", state.useRegex);
      triggerSearch();
    });
    searchRow.appendChild(els.toggleRx);

    els.header.appendChild(searchRow);

    // Directory row
    var dirRow = h("div", { className: "vsc-search-row" });
    dirRow.appendChild(h("span", { className: "vsc-search-icon" }, "\uD83D\uDCC1"));

    els.dirInput = h("input", {
      className: "vsc-search-input vsc-search-input--dir",
      type: "text",
      placeholder: "\u30C7\u30A3\u30EC\u30AF\u30C8\u30EA...",
      spellcheck: "false",
      autocomplete: "off",
    });
    els.dirInput.addEventListener("input", function () {
      state.directory = els.dirInput.value;
      triggerSearch();
    });
    els.dirInput.addEventListener("keydown", onKeyDown);
    dirRow.appendChild(els.dirInput);

    els.folderBtn = h("button", {
      className: "vsc-search-folder-btn",
      title: "\u30D5\u30A9\u30EB\u30C0\u3092\u9078\u629E",
    }, "\uD83D\uDCC2");
    els.folderBtn.addEventListener("click", function () {
      rpcPickFolder().then(function (folder) {
        if (folder) {
          state.directory = folder;
          els.dirInput.value = folder;
          triggerSearch();
        }
      });
    });
    dirRow.appendChild(els.folderBtn);

    els.hitCount = h("span", { className: "vsc-search-hit-count" });
    dirRow.appendChild(els.hitCount);

    els.header.appendChild(dirRow);
    els.modal.appendChild(els.header);

    // --- Results list ---
    els.resultsList = h("div", { className: "vsc-search-results" });
    els.modal.appendChild(els.resultsList);

    // --- Preview ---
    els.previewHeader = h("div", { className: "vsc-search-preview-header" });
    els.previewBody = h("div", { className: "vsc-search-preview-body" });
    els.modal.appendChild(els.previewHeader);
    els.modal.appendChild(els.previewBody);

    // --- Footer ---
    els.footer = h("div", { className: "vsc-search-footer" }, [
      h("span", null, "\u2191\u2193 \u79FB\u52D5\u3000Enter \u958B\u304F\u3000Esc \u9589\u3058\u308B"),
      h("span", null, "\u30C0\u30D6\u30EB\u30AF\u30EA\u30C3\u30AF\u3067\u30A8\u30C7\u30A3\u30BF\u306B\u5C55\u958B"),
    ]);
    els.modal.appendChild(els.footer);

    document.body.appendChild(els.backdrop);
    document.body.appendChild(els.modal);

    console.log("[vsc-search] DOM built");
  }

  function createToggle(label, title, onClick) {
    var btn = h("button", { className: "vsc-search-toggle", title: title }, label);
    btn.addEventListener("click", onClick);
    return btn;
  }

  // ---------------------------------------------------------------------------
  // Show / Hide
  // ---------------------------------------------------------------------------

  function showModal(args) {
    if (!els.modal) return;

    if (args && args.directory != null) {
      state.directory = args.directory;
      els.dirInput.value = args.directory;
    }

    els.backdrop.style.display = "block";
    els.modal.style.display = "flex";

    els.searchInput.value = state.query;
    els.dirInput.value = state.directory;

    els.toggleCc.classList.toggle("active", state.caseSensitive);
    els.toggleW.classList.toggle("active", state.wholeWord);
    els.toggleRx.classList.toggle("active", state.useRegex);

    setTimeout(function () {
      els.searchInput.focus();
      els.searchInput.select();
    }, 0);

    if (state.results.length > 0) {
      renderResults();
      loadPreview();
    } else if (state.query) {
      triggerSearch();
    }
  }

  function hideModal() {
    if (!els.modal) return;
    els.backdrop.style.display = "none";
    els.modal.style.display = "none";
  }

  function isModalVisible() {
    return els.modal && els.modal.style.display === "flex";
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  function onSearchInput() {
    state.query = els.searchInput.value;
    triggerSearch();
  }

  function triggerSearch() {
    if (searchTimer) {
      clearTimeout(searchTimer);
    }
    searchTimer = setTimeout(doSearch, DEBOUNCE_MS);
  }

  function doSearch() {
    var query = state.query;
    if (!query) {
      state.results = [];
      state.selectedIndex = 0;
      state.fileCount = 0;
      state.totalHits = 0;
      renderResults();
      renderPreviewEmpty();
      updateHitCount();
      return;
    }

    var requestId = ++state.searchRequestId;

    rpcSearch({
      query: query,
      directory: state.directory,
      caseSensitive: state.caseSensitive,
      wholeWord: state.wholeWord,
      useRegex: state.useRegex,
    }).then(function (response) {
      if (requestId !== state.searchRequestId) return;

      state.results = response.results || [];
      state.fileCount = response.fileCount || 0;
      state.totalHits = response.totalHits || 0;
      state.selectedIndex = 0;
      state.previewCache = {};

      renderResults();
      updateHitCount();

      if (state.results.length > 0) {
        loadPreview();
      } else {
        renderPreviewEmpty();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Results rendering (no innerHTML — Trusted Types safe)
  // ---------------------------------------------------------------------------

  function renderResults() {
    var container = els.resultsList;
    clearChildren(container);

    if (state.results.length === 0) {
      if (state.query) {
        container.appendChild(
          h("div", { className: "vsc-search-empty" }, "\u4E00\u81F4\u3059\u308B\u7D50\u679C\u304C\u3042\u308A\u307E\u305B\u3093")
        );
      }
      return;
    }

    for (var i = 0; i < state.results.length; i++) {
      (function (idx) {
        var r = state.results[idx];
        var row = h("div", {
          className: "vsc-search-result-row" + (idx === state.selectedIndex ? " selected" : ""),
        });
        row.setAttribute("data-ri", idx);

        var content = h("div", { className: "vsc-search-result-content" });
        var highlighted = highlightText(
          r.lineContent.trim(),
          state.query,
          state.caseSensitive,
          state.wholeWord,
          state.useRegex
        );
        for (var j = 0; j < highlighted.length; j++) {
          content.appendChild(highlighted[j]);
        }
        row.appendChild(content);

        var location = h(
          "div",
          { className: "vsc-search-result-location" },
          r.fileName + ":" + r.lineNumber
        );
        row.appendChild(location);

        row.addEventListener("click", function () {
          selectResult(idx);
        });
        row.addEventListener("dblclick", function () {
          openSelected();
        });

        container.appendChild(row);
      })(i);
    }

    scrollToSelected();
  }

  function updateHitCount() {
    if (state.totalHits > 0) {
      els.hitCount.textContent =
        state.totalHits + "\u4EF6 / " + state.fileCount + "\u30D5\u30A1\u30A4\u30EB";
    } else {
      els.hitCount.textContent = "";
    }
  }

  function selectResult(index) {
    if (index < 0 || index >= state.results.length) return;
    state.selectedIndex = index;
    renderResults();
    loadPreview();
  }

  function scrollToSelected() {
    var container = els.resultsList;
    var active = container.querySelector('[data-ri="' + state.selectedIndex + '"]');
    if (active) {
      active.scrollIntoView({ block: "nearest", behavior: "auto" });
    }
  }

  function openSelected() {
    var cur = state.results[state.selectedIndex];
    if (!cur) return;
    rpcOpenFile(cur.filePath, cur.lineNumber, cur.column);
    hideModal();
  }

  // ---------------------------------------------------------------------------
  // Text highlighting
  // ---------------------------------------------------------------------------

  function buildPattern(query, caseSensitive, wholeWord, useRegex) {
    try {
      if (useRegex) {
        return new RegExp("(" + query + ")", caseSensitive ? "g" : "gi");
      }
      var escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      var expr = wholeWord ? "\\b(" + escaped + ")\\b" : "(" + escaped + ")";
      return new RegExp(expr, caseSensitive ? "g" : "gi");
    } catch (e) {
      return null;
    }
  }

  function highlightText(text, query, caseSensitive, wholeWord, useRegex) {
    var spans = [];
    if (!query) {
      spans.push(document.createTextNode(text));
      return spans;
    }
    var pattern = buildPattern(query, caseSensitive, wholeWord, useRegex);
    if (!pattern) {
      spans.push(document.createTextNode(text));
      return spans;
    }
    var parts = text.split(pattern);
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (!part) continue;
      pattern.lastIndex = 0;
      if (pattern.test(part)) {
        spans.push(h("span", { className: "vsc-search-highlight" }, part));
      } else {
        spans.push(document.createTextNode(part));
      }
    }
    return spans;
  }

  function splitHighlightParts(text, query, caseSensitive, wholeWord, useRegex) {
    var parts = [];
    if (!query) {
      parts.push({ text: text, highlight: false });
      return parts;
    }
    var pattern = buildPattern(query, caseSensitive, wholeWord, useRegex);
    if (!pattern) {
      parts.push({ text: text, highlight: false });
      return parts;
    }
    var segments = text.split(pattern);
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      if (!seg) continue;
      pattern.lastIndex = 0;
      parts.push({ text: seg, highlight: pattern.test(seg) });
    }
    return parts;
  }

  // ---------------------------------------------------------------------------
  // Preview (no innerHTML — Trusted Types safe)
  // ---------------------------------------------------------------------------

  function loadPreview() {
    var cur = state.results[state.selectedIndex];
    if (!cur) {
      renderPreviewEmpty();
      return;
    }
    if (state.previewCache[cur.filePath]) {
      renderPreview(cur, state.previewCache[cur.filePath]);
      return;
    }
    rpcGetFileContent(cur.filePath)
      .then(function (fc) {
        state.previewCache[cur.filePath] = fc;
        var latest = state.results[state.selectedIndex];
        if (latest && latest.filePath === cur.filePath) {
          renderPreview(cur, fc);
        }
      })
      .catch(function () {
        renderPreviewEmpty();
      });
  }

  function renderPreviewEmpty() {
    els.previewHeader.textContent = "";
    els.previewHeader.style.display = "none";
    clearChildren(els.previewBody);
    els.previewBody.style.display = "none";
  }

  function appendSyntaxTokens(parent, text, langId) {
    var tokenize =
      window.__vscSearchHighlighter && window.__vscSearchHighlighter.tokenize
        ? window.__vscSearchHighlighter.tokenize
        : null;
    if (tokenize) {
      var tokens = tokenize(text, langId);
      for (var i = 0; i < tokens.length; i++) {
        if (tokens[i].color) {
          var span = document.createElement("span");
          span.style.color = tokens[i].color;
          span.textContent = tokens[i].text;
          parent.appendChild(span);
        } else {
          parent.appendChild(document.createTextNode(tokens[i].text));
        }
      }
    } else {
      parent.appendChild(document.createTextNode(text));
    }
  }

  function renderPreview(result, fileContent) {
    els.previewHeader.style.display = "";
    els.previewBody.style.display = "";
    els.previewHeader.textContent = result.filePath;

    var lines = fileContent.content.split("\n");
    var langId = fileContent.languageId || "plaintext";
    var lineNum = result.lineNumber;

    var startLine = Math.max(0, lineNum - 1 - PREVIEW_CTX);
    var endLine = Math.min(lines.length, lineNum + PREVIEW_CTX);

    var container = els.previewBody;
    clearChildren(container);

    for (var i = startLine; i < endLine; i++) {
      var ln = i + 1;
      var isMatch = ln === lineNum;
      var lineText = lines[i] || "";

      var lineEl = h("div", {
        className: "vsc-search-preview-line" + (isMatch ? " match" : ""),
      });
      lineEl.setAttribute("data-ln", ln);

      lineEl.appendChild(
        h("div", { className: "vsc-search-preview-linenum" }, String(ln))
      );

      var codeEl = h("pre", { className: "vsc-search-preview-code" });

      if (isMatch) {
        var parts = splitHighlightParts(
          lineText,
          state.query,
          state.caseSensitive,
          state.wholeWord,
          state.useRegex
        );
        for (var j = 0; j < parts.length; j++) {
          if (parts[j].highlight) {
            var mark = document.createElement("span");
            mark.style.background = "rgba(234,170,60,0.3)";
            mark.style.color = "#f0c050";
            mark.style.borderRadius = "2px";
            mark.style.outline = "1px solid rgba(240,192,80,0.5)";
            mark.textContent = parts[j].text;
            codeEl.appendChild(mark);
          } else {
            appendSyntaxTokens(codeEl, parts[j].text, langId);
          }
        }
      } else {
        appendSyntaxTokens(codeEl, lineText, langId);
      }

      lineEl.appendChild(codeEl);
      container.appendChild(lineEl);
    }

    setTimeout(function () {
      var matchEl = container.querySelector('[data-ln="' + lineNum + '"]');
      if (matchEl) {
        matchEl.scrollIntoView({ block: "center", behavior: "auto" });
      }
    }, 0);
  }

  // ---------------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------------

  function onKeyDown(e) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (state.selectedIndex < state.results.length - 1) {
        selectResult(state.selectedIndex + 1);
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (state.selectedIndex > 0) {
        selectResult(state.selectedIndex - 1);
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      openSelected();
    } else if (e.key === "Escape") {
      e.preventDefault();
      hideModal();
    }
  }

  document.addEventListener(
    "keydown",
    function (e) {
      if (!isModalVisible()) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        hideModal();
      }
    },
    true
  );

  // ---------------------------------------------------------------------------
  // Init — connect to Extension Host via WebSocket bridge
  // ---------------------------------------------------------------------------

  // Delay initial connection to allow status bar to render
  setTimeout(tryConnect, 3000);
})();
