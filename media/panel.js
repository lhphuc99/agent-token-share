// @ts-nocheck — runs inside the webview, not in Node.
(function () {
  var vscode = acquireVsCodeApi();
  var app = document.getElementById("app");
  var state = { accounts: [], screen: "main", shareKey: null, banner: null, pending: {}, usageMap: {}, usageFetching: {} };
  var callId = 0;
  var bannerTimer = null;

  // Toasts auto-hide after 10s; a fresh one cancels any still-pending timer so it
  // doesn't clear a banner shown after it.
  function showBanner(ok, text) {
    if (bannerTimer) clearTimeout(bannerTimer);
    state.banner = { ok: ok, text: text };
    bannerTimer = setTimeout(function () {
      bannerTimer = null;
      state.banner = null;
      if (state.screen === "main") renderMain();
    }, 10000);
  }

  // ---- icons ----------------------------------------------------------------
  function ci(name, cls) {
    var d = window.CODICONS && window.CODICONS[name];
    if (!d) return "";
    var c = cls ? ' class="ci ' + cls + '"' : ' class="ci"';
    return '<svg' + c + ' viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">' + d + "</svg>";
  }

  // ---- messaging ------------------------------------------------------------
  function post(type, data) {
    var msg = { type: type };
    if (data) for (var k in data) msg[k] = data[k];
    vscode.postMessage(msg);
  }

  function call(method, args) {
    return new Promise(function (resolve) {
      var id = ++callId;
      state.pending[id] = resolve;
      post("call", { id: id, method: method, args: args || {} });
    });
  }

  // ---- helpers --------------------------------------------------------------
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function fmt(m) {
    var h = Math.floor(m / 60), mm = m % 60;
    return h > 0 ? h + "h " + (mm < 10 ? "0" : "") + mm + "m" : mm + "m";
  }

  function tier(m) { return m === 0 ? "red" : m <= 60 ? "warn" : "ok"; }

  function mask(s) {
    if (!s) return "";
    if (s.length <= 8) return "•".repeat(s.length);
    return s.slice(0, 4) + "•".repeat(Math.min(s.length - 8, 20)) + s.slice(-4);
  }

  // ---- usage helpers --------------------------------------------------------
  function doFetchUsage(key, callArgs) {
    if (state.usageFetching[key]) return;
    state.usageFetching[key] = true;
    call("fetchUsage", callArgs).then(function (r) {
      delete state.usageFetching[key];
      state.usageMap[key] = r || { error: "No data." };
      if (state.screen === "main") renderMain();
    });
  }

  function fmtReset(resetsInMinutes, resetsInHours) {
    if (resetsInMinutes !== null && resetsInMinutes !== undefined) {
      if (resetsInMinutes <= 0) return "now";
      return fmt(resetsInMinutes);
    }
    if (resetsInHours !== null && resetsInHours !== undefined) {
      var rh = resetsInHours;
      var d = Math.floor(rh / 24), rem = Math.round(rh % 24);
      if (d > 0) return d + "d" + (rem > 0 ? " " + rem + "h" : "");
      return Math.round(rh) + "h";
    }
    return "";
  }

  function usageRow(label, utilization, resetsInMinutes, resetsInHours) {
    var pct = Math.min(100, Math.round(utilization * 100));
    var t = pct >= 100 ? "red" : pct >= 75 ? "warn" : "ok";
    var rs = fmtReset(resetsInMinutes, resetsInHours);
    var resetHtml = rs ? '<span style="display:inline-flex;align-items:center;gap:2px">' + ci("refresh", "ci-xs") + rs + '</span>' : "";
    var h = '<div style="margin-bottom:4px">';
    h += '<div style="display:flex;justify-content:space-between;align-items:center;font-size:10px;margin-bottom:2px">';
    h += '<span style="color:var(--vscode-descriptionForeground)">' + esc(label) + '</span>';
    h += '<span style="display:inline-flex;align-items:center;gap:4px;color:var(--vscode-descriptionForeground);opacity:0.8">';
    h += '<span>' + pct + '%</span>' + resetHtml;
    h += '</span>';
    h += '</div>';
    h += '<div class="meter"><i class="' + t + '" style="width:' + Math.max(2, pct) + '%"></i></div>';
    h += '</div>';
    return h;
  }

  function renderCardUsage(id) {
    if (state.usageFetching[id] && !state.usageMap[id]) {
      return '<div style="font-size:10px;color:var(--vscode-descriptionForeground);margin-bottom:6px;opacity:0.6">Loading usage…</div>';
    }
    var u = state.usageMap[id];
    if (!u) return "";
    if (u.error) {
      return '<div style="font-size:10px;color:var(--vscode-errorForeground);margin-bottom:6px">' + esc(u.error) + "</div>";
    }
    var h = '<div style="margin-bottom:6px">';
    if (u.session) h += usageRow("5-Hour Session", u.session.utilization, u.session.resetsInMinutes, null);
    if (u.weekly) h += usageRow("Weekly", u.weekly.utilization, null, u.weekly.resetsInHours);
    if (u.scoped && u.scoped.length) {
      for (var i = 0; i < u.scoped.length; i++) {
        h += usageRow("Weekly (" + u.scoped[i].label + ")", u.scoped[i].utilization, null, u.scoped[i].resetsInHours);
      }
    }
    h += '</div>';
    return h;
  }

  // ---- render: main screen --------------------------------------------------
  function renderMain() {
    var h = "";

    // banner
    if (state.banner) {
      var bcls = state.banner.ok ? "ok" : "err";
      var bicon = state.banner.ok ? "check" : "error";
      h += '<div class="banner ' + bcls + '">' + ci(bicon) +
        "<span>" + esc(state.banner.text) + "</span>" +
        '<button class="x" data-action="dismissBanner">' + ci("close") + "</button></div>";
    }

    // top actions
    h += '<button class="btn primary block" data-action="exportLogin">' + ci("sparkle") + " Share current login</button>";
    h += '<div class="row3">';
    h += '<button class="btn" data-action="goAdd">' + ci("add") + " Add</button>";
    h += '<button class="btn" data-action="goImport">' + ci("inbox") + " Import</button>";
    h += '<button class="btn" data-action="goKey">' + ci("key") + " Key</button>";
    h += "</div>";
    h += '<button class="btn block ppm-btn" data-action="syncPPM">' + ci("folder-opened") + " Sync from PPM</button>";

    // own login — always on top, so switching back to it is never more than one click away
    h += '<div class="list">';
    h += renderOwnCard("claude");
    h += renderOwnCard("codex");
    h += "</div>";

    h += '<div class="divider"><span>Shared accounts</span></div>';

    // cards
    if (!state.accounts.length) {
      h += '<div class="empty"><strong>No accounts yet</strong><p>Add a token or import a shared one.</p></div>';
    } else {
      h += '<div class="list">';
      for (var i = 0; i < state.accounts.length; i++) {
        h += renderCard(state.accounts[i]);
      }
      h += "</div>";
    }

    app.innerHTML = h;
    state.screen = "main";
    wire();
  }

  function renderCard(a) {
    var sel = a.selected ? " sel" : "";
    var provName = a.kind === "claude" ? "Claude" : "Codex";
    var pill = a.selected ? '<span class="pill">' + ci("check") + " Active</span>" : "";

    var meter = "", exp = "";
    if (a.mins != null) {
      var t = tier(a.mins);
      var w = Math.max(6, Math.min(100, Math.round(a.mins / 480 * 100)));
      if (a.mins === 0) {
        exp = '<div class="exp red">Expired — ask owner for a fresh token</div>';
      } else {
        meter = '<div class="meter"><i class="' + t + '" style="width:' + w + '%"></i></div>';
        exp = '<div class="exp ' + t + '">Expires in ' + fmt(a.mins) + "</div>";
      }
    }

    var switchBtn = a.selected
      ? '<button class="btn" data-action="switch" data-id="' + a.id + '" disabled>' + ci("check") + " Active</button>"
      : '<button class="btn primary" data-action="switch" data-id="' + a.id + '">Switch</button>';
    var whoBtn = (a.selected && a.kind === "claude")
      ? '<button class="btn icon" data-action="whoAmI" title="Who am I?">' + ci("info") + "</button>"
      : "";
    var refreshBtn = (a.kind === "claude")
      ? '<button class="btn icon" data-action="refreshOneUsage" data-id="' + a.id + '" title="Refresh usage">' + ci("refresh") + "</button>"
      : "";
    var cardUsage = a.kind === "claude" ? renderCardUsage(a.id) : "";
    return '<div class="card' + sel + '">' +
      '<div class="top"><span class="chip ' + a.kind + '">' + provName + "</span>" +
      '<span class="nm">' + esc(a.label) + "</span>" + pill + "</div>" +
      meter + exp +
      cardUsage +
      '<div class="btns">' +
      switchBtn +
      '<button class="btn" data-action="goShare" data-id="' + a.id + '">Share</button>' +
      whoBtn +
      refreshBtn +
      '<button class="btn icon" data-action="confirmRemove" data-id="' + a.id + '" title="Remove">' + ci("trash") + "</button>" +
      "</div></div>";
  }

  // The live Keychain/credentials-file login — not a stored account, so no id/expiry/remove,
  // but otherwise the same card shape so it isn't mistaken for a less important entry.
  function renderOwnCard(kind) {
    var ownId = "own:" + kind;
    var active = !state.accounts.some(function (a) { return a.kind === kind && a.selected; });
    var pill = active ? '<span class="pill">' + ci("check") + " Active</span>" : "";
    var switchBtn = active
      ? '<button class="btn" disabled>' + ci("check") + " Active</button>"
      : '<button class="btn primary" data-action="ownLogin" data-kind="' + kind + '">Switch</button>';
    var whoBtn = kind === "claude"
      ? '<button class="btn icon" data-action="whoAmI" data-own="1" title="Who am I?">' + ci("info") + "</button>"
      : "";
    var refreshBtn = kind === "claude"
      ? '<button class="btn icon" data-action="refreshOneUsage" data-id="' + ownId + '" title="Refresh usage">' + ci("refresh") + "</button>"
      : "";
    var cardUsage = kind === "claude" ? renderCardUsage(ownId) : "";
    return '<div class="card' + (active ? " sel" : "") + '">' +
      '<div class="top"><span class="chip ' + kind + '">' + (kind === "claude" ? "Claude" : "Codex") + "</span>" +
      '<span class="nm">Own login</span>' + pill + "</div>" +
      cardUsage +
      '<div class="btns">' +
      switchBtn +
      '<button class="btn" data-action="exportLogin" data-kind="' + kind + '">Share</button>' +
      whoBtn +
      refreshBtn +
      "</div></div>";
  }

  // ---- render: add screen ---------------------------------------------------
  function renderAdd() {
    var h = '<div class="hdr"><button class="btn ghost icon" data-action="goMain">' + ci("arrow-left") + "</button><h2>Add Token</h2></div>";
    h += '<div class="note">' + ci("info") + "<span>Paste a Claude <code>setup-token</code> or an <code>sk-ant-api…</code> API key.</span></div>";
    h += '<div class="fld"><label class="lbl">Token</label>';
    h += '<div class="inwrap"><input type="password" id="addToken" placeholder="sk-ant-oat01-… or sk-ant-api…"><button class="btn ghost icon eye" data-action="toggleVis" data-target="addToken">' + ci("eye-closed") + "</button></div></div>";
    h += '<div class="fld"><label class="lbl">Label <em>(optional)</em></label>';
    h += '<input type="text" id="addLabel" placeholder="e.g. team-shared"></div>';
    h += '<div id="addErr"></div>';
    h += '<div class="actions"><button class="btn" data-action="goMain">Cancel</button>';
    h += '<button class="btn primary" data-action="doAdd">Add</button></div>';
    app.innerHTML = h;
    state.screen = "add";
    wire();
    document.getElementById("addToken").focus();
  }

  // ---- render: import screen ------------------------------------------------
  function renderImport(mode) {
    mode = mode || "paste";
    var h = '<div class="hdr"><button class="btn ghost icon" data-action="goMain">' + ci("arrow-left") + "</button><h2>Import Token</h2></div>";
    h += '<div class="seg">';
    h += '<button data-action="importMode" data-mode="paste"' + (mode === "paste" ? ' class="on"' : "") + ">Paste blob</button>";
    h += '<button data-action="importMode" data-mode="file"' + (mode === "file" ? ' class="on"' : "") + ">Open file</button>";
    h += '<button data-action="importMode" data-mode="ppm"' + (mode === "ppm" ? ' class="on"' : "") + ">PPM backup</button>";
    h += "</div>";

    // CTS1 paste/file panels
    h += '<div id="importPaste" style="' + (mode === "paste" ? "" : "display:none") + '">';
    h += '<div class="fld"><label class="lbl">Encrypted blob</label>';
    h += '<textarea id="importBlob" placeholder="CTS1.…"></textarea></div></div>';
    h += '<div id="importFile" style="' + (mode === "file" ? "" : "display:none") + '">';
    h += '<button class="btn block" data-action="pickFile">' + ci("folder-opened") + " Choose .ctstoken file</button></div>";

    // PPM backup panel
    h += '<div id="importPPM" style="' + (mode === "ppm" ? "" : "display:none") + '">';
    h += '<div class="fld"><label class="lbl">PPM backup blob</label>';
    h += '<textarea id="ppmBlob" placeholder=\'{"version":1,"kdf":"scrypt",…}\'></textarea></div>';
    h += '<div class="fld"><label class="lbl">Backup password</label>';
    h += '<div class="inwrap"><input type="password" id="ppmPassword" placeholder="Leave blank if backup was exported without a password"><button class="btn ghost icon eye" data-action="toggleVis" data-target="ppmPassword">' + ci("eye-closed") + "</button></div></div>";
    h += '<div id="ppmErr"></div>';
    h += '<div class="actions"><button class="btn" data-action="goMain">Cancel</button>';
    h += '<button class="btn primary" data-action="doImportPPM">' + ci("inbox") + " Import from PPM</button></div>";
    h += "</div>";

    // CTS1 fields (shown only for paste/file modes)
    h += '<div id="importCTSFields" style="' + (mode === "ppm" ? "display:none" : "") + '">';
    h += '<div class="fld"><label class="lbl">Share key</label>';
    h += '<div class="inwrap"><input type="password" id="importKey" placeholder="The key the sender gave you"><button class="btn ghost icon eye" data-action="toggleVis" data-target="importKey">' + ci("eye-closed") + "</button></div></div>";
    h += '<div class="fld"><label class="lbl">Label <em>(optional)</em></label>';
    h += '<input type="text" id="importLabel" placeholder="e.g. john-shared"></div>';
    h += '<div id="importErr"></div>';
    h += '<div class="actions"><button class="btn" data-action="goMain">Cancel</button>';
    h += '<button class="btn primary" data-action="doImport">Import &amp; Switch</button></div>';
    h += "</div>";

    app.innerHTML = h;
    state.screen = "import";
    state.importMode = mode;
    wire();
    var focus = mode === "ppm" ? document.getElementById("ppmBlob") : document.getElementById("importBlob");
    if (focus) focus.focus();
    // pre-fill PPM password from stored default
    if (mode === "ppm") {
      call("getPpmPassword").then(function (pw) {
        var el = document.getElementById("ppmPassword");
        if (el && pw) el.value = pw;
      });
    }
  }

  // ---- render: export / share screen ----------------------------------------
  function renderShare(accountId) {
    var acc = null;
    for (var i = 0; i < state.accounts.length; i++) {
      if (state.accounts[i].id === accountId) { acc = state.accounts[i]; break; }
    }
    if (!acc) return renderMain();
    var provName = acc.kind === "claude" ? "Claude" : "Codex";
    var h = '<div class="hdr"><button class="btn ghost icon" data-action="goMain">' + ci("arrow-left") + "</button><h2>Share Token</h2></div>";
    h += '<div class="src"><span class="chip ' + acc.kind + '">' + provName + '</span><span class="nm">' + esc(acc.label) + "</span></div>";
    h += '<div class="fld"><label class="lbl">Share key</label>';
    h += '<div class="inwrap"><input type="password" id="shareKey" placeholder="Enter your share key"><button class="btn ghost icon eye" data-action="toggleVis" data-target="shareKey">' + ci("eye-closed") + "</button></div></div>";
    h += '<div id="shareErr"></div>';
    h += '<div class="actions"><button class="btn" data-action="goMain">Cancel</button>';
    h += '<button class="btn primary" data-action="doShare" data-id="' + acc.id + '">' + ci("copy") + " Encrypt &amp; Copy</button></div>";
    h += '<button class="btn block small" data-action="doShareFile" data-id="' + acc.id + '">' + ci("save") + " Save as .ctstoken file</button>";

    h += '<div class="note">' + ci("warning") + "<span>Send the <strong>blob</strong> and the <strong>key</strong> over separate channels.</span></div>";

    app.innerHTML = h;
    state.screen = "share";
    state.shareAccountId = accountId;
    wire();
    // pre-fill key if we have one
    call("getShareKey").then(function (k) {
      var el = document.getElementById("shareKey");
      if (el && k) el.value = k;
    });
  }

  // ---- render: key management screen ----------------------------------------
  function renderKey() {
    var h = '<div class="hdr"><button class="btn ghost icon" data-action="goMain">' + ci("arrow-left") + "</button><h2>Settings</h2></div>";

    // --- share key ---
    h += '<div class="sec">Share key</div>';
    h += '<div class="note" style="margin-bottom:8px">' + ci("info") + "<span>Encrypts tokens before sharing. Give the same key to recipients over a <strong>separate channel</strong>.</span></div>";
    // masked row — shown only when key exists and not editing
    h += '<div id="keyDisplay" style="display:none">';
    h += '<div class="keyrow"><span class="keyval" id="keyMasked"></span>';
    h += '<button class="btn ghost icon" data-action="toggleKeyVis" title="Show/hide">' + ci("eye-closed") + "</button>";
    h += '<button class="btn ghost icon" data-action="copyKey" title="Copy">' + ci("copy") + "</button>";
    h += '<button class="btn ghost icon" data-action="showKeyInput" title="Change">' + ci("edit") + "</button>";
    h += '<button class="btn ghost icon" data-action="clearShareKey" title="Clear">' + ci("trash") + "</button></div></div>";
    // input form — shown only when no key or editing
    h += '<div id="keyInputWrap" style="display:none">';
    h += '<div class="fld"><div class="inwrap"><input type="password" id="keyInput" placeholder="Enter share key"><button class="btn ghost icon eye" data-action="toggleVis" data-target="keyInput">' + ci("eye-closed") + "</button></div></div>";
    h += '<div id="keyErr"></div>';
    h += '<div class="actions" style="margin-bottom:16px"><button class="btn" data-action="cancelKeyInput">Cancel</button>';
    h += '<button class="btn primary" data-action="doSetKey">Save</button></div></div>';

    // --- ppm backup password ---
    h += '<div class="sec" style="margin-top:8px">PPM backup default password</div>';
    h += '<div class="note" style="margin-bottom:8px">' + ci("info") + "<span>Pre-fills the password field when importing a PPM backup.</span></div>";
    // masked row
    h += '<div id="ppmPwDisplay" style="display:none">';
    h += '<div class="keyrow"><span class="keyval" id="ppmPwMasked"></span>';
    h += '<button class="btn ghost icon" data-action="togglePpmPwVis" title="Show/hide">' + ci("eye-closed") + "</button>";
    h += '<button class="btn ghost icon" data-action="showPpmPwInput" title="Change">' + ci("edit") + "</button>";
    h += '<button class="btn ghost icon" data-action="clearPpmPassword" title="Clear">' + ci("trash") + "</button></div></div>";
    // input form
    h += '<div id="ppmPwInputWrap" style="display:none">';
    h += '<div class="fld"><div class="inwrap"><input type="password" id="ppmPwInput" placeholder="Enter backup password"><button class="btn ghost icon eye" data-action="toggleVis" data-target="ppmPwInput">' + ci("eye-closed") + "</button></div></div>";
    h += '<div id="ppmPwErr"></div>';
    h += '<div class="actions"><button class="btn" data-action="cancelPpmPwInput">Cancel</button>';
    h += '<button class="btn primary" data-action="doSetPpmPassword">Save</button></div></div>';


    app.innerHTML = h;
    state.screen = "key";
    state.keyRevealed = false;
    state.ppmPwRevealed = false;
    wire();

    call("getShareKey").then(function (k) {
      state.currentKey = k || null;
      if (k) {
        document.getElementById("keyDisplay").style.display = "";
        document.getElementById("keyMasked").textContent = mask(k);
      } else {
        document.getElementById("keyInputWrap").style.display = "";
      }
    });

    call("getPpmPassword").then(function (pw) {
      state.currentPpmPw = pw || null;
      if (pw) {
        document.getElementById("ppmPwDisplay").style.display = "";
        document.getElementById("ppmPwMasked").textContent = mask(pw);
      } else {
        document.getElementById("ppmPwInputWrap").style.display = "";
      }
    });
  }

  // ---- render: remove confirmation ------------------------------------------
  function renderRemoveConfirm(accountId) {
    var acc = null;
    for (var i = 0; i < state.accounts.length; i++) {
      if (state.accounts[i].id === accountId) { acc = state.accounts[i]; break; }
    }
    if (!acc) return renderMain();
    var provName = acc.kind === "claude" ? "Claude" : "Codex";

    var h = '<div class="hdr"><button class="btn ghost icon" data-action="goMain">' + ci("arrow-left") + '</button><h2>Remove Account</h2></div>';
    h += '<div class="card confirm"><div class="top"><span class="chip ' + acc.kind + '">' + provName + '</span><span class="nm">' + esc(acc.label) + '</span></div>';
    h += '<p>Remove this account? The token will be deleted from this machine.</p>';
    h += '<div class="btns"><button class="btn" data-action="goMain">Cancel</button>';
    h += '<button class="btn danger" data-action="doRemove" data-id="' + acc.id + '">Remove</button></div></div>';

    app.innerHTML = h;
    state.screen = "removeConfirm";
    wire();
  }

  // ---- actions --------------------------------------------------------------
  var actions = {
    goMain: function () { renderMain(); },
    goAdd: function () { renderAdd(); },
    goImport: function () { renderImport(); },
    goKey: function () { renderKey(); },
    goShare: function (el) { renderShare(el.getAttribute("data-id")); },
    confirmRemove: function (el) { renderRemoveConfirm(el.getAttribute("data-id")); },
    dismissBanner: function () {
      if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = null; }
      state.banner = null;
      renderMain();
    },

    exportLogin: function (el) {
      var kind = el && el.getAttribute("data-kind");
      post("exportLogin", kind ? { kind: kind } : undefined);
    },
    ownLogin: function (el) { post("own", { kind: el.getAttribute("data-kind") }); },

    syncPPM: function () {
      var btn = document.querySelector('[data-action="syncPPM"]');
      if (btn) { btn.disabled = true; btn.textContent = "Syncing…"; }
      call("importFromPPM").then(function (r) {
        if (r && r.error) {
          showBanner(false, "PPM sync failed: " + r.error);
        } else if (r && r.count === 0) {
          showBanner(true, r.total === 0 ? "No accounts found in PPM." : "All PPM accounts already imported.");
        } else {
          showBanner(true, "Imported " + r.count + " account" + (r.count !== 1 ? "s" : "") + " from PPM.");
        }
        renderMain();
      });
    },

    // switch
    switch: function (el) { post("switch", { id: el.getAttribute("data-id") }); },

    // toggle password visibility
    toggleVis: function (el) {
      var tid = el.getAttribute("data-target");
      var input = document.getElementById(tid);
      if (!input) return;
      var show = input.type === "password";
      input.type = show ? "text" : "password";
      el.innerHTML = show ? ci("eye") : ci("eye-closed");
    },

    // --- share key actions ---
    toggleKeyVis: function (el) {
      state.keyRevealed = !state.keyRevealed;
      var display = document.getElementById("keyMasked");
      if (display && state.currentKey) display.textContent = state.keyRevealed ? state.currentKey : mask(state.currentKey);
      el.innerHTML = state.keyRevealed ? ci("eye") : ci("eye-closed");
    },
    showKeyInput: function () {
      document.getElementById("keyDisplay").style.display = "none";
      document.getElementById("keyInputWrap").style.display = "";
      document.getElementById("keyInput").focus();
    },
    cancelKeyInput: function () {
      if (state.currentKey) {
        document.getElementById("keyDisplay").style.display = "";
        document.getElementById("keyInputWrap").style.display = "none";
      } else {
        renderMain();
      }
    },
    clearShareKey: function () {
      call("clearShareKey").then(function () {
        showBanner(true, "Share key cleared.");
        renderKey();
      });
    },
    copyKey: function () {
      if (state.currentKey) {
        call("copyToClipboard", { text: state.currentKey }).then(function () {
          showBanner(true, "Key copied to clipboard.");
          renderKey();
        });
      }
    },

    // --- ppm password actions ---
    togglePpmPwVis: function (el) {
      state.ppmPwRevealed = !state.ppmPwRevealed;
      var display = document.getElementById("ppmPwMasked");
      if (display && state.currentPpmPw) display.textContent = state.ppmPwRevealed ? state.currentPpmPw : mask(state.currentPpmPw);
      el.innerHTML = state.ppmPwRevealed ? ci("eye") : ci("eye-closed");
    },
    showPpmPwInput: function () {
      document.getElementById("ppmPwDisplay").style.display = "none";
      document.getElementById("ppmPwInputWrap").style.display = "";
      document.getElementById("ppmPwInput").focus();
    },
    cancelPpmPwInput: function () {
      if (state.currentPpmPw) {
        document.getElementById("ppmPwDisplay").style.display = "";
        document.getElementById("ppmPwInputWrap").style.display = "none";
      }
    },
    doSetPpmPassword: function () {
      var pw = (document.getElementById("ppmPwInput").value || "").trim();
      if (!pw) { showErr("ppmPwErr", "Enter a password."); return; }
      call("setPpmPassword", { password: pw }).then(function () {
        showBanner(true, "PPM backup default password saved.");
        renderKey();
      });
    },
    clearPpmPassword: function () {
      call("setPpmPassword", { password: "" }).then(function () {
        showBanner(true, "PPM backup default password cleared.");
        renderKey();
      });
    },

    // add token
    doAdd: function () {
      var token = (document.getElementById("addToken").value || "").trim();
      var label = (document.getElementById("addLabel").value || "").trim() || "account";
      if (!token) { showErr("addErr", "Paste a token."); return; }
      call("addToken", { token: token, label: label }).then(function (r) {
        if (r && r.error) { showErr("addErr", r.error); return; }
        showBanner(true, 'Added "' + label + '".');
        renderMain();
      });
    },

    // import
    importMode: function (el) {
      var mode = el.getAttribute("data-mode");
      state.importMode = mode;
      document.getElementById("importPaste").style.display = mode === "paste" ? "" : "none";
      document.getElementById("importFile").style.display = mode === "file" ? "" : "none";
      document.getElementById("importPPM").style.display = mode === "ppm" ? "" : "none";
      document.getElementById("importCTSFields").style.display = mode === "ppm" ? "none" : "";
      var btns = el.parentElement.querySelectorAll("button");
      for (var i = 0; i < btns.length; i++) btns[i].className = btns[i] === el ? "on" : "";
      if (mode === "ppm") {
        call("getPpmPassword").then(function (pw) {
          var pwEl = document.getElementById("ppmPassword");
          if (pwEl && pw && !pwEl.value) pwEl.value = pw;
        });
      }
    },

    pickFile: function () {
      call("pickImportFile").then(function (r) {
        if (r && r.blob) {
          document.getElementById("importBlob").value = r.blob;
          // switch back to paste view to show the blob
          var pasteEl = document.getElementById("importPaste");
          var fileEl = document.getElementById("importFile");
          pasteEl.style.display = "";
          fileEl.style.display = "none";
          var segs = document.querySelectorAll(".seg button");
          for (var i = 0; i < segs.length; i++) segs[i].className = i === 0 ? "on" : "";
        }
      });
    },

    doImport: function () {
      var blob = (document.getElementById("importBlob").value || "").trim();
      var key = (document.getElementById("importKey").value || "").trim();
      var label = (document.getElementById("importLabel").value || "").trim();
      if (!blob) { showErr("importErr", "Paste the encrypted blob or open a file."); return; }
      if (!key) { showErr("importErr", "Enter the share key."); return; }
      call("importToken", { blob: blob, key: key, label: label }).then(function (r) {
        if (r && r.error) { showErr("importErr", r.error); return; }
        showBanner(true, "Imported and switched.");
        renderMain();
      });
    },

    doImportPPM: function () {
      var blob = (document.getElementById("ppmBlob").value || "").trim();
      var password = (document.getElementById("ppmPassword").value || "").trim();
      if (!blob) { showErr("ppmErr", "Paste the PPM backup JSON."); return; }
      if (!password) { showErr("ppmErr", "Enter the backup password. Set a default in Settings (Key icon)."); return; }
      call("importFromPPMBlob", { blob: blob, password: password }).then(function (r) {
        if (r && r.error) { showErr("ppmErr", r.error); return; }
        var msg = r.count === 0
          ? (r.total === 0 ? "No accounts found in backup." : "All accounts already imported.")
          : "Imported " + r.count + " of " + r.total + " account" + (r.total !== 1 ? "s" : "") + " from PPM.";
        showBanner(true, msg);
        renderMain();
      });
    },

    refreshOneUsage: function (el) {
      var id = el.getAttribute("data-id");
      delete state.usageMap[id];
      renderMain();
      doFetchUsage(id, id.indexOf("own:") === 0 ? { own: true } : { id: id });
    },

    whoAmI: function (el) {
      el.disabled = true;
      var own = el.getAttribute("data-own") === "1";
      call("whoAmI", own ? { own: true } : undefined).then(function (r) {
        if (r && r.error) {
          showBanner(false, r.error);
        } else {
          var parts = [];
          if (r.name) parts.push(r.name);
          if (r.email) parts.push("<" + r.email + ">");
          if (r.org) parts.push("· " + r.org);
          showBanner(true, parts.length ? parts.join(" ") : "Profile fetched (no name/email returned).");
        }
        renderMain();
      });
    },

    // share / export stored token
    doShare: function (el) {
      var id = el.getAttribute("data-id");
      var key = (document.getElementById("shareKey").value || "").trim();
      if (!key) { showErr("shareErr", "Enter the share key."); return; }
      call("exportById", { id: id, key: key, method: "copy" }).then(function (r) {
        if (r && r.error) { showErr("shareErr", r.error); return; }
        showBanner(true, "Encrypted token copied. Send the KEY separately.");
        renderMain();
      });
    },

    doShareFile: function (el) {
      var id = el.getAttribute("data-id");
      var key = (document.getElementById("shareKey").value || "").trim();
      if (!key) { showErr("shareErr", "Enter the share key."); return; }
      call("exportById", { id: id, key: key, method: "file" }).then(function (r) {
        if (r && r.error) { showErr("shareErr", r.error); return; }
        showBanner(true, "Saved. Send the KEY separately.");
        renderMain();
      });
    },

    // set key
    doSetKey: function () {
      var k = (document.getElementById("keyInput").value || "").trim();
      if (!k) { showErr("keyErr", "Enter a key."); return; }
      call("setShareKey", { key: k }).then(function () {
        showBanner(true, "Share key saved.");
        renderKey();
      });
    },

    // remove
    doRemove: function (el) {
      var id = el.getAttribute("data-id");
      call("removeById", { id: id }).then(function () {
        showBanner(true, "Removed.");
        renderMain();
      });
    },
  };

  // ---- error display --------------------------------------------------------
  function showErr(elId, text) {
    var el = document.getElementById(elId);
    if (el) el.innerHTML = '<div class="err">' + ci("error") + "<span>" + esc(text) + "</span></div>";
  }

  // ---- wiring ---------------------------------------------------------------
  function wire() {
    var els = app.querySelectorAll("[data-action]");
    for (var i = 0; i < els.length; i++) {
      els[i].onclick = function () {
        var a = this.getAttribute("data-action");
        if (actions[a]) actions[a](this);
      };
    }
  }

  // ---- incoming messages ----------------------------------------------------
  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d) return;
    if (d.type === "state") {
      state.accounts = d.accounts || [];
      // fetch usage for any Claude account not yet loaded
      for (var ai = 0; ai < state.accounts.length; ai++) {
        var acc = state.accounts[ai];
        if (acc.kind === "claude" && !state.usageMap[acc.id] && !state.usageFetching[acc.id]) {
          doFetchUsage(acc.id, { id: acc.id });
        }
      }
      if (!state.usageMap["own:claude"] && !state.usageFetching["own:claude"]) {
        doFetchUsage("own:claude", { own: true });
      }
      if (state.screen === "main") renderMain();
    } else if (d.type === "result") {
      var fn = state.pending[d.id];
      if (fn) { delete state.pending[d.id]; fn(d.value); }
    }
  });

  // ---- boot -----------------------------------------------------------------
  renderMain();   // show empty state immediately; re-renders when state arrives
  post("ready");
})();
