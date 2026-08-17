/*
  PiP Toolkit - Premiere Pro host script (ExtendScript)
  ------------------------------------------------------
  Every public function returns a plain "|" delimited string (never JSON -
  ExtendScript's JSON support is unreliable across Premiere versions, so we
  avoid it entirely rather than ship a hand-rolled polyfill).

  Response protocol:
    "OK"                    success, nothing else to report
    "OK|warn:<message>"     success, but something non-critical was skipped
    "OK|<field>|<field>..." success, with data fields for the panel to read
    "ERR|<message>"         failure, message is safe to show to the user

  A few things used here (adding filter effects via the "QE" DOM, setting
  color-typed effect parameters) sit outside Adobe's officially documented
  scripting surface. They're long-standing, widely-relied-on community
  patterns because the documented DOM has no supported way to add a new
  filter effect to a clip. Every one of those calls is wrapped so a failure
  degrades the feature gracefully instead of aborting the whole operation -
  see addFilterByMatchName() and trySetColor().
*/

//////////////////////// small utilities ////////////////////////

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function easeSample(f, style) {
  // f in [0,1] -> eased [0,1]
  if (style === "linear") return f;
  if (style === "easeIn") return f * f * f;
  if (style === "easeOut") return 1 - Math.pow(1 - f, 3);
  // default: easeInOut (cubic)
  return f < 0.5 ? 4 * f * f * f : 1 - Math.pow(-2 * f + 2, 3) / 2;
}

function hexToColorNum(hex) {
  hex = String(hex).replace("#", "");
  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }
  var r = parseInt(hex.substr(0, 2), 16) || 0;
  var g = parseInt(hex.substr(2, 2), 16) || 0;
  var b = parseInt(hex.substr(4, 2), 16) || 0;
  // 32-bit ARGB, the convention Premiere's ComponentParam color values use
  return ((255 << 24) | (r << 16) | (g << 8) | b) >>> 0;
}

function getActiveSeq() {
  if (!app.project || !app.project.activeSequence) {
    throw new Error("No active sequence. Open a sequence in the timeline first.");
  }
  return app.project.activeSequence;
}

function getComponentByMatchName(trackItem, matchName) {
  var comps = trackItem.components;
  for (var i = 0; i < comps.numItems; i++) {
    if (comps[i].matchName === matchName) return comps[i];
  }
  return null;
}

function getParamByDisplayName(component, displayName) {
  for (var i = 0; i < component.properties.numItems; i++) {
    var p = component.properties[i];
    if (p.displayName === displayName) return p;
  }
  return null;
}

function ensureTimeVarying(param) {
  try {
    if (!param.isTimeVarying()) param.setTimeVarying(true);
  } catch (e) { /* some params can't be keyframed; caller falls back to setValue */ }
}

function setKeyframe(param, seconds, value) {
  var t = new Time();
  t.seconds = seconds;
  ensureTimeVarying(param);
  try { param.addKey(t); } catch (e) { /* key may already exist here */ }
  param.setValueAtKey(t, value, true);
}

function trySetColor(component, displayName, hex) {
  try {
    var p = getParamByDisplayName(component, displayName);
    if (!p) return false;
    p.setValue(hexToColorNum(hex), true);
    return true;
  } catch (e) { return false; }
}

// Locates the clip to operate on: the current timeline selection (first
// video item) if there is one, otherwise the topmost video-track item
// sitting under the playhead.
function getTargetTrackItem(seq) {
  try {
    var sel = seq.getSelection();
    if (sel && sel.length) {
      for (var i = 0; i < sel.length; i++) {
        if (sel[i].mediaType === "Video") return sel[i];
      }
    }
  } catch (e) { /* getSelection() not available on very old versions */ }

  var playhead = seq.getPlayerPosition().seconds;
  for (var t = seq.videoTracks.numTracks - 1; t >= 0; t--) {
    var track = seq.videoTracks[t];
    for (var c = 0; c < track.clips.numItems; c++) {
      var clip = track.clips[c];
      if (clip.start.seconds <= playhead && clip.end.seconds > playhead) return clip;
    }
  }
  return null;
}

function trackIndexOf(seq, trackItem) {
  for (var t = 0; t < seq.videoTracks.numTracks; t++) {
    var track = seq.videoTracks[t];
    for (var c = 0; c < track.clips.numItems; c++) {
      if (track.clips[c] === trackItem) return t;
    }
  }
  return -1;
}

