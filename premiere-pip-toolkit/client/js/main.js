/*
  Panel controller. Talks to Premiere Pro through the native CEP binding
  (window.__adobe_cep__) rather than Adobe's CSInterface.js wrapper - the
  wrapper just calls the same native evalScript/getHostEnvironment methods,
  and skipping it avoids bundling a large third-party file we can't verify
  byte-for-byte in this environment.
*/
(function () {
  "use strict";

  function evalScript(script) {
    return new Promise(function (resolve) {
      if (window.__adobe_cep__ && window.__adobe_cep__.evalScript) {
        window.__adobe_cep__.evalScript(script, resolve);
      } else {
        // Not running inside Premiere's CEP host (e.g. previewing in a browser).
        console.warn("No CEP host detected; evalScript() call ignored:", script);
        resolve("ERR|Not running inside Premiere Pro.");
      }
    });
  }

  function q(id) { return document.getElementById(id); }
  function esc(str) { return String(str).replace(/"/g, '\\"'); }

  var WARN_MESSAGES = {
    crop_effect: "couldn't add the Crop effect",
    crop_params: "Crop effect parameters not found",
    border_effect: "couldn't add Bevel Edges (border)",
    border_param: "Bevel Edges parameter not found",
    glow_effect: "couldn't add Alpha Glow",
    glow_color: "glow color not supported on this Premiere version",
    shadow_effect: "couldn't add Drop Shadow",
    dim_effect: "couldn't add Brightness & Contrast (dim)",
    dim_param: "Brightness parameter not found",
    shape_round_unverified: "rounded/circle masking isn't scriptable on this Premiere version; applied as rectangle"
  };

  function describeResult(result) {
    if (result === "OK") return { ok: true, text: "Done." };
    if (result.indexOf("OK|warn:") === 0) {
      var codes = result.substring(8).split(",");
      var msgs = codes.map(function (c) { return WARN_MESSAGES[c] || c; });
      return { ok: true, text: "Done, but: " + msgs.join("; ") + "." };
    }
    if (result.indexOf("OK|debug:") === 0) return { ok: true, text: "Done. " + result.substring(9) };
    if (result.indexOf("ERR|") === 0) return { ok: false, text: result.substring(4) };
    return { ok: false, text: "Unexpected response: " + result };
  }

  function setStatus(text, kind) {
    var bar = q("statusBar");
    bar.textContent = text;
    bar.title = text; // full text on hover / selectable, in case it's longer than the bar
    bar.className = "statusbar" + (kind ? " " + kind : "");
  }

  function withBusyButton(btn, fn) {
    return function () {
      btn.disabled = true;
      var prevText = btn.textContent;
      btn.textContent = "Working…";
      setStatus("Applying…");
      fn().then(function (result) {
        var d = describeResult(result);
        setStatus(d.text, d.ok ? "ok" : "err");
      }).catch(function (e) {
        setStatus("Unexpected error: " + e, "err");
      }).then(function () {
        btn.disabled = false;
        btn.textContent = prevText;
      });
    };
  }

  // ---------------- context / frame size ----------------

  var frameW = 1920, frameH = 1080, hasClip = false;

  function refreshContext() {
    q("contextBar").textContent = "Reading sequence…";
    return evalScript("getContext()").then(function (result) {
      if (result.indexOf("OK|") === 0) {
        var parts = result.split("|");
        var seqName = parts[1], w = parseInt(parts[2], 10), h = parseInt(parts[3], 10);
        hasClip = parts[4] === "1";
        var clipName = parts[5], dur = parts[6];
        frameW = w || 1920; frameH = h || 1080;
        stage.setAspect(frameW, frameH);
        q("contextBar").textContent = seqName + " • " + w + "×" + h + " • " + clipName + (hasClip ? " (" + dur + "s)" : "");
        setDisabled(!hasClip);
      } else {
        q("contextBar").textContent = result.replace(/^ERR\|/, "");
        setDisabled(true);
      }
    });
  }

  function setDisabled(disabled) {
    ["zoomApply", "hlApply", "ovApply"].forEach(function (id) { q(id).disabled = disabled; });
  }

  // ---------------- live frame thumbnail (best-effort) ----------------

  var thumbBusy = false;

  function refreshThumbnail() {
    if (thumbBusy) return Promise.resolve();
    thumbBusy = true;
    var box = q("stageAspect");
    return evalScript("getFrameThumbnail()").then(function (result) {
      if (result.indexOf("OK|") === 0) {
        var path = result.substring(3).replace(/\\/g, "/");
        var url = "file://" + (path.charAt(0) === "/" ? "" : "/") + path + "?t=" + Date.now();
        box.style.backgroundImage = 'url("' + url + '")';
        box.style.backgroundSize = "cover";
        box.style.backgroundPosition = "center";
      } else {
        box.style.backgroundImage = "";
        setStatus("No live preview available: " + result.replace(/^ERR\|/, ""), "err");
      }
    }).catch(function () {
      box.style.backgroundImage = "";
    }).then(function () { thumbBusy = false; });
  }

  // ---------------- tabs ----------------

  var tabs = document.querySelectorAll(".tab");
  var panels = { zoom: q("panel-zoom"), highlight: q("panel-highlight"), overlay: q("panel-overlay") };
  var hints = {
    zoom: "Click in the frame to set the zoom point.",
    highlight: "Drag the box onto the area to highlight.",
    overlay: "Drag the box to size/position the overlay (or use presets below)."
  };

  function selectTab(name) {
    tabs.forEach(function (t) { t.classList.toggle("active", t.dataset.tab === name); });
    Object.keys(panels).forEach(function (k) { panels[k].classList.toggle("hidden", k !== name); });
    q("stageHint").textContent = hints[name];
    stage.setMode(name === "zoom" ? "point" : "rect");
    refreshThumbnail();
  }
  tabs.forEach(function (t) { t.addEventListener("click", function () { selectTab(t.dataset.tab); }); });

  // ---------------- stage ----------------

  var stage = new Stage(q("stage"), q("stagePoint"), q("stageRect"), q("stageAspect"));
  stage.setMode("point");

  // ---------------- live range labels ----------------

  function bindLabel(rangeId, labelId, fmt) {
    var el = q(rangeId), label = q(labelId);
    var update = function () { label.textContent = fmt(el.value); };
    el.addEventListener("input", update);
    update();
  }
  bindLabel("zoomScale", "zoomScaleVal", function (v) { return v + "%"; });
  bindLabel("zoomIn", "zoomInVal", function (v) { return v + "s"; });
  bindLabel("zoomHold", "zoomHoldVal", function (v) { return v + "s"; });
  bindLabel("zoomOut", "zoomOutVal", function (v) { return v + "s"; });
  bindLabel("hlIn", "hlInVal", function (v) { return v + "s"; });
  bindLabel("hlHold", "hlHoldVal", function (v) { return v + "s"; });
  bindLabel("hlOut", "hlOutVal", function (v) { return v + "s"; });
  bindLabel("hlDim", "hlDimVal", function (v) { return v + "%"; });
  bindLabel("hlMagnifyPct", "hlMagnifyVal", function (v) { return v + "%"; });
  bindLabel("ovScale", "ovScaleVal", function (v) { return v + "%"; });

  q("zoomOutToggle").addEventListener("change", function () {
    q("zoomOutRow").hidden = !this.checked;
  });
  q("hlMagnify").addEventListener("change", function () {
    q("hlMagnifyRow").style.opacity = this.checked ? "1" : "0.35";
  });

  // segmented controls
  function bindSegmented(containerId) {
    var container = q(containerId);
    container.querySelectorAll(".seg").forEach(function (btn) {
      btn.addEventListener("click", function () {
        container.querySelectorAll(".seg").forEach(function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
      });
    });
  }
  bindSegmented("hlStyle");
  bindSegmented("ovShape");
  function segValue(containerId) {
    return q(containerId).querySelector(".seg.active").dataset.val;
  }

  // overlay 9-grid
  var ovGrid = q("ovGrid");
  ovGrid.querySelectorAll("button").forEach(function (btn) {
    btn.addEventListener("click", function () {
      ovGrid.querySelectorAll("button").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      q("ovCustom").checked = false;
    });
  });
  q("ovCustom").addEventListener("change", function () {
    if (this.checked) ovGrid.querySelectorAll("button").forEach(function (b) { b.classList.remove("active"); });
  });

  // ---------------- apply actions ----------------

  q("zoomApply").addEventListener("click", withBusyButton(q("zoomApply"), function () {
    var p = stage.point;
    var args = [
      p.x.toFixed(4), p.y.toFixed(4),
      q("zoomScale").value,
      q("zoomIn").value,
      q("zoomOutToggle").checked ? q("zoomHold").value : "0",
      q("zoomOutToggle").checked ? q("zoomOut").value : "0.3",
      q("zoomOutToggle").checked ? "1" : "0",
      '"' + q("zoomEasing").value + '"'
    ];
    return evalScript("applyZoom(" + args.join(",") + ")");
  }));

  q("hlApply").addEventListener("click", withBusyButton(q("hlApply"), function () {
    var r = stage.rect;
    var args = [
      r.x.toFixed(4), r.y.toFixed(4), r.w.toFixed(4), r.h.toFixed(4),
      '"' + segValue("hlStyle") + '"',
      q("hlMagnify").checked ? "1" : "0",
      q("hlMagnifyPct").value,
      q("hlDim").value,
      q("hlBorder").checked ? "1" : "0",
      q("hlBorderPx").value,
      q("hlGlow").checked ? "1" : "0",
      '"' + esc(q("hlGlowColor").value) + '"',
      q("hlIn").value,
      q("hlHold").value,
      q("hlOut").value
    ];
    return evalScript("applyHighlight(" + args.join(",") + ")");
  }));

  q("ovApply").addEventListener("click", withBusyButton(q("ovApply"), function () {
    var custom = q("ovCustom").checked;
    var preset = custom ? "custom" : ovGrid.querySelector(".active").dataset.val;
    var r = stage.rect;
    var cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    var args = [
      '"' + preset + '"',
      cx.toFixed(4), cy.toFixed(4),
      q("ovScale").value,
      '"' + segValue("ovShape") + '"',
      q("ovBorder").checked ? "1" : "0",
      q("ovBorderPx").value,
      '"' + esc(q("ovBorderColor") ? q("ovBorderColor").value : "#ffffff") + '"',
      q("ovGlow").checked ? "1" : "0",
      '"' + esc(q("ovGlowColor").value) + '"',
      q("ovShadow").checked ? "1" : "0",
      q("ovShadowDist").value,
      q("ovShadowSoft").value,
      q("ovShadowOpacity").value,
      '"' + q("ovAnim").value + '"',
      "0.5"
    ];
    return evalScript("applyOverlay(" + args.join(",") + ")");
  }));

  q("refreshBtn").addEventListener("click", function () { refreshContext(); refreshThumbnail(); });

  // ---------------- init ----------------

  selectTab("zoom");
  refreshContext();
  setInterval(refreshContext, 4000);
})();
