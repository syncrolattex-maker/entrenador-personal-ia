// Global Error Boundary for Mobile Debugging
window.addEventListener("error", (event) => {
  const bannerId = "js-error-debug-banner";
  if (document.getElementById(bannerId)) return;
  const banner = document.createElement("div");
  banner.id = bannerId;
  banner.style.position = "fixed";
  banner.style.top = "0";
  banner.style.left = "0";
  banner.style.width = "100%";
  banner.style.background = "#FEF2F2";
  banner.style.borderBottom = "2px solid #EF4444";
  banner.style.color = "#991B1B";
  banner.style.padding = "16px";
  banner.style.zIndex = "999999";
  banner.style.fontSize = "0.78rem";
  banner.style.fontFamily = "monospace";
  banner.style.lineHeight = "1.4";
  banner.innerHTML = `<strong>Error de JS detectado:</strong><br>${event.message}<br>en ${event.filename.split('/').pop()}:${event.lineno}:${event.colno}`;
  document.body.appendChild(banner);
});

// ============================================================
// SERVICE WORKER
// ============================================================
if ("serviceWorker" in navigator) {

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => console.log("[PWA] SW registered", reg.scope))
      .catch((err) => console.error("[PWA] SW error", err));
  });
}

// ============================================================
// AUTO-HEALING FOR CACHE MISMATCHES (PWA UPDATE)
// ============================================================
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", checkCacheIntegrity);
} else {
  checkCacheIntegrity();
}

function checkCacheIntegrity() {
  if (!document.getElementById("dashboard-activities-feed")) {
    console.warn("[Cache] Detected old HTML cache. Cleaning PWA cache and reloading...");
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.getRegistrations().then((registrations) => {
        for (let r of registrations) r.unregister();
      });
    }
    caches.keys().then((names) => {
      for (let name of names) caches.delete(name);
    });
    localStorage.clear();
    setTimeout(() => {
      window.location.reload(true);
    }, 450);
  }
}

// ============================================================

// APP STATE
// ============================================================
let state = {
  db: {
    dias_sin_entrenar: 0,
    ultimo_entreno: "Ninguno",
    siguiente_bloque: "Fuerza",
    historial_entrenamientos: []
  },
  currentWorkout: null
};
let _latestWeeklyPlan = null;

// ============================================================
// DOM — Main UI
// ============================================================
const elStatusUltimo      = document.getElementById("status-ultimo");
const elStatusSiguiente   = document.getElementById("status-siguiente");
const elStatusDias        = document.getElementById("status-dias");
const elLoadingState      = document.getElementById("loading-state");
const elLoadingText       = document.getElementById("loading-text");
const elSelectionCard     = document.getElementById("selection-card");
const elRecTipoLabel      = document.getElementById("rec-tipo-label");
const elRecRazonText      = document.getElementById("rec-razon-text");
const elRecSemanalText    = document.getElementById("rec-semanal-text");
const elBtnSelectFuerza   = document.getElementById("btn-select-fuerza");
const elBtnSelectCarrera  = document.getElementById("btn-select-carrera");
const elBtnSelectYoga     = document.getElementById("btn-select-yoga");
const elBtnSelectDescanso = document.getElementById("btn-select-descanso");

const elWorkoutCard       = document.getElementById("workout-card");
const elWorkoutBadge      = document.getElementById("workout-badge");
const elWorkoutContent    = document.getElementById("workout-content");
const elWorkoutNote       = document.getElementById("workout-note");
const elWorkoutActions    = document.getElementById("workout-actions");
const elSuccessBanner     = document.getElementById("success-banner");
const elSuccessText       = document.getElementById("success-text");
const elOfflineNotif      = document.getElementById("offline-notification");
const elAdaptationBanner  = document.getElementById("adaptation-banner");
const elAdaptationText    = document.getElementById("adaptation-text");
const elDecisionBanner    = document.getElementById("decision-banner");
const elDecisionText      = document.getElementById("decision-text");

// Last Workout DOM
const elLastWorkoutBox    = document.getElementById("last-workout-box");
const elLastWorkoutIcon   = document.getElementById("last-workout-icon");
const elLastWorkoutTipo   = document.getElementById("last-workout-tipo");
const elLastWorkoutName   = document.getElementById("last-workout-name");
const elLastWorkoutDate   = document.getElementById("last-workout-date");
const elLastWorkoutStats  = document.getElementById("last-workout-stats");
const elLastWorkoutDesc   = document.getElementById("last-workout-desc");



// ============================================================
// DOM — Guided Session Overlay
// ============================================================
const elGuidedOverlay       = document.getElementById("guided-overlay");
const elGuidedClose         = document.getElementById("guided-close");
const elGuidedProgressFill  = document.getElementById("guided-progress-fill");
const elGuidedCounter       = document.getElementById("guided-counter");
const elGuidedPhaseLabel    = document.getElementById("guided-phase-label");
const elGuidedExName        = document.getElementById("guided-exercise-name");
const elGuidedSetCounter    = document.getElementById("guided-set-counter");
const elGuidedSetCurrent    = document.getElementById("guided-set-current");
const elGuidedSetTotal      = document.getElementById("guided-set-total");
const elGuidedReps          = document.getElementById("guided-reps");
const elGuidedTimerWrap     = document.getElementById("guided-timer-wrap");
const elGuidedTimerArc      = document.getElementById("guided-timer-arc");
const elGuidedTimerDisplay  = document.getElementById("guided-timer-display");
const elGuidedActionsFuerza = document.getElementById("guided-actions-fuerza");
const elGuidedActionsRest   = document.getElementById("guided-actions-rest");
const elGuidedActionsCarrera= document.getElementById("guided-actions-carrera");
const elGuidedActionsDone   = document.getElementById("guided-actions-done");
const elBtnSkipRest         = document.getElementById("btn-skip-rest");
const elBtnPauseCarrera     = document.getElementById("btn-pause-carrera");
const elBtnGuardarSesion    = document.getElementById("btn-guardar-sesion");
const elGuidedFeedbackBtns  = document.querySelectorAll(".guided-feedback-btn");

// ============================================================
// GUIDED SESSION STATE
// ============================================================
const REST_DURATION = 45; // Max 45 seconds between sets (customized for advanced level)

let guided = {
  tipo: "Fuerza",         // "Fuerza" | "Carrera"
  exercises: [],          // array of {nombre, series, repeticiones} or phases
  exIndex: 0,             // current exercise / phase index
  setIndex: 0,            // current set (Fuerza only)
  phase: "ready",         // "ready" | "working" | "resting" | "running" | "done"
  timerInterval: null,
  timerRemaining: 0,
  timerTotal: 0,
  startTime: null,        // Date when session started
  totalSeries: 0,         // accumulated completed sets
  paused: false,
  selectedFeedback: null
};

const CIRCUMFERENCE = 2 * Math.PI * 54; // r=54

// ============================================================
// INIT
// ============================================================
document.addEventListener("DOMContentLoaded", () => {
  initApp();
  checkGarminStatus();
  loadWeeklyPlanAndRaceGoal();
  loadSummitAnalytics();
  loadActivitiesFeed();
  loadGearList();
  syncRouteFromLocation();
  window.addEventListener("popstate", syncRouteFromLocation);

  // Selection events (safe null checks)
  if (elBtnSelectFuerza) elBtnSelectFuerza.addEventListener("click", () => iniciarGeneracionEntrenamiento("Fuerza"));
  if (elBtnSelectCarrera) elBtnSelectCarrera.addEventListener("click", () => iniciarGeneracionEntrenamiento("Carrera"));
  if (elBtnSelectDescanso) elBtnSelectDescanso.addEventListener("click", registrarDescansoHoy);

  const elBtnDiaGris = document.getElementById("btnDiaGris");
  if (elBtnDiaGris) {
    elBtnDiaGris.addEventListener("click", () => {
      switchTab("tab-dashboard");
      iniciarGeneracionEntrenamiento("Fuerza", true);
    });
  }


  // Online/offline status
  window.addEventListener("online",  updateOnlineStatus);
  window.addEventListener("offline", updateOnlineStatus);
  updateOnlineStatus();

  // Guided session close & feedback
  elGuidedClose.addEventListener("click", () => {
    if (confirm("¿Salir de la sesión? El progreso no se guardará.")) closeGuided();
  });
  elBtnSkipRest.addEventListener("click",     onSkipRest);
  elBtnPauseCarrera.addEventListener("click", onPauseCarrera);
  elBtnGuardarSesion.addEventListener("click", onGuardarSesion);


  elGuidedFeedbackBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      elGuidedFeedbackBtns.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      guided.selectedFeedback = btn.getAttribute("data-value");
      elBtnGuardarSesion.removeAttribute("disabled");
    });
  });
});

// ============================================================
// ONLINE STATUS
// ============================================================
function updateOnlineStatus() {
  elOfflineNotif.style.display = navigator.onLine ? "none" : "flex";
}

// ============================================================
// BOOT — FETCH RECOMMENDATION
// ============================================================
function renderStrideHomeHeader() {
  const now = new Date();
  const dateEl = document.getElementById("stride-today-date");
  const greetEl = document.getElementById("stride-greeting-title");
  if (dateEl) {
    const raw = now.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" });
    dateEl.textContent = raw.charAt(0).toUpperCase() + raw.slice(1);
  }
  if (greetEl) {
    const h = now.getHours();
    const salute = h < 13 ? "Buenos días" : h < 20 ? "Buenas tardes" : "Buenas noches";
    greetEl.textContent = `${salute}, Aarón`;
  }
}

async function initApp() {
  if (window.lucide) lucide.createIcons();
  renderStrideHomeHeader();
  hideSuccessBanner();
  mostrarPantallaSeleccion();

  const elRecommendationBox = document.getElementById("recommendation-box");
  const elRecTipoLabel = document.getElementById("rec-tipo-label");
  const elRecRazonText = document.getElementById("rec-razon-text");
  const elPercent = document.getElementById("daily-goal-percent");
  const elRingArc = document.getElementById("daily-ring-arc");
  const elBtnComenzarHoy = document.getElementById("btn-comenzar-hoy");
  
  if (elRecommendationBox) {
    elRecommendationBox.classList.add("loading-pulse");
    if (elRecTipoLabel) elRecTipoLabel.textContent = "...";
    if (elRecRazonText) elRecRazonText.textContent = "Analizando tu historial con tu Coach IA...";
    if (elPercent) elPercent.innerHTML = `--<small>%</small>`;
    if (elRingArc) elRingArc.style.strokeDashoffset = 351.86; // empty ring while analyzing
    if (elBtnComenzarHoy) elBtnComenzarHoy.style.display = "none";
  }

  cargarPreferenciasGuardadas();
  loadThresholdPace();

  try {
    // 1. Get database status
    const dbRes = await fetch("/estado-db");
    if (dbRes.ok) { state.db = await dbRes.json(); updateStatsBanner(); }

    // 2. Clear cache if version changed (cache buster)
    const APP_VERSION = "v86"; // Fix checkCacheIntegrity element check after removing #selection-card








    const cachedVersion = localStorage.getItem("cached_version");
    if (cachedVersion !== APP_VERSION) {
      localStorage.removeItem("cached_recommendation");
      localStorage.removeItem("cached_recommendation_date");
      localStorage.removeItem("cached_workout");
      localStorage.removeItem("cached_workout_date");
      localStorage.setItem("cached_version", APP_VERSION);
    }

    // 3. Fetch real activity history immediately for Metrics Tab
    fetch("/historial-actividades")
      .then(res => res.json())
      .then(data => {
        if (data.status === "ok" && data.historial) {
          state.history = data.historial;
          renderMetricsTab(data.historial, state.lastCoachText || "");
        }
      })
      .catch(e => console.error("Error fetching real history:", e));


    // 4. Read cached recommendation for today
    const todayStr = new Date().toDateString();
    const cachedRec = localStorage.getItem("cached_recommendation");
    const cachedRecDate = localStorage.getItem("cached_recommendation_date");

    if (cachedRec && cachedRecDate === todayStr) {
      try {
        const recObj = JSON.parse(cachedRec);
        const rLower = (recObj.razon || "").toLowerCase();
        if (rLower.includes("interrupción") || rLower.includes("error") || rLower.includes("offline") || rLower.includes("desconectado")) {
          console.log("[Cache] Purging stale error recommendation from localStorage.");
          localStorage.removeItem("cached_recommendation");
          localStorage.removeItem("cached_recommendation_date");
        } else {
          console.log("[Cache] Serving today's recommendation from localStorage.");
          renderRecommendation(recObj);
          if (elRecommendationBox) elRecommendationBox.classList.remove("loading-pulse");
          return;
        }
      } catch(e) {
        localStorage.removeItem("cached_recommendation");
      }
    }

    // 5. Fetch new recommendation from server
    const recRes = await fetch("/recomendacion-hoy");
    if (recRes.ok) {
      const recommendation = await recRes.json();
      if (recommendation.historial_real) {
        state.history = recommendation.historial_real;
      }
      
      const rLower = (recommendation.razon || "").toLowerCase();
      if (recommendation.razon && !rLower.includes("error") && !rLower.includes("interrupción")) {
        localStorage.setItem("cached_recommendation", JSON.stringify(recommendation));
        localStorage.setItem("cached_recommendation_date", todayStr);
      }
      
      renderRecommendation(recommendation);

      // ✅ Re-fetch db AFTER recommendation (backend has now synced db with real history)
      try {
        const dbRes2 = await fetch("/estado-db");
        if (dbRes2.ok) { state.db = await dbRes2.json(); updateStatsBanner(); }
      } catch (e) { console.warn("Could not refresh stats banner:", e); }

    } else {
      const day = new Date().getDay();
      let offRec = (day === 0) ? "Descanso" : (day % 2 === 0) ? "Carrera" : "Fuerza";
      renderRecommendation({
        recomendacion: offRec,
        razon: `¡Hola Aarón! Te recomendamos para hoy una sesión de ${offRec}.`,
        explicacion_semanal: "Planificación activa."
      });
    }

  } catch (err) {
    console.error("Fetch recommendation error:", err);
    const day = new Date().getDay(); // 0 = Sun, 1 = Mon, 2 = Tue, 3 = Wed, 4 = Thu, 5 = Fri, 6 = Sat
    let offlineRec = "Fuerza";
    let offlineRazon = "Hoy te recomendamos un bloque de Fuerza estilo Strava con mancuernas de 5kg y cintas.";
    if (day === 0) {
      offlineRec = "Descanso";
      offlineRazon = "Hoy domingo toca recuperación activa y asimilación muscular.";
    } else if (day === 2 || day === 4 || day === 6) {
      offlineRec = "Carrera";
      offlineRazon = "Hoy te recomendamos una sesión de Carrera Aeróbica continua en Zona 2.";
    }

    renderRecommendation({
      recomendacion: offlineRec,
      razon: `¡Hola Aarón! ${offlineRazon}`,
      explicacion_semanal: "Sesión adaptada."
    });

  } finally {
    if (elRecommendationBox) elRecommendationBox.classList.remove("loading-pulse");
  }
}


function updateStatsBanner() {
  if (!state.db) return;
  if (elStatusUltimo) elStatusUltimo.textContent    = state.db.ultimo_entreno || "Ninguno";
  if (elStatusSiguiente) elStatusSiguiente.textContent = state.db.siguiente_bloque || "-";
  const dias = state.db.dias_sin_entrenar || 0;
  if (elStatusDias) {
    elStatusDias.textContent = dias === 0 ? "¡Al día!" : `${dias} ${dias === 1 ? "día" : "días"}`;
    dias > 0 ? elStatusDias.classList.add("highlight") : elStatusDias.classList.remove("highlight");
  }
}

function showLoading(on, text = "Cargando...") {
  if (elLoadingState) elLoadingState.style.display = on ? "flex" : "none";
  if (elLoadingText) elLoadingText.textContent = text;
  if (on) {
    if (elSelectionCard) elSelectionCard.style.display = "none";
    if (elWorkoutCard) elWorkoutCard.style.display = "none";
  }
}

function showError(msg) {
  elWorkoutContent.innerHTML = `
    <div style="text-align:center;color:var(--text-secondary);padding:20px 0;">
      <i data-lucide="alert-triangle" style="width:48px;height:48px;margin-bottom:12px;opacity:0.5;"></i>
      <p style="font-weight:500;">${msg}</p>
    </div>`;
  elWorkoutNote.textContent = "";
  elAdaptationBanner.style.display = "none";
  elDecisionBanner.style.display = "none";
  lucide.createIcons();
}

function mostrarPantallaSeleccion() {
  if (elSelectionCard) elSelectionCard.style.display = "flex";
  if (elWorkoutCard) elWorkoutCard.style.display = "none";
  if (elLoadingState) elLoadingState.style.display = "none";
}

function renderRecommendation(rec) {
  elRecTipoLabel.textContent = rec.recomendacion;
  if (rec.recomendacion === "Fuerza") {
    elRecTipoLabel.style.color = "var(--accent-fuerza)";
  } else if (rec.recomendacion === "Carrera") {
    elRecTipoLabel.style.color = "var(--accent-carrera)";
  } else {
    elRecTipoLabel.style.color = "var(--accent-success)";
  }
  
  elRecRazonText.textContent = rec.razon;
  elRecSemanalText.textContent = rec.explicacion_semanal || "";

  // Populate last workout context box right inside recommendation card
  const elLastContext = document.getElementById("rec-last-context");
  if (rec.ultimo_entreno_detalles && elLastContext) {
    const last = rec.ultimo_entreno_detalles;
    const mins = Math.round(last.duracion_minutos || 0);
    const hr = last.frecuencia_cardiaca_media ? ` • ❤️ ${Math.round(last.frecuencia_cardiaca_media)} ppm` : "";
    const km = last.distancia_km ? ` • 📏 ${last.distancia_km.toFixed(1)} km` : "";
    
    let dateLabel = last.fecha;
    try {
      const parts = last.fecha.split("-");
      if (parts.length === 3) {
        const d = new Date(parts[0], parts[1] - 1, parts[2]);
        dateLabel = d.toLocaleDateString("es-ES", { day: "numeric", month: "short" });
      }
    } catch(e) {}

    elLastContext.innerHTML = `⌚ <strong>Evaluando tu último registro:</strong> ${last.tipo} (${dateLabel}, ${mins} min${hr}${km})`;
    elLastContext.style.display = "block";
  } else if (elLastContext) {
    elLastContext.style.display = "none";
  }

  // Visually highlight the selection button prescribed by the AI
  const btnFuerza = document.getElementById("btn-select-fuerza");
  const btnCarrera = document.getElementById("btn-select-carrera");
  const btnYoga = document.getElementById("btn-select-yoga");
  const btnDescanso = document.getElementById("btn-select-descanso");
  
  [btnFuerza, btnCarrera, btnYoga, btnDescanso].forEach(btn => {
    if (btn) {
      btn.classList.remove("ai-recommended");
      const chip = btn.querySelector(".ai-recommended-chip");
      if (chip) chip.remove();
    }
  });

  let targetBtn = null;
  if (rec.recomendacion === "Fuerza") targetBtn = btnFuerza;
  else if (rec.recomendacion === "Carrera") targetBtn = btnCarrera;
  else if (rec.recomendacion === "Yoga") targetBtn = btnYoga;
  else if (rec.recomendacion === "Descanso") targetBtn = btnDescanso;

  if (targetBtn) {
    targetBtn.classList.add("ai-recommended");
    const textWrap = targetBtn.querySelector(".btn-text-wrap");
    if (textWrap) {
      const chip = document.createElement("div");
      chip.className = "ai-recommended-chip";
      chip.innerHTML = "✨ PRESCRIPCIÓN RECOMENDADA POR IA";
      textWrap.insertBefore(chip, textWrap.firstChild);
    }
  }

  // Adapt selection card header & direct button if already trained today
  const elSelectionTitle = document.getElementById("selection-card-title");
  const elBtnComenzarHoy = document.getElementById("btn-comenzar-hoy");
  const elBtnComenzarTexto = document.getElementById("btn-comenzar-hoy-texto");

  if (rec.recomendacion === "Descanso") {
    if (elSelectionTitle) elSelectionTitle.textContent = "✅ DÍA DE RECUPERACIÓN (OPCIONES ADICIONALES)";
    if (elBtnComenzarHoy) {
      elBtnComenzarHoy.style.display = "flex";
      if (elBtnComenzarTexto) elBtnComenzarTexto.textContent = "🔋 Rutina Suave de Movilidad (10 min)";
      elBtnComenzarHoy.className = "btn btn-primary";
      elBtnComenzarHoy.onclick = () => iniciarGeneracionEntrenamiento("Fuerza", true);
    }
  } else {
    if (elSelectionTitle) elSelectionTitle.textContent = "¿QUÉ VAS A ENTRENAR HOY?";
    if (elBtnComenzarHoy && rec.recomendacion) {
      elBtnComenzarHoy.style.display = "flex";
      if (rec.recomendacion === "Fuerza") {
        if (elBtnComenzarTexto) elBtnComenzarTexto.textContent = "⚡ Comenzar Fuerza (Strava)";
        elBtnComenzarHoy.className = "btn btn-primary";
        elBtnComenzarHoy.onclick = () => iniciarGeneracionEntrenamiento("Fuerza");
      } else if (rec.recomendacion === "Carrera") {
        if (elBtnComenzarTexto) elBtnComenzarTexto.textContent = "⚡ Comenzar Carrera (Runna)";
        elBtnComenzarHoy.className = "btn btn-primary";
        elBtnComenzarHoy.onclick = () => iniciarGeneracionEntrenamiento("Carrera");
      } else {
        if (elBtnComenzarTexto) elBtnComenzarTexto.textContent = "🔋 Rutina Suave de Movilidad (10 min)";
        elBtnComenzarHoy.className = "btn btn-primary";
        elBtnComenzarHoy.onclick = () => iniciarGeneracionEntrenamiento("Fuerza", true);
      }
    }
  }

  // Populate Stride 04 · Home Dark Hero Card
  const heroBadge = document.getElementById("stride-hero-badge");
  const heroTitle = document.getElementById("stride-hero-title");
  const heroSub = document.getElementById("stride-hero-subtitle");
  const heroPlayBtn = document.getElementById("stride-hero-play-btn");
  if (heroTitle && heroSub) {
    if (rec.recomendacion === "Carrera") {
      if (heroBadge) heroBadge.textContent = "Hoy · Carrera Runna";
      heroTitle.textContent = "Carrera Estructurada";
      heroSub.textContent = "Progresión aeróbica y ritmos objetivo · Listo para Garmin";
      if (heroPlayBtn) heroPlayBtn.onclick = () => iniciarGeneracionEntrenamiento("Carrera");
    } else if (rec.recomendacion === "Fuerza") {
      if (heroBadge) heroBadge.textContent = "Hoy · Fuerza Opcional";
      heroTitle.textContent = "Fuerza Strava (25–35 min)";
      heroSub.textContent = "Mancuernas 5 kg y cintas elásticas · Full-Body";
      if (heroPlayBtn) heroPlayBtn.onclick = () => iniciarGeneracionEntrenamiento("Fuerza");
    } else {
      if (heroBadge) heroBadge.textContent = "Hoy · Recuperación";
      heroTitle.textContent = "Día de Descanso";
      heroSub.textContent = "Asimilación muscular activa · Pulsa para movilidad 10 min";
      if (heroPlayBtn) heroPlayBtn.onclick = () => iniciarGeneracionEntrenamiento("Fuerza", true);
    }
  }

  // Update dynamic readiness score (Weekly Load Balance Score)
  const elPercent = document.getElementById("daily-goal-percent");
  const elRingArc = document.getElementById("daily-ring-arc");
  const score = rec.readiness_score !== undefined ? rec.readiness_score : 80;
  if (elPercent) {
    elPercent.innerHTML = `${score}<small>%</small>`;
  }
  if (elRingArc) {
    const r = 56;
    const circumference = 2 * Math.PI * r;
    const offset = circumference - (score / 100) * circumference;
    elRingArc.style.strokeDasharray = circumference;
    elRingArc.style.strokeDashoffset = offset;
  }


  // Render Last Completed Workout details
  if (rec.ultimo_entreno_detalles && elLastWorkoutBox) {
    const last = rec.ultimo_entreno_detalles;
    elLastWorkoutTipo.textContent = last.tipo;
    elLastWorkoutName.textContent = last.nombre || "Sesión de " + last.tipo;
    
    // Format Date
    let dateLabel = last.fecha;
    try {
      const parts = last.fecha.split("-");
      if (parts.length === 3) {
        const d = new Date(parts[0], parts[1] - 1, parts[2]);
        dateLabel = d.toLocaleDateString("es-ES", { day: "numeric", month: "short" });
      }
    } catch(e) {}
    elLastWorkoutDate.textContent = `(${dateLabel})`;
    
    // Set Icon & BG based on type
    if (last.tipo === "Fuerza") {
      elLastWorkoutIcon.textContent = "🏋️‍♂️";
      elLastWorkoutBox.style.backgroundColor = "var(--bg-fuerza)";
    } else {
      elLastWorkoutIcon.textContent = "🏃‍♀️";
      elLastWorkoutBox.style.backgroundColor = "var(--bg-carrera)";
    }
    
    // Build stats HTML
    let statsHtml = `<span>⏱️ ${Math.round(last.duracion_minutos)} min</span>`;
    if (last.frecuencia_cardiaca_media) {
      statsHtml += `<span>❤️ ${Math.round(last.frecuencia_cardiaca_media)} ppm</span>`;
    }
    if (last.distancia_km) {
      statsHtml += `<span>📏 ${last.distancia_km.toFixed(1)} km</span>`;
    }
    if (last.calorias_activas) {
      statsHtml += `<span>🔥 ${Math.round(last.calorias_activas)} kcal</span>`;
    }
    elLastWorkoutStats.innerHTML = statsHtml;
    
    // Description
    if (last.descripcion && last.descripcion.trim()) {
      elLastWorkoutDesc.innerHTML = last.descripcion.replace(/\n/g, "<br>");
      elLastWorkoutDesc.style.display = "block";
    } else {
      elLastWorkoutDesc.style.display = "none";
    }
    
    elLastWorkoutBox.style.display = "flex";
  } else if (elLastWorkoutBox) {
    elLastWorkoutBox.style.display = "none";
  }

  // Render dynamic real metrics tab with Intervals.icu history
  renderMetricsTab(rec.historial_real || [], rec.razon);

}

