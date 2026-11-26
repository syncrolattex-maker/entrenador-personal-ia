/* ==========================================================================
   AARONFIT — MÓDULO ÚNICO DE CONFIGURACIÓN Y ANIMACIÓN DE GRÁFICAS
   Equivalente vanilla JS de lib/chartMotion + hooks de SVG/DOM
   ========================================================================== */

(function () {
  "use strict";

  const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

  const CHART_MOTION = {
    enter: 800,
    update: 400,
    stagger: 45,
    staggerMax: 600,
    easeOutCubic: "cubic-bezier(0.22, 1, 0.36, 1)",
    easeInOutCubic: "cubic-bezier(0.65, 0, 0.35, 1)",
    easeOutFn: function (t) { return 1 - Math.pow(1 - t, 3); },
    easeInOutFn: function (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; },
    maxPointsForDraw: 500
  };

  let _reducedMotion = false;
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    const mql = window.matchMedia(REDUCED_MOTION_QUERY);
    _reducedMotion = mql.matches;
    const onMqlChange = (e) => { _reducedMotion = !!e.matches; };
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onMqlChange);
    } else if (typeof mql.addListener === "function") {
      mql.addListener(onMqlChange);
    }
  }

  function prefersReducedMotion() {
    return _reducedMotion;
  }

  CHART_MOTION.prefersReducedMotion = prefersReducedMotion;
  window.CHART_MOTION = CHART_MOTION;

  const stateStore = new WeakMap();
  const pendingOpts = new WeakMap();
  const activeRafs = new WeakMap();
  const observedContainers = new WeakSet();

  function _cancelContainerRaf(container) {
    const id = activeRafs.get(container);
    if (id) {
      cancelAnimationFrame(id);
      activeRafs.delete(container);
    }
  }

  function _isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function _isDataCurve(el) {
    if (!el || el.closest("defs")) return false;
    const id = el.id || "";
    if (id === "fitness-crosshair" || id === "detail-chart-crosshair") return false;
    const stroke = el.getAttribute("stroke");
    if (!stroke || stroke === "none") return false;
    const fill = el.getAttribute("fill");
    if (fill && fill !== "none") return false;
    const dash = el.getAttribute("stroke-dasharray");
    if (dash === "3 4" || dash === "3 3" || dash === "4 3" || dash === "2 3") return false;
    return true;
  }

  function _countPathPoints(el) {
    const d = el.getAttribute("d") || "";
    const matches = d.match(/[ML]\s*-?\d/g);
    return matches ? matches.length : 0;
  }

  function _computeContainerHash(container, opts) {
    if (opts && opts.hash) return String(opts.hash);
    const paths = Array.from(container.querySelectorAll("svg path")).map(p => (p.getAttribute("d") || "").slice(0, 80)).join("|");
    const bars = Array.from(container.querySelectorAll(".split-bar-fill, .split-bar-track > div, .progress-fill, .stride-eff-bar > div")).map(b => b.style.width).join(",");
    const ring = container.querySelector("#summit-exp-ring-arc");
    const ringVal = ring ? (ring.style.strokeDashoffset || "") : "";
    const cal = container.querySelectorAll(".summit-cal-row").length;
    return `${paths}#${bars}#${ringVal}#${cal}`;
  }

  function _animateCurves(container, isUpdate, opts) {
    const paths = container.querySelectorAll("svg path, svg polyline");
    const duration = isUpdate ? CHART_MOTION.update : CHART_MOTION.enter;
    const easing = isUpdate ? CHART_MOTION.easeInOutCubic : CHART_MOTION.easeOutCubic;
    const explicitPoints = opts && typeof opts.pointCount === "number" ? opts.pointCount : 0;

    if (paths && paths.length > 0) {
      paths.forEach((el) => {
        if (!_isDataCurve(el)) return;
        const pts = explicitPoints || _countPathPoints(el);
        if (pts > CHART_MOTION.maxPointsForDraw) return; // > 500 puntos: render directo para mantener 50+ fps
        if (typeof el.getTotalLength !== "function") return;

        let length = 0;
        try { length = el.getTotalLength(); } catch (_) { length = 0; }
        if (!length || !isFinite(length) || length <= 0) return;

        if (opts && opts.isToggleUpdate) {
          if (typeof el.animate === "function") {
            el.animate([{ opacity: 0 }, { opacity: Number(el.getAttribute("opacity") || 1) }], {
              duration: CHART_MOTION.update,
              easing: CHART_MOTION.easeInOutCubic,
              fill: "forwards"
            });
          }
          return;
        }

        const origDash = el.getAttribute("stroke-dasharray");
        if (typeof el.animate === "function") {
          el.style.strokeDasharray = `${length} ${length}`;
          const anim = el.animate(
            [{ strokeDashoffset: length }, { strokeDashoffset: 0 }],
            { duration, easing, fill: "both" }
          );
          anim.onfinish = () => {
            el.style.strokeDashoffset = "";
            el.style.strokeDasharray = origDash ? origDash : "";
          };
        }
      });

      // Área bajo la línea: fade-in (300 ms) después de la línea
      if (!isUpdate && !(opts && opts.isToggleUpdate)) {
        const areas = container.querySelectorAll('svg path[fill^="url("], svg path[fill="#171716"], svg path[fill="var(--surface-dark)"]');
        areas.forEach((area) => {
          if (typeof area.animate === "function") {
            area.animate([{ opacity: 0 }, { opacity: 1 }], {
              duration: 300,
              delay: CHART_MOTION.enter,
              easing: CHART_MOTION.easeOutCubic,
              fill: "both"
            });
          }
        });
      }
    }

    // Anillo semanal (#summit-exp-ring-arc) + contador central (#summit-exp-ring-pct)
    const ring = container.querySelector("#summit-exp-ring-arc");
    const pctEl = container.querySelector("#summit-exp-ring-pct");
    if (ring) {
      const circ = parseFloat(ring.getAttribute("stroke-dasharray")) || 326.7;
      const targetOffset = parseFloat(ring.style.strokeDashoffset);
      const targetPct = pctEl ? parseFloat((pctEl.textContent || "0").replace(/[^\d.]/g, "")) || 0 : 0;
      const prev = stateStore.get(ring) || { offset: circ, pct: 0 };
      const startOffset = isUpdate ? prev.offset : circ;
      const startPct = isUpdate ? prev.pct : 0;

      if (!isNaN(targetOffset)) {
        _cancelContainerRaf(container);
        const startTs = performance.now();
        const easeFn = isUpdate ? CHART_MOTION.easeInOutFn : CHART_MOTION.easeOutFn;
        const stepRing = (now) => {
          if (!ring.isConnected) return;
          const t = Math.min(1, (now - startTs) / duration);
          const e = easeFn(t);
          const curOffset = startOffset + (targetOffset - startOffset) * e;
          ring.style.strokeDashoffset = curOffset.toFixed(1);
          if (pctEl) {
            const curPct = Math.round(startPct + (targetPct - startPct) * e);
            pctEl.textContent = `${curPct}%`;
          }
          if (t < 1) {
            activeRafs.set(container, requestAnimationFrame(stepRing));
          } else {
            activeRafs.delete(container);
            stateStore.set(ring, { offset: targetOffset, pct: targetPct });
          }
        };
        activeRafs.set(container, requestAnimationFrame(stepRing));
      }
    }
  }

  function _animateBars(container, isUpdate) {
    const duration = isUpdate ? CHART_MOTION.update : CHART_MOTION.enter;
    const easing = isUpdate ? CHART_MOTION.easeInOutCubic : CHART_MOTION.easeOutCubic;

    // Barras horizontales (zonas Z1-Z6/Z1-Z5, parciales, esfuerzo, objetivos)
    const hBars = container.querySelectorAll(
      ".split-bar-fill, .split-bar-track > div, .progress-fill, .stride-eff-bar > div"
    );
    hBars.forEach((bar, idx) => {
      const targetW = parseFloat(bar.style.width);
      if (isNaN(targetW) || targetW <= 0) return;
      const prevW = stateStore.get(bar);
      const startScale = (isUpdate && typeof prevW === "number" && targetW > 0)
        ? Math.min(1.5, Math.max(0.05, prevW / targetW))
        : 0;
      const delay = isUpdate ? 0 : Math.min(idx * CHART_MOTION.stagger, CHART_MOTION.staggerMax);
      bar.style.transformOrigin = "left center";
      if (typeof bar.animate === "function") {
        bar.animate(
          [{ transform: `scaleX(${startScale})` }, { transform: "scaleX(1)" }],
          { duration, delay, easing, fill: "both" }
        );
      }
      stateStore.set(bar, targetW);
    });

    // Barras verticales SVG (#goals-weekly-spark-svg)
    const vRects = container.querySelectorAll("svg rect[rx]");
    vRects.forEach((rect, idx) => {
      if (rect.closest("clipPath")) return;
      const delay = isUpdate ? 0 : Math.min(idx * CHART_MOTION.stagger, CHART_MOTION.staggerMax);
      rect.style.transformBox = "fill-box";
      rect.style.transformOrigin = "center bottom";
      if (typeof rect.animate === "function") {
        rect.animate(
          [{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }],
          { duration, delay, easing, fill: "both" }
        );
      }
    });

    // Registro 12 semanas (#summit-bubble-grid): stagger por fila semanal
    const calRows = container.querySelectorAll(".summit-cal-row");
    calRows.forEach((row, idx) => {
      const delay = isUpdate ? 0 : Math.min(idx * CHART_MOTION.stagger, CHART_MOTION.staggerMax);
      if (typeof row.animate === "function") {
        row.animate(
          [
            { opacity: 0, transform: "translateY(6px)" },
            { opacity: 1, transform: "translateY(0)" }
          ],
          { duration: isUpdate ? CHART_MOTION.update : Math.round(CHART_MOTION.enter * 0.65), delay, easing, fill: "both" }
        );
      }
    });
  }

  function _executeAnimation(container, opts) {
    if (!container || prefersReducedMotion()) {
      if (container) container.dataset.animated = "1";
      return;
    }

    const newHash = _computeContainerHash(container, opts);
    const prevMeta = stateStore.get(container) || { hash: null };
    const alreadyAnimated = container.dataset.animated === "1";

    // Si los datos no han cambiado y ya se animó, no reiniciar
    if (alreadyAnimated && prevMeta.hash === newHash && !(opts && opts.isToggleUpdate)) {
      return;
    }

    const isUpdate = alreadyAnimated && prevMeta.hash !== null;
    stateStore.set(container, { hash: newHash });
    container.dataset.animated = "1";

    _animateCurves(container, isUpdate, opts);
    _animateBars(container, isUpdate);
  }

  // IntersectionObserver con umbral 0.3 para animar solo al entrar en viewport
  const io = (typeof IntersectionObserver !== "undefined")
    ? new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && entry.intersectionRatio >= 0.3) {
            const el = entry.target;
            io.unobserve(el);
            observedContainers.delete(el);
            const opts = pendingOpts.get(el) || {};
            _executeAnimation(el, opts);
          }
        });
      }, { threshold: 0.3 })
    : null;

  function scheduleAnimation(container, opts) {
    if (!container) return;
    _cancelContainerRaf(container);

    if (prefersReducedMotion()) {
      container.dataset.animated = "1";
      return;
    }

    if (!_isVisible(container)) {
      container.dataset.aaronPendingAnim = "1";
      pendingOpts.set(container, opts || {});
      return;
    }

    delete container.dataset.aaronPendingAnim;
    pendingOpts.set(container, opts || {});

    // Si ya se animó antes (cambio de periodo/datos), animar actualización directa desde valor previo
    if (container.dataset.animated === "1") {
      _executeAnimation(container, opts);
      return;
    }

    if (io) {
      if (!observedContainers.has(container)) {
        observedContainers.add(container);
        io.observe(container);
      }
    } else {
      _executeAnimation(container, opts);
    }
  }

  function animateMuscles(container) {
    if (!container || prefersReducedMotion()) return;
    const activeEls = container.querySelectorAll(".muscle-poly.active-target, .muscle-poly.secondary-target");
    activeEls.forEach((el, idx) => {
      const delay = Math.min(idx * CHART_MOTION.stagger, CHART_MOTION.staggerMax);
      if (typeof el.animate === "function") {
        el.animate(
          [{ opacity: 0.35 }, { opacity: 1 }],
          { duration: CHART_MOTION.update, delay, easing: CHART_MOTION.easeInOutCubic, fill: "both" }
        );
      }
    });
  }

  function flushVisiblePending(root) {
    if (!root) return;
    const targets = root.querySelectorAll('[data-aaron-pending-anim="1"]');
    targets.forEach((el) => {
      if (_isVisible(el)) {
        const opts = pendingOpts.get(el) || {};
        scheduleAnimation(el, opts);
      }
    });
  }

  if (typeof MutationObserver !== "undefined" && typeof document !== "undefined") {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((m) => {
        if (m.type === "attributes" && m.attributeName === "class") {
          const target = m.target;
          if (target.classList && target.classList.contains("tab-view") && target.classList.contains("active")) {
            requestAnimationFrame(() => flushVisiblePending(target));
          }
        }
      });
    });

    const attachObserver = () => {
      document.querySelectorAll(".tab-view").forEach((tab) => {
        observer.observe(tab, { attributes: true, attributeFilter: ["class"] });
      });
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", attachObserver);
    } else {
      attachObserver();
    }
  }

  window.AaronCharts = {
    animate: scheduleAnimation,
    animateMuscles: animateMuscles
  };
})();
