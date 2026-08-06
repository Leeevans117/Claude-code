/*
  Stage: a draggable point or resizable rectangle overlaid on a 16:9 (or
  whatever the sequence's frame size is) box, expressed in normalized 0..1
  frame coordinates. Used by all three tools to let the user "click where
  they want it" instead of typing numbers.
*/
(function (global) {
  function clamp01(n) { return Math.max(0, Math.min(1, n)); }

  function Stage(el, pointEl, rectEl) {
    this.el = el;
    this.pointEl = pointEl;
    this.rectEl = rectEl;
    this.mode = "point"; // "point" | "rect"
    this.point = { x: 0.5, y: 0.5 };
    this.rect = { x: 0.35, y: 0.35, w: 0.3, h: 0.3 };
    this.aspect = 16 / 9;
    this.onChange = null;

    this._bind();
    this._render();
  }

  Stage.prototype.setMode = function (mode) {
    this.mode = mode;
    this.pointEl.hidden = mode !== "point";
    this.rectEl.hidden = mode !== "rect";
  };

  Stage.prototype.setAspect = function (w, h) {
    if (w > 0 && h > 0) this.el.style.aspectRatio = w + " / " + h;
  };

  Stage.prototype._render = function () {
    var r = this.el.getBoundingClientRect();
    if (this.mode === "point") {
      this.pointEl.style.left = (this.point.x * r.width) + "px";
      this.pointEl.style.top = (this.point.y * r.height) + "px";
    } else {
      this.rectEl.style.left = (this.rect.x * r.width) + "px";
      this.rectEl.style.top = (this.rect.y * r.height) + "px";
      this.rectEl.style.width = (this.rect.w * r.width) + "px";
      this.rectEl.style.height = (this.rect.h * r.height) + "px";
    }
  };

  Stage.prototype._emit = function () {
    if (this.onChange) this.onChange(this.mode === "point" ? this.point : this.rect);
  };

  Stage.prototype._bind = function () {
    var self = this;

    self.el.addEventListener("pointerdown", function (ev) {
      if (self.mode !== "point") return;
      if (ev.target !== self.el) return; // rect handles/body have their own handlers
      self._dragPoint(ev);
    });

    function localXY(ev) {
      var r = self.el.getBoundingClientRect();
      return { x: clamp01((ev.clientX - r.left) / r.width), y: clamp01((ev.clientY - r.top) / r.height) };
    }

    self._dragPoint = function (ev) {
      var p = localXY(ev);
      self.point.x = p.x; self.point.y = p.y;
      self._render(); self._emit();
      var move = function (e) {
        var p2 = localXY(e);
        self.point.x = p2.x; self.point.y = p2.y;
        self._render(); self._emit();
      };
      var up = function () {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    };

    // rect body drag (move)
    self.rectEl.addEventListener("pointerdown", function (ev) {
      if (self.mode !== "rect") return;
      if (ev.target.classList.contains("rect-handle")) return;
      ev.stopPropagation();
      var start = localXY(ev);
      var orig = { x: self.rect.x, y: self.rect.y };
      var move = function (e) {
        var p = localXY(e);
        var dx = p.x - start.x, dy = p.y - start.y;
        self.rect.x = clamp01(Math.min(orig.x + dx, 1 - self.rect.w));
        self.rect.y = clamp01(Math.min(orig.y + dy, 1 - self.rect.h));
        if (self.rect.x < 0) self.rect.x = 0;
        if (self.rect.y < 0) self.rect.y = 0;
        self._render(); self._emit();
      };
      var up = function () {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });

    // rect resize handles
    var handles = self.rectEl.querySelectorAll(".rect-handle");
    handles.forEach(function (h) {
      h.addEventListener("pointerdown", function (ev) {
        ev.stopPropagation();
        var corner = h.getAttribute("data-handle");
        var orig = { x: self.rect.x, y: self.rect.y, w: self.rect.w, h: self.rect.h };
        var start = localXY(ev);
        var move = function (e) {
          var p = localXY(e);
          var dx = p.x - start.x, dy = p.y - start.y;
          var nx = orig.x, ny = orig.y, nw = orig.w, nh = orig.h;
          if (corner === "se") { nw = orig.w + dx; nh = orig.h + dy; }
          if (corner === "ne") { nw = orig.w + dx; ny = orig.y + dy; nh = orig.h - dy; }
          if (corner === "sw") { nx = orig.x + dx; nw = orig.w - dx; nh = orig.h + dy; }
          if (corner === "nw") { nx = orig.x + dx; ny = orig.y + dy; nw = orig.w - dx; nh = orig.h - dy; }
          nw = Math.max(0.04, nw); nh = Math.max(0.04, nh);
          nx = clamp01(nx); ny = clamp01(ny);
          if (nx + nw > 1) nw = 1 - nx;
          if (ny + nh > 1) nh = 1 - ny;
          self.rect = { x: nx, y: ny, w: nw, h: nh };
          self._render(); self._emit();
        };
        var up = function () {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      });
    });

    window.addEventListener("resize", function () { self._render(); });
  };

  global.Stage = Stage;
})(window);