// ============================================================
// RENDER WORKOUT CARD
// ============================================================
function renderWorkout(workout) {

  if (elSelectionCard) elSelectionCard.style.display = "none";
  if (elWorkoutCard) elWorkoutCard.style.display = "flex";

  elWorkoutContent.innerHTML = "";
  elWorkoutNote.textContent = workout.mensaje || "";

  if (workout.mensaje_adaptacion) {
    elAdaptationText.textContent = workout.mensaje_adaptacion;
    elAdaptationBanner.style.display = "flex";
  } else {
    elAdaptationBanner.style.display = "none";
  }

  if (workout.explicacion_tipo) {
    elDecisionText.textContent = workout.explicacion_tipo;
    elDecisionBanner.style.display = "flex";
  } else {
    elDecisionBanner.style.display = "none";
  }

  const isFuerza = workout.tipo_sesion === "Fuerza";
  const isYoga = workout.tipo_sesion === "Yoga";

  if (isFuerza || isYoga) {
    window.currentRoutineExercises = workout.ejercicios;
    if (isYoga) {
      elWorkoutBadge.className = "badge yoga";
      elWorkoutBadge.textContent = "Yoga • Flexibilidad y Equilibrio";
    } else {
      elWorkoutBadge.className = "badge fuerza";
      elWorkoutBadge.textContent = "Fuerza • Cintas & Pesas 5kg";
    }

    let html = '<div class="exercise-list">';
    workout.ejercicios.forEach((ex, idx) => {
      const targetMuscle = ex.target_muscle || (isYoga ? "Alineación" : "Full Body");
      const equipment = ex.equipment || (isYoga ? "Esterilla / Yoga" : "Pesas 5kg / Cintas");
      const gifUrl = ex.gif_url || "";
      
      html += `
        <div class="exercise-item-enriched">
          <div class="exercise-thumb-wrapper" style="${isYoga ? 'background:#ffffff; padding:4px;' : ''}">
            ${gifUrl ? `<img src="${gifUrl}" alt="${ex.nombre}" loading="lazy" style="${isYoga ? 'object-fit:contain;' : ''}" onerror="this.parentElement.innerHTML='<span class=\'exercise-thumb-icon\'>🧘‍♀️</span>'" />` : `<span class="exercise-thumb-icon">🧘‍♀️</span>`}
          </div>

          <div class="exercise-info-content">
            <div class="exercise-title-row">
              <span class="exercise-name-text">${ex.nombre}</span>
              <span class="exercise-reps-pill">${ex.series}× ${ex.repeticiones}</span>
            </div>
            <div class="exercise-tags-row">
              <span class="ex-tag muscle">🎯 ${targetMuscle}</span>
              <span class="ex-tag equipment">🏋️ ${equipment}</span>
            </div>
            ${ex.descripcion ? `<span class="body-sm-muted" style="margin-top:2px;">${ex.descripcion}</span>` : ""}
            <button class="btn-video-demo-chip" onclick="openExerciseVideoModal(${idx})">
              <i data-lucide="play-circle" style="width:14px;height:14px;"></i> Ver Técnica
            </button>
          </div>
        </div>`;
    });
    html += "</div>";
    elWorkoutContent.innerHTML = html;


    elWorkoutActions.innerHTML = `
      <button id="btn-empezar-fuerza" class="btn btn-primary guided-action-btn ${isYoga ? 'yoga' : ''}">
        <i data-lucide="play" style="width: 20px; height: 20px;"></i>
        Comenzar Sesión Guiada
      </button>
      <button id="btn-send-garmin-fuerza" class="btn btn-ghost" style="border: 1px solid rgba(0, 174, 239, 0.4); color: #00AEEF; font-weight: 700;" onclick="sendWorkoutToGarminWatch()">
        <i data-lucide="watch" style="width: 18px; height: 18px;"></i>
        ${workout.enviado_al_reloj ? '✅ Enviado a Garmin Connect' : '⌚ Enviar a Garmin Connect'}
      </button>
      <button id="btn-volver" class="btn btn-secondary">
        Atrás
      </button>
    `;

    document.getElementById("btn-empezar-fuerza").addEventListener("click", startGuidedSession);
    document.getElementById("btn-volver").addEventListener("click", mostrarPantallaSeleccion);

  } else {
    elWorkoutBadge.className = "badge carrera";
    elWorkoutBadge.textContent = "Carrera • Watch";

    let watchBadge = "";
    if (workout.enviado_al_reloj) {
      watchBadge = `
        <div style="background:rgba(0, 174, 239, 0.16);border:1px solid rgba(0, 174, 239, 0.4);color:#56CCF2;font-size:0.75rem;font-weight:700;padding:6px 12px;border-radius:8px;display:inline-flex;align-items:center;gap:6px;margin-bottom:12px;">
          <i data-lucide="check-circle" style="width:14px;height:14px;"></i>
          ENVIADO AUTOMÁTICAMENTE A GARMIN CONNECT
        </div>`;
    }

    let totalSeconds = 0;
    let stepsHtml = "";
    if (workout.phases && workout.phases.length > 0) {
      stepsHtml = '<div class="stride-steps-card">';
      workout.phases.forEach(p => {
        totalSeconds += Number(p.duration_seconds || 0);
        const m = Math.floor(p.duration_seconds / 60);
        const s = p.duration_seconds % 60;
        const isWork = p.type === "WORK" || /interval|tempo|serie|fartlek|velocidad|ritmo/i.test(p.name || "");
        stepsHtml += `
          <div class="stride-step-row">
            <span class="stride-step-bar ${isWork ? 'work' : ''}"></span>
            <div style="flex:1; min-width:0;">
              <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                <strong style="font-size:0.9rem; color:var(--on-surface);">${p.name}</strong>
                ${isWork ? `<span class="stride-step-repeat-pill">CALIDAD / ZONA</span>` : ""}
              </div>
              <span class="body-xs">${p.type === "WARMUP" ? "Calentamiento suave" : p.type === "COOLDOWN" ? "Vuelta a la calma" : "Bloque principal Runna"}</span>
            </div>
            <strong class="tabular-num" style="font-size:0.88rem; color:var(--on-surface);">${m}:${String(s).padStart(2,"0")}</strong>
          </div>`;
      });
      stepsHtml += "</div>";
    }

    const totalMins = Math.max(1, Math.round(totalSeconds / 60));
    const estKm = (totalMins * 0.18).toFixed(1);

    elWorkoutContent.innerHTML = `
      <div class="stride-workout-detail-hero">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <span style="font-size:0.72rem; font-weight:700; letter-spacing:0.06em; color:rgba(255,255,255,0.72); display:inline-flex; align-items:center; gap:6px;">
            <span class="stride-dot-orange"></span> CARRERA RUNNA · HOY
          </span>
          ${watchBadge ? '<span style="font-size:0.7rem; color:#4ADE80; font-weight:700;">✓ Garmin</span>' : ''}
        </div>
        <div style="display:flex; align-items:baseline; gap:6px;">
          <span class="tabular-num" style="font-size:2.6rem; font-weight:800; line-height:1; letter-spacing:-0.04em;">${estKm}</span>
          <span style="font-size:1rem; font-weight:500; color:rgba(255,255,255,0.68);">km est.</span>
        </div>
        <div class="stride-detail-pills">
          <span class="stride-detail-pill tabular-num">${totalMins} min</span>
          <span class="stride-detail-pill">${workout.phases ? workout.phases.length : 0} fases</span>
          <span class="stride-detail-pill">Garmin FIT</span>
        </div>
        <svg viewBox="0 0 340 36" preserveAspectRatio="none" style="width:100%; height:32px;">
          <path d="M0 28 L45 28 C55 28 58 8 68 8 L120 8 C130 8 132 28 142 28 C152 28 154 8 164 8 L216 8 C226 8 228 28 238 28 C248 28 250 8 260 8 L295 8 C305 8 308 28 318 28 L340 28"
                fill="none" stroke="#FF5500" stroke-width="2.4" stroke-linecap="round"/>
        </svg>
      </div>
      <h3 class="stride-section-title" style="margin-top:6px;">Pasos del entrenamiento</h3>
      ${stepsHtml}`;

    elWorkoutActions.innerHTML = `
      <button id="btn-empezar-carrera" class="btn btn-primary stride-btn-dark guided-action-btn carrera">
        <i data-lucide="play" style="width: 18px; height: 18px;"></i>
        Comenzar Carrera (Runna)
      </button>
      <button id="btn-send-garmin-carrera" class="btn btn-ghost" style="border-radius:9999px; font-weight: 700;" onclick="sendWorkoutToGarminWatch()">
        <i data-lucide="watch" style="width: 18px; height: 18px;"></i>
        ${workout.enviado_al_reloj ? '✅ Enviado a Garmin Connect' : '⌚ Enviar a Garmin Connect'}
      </button>
      <button id="btn-volver" class="btn btn-ghost" style="border-radius:9999px;">
        Atrás
      </button>
    `;

    const btnSyncWatch = document.getElementById("btn-sync-watch");
    if (btnSyncWatch) btnSyncWatch.addEventListener("click", sincronizarAppleWatch);
    document.getElementById("btn-empezar-carrera").addEventListener("click", startGuidedSession);
    document.getElementById("btn-volver").addEventListener("click", mostrarPantallaSeleccion);
  }

  lucide.createIcons();
}

// ============================================================
// WORKOUT GENERATION AND ACTIONS
// ============================================================
async function iniciarGeneracionEntrenamiento(tipo, modoRescate = false) {
  const loadingMsg = modoRescate ? "Preparando algo suave para ti..." : "La IA está diseñando tu entrenamiento...";
  showLoading(true, loadingMsg);
  try {
    const res = await fetch("/generar-entrenamiento", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tipo: tipo, modo_rescate: modoRescate })
    });
    if (res.ok) {
      let workout = await res.json();
      
      // If Yoga, enrich poses with vector graphics from alexcumplido/yoga-api
      if (tipo === "Yoga") {
        try {
          const yogaRes = await fetch("/api/yoga-poses");
          if (yogaRes.ok) {
            const yogaData = await yogaRes.json();
            const posesList = yogaData.poses || [];
            if (workout.ejercicios && posesList.length > 0) {
              workout.ejercicios.forEach(ex => {
                const exNameLower = ex.nombre.toLowerCase();
                const matchedPose = posesList.find(p => 
                  (p.english_name && exNameLower.includes(p.english_name.toLowerCase())) || 
                  (p.sanskrit_name && exNameLower.includes(p.sanskrit_name.toLowerCase())) ||
                  (p.sanskrit_name_adapted && exNameLower.includes(p.sanskrit_name_adapted.toLowerCase()))
                );
                if (matchedPose) {
                  ex.gif_url = matchedPose.url_svg || matchedPose.url_png;
                  ex.equipment = "Esterilla / Yoga";
                  ex.target_muscle = matchedPose.translation_name || "Alineación";
                  ex.tips = matchedPose.pose_benefits || "";
                }
              });
            }
          }
        } catch (yogaErr) {
          console.error("Error enriching yoga poses:", yogaErr);
        }
      }

      state.currentWorkout = workout;
      localStorage.setItem("cached_workout", JSON.stringify(state.currentWorkout));
      localStorage.setItem("cached_workout_date", new Date().toDateString());
      renderWorkout(state.currentWorkout);
    } else {
      if (modoRescate) {
        showError("Incluso la app está cansada hoy. ¡Tómate el día libre sin culpa!");
      } else {
        showError("No pudimos generar el entrenamiento de la IA.");
      }
    }

  } catch (err) {
    console.error("Generar entreno error:", err);
    if (modoRescate) {
      showError("Incluso la app está cansada hoy. ¡Tómate el día libre sin culpa!");
    } else {
      showError("Error de conexión al generar entrenamiento.");
    }
  } finally {
    showLoading(false);
  }
}

async function sincronizarAppleWatch() {
  const workout = state.currentWorkout;
  if (!workout || !workout.phases) return;
  
  showLoading(true, "Sincronizando con Apple Watch...");
  try {
    const res = await fetch("/sincronizar-carrera", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phases: workout.phases })
    });
    if (res.ok) {
      const data = await res.json();
      alert(data.msg);
      // Mark as synchronized
      workout.enviado_al_reloj = true;
      localStorage.setItem("cached_workout", JSON.stringify(workout));
      renderWorkout(workout);
    } else {
      alert("Error de red al sincronizar con Watchletic.");
    }
  } catch (err) {
    console.error("Sync error:", err);
    alert("Error de conexión al sincronizar.");
  } finally {
    showLoading(false);
  }
}

function registrarDescansoHoy() {
  handleRest();
}

// ============================================================
// REST DAY
// ============================================================
async function handleRest() {
  showLoading(true);
  hideSuccessBanner();
  try {
    // Clear today's cache on rest so tomorrow is a fresh choice
    localStorage.removeItem("cached_workout");
    localStorage.removeItem("cached_workout_date");
    localStorage.removeItem("cached_recommendation");
    localStorage.removeItem("cached_recommendation_date");

    const res = await fetch("/webhook-iphone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tipo: "Descanso", completado: true })
    });
    if (res.ok) {
      const data = await res.json();
      state.db = data.db;
      updateStatsBanner();
      showSuccessBanner(false);
      
      // Reload recommendation for the next day
      await initApp();
    } else {
      showError("No pudimos registrar tu descanso.");
    }
  } catch (err) {
    showError("Error de conexión.");
  } finally {
    showLoading(false);
  }
}


// ============================================================
// GUIDED SESSION — START (STRAVA & RUNNA INTEGRATION)
// ============================================================
let stravaState = {
  sessionVolume: 0,
  currentWeight: 40,
  currentReps: 12,
  workedMuscles: new Set()
};

let _runnaNeedleInterval = null;

function speakRunnaCoach(text) {
  if (_audioMuted) return;
  if (!("speechSynthesis" in window)) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "es-ES";
    u.rate = 1.05;
    u.pitch = 1.0;
    const voices = window.speechSynthesis.getVoices();
    const esV = voices.find(v => v.lang.startsWith("es"));
    if (esV) u.voice = esV;
    window.speechSynthesis.speak(u);
  } catch (e) {}

  const bubble = document.getElementById("runna-coach-speech");
  if (bubble) bubble.textContent = `"${text}"`;
}

const MUSCLE_MAP = {
  cuadriceps: ["sentadilla", "squat", "prensa", "zancada", "lunge", "extension", "pierna"],
  gluteos: ["sentadilla", "squat", "gluteo", "hip thrust", "puente", "zancada", "lunge", "peso muerto", "deadlift"],
  isquiotibiales: ["peso muerto", "deadlift", "femoral", "curl femoral", "isquio", "buenos dias"],
  pectoral: ["press banca", "bench press", "flexiones", "push up", "aperturas", "pecho"],
  espalda: ["remo", "row", "dominadas", "pull up", "dorsal", "jalon"],
  hombros: ["press militar", "overhead", "militar", "elevaciones", "deltoid", "hombro"],
  biceps: ["curl", "biceps", "dominadas supinas"],
  triceps: ["fondos", "dips", "press frances", "triceps", "extension triceps"],
  core: ["plancha", "plank", "abdominales", "crunch", "rueda", "pallof", "core"],
  gemelos: ["gemelos", "pantorrilla", "elevacion talon"],
  trapecio: ["encogimientos", "remo al cuello", "peso muerto"]
};

function identifyExerciseMuscles(name) {
  const n = (name || "").toLowerCase();
  const active = [];
  for (const [m, keys] of Object.entries(MUSCLE_MAP)) {
    if (keys.some(k => n.includes(k))) active.push(m);
  }
  return active.length > 0 ? active : ["cuadriceps", "core"];
}

function updateStravaHeatmap(exerciseName) {
  const active = identifyExerciseMuscles(exerciseName);
  active.forEach(m => stravaState.workedMuscles.add(m));

  document.querySelectorAll(".muscle-poly").forEach(el => {
    el.classList.remove("active-target", "secondary-target");
  });

  active.forEach((m, idx) => {
    document.querySelectorAll(`.muscle-poly[data-muscle="${m}"]`).forEach(el => {
      el.classList.add(idx === 0 ? "active-target" : "secondary-target");
    });
  });

  const txt = document.getElementById("strava-active-muscles-text");
  if (txt) {
    txt.textContent = active.map(m => m.charAt(0).toUpperCase() + m.slice(1)).join(", ");
  }
}

function adjustWeight(delta) {
  stravaState.currentWeight = Math.max(0, Math.round((stravaState.currentWeight + delta) * 10) / 10);
  const input = document.getElementById("strava-weight-input");
  if (input) input.value = stravaState.currentWeight;
}

function adjustReps(delta) {
  stravaState.currentReps = Math.max(1, stravaState.currentReps + delta);
  const input = document.getElementById("strava-reps-input");
  if (input) input.value = stravaState.currentReps;
}

function onWeightChange(val) {
  stravaState.currentWeight = Math.max(0, parseFloat(val) || 0);
}

function onRepsChange(val) {
  stravaState.currentReps = Math.max(1, parseInt(val, 10) || 1);
}

function adjustRestTimer(deltaSeconds) {
  if (guided.timerRemaining !== undefined) {
    guided.timerRemaining = Math.max(5, guided.timerRemaining + deltaSeconds);
    guided.timerTotal = Math.max(guided.timerTotal, guided.timerRemaining);
    updateTimerUI(guided.timerRemaining, guided.timerTotal);
    playBeep(750, 0.08);
  }
}

function getPhasePaceTarget(phase) {
  const type = (phase.type || "").toUpperCase();
  const name = (phase.name || "").toLowerCase();
  if (type === "WARMUP" || name.includes("calentam")) return "5:30 - 5:50 /km";
  if (type === "COOLDOWN" || name.includes("enfria") || name.includes("calma")) return "5:50 - 6:20 /km";
  if (name.includes("recup") || name.includes("descanso") || type === "REST") return "6:00 - 6:30 /km";
  if (name.includes("tempo") || name.includes("ritmo")) return "4:35 - 4:45 /km";
  if (name.includes("sprint") || name.includes("intervalo") || name.includes("serie")) return "4:10 - 4:25 /km";
  return "4:30 - 4:45 /km";
}

function renderRunnaTimeline() {
  const container = document.getElementById("runna-timeline-steps");
  if (!container) return;
  container.innerHTML = "";

  guided.exercises.forEach((phase, idx) => {
    const chip = document.createElement("div");
    chip.className = `runna-step-chip ${idx === guided.exIndex ? "active" : ""} ${idx < guided.exIndex ? "completed" : ""}`;
    const durationMin = Math.round((phase.duration_seconds || 300) / 60);
    const targetPace = getPhasePaceTarget(phase);

    chip.innerHTML = `
      <span class="runna-step-chip-name">${idx + 1}. ${phase.name || "Bloque"}</span>
      <span class="runna-step-chip-target">${targetPace || (durationMin + " min")}</span>
    `;
    container.appendChild(chip);
  });

  const stepBadge = document.getElementById("runna-step-badge");
  if (stepBadge) {
    stepBadge.textContent = `Fase ${guided.exIndex + 1} de ${guided.exercises.length}`;
  }

  const activeChip = container.querySelector(".runna-step-chip.active");
  if (activeChip) {
    activeChip.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }
}