function clipIndexOf(track, trackItem) {
  for (var c = 0; c < track.clips.numItems; c++) {
    if (track.clips[c] === trackItem) return c;
  }
  return -1;
}

// Finds a video track above `aboveIndex` with no clip overlapping
// [startSec, endSec). Returns the track index, or -1 if none is free.
function findEmptyTrackAbove(seq, aboveIndex, startSec, endSec) {
  for (var t = aboveIndex + 1; t < seq.videoTracks.numTracks; t++) {
    var track = seq.videoTracks[t];
    var free = true;
    for (var c = 0; c < track.clips.numItems; c++) {
      var clip = track.clips[c];
      if (clip.start.seconds < endSec && clip.end.seconds > startSec) { free = false; break; }
    }
    if (free) return t;
  }
  return -1;
}

// Adds a filter effect (Crop, Drop Shadow, Alpha Glow, Bevel Edges, ...) to
// a clip via the QE ("Quality Engineering") automation DOM. This is not in
// Adobe's public scripting guide, but it is the standard, long-established
// way Premiere scripting tools add new effects, because the documented
// TrackItem/Component API has no supported "add effect" call. Returns the
// documented Component object for the newly added effect so the rest of the
// script can keyframe it normally, or null if the QE DOM isn't cooperative
// on this Premiere version.
function addFilterByMatchName(seq, trackItem, matchName, effectName) {
  var existing = getComponentByMatchName(trackItem, matchName);
  if (existing) return existing;
  try {
    app.enableQE();
    var vIdx = trackIndexOf(seq, trackItem);
    var cIdx = clipIndexOf(seq.videoTracks[vIdx], trackItem);
    var qeSeq = qe.project.getActiveSequence();
    var qeTrack = qeSeq.getVideoTrackAt(vIdx);
    var qeItem = qeTrack.getItemAt(cIdx);
    var qeEffect = qe.project.getVideoEffectByName(effectName);
    if (!qeEffect) return null;
    qeItem.addVideoFilter(qeEffect);
    return getComponentByMatchName(trackItem, matchName);
  } catch (e) {
    return null;
  }
}

//////////////////////// context / info for the panel ////////////////////////

function getContext() {
  try {
    var seq = getActiveSeq();
    var item = getTargetTrackItem(seq);
    var name = item ? String(item.name).replace(/\|/g, "-") : "(none - click Refresh after selecting/parking on a clip)";
    var dur = item ? (item.end.seconds - item.start.seconds).toFixed(2) : "0";
    return ["OK", seq.name.replace(/\|/g, "-"), seq.frameSizeHorizontal, seq.frameSizeVertical, item ? 1 : 0, name, dur].join("|");
  } catch (e) {
    return "ERR|" + e.toString();
  }
}

//////////////////////// live frame thumbnail ////////////////////////

// Premiere's scripting API has no direct "give me the current frame as a
// bitmap" call. The documented way to get one is to have Premiere export a
// still frame through its own encoder (Sequence.exportAsMediaDirect), which
// needs a path to a PNG/JPEG export preset (.epr) file. Rather than ship a
// hand-authored .epr - a proprietary format that's easy to get subtly wrong
// - this searches the machine's own Adobe application-support folder for a
// real preset Adobe already installed, and tries whichever ones it finds
// whose filename suggests a still-image format. This is the most likely
// spot in the whole toolkit to need adjusting for a specific machine/OS
// layout; getFrameThumbnail() reports exactly what it tried and why it
// failed rather than just returning nothing.

function findFilesRecursive(folder, pattern, maxDepth, results, depth) {
  if (depth > maxDepth || results.length > 300) return;
  var items;
  try { items = folder.getFiles(); } catch (e) { return; }
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (item instanceof Folder) {
      findFilesRecursive(item, pattern, maxDepth, results, depth + 1);
    } else if (item instanceof File && pattern.test(item.name)) {
      results.push(item.fsName);
    }
    if (results.length > 300) return;
  }
}

