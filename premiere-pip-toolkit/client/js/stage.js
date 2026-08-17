/*
  Stage: a draggable point or resizable rectangle overlaid on a box sized to
  match the sequence's frame aspect ratio, expressed in normalized 0..1
  frame coordinates. Used by all three tools to let the user "click where
  they want it" instead of typing numbers.

  Uses plain mouse events (not the Pointer Events API) and explicitly
  prevents default on mousedown - CEP panels run in an embedded browser
  engine that can be a fair bit older than a normal desktop browser, and
  the native "drag this element" behavior some engines trigger on
  mousedown is a classic way for drag interactions to silently stop
  delivering mousemove events after the initial click.
*/
(function (global) {
  function clamp01(n) { return Math.max(0, Math.min(1, n)); }

  function Stage(el, pointEl, rectEl, aspectEl) {
    this.el = el;
    this.pointEl = pointEl;
    this.rectEl = rectEl;
    this.aspectEl = aspectEl;
    this.mode = "point"; // "point" | "rect"
    this.point = { x: 0.5, y: 0.5 };
    this.rect = { x: 0.35, y: 0.35, w: 0.3, h: 0.3 };
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
    if (w > 0 && h > 0 && this.aspectEl) {
      this.aspectEl.style.paddingTop = (h / w * 100) + "%";
    }
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

    function localXY(ev) {
      var r = self.el.getBoundingClientRect();
      return { x: clamp01((ev.clientX - r.left) / r.width), y: clamp01((ev.clientY - r.top) / r.height) };
    }

    function startDrag(onMove) {
      var move = function (e) { onMove(e); };
      var up = function () {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    }

    // point mode: mousedown anywhere in the stage places/moves the point
    self.el.addEventListener("mousedown", function (ev) {
      if (self.mode !== "point") return;
      ev.preventDefault();
      var p = localXY(ev);
      self.point.x = p.x; self.point.y = p.y;
      self._render(); self._emit();
      startDrag(function (e) {
        var p2 = localXY(e);
        self.point.x = p2.x; self.point.y = p2.y;
        self._render(); self._emit();
      });
    });

    // rect body drag (move)
    self.rectEl.addEventListener("mousedown", function (ev) {
      if (self.mode !== "rect") return;
      if (ev.target.classList.contains("rect-handle")) return;
      ev.preventDefault();
      ev.stopPropagation();
      var start = localXY(ev);
      var orig = { x: self.rect.x, y: self.rect.y };
      startDrag(function (e) {
        var p = localXY(e);
        var dx = p.x - start.x, dy = p.y - start.y;
        var nx = orig.x + dx, ny = orig.y + dy;
        nx = clamp01(Math.min(nx, 1 - self.rect.w));
        ny = clamp01(Math.min(ny, 1 - self.rect.h));
        self.rect.x = nx; self.rect.y = ny;
        self._render(); self._emit();
      });
    });

    // rect resize handles
    var handles = self.rectEl.querySelectorAll(".rect-handle");
    handles.forEach(function (h) {
      h.addEventListener("mousedown", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        var corner = h.getAttribute("data-handle");
        var orig = { x: self.rect.x, y: self.rect.y, w: self.rect.w, h: self.rect.h };
        var start = localXY(ev);
        startDrag(function (e) {
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
        });
      });
    });

    window.addEventListener("resize", function () { self._render(); });
  };

  global.Stage = Stage;
})(window);