function updateRunnaRunningDisplay(phase) {
  const targetPaceStr = getPhasePaceTarget(phase);
  const targetPaceEl = document.getElementById("runna-target-pace-val");
  if (targetPaceEl) targetPaceEl.textContent = targetPaceStr.replace("/km", "").trim();

  const avatarEl = document.getElementById("runna-avatar-canvas");
  const cadenceBadge = document.getElementById("runna-cadence-badge");
  const isSprint = targetPaceStr.includes("4:10") || targetPaceStr.includes("4:25");
  const isWarmup = targetPaceStr.includes("5:30") || targetPaceStr.includes("6:00");

  if (avatarEl) {
    avatarEl.className = isSprint ? "runna-runner-motion cadence-sprint"
      : isWarmup ? "runna-runner-motion cadence-warmup"
      : "runna-runner-motion cadence-jog";
  }

  if (cadenceBadge) {
    cadenceBadge.textContent = isSprint ? "⚡ Cadencia: ~182 ppm"
      : isWarmup ? "🌱 Cadencia: ~160 ppm"
      : "🏃 Cadencia: ~174 ppm";
  }

  const hrEl = document.getElementById("runna-hud-hr");
  if (hrEl) {
    hrEl.textContent = isSprint ? "Z4 Umbral" : isWarmup ? "Z1-Z2 Aeróbica" : "Z3 Tempo";
    hrEl.style.color = isSprint ? "#FF1744" : isWarmup ? "#2979FF" : "#00E676";
  }

  if (_runnaNeedleInterval) clearInterval(_runnaNeedleInterval);
  const needle = document.getElementById("runna-pace-indicator");
  _runnaNeedleInterval = setInterval(() => {
    if (needle && guided.phase === "running") {
      const jitter = 48 + Math.sin(Date.now() / 600) * 4;
      needle.style.left = `${jitter}%`;
    }
  }, 300);

  const coachPrompt = isSprint
    ? `Comenzando intervalo. Objetivo: ritmo ${targetPaceStr}. ¡Aumenta la zancada!`
    : isWarmup
    ? `Fase de ${phase.name || "calentamiento"}. Ritmo suave ${targetPaceStr}. Respira con calma.`
    : `Bloque de carrera. Mantén el ritmo en ${targetPaceStr}.`;
  speakRunnaCoach(coachPrompt);
}

function startGuidedSession() {
  const workout = state.currentWorkout;
  if (!workout) return;

  guided.tipo       = workout.tipo_sesion;
  guided.exercises  = (workout.tipo_sesion === "Fuerza" || workout.tipo_sesion === "Yoga") ? workout.ejercicios : workout.phases;
  guided.exIndex    = 0;
  guided.setIndex   = 0;
  guided.totalSeries= 0;
  guided.startTime  = new Date();
  guided.selectedFeedback = null;
  guided.paused     = false;

  stravaState.sessionVolume = 0;
  stravaState.workedMuscles.clear();

  clearTimer();
  elGuidedFeedbackBtns.forEach(b => b.classList.remove("active"));
  elBtnGuardarSesion.setAttribute("disabled", "true");

  // Reset progress bar colour
  if (guided.tipo === "Carrera") {
    elGuidedProgressFill.className = "guided-progress-fill carrera";
  } else if (guided.tipo === "Yoga") {
    elGuidedProgressFill.className = "guided-progress-fill yoga";
  } else {
    elGuidedProgressFill.className = "guided-progress-fill";
  }

  elGuidedOverlay.style.display = "flex";
  lucide.createIcons();

  unlockAudio();
  playGoSound();

  if (guided.tipo === "Fuerza" || guided.tipo === "Yoga") {
    showFuerzaExercise();
  } else {
    showCarreraPhase();
  }

}

let _stravaFrameInterval = null;
let _stravaRigRaf = null;
let _guidedPhotoUrl = "";
let _guidedShowPhoto = false;

function _stopStravaFrameAnim() {
  if (_stravaFrameInterval) {
    clearInterval(_stravaFrameInterval);
    _stravaFrameInterval = null;
  }
}

function stopStravaMotionRig() {
  if (_stravaRigRaf) {
    cancelAnimationFrame(_stravaRigRaf);
    _stravaRigRaf = null;
  }
}

function startStravaMotionRig(animClass) {
  stopStravaMotionRig();
  const svg = document.getElementById("strava-motion-svg");
  if (!svg) return;

  const setL = (id, x1, y1, x2, y2) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.setAttribute("x1", x1);
    el.setAttribute("y1", y1);
    el.setAttribute("x2", x2);
    el.setAttribute("y2", y2);
  };
  const setC = (id, cx, cy, r) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.setAttribute("cx", cx);
    el.setAttribute("cy", cy);
    if (r !== undefined) el.setAttribute("r", r);
  };

  const tempoEl = document.getElementById("guided-tempo-text");
  const mode = (animClass || "anim-squat").replace("anim-", "");

  function frame(ts) {
    // 3.2s full rep cycle: smooth eccentric -> pause -> concentric
    const t = (ts % 3200) / 3200;
    const p = 0.5 - 0.5 * Math.cos(t * Math.PI * 2); // 0 -> 1 -> 0

    if (tempoEl && !_guidedShowPhoto) {
      if (t < 0.42) tempoEl.textContent = "⬇️ BAJADA CONTROLADA (3s)";
      else if (t < 0.58) tempoEl.textContent = "🔥 CONTRACCIÓN MÁXIMA (1s)";
      else tempoEl.textContent = "⬆️ EMPUJE EXPLOSIVO (1s)";
    }

    if (mode === "squat") {
      const hipY = 95 + p * 36;
      const kneeX = 124 + p * 22;
      const kneeY = 128 + p * 8;
      const torsoLean = p * 12;
      setC("rig-shadow", 120, 162, 30 + p * 10);
      setC("rig-muscle-glow", 120, hipY + 8, 22 + p * 10);
      setL("rig-torso", 120 - torsoLean * 0.4, hipY, 120 + torsoLean, hipY - 43);
      setC("rig-head", 120 + torsoLean + 2, hipY - 58);
      // Legs
      setL("rig-thigh-b", 120 - torsoLean * 0.4, hipY, kneeX - 10, kneeY);
      setL("rig-calf-b", kneeX - 10, kneeY, 108, 158);
      setL("rig-thigh-f", 120 - torsoLean * 0.4, hipY, kneeX + 6, kneeY);
      setL("rig-calf-f", kneeX + 6, kneeY, 126, 158);
      // Arms holding 5kg dumbbells
      const shX = 120 + torsoLean, shY = hipY - 38;
      const handX = shX + 18 + p * 18, handY = shY + 26 - p * 18;
      setL("rig-uarm-b", shX, shY, shX + 8, shY + 18);
      setL("rig-farm-b", shX + 8, shY + 18, handX - 8, handY);
      setC("rig-db-b", handX - 8, handY);
      setL("rig-uarm-f", shX, shY, shX + 10, shY + 20);
      setL("rig-farm-f", shX + 10, shY + 20, handX, handY);
      setC("rig-db-f", handX, handY);
    } else if (mode === "lunge") {
      const hipY = 95 + p * 28;
      setC("rig-shadow", 120, 162, 38);
      setC("rig-muscle-glow", 126, hipY + 12, 22 + p * 10);
      setL("rig-torso", 120, hipY, 122, hipY - 43);
      setC("rig-head", 122, hipY - 58);
      // Split legs
      setL("rig-thigh-b", 120, hipY, 92, 126 + p * 20);
      setL("rig-calf-b", 92, 126 + p * 20, 74, 158);
      setL("rig-thigh-f", 120, hipY, 152, 122 + p * 8);
      setL("rig-calf-f", 152, 122 + p * 8, 154, 158);
      // Arms at sides with 5kg dumbbells
      setL("rig-uarm-b", 122, hipY - 38, 108, hipY - 14);
      setL("rig-farm-b", 108, hipY - 14, 106, hipY + 6);
      setC("rig-db-b", 106, hipY + 6);
      setL("rig-uarm-f", 122, hipY - 38, 134, hipY - 14);
      setL("rig-farm-f", 134, hipY - 14, 136, hipY + 6);
      setC("rig-db-f", 136, hipY + 6);
    } else if (mode === "press") {
      // Overhead / shoulder press with 5kg dumbbells
      setC("rig-shadow", 120, 162, 28);
      setC("rig-muscle-glow", 120, 56, 20 + p * 12);
      setL("rig-torso", 120, 98, 120, 54);
      setC("rig-head", 120, 36);
      setL("rig-thigh-b", 120, 98, 110, 128);
      setL("rig-calf-b", 110, 128, 108, 158);
      setL("rig-thigh-f", 120, 98, 130, 128);
      setL("rig-calf-f", 130, 128, 132, 158);
      const elbowY = 62 - p * 26;
      const handY = 42 - p * 28;
      setL("rig-uarm-b", 120, 58, 94, elbowY);
      setL("rig-farm-b", 94, elbowY, 98, handY);
      setC("rig-db-b", 98, handY);
      setL("rig-uarm-f", 120, 58, 146, elbowY);
      setL("rig-farm-f", 146, elbowY, 142, handY);
      setC("rig-db-f", 142, handY);
    } else if (mode === "row") {
      // Bent-over row / hinge with 5kg dumbbells
      setC("rig-shadow", 120, 162, 34);
      setC("rig-muscle-glow", 126, 72, 20 + p * 10);
      setL("rig-torso", 104, 100, 144, 68);
      setC("rig-head", 156, 56);
      setL("rig-thigh-b", 104, 100, 98, 130);
      setL("rig-calf-b", 98, 130, 96, 158);
      setL("rig-thigh-f", 104, 100, 116, 130);
      setL("rig-calf-f", 116, 130, 114, 158);
      const pullY = 122 - p * 44;
      setL("rig-uarm-b", 140, 72, 136 - p * 16, pullY - 12);
      setL("rig-farm-b", 136 - p * 16, pullY - 12, 138, pullY);
      setC("rig-db-b", 138, pullY);
      setL("rig-uarm-f", 144, 72, 140 - p * 16, pullY - 12);
      setL("rig-farm-f", 140 - p * 16, pullY - 12, 146, pullY);
      setC("rig-db-f", 146, pullY);
    } else {
      // Plank / Core isometric hold with breathing pulse
      const breath = Math.sin(ts / 450) * 2.5;
      setC("rig-shadow", 120, 162, 65);
      setC("rig-muscle-glow", 120, 128 + breath, 22 + Math.abs(breath) * 2);
      setL("rig-torso", 76, 132 + breath, 154, 122 + breath);
      setC("rig-head", 172, 116 + breath);
      setL("rig-thigh-b", 76, 132 + breath, 52, 146);
      setL("rig-calf-b", 52, 146, 38, 158);
      setL("rig-thigh-f", 76, 132 + breath, 54, 148);
      setL("rig-calf-f", 54, 148, 40, 158);
      setL("rig-uarm-b", 150, 124 + breath, 154, 144);
      setL("rig-farm-b", 154, 144, 168, 156);
      setC("rig-db-b", 168, 156, 3);
      setL("rig-uarm-f", 154, 124 + breath, 158, 144);
      setL("rig-farm-f", 158, 144, 174, 156);
      setC("rig-db-f", 174, 156, 3);
    }

    _stravaRigRaf = requestAnimationFrame(frame);
  }
  _stravaRigRaf = requestAnimationFrame(frame);
}

function toggleGuidedMediaMode() {
  _guidedShowPhoto = !_guidedShowPhoto;
  const canvasEl = document.getElementById("guided-biomechanics-canvas");
  const imgEl = document.getElementById("guided-exercise-img");
  const btn = document.getElementById("btn-toggle-ex-photo");

  if (_guidedShowPhoto && _guidedPhotoUrl && imgEl) {
    stopStravaMotionRig();
    if (canvasEl) canvasEl.style.display = "none";
    imgEl.src = _guidedPhotoUrl;
    imgEl.style.display = "block";
    if (btn) btn.textContent = "🏃 Ver Muñeco";
  } else {
    _guidedShowPhoto = false;
    if (imgEl) imgEl.style.display = "none";
    if (canvasEl) canvasEl.style.display = "flex";
    if (btn) btn.textContent = "📷 Ver Foto";
    const animClass = canvasEl?.dataset?.anim || "anim-squat";
    startStravaMotionRig(animClass);
  }
}

function closeGuided() {
  clearTimer();
  _stopStravaFrameAnim();
  stopStravaMotionRig();
  if (_runnaNeedleInterval) {
    clearInterval(_runnaNeedleInterval);
    _runnaNeedleInterval = null;
  }
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  elGuidedOverlay.style.display = "none";
}

// ============================================================
// FUERZA — exercise display & progression (STRAVA STRENGTH)
// ============================================================
function showFuerzaExercise() {
  const ex = guided.exercises[guided.exIndex];
  guided.phase = "working";

  updateProgress();
  setPhaseLabel("EJERCICIO", "working");

  // Show Strength container, hide Running container
  const strengthCont = document.getElementById("guided-strength-container");
  const runningCont  = document.getElementById("guided-running-container");
  const restCtrls    = document.getElementById("strava-rest-quick-ctrls");
  if (strengthCont) strengthCont.style.display = "flex";
  if (runningCont)  runningCont.style.display  = "none";
  if (restCtrls)    restCtrls.style.display    = "none";

  // Update Assisted Video Demo & Tempo Cues
  updateGuidedVideo(ex.nombre, ex.descripcion);

  elGuidedExName.textContent = ex.nombre;
  elGuidedExName.style.animation = "none";
  requestAnimationFrame(() => elGuidedExName.style.animation = "");

  // Parse suggested reps or default
  const parsedReps = parseInt((ex.repeticiones || "").replace(/\D/g, ""), 10) || 12;
  stravaState.currentReps = parsedReps;

  const repsInput = document.getElementById("strava-reps-input");
  if (repsInput) repsInput.value = stravaState.currentReps;

  const weightInput = document.getElementById("strava-weight-input");
  if (weightInput) weightInput.value = stravaState.currentWeight;

  const setBadge = document.getElementById("guided-set-counter-badge");
  if (setBadge) setBadge.textContent = `Serie ${guided.setIndex + 1} de ${ex.series}`;

  const volumeChip = document.getElementById("strava-total-volume-chip");
  if (volumeChip) volumeChip.textContent = `${stravaState.sessionVolume} kg movidos`;

  // Update Strava Muscular Heatmap
  updateStravaHeatmap(ex.nombre);

  elGuidedSetCurrent.textContent = guided.setIndex + 1;
  elGuidedSetTotal.textContent   = ex.series;
  elGuidedReps.textContent       = ex.repeticiones;

  // Show or hide description tip
  let descEl = document.getElementById("guided-ex-desc");
  if (ex.descripcion) {
    if (!descEl) {
      descEl = document.createElement("div");
      descEl.id = "guided-ex-desc";
      descEl.className = "guided-ex-desc";
      elGuidedReps.insertAdjacentElement("afterend", descEl);
    }
    descEl.textContent = ex.descripcion;
    descEl.style.display = "block";
  } else if (descEl) {
    descEl.style.display = "none";
  }

  show(elGuidedSetCounter);
  show(elGuidedReps);

  const workSeconds = getDurationFromReps(ex.repeticiones);
  const isYoga = guided.tipo === "Yoga";

  if (workSeconds) {
    show(elGuidedTimerWrap);
    elGuidedTimerArc.className = isYoga ? "guided-timer-arc yoga" : "guided-timer-arc";
    updateTimerUI(workSeconds, workSeconds);

    elGuidedActionsFuerza.innerHTML = `
      <button id="btn-start-work-fuerza" class="btn btn-primary guided-action-btn ${isYoga ? 'yoga' : ''}" style="${isYoga ? '' : 'background: linear-gradient(135deg, #FC5200 0%, #FF7A00 100%); border:none;'}">
        <i data-lucide="play" style="width:22px;height:22px;"></i>
        ${isYoga ? 'Mantener Postura' : 'Iniciar Serie'} (${ex.repeticiones})
      </button>
      <button id="btn-skip-exercise" class="btn btn-ghost" style="font-size:0.9rem; padding:12px;">
        <i data-lucide="skip-forward" style="width:18px;height:18px;"></i>
        ${isYoga ? 'Saltar Postura' : 'Saltar ejercicio'}
      </button>
    `;
    lucide.createIcons();

    document.getElementById("btn-start-work-fuerza").addEventListener("click", () => {
      elGuidedActionsFuerza.innerHTML = `
        <button id="btn-skip-work-timer" class="btn btn-primary guided-action-btn ${isYoga ? 'yoga' : ''}" style="${isYoga ? 'background: #A78BFA !important; box-shadow: 0 8px 30px rgba(167, 139, 250, 0.3) !important; color:#0e0e10 !important;' : 'background: #FC5200 !important; box-shadow: 0 8px 30px rgba(252, 82, 0, 0.35) !important;'}">
          <i data-lucide="skip-forward" style="width:22px;height:22px;"></i>
          ${isYoga ? 'Siguiente Asana' : `Completar Serie (${stravaState.currentWeight}kg × ${stravaState.currentReps})`}
        </button>
      `;
      lucide.createIcons();
      document.getElementById("btn-skip-work-timer").addEventListener("click", () => {
        clearTimer();
        onSerieDone();
      });

      startCountdown(workSeconds, () => {
        onSerieDone();
      });
    });

    document.getElementById("btn-skip-exercise").addEventListener("click", onSkipExercise);
  } else {
    hide(elGuidedTimerWrap);
    elGuidedActionsFuerza.innerHTML = `
      <button id="btn-serie-done" class="btn btn-primary guided-action-btn ${isYoga ? 'yoga' : ''}" style="${isYoga ? '' : 'background: linear-gradient(135deg, #FC5200 0%, #FF7A00 100%); border:none; box-shadow: 0 4px 18px rgba(252,82,0,0.35);'}">
        <i data-lucide="check" style="width:22px;height:22px;"></i>
        ${isYoga ? 'Postura completada' : `Completar Serie (${stravaState.currentWeight}kg × ${stravaState.currentReps})`}
      </button>
      <button id="btn-skip-exercise" class="btn btn-ghost" style="font-size:0.9rem; padding:12px;">
        <i data-lucide="skip-forward" style="width:18px;height:18px;"></i>
        ${isYoga ? 'Saltar Postura' : 'Saltar ejercicio'}
      </button>
    `;
    lucide.createIcons();

    document.getElementById("btn-serie-done").addEventListener("click", onSerieDone);
    document.getElementById("btn-skip-exercise").addEventListener("click", onSkipExercise);
  }

  showActions("fuerza");
}

function onSerieDone() {
  guided.totalSeries++;
  
  // Calculate Strava Volume (kg * reps)
  const setVolume = Math.round(stravaState.currentWeight * stravaState.currentReps);
  stravaState.sessionVolume += setVolume;

  const volumeChip = document.getElementById("strava-total-volume-chip");
  if (volumeChip) volumeChip.textContent = `${stravaState.sessionVolume} kg movidos`;

  playSetCompleteSound();
  const ex = guided.exercises[guided.exIndex];

  if (guided.setIndex + 1 < ex.series) {
    // More sets → rest
    guided.setIndex++;
    startRest();
  } else {
    // All sets done → next exercise
    guided.setIndex = 0;
    guided.exIndex++;
    if (guided.exIndex < guided.exercises.length) {
      showFuerzaExercise();
    } else {
      showDone();
    }
  }
}

function onSkipExercise() {
  clearTimer();
  playSkipSound();
  guided.setIndex = 0;
  guided.exIndex++;
  if (guided.exIndex < guided.exercises.length) {
    showFuerzaExercise();
  } else {
    showDone();
  }
}

// ============================================================
// REST TIMER (STRAVA REST CONTROLS)
// ============================================================
function startRest() {
  guided.phase = "resting";
  const isYoga = guided.tipo === "Yoga";
  setPhaseLabel(isYoga ? "TRANSICIÓN" : "DESCANSO", "resting");
  updateProgress();

  hide(elGuidedSetCounter);
  hide(elGuidedReps);
  elGuidedExName.textContent = isYoga ? "Cambio de Postura" : "Descansa";

  // Show quick rest +/-15s buttons
  const restCtrls = document.getElementById("strava-rest-quick-ctrls");
  if (restCtrls) restCtrls.style.display = "flex";

  showActions("rest");
  show(elGuidedTimerWrap);
  elGuidedTimerArc.className = isYoga ? "guided-timer-arc yoga" : "guided-timer-arc";

  const duration = isYoga ? 10 : REST_DURATION;

  startCountdown(duration, () => {
    // Auto-advance after rest with sound ping
    playGoSound();
    showFuerzaExercise();
  });
}


function onSkipRest() {
  clearTimer();
  playSkipSound();
  showFuerzaExercise();
}

// ============================================================
// CARRERA — phase display & progression (RUNNA RUNNING)
// ============================================================
function showCarreraPhase() {
  if (guided.exIndex >= guided.exercises.length) { showDone(); return; }

  const phase = guided.exercises[guided.exIndex];
  guided.phase = "running";
  guided.paused = false;

  updateProgress();

  // Show Running container, hide Strength container
  const strengthCont = document.getElementById("guided-strength-container");
  const runningCont  = document.getElementById("guided-running-container");
  const restCtrls    = document.getElementById("strava-rest-quick-ctrls");
  if (strengthCont) strengthCont.style.display = "none";
  if (runningCont)  runningCont.style.display  = "flex";
  if (restCtrls)    restCtrls.style.display    = "none";

  const typeLabel = phase.type === "WARMUP" ? "CALENTAMIENTO"
    : phase.type === "COOLDOWN" ? "ENFRIAMIENTO"
    : "INTERVALO RUNNA";
  setPhaseLabel(typeLabel, "running");

  elGuidedExName.textContent = phase.name;
  elGuidedExName.style.animation = "none";
  requestAnimationFrame(() => elGuidedExName.style.animation = "");

  hide(elGuidedSetCounter);
  hide(elGuidedReps);
  show(elGuidedTimerWrap);
  elGuidedTimerArc.className = "guided-timer-arc carrera-arc";

  // Update Runna timeline and display
  renderRunnaTimeline();
  updateRunnaRunningDisplay(phase);

  updatePauseBtn(false);
  showActions("carrera");

  startCountdown(phase.duration_seconds, () => {
    guided.exIndex++;
    showCarreraPhase();
  });
}

function onPauseCarrera() {
  if (!guided.paused) {
    pauseTimer();
    guided.paused = true;
    updatePauseBtn(true);
    speakRunnaCoach("Sesión pausada. Tómate un respiro.");
  } else {
    resumeTimer();
    guided.paused = false;
    updatePauseBtn(false);
    speakRunnaCoach("Reanudando. ¡A por ello!");
  }
}

function updatePauseBtn(isPaused) {
  elBtnPauseCarrera.innerHTML = isPaused
    ? `<i data-lucide="play" style="width:18px;height:18px;"></i> Continuar`
    : `<i data-lucide="pause" style="width:18px;height:18px;"></i> Pausar Intervalo`;
  lucide.createIcons();
}