function findStillFramePresets() {
  var roots = [];
  if ($.os.indexOf("Windows") !== -1) {
    roots.push(new Folder("C:/Program Files/Common Files/Adobe"));
    roots.push(new Folder(Folder.appData.fsName + "/Adobe"));
  } else {
    roots.push(new Folder("/Library/Application Support/Adobe"));
  }

  var all = [];
  for (var r = 0; r < roots.length; r++) {
    if (roots[r].exists) findFilesRecursive(roots[r], /\.epr$/i, 6, all, 0);
  }

  var preferred = [];
  for (var i = 0; i < all.length; i++) {
    if (/png|jpe?g|still|frame/i.test(all[i])) preferred.push(all[i]);
  }
  return { preferred: preferred, all: all };
}

function getFrameThumbnail() {
  try {
    var seq = getActiveSeq();
    var playhead = seq.getPlayerPosition().seconds;

    var fps = 30;
    try {
      if (seq.videoFrameRate && seq.videoFrameRate.ticks) fps = 254016000000 / seq.videoFrameRate.ticks;
    } catch (e) { /* fall back to 30 */ }
    var frameDur = 1 / fps;

    var origIn, origOut, hadWorkArea = true;
    try { origIn = seq.getInPoint(); origOut = seq.getOutPoint(); } catch (e) { hadWorkArea = false; }

    try { seq.setInPoint(playhead); seq.setOutPoint(playhead + frameDur * 2); }
    catch (e) { return "ERR|Could not set a work area on the sequence to export from: " + e.toString(); }

    var found = findStillFramePresets();
    var candidates = found.preferred.length ? found.preferred : found.all;

    if (!candidates.length) {
      if (hadWorkArea) { try { seq.setInPoint(origIn); seq.setOutPoint(origOut); } catch (e) {} }
      return "ERR|No .epr export preset found under Adobe's application support folder on this machine.";
    }

    var dest = new File(Folder.temp.fsName + "/pip_toolkit_thumb.png");
    if (dest.exists) { try { dest.remove(); } catch (e) {} }

    var success = false, lastErr = "", triedCount = 0;
    for (var i = 0; i < candidates.length && !success; i++) {
      triedCount++;
      try {
        seq.exportAsMediaDirect(dest.fsName, candidates[i], 1);
        if (dest.exists) success = true;
      } catch (e) { lastErr = e.toString(); }
    }

    if (hadWorkArea) { try { seq.setInPoint(origIn); seq.setOutPoint(origOut); } catch (e) {} }

    if (success) return "OK|" + dest.fsName;
    return "ERR|Tried " + triedCount + " export preset(s) found on this machine, none produced a file. Last error: " + (lastErr || "(none thrown, file just never appeared)");
  } catch (e) {
    return "ERR|" + e.toString();
  }
}

//////////////////////// Tool 1: Zoom ////////////////////////

// px,py: normalized (0..1) point in the frame to zoom into
// scalePct: target zoom scale, e.g. 220 = 220%
// inSec/holdSec/outSec: ramp-in, hold, ramp-out durations in seconds
// zoomOut: "1"/"0"
// easing: "linear" | "easeIn" | "easeOut" | "easeInOut"
function applyZoom(pxStr, pyStr, scalePctStr, inSecStr, holdSecStr, outSecStr, zoomOutStr, easing) {
  try {
    var seq = getActiveSeq();
    var item = getTargetTrackItem(seq);
    if (!item) return "ERR|No clip selected and nothing under the playhead on a video track.";

    var px = parseFloat(pxStr), py = parseFloat(pyStr);
    var scale = parseFloat(scalePctStr) / 100;
    var inSec = Math.max(0.05, parseFloat(inSecStr));
    var holdSec = Math.max(0, parseFloat(holdSecStr));
    var outSec = Math.max(0.05, parseFloat(outSecStr));
    var zoomOut = zoomOutStr === "1";

    var motion = getComponentByMatchName(item, "AE.ADBE Motion");
    if (!motion) return "ERR|Could not find the Motion effect on this clip.";
    var posParam = getParamByDisplayName(motion, "Position");
    var scaleParam = getParamByDisplayName(motion, "Scale") || getParamByDisplayName(motion, "Scale Height");
    if (!posParam || !scaleParam) return "ERR|Could not find Position/Scale on the Motion effect.";

    var W = seq.frameSizeHorizontal, H = seq.frameSizeVertical;
    var cx = W / 2, cy = H / 2;
    var targetX = px * W, targetY = py * H;

    function posFor(s) { return [cx - s * (targetX - cx), cy - s * (targetY - cy)]; }

    var playhead = seq.getPlayerPosition().seconds;
    var clipStart = item.start.seconds, clipEnd = item.end.seconds;
    var t0 = clamp(playhead - inSec, clipStart, clipEnd);
    var t1 = clamp(playhead, clipStart, clipEnd);

    setKeyframe(posParam, t0, posFor(1));
    setKeyframe(scaleParam, t0, 100);

    var steps = 6, i, f, e, s, tt;
    for (i = 1; i <= steps; i++) {
      f = i / steps;
      e = easeSample(f, easing);
      s = 1 + (scale - 1) * e;
      tt = t0 + (t1 - t0) * f;
      setKeyframe(posParam, tt, posFor(s));
      setKeyframe(scaleParam, tt, s * 100);
    }

    if (zoomOut) {
      var t2 = clamp(t1 + holdSec, clipStart, clipEnd);
      var t3 = clamp(t2 + outSec, clipStart, clipEnd);
      setKeyframe(posParam, t2, posFor(scale));
      setKeyframe(scaleParam, t2, scale * 100);
      for (i = 1; i <= steps; i++) {
        f = i / steps;
        e = easeSample(f, easing);
        s = scale - (scale - 1) * e;
        tt = t2 + (t3 - t2) * f;
        setKeyframe(posParam, tt, posFor(s));
        setKeyframe(scaleParam, tt, s * 100);
      }
    }
    return "OK";
  } catch (e) {
    return "ERR|" + e.toString();
  }
}

