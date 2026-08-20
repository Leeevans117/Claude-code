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

// Same idea as getComponentByMatchName(), but by the component's displayName
// instead - used as a fallback when a guessed matchName turns out wrong (see
// addFilterByMatchName()'s post-add lookup). displayName is localized, so
// this is only a safety net for the single-Locale "All"/English case this
// panel already assumes elsewhere (see manifest.xml), not a general
// replacement for matchName lookups.
function getComponentByDisplayName(trackItem, displayName) {
  var comps = trackItem.components;
  for (var i = 0; i < comps.numItems; i++) {
    if (comps[i].displayName === displayName) return comps[i];
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

// PLAYBACK-SMOOTHNESS FIX (interpolation type):
// ------------------------------------------------------------------------
// After applyZoom()'s wrong-clip/int16-clamp bugs were fixed and confirmed
// (7 keyframes now write correct values to the correct clip's Position/
// Scale), the clip still visibly hard-cut straight to the zoomed-in framing
// instead of ramping. The values were right; the MOTION wasn't. That points
// at keyframe INTERPOLATION TYPE, not keyframe VALUES.
//
// Confirmed, not guessed: ComponentParam has a real, documented method for
// this - setInterpolationTypeAtKey(time, interpolationType, [updateUI]) -
// verified directly against the official Premiere Pro Scripting Guide
// (docsforadobe/premiere-scripting-guide, docs/sequence/componentparam.md,
// cloned and read directly from GitHub, not taken from a paraphrase), which
// documents this exact signature and this exact numeric enum:
//   0 KF_Interp_Mode_Linear   4 KF_Interp_Mode_Hold      6 KF_Interp_Mode_Time
//   1 kfInterpMode_EaseIn_Obsolete   5 KF_Interp_Mode_Bezier
//   2 kfInterpMode_EaseOut_Obsolete  7 kfInterpMode_TimeTransitionStart
//   3 kfInterpMode_EaseInEaseOut_Obsolete  8 kfInterpMode_TimeTransitionEnd
// Independently confirmed as a real, live call against a real Premiere
// ComponentParam (not an After Effects-only lookalike, and not a doc typo)
// via Adobe's own official first-party sample - github.com/Adobe-CEP/Samples,
// PProPanel/jsx/PPRO/Premiere.jsx, fetched and read directly - which contains
// the live (non-commented) call `blurriness.setInterpolationTypeAtKey(thisKey,
// 4, true)` against a Motion-effect-style ComponentParam obtained the same
// way posParam/scaleParam are obtained here, using the exact (time, type,
// updateUI) argument shape docsforadobe documents. That same file's
// commented-out alternate code path calls addKey()/setValueAtKey() and THEN
// setInterpolationTypeAtKey(time, 5 /* Bezier */, true) as a separate,
// deliberate step - i.e. even Adobe's own sample author's working pattern
// treats "make it smooth" as something you must ask for explicitly after
// creating the keyframe, not something addKey()/setValueAtKey() hand you for
// free. A second, independently-found real snippet (an Adobe Community
// reply, reachable only via search-engine cache in this environment since
// community.adobe.com itself is blocked by network egress policy here - see
// below) shows the identical pattern for a Position param specifically:
// setTimeVarying(true); addKey(t); setValueAtKey(t, value); THEN
// setInterpolationTypeAtKey(t, 5, 1) as its own explicit call.
//
// NOT independently confirmed: no source reachable from this environment
// states in so many words "a keyframe Premiere creates via addKey() defaults
// to Hold." The community.adobe.com threads most likely to say that outright
// (e.g. "trouble with setValueAtKey and setInterpolationTypeAtKey for scale
// keyframes in Premiere Pro ExtendScript") are blocked by this session's
// network egress policy and could not be opened directly, only summarized
// third-hand by a search tool - not trustworthy enough to state as fact here.
//
// Given that gap, this does NOT gamble on Hold specifically being the
// default and does NOT gamble on Bezier (value 5) being a safe blind choice
// either - Bezier's auto-computed tangents are a Premiere/After-Effects UI
// convenience for hand-placed keyframes, not verified to reproduce the
// custom per-style easeSample() curve (linear/easeIn/easeOut/easeInOut) this
// file already samples by hand into 7 keyframes. Instead every keyframe this
// file ever writes is forced to Linear (0) - confirmed real and the first
// value in the documented enum above - immediately after its value is set.
// Linear interpolation between two correctly-valued, correctly-timed
// keyframes is a plain straight-line ramp with no jump, no matter what the
// unconfirmed default turns out to be, and it exactly preserves the eased
// curve shape already computed by hand-sampling 7 points along it (that
// sampling becomes 6 short straight segments instead of 1 continuous Bezier
// curve - visually indistinguishable at video frame rates for a sub-1-second
// ramp). This is the single most load-bearing fix for the reported symptom.
//
// This function is the ONLY place every keyframe in this file gets written
// (applyZoom's ramp, applyHighlight's crop/dim/magnify/opacity, applyOverlay's
// slide/pop/fade) - so fixing it here fixes all three tools identically,
// per the same "same pattern likely needs applying elsewhere" reasoning.
var KF_INTERP_LINEAR = 0; // KF_Interp_Mode_Linear - see comment block above

// Diagnostics companion to the fix above: there is no documented
// getInterpolationTypeAtKey() to read this back afterward and PROVE it stuck
// (confirmed by checking - the official scripting guide's full ComponentParam
// method list, reproduced in the comment above, has no such getter). The best
// available evidence is whether the setInterpolationTypeAtKey() CALL ITSELF
// throws or not, tallied here and reported in each tool's return string so
// the next live test shows directly whether this fix could even attempt to
// apply, rather than silently assuming it worked. Reset to 0 by each public
// entry point (applyZoom/applyHighlight/applyOverlay) before its first
// setKeyframe() call.
var _interpSetOkCount = 0;
var _interpSetFailCount = 0;

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
  // Force Linear interpolation on this keyframe - see the large comment
  // block above setKeyframe() for why, and why Linear (not Bezier) was
  // chosen. Wrapped defensively: setInterpolationTypeAtKey() is documented
  // as usable "only ... with keyframeable parameter streams," the same
  // caveat addKey()/setValueAtKey() carry, so a param that accepted those
  // two calls should accept this one too - but nothing here assumes that
  // holds on every Premiere version, hence the counted, non-fatal try/catch.
  try {
    param.setInterpolationTypeAtKey(keyTime, KF_INTERP_LINEAR, true);
    _interpSetOkCount++;
  } catch (eInterp) {
    _interpSetFailCount++;
  }
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

// Counts keyframes on a param, however this Premiere version exposes that -
// used to tell "nothing was ever keyframed" apart from "keyframes were
// written somewhere, but not where the user is looking." -1 means this
// Premiere version doesn't expose a way to ask.
function numKeysOf(param) {
  try { if (typeof param.getKeys === "function") return param.getKeys().length; } catch (e) {}
  return -1;
}

// Caches whether app.enableQE() has already succeeded once in this Premiere
// session, so addFilterByMatchName() (called on every Highlight/Overlay
// effect add) and getFrameThumbnail() (called on every manual preview
// refresh) don't each call the real app.enableQE() API fresh on every single
// invocation. This is NOT a confirmed fix for any specific crash - no
// documented source was found showing repeated app.enableQE() calls
// destabilize a session (see the investigation notes near getFrameThumbnail
// and applyZoom for what was and wasn't found) - it's a plain, low-risk
// reduction in how often an unsupported/undocumented API gets re-invoked,
// independent of the confirmed-working keyframe math elsewhere in this file
// and safe regardless of whether QE call frequency turns out to matter:
// enableQE() only flips on access to the QE layer itself, it doesn't hand
// back project- or sequence-specific objects (those are still re-fetched
// fresh via qe.project.getActiveSequence() on every call, unaffected by this
// cache), so there's no risk of this reintroducing the kind of stale-object
// bug real-world reports describe when QE objects are cached ACROSS a
// project switch.
var _qeEnabledOnce = false;
function ensureQE() {
  if (_qeEnabledOnce) return true;
  app.enableQE();
  _qeEnabledOnce = true;
  return true;
}

function trySetColor(component, displayName, hex) {
  try {
    var p = getParamByDisplayName(component, displayName);
    if (!p) return false;
    p.setValue(hexToColorNum(hex), true);
    return true;
  } catch (e) { return false; }
}

// Set by getTargetTrackItem() on every call to record HOW it picked the clip
// it returned - "selection" (explicit Timeline selection) vs
// "playhead-fallback" (nothing selected, so it grabbed whatever's under the
// playhead) vs "none". This matters because Premiere's Effect Controls panel
// tracks the Timeline SELECTION, not the playhead - if a tool runs via the
// fallback path, it can keyframe a different clip than the one currently
// showing in Effect Controls, which would look exactly like "nothing
// happened" even though real keyframes were written correctly elsewhere.
// See the caller-side debug strings that report this alongside which clip
// (name/track/start) actually got targeted.
var _lastTargetSource = "(not yet called)";

// Locates the clip to operate on: the current timeline selection (first
// video item) if there is one, otherwise the topmost video-track item
// sitting under the playhead.
function getTargetTrackItem(seq) {
  try {
    var sel = seq.getSelection();
    if (sel && sel.length) {
      for (var i = 0; i < sel.length; i++) {
        if (sel[i].mediaType === "Video") { _lastTargetSource = "selection"; return sel[i]; }
      }
    }
  } catch (e) { /* getSelection() not available on very old versions */ }

  _lastTargetSource = "playhead-fallback";
  var playhead = seq.getPlayerPosition().seconds;
  for (var t = seq.videoTracks.numTracks - 1; t >= 0; t--) {
    var track = seq.videoTracks[t];
    for (var c = 0; c < track.clips.numItems; c++) {
      var clip = track.clips[c];
      if (clip.start.seconds <= playhead && clip.end.seconds > playhead) return clip;
    }
  }
  _lastTargetSource = "none-found";
  return null;
}

// Describes what's currently selected in the Timeline, independent of what
// getTargetTrackItem() actually targeted. Effect Controls always displays
// keyframes for the Timeline SELECTION, not for whatever a tool operated on
// - so when _lastTargetSource is "playhead-fallback", real keyframes can
// land on a clip that isn't the one Effect Controls is showing, and it looks
// exactly like nothing happened. Reporting the current selection explicitly
// alongside the targeted clip (see applyZoom()'s debug string) means a
// mismatch is stated outright, not something the user has to infer from
// "via playhead-fallback" on its own.
function describeSelection(seq) {
  try {
    var sel = seq.getSelection();
    if (!sel || !sel.length) return "(nothing selected in Timeline)";
    var names = [];
    for (var i = 0; i < sel.length; i++) {
      names.push(String(sel[i].name).replace(/\|/g, "-") + (sel[i].mediaType ? " [" + sel[i].mediaType + "]" : ""));
    }
    return names.join(", ");
  } catch (e) {
    return "(unreadable: " + e.toString() + ")";
  }
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
//
// NOTE ON matchName CORRECTNESS: this is exactly the class of bug that
// silently broke the Crop effect earlier ("AE.ADBE Crop" was wrong - the
// real value is "AE.ADBE AECrop" - so the just-added effect could never be
// found again by matchName and every downstream property-set silently
// no-opped while a bare, uncustomized effect sat on the clip). The
// matchNames below other than Alpha Glow are independently confirmed:
// Crop ("AE.ADBE AECrop") against a real captured Premiere preset export and
// an independent open-source Premiere-automation project's source
// (hetpatel-11/adobe_premiere_pro_mcp, matches this exact string); Bevel
// Edges ("AE.ADBE Bevel Edges") and Drop Shadow ("AE.ADBE Drop Shadow")
// against the official docsforadobe/after-effects-scripting-guide
// first-party effect matchName table (both listed there verbatim, with
// display names "Bevel Edges"/"Drop Shadow" matching what's passed as
// effectName here).
//
// Alpha Glow is NOT independently confirmed and is specifically suspected
// wrong: it does not appear anywhere in that same official AE first-party
// matchName table (Crop/Bevel Edges/Drop Shadow/Brightness & Contrast all
// do), which fits Alpha Glow being a Premiere-only effect never shared with
// After Effects - and Premiere-only effects use a different prefix. Confirmed
// real examples of that other prefix, straight from Adobe's own official UXP
// API docs (github.com/AdobeDocs/uxp-premiere-pro, ppro-reference/classes/
// videofilterfactory.md, fetched and read directly): "the match name of the
// component to create, example 'PR.ADBE Solarize', 'AE.ADBE Mosaic' etc." -
// Solarize, like Alpha Glow, is a classic Premiere-only stylize effect, and
// it's "PR.ADBE", not "AE.ADBE". Two independent searches turned up a claim
// that Alpha Glow's real matchName is "PR.ADBE Alpha Glow" (sourced from the
// community "Premiere v12 Effect Component Documentation" PDF), consistent
// with this pattern - but that PDF's host is blocked by this environment's
// network egress policy, so this could not be read directly and confirmed
// the way the others were. Rather than swap one unverified guess
// ("AE.ADBE Alpha Glow") for another ("PR.ADBE Alpha Glow"), the lookup
// below is made robust to either being wrong: if the matchName lookup can't
// find the component QE just added, fall back to finding it by displayName
// instead (which only depends on effectName - the string already confirmed
// correct, since it's what qe.project.getVideoEffectByName() used to add the
// effect in the first place). This fixes the failure mode regardless of
// which matchName string turns out to be right, rather than betting on an
// unconfirmed replacement.
function addFilterByMatchName(seq, trackItem, matchName, effectName) {
  var existing = getComponentByMatchName(trackItem, matchName) || getComponentByDisplayName(trackItem, effectName);
  if (existing) return existing;
  try {
    ensureQE();
    var vIdx = trackIndexOf(seq, trackItem);
    var cIdx = clipIndexOf(seq.videoTracks[vIdx], trackItem);
    var qeSeq = qe.project.getActiveSequence();
    var qeTrack = qeSeq.getVideoTrackAt(vIdx);
    var qeItem = qeTrack.getItemAt(cIdx);
    var qeEffect = qe.project.getVideoEffectByName(effectName);
    if (!qeEffect) return null;
    qeItem.addVideoFilter(qeEffect);
    return getComponentByMatchName(trackItem, matchName) || getComponentByDisplayName(trackItem, effectName);
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

// HISTORY / WHY THIS CHANGED: the previous version of this function called
// Premiere's real encoder (Sequence.exportAsMediaDirect) with an .epr export
// preset found by recursively searching the whole Adobe application-support
// folder for a filename that looked like a still-image preset. That had two
// stacked risk sources: (a) exportAsMediaDirect() is a real, documented
// synchronous call into Premiere's encoder pipeline on the live sequence,
// and there's a reproducible Adobe Community report of Premiere crashing
// roughly 1 in 3 times when it's called repeatedly in quick succession
// (community.adobe.com "premiere crashes sporadically when using sequence
// exportasmediadirect", question 685820); (b) the preset it fed to that call
// was never actually verified - just whatever filename matched a regex on
// the user's own machine, with unknown codec/bit depth/resolution. Re-export
// research (2026) turned up a materially safer, still-real primitive that
// removes both of those risk sources instead of just mitigating them.
//
// THE REPLACEMENT: Premiere's "QE" (Quality Engineering) automation DOM -
// the same undocumented-but-long-standing layer this file already uses
// elsewhere for addFilterByMatchName() - exposes
// qe.project.getActiveSequence().exportFramePNG(timecode, filePath). This:
//   - needs NO export preset at all (no filesystem search, no shipped .epr,
//     nothing to fail to verify) - it's a direct "rasterize this one frame
//     to a PNG" call, not a run through the encoder-preset pipeline;
//   - takes an explicit timecode argument, so it needs no sequence in/out
//     point mutation (the old code had to set + restore a work area, with a
//     documented half-mutated-state failure mode if only one of those calls
//     threw - that entire risk category is gone too);
//   - is real: it ships in Adobe's own official sample
//     (github.com/Adobe-CEP/Samples, TypeScript/PProPanel-vscode/dom_app/src/
//     Premiere.jsx, function exportCurrentFrameAsPNG - fetched and read
//     directly, not taken on faith) which calls exactly
//     `app.enableQE(); qe.project.getActiveSequence().exportFramePNG(
//     activeSequence.CTI.timecode, outputFileName)`, and independently
//     appears with the identical signature in the community-maintained
//     type definitions at github.com/aenhancers/types-for-adobe-extras,
//     path Premiere/12.0/qeDom.d.ts (version "12.0" - the same CEP
//     generation this panel targets): `exportFramePNG(timecode: string,
//     filePath: string): any` on the QE Sequence interface, alongside
//     `CTI: QETime` / `QETime.timecode: string`. A third, independent data
//     point: github.com/Adobe-CEP/Samples issue #129 is a real bug report
//     from someone using this exact call in a shipped panel (about the CTI
//     timecode string needing to stay unmodified when passed to
//     exportFramePNG, even though a sanitized copy is used for the output
//     filename - the fix applied below).
//   - is NOT in Adobe's officially documented scripting guide (confirmed by
//     directly reading Adobe's own generated API reference,
//     Adobe-CEP/Samples TypeScript/PProPanel-vscode/payloads/api_doc.html,
//     which documents exportAsMediaDirect and app.encoder in detail but has
//     no exportFramePNG entry anywhere) - same "QE DOM" caveat as
//     addFilterByMatchName() elsewhere in this file: unsupported, but a
//     long-established real pattern, not a guess.
//   - has one confirmed compatibility caveat: Adobe Community reports place
//     it working from Premiere 2021 (v15) through at least v25.3 (2025) in
//     real panels; a report against v14.x describes a "Run Script Error /
//     undefined is not an object" for this call, which this function
//     detects (typeof check below) and reports clearly rather than
//     assuming it will work. This panel's manifest currently allows down to
//     v14.0 - if that's the Premiere version in use, expect getFrameThumbnail()
//     to report unavailability rather than produce a preview.
//
// ENCODE_WORKAREA RE-VERIFICATION (asked for explicitly, since this
// function no longer uses it but applyOverlay/applyZoom-adjacent code
// elsewhere in the project history relied on the same encoder constants
// being real): app.encoder.ENCODE_WORKAREA is confirmed as one of exactly
// three valid workAreaType values (ENCODE_WORKAREA / ENCODE_ENTIRE /
// ENCODE_IN_TO_OUT) for Sequence.exportAsMediaDirect() and
// app.encoder.encodeSequence(), independently via (1) Adobe's own generated
// api_doc.html referenced above, which documents
// `exportAsMediaDirect(outputFilePath, outputPresetPath, workAreaType)` and
// states workAreaType "can be ENCODE_WORKAREA, ENCODE_ENTIRE, or
// ENCODE_IN_TO_OUT", and (2) pymiere (github.com/qmasingarbe/pymiere), a
// third-party Python wrapper around this exact ExtendScript API, whose docs
// demonstrate calling it as the named property
// `pymiere.objects.app.encoder.ENCODE_ENTIRE` (i.e. confirmed to be
// accessed as a named constant on the encoder object, not a numeric literal
// someone guessed at). Not currently called anywhere in this file, but
// confirmed real should a future feature need it - use the named constant,
// never a bare literal ordinal.
//
// This is still an undocumented API and still hasn't been confirmed to
// produce a working PNG on a real Premiere install - only confirmed to be a
// real, Adobe-sample-verified call rather than a guess. It's kept
// manual/opt-in only (never automatic on tab switch or the periodic context
// refresh - see refreshThumbnail() in main.js) with an in-flight guard and a
// short cooldown as a precaution, even without a specific crash report tied
// to exportFramePNG the way the old exportAsMediaDirect path had one -
// there's simply no affirmative evidence this QE call is safe to hammer
// repeatedly either, and it still runs on the live sequence.

var _thumbInProgress = false;
var _thumbLastAttemptMs = 0;
var THUMB_COOLDOWN_MS = 1500; // debounce only (no confirmed repeat-call crash report for exportFramePNG) - see note above

function getFrameThumbnail() {
  if (_thumbInProgress) {
    return "ERR|A frame preview export is already running - wait for it to finish before requesting another.";
  }
  var now = new Date().getTime();
  if (_thumbLastAttemptMs && (now - _thumbLastAttemptMs) < THUMB_COOLDOWN_MS) {
    var waitSec = Math.ceil((THUMB_COOLDOWN_MS - (now - _thumbLastAttemptMs)) / 1000) || 1;
    return "ERR|Frame preview is cooling down - wait " + waitSec + "s and try again.";
  }

  _thumbInProgress = true;
  _thumbLastAttemptMs = now;
  try {
    getActiveSeq(); // throws its own clear message if there's no active sequence

    try {
      ensureQE();
    } catch (e) {
      return "ERR|Could not enable Premiere's QE automation layer (needed for the live preview): " + e.toString();
    }
    if (typeof qe === "undefined" || !qe || !qe.project) {
      return "ERR|Premiere's QE automation layer isn't available in this Premiere version - live preview can't work here.";
    }

    var qeSeq;
    try { qeSeq = qe.project.getActiveSequence(); } catch (e) { qeSeq = null; }
    if (!qeSeq) {
      return "ERR|Could not get the active sequence through Premiere's QE automation layer.";
    }
    if (typeof qeSeq.exportFramePNG !== "function") {
      return "ERR|This Premiere version's QE automation layer has no exportFramePNG call - live preview needs Premiere 2021 (v15) or newer.";
    }

    var timecode;
    try { timecode = qeSeq.CTI.timecode; } catch (e) {
      return "ERR|Could not read the current playhead timecode: " + e.toString();
    }

    // exportFramePNG's filePath argument takes no extension - it appends
    // ".png" itself (matches Adobe's own sample, which passes a bare path).
    // A Premiere 25.3 Community report describes that specific build adding
    // an extra ".png" on top of that, so rather than assume either behavior
    // this checks every plausible resulting filename and uses whichever one
    // actually exists after the call, instead of guessing which one Premiere
    // used on this build.
    var destBase = Folder.temp.fsName + "/pip_toolkit_thumb";
    var candidates = [destBase, destBase + ".png", destBase + ".png.png"];
    for (var ci = 0; ci < candidates.length; ci++) {
      var stale = new File(candidates[ci]);
      if (stale.exists) { try { stale.remove(); } catch (e) {} }
    }

    var callErr = "";
    try {
      // IMPORTANT: pass the timecode string exactly as read from CTI -
      // Adobe-CEP/Samples issue #129 documents a real bug where a Premiere
      // panel sanitized this string (replacing ":"/";" with "_" for
      // filename safety) and then passed the SANITIZED string to
      // exportFramePNG instead of the original, breaking the export. The
      // sanitizing (if any were needed) belongs only on the filename, which
      // here is a fixed literal anyway - so no sanitizing is needed at all.
      qeSeq.exportFramePNG(timecode, destBase);
    } catch (e) {
      callErr = e.toString();
    }

    // exportFramePNG is explicitly documented as NOT synchronous - the
    // community type definitions this function's design is sourced from
    // (aenhancers/types-for-adobe-extras, Premiere/12.0/qeDom.d.ts, fetched
    // and read directly) carry the comment "WARNING : all exportFrame()
    // functions are NOT synchronous" right on this method's declaration.
    // Checking File.exists exactly once immediately after the call (the
    // previous version of this function) can catch the export mid-flight
    // and report a false "no file produced" failure even though the file
    // would have appeared moments later. Poll instead, up to a bounded
    // timeout, using ExtendScript's blocking $.sleep() - a real, standard
    // part of the ExtendScript "$" debugging object (confirmed via multiple
    // independent scripting references documenting e.g. "$.sleep(5000); //
    // wait 5 seconds"), not a Premiere-specific or guessed API.
    var found = null;
    var pollDeadlineMs = new Date().getTime() + 3000; // 3s: generous for one PNG frame, still bounded
    while (!found && new Date().getTime() < pollDeadlineMs) {
      for (var fi = 0; fi < candidates.length; fi++) {
        var f = new File(candidates[fi]);
        if (f.exists) { found = f.fsName; break; }
      }
      if (!found) { try { $.sleep(150); } catch (eSleep) { break; } }
    }

    // Same qeDom.d.ts comment also separately documents (distinct from the
    // issue #129 filename gotcha above): "Format may require replacing
    // [semi-]colons (';:') with underscores ('_')" for the TIMECODE
    // ARGUMENT itself on some Premiere builds. Unconfirmed which builds -
    // rather than guess and switch the format outright, try it only as a
    // fallback after the documented-correct form has had its full timeout
    // to work, and never touch destBase/candidates (the output path) here
    // so this fallback can't reintroduce the #129 bug.
    if (!found) {
      var altTimecode = String(timecode).replace(/[:;]/g, "_");
      if (altTimecode !== timecode) {
        try { qeSeq.exportFramePNG(altTimecode, destBase); } catch (eAlt) { callErr = callErr || eAlt.toString(); }
        var altDeadlineMs = new Date().getTime() + 3000;
        while (!found && new Date().getTime() < altDeadlineMs) {
          for (var fj = 0; fj < candidates.length; fj++) {
            var f2 = new File(candidates[fj]);
            if (f2.exists) { found = f2.fsName; break; }
          }
          if (!found) { try { $.sleep(150); } catch (eSleep2) { break; } }
        }
      }
    }

    if (found) return "OK|" + found;
    return "ERR|exportFramePNG did not produce a file within " +
      "~6s (tried both the original and underscore-sanitized timecode formats)" +
      (callErr ? " (" + callErr + ")" : " (no error thrown, file just never appeared)") + ".";
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

    // Reset the interpolation-fix diagnostics counters (see setKeyframe())
    // for this run, before any setKeyframe() call below.
    _interpSetOkCount = 0;
    _interpSetFailCount = 0;

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

    // Identify exactly which clip this run targeted, and how it was chosen -
    // Effect Controls only ever displays keyframes for the Timeline's actual
    // SELECTED clip, so if _lastTargetSource is "playhead-fallback" and that
    // resolves to a clip other than the one the user is looking at (e.g. a
    // leftover duplicate from earlier Highlight testing on another track),
    // everything below can work perfectly and still look like nothing
    // happened. Reported in the debug string so this is checkable, not
    // assumed.
    var targetTrackIdx = trackIndexOf(seq, item);
    var targetDesc = String(item.name).replace(/\|/g, "-") + " (track " + targetTrackIdx +
      ", " + item.start.seconds.toFixed(3) + "-" + item.end.seconds.toFixed(3) + "s, via " + _lastTargetSource + ")";
    // Stated explicitly, not left for the user to infer from "via
    // playhead-fallback" alone: what the Timeline SELECTION actually is
    // right now, since that (not the targeted clip) is what Effect Controls
    // will display. When the two differ, this is spelled out in plain
    // language at the very front of the return string so it can't be missed
    // even if the status bar truncates the rest.
    var selectionDesc = describeSelection(seq);
    var mismatchWarning = (_lastTargetSource !== "selection")
      ? "MISMATCH RISK: this run targeted " + targetDesc + " but the Timeline selection is " + selectionDesc +
        " - Effect Controls shows keyframes for the SELECTION, so if that's not the clip you were watching, click on " + targetDesc + " in the Timeline to see the new keyframes. "
      : "";

    var keyTime0 = setKeyframe(posParam, t0, neutralPos);
    setKeyframe(scaleParam, t0, 100);

    // Read back and check time-varying state immediately after the very
    // FIRST keyframe write, before the ramp loop runs any further sets -
    // this tells apart "it never stuck in the first place" from "it stuck
    // here, then something later in this same run clobbered it."
    var isTimeVaryingAfterFirst;
    try { isTimeVaryingAfterFirst = posParam.isTimeVarying(); } catch (e) { isTimeVaryingAfterFirst = "(unreadable)"; }
    var readbackFirst = readParamValue(posParam, keyTime0);

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
    //
    // HOW TO READ actual0/actualPeak IF THE PANEL STILL LOOKS FROZEN AT
    // DEFAULTS NEXT TIME: worked through by hand, not guessed. The very last
    // posParam write in this run (last iteration of the ramp-in loop above,
    // when zoomOut is off) always sets zoomedPos - a computed, non-default
    // value that depends on the click point and scale - never the frame-
    // center default. That's true whether or not the parameter actually
    // ended up time-varying: even if isTimeVarying somehow silently failed
    // and every setValueAtKey() call behaved like a plain last-write-wins
    // set instead of a real keyframe, the value it would freeze at is still
    // zoomedPos, not the default. So:
    //   - actualPeak != intendedPeak AND actualPeak == the true Motion
    //     default ([0.5,0.5]/100%): the writes are not landing on THIS
    //     param/clip at all (see mismatchWarning above - wrong-clip is the
    //     leading explanation, since a silent isTimeVarying failure would
    //     still show a non-default frozen value, not the exact default).
    //   - actualPeak == intendedPeak but the value is still frozen across
    //     the WHOLE clip when scrubbing in Premiere: the write stuck as a
    //     static override rather than a real keyframe (isTimeVarying did
    //     not actually take), which isTimeVaryingFinal below should also
    //     show as false.
    //   - actualPeak == intendedPeak and isTimeVaryingFinal is true but
    //     Premiere still shows no animation: look at posKeyCount - if it's
    //     much higher than the ~7-13 keys this run should have added, stale
    //     keyframes from an earlier test run may be interleaved and worth
    //     clearing first.
    var readback0 = readParamValue(posParam, keyTime0);
    var readbackPeak = readParamValue(posParam, keyTimePeak);
    var posKeyCount = numKeysOf(posParam);
    var scaleKeyCount = numKeysOf(scaleParam);
    var isTimeVaryingFinal;
    try { isTimeVaryingFinal = posParam.isTimeVarying(); } catch (e) { isTimeVaryingFinal = "(unreadable)"; }

    // interpLinearSetOk/interpLinearSetFail: see the KF_INTERP_LINEAR / setKeyframe()
    // comment block near the top of this file. If interpLinearSetFail is 0 and
    // interpLinearSetOk roughly matches posKeyCount+scaleKeyCount, the explicit
    // Linear-interpolation fix was actually applied to every keyframe this run
    // wrote, and a still-hard-cutting clip after this points at something other
    // than interpolation type. If interpLinearSetFail > 0, this Premiere
    // version's setInterpolationTypeAtKey() rejected some/all calls (report the
    // count so that's visible, not silently swallowed) and the ramp is still
    // riding on whatever Premiere's real default interpolation is.
    return "OK|debug:" + mismatchWarning + "target=" + targetDesc +
      " currentSelection=" + selectionDesc +
      " t0=" + t0.toFixed(3) + " t1=" + t1.toFixed(3) +
      " neutralPos=" + fmtVal(neutralPos) + " zoomedPos=" + fmtVal(zoomedPos) +
      " isTimeVaryingAfterFirstKey=" + fmtVal(isTimeVaryingAfterFirst) +
      " isTimeVaryingFinal=" + fmtVal(isTimeVaryingFinal) +
      " readbackImmediatelyAfterFirstKey=" + fmtVal(readbackFirst) +
      " posKeyCount=" + posKeyCount + " scaleKeyCount=" + scaleKeyCount +
      " intended0=" + fmtVal(neutralPos) + " actual0=" + fmtVal(readback0) +
      " intendedPeak=" + fmtVal(zoomedPos) + " actualPeak=" + fmtVal(readbackPeak) +
      " interpLinearSetOk=" + _interpSetOkCount + " interpLinearSetFail=" + _interpSetFailCount;
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

    // Reset the interpolation-fix diagnostics counters (see setKeyframe())
    // for this run, before any setKeyframe() call below.
    _interpSetOkCount = 0;
    _interpSetFailCount = 0;

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
    // Opacity is an intrinsic per-clip component (like Motion), not one
    // added via addFilterByMatchName()/QE, so it doesn't benefit from that
    // function's displayName fallback - but unlike the QE-added effects
    // above, a missing Opacity component/param previously failed completely
    // silently here (no warning pushed at all), so if "AE.ADBE Opacity" ever
    // turns out wrong on some Premiere version, the highlight box would
    // simply never fade out with zero indication why. Warn like every other
    // effect in this function does.
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
      } else {
        warnings.push("opacity_param");
      }
    } else {
      warnings.push("opacity_effect");
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

    // See the KF_INTERP_LINEAR / setKeyframe() comment block near the top of
    // this file: this reports whether the explicit Linear-interpolation fix
    // (the fix for keyframes writing correct values but still hard-cutting
    // instead of animating) actually applied to every keyframe this run
    // wrote, since there's no documented way to read interpolation type back
    // and confirm it directly.
    if (_interpSetFailCount > 0) warnings.push("interp_linear_partial:" + _interpSetOkCount + "ok/" + _interpSetFailCount + "fail");

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

    // Reset the interpolation-fix diagnostics counters (see setKeyframe())
    // for this run, before any setKeyframe() call below.
    _interpSetOkCount = 0;
    _interpSetFailCount = 0;

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
        else warnings.push("opacity_param");
      } else warnings.push("opacity_effect");
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

    // See the KF_INTERP_LINEAR / setKeyframe() comment block near the top of
    // this file: reports whether the explicit Linear-interpolation fix
    // actually applied to every keyframe this run wrote (slide/pop/fade
    // animate-in), since there's no documented way to read interpolation
    // type back and confirm it directly.
    if (_interpSetFailCount > 0) warnings.push("interp_linear_partial:" + _interpSetOkCount + "ok/" + _interpSetFailCount + "fail");

    return warnings.length ? "OK|warn:" + warnings.join(",") : "OK";
  } catch (e) {
    return "ERR|" + e.toString();
  }
}