// ============================================================
// DONE SCREEN (STRAVA & RUNNA SUMMARY)
// ============================================================
function showDone() {
  clearTimer();
  guided.phase = "done";
  playWorkoutCompleteSound();

  if (_runnaNeedleInterval) {
    clearInterval(_runnaNeedleInterval);
    _runnaNeedleInterval = null;
  }

  setPhaseLabel("¡COMPLETADO!", "done");
  updateProgress(true);

  const elapsed = Math.round((new Date() - guided.startTime) / 1000);
  const mins    = Math.floor(elapsed / 60);

  const strengthCont = document.getElementById("guided-strength-container");
  const runningCont  = document.getElementById("guided-running-container");
  const restCtrls    = document.getElementById("strava-rest-quick-ctrls");
  if (strengthCont) strengthCont.style.display = "none";
  if (runningCont)  runningCont.style.display  = "none";
  if (restCtrls)    restCtrls.style.display    = "none";

  elGuidedExName.style.display = "none";
  hide(elGuidedSetCounter);
  hide(elGuidedReps);
  hide(elGuidedTimerWrap);

  const workedMusclesList = Array.from(stravaState.workedMuscles)
    .map(m => m.charAt(0).toUpperCase() + m.slice(1))
    .join(", ");

  // Build done content inside main
  const mainEl = document.querySelector(".guided-main");
  mainEl.innerHTML = `
    <div class="guided-done-emoji">${guided.tipo === "Fuerza" ? "🏋️‍♂️" : "🏃"}</div>
    <div class="guided-done-title" style="margin-bottom: 4px;">¡Sesión completada!</div>
    <div style="margin-bottom: 16px;">
      <span class="label-caps" style="color: ${guided.tipo === "Fuerza" ? "#FC5200" : "#00E676"}; font-size: 0.8rem; font-weight: 800;">
        ${guided.tipo === "Fuerza" ? "STRAVA STRENGTH SUMMARY" : "RUNNA COACHING SUMMARY"}
      </span>
    </div>

    <div class="guided-done-stats">
      <div class="guided-done-stat">
        <div class="guided-done-stat-value">${mins} min</div>
        <div class="guided-done-stat-label">Duración</div>
      </div>
      ${guided.tipo === "Fuerza" ? `
      <div class="guided-done-stat">
        <div class="guided-done-stat-value" style="color: #FC5200;">${stravaState.sessionVolume} kg</div>
        <div class="guided-done-stat-label">Volumen Total</div>
      </div>
      <div class="guided-done-stat">
        <div class="guided-done-stat-value">${guided.totalSeries}</div>
        <div class="guided-done-stat-label">Series</div>
      </div>` : `
      <div class="guided-done-stat">
        <div class="guided-done-stat-value" style="color: #00E676;">${guided.exercises.length}</div>
        <div class="guided-done-stat-label">Intervalos</div>
      </div>
      <div class="guided-done-stat">
        <div class="guided-done-stat-value">100%</div>
        <div class="guided-done-stat-label">En Ritmo</div>
      </div>`}
    </div>

    ${guided.tipo === "Fuerza" && workedMusclesList ? `
      <div style="background: rgba(252,82,0,0.1); border: 1px solid rgba(252,82,0,0.3); border-radius: var(--rounded-md); padding: 10px 14px; margin-top: 14px; max-width: 340px; text-align: center;">
        <span class="label-caps" style="color: #FC5200; font-size: 0.72rem;">MÚSCULOS ENTRENADOS:</span>
        <div class="body-sm" style="color: var(--on-surface); font-weight: 700; margin-top: 4px;">${workedMusclesList}</div>
      </div>
    ` : ""}
  `;

  if (guided.tipo === "Carrera") {
    speakRunnaCoach("¡Excelente entrenamiento! Has completado todas las fases con éxito.");
  }

  showActions("done");
  lucide.createIcons();
}

// ============================================================
// SAVE SESSION → backend → Intervals.icu
// ============================================================
async function onGuardarSesion() {
  elBtnGuardarSesion.setAttribute("disabled", "true");
  elBtnGuardarSesion.textContent = "Guardando…";

  const elapsed = Math.round((new Date() - guided.startTime) / 1000);

  const payload = {
    tipo:                   guided.tipo,
    duracion_segundos:      elapsed,
    esfuerzo_subjetivo:     guided.selectedFeedback,
    series_completadas:     (guided.tipo === "Fuerza" || guided.tipo === "Yoga") ? guided.totalSeries : null,
    ejercicios_completados: (guided.tipo === "Fuerza" || guided.tipo === "Yoga") ? guided.exercises.length : null,

    distancia_km:           null,
    calorias:               null,
    frecuencia_cardiaca_media: null
  };

  // Note: HR and calories come from Apple Watch → Apple Health → Intervals.icu
  // We only register what we actually know: duration, type, effort, series count


  try {
    const res = await fetch("/registrar-actividad", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      const data = await res.json();
      state.db = data.db;
      closeGuided();
      updateStatsBanner();
      showSuccessBanner(true, data.registrado_en_intervals);
      
      // Clear today's cache as the session is completed successfully
      localStorage.removeItem("cached_workout");
      localStorage.removeItem("cached_workout_date");
      localStorage.removeItem("cached_recommendation");
      localStorage.removeItem("cached_recommendation_date");

      showLoading(true);
      await initApp();
      showLoading(false);

    } else {
      elBtnGuardarSesion.textContent = "Error. Reintentar";
      elBtnGuardarSesion.removeAttribute("disabled");
    }
  } catch (err) {
    console.error("Save error:", err);
    elBtnGuardarSesion.textContent = "Error. Reintentar";
    elBtnGuardarSesion.removeAttribute("disabled");
  }
}

// ============================================================
// COUNTDOWN TIMER
// ============================================================
let _pausedRemaining = 0;

function startCountdown(seconds, onDone) {
  clearTimer();
  guided.timerTotal     = seconds;
  guided.timerRemaining = seconds;
  _pausedRemaining = 0;

  updateTimerUI(seconds, seconds);

  guided.timerInterval = setInterval(() => {
    guided.timerRemaining--;
    updateTimerUI(guided.timerRemaining, guided.timerTotal);

    // Update Runna HUD if in running phase
    if (guided.phase === "running") {
      const hudTime = document.getElementById("runna-hud-time");
      if (hudTime) {
        const m = Math.floor(guided.timerRemaining / 60);
        const s = guided.timerRemaining % 60;
        hudTime.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
      }

      const hudDist = document.getElementById("runna-hud-dist");
      if (hudDist) {
        const elapsedSecs = guided.timerTotal - guided.timerRemaining;
        // Assume avg ~4:45/km = 285s/km -> ~0.0035 km/s
        const estDist = (elapsedSecs / 285).toFixed(2);
        hudDist.textContent = `${estDist} km`;
      }

      // Coaching triggers
      if (guided.timerTotal > 30 && guided.timerRemaining === Math.floor(guided.timerTotal / 2)) {
        speakRunnaCoach("Mitad de fase completada. ¡Mantén esa zancada!");
      } else if (guided.timerRemaining === 10 && guided.timerTotal >= 20) {
        speakRunnaCoach("10 segundos. ¡Fuerza hasta el final!");
      }
    }
    
    // Play warning count down sound on 3, 2, 1 seconds left
    if (guided.timerRemaining >= 1 && guided.timerRemaining <= 3) {
      playBeep(600, 0.12);
    } else if (guided.timerRemaining === 0) {
      // Deeper beep indicating start/end
      playBeep(900, 0.25);
    }

    if (guided.timerRemaining <= 0) {
      clearTimer();
      onDone();
    }
  }, 1000);
}

function pauseTimer() {
  _pausedRemaining = guided.timerRemaining;
  clearTimer();
}

function resumeTimer() {
  guided.timerRemaining = _pausedRemaining;
  updateTimerUI(_pausedRemaining, guided.timerTotal);
  guided.timerInterval = setInterval(() => {
    guided.timerRemaining--;
    updateTimerUI(guided.timerRemaining, guided.timerTotal);

    if (guided.phase === "running") {
      const hudTime = document.getElementById("runna-hud-time");
      if (hudTime) {
        const m = Math.floor(guided.timerRemaining / 60);
        const s = guided.timerRemaining % 60;
        hudTime.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
      }
    }

    // Play warning count down sound on 3, 2, 1 seconds left
    if (guided.timerRemaining >= 1 && guided.timerRemaining <= 3) {
      playBeep(600, 0.12);
    } else if (guided.timerRemaining === 0) {
      playBeep(900, 0.25);
    }

    if (guided.timerRemaining <= 0) {
      clearTimer();
      guided.exIndex++;
      showCarreraPhase();
    }
  }, 1000);
}

function clearTimer() {
  if (guided.timerInterval) {
    clearInterval(guided.timerInterval);
    guided.timerInterval = null;
  }
}

function updateTimerUI(remaining, total) {
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  elGuidedTimerDisplay.textContent = `${m > 0 ? m + ":" : ""}${String(s).padStart(m > 0 ? 2 : 1, "0")}`;

  // SVG arc
  const ratio  = total > 0 ? remaining / total : 0;
  const offset = CIRCUMFERENCE * (1 - ratio);
  elGuidedTimerArc.style.strokeDashoffset = offset;
}

// ============================================================
// HELPERS — audio synthesize & time parsing (Web Audio API)
// ============================================================
let _audioCtx = null;
let _audioMuted = false;

function getAudioCtx() {
  if (_audioMuted) return null;
  if (!_audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      _audioCtx = new AudioContextClass();
    }
  }
  if (_audioCtx && _audioCtx.state === "suspended") {
    _audioCtx.resume();
  }
  return _audioCtx;
}

function unlockAudio() {
  const ctx = getAudioCtx();
  if (ctx && ctx.state === "suspended") {
    ctx.resume();
  }
}

function toggleAudioMute() {
  _audioMuted = !_audioMuted;
  const iconEl = document.getElementById("guided-audio-icon");
  if (iconEl) {
    iconEl.setAttribute("data-lucide", _audioMuted ? "volume-x" : "volume-2");
    iconEl.style.color = _audioMuted ? "var(--text-muted)" : "var(--primary)";
    if (window.lucide) lucide.createIcons();
  }
  showSuccessBanner(_audioMuted ? "🔇 Avisos sonoros desactivados" : "🔊 Avisos sonoros activados");
}

function playBeep(frequency = 800, duration = 0.12, type = "sine", volume = 0.15) {
  try {
    const ctx = getAudioCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, now);
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + duration);
  } catch (e) {}
}

function playSetCompleteSound() {
  try {
    const ctx = getAudioCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(587.33, now); // D5
    osc.frequency.exponentialRampToValueAtTime(880, now + 0.15); // A5
    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.35);
  } catch (e) {}
}

function playGoSound() {
  try {
    const ctx = getAudioCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(880, now); // A5
    osc.frequency.exponentialRampToValueAtTime(1318.51, now + 0.2); // E6
    gain.gain.setValueAtTime(0.35, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.4);
  } catch (e) {}
}

function playSkipSound() {
  try {
    const ctx = getAudioCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(600, now);
    osc.frequency.exponentialRampToValueAtTime(300, now + 0.15);
    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.18);
  } catch (e) {}
}

function playWorkoutCompleteSound() {
  try {
    const ctx = getAudioCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6 Major chord
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(freq, now + i * 0.1);
      gain.gain.setValueAtTime(0.3, now + i * 0.1);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.1 + 0.6);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + i * 0.1);
      osc.stop(now + i * 0.1 + 0.6);
    });
  } catch (e) {}
}

function getDurationFromReps(repsStr) {
  if (!repsStr) return null;
  const clean = repsStr.toLowerCase();

  // Match minutes: e.g. "3 min" or "2 min" or "1 min por lado"
  if (clean.includes("min") || clean.includes("minuto") || clean.includes("minute")) {
    const match = clean.match(/\d+/);
    if (match) {
      return parseInt(match[0], 10) * 60;
    }
  }

  // Match seconds
  if (clean.includes("seg") || clean.includes("segundos") || clean.includes(" sec") || clean.includes("second") || (clean.endsWith("s") && !clean.includes("reps") && !clean.includes("series"))) {
    const match = clean.match(/\d+/);
    if (match) {
      return parseInt(match[0], 10);
    }
  }
  return null;
}


// ============================================================
// HELPERS — show/hide action panels
// ============================================================
function showActions(panel) {
  hide(elGuidedActionsFuerza);
  hide(elGuidedActionsRest);
  hide(elGuidedActionsCarrera);
  hide(elGuidedActionsDone);

  if (panel === "fuerza")   show(elGuidedActionsFuerza,  "flex");
  if (panel === "rest")     show(elGuidedActionsRest,    "flex");
  if (panel === "carrera")  show(elGuidedActionsCarrera, "flex");
  if (panel === "done")     show(elGuidedActionsDone,    "flex");
}

function show(el, display = "block") { if (el) el.style.display = display; }
function hide(el)                    { if (el) el.style.display = "none"; }

function setPhaseLabel(text, cls) {
  elGuidedPhaseLabel.textContent  = text;
  elGuidedPhaseLabel.className    = `guided-phase-label ${cls}`;
}

function updateProgress(forceComplete = false) {
  const total   = guided.exercises.length;
  const current = forceComplete ? total : guided.exIndex;
  const pct     = total > 0 ? (current / total) * 100 : 0;
  elGuidedProgressFill.style.width = `${pct}%`;

  const label = forceComplete
    ? `${total}/${total}`
    : `${Math.min(guided.exIndex + 1, total)}/${total}`;
  elGuidedCounter.textContent = label;
}

// ============================================================
// SUCCESS BANNER
// ============================================================
function showSuccessBanner(completado, synced = false) {
  elSuccessBanner.style.display = "flex";
  if (completado) {
    const syncMsg = synced ? " Registrado en Intervals.icu ✅" : "";
    elSuccessText.innerHTML = `💪 <strong>¡Sesión guardada!</strong>${syncMsg} Tu próxima rutina está lista.`;
  } else {
    elSuccessText.innerHTML = `🧘 <strong>Día de descanso registrado.</strong> Sin culpas. Tu entrenamiento te espera mañana.`;
  }
  window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  setTimeout(hideSuccessBanner, 6000);
}

function hideSuccessBanner() { elSuccessBanner.style.display = "none"; }

// ============================================================
// STRAVA TRAINING TAB (#tab-training)
// ============================================================
function _buildWorkoutFromPlannedDay(d) {
  const isFuerza = d.tipo === "Fuerza";
  return {
    tipo_sesion: isFuerza ? "Fuerza" : (d.tipo === "Ciclismo" ? "Ciclismo" : "Carrera"),
    fecha: d.fecha,
    titulo: d.titulo,
    explicacion_tipo: d.detalle || d.titulo,
    mensaje_adaptacion: `${d.dia} (${d.fecha}) • ${d.zona_objetivo || ""}`,
    nota_coach: d.detalle || "",
    ejercicios: d.ejercicios || [],
    phases: d.phases || []
  };
}

function renderTrainingTab(plan) {
  if (!plan) return;
  _latestWeeklyPlan = plan;

  const weekRange = document.getElementById("training-week-range");
  if (weekRange && plan.semana_inicio && plan.semana_fin) {
    const comp = plan.weekly_compliance;
    weekRange.textContent = comp
      ? `${plan.semana_inicio} – ${plan.semana_fin} • ${comp.overall_pct}% (${comp.status_label})`
      : `${plan.semana_inicio} – ${plan.semana_fin}`;
  }

  const goals = plan.goals || {};
  const prog = plan.week_progress || {};
  const gRun = Number(goals.goal_run_km ?? plan.objetivo_km_carrera ?? 20);
  const gBike = Number(goals.goal_bike_km ?? 35);
  const gStr = Number(goals.goal_strength_sessions ?? 2);
  const pRun = Number(prog.run_km || 0);
  const pBike = Number(prog.bike_km || 0);
  const pStr = Number(prog.strength_sessions || 0);

  const setBar = (lblId, barId, txt, pct) => {
    const l = document.getElementById(lblId);
    const b = document.getElementById(barId);
    if (l) l.textContent = txt;
    if (b) b.style.width = `${Math.min(100, Math.max(0, Math.round(pct)))}%`;
  };
  setBar("goal-run-progress-label", "goal-run-bar", `${pRun.toFixed(1)} / ${gRun} km`, gRun > 0 ? (pRun / gRun) * 100 : 0);
  setBar("goal-bike-progress-label", "goal-bike-bar", `${pBike.toFixed(1)} / ${gBike} km`, gBike > 0 ? (pBike / gBike) * 100 : 0);
  setBar("goal-strength-progress-label", "goal-strength-bar", `${pStr} / ${gStr} ses`, gStr > 0 ? (pStr / gStr) * 100 : 0);

  const inRun = document.getElementById("input-goal-run-km");
  const inBike = document.getElementById("input-goal-bike-km");
  const inStr = document.getElementById("input-goal-strength-ses");
  if (inRun) inRun.value = gRun;
  if (inBike) inBike.value = gBike;
  if (inStr) inStr.value = gStr;

  const planType = plan.plan_type || goals.plan_type || "mantenimiento";
  const planLabels = {
    mantenimiento: "BASE / MANTENIMIENTO",
    "10k": "PLAN 10K",
    "21k": "PLAN MEDIA MARATÓN",
    ciclismo: "GRAN FONDO BICI"
  };
  const badge = document.getElementById("training-plan-badge");
  if (badge) badge.textContent = planLabels[planType] || "BASE / MANTENIMIENTO";

  document.querySelectorAll(".training-plan-pill").forEach(btn => {
    btn.classList.toggle("active", btn.getAttribute("data-plan") === planType);
  });

  const race = plan.carrera_objetivo;
  if (race && race.activo) {
    const rName = document.getElementById("training-race-name");
    const rDate = document.getElementById("training-race-date");
    const rDist = document.getElementById("training-race-dist");
    if (rName) rName.value = race.nombre || "";
    if (rDate) rDate.value = (race.fecha || "").slice(0, 10);
    if (rDist) rDist.value = race.distancia_km || 10;
  }

  const calEl = document.getElementById("training-weekly-calendar");
  if (!calEl || !Array.isArray(plan.dias)) return;

  calEl.innerHTML = plan.dias.map((d, idx) => {
    const isRest = d.tipo === "Descanso";
    const isFuerza = d.tipo === "Fuerza";
    const isBici = d.tipo === "Ciclismo";
    const badgeCls = isFuerza ? "orange" : isBici ? "cyan" : "";
    const isCancelled = !!d.cancelado;
    const hasActions = !isRest;
    const distInfo = d.distancia_km > 0 ? `${d.distancia_km} km` : (d.duracion_min > 0 ? `${d.duracion_min} min` : "Descanso");
    const matchedLabel = Array.isArray(d.garmin_actividades) && d.garmin_actividades.length > 0
      ? `✓ Garmin (${d.garmin_actividades[0]})`
      : "✓ Garmin";

    return `
      <div class="training-day-card ${d.es_hoy && !isCancelled ? "is-today" : ""}" style="${isCancelled ? "opacity:0.65; background:#F4F4F6;" : ""}">
        <div class="training-day-info">
          <div class="training-day-head">
            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
              <strong style="font-size:0.92rem; color:${d.es_hoy && !isCancelled ? "var(--primary-text)" : "var(--on-surface)"};">${d.dia}${d.es_hoy ? " • HOY" : ""}</strong>
              <span class="body-xs tabular-num">${d.fecha}</span>
              <span class="pill-tag ${badgeCls}">${d.tipo}</span>
              ${d.opcional ? `<span class="pill-tag">OPCIONAL</span>` : ""}
              ${isCancelled ? `<span class="pill-tag" style="background:#FEE2E2; color:#B91C1C;">CANCELADO</span>` : ""}
            </div>
            ${d.completado
              ? `<span class="pill-tag" style="background:rgba(21,128,61,0.12); color:#15803D;">${matchedLabel}</span>`
              : `<span class="body-xs tabular-num">${distInfo}${d.zona_objetivo ? ` • ${d.zona_objetivo}` : ""}</span>`}
          </div>
          <div style="font-weight:800; font-size:0.96rem; color:var(--on-surface); margin-top:4px; ${isCancelled ? "text-decoration:line-through;" : ""}">${d.titulo}</div>
          <div class="body-xs" style="margin-top:2px;">${d.detalle}</div>
        </div>
        ${hasActions ? `
          <div class="training-day-actions">
            ${isCancelled ? `
              <button type="button" class="btn btn-ghost" style="padding:8px 12px; font-size:0.8rem;" onclick="toggleCancelPlannedDay('${d.fecha}', false)">Reactivar</button>
            ` : `
              <button type="button" class="btn btn-primary" style="padding:8px 12px; font-size:0.8rem;" onclick="startPlannedWorkout(${idx})">Ver / Iniciar</button>
              <button type="button" class="btn btn-ghost" style="padding:8px 12px; font-size:0.8rem;" onclick="sendPlannedDayToGarmin(${idx})">⌚ Enviar a Garmin</button>
              ${!d.completado ? `<button type="button" class="btn btn-ghost" style="padding:8px 10px; font-size:0.78rem; color:#B91C1C;" onclick="toggleCancelPlannedDay('${d.fecha}', true)">Cancelar</button>` : ""}
            `}
          </div>
        ` : ""}
      </div>
    `;
  }).join("");
}

function selectTrainingPlanType(planType, btnEl) {
  document.querySelectorAll(".training-plan-pill").forEach(b => b.classList.remove("active"));
  if (btnEl) btnEl.classList.add("active");
  saveTrainingGoals(planType);
}

async function saveTrainingGoals(overridePlanType = null) {
  const activePill = document.querySelector(".training-plan-pill.active");
  const planType = overridePlanType || (activePill ? activePill.getAttribute("data-plan") : "mantenimiento");
  const goalRun = parseFloat(document.getElementById("input-goal-run-km")?.value || "20");
  const goalBike = parseFloat(document.getElementById("input-goal-bike-km")?.value || "35");
  const goalStrength = parseInt(document.getElementById("input-goal-strength-ses")?.value || "2", 10);

  try {
    const res = await fetch("/api/training/goals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plan_type: planType,
        goal_run_km: goalRun,
        goal_bike_km: goalBike,
        goal_strength_sessions: goalStrength
      })
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.plan) renderWeeklyPlan(data.plan);
    showSuccessBanner("Objetivos y plan semanal guardados.");
  } catch (e) {}
}

async function saveTrainingRaceGoal() {
  const name = document.getElementById("training-race-name")?.value.trim();
  const dateVal = document.getElementById("training-race-date")?.value;
  const distVal = parseFloat(document.getElementById("training-race-dist")?.value || "10");
  if (!name || !dateVal) {
    showSuccessBanner("Introduce nombre y fecha de la carrera objetivo.");
    return;
  }
  try {
    const res = await fetch("/api/carrera-objetivo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nombre: name, fecha: dateVal, distancia_km: distVal, activo: true })
    });
    const data = await res.json();
    if (data.plan) renderWeeklyPlan(data.plan);
    showSuccessBanner(`Plan adaptado a ${name}.`);
  } catch (e) {}
}

function startPlannedWorkout(dayIdx) {
  if (!_latestWeeklyPlan || !_latestWeeklyPlan.dias || !_latestWeeklyPlan.dias[dayIdx]) return;
  const d = _latestWeeklyPlan.dias[dayIdx];
  const w = _buildWorkoutFromPlannedDay(d);
  state.currentWorkout = w;
  switchTab("tab-dashboard");
  renderWorkout(w);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function toggleCancelPlannedDay(fecha, cancel = true) {
  try {
    const res = await fetch("/api/training/cancel-day", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fecha, cancel })
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.plan) renderWeeklyPlan(data.plan);
    showSuccessBanner(cancel ? "Entrenamiento cancelado en el plan semanal." : "Entrenamiento reactivado.");
  } catch (e) {}
}