//////////////////////// Tool 2: Animated Highlight ////////////////////////

// "Spotlight" technique built entirely from stock effects (Premiere has no
// native shape/vector generator like After Effects does):
//  - the ORIGINAL clip gets Brightness & Contrast keyframed down, dimming
//    the whole frame around the highlight
//  - a DUPLICATE of the same source, on an empty track above, gets a Crop
//    keyframed to reveal only the highlighted rectangle (undimmed), plus
//    an optional Motion push-in on just that region ("magnify"), plus
//    optional Bevel Edges (border) / Alpha Glow (colored glow)
//
// px,py,pw,ph: normalized rect (0..1) in frame coordinates
// style: "draw" | "pop" | "fade"
function applyHighlight(pxStr, pyStr, pwStr, phStr, style, magnifyStr, magnifyPctStr,
                         dimStr, borderStr, borderPxStr, glowStr, glowColor,
                         inSecStr, holdSecStr, outSecStr) {
  try {
    var seq = getActiveSeq();
    var orig = getTargetTrackItem(seq);
    if (!orig) return "ERR|No clip selected and nothing under the playhead on a video track.";
    if (!orig.projectItem) return "ERR|Selected clip has no source media reference; can't duplicate it.";

    var px = parseFloat(pxStr), py = parseFloat(pyStr), pw = parseFloat(pwStr), ph = parseFloat(phStr);
    var magnify = magnifyStr === "1";
    var magnifyScale = parseFloat(magnifyPctStr) / 100;
    var dim = clamp(parseFloat(dimStr), 0, 100);
    var border = borderStr === "1";
    var borderPx = parseFloat(borderPxStr);
    var glow = glowStr === "1";
    var inSec = Math.max(0.05, parseFloat(inSecStr));
    var holdSec = Math.max(0, parseFloat(holdSecStr));
    var outSec = Math.max(0.05, parseFloat(outSecStr));

    var vIdx = trackIndexOf(seq, orig);
    if (vIdx < 0) return "ERR|Could not locate the clip's track.";
    var origStart = orig.start.seconds, origEnd = orig.end.seconds;

    var freeTrack = findEmptyTrackAbove(seq, vIdx, origStart, origEnd);
    if (freeTrack < 0) {
      return "ERR|No empty video track above this clip for the highlight layer. " +
             "Add one (Sequence > Add Tracks) and try again.";
    }

    seq.videoTracks[freeTrack].overwriteClip(orig.projectItem, origStart);
    var dup = null;
    for (var c = 0; c < seq.videoTracks[freeTrack].clips.numItems; c++) {
      var cand = seq.videoTracks[freeTrack].clips[c];
      if (Math.abs(cand.start.seconds - origStart) < 0.01) { dup = cand; break; }
    }
    if (!dup) return "ERR|Could not create the highlight layer.";
    try {
      dup.end = orig.end;
      dup.inPoint = orig.inPoint;
      dup.outPoint = orig.outPoint;
    } catch (e) { /* best effort trim to match source clip's duration */ }

    var warnings = [];

    var playhead = seq.getPlayerPosition().seconds;
    var t0 = clamp(playhead - inSec, origStart, origEnd);
    var t1 = clamp(playhead, origStart, origEnd);
    var t2 = clamp(t1 + holdSec, origStart, origEnd);
    var t3 = clamp(t2 + outSec, origStart, origEnd);

    // --- crop reveal on the duplicate ---
    var cropComp = addFilterByMatchName(seq, dup, "AE.ADBE Crop", "Crop");
    if (cropComp) {
      var pLeft = getParamByDisplayName(cropComp, "Left");
      var pTop = getParamByDisplayName(cropComp, "Top");
      var pRight = getParamByDisplayName(cropComp, "Right");
      var pBottom = getParamByDisplayName(cropComp, "Bottom");
      var targetLeft = px * 100, targetTop = py * 100;
      var targetRight = (1 - (px + pw)) * 100, targetBottom = (1 - (py + ph)) * 100;

      if (pLeft && pTop && pRight && pBottom) {
        if (style === "draw") {
          pLeft.setValue(targetLeft, true);
          pTop.setValue(targetTop, true);
          pBottom.setValue(targetBottom, true);
          setKeyframe(pRight, t0, 100);
          for (var i = 1; i <= 6; i++) {
            var f = i / 6, e = easeSample(f, "easeOut");
            setKeyframe(pRight, t0 + (t1 - t0) * f, 100 - (100 - targetRight) * e);
          }
        } else if (style === "pop") {
          var midX = (targetLeft + (100 - targetRight)) / 2;
          var midY = (targetTop + (100 - targetBottom)) / 2;
          setKeyframe(pLeft, t0, midX); setKeyframe(pRight, t0, 100 - midX);
          setKeyframe(pTop, t0, midY); setKeyframe(pBottom, t0, 100 - midY);
          for (var j = 1; j <= 6; j++) {
            var f2 = j / 6, e2 = easeSample(f2, "easeOut");
            var tt = t0 + (t1 - t0) * f2;
            setKeyframe(pLeft, tt, midX + (targetLeft - midX) * e2);
            setKeyframe(pRight, tt, (100 - midX) + (targetRight - (100 - midX)) * e2);
            setKeyframe(pTop, tt, midY + (targetTop - midY) * e2);
            setKeyframe(pBottom, tt, (100 - midY) + (targetBottom - (100 - midY)) * e2);
          }
        } else { // fade
          pLeft.setValue(targetLeft, true);
          pTop.setValue(targetTop, true);
          pRight.setValue(targetRight, true);
          pBottom.setValue(targetBottom, true);
        }
      } else {
        warnings.push("crop_params");
      }
    } else {
      warnings.push("crop_effect");
    }

    // --- opacity: fade style, plus the ramp-out fade back for all styles ---
    var opacityComp = getComponentByMatchName(dup, "AE.ADBE Opacity");
    if (opacityComp) {
      var opParam = getParamByDisplayName(opacityComp, "Opacity");
      if (opParam) {
        if (style === "fade") {
          setKeyframe(opParam, t0, 0);
          setKeyframe(opParam, t1, 100);
        }
        setKeyframe(opParam, t2, 100);
        setKeyframe(opParam, t3, 0);
      }
    }

    // --- magnify: push in on just the highlighted region ---
    if (magnify) {
      var motion = getComponentByMatchName(dup, "AE.ADBE Motion");
      if (motion) {
        var posP = getParamByDisplayName(motion, "Position");
        var scaleP = getParamByDisplayName(motion, "Scale");
        if (posP && scaleP) {
          var W = seq.frameSizeHorizontal, H = seq.frameSizeVertical;
          var cx = W / 2, cy = H / 2;
          var boxCx = (px + pw / 2) * W, boxCy = (py + ph / 2) * H;
          function posFor(s) { return [cx - s * (boxCx - cx), cy - s * (boxCy - cy)]; }
          setKeyframe(posP, t0, posFor(1));
          setKeyframe(scaleP, t0, 100);
          for (var k = 1; k <= 6; k++) {
            var fk = k / 6, ek = easeSample(fk, "easeInOut");
            var sk = 1 + (magnifyScale - 1) * ek;
            setKeyframe(posP, t0 + (t1 - t0) * fk, posFor(sk));
            setKeyframe(scaleP, t0 + (t1 - t0) * fk, sk * 100);
          }
          setKeyframe(posP, t2, posFor(magnifyScale));
          setKeyframe(scaleP, t2, magnifyScale * 100);
          setKeyframe(posP, t3, posFor(1));
          setKeyframe(scaleP, t3, 100);
        }
      }
    }

    // --- border (Bevel Edges is the closest stock effect to a flat border) ---
    if (border) {
      var bevel = addFilterByMatchName(seq, dup, "AE.ADBE Bevel Edges", "Bevel Edges");
      if (bevel) {
        var pThick = getParamByDisplayName(bevel, "Edge Thickness");
        if (pThick) { try { pThick.setValue(clamp(borderPx / 8, 0, 16), true); } catch (e) {} }
        else warnings.push("border_param");
      } else warnings.push("border_effect");
    }

    // --- glow ---
    if (glow) {
      var ag = addFilterByMatchName(seq, dup, "AE.ADBE Alpha Glow", "Alpha Glow");
      if (ag) {
        if (!trySetColor(ag, "Start Color", glowColor)) warnings.push("glow_color");
        var pGlow = getParamByDisplayName(ag, "Glow");
        if (pGlow) { try { pGlow.setValue(12, true); } catch (e) {} }
      } else warnings.push("glow_effect");
    }

    // --- dim the background via the ORIGINAL clip ---
    if (dim > 0) {
      var bc = addFilterByMatchName(seq, orig, "AE.ADBE Brightness & Contrast 2", "Brightness & Contrast");
      if (bc) {
        var pB = getParamByDisplayName(bc, "Brightness");
        if (pB) {
          var amt = -(dim * 0.8);
          setKeyframe(pB, t0, 0);
          setKeyframe(pB, t1, amt);
          setKeyframe(pB, t2, amt);
          setKeyframe(pB, t3, 0);
        } else warnings.push("dim_param");
      } else warnings.push("dim_effect");
    }

    return warnings.length ? "OK|warn:" + warnings.join(",") : "OK";
  } catch (e) {
    return "ERR|" + e.toString();
  }
}

