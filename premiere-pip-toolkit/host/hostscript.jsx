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
  // addKey() likely snaps to the nearest frame boundary and hands back that
  // snapped Time. Reusing our own unsnapped `t` for setValueAtKey afterward
  // can then target a different instant than the keyframe that actually got
  // created, leaving the real keyframe at whatever default Premiere
  // initializes a fresh one to and the value silently landing nowhere - so
  // prefer whatever addKey() returns, when it returns something Time-like.
  var keyTime = t;
  try {
    var added = param.addKey(t);
    if (added && typeof added.seconds === "number") keyTime = added;
  } catch (e) { /* key may already exist here */ }
  param.setValueAtKey(keyTime, value, true);
  return keyTime;
}

// Reads a parameter's value back however this Premiere version supports it,
// for verifying a set actually stuck instead of assuming it did.
function readParamValue(param, t) {
  try { if (typeof param.getValueAtKey === "function") return param.getValueAtKey(t); } catch (e) {}
  try { if (typeof param.getValueAtTime === "function") return param.getValueAtTime(t.ticks); } catch (e) {}
  try { return param.getValue(); } catch (e) {}
  return undefined;
}

function fmtVal(v) {
  if (v === undefined) return "(unreadable)";
  if (v === null) return "null";
  if (v instanceof Array) { var parts = []; for (var i = 0; i < v.length; i++) parts.push(v[i]); return "[" + parts.join(",") + "]"; }
  return String(v);
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
// whose filename suggests a still-image format.
//
// exportAsMediaDirect() is a genuinely risky call to make casually:
//  - It's DOCUMENTED/verified as synchronous - it blocks Premiere's single
//    UI/ExtendScript thread for as long as the render takes, on the live
//    sequence, using whatever .epr preset was found (which may not be a
//    small/fast one - there's no way to verify a preset's codec, bit depth,
//    color space, or resolution before handing it to the encoder).
//  - There's a real, reproducible Adobe Community report of Premiere
//    crashing roughly 1 in 3 times specifically when exportAsMediaDirect()
//    is called repeatedly/in a loop, with Premiere becoming unresponsive
//    right after an export finishes and the next call never starting -
//    see: community.adobe.com "premiere crashes sporadically when using
//    sequence exportasmediadirect" (question 685820). That is exactly the
//    calling pattern this feature used to have: multiple candidate presets
//    tried back-to-back inside one call, and the whole thing re-run
//    automatically every time the panel's tab changed.
//  - The work area type argument matters: app.encoder.ENCODE_WORKAREA is
//    the documented/verified constant for "honor the in/out I just set"
//    (see Adobe-CEP/Samples PProPanel/jsx/PPRO/Premiere.jsx, which calls
//    exportAsMediaDirect(path, preset, app.encoder.ENCODE_WORKAREA) for
//    exactly this "render a short work-area bracket" use case). This used
//    to pass the bare literal 1 instead, which is guessing at the enum's
//    underlying ordinal - if it happened to resolve to ENCODE_ENTIRE or
//    ENCODE_IN_TO_OUT on this Premiere build instead of ENCODE_WORKAREA,
//    every "grab one frame" attempt could have silently rendered the WHOLE
//    active sequence (all tracks, all adjustment layers) through an
//    unverified preset, synchronously, on the live project - a very
//    plausible way to produce exactly the kind of crash reported here.
//
// Given all of that, this function now: (1) always uses the documented
// ENCODE_WORKAREA constant instead of a guessed literal, (2) only ever
// runs the (expensive, whole-of-Adobe) preset search once per Premiere
// session and reuses the result, (3) refuses to run again while a call is
// still in flight or within a short cooldown of the last attempt, and (4)
// only tries a small batch of candidate presets per call instead of
// hammering through every match it finds. getFrameThumbnail() still
// reports exactly what it tried and why it failed rather than just
// returning nothing - see README.md for how this is now wired into the UI
// (manual/opt-in only, never automatic on tab switch).

var _thumbPresetCache = null;   // null until findStillFramePresets() has run once this session
var _thumbCandidateOffset = 0;  // rotates which small batch of candidates gets tried next
var _thumbInProgress = false;
var _thumbLastAttemptMs = 0;
var THUMB_COOLDOWN_MS = 4000;        // matches the "don't call it repeatedly in quick succession" lesson above
var THUMB_MAX_CANDIDATES_PER_CALL = 3;
var THUMB_FS_VISIT_BUDGET = 8000;    // hard cap on files/folders touched per search, independent of the 300-match cap

function findFilesRecursive(folder, pattern, maxDepth, results, depth, budget) {
  if (depth > maxDepth || results.length > 300 || budget.count >= budget.max) return;
  var items;
  try { items = folder.getFiles(); } catch (e) { return; }
  for (var i = 0; i < items.length; i++) {
    budget.count++;
    if (budget.count >= budget.max) return;
    var item = items[i];
    if (item instanceof Folder) {
      findFilesRecursive(item, pattern, maxDepth, results, depth + 1, budget);
    } else if (item instanceof File && pattern.test(item.name)) {
      results.push(item.fsName);
    }
    if (results.length > 300) return;
  }
}

// Runs the recursive .epr search at most once per Premiere session - the
// result (top-level vars in a CEP host script persist for the life of the
// panel, per Adobe's own CEP HTML Extension Cookbook) is cached in
// _thumbPresetCache so every subsequent call is free instead of re-walking
// the whole Adobe application-support tree again.
function findStillFramePresets() {
  if (_thumbPresetCache) return _thumbPresetCache;

  var roots = [];
  if ($.os.indexOf("Windows") !== -1) {
    roots.push(new Folder("C:/Program Files/Common Files/Adobe"));
    roots.push(new Folder(Folder.appData.fsName + "/Adobe"));
  } else {
    roots.push(new Folder("/Library/Application Support/Adobe"));
  }

  var all = [];
  var budget = { count: 0, max: THUMB_FS_VISIT_BUDGET };
  for (var r = 0; r < roots.length; r++) {
    if (roots[r].exists) findFilesRecursive(roots[r], /\.epr$/i, 6, all, 0, budget);
  }

  var preferred = [];
  for (var i = 0; i < all.length; i++) {
    if (/png|jpe?g|still|frame/i.test(all[i])) preferred.push(all[i]);
  }
  _thumbPresetCache = { preferred: preferred, all: all };
  return _thumbPresetCache;
}

function getFrameThumbnail() {
  if (_thumbInProgress) {
    return "ERR|A frame preview export is already running - wait for it to finish before requesting another.";
  }
  var now = new Date().getTime();
  if (_thumbLastAttemptMs && (now - _thumbLastAttemptMs) < THUMB_COOLDOWN_MS) {
    var waitSec = Math.ceil((THUMB_COOLDOWN_MS - (now - _thumbLastAttemptMs)) / 1000);
    return "ERR|Frame preview is cooling down (calling Premiere's encoder repeatedly in quick succession is a known crash risk) - wait " + waitSec + "s and try again.";
  }

  _thumbInProgress = true;
  _thumbLastAttemptMs = now;
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

    // setInPoint() can succeed while the paired setOutPoint() throws (or vice
    // versa) - if that happens, don't return early leaving the sequence's
    // work area half-mutated (in point moved, out point untouched); restore
    // whatever original bounds we captured above before reporting the error.
    try { seq.setInPoint(playhead); seq.setOutPoint(playhead + frameDur * 2); }
    catch (e) {
      if (hadWorkArea) { try { seq.setInPoint(origIn); seq.setOutPoint(origOut); } catch (e2) {} }
      return "ERR|Could not set a work area on the sequence to export from: " + e.toString();
    }

    var found = findStillFramePresets();
    var full = found.preferred.length ? found.preferred : found.all;

    if (!full.length) {
      if (hadWorkArea) { try { seq.setInPoint(origIn); seq.setOutPoint(origOut); } catch (e) {} }
      return "ERR|No .epr export preset found under Adobe's application support folder on this machine.";
    }

    // Try only a small rotating batch per call (never the whole list) so one
    // request can't fire off a long back-to-back run of real encoder calls -
    // that repeated-call pattern is the documented crash trigger. If none of
    // this batch works, the NEXT call (after the cooldown) picks up where
    // this one left off, so repeated manual retries still eventually cover
    // every candidate rather than looping the same failing ones forever.
    var startIdx = _thumbCandidateOffset % full.length;
    var batch = [];
    var batchSize = Math.min(THUMB_MAX_CANDIDATES_PER_CALL, full.length);
    for (var bi = 0; bi < batchSize; bi++) batch.push(full[(startIdx + bi) % full.length]);
    _thumbCandidateOffset = (startIdx + batchSize) % full.length;

    var dest = new File(Folder.temp.fsName + "/pip_toolkit_thumb.png");
    if (dest.exists) { try { dest.remove(); } catch (e) {} }

    var success = false, lastErr = "", triedCount = 0;
    for (var i = 0; i < batch.length && !success; i++) {
      triedCount++;
      try {
        // ENCODE_WORKAREA is the documented/verified constant for "honor the
        // in/out points I just set" - see the block comment above this
        // function for why a guessed literal here is unsafe.
        seq.exportAsMediaDirect(dest.fsName, batch[i], app.encoder.ENCODE_WORKAREA);
        if (dest.exists) success = true;
      } catch (e) { lastErr = e.toString(); }
    }

    if (hadWorkArea) { try { seq.setInPoint(origIn); seq.setOutPoint(origOut); } catch (e) {} }

    if (success) return "OK|" + dest.fsName;
    return "ERR|Tried " + triedCount + " of " + full.length + " known export preset(s), none produced a file (hit refresh again to try the next batch). Last error: " + (lastErr || "(none thrown, file just never appeared)");
  } catch (e) {
    return "ERR|" + e.toString();
  } finally {
    _thumbInProgress = false;
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
    var zoomOut = String(zoomOutStr) === "1";

    var motion = getComponentByMatchName(item, "AE.ADBE Motion");
    if (!motion) return "ERR|Could not find the Motion effect on this clip.";
    var posParam = getParamByDisplayName(motion, "Position");
    var scaleParam = getParamByDisplayName(motion, "Scale") || getParamByDisplayName(motion, "Scale Height");
    if (!posParam || !scaleParam) return "ERR|Could not find Position/Scale on the Motion effect.";

    // IMPORTANT: the Motion effect's "Position" ComponentParam is set/read
    // through the scripting DOM as a fraction of the frame - [0,0] is the
    // top-left corner and [1,1] is the bottom-right corner - REGARDLESS of
    // sequence resolution. This is not what the Effect Controls panel shows
    // (it always displays pixels), and it's not how Scale works (Scale is a
    // plain percentage number), which is why only Position was silently
    // landing on Premiere's clamp/sentinel value: pixel-sized numbers like
    // 1920 are ~2000x too large for a parameter expecting 0..1, and every
    // one of those out-of-range calls clamped to the same 32767 (2^15-1)
    // ceiling regardless of which oversized pixel value was sent - hence
    // identical X/Y results no matter what "in range" pixel value was tried.
    // Verified against multiple independent real-world ExtendScript
    // examples/reports (Adobe Community threads on Position scripting) that
    // all set/get Position as e.g. [0.5, 0.5] for frame-center, never in
    // pixels. So all Position math here stays in normalized 0..1 space -
    // conveniently, px/py/pw/ph are already normalized, so no pixel
    // conversion is needed (or wanted) at all.
    var ncx = 0.5, ncy = 0.5;
    var ntx = clamp(px, 0, 1), nty = clamp(py, 0, 1);

    // Neutral framing (no pan, no zoom) - the frame's default Motion state.
    var neutralPos = [ncx, ncy];
    // Position that puts the clicked point (ntx,nty) dead-center at
    // full target scale. Only valid AT that scale - it is not a "keep this
    // point centered at every scale" formula, which is why the in-between
    // keyframes below interpolate the two positions directly instead of
    // recomputing this per intermediate scale.
    var zoomedPos = [ncx - scale * (ntx - ncx), ncy - scale * (nty - ncy)];

    function lerp(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }

    var playhead = seq.getPlayerPosition().seconds;
    var clipStart = item.start.seconds, clipEnd = item.end.seconds;
    var t0 = clamp(playhead - inSec, clipStart, clipEnd);
    var t1 = clamp(playhead, clipStart, clipEnd);

    var keyTime0 = setKeyframe(posParam, t0, neutralPos);
    setKeyframe(scaleParam, t0, 100);

    var steps = 6, i, f, e, s, tt, keyTimePeak;
    for (i = 1; i <= steps; i++) {
      f = i / steps;
      e = easeSample(f, easing);
      s = 1 + (scale - 1) * e;
      tt = t0 + (t1 - t0) * f;
      keyTimePeak = setKeyframe(posParam, tt, lerp(neutralPos, zoomedPos, e));
      setKeyframe(scaleParam, tt, s * 100);
    }

    if (zoomOut) {
      var t2 = clamp(t1 + holdSec, clipStart, clipEnd);
      var t3 = clamp(t2 + outSec, clipStart, clipEnd);
      setKeyframe(posParam, t2, zoomedPos);
      setKeyframe(scaleParam, t2, scale * 100);
      for (i = 1; i <= steps; i++) {
        f = i / steps;
        e = easeSample(f, easing);
        s = scale - (scale - 1) * e;
        tt = t2 + (t3 - t2) * f;
        setKeyframe(posParam, tt, lerp(zoomedPos, neutralPos, e));
        setKeyframe(scaleParam, tt, s * 100);
      }
    }

    // Read back what actually landed, rather than assuming the sets above
    // stuck - this is the hard evidence needed if the value is still wrong.
    var readback0 = readParamValue(posParam, keyTime0);
    var readbackPeak = readParamValue(posParam, keyTimePeak);
    return "OK|debug:intended0=" + fmtVal(neutralPos) + " actual0=" + fmtVal(readback0) +
      " intendedPeak=" + fmtVal(zoomedPos) + " actualPeak=" + fmtVal(readbackPeak);
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
    var magnify = String(magnifyStr) === "1";
    var magnifyScale = parseFloat(magnifyPctStr) / 100;
    var dim = clamp(parseFloat(dimStr), 0, 100);
    var border = String(borderStr) === "1";
    var borderPx = parseFloat(borderPxStr);
    var glow = String(glowStr) === "1";
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
    // matchName is "AE.ADBE AECrop" (NOT "AE.ADBE Crop" - that string matches
    // nothing, which silently made every crop no-op: getComponentByMatchName()
    // never found the just-added effect back, so cropComp came back null and
    // the whole reveal step got skipped every time). Verified against a real
    // Premiere-exported preset (AE.ADBE AECrop / display name "Crop") and
    // multiple independent open-source Premiere automation tools that all
    // agree on this exact string.
    //
    // Its four sub-parameters are also NOT called "Left"/"Top"/"Right"/
    // "Bottom" - Premiere's actual display names are "Crop Left"/"Crop Top"/
    // "Crop Right"/"Crop Bottom" (confirmed the same way: a captured Premiere
    // preset export, an independent open-source OTIO/Premiere exporter, and
    // two independent CEP-panel projects' live-probed param tables all agree).
    // With the old bare names every getParamByDisplayName() call below
    // returned null too, so this was a second, compounding cause of the same
    // "crop never actually happens" failure.
    var cropComp = addFilterByMatchName(seq, dup, "AE.ADBE AECrop", "Crop");
    if (cropComp) {
      var pLeft = getParamByDisplayName(cropComp, "Crop Left");
      var pTop = getParamByDisplayName(cropComp, "Crop Top");
      var pRight = getParamByDisplayName(cropComp, "Crop Right");
      var pBottom = getParamByDisplayName(cropComp, "Crop Bottom");
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
          // Position is normalized 0..1 (see the note in applyZoom()) - px/py/pw/ph
          // are already fractions of the frame, so no pixel conversion here either.
          var ncx = 0.5, ncy = 0.5;
          var boxCx = px + pw / 2, boxCy = py + ph / 2;
          var neutralPos2 = [ncx, ncy];
          var magnifiedPos = [ncx - magnifyScale * (boxCx - ncx), ncy - magnifyScale * (boxCy - ncy)];
          function lerp2(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }
          setKeyframe(posP, t0, neutralPos2);
          setKeyframe(scaleP, t0, 100);
          for (var k = 1; k <= 6; k++) {
            var fk = k / 6, ek = easeSample(fk, "easeInOut");
            var sk = 1 + (magnifyScale - 1) * ek;
            setKeyframe(posP, t0 + (t1 - t0) * fk, lerp2(neutralPos2, magnifiedPos, ek));
            setKeyframe(scaleP, t0 + (t1 - t0) * fk, sk * 100);
          }
          setKeyframe(posP, t2, magnifiedPos);
          setKeyframe(scaleP, t2, magnifyScale * 100);
          setKeyframe(posP, t3, neutralPos2);
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
    // `dup` (the duplicate clip created above via overwriteClip) is a `var`,
    // so it's still in scope here even though it's assigned inside the try
    // block - if an exception hit anywhere after it was created (e.g. a
    // setValueAtKey() call throwing because a lookup upstream returned a
    // stale/wrong param), don't leave an orphaned duplicate clip sitting on
    // the timeline with nothing to point the user at it; best-effort remove
    // it before reporting the error.
    if (typeof dup !== "undefined" && dup) {
      try { dup.remove(false, false); } catch (e2) { /* best effort only */ }
    }
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

    // Position is normalized 0..1, not pixels (see the note in applyZoom()) -
    // so the preset table and the custom px/py input stay in that space and
    // are never multiplied out to frame dimensions.
    var margin = 0.06;
    var presets = {
      tl: [margin, margin], tc: [0.5, margin], tr: [1 - margin, margin],
      cl: [margin, 0.5], cc: [0.5, 0.5], cr: [1 - margin, 0.5],
      bl: [margin, 1 - margin], bc: [0.5, 1 - margin], br: [1 - margin, 1 - margin]
    };
    var ncx, ncy;
    if (preset === "custom" || !presets[preset]) {
      ncx = clamp(parseFloat(pxStr), 0, 1); ncy = clamp(parseFloat(pyStr), 0, 1);
    } else {
      ncx = presets[preset][0]; ncy = presets[preset][1];
    }
    var scale = clamp(parseFloat(scalePctStr), 5, 400);
    var borderOn = String(borderStr) === "1", borderPx = parseFloat(borderPxStr);
    var glowOn = String(glowStr) === "1";
    var shadowOn = String(shadowStr) === "1";
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
      posP.setValue([ncx, ncy], true);
      scaleP.setValue(scale, true);
    } else if (animStyle === "slide") {
      var offX = ncx, offY = ncy;
      var edgeDist = 0.35;
      if (ncx < 0.5) offX = -edgeDist; else if (ncx > 0.5) offX = 1 + edgeDist;
      if (ncy < 0.5 && ncx === 0.5) offY = -edgeDist; else if (ncy > 0.5 && ncx === 0.5) offY = 1 + edgeDist;
      setKeyframe(posP, t0, [offX, offY]);
      setKeyframe(scaleP, t0, scale);
      for (var i = 1; i <= 6; i++) {
        var f = i / 6, e = easeSample(f, "easeOut");
        setKeyframe(posP, t0 + (t1 - t0) * f, [offX + (ncx - offX) * e, offY + (ncy - offY) * e]);
        setKeyframe(scaleP, t0 + (t1 - t0) * f, scale);
      }
    } else if (animStyle === "pop") {
      setKeyframe(posP, t0, [ncx, ncy]);
      setKeyframe(scaleP, t0, Math.max(1, scale * 0.02));
      for (var j = 1; j <= 6; j++) {
        var f2 = j / 6, e2 = easeSample(f2, "easeOut");
        setKeyframe(posP, t0 + (t1 - t0) * f2, [ncx, ncy]);
        setKeyframe(scaleP, t0 + (t1 - t0) * f2, Math.max(1, scale * 0.02) + (scale - Math.max(1, scale * 0.02)) * e2);
      }
    } else if (animStyle === "fade") {
      posP.setValue([ncx, ncy], true);
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