async function sendPlannedDayToGarmin(dayIdx) {
  if (!_latestWeeklyPlan || !_latestWeeklyPlan.dias || !_latestWeeklyPlan.dias[dayIdx]) return;
  const d = _latestWeeklyPlan.dias[dayIdx];
  const workout = _buildWorkoutFromPlannedDay(d);
  showSuccessBanner(`⌚ Enviando "${d.titulo}" a Garmin Connect...`);
  try {
    const sendRes = await fetch("/api/garmin/send-workout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(workout)
    });
    if (sendRes.ok) {
      const sendData = await sendRes.json();
      if (sendData.status === "sent") {
        showSuccessBanner(`⌚ ${sendData.message || `Sesión "${d.titulo}" enviada a tu reloj Garmin.`}`);
        return;
      }
    }
    // Fallback to native .FIT download if OAuth watch-push is not active yet
    const fitRes = await fetch("/api/garmin/export-fit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(workout)
    });
    if (fitRes.ok) {
      const blob = await fitRes.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `aaronfit_${(d.tipo || "sesion").toLowerCase()}_${d.fecha || "hoy"}.fit`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showSuccessBanner(`Archivo .FIT generado para "${d.titulo}". Activa tu login Garmin en Perfil para envío directo sin cables.`);
    }
  } catch (e) {
    showSuccessBanner("No se pudo exportar la sesión a Garmin.");
  }
}

const ROUTE_TO_TAB = {
  "/": "tab-dashboard",
  "/inicio": "tab-dashboard",
  "/entrenamiento": "tab-metrics",
  "/entrenamientos": "tab-training",
  "/plan": "tab-training",
  "/perfil": "tab-profile"
};

const TAB_TO_ROUTE = {
  "tab-dashboard": "/inicio",
  "tab-metrics": "/entrenamiento",
  "tab-training": "/plan",
  "tab-profile": "/perfil"
};

let _lastTabId = "tab-dashboard";

function navigateTo(event, path, tabId) {
  if (event && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    if (window.location.pathname !== path) {
      history.pushState({ tabId }, "", path);
    }
    switchTab(tabId, false);
  }
}

function syncRouteFromLocation() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  const actMatch = path.match(/^\/actividad\/([^/]+)$/);
  if (actMatch) {
    switchTab(_lastTabId, false);
    openActivityDetail(actMatch[1], false);
    return;
  }
  closeActivityDetailModal(false);
  const tabId = ROUTE_TO_TAB[path] || "tab-dashboard";
  switchTab(tabId, false);
}

function switchTab(tabId, updateUrl = true) {
  _lastTabId = tabId;
  const tabs = document.querySelectorAll(".tab-view");
  tabs.forEach(t => t.classList.remove("active"));

  const navBtns = document.querySelectorAll(".nav-tab-btn");
  navBtns.forEach(b => b.classList.remove("active"));

  const targetTab = document.getElementById(tabId);
  if (targetTab) targetTab.classList.add("active");

  const activeBtns = document.querySelectorAll(`.nav-tab-btn[data-target="${tabId}"]`);
  activeBtns.forEach(b => b.classList.add("active"));

  if (updateUrl && TAB_TO_ROUTE[tabId] && window.location.pathname !== TAB_TO_ROUTE[tabId]) {
    history.pushState({ tabId }, "", TAB_TO_ROUTE[tabId]);
  }

  if (window.lucide) lucide.createIcons();

  if (tabId === "tab-metrics") {
    fetch("/historial-actividades")
      .then(res => res.json())
      .then(data => {
        if (data.status === "ok" && data.historial) {
          state.history = data.historial;
          renderMetricsTab(data.historial, state.lastCoachText || "");
        }
      })
      .catch(e => console.error("Error fetching real history on tab switch:", e));
  }
}


function getMondayOfCurrentWeek() {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now.setDate(diff));
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function renderMetricsTab(history, coachText) {
  const elMetricsHistoryList = document.getElementById("metrics-history-list");
  const elMetricFuerzaCount = document.getElementById("metric-fuerza-count");
  const elMetricFuerzaBar = document.getElementById("metric-fuerza-bar");
  const elMetricCarreraCount = document.getElementById("metric-carrera-count");
  const elMetricCarreraBar = document.getElementById("metric-carrera-bar");
  const elMetricsCoachText = document.getElementById("metrics-coach-text");
  
  if (elMetricsCoachText && coachText) {
    elMetricsCoachText.textContent = coachText;
  }
  
  let fuerzaCount = 0;
  let carreraCount = 0;
  
  if (history && history.length > 0) {
    const monday = getMondayOfCurrentWeek();
    
    history.forEach(act => {
      let actDate = null;
      if (act.fecha === "Hoy") {
        actDate = new Date();
      } else if (act.fecha === "Ayer") {
        actDate = new Date();
        actDate.setDate(actDate.getDate() - 1);
      } else if (act.fecha) {
        actDate = new Date(act.fecha);
      }
      
      if (actDate && actDate >= monday) {
        if (act.tipo === "Fuerza") fuerzaCount++;
        if (act.tipo === "Carrera") carreraCount++;
      }
    });
  }
  
  const targetFuerza = 2;  // 1-2 opcionales por semana
  const targetCarrera = 3; // Base semanal Garmin

  if (elMetricFuerzaCount) elMetricFuerzaCount.innerHTML = `${fuerzaCount}<small> / ${targetFuerza} opc</small>`;
  if (elMetricFuerzaBar) elMetricFuerzaBar.style.width = `${Math.min(100, Math.round((fuerzaCount / targetFuerza) * 100))}%`;
  if (elMetricCarreraCount) elMetricCarreraCount.innerHTML = `${carreraCount}<small> / ${targetCarrera} ses</small>`;
  if (elMetricCarreraBar) elMetricCarreraBar.style.width = `${Math.min(100, Math.round((carreraCount / targetCarrera) * 100))}%`;

  // Compute 14-day Garmin Run & Bike distance totals
  const runKmEl = document.getElementById("metric-garmin-run-km");
  const bikeKmEl = document.getElementById("metric-garmin-bike-km");
  const hrvEl = document.getElementById("metric-garmin-hrv");
  if (history && history.length > 0) {
    const cutoff14d = new Date();
    cutoff14d.setDate(cutoff14d.getDate() - 14);
    let runKm14 = 0;
    let bikeKm14 = 0;
    history.forEach(act => {
      const dt = act.fecha ? new Date(act.fecha) : null;
      if (dt && dt >= cutoff14d && act.distancia_km) {
        if (act.tipo === "Carrera") runKm14 += Number(act.distancia_km);
        if (act.tipo === "Ciclismo") bikeKm14 += Number(act.distancia_km);
      }
    });
    if (runKmEl) runKmEl.textContent = `${runKm14.toFixed(1)} km`;
    if (bikeKmEl) bikeKmEl.textContent = `${bikeKm14.toFixed(1)} km`;
  }

  // Fetch Garmin wellness (HRV / Body Battery) silently
  if (hrvEl) {
    fetch("/api/garmin/sync")
      .then(r => r.ok ? r.json() : null)
      .then(g => {
        if (!g || !g.wellness) return;
        const hrv = g.wellness.hrv_ultima_noche;
        const bb = g.wellness.body_battery_actual ?? g.wellness.body_battery_charged;
        if (hrv && bb) hrvEl.textContent = `${hrv} / ${bb}%`;
        else if (hrv) hrvEl.textContent = `${hrv} ms`;
        else if (bb) hrvEl.textContent = `${bb}%`;
        else hrvEl.textContent = "Sync OK";
      })
      .catch(() => {});
  }

  if (elMetricsHistoryList) {
    if (!history || history.length === 0) {
      elMetricsHistoryList.innerHTML = `<p class="body-sm-muted" style="text-align:center; padding: 20px 0;">No hay actividades sincronizadas en Garmin Connect todavía.</p>`;
      return;
    }

    let html = "";
    history.forEach(act => {
      const isFuerza = act.tipo === "Fuerza";
      const borderClass = isFuerza ? "fuerza" : "carrera";
      const tagClass = isFuerza ? "lime" : "cyan";
      
      let statsPills = `<span class="stat-chip">⏱️ ${Math.round(act.duracion_minutos)} min</span>`;
      if (act.distancia_km) statsPills += `<span class="stat-chip">📏 ${act.distancia_km} km</span>`;
      if (act.ritmo_medio) statsPills += `<span class="stat-chip">⚡ ${act.ritmo_medio}</span>`;
      if (act.frecuencia_cardiaca_media) statsPills += `<span class="stat-chip">❤️ ${Math.round(act.frecuencia_cardiaca_media)} ppm</span>`;
      if (act.efecto_aerobico) statsPills += `<span class="stat-chip">🫁 TE ${Number(act.efecto_aerobico).toFixed(1)}</span>`;
      if (act.calorias_activas) statsPills += `<span class="stat-chip">🔥 ${Math.round(act.calorias_activas)} kcal</span>`;
      
      html += `
        <div class="history-card-item ${borderClass}">
          <div class="history-card-header">
            <span class="label-caps">${act.fecha}</span>
            <span class="pill-tag ${tagClass}">${act.tipo}</span>
          </div>
          <div class="history-title-row">
            <span class="headline-sm">${act.nombre || 'Sesión de ' + act.tipo}</span>
          </div>
          <div class="history-stat-chips">
            ${statsPills}
          </div>
        </div>
      `;
    });
    elMetricsHistoryList.innerHTML = html;
  }
}

// Profile Workout Rules & Preference Selectors
state.prefFuerzaDays = 3;
state.prefCarreraDays = 2;

function updateEquipChip(checkboxEl) {
  if (!checkboxEl) return;
  const chipLabel = checkboxEl.closest(".equip-chip");
  if (chipLabel) {
    if (checkboxEl.checked) {
      chipLabel.classList.add("active");
    } else {
      chipLabel.classList.remove("active");
    }
  }
}

function cargarPreferenciasGuardadas() {
  const savedStr = localStorage.getItem("user_workout_preferences");
  if (!savedStr) return;
  try {
    const prefs = JSON.parse(savedStr);
    if (prefs.fuerzaDays) setFuerzaPreference(parseInt(prefs.fuerzaDays));
    if (prefs.carreraDays) setCarreraPreference(parseInt(prefs.carreraDays));
    
    if (prefs.maxCalidad !== undefined) {
      const elMax = document.getElementById("pref-max-calidad");
      if (elMax) elMax.checked = !!prefs.maxCalidad;
    }
    
    if (prefs.equipment) {
      const elMan = document.getElementById("equip-mancuernas");
      const elCin = document.getElementById("equip-cintas");
      const elWat = document.getElementById("equip-watch");
      
      if (elMan) { elMan.checked = !!prefs.equipment.mancuernas5kg; updateEquipChip(elMan); }
      if (elCin) { elCin.checked = !!prefs.equipment.cintas; updateEquipChip(elCin); }
      if (elWat) { elWat.checked = !!prefs.equipment.appleWatch; updateEquipChip(elWat); }
    }
  } catch (e) {
    console.error("Error loading saved workout preferences:", e);
  }
}

function setFuerzaPreference(days) {
  state.prefFuerzaDays = days;
  const btns = document.querySelectorAll(".pref-fuerza-btn");
  btns.forEach(b => {
    if (parseInt(b.getAttribute("data-val")) === days) {
      b.classList.add("active");
    } else {
      b.classList.remove("active");
    }
  });
}

function setCarreraPreference(days) {
  state.prefCarreraDays = days;
  const btns = document.querySelectorAll(".pref-carrera-btn");
  btns.forEach(b => {
    if (parseInt(b.getAttribute("data-val")) === days) {
      b.classList.add("active");
    } else {
      b.classList.remove("active");
    }
  });
}

function guardarPreferenciasEntrenamiento() {
  const maxCalidad = document.getElementById("pref-max-calidad")?.checked ?? true;
  const hasMancuernas = document.getElementById("equip-mancuernas")?.checked ?? true;
  const hasCintas = document.getElementById("equip-cintas")?.checked ?? true;
  const hasWatch = document.getElementById("equip-watch")?.checked ?? true;

  const userPrefs = {
    fuerzaDays: state.prefFuerzaDays,
    carreraDays: state.prefCarreraDays,
    maxCalidad: maxCalidad,
    equipment: {
      mancuernas5kg: hasMancuernas,
      cintas: hasCintas,
      appleWatch: hasWatch
    }
  };

  localStorage.setItem("user_workout_preferences", JSON.stringify(userPrefs));
  
  // Clear cached recommendation so dashboard re-evaluates immediately with new preferences
  localStorage.removeItem("cached_recommendation");
  localStorage.removeItem("cached_recommendation_date");

  // Re-render metrics tab with new target goals
  if (state.history) {
    renderMetricsTab(state.history, state.lastCoachText || "");
  }

  // Refresh recommendation on dashboard
  fetchRecommendation();

  showSuccessBanner("✨ Reglas y preferencias de entrenamiento guardadas.");
}

// Assisted Strength Workout Video Demonstration Engine
const EXERCISE_MEDIA_MAP = [
  {
    keywords: ["zancada", "lunge"],
    gif: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Dumbbell_Lunges/0.jpg",
    animClass: "anim-lunge",
    muscle: "CUÁDRICEPS Y GLÚTEOS",
    tempo: "3s Bajada • 1s Pausa • 1s Empuje",
    cues: "Mantén el torso erguido. La rodilla trasera desciende rozando el suelo."
  },
  {
    keywords: ["sentadilla", "squat", "goblet"],
    gif: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Goblet_Squat/0.jpg",
    animClass: "anim-squat",
    muscle: "TREN INFERIOR • GLÚTEOS",
    tempo: "3s Bajar • 1s Pausa • 1s Subir",
    cues: "Peso en talones, rodillas alineadas con las puntas de los pies."
  },
  {
    keywords: ["peso muerto", "deadlift", "puente", "hip thrust"],
    gif: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Barbell_Glute_Bridge/0.jpg",
    animClass: "anim-squat",
    muscle: "CADENA POSTERIOR • GLÚTEO",
    tempo: "3s Bajar • 1s Apretar Glúteo",
    cues: "Empuja la cadera atrás manteniendo la columna totalmente neutra."
  },
  {
    keywords: ["press", "hombro", "militar", "elevaciones"],
    gif: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Dumbbell_Shoulder_Press/0.jpg",
    animClass: "anim-press",
    muscle: "EMPUJE • DELTOIDES Y TRÍCEPS",
    tempo: "1s Empujar • 3s Controlar Bajada",
    cues: "Abdomen tenso, empuja vertical sin arquear la zona lumbar."
  },
  {
    keywords: ["remo", "row", "pull"],
    gif: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Bent_Over_Two-Dumbbell_Row/0.jpg",
    animClass: "anim-row",
    muscle: "TRACCIÓN • DORSAL Y ESCÁPULAS",
    tempo: "1s Tirar • 1s Apretar Escápulas",
    cues: "Tracciona el codo hacia la cadera apretando las escápulas atrás."
  },
  {
    keywords: ["plancha", "plank", "core", "bicho", "escaladores"],
    gif: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Plank/0.jpg",
    animClass: "anim-plank",
    muscle: "CORE • ESTABILIZACIÓN ABDOMINAL",
    tempo: "Tensión Isométrica Constante",
    cues: "Alinea cabeza, pelvis y tobillos. Aprieta fuertemente abdomen y glúteos."
  }
];

function updateGuidedVideo(exerciseName, exerciseDesc) {
  const videoCard = document.getElementById("guided-video-card");
  const canvasEl = document.getElementById("guided-biomechanics-canvas");
  const imgEl = document.getElementById("guided-exercise-img");
  const muscleEl = document.getElementById("guided-muscle-name");
  const tempoEl = document.getElementById("guided-tempo-text");
  const descEl = document.getElementById("guided-exercise-desc");
  
  if (!videoCard) return;

  videoCard.style.display = "flex";

  const wrapperEl = document.querySelector(".guided-video-wrapper");

  if (state.currentWorkout && state.currentWorkout.tipo_sesion === "Yoga") {
    if (wrapperEl) wrapperEl.style.background = "#f9f9fb";
    if (muscleEl) muscleEl.textContent = "YOGA • FLEXIBILIDAD Y CONEXIÓN";
    if (tempoEl) tempoEl.textContent = "Respiración Controlada (Pranayama)";
    if (descEl) descEl.textContent = exerciseDesc || "Mantén la postura respirando con calma.";

    const currentEx = state.currentWorkout.ejercicios[guided.exIndex];
    if (currentEx && currentEx.gif_url) {
      if (imgEl) {
        imgEl.src = currentEx.gif_url;
        imgEl.style.objectFit = "contain";
        imgEl.style.padding = "12px";
        imgEl.style.display = "block";
      }
      if (canvasEl) {
        canvasEl.style.display = "none";
      }
      return;
    }
  } else {
    if (wrapperEl) wrapperEl.style.background = "#000000";
    if (imgEl) {
      imgEl.style.objectFit = "cover";
      imgEl.style.padding = "0";
    }
  }


  const nameLower = (exerciseName || "").toLowerCase();

  let match = EXERCISE_MEDIA_MAP.find(item => item.keywords.some(k => nameLower.includes(k)));

  if (!match) {
    match = {
      gif: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Goblet_Squat/0.jpg",
      animClass: "anim-squat",
      muscle: "FULL-BODY • RESISTENCIA",
      tempo: "3s Bajada • 1s Pausa • 1s Empuje",
      cues: exerciseDesc || "Mantén la postura erguida y tensión constante con tus pesas o cintas."
    };
  }

  if (tempoEl) tempoEl.textContent = match.tempo;
  if (descEl) descEl.textContent = exerciseDesc || match.cues;
  if (muscleEl) muscleEl.textContent = match.muscle;

  if (canvasEl) {
    canvasEl.style.display = "flex";
    canvasEl.className = `biomechanics-canvas ${match.animClass}`;
  }

  if (match.gif && imgEl) {
    imgEl.src = match.gif;
    imgEl.style.display = "block";
    imgEl.onload = () => { imgEl.style.display = "block"; };
    imgEl.onerror = () => { imgEl.style.display = "none"; };
  } else if (imgEl) {
    imgEl.style.display = "none";
  }
}

function openExerciseVideoModal(arg1, arg2, arg3) {
  let name = "";
  let desc = "";
  let exData = null;

  if (typeof arg1 === "number") {
    const list = window.currentRoutineExercises || (state.currentWorkout ? state.currentWorkout.ejercicios : null);
    if (list && list[arg1]) {
      exData = list[arg1];
    }
  } else if (typeof arg1 === "object" && arg1 !== null) {
    exData = arg1;
  } else if (typeof arg1 === "string") {
    name = decodeURIComponent(arg1 || '');
    desc = decodeURIComponent(arg2 || '');
    try {
      if (arg3) exData = JSON.parse(decodeURIComponent(arg3));
    } catch (e) {
      console.error("Error parsing exercise details:", e);
    }
  }

  if (exData) {
    name = exData.nombre || exData.name || name;
    desc = exData.descripcion || desc;
  }

  const modal = document.getElementById("exercise-video-modal");
  const titleEl = document.getElementById("modal-video-title");
  const canvasEl = document.getElementById("modal-biomechanics-canvas");
  const imgEl = document.getElementById("modal-exercise-img");
  const videoEl = document.getElementById("modal-exercise-video");
  const muscleEl = document.getElementById("modal-muscle-name");
  const tempoEl = document.getElementById("modal-video-tempo");
  const cuesEl = document.getElementById("modal-video-cues");

  if (!modal) return;

  if (titleEl) titleEl.textContent = name;

  const nameLower = (name || "").toLowerCase();
  let match = EXERCISE_MEDIA_MAP.find(item => item.keywords.some(k => nameLower.includes(k)));

  const gifUrl = exData?.gif_url || (match ? match.gif : "");
  const videoUrl = exData?.video_url || null;
  const targetMuscle = exData?.target_muscle || (match ? match.muscle : "TREN INFERIOR Y SUPERIOR");
  const instructions = exData?.instructions;
  const tips = exData?.tips || desc || (match ? match.cues : "");

  const isYogaSession = state.currentWorkout && state.currentWorkout.tipo_sesion === "Yoga";

  if (isYogaSession) {
    if (muscleEl) muscleEl.textContent = `🧘‍♀️ TIPO: YOGA / FLEXIBILIDAD`;
    if (tempoEl) tempoEl.textContent = "Respiración Controlada Consciente";
    if (canvasEl) canvasEl.style.display = "none";
  } else {
    if (muscleEl) muscleEl.textContent = `🎯 MÚSCULO: ${targetMuscle.toUpperCase()}`;
    if (tempoEl) tempoEl.textContent = match ? match.tempo : "3s Bajada • 1s Pausa • 1s Empuje";
    if (canvasEl) {
      canvasEl.style.display = "flex";
      canvasEl.className = `biomechanics-canvas ${match ? match.animClass : 'anim-squat'}`;
    }
  }

  // ── Media priority: real video > image > SVG canvas ──────────────────────
  function _showVideo(url) {
    if (!videoEl) return;
    videoEl.src = url;
    videoEl.style.display = "block";
    if (imgEl) imgEl.style.display = "none";
    if (canvasEl) canvasEl.style.display = "none";
    videoEl.load();
    videoEl.play().catch(() => {});
  }

  function _showImage(url) {
    if (!imgEl) return;
    _stopStravaFrameAnim();

    const frame0 = url;
    const frame1 = url.includes("/0.jpg") ? url.replace("/0.jpg", "/1.jpg") : null;
    let showingFrame1 = false;

    imgEl.src = frame0;
    imgEl.style.display = "block";
    imgEl.style.opacity = "1";
    imgEl.style.transition = "opacity 0.25s ease-in-out";
    if (videoEl) videoEl.style.display = "none";
    if (canvasEl) canvasEl.style.display = "none";
    imgEl.style.background = "#F7F7FA";
    imgEl.style.padding = "0";
    imgEl.style.objectFit = "contain";

    // Animate 2-frame Strava-style start <-> contraction sequence
    if (frame1) {
      const preload = new Image();
      preload.src = frame1;
      _stravaFrameInterval = setInterval(() => {
        if (!imgEl || imgEl.style.display === "none") return;
        showingFrame1 = !showingFrame1;
        imgEl.style.opacity = "0.82";
        setTimeout(() => {
          imgEl.src = showingFrame1 ? frame1 : frame0;
          imgEl.style.opacity = "1";
          if (tempoEl) {
            tempoEl.textContent = showingFrame1
              ? "🔥 CONTRACCIÓN MÁXIMA • 1s Pausa"
              : "⚡ FASE EXCÉNTRICA • 3s Controlado";
          }
        }, 120);
      }, 1250);
    }

    imgEl.onerror = () => {
      _stopStravaFrameAnim();
      imgEl.style.display = "none";
      if (canvasEl) canvasEl.style.display = "flex";
    };
  }

  // Reset media elements & ALWAYS start Articulated Strava/Runna Athlete Rig
  _stopStravaFrameAnim();
  _guidedPhotoUrl = gifUrl || "";
  _guidedShowPhoto = false;
  const animClass = match ? match.animClass : "anim-squat";
  const toggleBtn = document.getElementById("btn-toggle-ex-photo");
  if (toggleBtn) toggleBtn.style.display = _guidedPhotoUrl ? "inline-block" : "none";
  if (toggleBtn) toggleBtn.textContent = "📷 Ver Foto";

  if (videoEl) { videoEl.pause(); videoEl.src = ""; videoEl.style.display = "none"; }
  if (imgEl)   imgEl.style.display = "none";

  if (canvasEl) {
    canvasEl.dataset.anim = animClass;
    canvasEl.style.display = "flex";
    startStravaMotionRig(animClass);
  }

  // ── Instructions and tips ─────────────────────────────────────────────────
  function _renderCues(instructions, tips) {
    if (instructions && instructions.length > 0) {
      let stepsHtml = `<span class="label-caps" style="color: var(--secondary); display: block; margin-bottom: 6px;">TÉCNICA PASO A PASO:</span><ol class="exercise-instructions-list">`;
      instructions.forEach(step => { stepsHtml += `<li>${step}</li>`; });
      stepsHtml += `</ol>`;
      if (tips) {
        stepsHtml += `<div style="margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border-glass);"><span class="label-caps" style="color: var(--primary); display: block; margin-bottom: 2px;">CONSEJO DE TÉCNICA:</span><p class="body-sm" style="margin: 0; color: var(--on-surface); line-height:1.4;">${tips}</p></div>`;
      }
      if (cuesEl) cuesEl.innerHTML = stepsHtml;
    } else {
      if (cuesEl) cuesEl.textContent = tips || "Mantén la postura erguida y tensión constante con tus pesas de 5kg o cintas.";
    }
  }

  _renderCues(instructions, tips);

  // ── Lazy-fetch full detail if exercise_id available and not yet enriched ──
  const exerciseId = exData?.exercise_id;
  if (exerciseId && (!videoUrl || !instructions || instructions.length === 0)) {
    const cacheKey = `edb_detail_${exerciseId}`;
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      try {
        const detail = JSON.parse(cached);
        if (!videoUrl && detail.videoUrl) _showVideo(detail.videoUrl);
        if ((!instructions || instructions.length === 0) && detail.instructions) {
          const tips2 = (detail.exerciseTips || [])[0] || tips;
          _renderCues(detail.instructions, tips2);
        }
      } catch(e) {}
    } else {
      fetch(`/ejercicio-detalle/${exerciseId}`)
        .then(r => r.json())
        .then(res => {
          if (res.status === "ok" && res.data) {
            const detail = res.data;
            localStorage.setItem(cacheKey, JSON.stringify(detail));
            // Only update if modal still open for this exercise
            if (document.getElementById("modal-video-title")?.textContent === name) {
              if (!videoUrl && detail.videoUrl) _showVideo(detail.videoUrl);
              if ((!instructions || instructions.length === 0) && detail.instructions) {
                const tips2 = (detail.exerciseTips || [])[0] || tips;
                _renderCues(detail.instructions, tips2);
              }
            }
          }
        })
        .catch(e => console.warn("[EDB] lazy detail fetch failed:", e));
    }
  }

  modal.style.display = "flex";
  if (window.lucide) lucide.createIcons();
}