//////////////////////// Tool 3: Overlay / Talking-head positioning ////////////////////////

// preset: "tl","tc","tr","cl","cc","cr","bl","bc","br","custom"
// px,py: normalized center point, used when preset === "custom"
// scalePct: size as a percentage (10-150)
// shape: "rect" | "round"
// animStyle: "slide" | "pop" | "fade" | "none"
function applyOverlay(preset, pxStr, pyStr, scalePctStr, shape,
                       borderStr, borderPxStr, borderColor,
                       glowStr, glowColor,
                       shadowStr, shadowDistStr, shadowSoftStr, shadowOpacityStr,
                       animStyle, inSecStr) {
  try {
    var seq = getActiveSeq();
    var item = getTargetTrackItem(seq);
    if (!item) return "ERR|No clip selected and nothing under the playhead on a video track.";

    var W = seq.frameSizeHorizontal, H = seq.frameSizeVertical;
    var margin = 0.06;
    var presets = {
      tl: [margin, margin], tc: [0.5, margin], tr: [1 - margin, margin],
      cl: [margin, 0.5], cc: [0.5, 0.5], cr: [1 - margin, 0.5],
      bl: [margin, 1 - margin], bc: [0.5, 1 - margin], br: [1 - margin, 1 - margin]
    };
    var cx, cy;
    if (preset === "custom" || !presets[preset]) {
      cx = parseFloat(pxStr) * W; cy = parseFloat(pyStr) * H;
    } else {
      cx = presets[preset][0] * W; cy = presets[preset][1] * H;
    }
    var scale = clamp(parseFloat(scalePctStr), 5, 400);
    var borderOn = borderStr === "1", borderPx = parseFloat(borderPxStr);
    var glowOn = glowStr === "1";
    var shadowOn = shadowStr === "1";
    var shadowDist = parseFloat(shadowDistStr), shadowSoft = parseFloat(shadowSoftStr), shadowOpacity = parseFloat(shadowOpacityStr);
    var inSec = Math.max(0.05, parseFloat(inSecStr));

    var warnings = [];
    var playhead = seq.getPlayerPosition().seconds;
    var clipStart = item.start.seconds, clipEnd = item.end.seconds;
    var t0 = clamp(playhead - inSec, clipStart, clipEnd);
    var t1 = clamp(playhead, clipStart, clipEnd);

    var motion = getComponentByMatchName(item, "AE.ADBE Motion");
    if (!motion) return "ERR|Could not find the Motion effect on this clip.";
    var posP = getParamByDisplayName(motion, "Position");
    var scaleP = getParamByDisplayName(motion, "Scale");
    if (!posP || !scaleP) return "ERR|Could not find Position/Scale on the Motion effect.";

    if (animStyle === "none") {
      posP.setValue([cx, cy], true);
      scaleP.setValue(scale, true);
    } else if (animStyle === "slide") {
      var offX = cx, offY = cy;
      var edgeDist = 0.35;
      if (cx < W / 2) offX = -W * edgeDist; else if (cx > W / 2) offX = W * (1 + edgeDist);
      if (cy < H / 2 && cx === W / 2) offY = -H * edgeDist; else if (cy > H / 2 && cx === W / 2) offY = H * (1 + edgeDist);
      setKeyframe(posP, t0, [offX, offY]);
      setKeyframe(scaleP, t0, scale);
      for (var i = 1; i <= 6; i++) {
        var f = i / 6, e = easeSample(f, "easeOut");
        setKeyframe(posP, t0 + (t1 - t0) * f, [offX + (cx - offX) * e, offY + (cy - offY) * e]);
        setKeyframe(scaleP, t0 + (t1 - t0) * f, scale);
      }
    } else if (animStyle === "pop") {
      setKeyframe(posP, t0, [cx, cy]);
      setKeyframe(scaleP, t0, Math.max(1, scale * 0.02));
      for (var j = 1; j <= 6; j++) {
        var f2 = j / 6, e2 = easeSample(f2, "easeOut");
        setKeyframe(posP, t0 + (t1 - t0) * f2, [cx, cy]);
        setKeyframe(scaleP, t0 + (t1 - t0) * f2, Math.max(1, scale * 0.02) + (scale - Math.max(1, scale * 0.02)) * e2);
      }
    } else if (animStyle === "fade") {
      posP.setValue([cx, cy], true);
      scaleP.setValue(scale, true);
      var opacityComp = getComponentByMatchName(item, "AE.ADBE Opacity");
      if (opacityComp) {
        var opP = getParamByDisplayName(opacityComp, "Opacity");
        if (opP) { setKeyframe(opP, t0, 0); setKeyframe(opP, t1, 100); }
      }
    }

    if (shape === "round") {
      warnings.push("shape_round_unverified");
    }

    if (borderOn) {
      var bevel = addFilterByMatchName(seq, item, "AE.ADBE Bevel Edges", "Bevel Edges");
      if (bevel) {
        var pThick = getParamByDisplayName(bevel, "Edge Thickness");
        if (pThick) { try { pThick.setValue(clamp(borderPx / 8, 0, 16), true); } catch (e) {} }
      } else warnings.push("border_effect");
    }

    if (glowOn) {
      var ag = addFilterByMatchName(seq, item, "AE.ADBE Alpha Glow", "Alpha Glow");
      if (ag) {
        if (!trySetColor(ag, "Start Color", glowColor)) warnings.push("glow_color");
      } else warnings.push("glow_effect");
    }

    if (shadowOn) {
      var ds = addFilterByMatchName(seq, item, "AE.ADBE Drop Shadow", "Drop Shadow");
      if (ds) {
        var pDist = getParamByDisplayName(ds, "Distance");
        var pSoft = getParamByDisplayName(ds, "Softness");
        var pOp = getParamByDisplayName(ds, "Opacity");
        if (pDist) { try { pDist.setValue(shadowDist, true); } catch (e) {} }
        if (pSoft) { try { pSoft.setValue(shadowSoft, true); } catch (e) {} }
        if (pOp) { try { pOp.setValue((shadowOpacity / 100) * 255, true); } catch (e) {} }
      } else warnings.push("shadow_effect");
    }

    return warnings.length ? "OK|warn:" + warnings.join(",") : "OK";
  } catch (e) {
    return "ERR|" + e.toString();
  }
}