function closeExerciseVideoModal() {
  const modal = document.getElementById("exercise-video-modal");
  if (modal) modal.style.display = "none";
  const videoEl = document.getElementById("modal-exercise-video");
  if (videoEl) { videoEl.pause(); videoEl.src = ""; }
}

// ============================================================
// GARMIN CONNECT DIRECT SYNC UI
// ============================================================
async function checkGarminStatus() {
  try {
    const res = await fetch("/api/garmin/status");
    if (!res.ok) return;
    const data = await res.json();
    updateGarminUI(data.connected, data.profile, data.write_connected);
  } catch (e) {
    console.warn("Garmin status check failed:", e);
  }
}

function updateGarminUI(connected, profile, writeConnected = false) {
  const badge = document.getElementById("garmin-status-badge");
  const loginForm = document.getElementById("garmin-login-form");
  const connectedPanel = document.getElementById("garmin-connected-panel");
  const summaryText = document.getElementById("garmin-summary-text");
  const writeStatus = document.getElementById("garmin-write-status");

  if (!badge || !loginForm || !connectedPanel) return;

  if (connected) {
    badge.textContent = writeConnected ? "Lectura + Reloj OK" : "Lectura Activa";
    badge.style.background = "rgba(0, 174, 239, 0.18)";
    badge.style.color = "#00AEEF";
    connectedPanel.style.display = "flex";
    loginForm.style.display = writeConnected ? "none" : "flex";
    if (writeStatus) {
      writeStatus.textContent = writeConnected
        ? "✅ ENVÍO AUTOMÁTICO AL RELOJ ACTIVO"
        : "ENVÍO AUTOMÁTICO AL RELOJ: INICIA SESIÓN CON TU CUENTA GARMIN";
    }
    if (profile && profile.nombre && summaryText) {
      const vo2 = profile.vo2max_carrera ? ` • VO2 Máx: ${profile.vo2max_carrera}` : "";
      const peso = profile.peso_kg ? ` • Peso Garmin: ${profile.peso_kg} kg` : "";
      summaryText.textContent = `Vinculado como ${profile.nombre}${peso}${vo2}. Tus entrenamientos y métricas se analizan automáticamente.`;
    }
  } else {
    badge.textContent = "Desconectado";
    badge.style.background = "rgba(255, 255, 255, 0.08)";
    badge.style.color = "var(--text-secondary)";
    loginForm.style.display = "flex";
    connectedPanel.style.display = "none";
  }
}

async function saveGarminPersonalKey() {
  const keyEl = document.getElementById("garmin-apikey-input");
  const key = keyEl ? keyEl.value.trim() : "";
  if (!key || !key.startsWith("GCDC_")) {
    showSuccessBanner("⚠️ Introduce una clave válida que empiece por GCDC_");
    return;
  }
  showLoading(true, "Validando clave de Garmin Connect...");
  try {
    const res = await fetch("/api/garmin/set-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: key })
    });
    const data = await res.json();
    if (data.status === "connected") {
      showSuccessBanner("✅ ¡Garmin Connect conectado!");
      await checkGarminStatus();
      await initApp();
      await loadWeeklyPlanAndRaceGoal();
    } else {
      showSuccessBanner(`⚠️ ${data.message || "Error validando clave."}`);
    }
  } catch (e) {
    showSuccessBanner("⚠️ Error de red conectando Garmin.");
  } finally {
    showLoading(false);
  }
}

async function connectGarminAccount() {
  const emailEl = document.getElementById("garmin-email-input");
  const passEl = document.getElementById("garmin-password-input");
  const btn = document.getElementById("btn-garmin-login");
  const mfaBox = document.getElementById("garmin-mfa-box");
  if (!emailEl || !passEl) return;

  const email = emailEl.value.trim();
  const password = passEl.value;
  if (!email || !password) {
    showSuccessBanner("⚠️ Introduce tu email y contraseña de Garmin Connect.");
    return;
  }

  if (btn) btn.textContent = "Conectando...";
  try {
    const res = await fetch("/api/garmin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (data.status === "needs_mfa") {
      if (mfaBox) mfaBox.style.display = "flex";
      showSuccessBanner("🔐 Garmin requiere código 2FA. Introdúcelo debajo.");
    } else if (data.status === "connected") {
      showSuccessBanner("✅ ¡Garmin Connect vinculado correctamente!");
      await checkGarminStatus();
      await initApp();
    } else {
      showSuccessBanner(`⚠️ ${data.message || "Error al conectar con Garmin."}`);
    }
  } catch (e) {
    showSuccessBanner("⚠️ Error de red conectando con Garmin.");
  } finally {
    if (btn) btn.textContent = "Conectar Garmin Connect";
  }
}

async function submitGarminMfa() {
  const mfaEl = document.getElementById("garmin-mfa-input");
  if (!mfaEl || !mfaEl.value.trim()) return;

  try {
    const res = await fetch("/api/garmin/mfa", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: mfaEl.value.trim() })
    });
    const data = await res.json();
    if (data.status === "connected") {
      showSuccessBanner("✅ ¡Garmin Connect verificado y vinculado!");
      await checkGarminStatus();
      await initApp();
    } else {
      showSuccessBanner(`⚠️ ${data.message || "Código 2FA inválido."}`);
    }
  } catch (e) {
    showSuccessBanner("⚠️ Error verificando el código 2FA.");
  }
}

async function syncGarminNow() {
  try {
    showSuccessBanner("🔄 Sincronizando actividades y telemetría de Garmin...");
    const res = await fetch("/api/garmin/sync");
    if (!res.ok) {
      showSuccessBanner("⚠️ No se pudo sincronizar con Garmin.");
      return;
    }
    const data = await res.json();
    showSuccessBanner(`✅ Sincronizadas ${data.activities_count} actividades de Garmin Connect.`);
    await initApp();
  } catch (e) {
    showSuccessBanner("⚠️ Error de conexión al sincronizar Garmin.");
  }
}

async function sendWorkoutToGarminWatch() {
  if (!state.currentWorkout) return;
  showLoading(true, "Enviando entrenamiento a Garmin Connect...");
  try {
    const res = await fetch("/api/garmin/send-workout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.currentWorkout)
    });
    const data = await res.json();
    if (data.status === "sent") {
      state.currentWorkout.enviado_al_reloj = true;
      showSuccessBanner(`⌚ ${data.message}`);
      renderWorkout(state.currentWorkout);
    } else {
      showSuccessBanner(`🔐 ${data.message}`);
      switchTab("tab-profile");
    }
  } catch (e) {
    showSuccessBanner("⚠️ Error enviando el entrenamiento a Garmin Connect.");
  } finally {
    showLoading(false);
  }
}

// ============================================================
// WEEKLY GARMIN PLANNER & TARGET RACE GOAL
// ============================================================
async function loadWeeklyPlanAndRaceGoal() {
  try {
    const res = await fetch("/api/plan-semanal");
    if (!res.ok) return;
    const plan = await res.json();
    renderWeeklyPlan(plan);
  } catch (e) {
    console.warn("Weekly plan load failed:", e);
  }
}

function renderWeeklyPlan(plan) {
  const m = plan.metrics || {};
  const trendEl = document.getElementById("dashboard-trend-val");
  const paceEl = document.getElementById("dashboard-pace-val");
  const kmBadge = document.getElementById("weekly-plan-km-badge");
  const listEl = document.getElementById("weekly-plan-list");
  const banner = document.getElementById("race-goal-banner");
  const titleEl = document.getElementById("race-goal-title");

  if (trendEl) trendEl.textContent = m.tendencia_label || "En Ascenso";
  if (paceEl) paceEl.textContent = m.ritmo_medio_garmin || "5:35 min/km";
  if (kmBadge) kmBadge.textContent = `${plan.objetivo_km_carrera || 0} km obj.`;

  const race = plan.carrera_objetivo;
  if (race && race.activo && banner) {
    banner.style.display = "block";
    if (titleEl) titleEl.textContent = `Objetivo: ${race.nombre}`;
    const bName = document.getElementById("race-banner-name");
    const bDays = document.getElementById("race-banner-days");
    const bPhase = document.getElementById("race-banner-phase");
    if (bName) bName.textContent = `🏁 ${race.nombre} (${race.distancia_km} km)`;
    if (bDays) {
      const d = m.dias_para_carrera;
      bDays.textContent = d !== null && d !== undefined ? (d >= 0 ? `Faltan ${d} días` : "Completada") : race.fecha;
    }
    if (bPhase) bPhase.textContent = `Fase actual: ${m.fase_actual}`;
  } else if (banner) {
    banner.style.display = "none";
    if (titleEl) titleEl.textContent = m.fase_actual || "Tendencia Ascendente";
  }

  if (listEl && Array.isArray(plan.dias)) {
    let html = "";
    plan.dias.forEach(d => {
      const isFuerza = d.tipo === "Fuerza";
      const isCarrera = d.tipo === "Carrera" || d.tipo === "Carrera Objetivo";
      const accent = isCarrera ? "#16A34A" : isFuerza ? "#FF5500" : "var(--text-muted)";
      const todayBorder = d.es_hoy ? `border: 1.5px solid ${accent}; background: #FFF7F3;` : "border: 1px solid var(--border-glass); background: var(--surface-dim);";
      const clickable = (isFuerza || isCarrera) ? `onclick="iniciarGeneracionEntrenamiento('${isFuerza ? 'Fuerza' : 'Carrera'}')" style="cursor:pointer; ${todayBorder} border-radius:14px; padding:10px 12px; display:flex; flex-direction:column; gap:4px;"` : `style="${todayBorder} border-radius:14px; padding:10px 12px; display:flex; flex-direction:column; gap:4px;"`;

      html += `
        <div ${clickable}>
          <div style="display:flex; justify-content:space-between; align-items:center; gap:6px;">
            <div style="display:flex; align-items:center; gap:6px;">
              <span class="label-caps" style="color:${accent}; font-size:0.72rem;">${d.dia}${d.es_hoy ? " • HOY" : ""}</span>
              ${d.opcional ? `<span class="label-caps" style="background:rgba(255,85,0,0.12); color:#C23B00; padding:2px 6px; border-radius:6px; font-size:0.62rem;">OPCIONAL</span>` : ""}
            </div>
            ${d.completado ? `<span class="label-caps" style="color:#0077CC; font-size:0.68rem;">✓ Garmin</span>` : (d.duracion_min > 0 ? `<span class="body-xs tabular-num" style="color:var(--text-muted);">${d.duracion_min} min</span>` : "")}
          </div>
          <div style="font-weight:700; font-size:0.9rem; color: var(--on-surface);">${d.titulo}</div>
          <div style="font-size:0.76rem; color:var(--text-secondary);">${d.detalle}</div>
        </div>
      `;
    });
    listEl.innerHTML = html;

    // 1. Render Stride Weekly Calendar Strip (L M X J V S D)
    const weekStripEl = document.getElementById("stride-week-strip");
    if (weekStripEl) {
      const dayLetters = ["L", "M", "X", "J", "V", "S", "D"];
      weekStripEl.innerHTML = plan.dias.map((d, idx) => {
        const letter = dayLetters[idx] || (d.dia || "").slice(0, 1).toUpperCase();
        const dayNum = (d.fecha || "").split("-")[2] ? parseInt(d.fecha.split("-")[2], 10) : (idx + 1);
        const cls = [
          "stride-day-col",
          d.es_hoy ? "is-today" : "",
          d.completado ? "is-done" : (d.tipo !== "Descanso" ? "is-planned" : "")
        ].filter(Boolean).join(" ");
        const actionAttr = d.tipo !== "Descanso" ? `onclick="startPlannedWorkout(${idx})"` : `onclick="switchTab('tab-training')"`;
        return `
          <button type="button" class="${cls}" ${actionAttr} aria-label="${d.dia} ${dayNum}: ${d.titulo}">
            <span class="stride-day-letter">${letter}</span>
            <span class="stride-day-num">${dayNum}</span>
            <span class="stride-day-dot"></span>
          </button>
        `;
      }).join("");
    }

    // 2. Enhance Stride Dark Hero Card with today's planned session if available
    const todayDay = plan.dias.find(d => d.es_hoy);
    if (todayDay) {
      const hTitle = document.getElementById("stride-hero-title");
      const hSub = document.getElementById("stride-hero-subtitle");
      const hBadge = document.getElementById("stride-hero-badge");
      const hPlay = document.getElementById("stride-hero-play-btn");
      const todayIdx = plan.dias.indexOf(todayDay);
      if (hTitle) hTitle.textContent = todayDay.titulo || hTitle.textContent;
      const metricsParts = [];
      if (todayDay.distancia_km > 0) metricsParts.push(`${todayDay.distancia_km} km`);
      if (todayDay.duracion_min > 0) metricsParts.push(`${todayDay.duracion_min} min`);
      if (todayDay.zona_objetivo) metricsParts.push(todayDay.zona_objetivo);
      if (hSub && metricsParts.length > 0) hSub.textContent = metricsParts.join(" · ");
      if (hBadge) hBadge.textContent = todayDay.completado ? "Hoy · Completado en Garmin" : `Hoy · ${todayDay.tipo}`;
      if (hPlay && todayIdx >= 0 && todayDay.tipo !== "Descanso") {
        hPlay.onclick = () => startPlannedWorkout(todayIdx);
      }
    }

    // 3. Render Stride "Up next" (Próximos entrenos)
    const upNextWrap = document.getElementById("stride-up-next-wrap");
    const upNextCard = document.getElementById("stride-up-next-card");
    if (upNextWrap && upNextCard) {
      const todayIdx = plan.dias.findIndex(d => d.es_hoy);
      const upcoming = plan.dias
        .map((d, idx) => ({ d, idx }))
        .filter(({ d, idx }) => idx > todayIdx && d.tipo !== "Descanso")
        .slice(0, 2);

      if (upcoming.length > 0) {
        upNextWrap.style.display = "flex";
        upNextCard.innerHTML = upcoming.map(({ d, idx }) => {
          const dayShort = (d.dia || "").slice(0, 3);
          const dayNum = (d.fecha || "").split("-")[2] ? parseInt(d.fecha.split("-")[2], 10) : "";
          const metaParts = [`${dayShort} ${dayNum}`.trim()];
          if (d.distancia_km > 0) metaParts.push(`${d.distancia_km} km`);
          else if (d.duracion_min > 0) metaParts.push(`${d.duracion_min} min`);
          if (d.zona_objetivo) metaParts.push(d.zona_objetivo);
          const strokeCol = d.tipo === "Fuerza" ? "#111113" : "#FF5500";
          const miniIcon = d.tipo === "Fuerza"
            ? `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${strokeCol}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6.5 6.5 11 11"/><path d="m21 21-1-1"/><path d="m3 3 1 1"/><path d="m18 22 4-4"/><path d="m2 6 4-4"/></svg>`
            : `<svg width="34" height="34" viewBox="0 0 40 40" fill="none"><path d="M8 14 L18 10 L30 15 L32 25 L22 30 L10 26 Z" stroke="${strokeCol}" stroke-width="2.2" stroke-linejoin="round" fill="none"/></svg>`;
          return `
            <button type="button" class="stride-up-next-item" onclick="startPlannedWorkout(${idx})">
              <div class="stride-mini-route">${miniIcon}</div>
              <div style="flex:1; min-width:0;">
                <div style="font-weight:700; font-size:0.95rem; color:var(--on-surface); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${d.titulo}</div>
                <div class="body-xs" style="margin-top:2px;">${metaParts.join(" · ")}</div>
              </div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8A8A94" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
          `;
        }).join("");
      } else {
        upNextWrap.style.display = "none";
      }
    }
  }
  renderTrainingTab(plan);
}

function toggleRaceGoalForm() {
  const form = document.getElementById("race-goal-form");
  if (!form) return;
  form.style.display = form.style.display === "none" ? "flex" : "none";
}

async function saveRaceGoal() {
  const name = document.getElementById("race-input-name")?.value.trim();
  const dateVal = document.getElementById("race-input-date")?.value;
  const distVal = parseFloat(document.getElementById("race-input-dist")?.value || "10");
  if (!name || !dateVal) {
    showSuccessBanner("⚠️ Introduce el nombre y la fecha de tu próxima carrera.");
    return;
  }
  try {
    const res = await fetch("/api/carrera-objetivo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nombre: name, fecha: dateVal, distancia_km: distVal, activo: true })
    });
    const data = await res.json();
    if (data.plan) renderWeeklyPlan(data.plan);
    toggleRaceGoalForm();
    showSuccessBanner(`🏁 Plan semanal adaptado para ${name}!`);
  } catch (e) {
    showSuccessBanner("⚠️ Error guardando carrera objetivo.");
  }
}

async function clearRaceGoal() {
  try {
    const res = await fetch("/api/carrera-objetivo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nombre: "", fecha: "", distancia_km: 10, activo: false })
    });
    const data = await res.json();
    if (data.plan) renderWeeklyPlan(data.plan);
    toggleRaceGoalForm();
    showSuccessBanner("📈 Plan en modo Tendencia Ascendente Continua.");
  } catch (e) {}
}

// ============================================================
// FASE 2 & 3: STRAVA ACTIVITY FEED, LEAFLET MAPS & SUMMIT ANALYTICS
// ============================================================
let _summitData = null;
let _detailMapInstance = null;

async function loadSummitAnalytics() {
  try {
    const res = await fetch("/api/analytics/summit");
    if (!res.ok) return;
    _summitData = await res.json();
    renderTrainingLogBubbles("Todo");
    renderFitnessFreshnessChart(_summitData.fitness_curve || []);
    renderPersonalRecords(_summitData.personal_records || []);
    renderOfficialRecords(_summitData.official_records || []);
    loadSegmentsList();
  } catch (e) {
    console.warn("Summit analytics load failed:", e);
  }
}

function renderOfficialRecords(records) {
  const grid = document.getElementById("summit-official-prs-grid");
  if (!grid) return;
  if (!records || records.length === 0) {
    grid.innerHTML = `<p class="body-sm-muted" style="grid-column:1/-1;">Añade tus marcas oficiales en carrera o competición.</p>`;
    return;
  }
  grid.innerHTML = records.map(pr => `
    <div class="p-stat-box" style="text-align:left; border-color:#FFD5BF; background:#FFF7F3;">
      <span class="label-caps" style="color: var(--primary-text); font-size:0.72rem;">RP • ${pr.label}</span>
      <span class="p-stat-val tabular-num" style="color: var(--on-surface); font-size:1.05rem;">${pr.best_value}</span>
      <span class="body-xs tabular-num" style="color:var(--text-muted);">${pr.achieved_date || ""}</span>
    </div>
  `).join("");
}

function toggleOfficialPrForm() {
  const f = document.getElementById("official-pr-form");
  if (f) f.style.display = f.style.display === "none" ? "flex" : "none";
}

async function saveOfficialPr() {
  const cat = document.getElementById("official-pr-category")?.value || "10K";
  const val = document.getElementById("official-pr-value")?.value.trim();
  const label = document.getElementById("official-pr-label")?.value.trim() || cat;
  const dt = document.getElementById("official-pr-date")?.value || "";
  if (!val) return;
  try {
    const res = await fetch("/api/personal-records/official", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: cat, label, best_value: val, achieved_date: dt })
    });
    if (res.ok) {
      const data = await res.json();
      renderOfficialRecords(data.official_records || []);
      toggleOfficialPrForm();
      showSuccessBanner("RP Oficial guardado.");
    }
  } catch (e) {}
}

async function loadSegmentsList() {
  const listEl = document.getElementById("summit-segments-list");
  if (!listEl) return;
  try {
    const res = await fetch("/api/segments");
    if (!res.ok) return;
    const data = await res.json();
    const segs = data.segments || [];
    if (segs.length === 0) {
      listEl.innerHTML = `<p class="body-sm-muted">Abre cualquier actividad con mapa y pulsa «Guardar ruta como Segmento» para seguir tus tiempos históricos.</p>`;
      return;
    }
    listEl.innerHTML = segs.map(seg => {
      const distKm = ((seg.distance_m || 0) / 1000).toFixed(2);
      const effortsHtml = (seg.efforts || []).slice(0, 6).map((e, i) => `
        <button type="button" class="segment-effort-chip ${i === 0 ? 'best' : ''}" onclick="openActivityDetail('${e.activity_id}')">
          ${i === 0 ? 'PR ' : ''}${e.elapsed_str} (${(e.achieved_date || '').slice(0, 10)})${e.vam_mh ? ` • ${e.vam_mh} m/h` : ''}
        </button>
      `).join("");
      return `
        <div class="segment-card-row">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
            <strong style="font-size:0.92rem; color:var(--on-surface);">${seg.name}</strong>
            <span class="pill-tag orange tabular-num">${seg.sport_type} • ${distKm} km</span>
          </div>
          <div class="segment-efforts-list">${effortsHtml || `<span class="body-xs">Sin intentos detectados todavía.</span>`}</div>
        </div>
      `;
    }).join("");
  } catch (e) {}
}

async function createSegmentFromActivity(externalId, defaultName) {
  const segName = window.prompt("Nombre del segmento (ej. Subida al Garbí):", defaultName || "Segmento Personal");
  if (!segName || !segName.trim()) return;
  try {
    const res = await fetch("/api/segments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: segName.trim(), activity_id: externalId })
    });
    if (res.ok) {
      await loadSegmentsList();
      showSuccessBanner("Segmento guardado e intentos históricos detectados.");
    }
  } catch (e) {}
}

function filterTrainingLog(sport, btnEl) {
  document.querySelectorAll("#training-log-filters .strava-chip-btn").forEach(b => {
    b.classList.remove("active");
    b.style.background = "";
    b.style.color = "";
  });
  if (btnEl) {
    btnEl.classList.add("active");
    btnEl.style.background = "#FC5200";
    btnEl.style.color = "#FFF";
  }
  renderTrainingLogBubbles(sport);
}

function renderTrainingLogBubbles(sportFilter) {
  const grid = document.getElementById("summit-bubble-grid");
  if (!grid || !_summitData || !_summitData.training_log) return;

  const days = _summitData.training_log;
  // Group into 12 columns (weeks) of 7 days
  let html = "";
  for (let w = 0; w < 12; w++) {
    html += `<div class="summit-week-col">`;
    for (let d = 0; d < 7; d++) {
      const item = days[w * 7 + d];
      if (!item) { html += `<div class="summit-bubble-cell"></div>`; continue; }
      const filtered = sportFilter === "Todo"
        ? item.entries
        : item.entries.filter(e => e.sport_type === sportFilter);
      const totalMin = filtered.reduce((s, e) => s + (e.min || 0), 0);
      const mainSport = filtered[0]?.sport_type || "";
      const color = mainSport === "Carrera" ? "#16A34A" : mainSport === "Ciclismo" ? "#0077CC" : mainSport === "Fuerza" ? "#FC5200" : "transparent";
      const size = totalMin > 0 ? Math.min(20, Math.max(7, Math.round(totalMin / 5))) : 0;

      html += `<div class="summit-bubble-cell" title="${item.date}: ${totalMin} min">
        ${size > 0 ? `<div class="summit-bubble-dot" style="width:${size}px; height:${size}px; background:${color};"></div>` : ""}
      </div>`;
    }
    html += `</div>`;
  }
  grid.innerHTML = html;
}

function renderFitnessFreshnessChart(curve) {
  const wrap = document.getElementById("summit-fitness-svg-wrap");
  if (!wrap || curve.length === 0) return;

  const W = 360, H = 120, pad = 10;
  const allVals = curve.flatMap(p => [p.ctl, p.atl, p.tsb]);
  const minV = Math.min(...allVals, -15);
  const maxV = Math.max(...allVals, 35);
  const range = (maxV - minV) || 1;

  const toPath = (key) => curve.map((pt, i) => {
    const x = pad + (i / (curve.length - 1)) * (W - pad * 2);
    const y = H - pad - ((pt[key] - minV) / range) * (H - pad * 2);
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");

  const zeroY = H - pad - ((0 - minV) / range) * (H - pad * 2);
  const last = curve[curve.length - 1];

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%; height:100%;">
      <line x1="${pad}" y1="${zeroY.toFixed(1)}" x2="${W - pad}" y2="${zeroY.toFixed(1)}" stroke="#E5E5EA" stroke-dasharray="3 3"/>
      <path d="${toPath('atl')}" fill="none" stroke="#FC5200" stroke-width="1.8" opacity="0.9"/>
      <path d="${toPath('ctl')}" fill="none" stroke="#0077CC" stroke-width="2.2"/>
      <path d="${toPath('tsb')}" fill="none" stroke="#16A34A" stroke-width="1.6" stroke-dasharray="2 2"/>
    </svg>
  `;
  const legend = document.getElementById("fitness-legend");
  if (legend && last) {
    legend.innerHTML = `<span style="color:#0077CC;">CTL ${last.ctl}</span> • <span style="color:#FC5200;">ATL ${last.atl}</span> • <span style="color:#16A34A;">TSB ${last.tsb}</span>`;
  }
}

function renderPersonalRecords(prs) {
  const grid = document.getElementById("summit-prs-grid");
  if (!grid) return;
  if (!prs || prs.length === 0) {
    grid.innerHTML = `<p class="body-sm-muted" style="grid-column:1/-1;">Sincroniza tus carreras y salidas en bici para calcular tus récords.</p>`;
    return;
  }
  grid.innerHTML = prs.map(pr => `
    <div class="p-stat-box" style="text-align:left; cursor:pointer;" onclick="openActivityDetail('${pr.activity_id}')">
      <span class="label-caps" style="color: var(--primary); font-size:0.65rem;">🏆 ${pr.label}</span>
      <span class="p-stat-val tabular-num" style="color: var(--on-surface); font-size:1.05rem;">${pr.best_value}</span>
      <span class="body-xs tabular-num" style="color:var(--text-muted);">${pr.achieved_date || ""}</span>
    </div>
  `).join("");
}

const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ARCGIS_FALLBACK_TILE_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}";
let _feedMapInstances = [];

function renderStravaLeafletRoute(map, polyline) {
  const primaryLayer = L.tileLayer(OSM_TILE_URL, {
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 19
  });

  let fallbackAdded = false;
  primaryLayer.on("tileerror", () => {
    if (fallbackAdded) return;
    fallbackAdded = true;
    map.removeLayer(primaryLayer);
    L.tileLayer(ARCGIS_FALLBACK_TILE_URL, {
      attribution: "&copy; Esri",
      maxZoom: 19
    }).addTo(map);
  });

  primaryLayer.addTo(map);
  const route = L.polyline(polyline, { color: "#FC5200", weight: 3.5, opacity: 0.95 }).addTo(map);
  const bounds = route.getBounds();
  map.fitBounds(bounds, { padding: [16, 16] });
  requestAnimationFrame(() => {
    map.invalidateSize();
    map.fitBounds(bounds, { padding: [16, 16] });
  });
  return route;
}

let _feedActivitiesCache = [];
let _feedLimit = 15;

function loadMoreActivities() {
  _feedLimit += 15;
  loadActivitiesFeed(_feedLimit);
}

async function loadActivitiesFeed(limit = _feedLimit) {
  const feedEl = document.getElementById("dashboard-activities-feed");
  const listEl = document.getElementById("metrics-history-list");
  if (!feedEl && !listEl) return;

  if (_feedActivitiesCache.length === 0) {
    const skel = `<div class="skeleton-shimmer" style="height:120px; margin-bottom:12px;"></div><div class="skeleton-shimmer" style="height:120px;"></div>`;
    if (feedEl) feedEl.innerHTML = skel;
    if (listEl) listEl.innerHTML = skel;
  }

  try {
    const res = await fetch(`/api/activities?limit=${limit}`);
    if (!res.ok) return;
    const data = await res.json();
    const acts = data.activities || [];
    _feedActivitiesCache = acts;

    // Update Desktop Weekly Summary (Left Column Profile Card)
    const monday = getMondayOfCurrentWeek();
    let weekRunKm = 0, weekBikeKm = 0, weekStrengthCount = 0;
    acts.forEach(a => {
      if (!a.start_date) return;
      const dt = new Date(a.start_date);
      if (dt >= monday) {
        if (a.sport_type === "Carrera") weekRunKm += Number(a.distance_km || 0);
        else if (a.sport_type === "Ciclismo") weekBikeKm += Number(a.distance_km || 0);
        else if (a.sport_type === "Fuerza") weekStrengthCount++;
      }
    });
    const elWeekRun = document.getElementById("desktop-week-run-km");
    const elWeekBike = document.getElementById("desktop-week-bike-km");
    const elWeekStr = document.getElementById("desktop-week-strength-count");
    if (elWeekRun) elWeekRun.textContent = `${weekRunKm.toFixed(1)} km`;
    if (elWeekBike) elWeekBike.textContent = `${weekBikeKm.toFixed(1)} km`;
    if (elWeekStr) elWeekStr.textContent = `${weekStrengthCount} ses`;

    if (acts.length === 0) {
      const emptyMsg = `
        <div class="glass-card" style="text-align:center; padding: 24px 16px;">
          <p class="body-md" style="font-weight:700; margin-bottom:4px;">Sin actividades sincronizadas todavía</p>
          <p class="body-sm-muted" style="margin-bottom:12px;">Conecta o sincroniza tu Garmin Connect para ver tus rutas, ritmos y mapas aquí.</p>
          <button type="button" class="btn btn-primary" style="margin:0 auto;" onclick="syncGarminNow()">Sincronizar Garmin Ahora</button>
        </div>`;
      if (feedEl) feedEl.innerHTML = emptyMsg;
      if (listEl) listEl.innerHTML = emptyMsg;
      return;
    }

    let feedHtml = "";
    let listHtml = "";

    acts.forEach((a, idx) => {
      const isFuerza = a.sport_type === "Fuerza";
      const isBici = a.sport_type === "Ciclismo";
      const sportSvg = isFuerza
        ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FC5200" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6.5 6.5 11 11"/><path d="m21 21-1-1"/><path d="m3 3 1 1"/><path d="m18 22 4-4"/><path d="m2 6 4-4"/></svg>`
        : isBici
        ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0077CC" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/></svg>`
        : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#16A34A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 4v6l3.5 3.5"/><circle cx="12" cy="12" r="9"/></svg>`;
      const badgeBg = isFuerza ? "rgba(252,82,0,0.10)" : isBici ? "rgba(0,119,204,0.10)" : "rgba(22,163,74,0.10)";
      const badgeColor = isFuerza ? "#FC5200" : isBici ? "#0077CC" : "#16A34A";
      const paceOrSpeed = isBici && a.duration_min > 0
        ? `${((a.distance_km || 0) / (a.duration_min / 60)).toFixed(1)} km/h`
        : (a.avg_pace_str || `${Math.round(a.duration_min || 0)} min`);
      const distVal = a.distance_km ? `${a.distance_km} km` : `${Math.round(a.duration_min || 0)} min`;
      const elevVal = `+${Math.round(a.elevation_gain || 0)} m`;
      const hasPoly = Array.isArray(a.polyline) && a.polyline.length > 2;

      feedHtml += `
        <article class="glass-card strava-feed-card" onclick="openActivityDetail('${a.external_id}')">
          <div class="strava-feed-header">
            <div class="strava-feed-meta">
              <span class="strava-feed-avatar">${sportSvg}</span>
              <div>
                <a href="/actividad/${a.external_id}" class="strava-feed-title" style="text-decoration:none; display:block;" onclick="event.preventDefault(); event.stopPropagation(); openActivityDetail('${a.external_id}')">${a.name}</a>
                <span class="strava-feed-date tabular-num">${a.start_date} • ${a.sport_type}</span>
              </div>
            </div>
            <span class="pill-tag" style="background:${badgeBg}; color:${badgeColor};">${a.sport_type}</span>
          </div>
          <div class="strava-feed-metrics">
            <div class="strava-feed-metric">
              <span class="label-caps">DISTANCIA</span>
              <strong class="tabular-num">${distVal}</strong>
            </div>
            <div class="strava-feed-metric">
              <span class="label-caps">${isBici ? "VELOCIDAD" : "RITMO"}</span>
              <strong class="tabular-num">${paceOrSpeed}</strong>
            </div>
            <div class="strava-feed-metric">
              <span class="label-caps">DESNIVEL</span>
              <strong class="tabular-num">${elevVal}</strong>
            </div>
          </div>
          ${hasPoly ? `<div id="feed-minimap-${idx}" class="activity-feed-map"></div>` : ""}
        </article>
      `;

      listHtml += `
        <div class="history-card-item" onclick="openActivityDetail('${a.external_id}')" style="cursor:pointer; border-left: 3px solid ${badgeColor};">
          <div class="history-card-header">
            <span class="label-caps tabular-num">${a.start_date}</span>
            <span class="pill-tag" style="background:${badgeBg}; color:${badgeColor};">${a.sport_type}</span>
          </div>
          <div class="history-title-row">
            <span class="headline-sm">${a.name}</span>
          </div>
          <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:6px; margin-top:6px;">
            <div><span class="body-xs" style="color:var(--text-muted); display:block;">DISTANCIA</span><strong class="tabular-num">${distVal}</strong></div>
            <div><span class="body-xs" style="color:var(--text-muted); display:block;">${isBici ? 'VELOCIDAD' : 'RITMO'}</span><strong class="tabular-num">${paceOrSpeed}</strong></div>
            <div><span class="body-xs" style="color:var(--text-muted); display:block;">DESNIVEL</span><strong class="tabular-num">${elevVal}</strong></div>
          </div>
        </div>
      `;
    });

    const loadMoreBtn = acts.length >= limit
      ? `<button type="button" class="btn btn-ghost" style="width:100%; border-radius:9999px; margin-top:4px;" onclick="loadMoreActivities()">Cargar más actividades</button>`
      : "";

    if (feedEl) feedEl.innerHTML = feedHtml + loadMoreBtn;
    if (listEl) listEl.innerHTML = listHtml + loadMoreBtn;

    // Render interactive Leaflet Voyager maps for activities with GPS polylines
    _feedMapInstances.forEach(m => { try { m.remove(); } catch (e) {} });
    _feedMapInstances = [];
    if (window.L && feedEl) {
      acts.forEach((a, idx) => {
        if (Array.isArray(a.polyline) && a.polyline.length > 2) {
          const mapEl = document.getElementById(`feed-minimap-${idx}`);
          if (!mapEl) return;
          const m = L.map(mapEl, { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false });
          renderStravaLeafletRoute(m, a.polyline);
          _feedMapInstances.push(m);
        }
      });
    }
  } catch (e) {
    console.warn("Activities feed load error:", e);
  }
}

let _currentDetailActivity = null;
let _detailStreamState = { pace: true, hr: true, cadence: false, temp: false };

function _fmtDurationHMS(mins) {
  const totalSec = Math.max(0, Math.round(Number(mins || 0) * 60));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function scrollDetailSection(secId, btnEl) {
  document.querySelectorAll(".strava-detail-sidebar .detail-nav-item").forEach(b => b.classList.remove("active"));
  if (btnEl) btnEl.classList.add("active");
  const target = document.getElementById(secId);
  if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function saveActivityNotes() {
  if (!_currentDetailActivity) return;
  const description = document.getElementById("detail-input-description")?.value ?? "";
  const private_notes = document.getElementById("detail-input-notes")?.value ?? "";
  try {
    const res = await fetch(`/api/activities/${_currentDetailActivity.external_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description, private_notes })
    });
    if (res.ok) showSuccessBanner("Descripción y notas privadas guardadas.");
  } catch (e) {}
}

async function saveActivityGear(gearIdVal) {
  if (!_currentDetailActivity) return;
  const gear_id = parseInt(gearIdVal || "0", 10);
  try {
    const res = await fetch(`/api/activities/${_currentDetailActivity.external_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gear_id })
    });
    if (res.ok) showSuccessBanner("Material asignado a la actividad.");
  } catch (e) {}
}

function toggleChartLayer(layerKey) {
  _detailStreamState[layerKey] = !_detailStreamState[layerKey];
  if (_currentDetailActivity) renderStravaDetailChart(_currentDetailActivity.chart_series || {});
}

function renderStravaDetailChart(series) {
  const act = _currentDetailActivity || { chart_series: series || {} };
  const chartCard = document.getElementById("detail-chart-card");
  const chartSvg = document.getElementById("detail-chart-svg");
  const togglesEl = document.getElementById("detail-stream-toggles");
  if (!chartSvg || !togglesEl) return;

  const cs = series || act.chart_series || {};
  const elevs = (cs.elevation_m || []).filter(v => v !== null && v !== undefined);
  const paces = (cs.pace_sec || []).filter(v => v !== null && v !== undefined && v > 120 && v < 1200);
  const hrs = (cs.hr || []).filter(v => v !== null && v !== undefined);
  const cads = (cs.cadence || []).filter(v => v !== null && v !== undefined);
  const temps = (cs.temp_c || []).filter(v => v !== null && v !== undefined);

  const avg = (arr) => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length) : null;
  const avgPaceSec = avg(paces);
  const avgPaceStr = avgPaceSec ? `${Math.floor(avgPaceSec / 60)}:${String(Math.round(avgPaceSec % 60)).padStart(2, "0")} /km` : (act.avg_pace_str || "—");
  const avgHrVal = avg(hrs) ? `${Math.round(avg(hrs))} ppm` : (act.avg_hr ? `${Math.round(act.avg_hr)} ppm` : "—");
  const avgCadVal = avg(cads) ? `${Math.round(avg(cads))} ppm` : (act.avg_cadence ? `${act.avg_cadence} ppm` : "—");
  const avgTempVal = avg(temps) !== null ? `${avg(temps).toFixed(1)} °C` : (act.avg_temp_c !== null && act.avg_temp_c !== undefined ? `${Number(act.avg_temp_c).toFixed(1)} °C` : "—");

  const streamsMeta = [
    { key: "pace", label: "Ritmo", avg: avgPaceStr, color: "#0077CC", data: cs.pace_sec || [], invert: true },
    { key: "hr", label: "Frecuencia cardíaca", avg: avgHrVal, color: "#E53935", data: cs.hr || [], invert: false },
    { key: "cadence", label: "Cadencia", avg: avgCadVal, color: "#8E24AA", data: cs.cadence || [], invert: false },
    { key: "temp", label: "Temperatura", avg: avgTempVal, color: "#FB8C00", data: cs.temp_c || [], invert: false }
  ];

  togglesEl.innerHTML = streamsMeta.map(s => {
    const isOn = !!_detailStreamState[s.key];
    return `
      <div class="detail-toggle-row">
        <div>
          <span class="body-xs" style="display:flex; align-items:center; gap:5px; font-weight:700; color:var(--text-secondary);">
            <span style="width:8px; height:8px; border-radius:50%; background:${s.color}; display:inline-block;"></span>
            ${s.label}
          </span>
          <strong class="tabular-num" style="font-size:0.86rem; color:var(--on-surface);">${s.avg}</strong>
        </div>
        <button type="button" class="detail-toggle-btn ${isOn ? "on" : ""}" onclick="toggleChartLayer('${s.key}')">${isOn ? "Sí" : "No"}</button>
      </div>
    `;
  }).join("");

  if (!cs.dist_km || cs.dist_km.length < 4) {
    if (chartCard) chartCard.style.display = "flex";
    chartSvg.innerHTML = `<div style="height:100%; display:flex; align-items:center; justify-content:center;" class="body-xs">Sin series temporales detalladas para esta actividad.</div>`;
    return;
  }

  const W = 640, H = 170, pad = 10;
  const buildPath = (rawArr, invert = false) => {
    const pts = [];
    const valid = rawArr.filter(v => v !== null && v !== undefined);
    if (valid.length < 3) return "";
    const mn = Math.min(...valid), mx = Math.max(...valid), rng = (mx - mn) || 1;
    rawArr.forEach((v, i) => {
      if (v === null || v === undefined) return;
      const x = pad + (i / Math.max(1, rawArr.length - 1)) * (W - pad * 2);
      const norm = (v - mn) / rng;
      const y = invert ? (pad + norm * (H - pad * 2)) : (H - pad - norm * (H - pad * 2));
      pts.push(`${pts.length === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`);
    });
    return pts.join(" ");
  };

  let elevArea = "";
  const elevLine = buildPath(cs.elevation_m || [], false);
  if (elevLine) {
    elevArea = `${elevLine} L${(W - pad).toFixed(1)},${(H - pad).toFixed(1)} L${pad.toFixed(1)},${(H - pad).toFixed(1)} Z`;
  }

  const overlays = streamsMeta
    .filter(s => _detailStreamState[s.key])
    .map(s => {
      const p = buildPath(s.data, s.invert);
      return p ? `<path d="${p}" fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linecap="round"/>` : "";
    })
    .join("");

  chartSvg.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%; height:100%; background:#FAFAFC; border:1px solid #E5E5EA; border-radius:6px;">
      ${elevArea ? `<path d="${elevArea}" fill="#E5E5EA" opacity="0.7"/>` : ""}
      ${elevLine ? `<path d="${elevLine}" fill="none" stroke="#9CA3AF" stroke-width="1.5"/>` : ""}
      ${overlays}
    </svg>
  `;
}

function _paintActivityDetailHeaderAndMap(act) {
  document.getElementById("detail-modal-sport").textContent = (act.sport_type || "GARMIN").toUpperCase();
  document.getElementById("detail-modal-date").textContent = act.start_date || "";
  const dtHeader = document.getElementById("detail-header-datetime");
  if (dtHeader) dtHeader.textContent = `${act.start_date || ""} • ${act.sport_type || ""}`;
  document.getElementById("detail-modal-title").textContent = act.name || "Actividad";

  const descEl = document.getElementById("detail-input-description");
  const notesEl = document.getElementById("detail-input-notes");
  if (descEl) descEl.value = act.description || "";
  if (notesEl) notesEl.value = act.private_notes || "";

  document.getElementById("detail-stat-dist").textContent = act.distance_km ? `${act.distance_km} km` : `${Math.round(act.duration_min || 0)} min`;
  const movingEl = document.getElementById("detail-stat-moving");
  if (movingEl) movingEl.textContent = _fmtDurationHMS(act.moving_duration_min || act.duration_min || 0);
  const isBici = act.sport_type === "Ciclismo";
  document.getElementById("detail-stat-pace").textContent = isBici && act.duration_min > 0
    ? `${((act.distance_km || 0) / (act.duration_min / 60)).toFixed(1)} km/h`
    : (act.avg_pace_str || "—");
  document.getElementById("detail-stat-elev").textContent = `+${Math.round(act.elevation_gain || 0)} m`;
  const elapsedEl = document.getElementById("detail-stat-elapsed");
  if (elapsedEl) elapsedEl.textContent = _fmtDurationHMS(act.elapsed_duration_min || act.duration_min || 0);
  const calEl = document.getElementById("detail-stat-calories");
  if (calEl) calEl.textContent = act.calories ? `${Math.round(act.calories)} kcal` : "—";
  const devEl = document.getElementById("detail-device-name");
  if (devEl) devEl.textContent = act.device_name || "Garmin Connect";

  const mapCont = document.getElementById("detail-map-container");
  const segBtn = document.getElementById("btn-create-segment-from-act");
  const gpxBtn = document.getElementById("btn-download-gpx");
  if (_detailMapInstance) { _detailMapInstance.remove(); _detailMapInstance = null; }
  if (window.L && act.polyline && act.polyline.length > 2) {
    mapCont.style.display = "block";
    if (segBtn) {
      segBtn.style.display = "inline-flex";
      segBtn.onclick = () => createSegmentFromActivity(act.external_id, act.name);
    }
    if (gpxBtn) {
      gpxBtn.style.display = "inline-flex";
      gpxBtn.href = `/api/activities/${act.external_id}/gpx`;
    }
    setTimeout(() => {
      _detailMapInstance = L.map(mapCont);
      renderStravaLeafletRoute(_detailMapInstance, act.polyline);
    }, 40);
  } else {
    mapCont.style.display = "none";
    if (segBtn) segBtn.style.display = "none";
    if (gpxBtn) gpxBtn.style.display = "none";
  }
}

async function openActivityDetail(externalId, updateUrl = true) {
  const modal = document.getElementById("activity-detail-modal");
  if (!modal) return;
  modal.style.display = "flex";
  if (updateUrl) {
    const targetPath = `/actividad/${externalId}`;
    if (window.location.pathname !== targetPath) {
      history.pushState({ externalId }, "", targetPath);
    }
  }
  if (window.lucide) lucide.createIcons();

  // 1. Instant render from cached feed data while full detail streams load in background
  const cached = _feedActivitiesCache.find(x => String(x.external_id) === String(externalId));
  if (cached) {
    _currentDetailActivity = cached;
    _paintActivityDetailHeaderAndMap(cached);
    const splitsList = document.getElementById("detail-splits-list");
    if (splitsList) splitsList.innerHTML = `<div class="skeleton-shimmer" style="height:48px;"></div>`;
    const chartSvg = document.getElementById("detail-chart-svg");
    if (chartSvg) chartSvg.innerHTML = `<div class="skeleton-shimmer" style="height:100%;"></div>`;
  }

  try {
    const res = await fetch(`/api/activities/${externalId}`);
    if (!res.ok) return;
    const act = await res.json();
    _currentDetailActivity = act;
    const isBici = act.sport_type === "Ciclismo";

    // Re-paint header & map (with full-resolution polyline if available)
    _paintActivityDetailHeaderAndMap(act);

    // Populate gear dropdown
    const gearSel = document.getElementById("detail-gear-select");
    if (gearSel) {
      try {
        const gRes = await fetch("/api/gear");
        if (gRes.ok) {
          const gData = await gRes.json();
          const opts = [`<option value="0">Sin asignar</option>`].concat(
            (gData.gear || []).map(g => `<option value="${g.id}">${g.name}</option>`)
          );
          gearSel.innerHTML = opts.join("");
          gearSel.value = String(act.gear_id || 0);
        }
      } catch (e) {}
    }

    // Render Relative Effort, VAM & Interactive RPE (1-10)
    const relEl = document.getElementById("detail-relative-effort");
    const vamEl = document.getElementById("detail-vam-mh");
    const rpeWrap = document.getElementById("detail-rpe-buttons");
    if (relEl) relEl.textContent = act.relative_effort !== null && act.relative_effort !== undefined ? `${act.relative_effort}` : "—";
    if (vamEl) vamEl.textContent = act.vam_mh ? `${act.vam_mh} m/h` : "—";
    if (rpeWrap) {
      const currentRpe = Number(act.rpe || 0);
      rpeWrap.innerHTML = Array.from({ length: 10 }, (_, i) => i + 1).map(n => `
        <button type="button" class="rpe-btn ${currentRpe === n ? 'active' : ''}" onclick="setActivityRpe('${act.external_id}', ${n})">${n}</button>
      `).join("");
    }

    // Render Cycling Power, Energy & Intensity Band
    const cycCard = document.getElementById("detail-cycling-card");
    if (cycCard) {
      if (isBici && act.avg_power_w) {
        cycCard.style.display = "flex";
        document.getElementById("detail-power-w").textContent = `${Math.round(act.avg_power_w)} W`;
        document.getElementById("detail-energy-kj").textContent = act.energy_kj ? `${Math.round(act.energy_kj)} kJ` : "—";
        const pct = Number(act.intensity_pct || 0);
        document.getElementById("detail-intensity-pct").textContent = pct ? `${pct}%` : "—";
        const band = pct >= 95 ? "Contrarreloj (Z4–Z5)" : pct >= 80 ? "Con ritmo (Tempo)" : pct >= 65 ? "Moderada (Aeróbica)" : "Resistencia (Z1–Z2)";
        document.getElementById("detail-intensity-band").textContent = `Zona de Intensidad: ${band}`;
      } else {
        cycCard.style.display = "none";
      }
    }

    // Render Strava-style Parciales Table (KM, Ritmo, Desn.) including fractional last split
    const splitsList = document.getElementById("detail-splits-list");
    if (act.splits && act.splits.length > 0) {
      const minPace = Math.min(...act.splits.map(s => s.pace_sec));
      const maxPace = Math.max(...act.splits.map(s => s.pace_sec));
      splitsList.innerHTML = act.splits.map(s => {
        const ratio = maxPace > minPace ? 100 - ((s.pace_sec - minPace) / (maxPace - minPace)) * 45 : 85;
        const elevTxt = s.elev_diff !== undefined && s.elev_diff !== null ? `${s.elev_diff >= 0 ? "+" : ""}${Math.round(s.elev_diff)} m` : "—";
        return `
          <div class="detail-split-row">
            <span style="color:var(--text-secondary); font-weight:700;">${s.km} km</span>
            <div class="detail-split-pace-wrap">
              <span style="font-weight:800; color:var(--on-surface); min-width:58px;">${s.pace_str}</span>
              <div class="split-bar-track" style="flex:1;"><div class="split-bar-fill" style="width:${Math.round(ratio)}%;"></div></div>
            </div>
            <span style="color:var(--text-secondary); text-align:right;">${elevTxt}</span>
          </div>
        `;
      }).join("");
    } else {
      splitsList.innerHTML = `<p class="body-xs">Sin parciales disponibles para esta actividad.</p>`;
    }

    // Render Synchronized Chart + Toggles
    renderStravaDetailChart(act.chart_series || {});

    // Render HR Zones Z1-Z5 + Cardiac Drift + HR Curve SVG
    renderHrAnalysisSubview(act);

    // Render Matched Runs + Pace Analysis (GAP) + Pace Distribution (Z1-Z6)
    renderMatchedRuns(act.matched_runs || []);
    renderPaceAnalysisSubview(act);
    renderPaceDistributionSubview(act.pace_distribution || null);

    // Render Detected Segments in this Activity
    const segListEl = document.getElementById("detail-segments-list");
    if (segListEl) {
      const effs = act.segment_efforts || [];
      segListEl.innerHTML = effs.length > 0
        ? effs.map(se => `
            <div class="segment-card-row" style="flex-direction:row; justify-content:space-between; align-items:center;">
              <div>
                <strong style="font-size:0.88rem;">${se.segment_name}</strong>
                <span class="body-xs" style="display:block;">${((se.distance_m || 0) / 1000).toFixed(2)} km${se.vam_mh ? ` • ${se.vam_mh} m/h` : ""}</span>
              </div>
              <strong class="tabular-num" style="color:var(--primary-text);">${se.elapsed_str}</strong>
            </div>
          `).join("")
        : `<p class="body-xs">Sin segmentos detectados en esta actividad.</p>`;
    }

    // Render PRs achieved in this activity (from _summitData)
    const prsListEl = document.getElementById("detail-prs-list");
    if (prsListEl && _summitData && Array.isArray(_summitData.personal_records)) {
      const actPrs = _summitData.personal_records.filter(p => String(p.activity_id) === String(act.external_id));
      prsListEl.innerHTML = actPrs.length > 0
        ? actPrs.map(p => `
            <div class="p-stat-box" style="text-align:left;">
              <span class="label-caps" style="color:var(--primary-text);">${p.label}</span>
              <span class="p-stat-val tabular-num">${p.best_value}</span>
            </div>
          `).join("")
        : `<p class="body-xs" style="grid-column:1/-1;">Sin récords GPS asignados a esta sesión.</p>`;
    }
  } catch (e) {
    console.warn("Detail modal error:", e);
  }
}

function closeActivityDetailModal(updateUrl = true) {
  const modal = document.getElementById("activity-detail-modal");
  if (modal) modal.style.display = "none";
  if (_detailMapInstance) { _detailMapInstance.remove(); _detailMapInstance = null; }
  if (updateUrl && window.location.pathname.startsWith("/actividad/")) {
    const backPath = TAB_TO_ROUTE[_lastTabId] || "/inicio";
    history.pushState({ tabId: _lastTabId }, "", backPath);
  }
}

async function setActivityRpe(externalId, rpe) {
  try {
    const res = await fetch(`/api/activities/${externalId}/rpe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rpe })
    });
    if (!res.ok) return;
    const data = await res.json();
    const relEl = document.getElementById("detail-relative-effort");
    if (relEl && data.relative_effort !== null && data.relative_effort !== undefined) {
      relEl.textContent = `${data.relative_effort}`;
    }
    const rpeBtns = document.querySelectorAll("#detail-rpe-buttons .rpe-btn");
    rpeBtns.forEach((btn, idx) => btn.classList.toggle("active", idx + 1 === rpe));
    loadSummitAnalytics();
    showSuccessBanner(`RPE ${rpe}/10 guardado.`);
  } catch (e) {}
}

// ============================================================
// FASE 4: GEAR TRACKER (ZAPATILLAS & BICI)
// ============================================================
async function loadGearList() {
  const cont = document.getElementById("gear-list-container");
  const dashCont = document.getElementById("dashboard-gear-list");
  if (!cont && !dashCont) return;
  try {
    const res = await fetch("/api/gear");
    if (!res.ok) return;
    const data = await res.json();
    const list = data.gear || [];
    const html = list.map(g => {
      const pct = Math.min(100, Math.round((g.total_km / (g.alert_km || 650)) * 100));
      const warn = g.total_km >= (g.alert_km || 650) * 0.9;
      return `
        <div style="background:var(--surface-dim); border:1px solid ${warn ? '#FC5200' : 'var(--border-glass)'}; border-radius:8px; padding:10px 12px;">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:6px;">
            <strong style="font-size:0.85rem; color:var(--on-surface);">${g.gear_type === 'shoes' ? '👟' : '🚴'} ${g.name}</strong>
            <span class="label-caps tabular-num" style="color:${warn ? '#FC5200' : 'var(--text-secondary)'}; font-size:0.74rem;">${g.total_km} / ${g.alert_km} km</span>
          </div>
          <div class="progress-bar-wrap" style="margin-top:6px;">
            <div class="progress-fill" style="width:${pct}%; background:${warn ? '#FC5200' : '#0077CC'};"></div>
          </div>
          ${warn ? `<span class="body-xs" style="color:#FC5200; margin-top:4px; display:block;">⚠️ Cerca del límite de desgaste recomendado</span>` : ""}
        </div>
      `;
    }).join("");
    if (cont) cont.innerHTML = html;
    if (dashCont) dashCont.innerHTML = html || `<p class="body-xs" style="color:var(--text-muted);">Sin material registrado.</p>`;
  } catch (e) {}
}

function toggleGearForm() {
  const f = document.getElementById("gear-add-form");
  if (f) f.style.display = f.style.display === "none" ? "flex" : "none";
}

async function saveNewGear() {
  const name = document.getElementById("gear-input-name")?.value.trim();
  const type = document.getElementById("gear-input-type")?.value || "shoes";
  const alertKm = parseFloat(document.getElementById("gear-input-alert")?.value || "650");
  if (!name) return;
  try {
    await fetch("/api/gear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, gear_type: type, brand: "", initial_km: 0, alert_km: alertKm })
    });
    toggleGearForm();
    await loadGearList();
    showSuccessBanner("✅ Material añadido al Gear Tracker.");
  } catch (e) {}
}












// ============================================================
// STRAVA PREMIUM SUBVIEWS & THRESHOLD PACE CALIBRATION
// ============================================================
async function loadThresholdPace() {
  try {
    const res = await fetch("/api/settings/threshold-pace");
    if (!res.ok) return;
    const data = await res.json();
    const sec = Number(data.threshold_pace_sec || 285);
    const mm = Math.floor(sec / 60);
    const ss = String(sec % 60).padStart(2, "0");
    const inp = document.getElementById("profile-threshold-pace-input");
    const badge = document.getElementById("profile-threshold-badge");
    if (inp) inp.value = `${mm}:${ss}`;
    if (badge) badge.textContent = `${mm}:${ss} /km`;
  } catch (e) {}
}

async function saveThresholdPace() {
  const inp = document.getElementById("profile-threshold-pace-input");
  const badge = document.getElementById("profile-threshold-badge");
  if (!inp) return;
  const raw = inp.value.trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    showSuccessBanner("⚠️ Usa formato mm:ss (ej. 4:45).");
    return;
  }
  const sec = parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
  try {
    const res = await fetch("/api/settings/threshold-pace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threshold_pace_sec: sec })
    });
    if (res.ok) {
      const data = await res.json();
      if (badge) badge.textContent = data.threshold_pace_str || `${raw} /km`;
      showSuccessBanner(`✅ Ritmo umbral calibrado a ${data.threshold_pace_str || raw}`);
    }
  } catch (e) {}
}

function renderMatchedRuns(matchedRuns) {
  const card = document.getElementById("detail-matched-runs-card");
  const countEl = document.getElementById("detail-matched-count");
  const svgEl = document.getElementById("detail-matched-svg");
  if (!card || !svgEl) return;

  if (!Array.isArray(matchedRuns) || matchedRuns.length <= 1) {
    card.style.display = "none";
    return;
  }
  card.style.display = "flex";
  if (countEl) countEl.textContent = `${matchedRuns.length} carreras`;

  const valid = matchedRuns.filter(r => r.pace_sec && r.pace_sec > 0);
  if (valid.length < 2) {
    svgEl.innerHTML = `<p class="body-xs">Sin datos de ritmo suficientes para comparar.</p>`;
    return;
  }

  const W = 560, H = 120, padX = 28, padY = 18;
  const paces = valid.map(r => r.pace_sec);
  const minP = Math.min(...paces), maxP = Math.max(...paces), rng = (maxP - minP) || 10;

  const coords = valid.map((r, i) => {
    const x = padX + (i / (valid.length - 1)) * (W - padX * 2);
    // Faster pace (lower sec) higher up on chart
    const y = padY + ((r.pace_sec - minP) / rng) * (H - padY * 2);
    return { x, y, r };
  });

  const linePath = coords.map((pt, i) => `${i === 0 ? "M" : "L"}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(" ");
  const dotsHtml = coords.map(pt => {
    const col = pt.r.is_current ? "#FC5200" : "#0066B3";
    const rad = pt.r.is_current ? 6 : 4.5;
    return `
      <g style="cursor:pointer;" onclick="openActivityDetail('${pt.r.external_id}')">
        <title>${pt.r.start_date} · ${pt.r.avg_pace_str}</title>
        <circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="${rad}" fill="${col}" stroke="#FFFFFF" stroke-width="1.5"/>
      </g>
    `;
  }).join("");

  svgEl.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%; height:100%; background:#FAFAFC; border:1px solid #E5E5EA; border-radius:8px;">
      <path d="${linePath}" fill="none" stroke="#93C5FD" stroke-width="2"/>
      ${dotsHtml}
    </svg>
  `;
}

function renderPaceAnalysisSubview(act) {
  const mvEl = document.getElementById("detail-pace-moving");
  const gapEl = document.getElementById("detail-pace-gap");
  const elEl = document.getElementById("detail-pace-elapsed");
  const listEl = document.getElementById("detail-pace-analysis-list");
  if (!listEl) return;

  if (mvEl) mvEl.textContent = act.avg_pace_str || "—";
  if (gapEl) gapEl.textContent = act.avg_gap_str || act.avg_pace_str || "—";
  if (elEl) {
    const dist = Number(act.distance_km || 0);
    const elMin = Number(act.elapsed_duration_min || act.duration_min || 0);
    if (dist > 0.1 && elMin > 0.1) {
      const s = Math.round((elMin * 60) / dist);
      elEl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} /km`;
    } else {
      elEl.textContent = act.avg_pace_str || "—";
    }
  }

  const splits = act.splits || [];
  if (splits.length === 0) {
    listEl.innerHTML = `<p class="body-xs">Sin parciales detallados para esta sesión.</p>`;
    return;
  }

  const minPace = Math.min(...splits.map(s => s.pace_sec));
  const maxPace = Math.max(...splits.map(s => s.pace_sec));
  listEl.innerHTML = splits.map(s => {
    const ratio = maxPace > minPace ? 100 - ((s.pace_sec - minPace) / (maxPace - minPace)) * 48 : 85;
    const isFast = s.pace_sec <= minPace + 5;
    const barColor = isFast ? "#FC5200" : "#0066B3";
    const elevTxt = s.elev_diff !== undefined && s.elev_diff !== null ? `${s.elev_diff >= 0 ? "+" : ""}${Math.round(s.elev_diff)}m` : "—";
    const hrTxt = s.avg_hr ? `${Math.round(s.avg_hr)}` : "—";
    return `
      <div class="pace-analysis-row">
        <strong style="color:var(--text-secondary);">${s.km}</strong>
        <div class="pace-bar-dual">
          <strong style="min-width:54px; color:var(--on-surface);">${s.pace_str}</strong>
          <div class="split-bar-track" style="flex:1;"><div style="height:100%; width:${Math.round(ratio)}%; background:${barColor}; border-radius:999px;"></div></div>
        </div>
        <strong style="color:var(--primary-text);">${s.gap_str || s.pace_str}</strong>
        <span style="color:var(--text-secondary);">${elevTxt}</span>
        <span style="text-align:right; color:var(--text-secondary);">${hrTxt}</span>
      </div>
    `;
  }).join("");
}

function renderPaceDistributionSubview(paceDist) {
  const listEl = document.getElementById("detail-pace-dist-list");
  const lblEl = document.getElementById("detail-pace-threshold-label");
  if (!listEl) return;

  if (!paceDist || !Array.isArray(paceDist.zones)) {
    listEl.innerHTML = `<p class="body-xs">Sin datos de ritmo por segundo disponibles.</p>`;
    return;
  }
  if (lblEl && paceDist.threshold_pace_str) {
    lblEl.textContent = `Umbral: ${paceDist.threshold_pace_str}`;
  }

  listEl.innerHTML = paceDist.zones.map(z => `
    <div class="pace-dist-row">
      <div>
        <strong style="display:block; color:var(--on-surface);">${z.zone}</strong>
        <span class="body-xs" style="font-size:0.68rem;">${z.range_str}</span>
      </div>
      <div class="split-bar-track" style="height:12px;">
        <div style="height:100%; width:${z.pct}%; background:${z.color}; border-radius:999px;"></div>
      </div>
      <span style="text-align:right; font-weight:700;">${z.time_str}</span>
      <span style="text-align:right; color:var(--text-secondary);">${z.pct}%</span>
    </div>
  `).join("");
}

function renderHrAnalysisSubview(act) {
  const zonesCard = document.getElementById("detail-zones-card");
  const zonesList = document.getElementById("detail-zones-list");
  const driftBadge = document.getElementById("detail-drift-badge");
  const hrSvg = document.getElementById("detail-hr-curve-svg");
  if (!zonesCard || !zonesList) return;

  const zones = act.hr_zones || [];
  if (zones.length === 0) {
    zonesCard.style.display = "none";
    return;
  }
  zonesCard.style.display = "flex";

  const hrAnalysis = act.hr_analysis || {};
  if (driftBadge) {
    const drift = hrAnalysis.cardiac_drift_pct;
    if (drift !== null && drift !== undefined) {
      driftBadge.textContent = `Desacoplamiento: ${drift >= 0 ? "+" : ""}${drift}%`;
      driftBadge.className = `pill-tag tabular-num ${Math.abs(drift) <= 5 ? "" : "orange"}`;
    } else {
      driftBadge.textContent = "Desacoplamiento: —";
    }
  }

  if (hrSvg) {
    const hrs = ((act.chart_series || {}).hr || []).filter(v => v !== null && v !== undefined && v > 40);
    if (hrs.length >= 6) {
      const W = 560, H = 120, pad = 8;
      const mn = Math.min(...hrs, 100), mx = Math.max(...hrs, 180), rng = (mx - mn) || 1;
      const pathPts = hrs.map((h, i) => {
        const x = pad + (i / (hrs.length - 1)) * (W - pad * 2);
        const y = H - pad - ((h - mn) / rng) * (H - pad * 2);
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(" ");
      hrSvg.innerHTML = `
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%; height:100%; border:1px solid #E5E5EA; border-radius:8px; overflow:hidden;">
          <rect x="0" y="0" width="${W}" height="${H * 0.2}" fill="rgba(255,23,68,0.08)"/>
          <rect x="0" y="${H * 0.2}" width="${W}" height="${H * 0.2}" fill="rgba(255,152,0,0.08)"/>
          <rect x="0" y="${H * 0.4}" width="${W}" height="${H * 0.2}" fill="rgba(0,230,118,0.08)"/>
          <rect x="0" y="${H * 0.6}" width="${W}" height="${H * 0.2}" fill="rgba(0,174,239,0.08)"/>
          <rect x="0" y="${H * 0.8}" width="${W}" height="${H * 0.2}" fill="rgba(100,116,139,0.08)"/>
          <path d="${pathPts}" fill="none" stroke="#E53935" stroke-width="2.2" stroke-linecap="round"/>
        </svg>
      `;
    } else {
      hrSvg.innerHTML = "";
      hrSvg.style.height = "auto";
    }
  }

  zonesList.innerHTML = zones.map(z => `
    <div style="display:flex; flex-direction:column; gap:3px;">
      <div style="display:flex; justify-content:space-between; font-size:0.75rem; gap:6px; flex-wrap:wrap;">
        <span style="color:var(--on-surface); font-weight:700;">${z.zone} <small class="tabular-num" style="color:var(--text-muted);">(${z.range})</small></span>
        <span class="tabular-num" style="color:${z.color}; font-weight:800;">
          ${z.time_str || "0:00"} • ${z.pct}% ${z.trimp_points ? `• ${z.trimp_points} TRIMP` : ""}
        </span>
      </div>
      <div class="split-bar-track"><div style="height:100%; width:${z.pct}%; background:${z.color}; border-radius:999px;"></div></div>
    </div>
  `).join("");
}
