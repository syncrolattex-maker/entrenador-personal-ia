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
  currentWorkout: null,
  wellnessToday: null,
  wellnessHistory: null,
  wellnessHistoryDays: 28,
  wellnessCheckin: null,
  wellnessLoading: false,
  garminConnected: null
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
let _summitLoadedOnce = false;

document.addEventListener("DOMContentLoaded", () => {
  loadDashboardSummary();
  initApp();
  loadActivitiesFeed();
  initWellnessCheckinEvents();
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

async function loadDashboardSummary(force = false) {
  try {
    const res = await fetch(force ? "/api/dashboard/summary?refresh=true" : "/api/dashboard/summary");
    if (!res.ok) {
      // Fallback to individual endpoints if consolidated summary is unavailable
      checkGarminStatus();
      loadWeeklyPlanAndRaceGoal();
      loadGearList();
      loadWellnessToday(force);
      return;
    }
    const data = await res.json();
    if (data.garmin_status) {
      updateGarminUI(
        data.garmin_status.connected,
        data.garmin_status.profile,
        data.garmin_status.write_connected
      );
    }
    if (data.estado_atleta) {
      state.db = data.estado_atleta;
      updateStatsBanner();
    }
    if (Array.isArray(data.historial_entrenamientos)) {
      state.history = data.historial_entrenamientos;
    }
    if (data.weekly_plan) {
      renderWeeklyPlan(data.weekly_plan);
    }
    if (data.wellness_today) {
      _wellnessCache.today = data.wellness_today;
      _wellnessCache.todayFetchedAt = Date.now();
      state.wellnessToday = data.wellness_today;
      renderWellnessTodayDashboard(data.wellness_today);
    }
    if (data.updated_at) {
      const pill = document.getElementById("wellness-dash-status-pill");
      if (pill) {
        const dt = new Date(data.updated_at);
        const hhmm = isNaN(dt.getTime()) ? "" : dt.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
        pill.textContent = hhmm ? `GARMIN REAL · ${hhmm}` : "GARMIN REAL";
      }
    }
    if (data.training_load) {
      renderHomeTrainingLoad(data.training_load, data.training_load.aerobic_efficiency);
    }
    if (Array.isArray(data.gear)) {
      renderGearListItems(data.gear);
    }
  } catch (err) {
    console.warn("[Dashboard] Consolidated summary failed, falling back:", err);
    checkGarminStatus();
    loadWeeklyPlanAndRaceGoal();
    loadGearList();
    loadWellnessToday(force);
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
    // 1. Clear cache if version changed (cache buster)
    const APP_VERSION = "v100";
    const cachedVersion = localStorage.getItem("cached_version");
    if (cachedVersion !== APP_VERSION) {
      localStorage.removeItem("cached_recommendation");
      localStorage.removeItem("cached_recommendation_date");
      localStorage.removeItem("cached_workout");
      localStorage.removeItem("cached_workout_date");
      localStorage.setItem("cached_version", APP_VERSION);
    }

    // 2. Read cached recommendation for today (instant render)
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

    // 3. Fetch recommendation in background (non-blocking for rest of dashboard)
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
  if (elRecTipoLabel) {
    elRecTipoLabel.textContent = rec.recomendacion;
    if (rec.recomendacion === "Fuerza") {
      elRecTipoLabel.style.color = "var(--accent-fuerza)";
    } else if (rec.recomendacion === "Carrera") {
      elRecTipoLabel.style.color = "var(--accent-carrera)";
    } else {
      elRecTipoLabel.style.color = "var(--accent-success)";
    }
  }
  if (elRecRazonText) elRecRazonText.textContent = rec.razon;
  if (elRecSemanalText) elRecSemanalText.textContent = rec.explicacion_semanal || "";

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

  // Hero Card (#stride-hero-card) is populated deterministically by loadWeeklyPlan()
  // so it always reflects the active weekly plan without AI recommendation overrides.

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
  const hm = document.querySelector(".strava-body-heatmap");
  if (hm && window.AaronCharts && typeof window.AaronCharts.animateMuscles === "function") {
    window.AaronCharts.animateMuscles(hm);
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
let _successBannerTimer = null;

function showSuccessBanner(completado, synced = false) {
  if (!elSuccessBanner || !elSuccessText) return;
  elSuccessBanner.style.display = "flex";
  if (typeof completado === "string") {
    elSuccessText.textContent = completado;
  } else if (completado) {
    const syncMsg = synced ? " Registrado en Garmin/DB ✅" : "";
    elSuccessText.innerHTML = `💪 <strong>¡Sesión guardada!</strong>${syncMsg} Tu próxima rutina está lista.`;
  } else {
    elSuccessText.innerHTML = `🧘 <strong>Día de descanso registrado.</strong> Sin culpas. Tu entrenamiento te espera mañana.`;
  }
  if (_successBannerTimer) clearTimeout(_successBannerTimer);
  _successBannerTimer = setTimeout(hideSuccessBanner, 5000);
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

let _selectedHomeWeekIdx = null;

function toggleHomeWeekDay(idx) {
  const panel = document.getElementById("stride-week-day-panel");
  if (!panel || !_latestWeeklyPlan || !_latestWeeklyPlan.dias || !_latestWeeklyPlan.dias[idx]) return;

  _selectedHomeWeekIdx = _selectedHomeWeekIdx === idx ? null : idx;
  document.querySelectorAll("#stride-week-strip .stride-day-col").forEach((el, i) => {
    el.classList.toggle("is-selected", i === _selectedHomeWeekIdx);
  });

  if (_selectedHomeWeekIdx === null) {
    panel.style.display = "none";
    return;
  }

  const d = _latestWeeklyPlan.dias[idx];
  const isRest = d.tipo === "Descanso";
  const distInfo = d.distancia_km > 0 ? `${d.distancia_km} km` : (d.duracion_min > 0 ? `${d.duracion_min} min` : "Descanso");

  let preview = "";
  if (Array.isArray(d.phases) && d.phases.length > 0) {
    preview = d.phases.map(p => `${p.name} (${Math.max(1, Math.round((p.duration_seconds || 0) / 60))}')`).join(" → ");
  } else if (Array.isArray(d.ejercicios) && d.ejercicios.length > 0) {
    preview = d.ejercicios.map(ex => `${ex.nombre} ${ex.series}×${ex.repeticiones}`).join(" · ");
  }

  panel.style.display = "flex";
  panel.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
      <div>
        <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
          <strong style="font-size:0.86rem; color:var(--primary-text);">${d.dia}${d.es_hoy ? " • HOY" : ""}</strong>
          <span class="body-xs tabular-num">${d.fecha}</span>
          <span class="pill-tag">${d.tipo}</span>
          ${d.completado ? `<span class="pill-tag" style="background:rgba(21,128,61,0.12); color:#15803D;">✓ Completado</span>` : d.garmin_scheduled ? `<span class="pill-tag" style="background:rgba(21,128,61,0.10); color:#15803D;">📅 Garmin</span>` : ""}
        </div>
        <div style="font-weight:800; font-size:1rem; color:var(--on-surface); margin-top:4px;">${d.titulo}</div>
        <div class="body-xs" style="margin-top:2px;">${distInfo}${d.zona_objetivo ? ` • ${d.zona_objetivo}` : ""} — ${d.detalle}</div>
      </div>
      <button type="button" class="strava-chip-btn" style="padding:4px 9px; font-size:0.74rem;" onclick="toggleHomeWeekDay(${idx})" aria-label="Cerrar">✕</button>
    </div>
    ${preview ? `<div class="body-xs" style="padding:7px 10px; background:#F4F4F6; border-radius:10px; color:var(--text-primary);">${preview}</div>` : ""}
    ${!isRest ? `
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button type="button" class="btn btn-primary" style="padding:8px 14px; font-size:0.82rem;" onclick="startPlannedWorkout(${idx})">Ver desglose / Iniciar</button>
        <button type="button" class="btn btn-ghost" style="padding:8px 12px; font-size:0.82rem;" onclick="sendPlannedDayToGarmin(${idx})">⌚ Enviar a Garmin</button>
      </div>
    ` : ""}
  `;
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
  if (window.AaronCharts) {
    const goalsCardEl = document.getElementById("training-goals-card");
    if (goalsCardEl) window.AaronCharts.animate(goalsCardEl);
  }

  // Populate Stride 10 · Progress, history & profile cards in Objetivos Semanales
  const elTotKm = document.getElementById("goals-total-km");
  const elTgtKm = document.getElementById("goals-target-km");
  const elOverallBadge = document.getElementById("goals-overall-badge");
  const elHeroRun = document.getElementById("goals-hero-run");
  const elHeroBike = document.getElementById("goals-hero-bike");
  const elHeroStr = document.getElementById("goals-hero-str");
  const elAvgPace = document.getElementById("goals-avg-pace");
  const elCompPct = document.getElementById("goals-compliance-pct");
  const compPct = plan.weekly_compliance ? Number(plan.weekly_compliance.overall_pct || 0) : 0;

  if (elTotKm) elTotKm.textContent = (pRun + pBike).toFixed(1);
  if (elTgtKm) elTgtKm.textContent = `/ ${(gRun + gBike).toFixed(0)} km obj.`;
  if (elOverallBadge) elOverallBadge.textContent = `${compPct}%`;
  if (elHeroRun) elHeroRun.textContent = `${pRun.toFixed(1)} km`;
  if (elHeroBike) elHeroBike.textContent = `${pBike.toFixed(1)} km`;
  if (elHeroStr) elHeroStr.textContent = `${pStr} ses`;
  if (elAvgPace) elAvgPace.textContent = (plan.metrics && plan.metrics.ritmo_medio_garmin) ? plan.metrics.ritmo_medio_garmin : "—";
  if (elCompPct) elCompPct.textContent = `${compPct}%`;

  const elWeeklySpark = document.getElementById("goals-weekly-spark-svg");
  if (elWeeklySpark && Array.isArray(plan.dias) && plan.dias.length > 0) {
    const dayVals = plan.dias.map(d => Number(d.distancia_km || (d.duracion_min ? d.duracion_min * 0.15 : 0)));
    const maxD = Math.max(...dayVals, 0);
    if (maxD <= 0) {
      elWeeklySpark.innerHTML = `<div class="body-xs" style="color:rgba(255,255,255,0.65); padding-top:10px;">Sin volumen planificado esta semana.</div>`;
    } else {
      const bars = plan.dias.map((d, i) => {
        const v = dayVals[i];
        const h = Math.max(4, Math.round((v / maxD) * 34));
        const x = 6 + i * 45;
        const y = 40 - h;
        const fill = d.completado ? "#EE5A2B" : "rgba(255,255,255,0.28)";
        return `<rect x="${x}" y="${y}" width="32" height="${h}" rx="4" fill="${fill}"><title>${d.dia}: ${d.distancia_km || 0} km</title></rect>`;
      }).join("");
      elWeeklySpark.innerHTML = `<svg viewBox="0 0 320 44" preserveAspectRatio="none" style="width:100%; height:44px;">${bars}</svg>`;
      if (window.AaronCharts) window.AaronCharts.animate(elWeeklySpark);
    }
  }

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
  const raceBanner = document.getElementById("training-race-countdown-banner");
  if (race && race.activo) {
    const rName = document.getElementById("training-race-name");
    const rDate = document.getElementById("training-race-date");
    const rDist = document.getElementById("training-race-dist");
    if (rName) rName.value = race.nombre || "";
    if (rDate) rDate.value = (race.fecha || "").slice(0, 10);
    if (rDist) rDist.value = race.distancia_km || 10;
    if (raceBanner && race.fecha) {
      const daysLeft = Math.max(0, Math.ceil((new Date(race.fecha) - new Date()) / 86400000));
      const weeksLeft = Math.max(1, Math.ceil(daysLeft / 7));
      raceBanner.style.display = "flex";
      raceBanner.innerHTML = `
        <span class="stride-stitch-race-kicker">${(race.nombre || "CARRERA OBJETIVO").toUpperCase()} · ${race.distancia_km || 10} KM</span>
        <h2 class="stride-stitch-race-title">Carrera objetivo en ${weeksLeft} ${weeksLeft === 1 ? "semana" : "semanas"}</h2>
        <span class="stride-stitch-race-sub">${(race.fecha || "").slice(0, 10)} · Faltan ${daysLeft} días · Progresión adaptada</span>
      `;
    }
  } else if (raceBanner) {
    raceBanner.style.display = "none";
  }

  const volWrap = document.getElementById("training-volume-chart-wrap");
  if (volWrap) {
    const diasList = Array.isArray(plan.dias) && plan.dias.length > 0 ? plan.dias : [];
    if (diasList.length === 0) {
      volWrap.style.display = "none";
    } else {
      const W = 350, H = 96, padT = 14, padB = 10;
      const plotH = H - padT - padB;
      let cumPlan = 0;
      const pts = diasList.map((d, i) => {
        cumPlan += Number(d.distancia_km || (d.duracion_min ? d.duracion_min * 0.12 : 0));
        return { d, i, cum: cumPlan };
      });
      const maxVal = Math.max(gRun, cumPlan, pRun, 10);
      const todayIdx = Math.max(0, pts.findIndex(p => p.d.es_hoy));
      const splitIdx = todayIdx >= 0 ? todayIdx : Math.floor(pts.length / 2);

      const coords = pts.map((p, i) => {
        const x = (i / Math.max(1, pts.length - 1)) * W;
        const y = padT + plotH - (p.cum / maxVal) * plotH;
        return { x, y, ...p };
      });

      const doneCoords = coords.slice(0, splitIdx + 1);
      const futCoords = coords.slice(splitIdx);
      const doneLine = doneCoords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
      const doneArea = doneCoords.length > 0
        ? `${doneLine} L${doneCoords[doneCoords.length - 1].x.toFixed(1)},${H} L0,${H} Z`
        : "";
      const futLine = futCoords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
      const futArea = futCoords.length > 1
        ? `${futLine} L${W},${H} L${futCoords[0].x.toFixed(1)},${H} Z`
        : "";

      const nowPt = coords[splitIdx] || coords[0];
      const nowLeftPct = Math.min(82, Math.max(18, (nowPt.x / W) * 100));

      volWrap.style.display = "block";
      volWrap.innerHTML = `
        <div class="stride-volume-header-pills">
          <span class="stride-volume-now-pill-inline">Hoy · ${pRun.toFixed(1)} km</span>
          <span class="stride-volume-target-lbl tabular-num">Obj. ${gRun.toFixed(0)} km</span>
        </div>
        <div class="stride-volume-chart-box">
          <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%; height:100%; display:block;">
            <defs>
              <pattern id="stride-diag-stripe" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="8" stroke="#E7E5E4" stroke-width="3"></line>
              </pattern>
            </defs>
            ${doneArea ? `<path d="${doneArea}" fill="#171716"></path>` : ""}
            ${futArea ? `<path d="${futArea}" fill="url(#stride-diag-stripe)"></path>` : ""}
            ${doneLine ? `<path d="${doneLine}" fill="none" stroke="#171716" stroke-width="2" vector-effect="non-scaling-stroke"></path>` : ""}
            ${futLine ? `<path d="${futLine}" fill="none" stroke="#A8A29E" stroke-dasharray="3 3" stroke-width="1.5" vector-effect="non-scaling-stroke"></path>` : ""}
          </svg>
          <span class="stride-volume-now-dot" style="left:${nowLeftPct.toFixed(1)}%; top:${((nowPt.y / H) * 100).toFixed(1)}%;"></span>
        </div>
        <div class="stride-volume-days-axis">
          ${diasList.map((d, i) => `<span class="${i === splitIdx ? "is-today" : ""}">${(d.dia || "").slice(0, 1).toUpperCase()}</span>`).join("")}
        </div>
      `;
      if (window.AaronCharts) window.AaronCharts.animate(volWrap);
    }
  }

  const calEl = document.getElementById("training-weekly-calendar");
  if (!calEl || !Array.isArray(plan.dias)) return;

  const authNotice = plan.garmin_write_ready === false
    ? `<div style="padding:10px 12px; border-radius:12px; background:#FFF2EB; border:1px solid rgba(255,85,0,0.28); display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">
         <span class="body-xs" style="color:var(--on-surface);"><strong>Garmin Calendario:</strong> Tu conexión actual (<code>GCDC_</code>) es solo lectura. Vincula tu email y contraseña de Garmin Connect para que las sesiones se envíen solas al calendario y al reloj.</span>
         <a href="/perfil" class="btn btn-primary" style="padding:6px 12px; font-size:0.76rem; text-decoration:none;" onclick="navigateTo(event, '/perfil', 'tab-profile')">Vincular en Perfil</a>
       </div>`
    : "";

  const totalActiveDays = plan.dias.filter(d => d.tipo !== "Descanso" && !d.cancelado).length;
  const doneDaysCount = plan.dias.filter(d => d.completado && d.tipo !== "Descanso").length;
  const weekHeroHtml = `
    <div class="stride-plan-week-hero">
      <span class="stride-week-badge">${plan.semana_num || "S"}</span>
      <div class="stride-week-meta">
        <span class="stride-week-title">${planLabels[planType] || "BASE / MANTENIMIENTO"} · Esta semana</span>
        <span class="stride-week-sub">${plan.semana_inicio || ""} – ${plan.semana_fin || ""} · ${doneDaysCount} de ${totalActiveDays} sesiones completadas</span>
      </div>
      ${plan.weekly_compliance ? `<span class="pill-tag" style="background:rgba(255,255,255,0.12); color:#FFFFFF; border:none;">${plan.weekly_compliance.overall_pct}%</span>` : ""}
    </div>`;

  calEl.innerHTML = authNotice + weekHeroHtml + plan.dias.map((d, idx) => {
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
    const dayAbbr = (d.dia || "").slice(0, 3).toUpperCase();
    const dayNum = (d.fecha || "").slice(8, 10) || "—";

    let breakdownPreview = "";
    if (Array.isArray(d.phases) && d.phases.length > 0) {
      breakdownPreview = d.phases.map(p => {
        const mins = Math.max(1, Math.round((p.duration_seconds || 0) / 60));
        return `${p.name} (${mins}')`;
      }).join(" → ");
    } else if (Array.isArray(d.ejercicios) && d.ejercicios.length > 0) {
      breakdownPreview = d.ejercicios.map(ex => `${ex.nombre} ${ex.series}×${ex.repeticiones}`).join(" · ");
    }

    const estadoDia = d.estado_dia || (d.completado ? "completado" : isCancelled ? "cancelado" : "pendiente");
    const isNotDone = estadoDia === "no_realizado";
    const isSubstituted = estadoDia === "sustituido";
    const isExtra = estadoDia === "extra";
    const stateCardCls = estadoDia === "completado"
      ? "state-done"
      : (isSubstituted || isExtra)
        ? "state-other"
        : (isNotDone || isCancelled)
          ? "state-missed"
          : "state-pending";
    const dotCls = estadoDia === "completado"
      ? "is-done"
      : (isSubstituted || isExtra)
        ? "is-other"
        : (isNotDone || isCancelled)
          ? "is-missed"
          : (d.es_hoy && !isCancelled ? "is-today" : "");
    const reales = Array.isArray(d.actividades_reales) ? d.actividades_reales : [];
    const realChipHtml = (isSubstituted || isExtra) && reales.length > 0
      ? `<div style="margin-top:6px; padding:6px 10px; border-radius:10px; background:${isExtra ? "var(--stitch-accent-soft)" : "var(--stitch-info-soft)"}; color:${isExtra ? "var(--stitch-accent-hover)" : "var(--stitch-info)"}; font-size:0.78rem; font-weight:600;">
           Actividad real: ${reales.map(r => `${r.nombre} (${r.tipo}${r.distancia_km > 0 ? ` · ${r.distancia_km} km` : ""}${r.duracion_min > 0 ? ` · ${r.duracion_min} min` : ""})`).join(" + ")}
         </div>`
      : "";

    let statusBadgeHtml = `<span class="body-xs tabular-num">${distInfo}${d.zona_objetivo ? ` • ${d.zona_objetivo}` : ""}</span>`;
    if (estadoDia === "completado") {
      statusBadgeHtml = `<span class="stitch-status-badge is-done">✓ Completado</span>`;
    } else if (isSubstituted) {
      statusBadgeHtml = `<span class="stitch-status-badge is-other">Realizado · Otro deporte</span>`;
    } else if (isExtra) {
      statusBadgeHtml = `<span class="stitch-status-badge is-extra">Extra · Fuera de plan</span>`;
    } else if (isNotDone) {
      statusBadgeHtml = `<span class="stitch-status-badge is-missed">No realizado · 0 carga</span>`;
    } else if (isCancelled) {
      statusBadgeHtml = `<span class="stitch-status-badge is-missed">Cancelado</span>`;
    } else if (d.garmin_scheduled) {
      statusBadgeHtml = `<span class="stitch-status-badge is-pending">Pendiente · 📅 Garmin</span>`;
    } else if (!isRest) {
      statusBadgeHtml = `<span class="stitch-status-badge is-pending">Pendiente</span>`;
    }

    return `
      <div class="training-day-card ${stateCardCls} ${d.es_hoy && !isCancelled ? "is-today" : ""}">
        <div class="stride-day-row-main">
          <div class="stride-day-datecol">
            <span class="stride-day-abbr">${dayAbbr}</span>
            <span class="stride-day-num-col">${dayNum}</span>
          </div>
          <div class="stride-day-nodecol">
            <span class="stride-timeline-dot ${dotCls}">${estadoDia === "completado" ? "✓" : (isSubstituted || isExtra) ? "~" : isNotDone ? "–" : ""}</span>
          </div>
          <div class="training-day-info" style="${!isRest && !isCancelled ? "cursor:pointer;" : ""}" ${!isRest && !isCancelled ? `onclick="startPlannedWorkout(${idx})"` : ""}>
            <div class="training-day-head">
              <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                <span class="training-day-title" style="font-weight:600; font-size:15px; color:var(--on-surface);">${d.titulo}</span>
                ${d.es_hoy && !isCancelled ? `<span class="pill-tag orange">HOY</span>` : ""}
                <span class="pill-tag ${badgeCls}">${d.tipo}</span>
                ${d.opcional ? `<span class="pill-tag">OPCIONAL</span>` : ""}
              </div>
              ${statusBadgeHtml}
            </div>
            <div class="body-xs" style="margin-top:2px; color:var(--text-secondary);">${d.detalle}</div>
            ${realChipHtml}
            ${breakdownPreview && !isCancelled && !isNotDone ? `<div class="body-xs" style="margin-top:6px; padding:6px 10px; background:#F5F5F4; border-radius:10px; color:var(--text-primary); font-weight:500;">${breakdownPreview}</div>` : ""}
          </div>
        </div>
        ${hasActions ? `
          <div class="training-day-actions">
            ${isCancelled ? `
              <button type="button" class="btn btn-ghost" style="padding:7px 12px; font-size:0.8rem;" onclick="toggleCancelPlannedDay('${d.fecha}', false)">Reactivar</button>
            ` : `
              <button type="button" class="btn btn-primary" style="padding:7px 13px; font-size:0.8rem;" onclick="startPlannedWorkout(${idx})">Ver / Iniciar</button>
              <button type="button" class="btn btn-ghost" style="padding:7px 12px; font-size:0.8rem;" onclick="sendPlannedDayToGarmin(${idx})">⌚ Garmin</button>
              ${!d.completado ? `<button type="button" class="btn btn-ghost" style="padding:7px 10px; font-size:0.78rem; color:#B91C1C;" onclick="toggleCancelPlannedDay('${d.fecha}', true)">Cancelar</button>` : ""}
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

function closePlannedWorkoutModal() {
  const modal = document.getElementById("planned-workout-modal");
  if (modal) modal.style.display = "none";
}

function startGuidedFromPlannedDay(dayIdx) {
  if (!_latestWeeklyPlan || !_latestWeeklyPlan.dias || !_latestWeeklyPlan.dias[dayIdx]) return;
  const d = _latestWeeklyPlan.dias[dayIdx];
  const w = _buildWorkoutFromPlannedDay(d);
  state.currentWorkout = w;
  closePlannedWorkoutModal();
  if (typeof startGuidedSession === "function") {
    startGuidedSession();
  }
}

function startPlannedWorkout(dayIdx) {
  if (!_latestWeeklyPlan || !_latestWeeklyPlan.dias || !_latestWeeklyPlan.dias[dayIdx]) return;
  const d = _latestWeeklyPlan.dias[dayIdx];
  const modal = document.getElementById("planned-workout-modal");
  const body = document.getElementById("planned-modal-body");
  const kickerEl = document.getElementById("planned-modal-kicker");
  const dateEl = document.getElementById("planned-modal-date");
  if (!modal || !body) return;

  state.currentWorkout = _buildWorkoutFromPlannedDay(d);
  if (kickerEl) kickerEl.textContent = `${(d.tipo || "SESIÓN").toUpperCase()}${d.es_hoy ? " • HOY" : ""}`;
  if (dateEl) dateEl.textContent = `${d.dia} · ${d.fecha}`;

  const phases = Array.isArray(d.phases) ? d.phases : [];
  const exercises = Array.isArray(d.ejercicios) ? d.ejercicios : [];
  const totalSec = phases.reduce((acc, p) => acc + Number(p.duration_seconds || 0), 0);
  const totalMins = d.duracion_min || Math.max(1, Math.round(totalSec / 60));

  // Build proportional Stride interval bar SVG from phases
  let profileSvg = "";
  if (phases.length > 0) {
    const safeTotal = Math.max(1, totalSec);
    let xAcc = 0;
    const bars = phases.map((p) => {
      const dur = Math.max(1, Number(p.duration_seconds || 60));
      const w = (dur / safeTotal) * 336;
      const isWork = p.type === "WORK" || /interval|tempo|serie|fartlek|velocidad|ritmo|umbral/i.test(p.name || "");
      const isWarmCool = p.type === "WARMUP" || p.type === "COOLDOWN" || p.type === "REST";
      const h = isWork ? 28 : isWarmCool ? 12 : 20;
      const y = 34 - h;
      const fill = isWork ? "#FF5500" : isWarmCool ? "rgba(255,255,255,0.28)" : "rgba(255,85,0,0.65)";
      const rect = `<rect x="${xAcc.toFixed(1)}" y="${y}" width="${Math.max(3, w - 2).toFixed(1)}" height="${h}" rx="3" fill="${fill}"/>`;
      xAcc += w;
      return rect;
    }).join("");
    profileSvg = `<svg viewBox="0 0 336 36" preserveAspectRatio="none" style="width:100%; height:36px;">${bars}</svg>`;
  }

  let breakdownHtml = "";
  if (phases.length > 0) {
    breakdownHtml = `
      <h3 class="stride-section-title" style="margin:4px 0 0;">Desglose por fases (${phases.length})</h3>
      <div class="stride-steps-card">
        ${phases.map((p, i) => {
          const sec = Number(p.duration_seconds || 0);
          const m = Math.floor(sec / 60);
          const s = sec % 60;
          const isWork = p.type === "WORK" || /interval|tempo|serie|fartlek|velocidad|ritmo|umbral/i.test(p.name || "");
          const typeLbl = p.type === "WARMUP" ? "Calentamiento" : p.type === "COOLDOWN" ? "Vuelta a la calma" : p.type === "REST" ? "Recuperación" : "Bloque principal";
          return `
            <div class="stride-step-row">
              <span class="stride-step-bar ${isWork ? "work" : ""}"></span>
              <div style="flex:1; min-width:0;">
                <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                  <strong style="font-size:0.92rem; color:var(--on-surface);">${i + 1}. ${p.name}</strong>
                  ${isWork ? `<span class="stride-step-repeat-pill">CALIDAD</span>` : ""}
                </div>
                <span class="body-xs">${typeLbl}${p.target_zone ? ` · ${p.target_zone}` : ""}</span>
              </div>
              <strong class="tabular-num" style="font-size:0.9rem; color:var(--on-surface);">${m}:${String(s).padStart(2, "0")}</strong>
            </div>
          `;
        }).join("")}
      </div>
    `;
  } else if (exercises.length > 0) {
    breakdownHtml = `
      <h3 class="stride-section-title" style="margin:4px 0 0;">Desglose de ejercicios (${exercises.length})</h3>
      <div class="stride-steps-card">
        ${exercises.map((ex, i) => `
          <div class="stride-step-row">
            <span class="stride-step-bar work"></span>
            <div style="flex:1; min-width:0;">
              <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                <strong style="font-size:0.92rem; color:var(--on-surface);">${i + 1}. ${ex.nombre}</strong>
                <span class="stride-step-repeat-pill tabular-num">${ex.series} × ${ex.repeticiones}</span>
              </div>
              <span class="body-xs">${ex.target_muscle || "Full Body"} · ${ex.equipment || "Mancuernas 5 kg / Cintas"}${ex.descanso_seg ? ` · Descanso ${ex.descanso_seg}s` : ""}</span>
              ${ex.descripcion ? `<div class="body-xs" style="margin-top:3px; color:var(--text-primary);">${ex.descripcion}</div>` : ""}
            </div>
          </div>
        `).join("")}
      </div>
    `;
  } else {
    breakdownHtml = `
      <div class="glass-card" style="padding:14px;">
        <p class="body-md" style="margin:0;">${d.detalle || "Día de descanso y asimilación muscular."}</p>
      </div>
    `;
  }

  const bigMetric = d.distancia_km > 0
    ? `<span class="tabular-num" style="font-size:2.4rem; font-weight:800; line-height:1; letter-spacing:-0.04em;">${d.distancia_km}</span><span style="font-size:1rem; font-weight:500; color:rgba(255,255,255,0.72);">km</span>`
    : `<span class="tabular-num" style="font-size:2.4rem; font-weight:800; line-height:1; letter-spacing:-0.04em;">${totalMins}</span><span style="font-size:1rem; font-weight:500; color:rgba(255,255,255,0.72);">min</span>`;

  body.innerHTML = `
    <div class="stride-workout-detail-hero">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
        <span style="font-size:0.72rem; font-weight:700; letter-spacing:0.06em; color:rgba(255,255,255,0.78); display:inline-flex; align-items:center; gap:6px;">
          <span class="stride-dot-orange"></span> ${d.dia.toUpperCase()} · ${d.tipo.toUpperCase()}
        </span>
        ${d.completado
          ? `<span style="font-size:0.72rem; color:#4ADE80; font-weight:700;">✓ Completado en Garmin</span>`
          : d.garmin_scheduled
            ? `<span style="font-size:0.72rem; color:#4ADE80; font-weight:700;">📅 En Calendario Garmin</span>`
            : ""}
      </div>
      <h2 style="margin:0; font-size:1.35rem; font-weight:700; letter-spacing:-0.02em; color:#FFFFFF;">${d.titulo}</h2>
      <div style="display:flex; align-items:baseline; gap:6px;">${bigMetric}</div>
      <div class="stride-detail-pills">
        ${totalMins > 0 ? `<span class="stride-detail-pill tabular-num">${totalMins} min</span>` : ""}
        ${d.zona_objetivo ? `<span class="stride-detail-pill">${d.zona_objetivo}</span>` : ""}
        ${phases.length > 0 ? `<span class="stride-detail-pill">${phases.length} fases</span>` : ""}
        ${exercises.length > 0 ? `<span class="stride-detail-pill">${exercises.length} ejercicios</span>` : ""}
      </div>
      ${profileSvg}
    </div>

    ${breakdownHtml}

    <div style="display:flex; flex-direction:column; gap:8px; margin-top:4px;">
      ${d.tipo !== "Descanso" ? `
        <button type="button" class="btn btn-primary stride-btn-dark" style="width:100%; padding:13px;" onclick="startGuidedFromPlannedDay(${dayIdx})">
          Comenzar Entrenamiento Guiado
        </button>
        <button type="button" class="btn btn-ghost" style="width:100%; border-radius:9999px;" onclick="sendPlannedDayToGarmin(${dayIdx})">
          ⌚ Enviar a Garmin Connect
        </button>
      ` : ""}
      <button type="button" class="btn btn-ghost" style="width:100%; border-radius:9999px;" onclick="closePlannedWorkoutModal()">Cerrar</button>
    </div>
  `;

  modal.style.display = "flex";
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

async function syncWeeklyPlanToGarmin() {
  const btn = document.getElementById("btn-sync-week-garmin");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Enviando a Garmin...";
  }
  try {
    const res = await fetch("/api/training/sync-garmin-calendar", { method: "POST" });
    const data = await res.json();
    if (data.plan) renderWeeklyPlan(data.plan);
    showSuccessBanner(data.message || "Sincronización completada.");
  } catch (e) {
    showSuccessBanner("❌ Error conectando con Garmin Connect.");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "📅 Enviar semana a Garmin";
    }
  }
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
  "/analisis": "tab-metrics",
  "/entrenamientos": "tab-training",
  "/plan": "tab-training",
  "/historial": "tab-history",
  "/perfil": "tab-profile"
};

const TAB_TO_ROUTE = {
  "tab-dashboard": "/inicio",
  "tab-metrics": "/analisis",
  "tab-training": "/plan",
  "tab-history": "/historial",
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
    if (!_summitLoadedOnce) {
      _summitLoadedOnce = true;
      loadSummitAnalytics();
    }
    loadWellnessHistory(state.wellnessHistoryDays || 28);
    if (Array.isArray(state.history) && state.history.length > 0) {
      renderMetricsTab(state.history, state.lastCoachText || "");
    } else {
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

  if (elMetricsHistoryList && !elMetricsHistoryList.dataset.feedLoaded) {
    if (!history || history.length === 0) {
      elMetricsHistoryList.innerHTML = `<p class="body-sm-muted" style="text-align:center; padding: 20px 0;">No hay actividades sincronizadas en Garmin Connect todavía.</p>`;
      return;
    }

    let html = "";
    history.slice(0, 5).forEach(act => {
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
  state.garminConnected = !!connected;
  const dashDisBanner = document.getElementById("wellness-dash-disconnected-banner");
  if (dashDisBanner) {
    dashDisBanner.style.display = connected ? "none" : "flex";
  }

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
      showSuccessBanner("✅ ¡Garmin Connect vinculado! Programando semana en tu calendario...");
      await checkGarminStatus();
      await initApp();
      await syncWeeklyPlanToGarmin();
      await loadWeeklyPlanAndRaceGoal();
    } else {
      showSuccessBanner(`⚠️ ${data.message || "Error al conectar con Garmin."}`);
    }
  } catch (e) {
    showSuccessBanner("⚠️ Error de red conectando con Garmin.");
  } finally {
    if (btn) btn.textContent = "Conectar Garmin Connect";
  }
}

async function importGarminTokens() {
  const inp = document.getElementById("garmin-token-import-input");
  const tokens = inp ? inp.value.trim() : "";
  if (!tokens) {
    showSuccessBanner("⚠️ Pega el token OAuth generado en tu PC.");
    return;
  }
  try {
    const res = await fetch("/api/garmin/import-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokens })
    });
    const data = await res.json();
    if (data.status === "connected") {
      showSuccessBanner("✅ ¡Tokens OAuth de Garmin importados! Sincronizando calendario...");
      await checkGarminStatus();
      await initApp();
      await syncWeeklyPlanToGarmin();
      await loadWeeklyPlanAndRaceGoal();
    } else {
      showSuccessBanner(`⚠️ ${data.message || "Error importando tokens."}`);
    }
  } catch (e) {
    showSuccessBanner("⚠️ Error de red importando tokens de Garmin.");
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
      showSuccessBanner("✅ ¡Garmin Connect verificado! Programando semana en tu calendario...");
      await checkGarminStatus();
      await initApp();
      await syncWeeklyPlanToGarmin();
      await loadWeeklyPlanAndRaceGoal();
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
    showSuccessBanner(`✅ Sincronizadas ${data.activities_count} actividades y telemetría de Garmin.`);
    _summitLoadedOnce = false;
    await Promise.all([
      loadDashboardSummary(true),
      loadActivitiesFeed(),
      initApp(),
    ]);
    if (state.wellnessHistoryDays && _lastTabId === "tab-metrics") {
      await loadWellnessHistory(state.wellnessHistoryDays, true);
    }
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

    // 1. Render Stride Weekly Calendar Strip (L M X J V S D) with inline expandable day panel
    const weekStripEl = document.getElementById("stride-week-strip");
    if (weekStripEl) {
      const dayLetters = ["L", "M", "X", "J", "V", "S", "D"];
      weekStripEl.innerHTML = plan.dias.map((d, idx) => {
        const letter = dayLetters[idx] || (d.dia || "").slice(0, 1).toUpperCase();
        const dayNum = (d.fecha || "").split("-")[2] ? parseInt(d.fecha.split("-")[2], 10) : (idx + 1);
        const cls = [
          "stride-day-col",
          d.es_hoy ? "is-today" : "",
          _selectedHomeWeekIdx === idx ? "is-selected" : "",
          d.completado ? "is-done" : (d.tipo !== "Descanso" ? "is-planned" : "")
        ].filter(Boolean).join(" ");
        return `
          <button type="button" class="${cls}" onclick="toggleHomeWeekDay(${idx})" aria-label="${d.dia} ${dayNum}: ${d.titulo}">
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
      const heroCard = document.getElementById("stride-hero-card");
      if (heroCard) {
        const waveSvg = heroCard.querySelector(".stride-hero-wave-svg");
        if (waveSvg && Array.isArray(todayDay.phases) && todayDay.phases.length > 0) {
          const totalSec = todayDay.phases.reduce((s, p) => s + Math.max(30, Number(p.duration_seconds || 60)), 0) || 1;
          let curX = 0;
          const pts = ["M0 30"];
          todayDay.phases.forEach((p) => {
            const w = (Math.max(30, Number(p.duration_seconds || 60)) / totalSec) * 340;
            const isWork = p.type === "WORK" || /interval|tempo|serie|fartlek|velocidad|ritmo/i.test(p.name || "");
            const isWarmCool = p.type === "WARMUP" || p.type === "COOLDOWN";
            const y = isWork ? 8 : isWarmCool ? 28 : 22;
            const xEnd = Math.min(340, curX + w);
            pts.push(`L${(curX + 3).toFixed(1)} ${y} L${Math.max(curX + 3, xEnd - 3).toFixed(1)} ${y}`);
            curX = xEnd;
          });
          pts.push("L340 30");
          waveSvg.innerHTML = `<path d="${pts.join(" ")}" fill="none" stroke="#EE5A2B" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" opacity="0.88"/>`;
        }
        if (window.AaronCharts) window.AaronCharts.animate(heroCard);
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
          const isFuerzaNext = d.tipo === "Fuerza";
          const isBiciNext = d.tipo === "Ciclismo";
          const strokeCol = isFuerzaNext ? "#111113" : isBiciNext ? "#0066B3" : "#EE5A2B";
          const miniIcon = isFuerzaNext
            ? `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${strokeCol}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6.5 6.5 11 11"/><path d="m21 21-1-1"/><path d="m3 3 1 1"/><path d="m18 22 4-4"/><path d="m2 6 4-4"/></svg>`
            : isBiciNext
            ? `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${strokeCol}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/></svg>`
            : `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${strokeCol}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="15" cy="4" r="2"/><path d="M10.5 9.5 7 11.5l1 3.5"/><path d="m14 9.5 3.5 2.5 2.5-.5"/><path d="m13.5 9.5-2.5 5 3.5 2.5 1.5 4.5"/><path d="m11 14.5-4 2.5-2 3.5"/></svg>`;
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
    renderSummitExplorations(_summitData);
    renderPersonalRecords(_summitData.personal_records || []);
    renderOfficialRecords(_summitData.official_records || []);
    loadSegmentsList();
    loadAnalyticsOverviewAndAI();
  } catch (e) {
    console.warn("Summit analytics load failed:", e);
  }
}

function renderSummitExplorations(summit) {
  if (!summit) return;
  const days = Array.isArray(summit.training_log) ? summit.training_log : [];
  const last14 = days.slice(-14);
  const prev14 = days.slice(-28, -14);

  let km14 = 0, kmPrev14 = 0;
  let minRun = 0, minBike = 0, minStr = 0;

  last14.forEach(d => {
    (d.entries || []).forEach(e => {
      km14 += Number(e.km || 0);
      if (e.sport_type === "Carrera") minRun += Number(e.min || 0);
      else if (e.sport_type === "Ciclismo") minBike += Number(e.min || 0);
      else if (e.sport_type === "Fuerza") minStr += Number(e.min || 0);
    });
  });
  prev14.forEach(d => {
    (d.entries || []).forEach(e => { kmPrev14 += Number(e.km || 0); });
  });

  const elVolKm = document.getElementById("summit-exp-vol-km");
  const elVolDelta = document.getElementById("summit-exp-vol-delta");
  const elVolSvg = document.getElementById("summit-exp-vol-svg");
  if (elVolKm) elVolKm.textContent = km14.toFixed(1);
  if (elVolDelta) {
    if (kmPrev14 > 0) {
      const pct = Math.round(((km14 - kmPrev14) / kmPrev14) * 100);
      elVolDelta.textContent = `${pct >= 0 ? "+" : ""}${pct}%`;
    } else {
      elVolDelta.textContent = "14 días";
    }
  }
  if (elVolSvg) {
    if (km14 <= 0 || last14.length < 2) {
      elVolSvg.innerHTML = `<div class="body-xs" style="color:rgba(255,255,255,0.65); padding-top:12px;">Sin datos de volumen en los últimos 14 días.</div>`;
    } else {
      const dayKms = last14.map(d => (d.entries || []).reduce((s, e) => s + Number(e.km || 0), 0));
      const maxK = Math.max(0.5, ...dayKms);
      const W = 280, H = 48, pad = 4;
      const pts = dayKms.map((v, i) => {
        const x = pad + (i / (dayKms.length - 1)) * (W - pad * 2);
        const y = H - pad - (v / maxK) * (H - pad * 2);
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(" ");
      const area = `${pts} L${W - pad},${H - pad} L${pad},${H - pad} Z`;
      elVolSvg.innerHTML = `
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%; height:100%;">
          <defs>
            <linearGradient id="expDarkGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#EE5A2B" stop-opacity="0.45"/>
              <stop offset="100%" stop-color="#EE5A2B" stop-opacity="0.02"/>
            </linearGradient>
          </defs>
          <path d="${area}" fill="url(#expDarkGrad)"/>
          <path d="${pts}" fill="none" stroke="#EE5A2B" stroke-width="2.2" stroke-linecap="round"/>
        </svg>
      `;
    }
  }

  // Effort breakdown (Carrera / Ciclismo / Fuerza)
  const totalMin = Math.max(1, minRun + minBike + minStr);
  const pRun = Math.round((minRun / totalMin) * 100);
  const pBike = Math.round((minBike / totalMin) * 100);
  const pStr = Math.max(0, 100 - pRun - pBike);
  const elEffTot = document.getElementById("summit-exp-eff-total");
  const elEffBar = document.getElementById("summit-exp-eff-bar");
  const elEffLeg = document.getElementById("summit-exp-eff-legend");
  if (elEffTot) elEffTot.textContent = `${Math.round(minRun + minBike + minStr)} min`;
  if (elEffBar) {
    elEffBar.innerHTML = (minRun + minBike + minStr) > 0
      ? `
        ${pRun > 0 ? `<div style="width:${pRun}%; background:#15803D;"></div>` : ""}
        ${pBike > 0 ? `<div style="width:${pBike}%; background:#0077CC;"></div>` : ""}
        ${pStr > 0 ? `<div style="width:${pStr}%; background:#EE5A2B;"></div>` : ""}
      `
      : `<div style="width:100%; background:#ECECEA;"></div>`;
  }
  if (elEffLeg) {
    elEffLeg.innerHTML = `
      <span><strong style="color:#15803D;">●</strong> Carrera ${pRun}%</span>
      <span><strong style="color:#0077CC;">●</strong> Ciclismo ${pBike}%</span>
      <span><strong style="color:#C83E00;">●</strong> Fuerza ${pStr}%</span>
    `;
  }

  // Weekly ring from _latestWeeklyPlan
  const plan = _latestWeeklyPlan;
  const elRingArc = document.getElementById("summit-exp-ring-arc");
  const elRingPct = document.getElementById("summit-exp-ring-pct");
  const elRingRem = document.getElementById("summit-exp-ring-rem");
  const elRingSub = document.getElementById("summit-exp-ring-sub");
  const elRingSt = document.getElementById("summit-exp-ring-status");
  if (plan && plan.weekly_compliance) {
    const pct = Math.min(100, Math.max(0, Number(plan.weekly_compliance.overall_pct || 0)));
    const circ = 326.7;
    if (elRingArc) elRingArc.style.strokeDashoffset = (circ - (pct / 100) * circ).toFixed(1);
    if (elRingPct) elRingPct.textContent = `${pct}%`;
    const gRun = Number((plan.goals && plan.goals.goal_run_km) || plan.objetivo_km_carrera || 20);
    const pRunKm = Number((plan.week_progress && plan.week_progress.run_km) || 0);
    const remKm = Math.max(0, gRun - pRunKm).toFixed(1);
    if (elRingRem) elRingRem.textContent = remKm > 0 ? `Faltan ${remKm} km` : "Objetivo cumplido";
    if (elRingSub) elRingSub.textContent = `${pRunKm.toFixed(1)} / ${gRun} km carrera`;
    if (elRingSt) elRingSt.textContent = plan.plan_type ? plan.plan_type.toUpperCase() : "ACTIVO";
  }
  if (window.AaronCharts) {
    const expRow = document.getElementById("summit-explorations-row");
    if (expRow) window.AaronCharts.animate(expRow);
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
  const hasAny = days.some(item => {
    const f = sportFilter === "Todo" ? (item.entries || []) : (item.entries || []).filter(e => e.sport_type === sportFilter);
    return f.some(e => (e.min || 0) > 0);
  });
  if (!days.length || !hasAny) {
    grid.innerHTML = `<div class="body-sm-muted" style="padding:18px 8px; text-align:center;">Sin datos de entrenamientos en las últimas 12 semanas${sportFilter !== "Todo" ? ` (${sportFilter})` : ""}.</div>`;
    return;
  }
  const todayIso = new Date().toISOString().slice(0, 10);
  const months = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

  let html = `
    <div class="summit-calendar-grid">
      <div class="summit-cal-head">
        <span>SEM</span>
        <span>L</span><span>M</span><span>X</span><span>J</span><span>V</span><span>S</span><span>D</span>
      </div>
  `;

  for (let w = 0; w < 12; w++) {
    const weekStart = days[w * 7];
    let weekLbl = `S${w + 1}`;
    if (weekStart && weekStart.date) {
      const parts = weekStart.date.split("-");
      const mIdx = parseInt(parts[1], 10) - 1;
      weekLbl = `${parseInt(parts[2], 10)} ${months[mIdx] || ""}`;
    }

    html += `<div class="summit-cal-row"><span class="summit-cal-week-lbl">${weekLbl}</span>`;
    for (let d = 0; d < 7; d++) {
      const item = days[w * 7 + d];
      if (!item) { html += `<div class="summit-cal-cell"></div>`; continue; }
      const filtered = sportFilter === "Todo"
        ? item.entries
        : item.entries.filter(e => e.sport_type === sportFilter);
      const totalMin = Math.round(filtered.reduce((s, e) => s + (e.min || 0), 0));
      const mainSport = filtered[0]?.sport_type || "";
      const color = mainSport === "Carrera" ? "#15803D" : mainSport === "Ciclismo" ? "#0077CC" : mainSport === "Fuerza" ? "#C83E00" : "transparent";
      const dayNum = parseInt((item.date || "").split("-")[2] || "0", 10) || "";
      const isToday = item.date === todayIso;

      html += `
        <div class="summit-cal-cell ${totalMin > 0 ? "has-act" : ""} ${isToday ? "is-today" : ""}" title="${item.date}: ${totalMin} min">
          <span class="summit-cal-daynum">${dayNum}</span>
          ${totalMin > 0 ? `<span class="summit-cal-badge" style="background:${color};">${totalMin}'</span>` : ""}
        </div>
      `;
    }
    html += `</div>`;
  }
  html += `</div>`;
  grid.innerHTML = html;
  if (window.AaronCharts) window.AaronCharts.animate(grid, { hash: sportFilter });
}

function renderFitnessFreshnessChart(curve) {
  const wrap = document.getElementById("summit-fitness-svg-wrap");
  const summaryEl = document.getElementById("fitness-plain-summary");
  const tooltipEl = document.getElementById("fitness-tooltip");
  if (!wrap) return;

  const hasData = Array.isArray(curve) && curve.length >= 2 && curve.some(p => p.ctl > 0 || p.atl > 0);
  if (!hasData) {
    wrap.innerHTML = `<div style="height:100%; display:flex; align-items:center; justify-content:center;" class="body-sm-muted">Sin datos de carga (CTL / ATL / TSB) en los últimos 90 días.</div>`;
    if (summaryEl) summaryEl.innerHTML = "";
    return;
  }

  const isDesktop = typeof window !== "undefined" && window.innerWidth >= 1024;
  const W = isDesktop ? 960 : 480;
  const H = isDesktop ? 210 : 175;
  const padL = 46, padR = 16, padT = 18, padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const allVals = curve.flatMap(p => [p.ctl, p.atl, p.tsb]);
  const minV = Math.min(...allVals, -10);
  const maxV = Math.max(...allVals, 20);
  const range = (maxV - minV) || 1;

  const toPath = (key) => curve.map((pt, i) => {
    const x = padL + (i / Math.max(1, curve.length - 1)) * plotW;
    const y = padT + plotH - ((pt[key] - minV) / range) * plotH;
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");

  const zeroY = padT + plotH - ((0 - minV) / range) * plotH;
  const last = curve[curve.length - 1];
  const midPt = curve[Math.floor((curve.length - 1) / 2)];
  const fmtD = (iso) => (iso || "").slice(5).split("-").reverse().join("/");

  const ctlPath = toPath('ctl');
  const ctlArea = ctlPath
    ? `${ctlPath} L${(padL + plotW).toFixed(1)},${(padT + plotH).toFixed(1)} L${padL.toFixed(1)},${(padT + plotH).toFixed(1)} Z`
    : "";

  wrap.innerHTML = `
    <svg id="fitness-svg-el" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" style="width:100%; height:100%; cursor:crosshair; display:block; background:var(--surface);">
      <defs>
        <linearGradient id="strideCtlAreaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--curve-stroke-accent)" stop-opacity="0.28"/>
          <stop offset="100%" stop-color="var(--curve-stroke-accent)" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <line x1="${padL}" y1="${padT}" x2="${W - padR}" y2="${padT}" stroke="var(--curve-grid-stroke)" stroke-width="1"/>
      <line x1="${padL}" y1="${zeroY.toFixed(1)}" x2="${W - padR}" y2="${zeroY.toFixed(1)}" stroke="var(--border-strong)" stroke-width="1" stroke-dasharray="4 3"/>
      <line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="var(--curve-grid-stroke)" stroke-width="1.5"/>
      <text x="${padL - 6}" y="${padT + 4}" text-anchor="end" font-size="11" fill="var(--text-muted)">${Math.round(maxV)} pts</text>
      <text x="${padL - 6}" y="${zeroY + 3}" text-anchor="end" font-size="11" fill="var(--text-muted)">0</text>
      <text x="${padL - 6}" y="${padT + plotH}" text-anchor="end" font-size="11" fill="var(--text-muted)">${Math.round(minV)}</text>
      <text x="${padL}" y="${H - 6}" text-anchor="start" font-size="11" fill="var(--text-muted)">${fmtD(curve[0].date) || "-90d"}</text>
      <text x="${padL + plotW / 2}" y="${H - 6}" text-anchor="middle" font-size="11" fill="var(--text-muted)">${fmtD(midPt.date) || "-45d"}</text>
      <text x="${W - padR}" y="${H - 6}" text-anchor="end" font-size="11" fill="var(--text-muted)">${fmtD(last.date) || "Hoy"}</text>
      ${ctlArea ? `<path d="${ctlArea}" fill="url(#strideCtlAreaGrad)"/>` : ""}
      <path d="${toPath('atl')}" fill="none" stroke="var(--curve-stroke-dark)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>
      <path d="${ctlPath}" fill="none" stroke="var(--curve-stroke-accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="${toPath('tsb')}" fill="none" stroke="var(--text-secondary)" stroke-width="1.8" stroke-linecap="round" stroke-dasharray="3 2"/>
      <line id="fitness-crosshair" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" stroke="var(--surface-dark)" stroke-width="1.2" stroke-dasharray="3 2" style="display:none;"/>
      <circle id="fitness-dot-ctl" cx="0" cy="0" r="4" fill="var(--accent-orange)" stroke="var(--surface)" stroke-width="2" style="display:none;"/>
    </svg>
  `;
  if (window.AaronCharts) window.AaronCharts.animate(wrap, { pointCount: curve.length });

  const svgEl = document.getElementById("fitness-svg-el");
  const crosshair = document.getElementById("fitness-crosshair");
  const dotCtl = document.getElementById("fitness-dot-ctl");
  if (svgEl) {
    const scrubFitness = (clientX) => {
      const rect = svgEl.getBoundingClientRect();
      if (!rect.width) return;
      const svgX = ((clientX - rect.left) / rect.width) * W;
      const clampedX = Math.max(padL, Math.min(padL + plotW, svgX));
      const frac = (clampedX - padL) / plotW;
      const idx = Math.min(curve.length - 1, Math.max(0, Math.round(frac * (curve.length - 1))));
      const pt = curve[idx];
      const ptX = padL + (idx / Math.max(1, curve.length - 1)) * plotW;
      const ptY = padT + plotH - ((pt.ctl - minV) / range) * plotH;

      if (crosshair) {
        crosshair.setAttribute("x1", ptX.toFixed(1));
        crosshair.setAttribute("x2", ptX.toFixed(1));
        crosshair.style.display = "block";
      }
      if (dotCtl) {
        dotCtl.setAttribute("cx", ptX.toFixed(1));
        dotCtl.setAttribute("cy", ptY.toFixed(1));
        dotCtl.style.display = "block";
      }
      if (tooltipEl) {
        tooltipEl.innerHTML = `
          <span style="font-weight:700;">${pt.date || ""}</span> ·
          <span style="color:#60A5FA;">CTL ${pt.ctl}</span> ·
          <span style="color:#FF7A33;">ATL ${pt.atl}</span> ·
          <span style="color:#4ADE80;">TSB ${pt.tsb > 0 ? `+${pt.tsb}` : pt.tsb}</span>
        `;
        tooltipEl.style.display = "flex";
      }
    };
    svgEl.addEventListener("mousemove", (e) => scrubFitness(e.clientX));
    svgEl.addEventListener("touchstart", (e) => { if (e.touches && e.touches[0]) scrubFitness(e.touches[0].clientX); }, { passive: true });
    svgEl.addEventListener("touchmove", (e) => { if (e.touches && e.touches[0]) scrubFitness(e.touches[0].clientX); }, { passive: true });
    svgEl.addEventListener("mouseleave", () => {
      if (crosshair) crosshair.style.display = "none";
      if (dotCtl) dotCtl.style.display = "none";
      if (tooltipEl) tooltipEl.style.display = "none";
    });
  }

  const legend = document.getElementById("fitness-legend");
  if (legend && last) {
    legend.innerHTML = `<span style="color:#0077CC; font-weight:700;">Forma ${last.ctl}</span> • <span style="color:#C23B00; font-weight:700;">Fatiga ${last.atl}</span> • <span style="color:#15803D; font-weight:700;">Frescura ${last.tsb}</span>`;
  }

  if (summaryEl && last) {
    const tsb = Number(last.tsb || 0);
    const diag = tsb >= 5
      ? "Descansado y fresco: momento óptimo para series exigentes o competición."
      : tsb >= -10
        ? "Equilibrio ideal: estás asimilando bien la carga semanal sin sobreentrenarte."
        : "Fatiga acumulada alta: prioriza rodajes suaves en Z2 o descanso para recuperar frescura.";

    summaryEl.innerHTML = `
      <div class="fitness-explain-grid">
        <div class="fitness-explain-box">
          <span style="font-size:11px; font-weight:700; color:#0077CC;">● FORMA (CTL): ${last.ctl}</span>
          <span class="body-xs">Tu condición física base acumulada en los últimos 42 días.</span>
        </div>
        <div class="fitness-explain-box">
          <span style="font-size:11px; font-weight:700; color:#C23B00;">● FATIGA (ATL): ${last.atl}</span>
          <span class="body-xs">El cansancio y carga reciente de tus últimos 7 días.</span>
        </div>
        <div class="fitness-explain-box">
          <span style="font-size:11px; font-weight:700; color:#15803D;">● FRESCURA (TSB): ${last.tsb > 0 ? `+${last.tsb}` : last.tsb}</span>
          <span class="body-xs">Diferencia entre Forma y Fatiga (+ descansado / − con carga).</span>
        </div>
      </div>
      <div class="fitness-diagnosis-pill">
        <strong style="color:#FF7A33;">Lectura actual:</strong> ${diag}
      </div>
    `;
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
const _feedPageSize = 20;
let _feedOffset = 0;
let _feedHasMore = false;
let _dashboardVisibleCount = 5;

function loadMoreActivities() {
  _dashboardVisibleCount += 10;
  if (_dashboardVisibleCount <= _feedActivitiesCache.length && !_feedHasMore) {
    loadActivitiesFeed(_feedPageSize, 0, false);
  } else {
    loadActivitiesFeed(_feedPageSize, _feedOffset, true);
  }
}

async function loadActivitiesFeed(limit = _feedPageSize, offset = 0, append = false) {
  const feedEl = document.getElementById("dashboard-activities-feed");
  const listEl = document.getElementById("metrics-history-list");
  if (!feedEl && !listEl) return;

  if (!append && _feedActivitiesCache.length === 0) {
    const skel = `<div class="skeleton-shimmer" style="height:120px; margin-bottom:12px;"></div><div class="skeleton-shimmer" style="height:120px;"></div>`;
    if (feedEl) feedEl.innerHTML = skel;
    if (listEl) listEl.innerHTML = skel;
  }

  try {
    const res = await fetch(`/api/activities?limit=${limit}&offset=${offset}`);
    if (!res.ok) return;
    const data = await res.json();
    const pageActs = data.activities || [];
    _feedHasMore = Boolean(data.has_more);
    if (append) {
      const seen = new Set(_feedActivitiesCache.map(x => String(x.external_id)));
      pageActs.forEach(x => {
        if (!seen.has(String(x.external_id))) _feedActivitiesCache.push(x);
      });
    } else {
      _feedActivitiesCache = pageActs;
    }
    _feedOffset = _feedActivitiesCache.length;
    const acts = _feedActivitiesCache;

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
        ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0077CC" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/></svg>`
        : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#16A34A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="15" cy="4" r="2"/><path d="M10.5 9.5 7 11.5l1 3.5"/><path d="m14 9.5 3.5 2.5 2.5-.5"/><path d="m13.5 9.5-2.5 5 3.5 2.5 1.5 4.5"/><path d="m11 14.5-4 2.5-2 3.5"/></svg>`;
      const badgeBg = isFuerza ? "rgba(252,82,0,0.10)" : isBici ? "rgba(0,119,204,0.10)" : "rgba(22,163,74,0.10)";
      const badgeColor = isFuerza ? "#FC5200" : isBici ? "#0077CC" : "#16A34A";
      const paceOrSpeed = isBici && a.duration_min > 0
        ? `${((a.distance_km || 0) / (a.duration_min / 60)).toFixed(1)} km/h`
        : (a.avg_pace_str || `${Math.round(a.duration_min || 0)} min`);
      const distVal = a.distance_km ? `${a.distance_km} km` : `${Math.round(a.duration_min || 0)} min`;
      const elevVal = `+${Math.round(a.elevation_gain || 0)} m`;
      const hasPoly = Array.isArray(a.polyline) && a.polyline.length > 2;

      if (idx < _dashboardVisibleCount) {
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
      }

      if (idx < _dashboardVisibleCount) {
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
      }
    });

    const canShowMore = (acts.length > _dashboardVisibleCount) || _feedHasMore;
    const loadMoreBtn = canShowMore
      ? `<button type="button" class="btn btn-ghost" style="width:100%; border-radius:9999px; margin-top:4px;" onclick="loadMoreActivities()">Cargar más actividades</button>`
      : "";

    if (feedEl) feedEl.innerHTML = feedHtml + loadMoreBtn;
    if (listEl) {
      listEl.dataset.feedLoaded = "1";
      listEl.innerHTML = listHtml;
    }

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
let _detailSelectedSplitIdx = null;
let _detailMapCursorMarker = null;
let _detailMapHighlightLayer = null;

function _getSplitKmBounds(splits, idx) {
  if (!splits || idx < 0 || idx >= splits.length) return [0, 0];
  let acc = 0;
  for (let i = 0; i < idx; i++) {
    acc += splits[i].is_partial ? Number(splits[i].km || 0) : 1.0;
  }
  const len = splits[idx].is_partial ? Number(splits[idx].km || 0) : 1.0;
  return [acc, acc + len];
}

function _fmtSecMS(sec) {
  if (sec === null || sec === undefined || isNaN(sec)) return "—";
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function _syncMapMarkerAtIndex(idx) {
  const act = _currentDetailActivity;
  if (!_detailMapInstance || !window.L || !act || !act.polyline || act.polyline.length < 2) return;
  const cs = act.chart_series || {};
  const n = Math.max(1, (cs.dist_km || []).length - 1);
  const ratio = Math.min(1, Math.max(0, idx / n));
  const polyIdx = Math.min(act.polyline.length - 1, Math.round(ratio * (act.polyline.length - 1)));
  const pt = act.polyline[polyIdx];
  if (!pt) return;
  if (!_detailMapCursorMarker) {
    _detailMapCursorMarker = L.circleMarker(pt, {
      radius: 7,
      color: "#FFFFFF",
      weight: 3,
      fillColor: "#FF5500",
      fillOpacity: 1
    }).addTo(_detailMapInstance);
  } else {
    _detailMapCursorMarker.setLatLng(pt);
  }
}

function selectActivitySplit(idx) {
  const act = _currentDetailActivity;
  if (!act || !act.splits || !act.splits[idx]) return;
  _detailSelectedSplitIdx = _detailSelectedSplitIdx === idx ? null : idx;

  document.querySelectorAll("#detail-splits-list .detail-split-row").forEach((el) => {
    const rowIdx = Number(el.getAttribute("data-split-idx"));
    el.classList.toggle("active", rowIdx === _detailSelectedSplitIdx);
  });

  const inspector = document.getElementById("detail-split-inspector");
  if (_detailSelectedSplitIdx === null) {
    if (inspector) inspector.style.display = "none";
    if (_detailMapHighlightLayer && _detailMapInstance) {
      _detailMapInstance.removeLayer(_detailMapHighlightLayer);
      _detailMapHighlightLayer = null;
    }
    renderStravaDetailChart(act.chart_series || {});
    return;
  }

  const s = act.splits[idx];
  const [startKm, endKm] = _getSplitKmBounds(act.splits, idx);
  const cs = act.chart_series || {};
  const dists = cs.dist_km || [];
  const cads = cs.cadence || [];
  const temps = cs.temp_c || [];

  const inRange = (arr) => {
    const vals = [];
    for (let i = 0; i < dists.length; i++) {
      const d = Number(dists[i]);
      if (d >= startKm && d <= endKm && arr[i] !== null && arr[i] !== undefined) {
        vals.push(Number(arr[i]));
      }
    }
    return vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  };

  const avgCad = inRange(cads);
  const avgTemp = inRange(temps);
  const elevTxt = s.elev_diff !== undefined && s.elev_diff !== null ? `${s.elev_diff >= 0 ? "+" : ""}${Math.round(s.elev_diff)} m` : "—";
  const splitTitle = s.is_partial ? `Último parcial (${s.km} km)` : `Parcial Km ${s.km}`;

  if (inspector) {
    inspector.style.display = "flex";
    inspector.innerHTML = `
      <div class="detail-split-inspector-head">
        <div>
          <span style="font-size:0.68rem; font-weight:700; letter-spacing:0.06em; color:#FF7A33; display:block;">DETALLE DEL PARCIAL</span>
          <strong style="font-size:0.95rem; color:#FFFFFF;">${splitTitle}</strong>
        </div>
        <button type="button" class="strava-chip-btn" style="padding:3px 9px; font-size:0.72rem; background:rgba(255,255,255,0.12); color:#FFFFFF; border:none;" onclick="selectActivitySplit(${idx})">Cerrar</button>
      </div>
      <div class="detail-split-inspector-grid">
        <div class="detail-split-metric"><span>Ritmo</span><strong>${s.pace_str || "—"}</strong></div>
        <div class="detail-split-metric"><span>GAP</span><strong>${s.gap_str || "—"}</strong></div>
        <div class="detail-split-metric"><span>FC Media</span><strong>${s.avg_hr ? `${s.avg_hr} ppm` : "—"}</strong></div>
        <div class="detail-split-metric"><span>Desnivel</span><strong>${elevTxt}</strong></div>
        <div class="detail-split-metric"><span>Cadencia</span><strong>${avgCad ? `${Math.round(avgCad)} ppm` : (act.avg_cadence ? `${act.avg_cadence} ppm` : "—")}</strong></div>
        <div class="detail-split-metric"><span>Temp</span><strong>${avgTemp !== null ? `${avgTemp.toFixed(1)} °C` : (act.avg_temp_c !== null && act.avg_temp_c !== undefined ? `${Number(act.avg_temp_c).toFixed(1)} °C` : "—")}</strong></div>
      </div>
    `;
  }

  // Highlight km segment on Leaflet map
  if (_detailMapInstance && window.L && act.polyline && act.polyline.length > 2) {
    if (_detailMapHighlightLayer) {
      _detailMapInstance.removeLayer(_detailMapHighlightLayer);
      _detailMapHighlightLayer = null;
    }
    const totalKm = Math.max(0.1, Number(act.distance_km || (dists.length ? dists[dists.length - 1] : 1)));
    const pStart = Math.max(0, Math.floor((startKm / totalKm) * (act.polyline.length - 1)));
    const pEnd = Math.min(act.polyline.length - 1, Math.ceil((endKm / totalKm) * (act.polyline.length - 1)));
    const segPts = act.polyline.slice(pStart, Math.max(pStart + 2, pEnd + 1));
    if (segPts.length >= 2) {
      _detailMapHighlightLayer = L.polyline(segPts, {
        color: "#111113",
        weight: 6,
        opacity: 0.95
      }).addTo(_detailMapInstance);
      _detailMapInstance.fitBounds(_detailMapHighlightLayer.getBounds(), { padding: [36, 36], maxZoom: 16 });
    }
  }

  renderStravaDetailChart(act.chart_series || {});
}

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
  window._detailChartToggleTriggered = true;
  if (_currentDetailActivity) renderStravaDetailChart(_currentDetailActivity.chart_series || {});
}

function _cleanAndSmoothSeries(rawArr, windowSize = 5, minValid = null, maxValid = null) {
  if (!Array.isArray(rawArr) || rawArr.length === 0) return [];
  const filtered = rawArr.map(v => {
    if (v === null || v === undefined || isNaN(v)) return null;
    const n = Number(v);
    if (minValid !== null && n < minValid) return null;
    if (maxValid !== null && n > maxValid) return null;
    return n;
  });
  const half = Math.floor(windowSize / 2);
  return filtered.map((v, i) => {
    if (v === null) return null;
    let sum = 0, cnt = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(filtered.length - 1, i + half); k++) {
      if (filtered[k] !== null) {
        sum += filtered[k];
        cnt++;
      }
    }
    return cnt > 0 ? (sum / cnt) : null;
  });
}

function renderStravaDetailChart(series) {
  const act = _currentDetailActivity || { chart_series: series || {} };
  const chartCard = document.getElementById("detail-chart-card");
  const chartSvg = document.getElementById("detail-chart-svg");
  const togglesEl = document.getElementById("detail-stream-toggles");
  const tooltipEl = document.getElementById("detail-chart-tooltip");
  if (!chartSvg || !togglesEl) return;

  const cs = series || act.chart_series || {};
  const dists = cs.dist_km || [];

  // Rolling average (5-7 pts) + spike filter (pace 2:30/km to 12:00/km)
  const smoothElev = _cleanAndSmoothSeries(cs.elevation_m || [], 5, -200, 6000);
  const smoothPace = _cleanAndSmoothSeries(cs.pace_sec || [], 5, 150, 720);
  const smoothHr = _cleanAndSmoothSeries(cs.hr || [], 3, 40, 230);
  const smoothCad = _cleanAndSmoothSeries(cs.cadence || [], 3, 40, 240);
  const cleanTemp = _cleanAndSmoothSeries(cs.temp_c || [], 3, -30, 60);

  const elevs = smoothElev.filter(v => v !== null);
  const paces = smoothPace.filter(v => v !== null);
  const hrs = smoothHr.filter(v => v !== null);
  const cads = smoothCad.filter(v => v !== null);
  const temps = cleanTemp.filter(v => v !== null);

  const avg = (arr) => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length) : null;
  const avgPaceSec = avg(paces);
  const avgPaceStr = avgPaceSec ? `${Math.floor(avgPaceSec / 60)}:${String(Math.round(avgPaceSec % 60)).padStart(2, "0")} /km` : (act.avg_pace_str || "Sin datos");
  const avgHrVal = avg(hrs) ? `${Math.round(avg(hrs))} ppm` : (act.avg_hr ? `${Math.round(act.avg_hr)} ppm` : "Sin datos");
  const avgCadVal = avg(cads) ? `${Math.round(avg(cads))} ppm` : (act.avg_cadence ? `${act.avg_cadence} ppm` : "Sin datos");
  const avgTempVal = avg(temps) !== null ? `${avg(temps).toFixed(1)} °C` : (act.avg_temp_c !== null && act.avg_temp_c !== undefined ? `${Number(act.avg_temp_c).toFixed(1)} °C` : "Sin datos");

  const streamsMeta = [
    { key: "pace", label: "Ritmo", avg: avgPaceStr, color: "#0077CC", data: smoothPace, invert: true, unit: "min/km" },
    { key: "hr", label: "Frecuencia cardíaca", avg: avgHrVal, color: "#E53935", data: smoothHr, invert: false, unit: "ppm" },
    { key: "cadence", label: "Cadencia", avg: avgCadVal, color: "#8E24AA", data: smoothCad, invert: false, unit: "ppm" },
    { key: "temp", label: "Temperatura", avg: avgTempVal, color: "#FB8C00", data: cleanTemp, invert: false, unit: "°C" }
  ];

  togglesEl.innerHTML = streamsMeta.map(s => {
    const isOn = !!_detailStreamState[s.key];
    return `
      <div class="detail-toggle-row">
        <div>
          <span class="body-xs" style="display:flex; align-items:center; gap:6px; font-weight:700; color:var(--text-secondary);">
            <span style="width:8px; height:8px; border-radius:50%; background:${s.color}; display:inline-block;"></span>
            ${s.label}
          </span>
          <strong class="tabular-num" style="font-size:0.9rem; color:var(--on-surface);">${s.avg}</strong>
        </div>
        <button type="button" class="detail-toggle-btn ${isOn ? "on" : ""}" onclick="toggleChartLayer('${s.key}')">${isOn ? "Sí" : "No"}</button>
      </div>
    `;
  }).join("");

  if (!dists || dists.length < 4) {
    if (chartCard) chartCard.style.display = "flex";
    chartSvg.innerHTML = `<div style="height:100%; display:flex; align-items:center; justify-content:center;" class="body-xs">Sin datos de telemetría GPS en esta sesión.</div>`;
    return;
  }

  const W = 680, H = 220;
  const padL = 44, padR = 52, padT = 14, padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const maxDist = Math.max(0.1, Number(dists[dists.length - 1] || act.distance_km || 1));

  const buildCoords = (rawArr, invert = false) => {
    const valid = rawArr.filter(v => v !== null && v !== undefined);
    if (valid.length < 3) return { path: "", coords: [], mn: 0, mx: 0 };
    const mn = Math.min(...valid), mx = Math.max(...valid), rng = (mx - mn) || 1;
    const coords = new Array(rawArr.length).fill(null);
    const pts = [];
    rawArr.forEach((v, i) => {
      if (v === null || v === undefined) return;
      const x = padL + (i / Math.max(1, rawArr.length - 1)) * plotW;
      const norm = (v - mn) / rng;
      const y = invert ? (padT + norm * plotH) : (padT + plotH - norm * plotH);
      coords[i] = { x, y, v };
      pts.push(`${pts.length === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`);
    });
    return { path: pts.join(" "), coords, mn, mx };
  };

  const elevRes = buildCoords(smoothElev, false);
  const elevLine = elevRes.path;
  const elevArea = elevLine
    ? `${elevLine} L${(padL + plotW).toFixed(1)},${(padT + plotH).toFixed(1)} L${padL.toFixed(1)},${(padT + plotH).toFixed(1)} Z`
    : "";

  // Y-axis elevation ticks & horizontal gridlines
  const minElev = elevs.length ? Math.round(Math.min(...elevs)) : 0;
  const maxElev = elevs.length ? Math.round(Math.max(...elevs)) : 100;
  const midElev = Math.round((minElev + maxElev) / 2);
  const yTicks = [
    { y: padT, label: `${maxElev}m` },
    { y: padT + plotH * 0.5, label: `${midElev}m` },
    { y: padT + plotH, label: `${minElev}m` }
  ];
  const gridSvg = yTicks.map(t => `
    <line x1="${padL}" y1="${t.y.toFixed(1)}" x2="${W - padR}" y2="${t.y.toFixed(1)}" stroke="#E5E5EA" stroke-dasharray="3 4" stroke-width="1"/>
    <text x="${padL - 6}" y="${(t.y + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="#5B5B66" font-family="Geist, sans-serif">${t.label}</text>
  `).join("");

  // X-axis distance ticks
  const xTickCount = 4;
  const xTicksSvg = Array.from({ length: xTickCount + 1 }, (_, i) => {
    const frac = i / xTickCount;
    const x = padL + frac * plotW;
    const dLbl = `${(frac * maxDist).toFixed(1)} km`;
    const anchor = i === 0 ? "start" : i === xTickCount ? "end" : "middle";
    return `<text x="${x.toFixed(1)}" y="${H - 6}" text-anchor="${anchor}" font-size="10" fill="#5B5B66" font-family="Geist, sans-serif">${dLbl}</text>`;
  }).join("");

  // Optional selected split highlight band
  let splitBandSvg = "";
  if (_detailSelectedSplitIdx !== null && act.splits && act.splits[_detailSelectedSplitIdx]) {
    const [sKm, eKm] = _getSplitKmBounds(act.splits, _detailSelectedSplitIdx);
    const x1 = padL + Math.min(1, sKm / maxDist) * plotW;
    const x2 = padL + Math.min(1, eKm / maxDist) * plotW;
    splitBandSvg = `<rect x="${x1.toFixed(1)}" y="${padT}" width="${Math.max(4, x2 - x1).toFixed(1)}" height="${plotH}" fill="rgba(255, 85, 0, 0.14)" stroke="rgba(255, 85, 0, 0.45)" stroke-width="1"/>`;
  }

  // Right Y-axis for active primary stream (Pace inverted: fast on top, slow at bottom; or HR in ppm)
  let rightAxisSvg = "";
  const activeStream = streamsMeta.find(s => _detailStreamState[s.key] && s.data.filter(v => v !== null).length >= 3);
  if (activeStream) {
    const aRes = buildCoords(activeStream.data, activeStream.invert);
    const topVal = activeStream.invert ? aRes.mn : aRes.mx;
    const botVal = activeStream.invert ? aRes.mx : aRes.mn;
    const fmtAxisVal = (v) => activeStream.key === "pace" ? _fmtSecMS(v) : activeStream.key === "temp" ? `${v.toFixed(1)}°` : `${Math.round(v)}`;
    rightAxisSvg = `
      <text x="${W - padR + 5}" y="${padT + 4}" text-anchor="start" font-size="9.5" fill="${activeStream.color}" font-family="Geist, sans-serif">${fmtAxisVal(topVal)}</text>
      <text x="${W - padR + 5}" y="${padT + plotH / 2 + 3}" text-anchor="start" font-size="9" fill="${activeStream.color}" font-family="Geist, sans-serif">${activeStream.unit}</text>
      <text x="${W - padR + 5}" y="${padT + plotH}" text-anchor="start" font-size="9.5" fill="${activeStream.color}" font-family="Geist, sans-serif">${fmtAxisVal(botVal)}</text>
    `;
  }

  const overlays = streamsMeta
    .filter(s => _detailStreamState[s.key])
    .map(s => {
      const res = buildCoords(s.data, s.invert);
      return res.path ? `<path d="${res.path}" fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linecap="round"/>` : "";
    })
    .join("");

  chartSvg.innerHTML = `
    <svg id="detail-streams-svg-el" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%; height:100%; background:#FFFFFF; border:1px solid rgba(0,0,0,0.06); border-radius:16px; cursor:crosshair; display:block;">
      <defs>
        <linearGradient id="strideElevGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#111113" stop-opacity="0.16"/>
          <stop offset="100%" stop-color="#111113" stop-opacity="0.02"/>
        </linearGradient>
      </defs>
      ${gridSvg}
      ${rightAxisSvg}
      ${splitBandSvg}
      ${elevArea ? `<path d="${elevArea}" fill="url(#strideElevGrad)"/>` : ""}
      ${elevLine ? `<path d="${elevLine}" fill="none" stroke="#8A8A94" stroke-width="1.5"/>` : ""}
      ${overlays}
      ${xTicksSvg}
      <line id="detail-chart-crosshair" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" stroke="#111113" stroke-width="1.2" stroke-dasharray="3 2" style="display:none;"/>
      <circle id="detail-chart-dot" cx="0" cy="0" r="4.5" fill="#FF5500" stroke="#FFFFFF" stroke-width="2" style="display:none;"/>
    </svg>
  `;
  if (window.AaronCharts) {
    window.AaronCharts.animate(chartSvg, {
      isToggleUpdate: !!window._detailChartToggleTriggered,
      pointCount: dists.length
    });
  }
  window._detailChartToggleTriggered = false;

  const svgEl = document.getElementById("detail-streams-svg-el");
  const crosshair = document.getElementById("detail-chart-crosshair");
  const dot = document.getElementById("detail-chart-dot");
  if (!svgEl) return;

  const handleScrub = (clientX) => {
    const rect = svgEl.getBoundingClientRect();
    if (!rect.width) return;
    const svgX = ((clientX - rect.left) / rect.width) * W;
    const clampedX = Math.max(padL, Math.min(padL + plotW, svgX));
    const frac = (clampedX - padL) / plotW;
    const idx = Math.min(dists.length - 1, Math.max(0, Math.round(frac * (dists.length - 1))));

    const ptX = padL + (idx / Math.max(1, dists.length - 1)) * plotW;
    if (crosshair) {
      crosshair.setAttribute("x1", ptX.toFixed(1));
      crosshair.setAttribute("x2", ptX.toFixed(1));
      crosshair.style.display = "block";
    }
    const elevCoord = elevRes.coords[idx];
    if (dot && elevCoord) {
      dot.setAttribute("cx", ptX.toFixed(1));
      dot.setAttribute("cy", elevCoord.y.toFixed(1));
      dot.style.display = "block";
    }

    if (tooltipEl) {
      const dVal = dists[idx] !== null && dists[idx] !== undefined ? `${Number(dists[idx]).toFixed(2)} km` : "—";
      const tVal = (cs.time_sec && cs.time_sec[idx] !== null && cs.time_sec[idx] !== undefined) ? _fmtSecMS(cs.time_sec[idx]) : "";
      const eVal = (cs.elevation_m && cs.elevation_m[idx] !== null && cs.elevation_m[idx] !== undefined) ? `${Math.round(cs.elevation_m[idx])} m` : "";
      const pRaw = cs.pace_sec ? cs.pace_sec[idx] : null;
      const pVal = (pRaw && pRaw > 120 && pRaw < 1200) ? `${_fmtSecMS(pRaw)}/km` : "";
      const hVal = (cs.hr && cs.hr[idx]) ? `${cs.hr[idx]} ppm` : "";
      const cVal = (cs.cadence && cs.cadence[idx]) ? `${cs.cadence[idx]} cad` : "";
      const tmpVal = (cs.temp_c && cs.temp_c[idx] !== null && cs.temp_c[idx] !== undefined) ? `${cs.temp_c[idx]}°C` : "";

      const parts = [
        `<span style="display:inline-flex;align-items:center;gap:5px;font-weight:700;"><span style="width:7px;height:7px;border-radius:50%;background:#FF5500;display:inline-block;"></span>${dVal}</span>`,
        tVal ? `<span>${tVal}</span>` : "",
        eVal ? `<span>${eVal}</span>` : "",
        pVal ? `<span style="color:#60A5FA;">${pVal}</span>` : "",
        hVal ? `<span style="color:#F87171;">${hVal}</span>` : "",
        cVal ? `<span style="color:#C084FC;">${cVal}</span>` : "",
        tmpVal ? `<span style="color:#FBBF24;">${tmpVal}</span>` : ""
      ].filter(Boolean);
      tooltipEl.innerHTML = parts.join(" · ");
      tooltipEl.style.display = "flex";
    }

    _syncMapMarkerAtIndex(idx);
  };

  svgEl.addEventListener("mousemove", (e) => handleScrub(e.clientX));
  svgEl.addEventListener("touchstart", (e) => {
    if (e.touches && e.touches[0]) handleScrub(e.touches[0].clientX);
  }, { passive: true });
  svgEl.addEventListener("touchmove", (e) => {
    if (e.touches && e.touches[0]) handleScrub(e.touches[0].clientX);
  }, { passive: true });
  svgEl.addEventListener("mouseleave", () => {
    if (crosshair) crosshair.style.display = "none";
    if (dot) dot.style.display = "none";
    if (tooltipEl) tooltipEl.style.display = "none";
  });
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
  const flyoverBtn = document.getElementById("btn-play-flyover-3d");
  if (_detailMapInstance) { _detailMapInstance.remove(); _detailMapInstance = null; }
  _detailMapCursorMarker = null;
  _detailMapHighlightLayer = null;
  if (flyoverBtn) {
    flyoverBtn.style.display = (act.polyline && act.polyline.length >= 2) ? "inline-flex" : "none";
  }
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

    // Render Strava-style Parciales Table (KM, Ritmo, Desn.) including fractional last split & clickable inspector
    _detailSelectedSplitIdx = null;
    const splitInspector = document.getElementById("detail-split-inspector");
    if (splitInspector) splitInspector.style.display = "none";
    const splitsList = document.getElementById("detail-splits-list");
    if (act.splits && act.splits.length > 0) {
      const minPace = Math.min(...act.splits.map(s => s.pace_sec));
      const maxPace = Math.max(...act.splits.map(s => s.pace_sec));
      splitsList.innerHTML = act.splits.map((s, idx) => {
        const ratio = maxPace > minPace ? 100 - ((s.pace_sec - minPace) / (maxPace - minPace)) * 45 : 85;
        const elevTxt = s.elev_diff !== undefined && s.elev_diff !== null ? `${s.elev_diff >= 0 ? "+" : ""}${Math.round(s.elev_diff)} m` : "—";
        return `
          <button type="button" class="detail-split-row" data-split-idx="${idx}" onclick="selectActivitySplit(${idx})">
            <span style="color:var(--text-secondary); font-weight:700;">${s.km} km</span>
            <div class="detail-split-pace-wrap">
              <span style="font-weight:800; color:var(--on-surface); min-width:58px;">${s.pace_str}</span>
              <div class="split-bar-track" style="flex:1;"><div class="split-bar-fill" style="width:${Math.round(ratio)}%;"></div></div>
            </div>
            <span style="color:var(--text-secondary); text-align:right;">${elevTxt}</span>
          </button>
        `;
      }).join("");
      if (window.AaronCharts) window.AaronCharts.animate(splitsList);
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
    loadActivityDeepAnalysis(act.external_id || externalId, act.chart_series || {});

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
  _detailMapCursorMarker = null;
  _detailMapHighlightLayer = null;
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
function renderGearListItems(list) {
  const cont = document.getElementById("gear-list-container");
  const dashCont = document.getElementById("dashboard-gear-list");
  if (!cont && !dashCont) return;
  const safeList = Array.isArray(list) ? list : [];
  const html = safeList.map(g => {
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
}

async function loadGearList() {
  const cont = document.getElementById("gear-list-container");
  const dashCont = document.getElementById("dashboard-gear-list");
  if (!cont && !dashCont) return;
  try {
    const res = await fetch("/api/gear");
    if (!res.ok) return;
    const data = await res.json();
    renderGearListItems(data.gear || []);
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

  const isDesktop = typeof window !== "undefined" && window.innerWidth >= 1024;
  const W = isDesktop ? 720 : 520;
  const H = 150;
  const padL = 48, padR = 22, padT = 22, padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const paces = valid.map(r => r.pace_sec);
  const minP = Math.min(...paces), maxP = Math.max(...paces), rng = (maxP - minP) || 10;

  const coords = valid.map((r, i) => {
    const x = padL + (i / (valid.length - 1)) * plotW;
    // Faster pace (lower sec) higher up on chart
    const y = padT + ((r.pace_sec - minP) / rng) * plotH;
    return { x, y, r };
  });

  const linePath = coords.map((pt, i) => `${i === 0 ? "M" : "L"}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${coords[coords.length - 1].x.toFixed(1)},${(padT + plotH).toFixed(1)} L${coords[0].x.toFixed(1)},${(padT + plotH).toFixed(1)} Z`;
  const midP = Math.round((minP + maxP) / 2);
  const fmtPace = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
  const fmtDateShort = (d) => (d || "").slice(5).split("-").reverse().join("/");

  const gridLines = [
    { y: padT, label: fmtPace(minP) },
    { y: padT + plotH / 2, label: fmtPace(midP) },
    { y: padT + plotH, label: fmtPace(maxP) }
  ].map(t => `
    <line x1="${padL}" y1="${t.y.toFixed(1)}" x2="${W - padR}" y2="${t.y.toFixed(1)}" stroke="var(--curve-grid-stroke)" stroke-width="1"/>
    <text x="${padL - 8}" y="${(t.y + 3).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--text-muted)">${t.label}</text>
  `).join("");

  const dotsHtml = coords.map(pt => {
    const isCur = !!pt.r.is_current;
    const col = isCur ? "var(--accent-orange)" : "var(--curve-stroke-dark)";
    const rad = isCur ? 6 : 4.5;
    return `
      <g class="matched-dot-group" style="cursor:pointer;" onclick="openActivityDetail('${pt.r.external_id}')">
        <title>${pt.r.start_date} · ${pt.r.avg_pace_str}</title>
        ${isCur ? `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="11" fill="rgba(238,90,43,0.16)"/>` : ""}
        <circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="${rad}" fill="${col}" stroke="var(--surface)" stroke-width="2"/>
        ${isCur ? `<text x="${pt.x.toFixed(1)}" y="${Math.max(12, pt.y - 10).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="600" fill="var(--accent-orange-hover)">${pt.r.avg_pace_str || ""}</text>` : ""}
      </g>
    `;
  }).join("");

  svgEl.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" style="width:100%; height:100%; background:var(--surface); border:1px solid var(--border-default); border-radius:18px; display:block;">
      <defs>
        <linearGradient id="matchedAreaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--curve-stroke-accent)" stop-opacity="0.28"/>
          <stop offset="100%" stop-color="var(--curve-stroke-accent)" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${gridLines}
      <text x="${padL}" y="${H - 6}" text-anchor="start" font-size="11" fill="var(--text-muted)">${fmtDateShort(valid[0].start_date)}</text>
      <text x="${W - padR}" y="${H - 6}" text-anchor="end" font-size="11" fill="var(--text-muted)">${fmtDateShort(valid[valid.length - 1].start_date)}</text>
      <path d="${areaPath}" fill="url(#matchedAreaGrad)"/>
      <path d="${linePath}" fill="none" stroke="var(--curve-stroke-accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      ${dotsHtml}
    </svg>
  `;
  if (window.AaronCharts) window.AaronCharts.animate(svgEl);
}

async function loadActivityDeepAnalysis(externalId, chartSeries) {
  const sec = document.getElementById("detail-sec-deep-analysis");
  if (!sec || !externalId) return;
  sec.style.display = "flex";
  sec.innerHTML = `<div class="skeleton-shimmer" style="height:160px; border-radius:var(--radius-row);"></div>`;
  try {
    const res = await fetch(`/api/activity/${encodeURIComponent(externalId)}/analysis`);
    if (!res.ok) {
      sec.style.display = "none";
      return;
    }
    const analysis = await res.json();
    renderActivityDeepAnalysis(analysis, chartSeries || {});
  } catch (e) {
    console.warn("Deep analysis fetch error:", e);
    sec.style.display = "none";
  }
}

function renderActivityDeepAnalysis(analysis, chartSeries) {
  const sec = document.getElementById("detail-sec-deep-analysis");
  if (!sec || !analysis) return;

  const tipoLabels = {
    series: "SERIES / INTERVALOS",
    fartlek: "FARTLEK",
    tempo: "TEMPO / UMBRAL",
    rodaje: "RODAJE AERÓBICO",
    bici_potencia: "CICLISMO · CON POTENCIA",
    bici_sin_potencia: "CICLISMO · SIN POTENCIA",
    fuerza: "FUERZA",
    otro: "SESIÓN"
  };
  const fuenteLabels = {
    laps_garmin: "Fuente: Vueltas Garmin",
    laps_strava: "Fuente: Vueltas Strava",
    stream: "Fuente: Tramos detectados del stream"
  };

  const tipo = analysis.tipo || "otro";
  const fuente = analysis.fuente || "stream";
  const m = analysis.metricas || {};
  const laps = Array.isArray(analysis.series_o_laps) ? analysis.series_o_laps : [];
  const avisos = Array.isArray(analysis.avisos) ? analysis.avisos : [];
  const ai = analysis.ai_interpretation || null;

  const avisosHtml = avisos.length > 0
    ? `<div style="display:flex; flex-direction:column; gap:6px;">
         ${avisos.map(av => `<div style="padding:8px 12px; border-radius:var(--radius-control); background:var(--surface-elevated); border:1px solid var(--border-strong); font-size:12px; color:var(--text-dark-secondary);">⚠️ ${_escHtml(av)}</div>`).join("")}
       </div>`
    : "";

  let bodyHtml = "";

  if (tipo === "series" || tipo === "fartlek") {
    const workReps = laps.filter(l => l.role === "work");
    const avgPaceSec = Number(m.ritmo_medio_trabajo_sec || 0);
    const planComp = m.cumplimiento_plan;

    // SVG bar chart per repetition (pace height + HR & recovery drop)
    let chartHtml = "";
    if (workReps.length >= 2) {
      const W = 560, H = 160, padL = 44, padR = 16, padT = 20, padB = 28;
      const plotW = W - padL - padR, plotH = H - padT - padB;
      const paces = workReps.map(r => Number(r.pace_sec || avgPaceSec || 300));
      const minP = Math.min(...paces) * 0.92;
      const maxP = Math.max(...paces) * 1.05;
      const rng = Math.max(10, maxP - minP);
      // Faster pace (lower sec) -> taller bar
      const toH = (p) => Math.max(14, Math.min(plotH, ((maxP - p) / rng) * plotH));
      const avgY = avgPaceSec > 0 ? (padT + plotH - toH(avgPaceSec)) : null;
      const slotW = plotW / workReps.length;
      const barW = Math.min(38, Math.max(14, slotW * 0.56));

      const barsSvg = workReps.map((r, i) => {
        const p = Number(r.pace_sec || avgPaceSec || 300);
        const bh = toH(p);
        const bx = padL + i * slotW + (slotW - barW) / 2;
        const by = padT + plotH - bh;
        const dropTxt = r.recovery_drop_60s_bpm !== null && r.recovery_drop_60s_bpm !== undefined
          ? `-${r.recovery_drop_60s_bpm}`
          : "";
        return `
          <rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" rx="6" fill="var(--accent-orange)">
            <title>Serie #${r.rep_num || (i + 1)}: ${r.pace_str || "—"}${r.avg_hr ? ` · ${r.avg_hr} ppm` : ""}${dropTxt ? ` · Rec 60s: ${dropTxt} ppm` : ""}</title>
          </rect>
          <text x="${(bx + barW / 2).toFixed(1)}" y="${Math.max(12, by - 5).toFixed(1)}" text-anchor="middle" font-size="10" fill="var(--text-primary)">${(r.pace_str || "").replace(" /km", "")}</text>
          <text x="${(bx + barW / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="var(--text-muted)">#${r.rep_num || (i + 1)}${dropTxt ? ` (${dropTxt})` : ""}</text>
        `;
      }).join("");

      chartHtml = `
        <div id="deep-intervals-chart-wrap" style="width:100%; height:165px;">
          <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" style="width:100%; height:100%; background:var(--surface); border:1px solid var(--border-default); border-radius:var(--radius-row); display:block;">
            <line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="var(--curve-grid-stroke)" stroke-width="1.5"/>
            ${avgY !== null ? `<line x1="${padL}" y1="${avgY.toFixed(1)}" x2="${W - padR}" y2="${avgY.toFixed(1)}" stroke="var(--curve-stroke-dark)" stroke-width="1.5" stroke-dasharray="4 3"/>` : ""}
            ${avgY !== null ? `<text x="${padL - 5}" y="${(avgY + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--text-secondary)">Media</text>` : ""}
            ${barsSvg}
          </svg>
        </div>
      `;
    }

    const warmCoolHtml = (analysis.calentamiento || analysis.enfriamiento)
      ? `<div style="display:flex; gap:8px; flex-wrap:wrap; font-size:12px; color:var(--text-secondary);">
           ${analysis.calentamiento ? `<span class="pill-tag">Calentamiento: ${Math.round((analysis.calentamiento.duration_sec || 0) / 60)}' @ ${analysis.calentamiento.pace_str || "—"}</span>` : ""}
           ${analysis.enfriamiento ? `<span class="pill-tag">Enfriamiento: ${Math.round((analysis.enfriamiento.duration_sec || 0) / 60)}' @ ${analysis.enfriamiento.pace_str || "—"}</span>` : ""}
         </div>`
      : "";

    bodyHtml = `
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(125px, 1fr)); gap:8px;">
        <div class="p-stat-box">
          <span class="label-caps">REPETICIONES</span>
          <span class="p-stat-val tabular-num">${m.repeticiones_trabajo ?? "—"}</span>
        </div>
        <div class="p-stat-box">
          <span class="label-caps">RITMO TRABAJO</span>
          <span class="p-stat-val tabular-num">${m.ritmo_medio_trabajo_str || "—"}</span>
        </div>
        <div class="p-stat-box">
          <span class="label-caps">FC MEDIA / MÁX</span>
          <span class="p-stat-val tabular-num">${m.fc_media_trabajo ?? "—"} / ${m.fc_max_trabajo ?? "—"}</span>
        </div>
        <div class="p-stat-box">
          <span class="label-caps">CONSISTENCIA (CV)</span>
          <span class="p-stat-val tabular-num">${m.consistencia_cv_pct !== null && m.consistencia_cv_pct !== undefined ? `${m.consistencia_cv_pct}%` : "—"}</span>
        </div>
        <div class="p-stat-box">
          <span class="label-caps">FATIGA 1ª VS ÚLT.</span>
          <span class="p-stat-val tabular-num">${m.fatiga_primera_vs_ultima_sec !== null && m.fatiga_primera_vs_ultima_sec !== undefined ? `${m.fatiga_primera_vs_ultima_sec > 0 ? "+" : ""}${m.fatiga_primera_vs_ultima_sec}s` : "—"}</span>
        </div>
        <div class="p-stat-box">
          <span class="label-caps">CAÍDA FC 60S</span>
          <span class="p-stat-val tabular-num">${m.recuperacion_caida_60s_media_bpm !== null && m.recuperacion_caida_60s_media_bpm !== undefined ? `-${m.recuperacion_caida_60s_media_bpm} ppm` : "—"}</span>
        </div>
      </div>
      ${planComp ? `<div class="body-xs tabular-num" style="padding:8px 12px; border-radius:var(--radius-control); background:var(--surface-muted);"><strong>Cumplimiento del plan:</strong> ${planComp.in_target_reps}/${planComp.total_reps} series en objetivo (${planComp.target_pace_str}) · ${planComp.compliance_pct}%</div>` : ""}
      ${warmCoolHtml}
      ${chartHtml}
    `;
  } else if (tipo === "bici_potencia") {
    const be = m.mejores_esfuerzos_w || {};
    const pwrs = (chartSeries.power_w || []).filter(p => p !== null && p !== undefined);
    let pwrChartHtml = "";
    if (pwrs.length >= 4) {
      const W = 560, H = 140, padL = 44, padR = 16, padT = 16, padB = 22;
      const plotW = W - padL - padR, plotH = H - padT - padB;
      const maxP = Math.max(...pwrs, Number(m.potencia_normalizada_np_w || 200), 100);
      const pts = pwrs.map((v, i) => {
        const x = padL + (i / (pwrs.length - 1)) * plotW;
        const y = padT + plotH - (Math.max(0, Number(v)) / maxP) * plotH;
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(" ");
      const npVal = Number(m.potencia_normalizada_np_w || 0);
      const npY = npVal > 0 ? (padT + plotH - (npVal / maxP) * plotH) : null;
      pwrChartHtml = `
        <div style="width:100%; height:145px;">
          <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" style="width:100%; height:100%; background:var(--surface); border:1px solid var(--border-default); border-radius:var(--radius-row); display:block;">
            <path d="${pts}" fill="none" stroke="var(--curve-stroke-dark)" stroke-width="1.8" stroke-linecap="round"/>
            ${npY !== null ? `<line x1="${padL}" y1="${npY.toFixed(1)}" x2="${W - padR}" y2="${npY.toFixed(1)}" stroke="var(--curve-stroke-accent)" stroke-width="2" stroke-dasharray="4 3"/>` : ""}
            ${npY !== null ? `<text x="${padL - 5}" y="${(npY + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--accent-orange-hover)">NP ${Math.round(npVal)}W</text>` : ""}
          </svg>
        </div>
      `;
    }

    const effortsList = [
      { lbl: "5 seg", val: be["5s"] },
      { lbl: "1 min", val: be["1m"] },
      { lbl: "5 min", val: be["5m"] },
      { lbl: "20 min", val: be["20m"] }
    ];
    const maxEff = Math.max(1, ...effortsList.map(e => Number(e.val || 0)));
    const effortsBarsHtml = effortsList.map(e => {
      const pct = e.val ? Math.round((Number(e.val) / maxEff) * 100) : 0;
      return `
        <div class="pace-dist-row" style="grid-template-columns:64px 1fr 64px;">
          <strong>${e.lbl}</strong>
          <div class="split-bar-track"><div class="split-bar-fill" style="width:${pct}%;"></div></div>
          <span class="tabular-num" style="text-align:right; font-weight:600;">${e.val !== null && e.val !== undefined ? `${e.val} W` : "—"}</span>
        </div>
      `;
    }).join("");

    bodyHtml = `
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(125px, 1fr)); gap:8px;">
        <div class="p-stat-box">
          <span class="label-caps">POTENCIA MEDIA</span>
          <span class="p-stat-val tabular-num">${m.potencia_media_w !== null && m.potencia_media_w !== undefined ? `${m.potencia_media_w} W` : "—"}</span>
        </div>
        <div class="p-stat-box">
          <span class="label-caps">POTENCIA NORM. (NP)</span>
          <span class="p-stat-val tabular-num">${m.potencia_normalizada_np_w !== null && m.potencia_normalizada_np_w !== undefined ? `${m.potencia_normalizada_np_w} W` : "—"}</span>
        </div>
        <div class="p-stat-box">
          <span class="label-caps">IF / TSS</span>
          <span class="p-stat-val tabular-num">${m.factor_intensidad_if ?? "—"} / ${m.tss ?? "—"}</span>
        </div>
        <div class="p-stat-box">
          <span class="label-caps">EFICIENCIA (W/FC)</span>
          <span class="p-stat-val tabular-num">${m.eficiencia_w_fc ?? "—"}</span>
        </div>
        <div class="p-stat-box">
          <span class="label-caps">DESACOPLAMIENTO</span>
          <span class="p-stat-val tabular-num">${m.desacoplamiento_potencia_fc_pct !== null && m.desacoplamiento_potencia_fc_pct !== undefined ? `${m.desacoplamiento_potencia_fc_pct}%` : "—"}</span>
        </div>
        <div class="p-stat-box">
          <span class="label-caps">FTP EST. (20M)</span>
          <span class="p-stat-val tabular-num">${m.ftp_estimado_20m_w !== null && m.ftp_estimado_20m_w !== undefined ? `~${m.ftp_estimado_20m_w} W` : "—"}</span>
        </div>
      </div>
      ${pwrChartHtml}
      <div style="display:flex; flex-direction:column; gap:6px;">
        <span class="label-caps">CURVA DE MEJORES ESFUERZOS (POTENCIA)</span>
        ${effortsBarsHtml}
      </div>
    `;
  } else if (tipo === "bici_sin_potencia") {
    const fcp = m.fc_por_pendiente || {};
    bodyHtml = `
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(125px, 1fr)); gap:8px;">
        <div class="p-stat-box">
          <span class="label-caps">VELOCIDAD MEDIA</span>
          <span class="p-stat-val tabular-num">${m.velocidad_media_kmh ? `${m.velocidad_media_kmh} km/h` : "—"}</span>
        </div>
        <div class="p-stat-box">
          <span class="label-caps">VAM</span>
          <span class="p-stat-val tabular-num">${m.vam_mh ? `${m.vam_mh} m/h` : "—"}</span>
        </div>
        <div class="p-stat-box">
          <span class="label-caps">FC LLANO (&lt;2%)</span>
          <span class="p-stat-val tabular-num">${fcp.llano ? `${fcp.llano} ppm` : "—"}</span>
        </div>
        <div class="p-stat-box">
          <span class="label-caps">FC SUBIDA (2–6% / &gt;6%)</span>
          <span class="p-stat-val tabular-num">${fcp.subida_moderada ?? "—"} / ${fcp.subida_fuerte ?? "—"} ppm</span>
        </div>
      </div>
    `;
  } else {
    bodyHtml = `
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(125px, 1fr)); gap:8px;">
        <div class="p-stat-box">
          <span class="label-caps">RITMO MEDIO</span>
          <span class="p-stat-val tabular-num">${m.ritmo_medio_str || "—"}</span>
        </div>
        <div class="p-stat-box">
          <span class="label-caps">ESTABILIDAD (CV)</span>
          <span class="p-stat-val tabular-num">${m.estabilidad_ritmo_cv_pct !== null && m.estabilidad_ritmo_cv_pct !== undefined ? `${m.estabilidad_ritmo_cv_pct}%` : "—"}</span>
        </div>
        <div class="p-stat-box">
          <span class="label-caps">DERIVA FC MITADES</span>
          <span class="p-stat-val tabular-num">${m.deriva_fc_mitades_bpm !== null && m.deriva_fc_mitades_bpm !== undefined ? `${m.deriva_fc_mitades_bpm > 0 ? "+" : ""}${m.deriva_fc_mitades_bpm} ppm` : "—"}</span>
        </div>
      </div>
    `;
  }

  const aiHtml = ai
    ? `<div style="margin-top:6px; padding:14px 16px; border-radius:var(--radius-row); background:var(--surface-muted); border:1px solid var(--border-default); display:flex; flex-direction:column; gap:8px;">
         <span class="label-caps" style="color:var(--accent-orange-hover);">LECTURA ESTRUCTURADA DE LA SESIÓN</span>
         <ul style="margin:0; padding-left:18px; font-size:13px; color:var(--text-primary); display:flex; flex-direction:column; gap:4px;">
           ${(ai.conclusiones || []).map(c => `<li>${_escHtml(c)}</li>`).join("")}
         </ul>
         <div class="body-xs" style="color:var(--text-dark-secondary);"><strong>Punto a mejorar:</strong> ${_escHtml(ai.punto_a_mejorar || "—")}</div>
         <div class="body-xs" style="color:var(--text-dark-secondary);"><strong>Siguiente sesión:</strong> ${_escHtml(ai.recomendacion_siguiente_sesion || "—")}</div>
       </div>`
    : "";

  sec.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
      <h3 class="headline-sm" style="margin:0;">Análisis Específico · ${tipoLabels[tipo] || tipo.toUpperCase()}</h3>
      <span class="pill-tag">${fuenteLabels[fuente] || fuente}</span>
    </div>
    ${avisosHtml}
    ${bodyHtml}
    ${aiHtml}
  `;

  if (window.AaronCharts) {
    const pwrPts = ((chartSeries && chartSeries.power_w) || []).length;
    window.AaronCharts.animate(sec, { hash: `${analysis.activity_id}_${tipo}_${fuente}`, pointCount: pwrPts });
  }
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
  if (window.AaronCharts) window.AaronCharts.animate(listEl);
}

function _normalizeZonePercentages(zones) {
  if (!Array.isArray(zones) || zones.length === 0) return [];
  const rawSum = zones.reduce((s, z) => s + Number(z.pct || 0), 0);
  if (rawSum <= 0) return zones.map(z => ({ ...z, pct: 0 }));
  const exact = zones.map(z => (Number(z.pct || 0) / rawSum) * 100);
  const floored = exact.map(v => Math.floor(v));
  let rem = 100 - floored.reduce((a, b) => a + b, 0);
  const order = exact.map((v, i) => ({ i, frac: v - floored[i] })).sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < rem && k < order.length; k++) {
    floored[order[k].i] += 1;
  }
  return zones.map((z, i) => ({ ...z, pct: floored[i] }));
}

function renderPaceDistributionSubview(paceDist) {
  const listEl = document.getElementById("detail-pace-dist-list");
  const lblEl = document.getElementById("detail-pace-threshold-label");
  if (!listEl) return;

  const rawZones = (paceDist && Array.isArray(paceDist.zones)) ? paceDist.zones : [];
  const hasTime = rawZones.some(z => Number(z.pct || 0) > 0);
  if (rawZones.length === 0 || !hasTime) {
    listEl.innerHTML = `<p class="body-xs">Sin datos de distribución de ritmo en esta sesión.</p>`;
    return;
  }
  const zones = _normalizeZonePercentages(rawZones);
  if (lblEl && paceDist.threshold_pace_str) {
    lblEl.textContent = `Umbral: ${paceDist.threshold_pace_str}`;
  }

  listEl.innerHTML = zones.map(z => `
    <div class="pace-dist-row">
      <div>
        <strong style="display:block; color:var(--on-surface);">${z.zone}</strong>
        <span class="body-xs" style="font-size:11px;">${z.range_str}</span>
      </div>
      <div class="split-bar-track" style="height:12px;">
        <div style="height:100%; width:${z.pct}%; background:${z.color}; border-radius:999px;"></div>
      </div>
      <span style="text-align:right; font-weight:700;">${z.time_str}</span>
      <span style="text-align:right; color:var(--text-secondary);">${z.pct}%</span>
    </div>
  `).join("");
  if (window.AaronCharts) window.AaronCharts.animate(listEl);
}

function renderHrAnalysisSubview(act) {
  const zonesCard = document.getElementById("detail-zones-card");
  const zonesList = document.getElementById("detail-zones-list");
  const driftBadge = document.getElementById("detail-drift-badge");
  const hrSvg = document.getElementById("detail-hr-curve-svg");
  if (!zonesCard || !zonesList) return;

  const rawZones = act.hr_zones || [];
  const hasHrZones = rawZones.some(z => Number(z.pct || 0) > 0);
  if (rawZones.length === 0 || !hasHrZones) {
    zonesCard.style.display = "flex";
    if (hrSvg) { hrSvg.innerHTML = ""; hrSvg.style.height = "auto"; }
    if (driftBadge) driftBadge.textContent = "Desacoplamiento: —";
    zonesList.innerHTML = `<p class="body-xs">Sin datos de frecuencia cardíaca en esta sesión.</p>`;
    return;
  }
  zonesCard.style.display = "flex";
  const zones = _normalizeZonePercentages(rawZones);

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
    const cs = act.chart_series || {};
    const dists = cs.dist_km || [];
    const hrs = _cleanAndSmoothSeries(cs.hr || [], 3, 40, 230).filter(v => v !== null);
    if (hrs.length >= 6) {
      const W = 560, H = 140, padL = 42, padR = 12, padT = 10, padB = 22;
      const plotW = W - padL - padR;
      const plotH = H - padT - padB;
      const mn = Math.min(...hrs, 100), mx = Math.max(...hrs, 180), rng = (mx - mn) || 1;
      const maxD = dists.length ? Number(dists[dists.length - 1] || act.distance_km || 0) : 0;
      const pathPts = hrs.map((h, i) => {
        const x = padL + (i / (hrs.length - 1)) * plotW;
        const y = padT + plotH - ((h - mn) / rng) * plotH;
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(" ");
      hrSvg.style.height = "140px";
      hrSvg.innerHTML = `
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%; height:100%; border:1px solid #E5E5EA; border-radius:10px; background:#FFFFFF;">
          <rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH * 0.2}" fill="rgba(255,23,68,0.08)"/>
          <rect x="${padL}" y="${padT + plotH * 0.2}" width="${plotW}" height="${plotH * 0.2}" fill="rgba(255,152,0,0.08)"/>
          <rect x="${padL}" y="${padT + plotH * 0.4}" width="${plotW}" height="${plotH * 0.2}" fill="rgba(0,230,118,0.08)"/>
          <rect x="${padL}" y="${padT + plotH * 0.6}" width="${plotW}" height="${plotH * 0.2}" fill="rgba(0,174,239,0.08)"/>
          <rect x="${padL}" y="${padT + plotH * 0.8}" width="${plotW}" height="${plotH * 0.2}" fill="rgba(100,116,139,0.08)"/>
          <text x="${padL - 5}" y="${padT + 8}" text-anchor="end" font-size="9.5" fill="#5B5B66">${Math.round(mx)} ppm</text>
          <text x="${padL - 5}" y="${padT + plotH / 2 + 3}" text-anchor="end" font-size="9.5" fill="#5B5B66">${Math.round((mn + mx) / 2)}</text>
          <text x="${padL - 5}" y="${padT + plotH}" text-anchor="end" font-size="9.5" fill="#5B5B66">${Math.round(mn)} ppm</text>
          <text x="${padL}" y="${H - 5}" text-anchor="start" font-size="9.5" fill="#5B5B66">0 km</text>
          <text x="${W - padR}" y="${H - 5}" text-anchor="end" font-size="9.5" fill="#5B5B66">${maxD > 0 ? `${maxD.toFixed(1)} km` : "Fin"}</text>
          <path d="${pathPts}" fill="none" stroke="#E53935" stroke-width="2.2" stroke-linecap="round"/>
        </svg>
      `;
    } else {
      hrSvg.innerHTML = `<div class="body-xs" style="padding:8px 0;">Sin curva continua de frecuencia cardíaca en esta sesión.</div>`;
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
  if (window.AaronCharts) {
    if (hrSvg) window.AaronCharts.animate(hrSvg);
    window.AaronCharts.animate(zonesList);
  }
}


// ============================================================
// FASE 3 & 4: MOTOR ANALÍTICO + INTERPRETACIÓN IA (GEMINI)
// ============================================================
let _analyticsOverviewData = null;
let _analyticsPeriodKey = "week";

function _escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function _formatDeltaPct(pct, unitSuffix = "%") {
  if (pct === null || pct === undefined || Number.isNaN(Number(pct))) {
    return { text: "Sin base previa", cls: "" };
  }
  const n = Number(pct);
  const sign = n > 0 ? "+" : "";
  return {
    text: `${sign}${n.toFixed(1)}${unitSuffix} vs anterior`,
    cls: n > 0 ? "pos" : n < 0 ? "neg" : ""
  };
}

async function loadAnalyticsOverviewAndAI(forceRefresh = false) {
  const refreshBtn = document.getElementById("summit-ai-refresh-btn");
  if (refreshBtn && forceRefresh) {
    refreshBtn.disabled = true;
    refreshBtn.textContent = "Actualizando...";
  }

  const aiUrl = forceRefresh
    ? "/api/analytics/ai-interpretation?days=730&refresh=1"
    : "/api/analytics/ai-interpretation?days=730";

  try {
    const [overviewRes, aiRes] = await Promise.all([
      fetch("/api/analytics/overview?days=730").catch(() => null),
      fetch(aiUrl).catch(() => null),
    ]);

    if (overviewRes && overviewRes.ok) {
      _analyticsOverviewData = await overviewRes.json();
      renderHomeTrainingLoad(_analyticsOverviewData.training_load, _analyticsOverviewData.aerobic_efficiency);
      renderAnalyticsComparisons(_analyticsPeriodKey);
      renderAerobicEfficiencyCard(_analyticsOverviewData.aerobic_efficiency);
      renderProfileRunnerStats(_analyticsOverviewData);
    }

    if (aiRes) {
      if (aiRes.status === 401) {
        renderAIAuthRequired();
      } else if (aiRes.ok) {
        const aiPayload = await aiRes.json();
        renderAIInterpretationCards(aiPayload);
      }
    }
  } catch (e) {
    console.warn("Analytics overview/AI parallel load failed:", e);
  } finally {
    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.textContent = "Actualizar";
    }
  }
}

function selectAnalyticsPeriod(periodKey, btnEl) {
  _analyticsPeriodKey = periodKey;
  const pills = document.querySelectorAll("#summit-period-pills .stride-period-pill");
  pills.forEach(p => p.classList.remove("active"));
  if (btnEl) btnEl.classList.add("active");
  renderAnalyticsComparisons(periodKey);
}

function renderAnalyticsComparisons(periodKey) {
  const grid = document.getElementById("summit-comp-grid");
  const subtitle = document.getElementById("summit-comp-subtitle");
  if (!grid || !_analyticsOverviewData || !_analyticsOverviewData.comparisons) return;

  const comp = _analyticsOverviewData.comparisons[periodKey];
  if (!comp || !comp.current) {
    grid.innerHTML = `<div class="body-sm-muted">Sin datos reales para este periodo.</div>`;
    return;
  }

  const c = comp.current;
  const d = comp.deltas || {};
  if (subtitle) {
    const qualityTag = comp.sample_quality === "reliable" ? "Muestra comparable" : "Muestra parcial";
    subtitle.textContent = `${comp.label} • ${c.activities_count || 0} actividades • ${qualityTag}`;
  }

  const kmDelta = _formatDeltaPct(d.distance_pct);
  const durDelta = _formatDeltaPct(d.duration_pct);
  const elevDelta = _formatDeltaPct(d.elevation_gain_pct);
  const effDelta = _formatDeltaPct(d.relative_effort_pct);

  const hoursVal = ((Number(c.duration_min || 0)) / 60).toFixed(1);
  grid.innerHTML = `
    <div class="stride-comp-box">
      <span class="stride-comp-label">Distancia</span>
      <strong class="stride-comp-val tabular-num">${Number(c.distance_km || 0).toFixed(1)} km</strong>
      <span class="stride-comp-delta ${kmDelta.cls}">${_escHtml(kmDelta.text)}</span>
    </div>
    <div class="stride-comp-box">
      <span class="stride-comp-label">Tiempo activo</span>
      <strong class="stride-comp-val tabular-num">${hoursVal} h</strong>
      <span class="stride-comp-delta ${durDelta.cls}">${_escHtml(durDelta.text)}</span>
    </div>
    <div class="stride-comp-box">
      <span class="stride-comp-label">Desnivel +</span>
      <strong class="stride-comp-val tabular-num">${Math.round(Number(c.elevation_gain_m || 0))} m</strong>
      <span class="stride-comp-delta ${elevDelta.cls}">${_escHtml(elevDelta.text)}</span>
    </div>
    <div class="stride-comp-box">
      <span class="stride-comp-label">Esfuerzo rel.</span>
      <strong class="stride-comp-val tabular-num">${Math.round(Number(c.relative_effort || 0))}</strong>
      <span class="stride-comp-delta ${effDelta.cls}">${_escHtml(effDelta.text)}</span>
    </div>
  `;
}

function renderAerobicEfficiencyCard(eff) {
  const badge = document.getElementById("summit-eff-badge");
  const metricsEl = document.getElementById("summit-eff-metrics");
  const conclusionEl = document.getElementById("summit-eff-conclusion");
  const homeEffEl = document.getElementById("home-ai-efficiency-pill");
  if (!eff) return;

  const rec = eff.recent_period || {};
  const base = eff.baseline_period || {};

  if (badge) {
    if (eff.status === "insufficient_sample") {
      badge.textContent = "Muestra insuf.";
      badge.className = "pill-tag";
    } else {
      const pct = Number(eff.ef_change_pct || 0);
      badge.textContent = `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% EF`;
      badge.className = pct >= 2.5 ? "pill-tag green tabular-num" : "pill-tag orange tabular-num";
    }
  }

  if (homeEffEl) {
    if (eff.status === "insufficient_sample") {
      homeEffEl.textContent = "Eficiencia 6s vs 6s: muestra insuficiente";
    } else {
      const pct = Number(eff.ef_change_pct || 0);
      homeEffEl.textContent = `Eficiencia 6s vs 6s: ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% (${rec.mean_pace_str || "--"} @ ${rec.mean_hr || "--"} ppm)`;
    }
  }

  if (metricsEl) {
    metricsEl.innerHTML = `
      <div class="stride-eff-window-box">
        <span class="stride-comp-label">Últimas 6 semanas (${rec.count || 0} car.)</span>
        <strong class="tabular-num" style="font-size:1rem; color:#111111;">${_escHtml(rec.mean_pace_str || "--")} /km</strong>
        <span class="body-xs tabular-num" style="color:#5B5B66;">${rec.mean_hr ? `${rec.mean_hr} ppm` : "Sin FC"} • EF ${rec.mean_ef ?? "--"}</span>
      </div>
      <div class="stride-eff-window-box">
        <span class="stride-comp-label">6 semanas previas (${base.count || 0} car.)</span>
        <strong class="tabular-num" style="font-size:1rem; color:#111111;">${_escHtml(base.mean_pace_str || "--")} /km</strong>
        <span class="body-xs tabular-num" style="color:#5B5B66;">${base.mean_hr ? `${base.mean_hr} ppm` : "Sin FC"} • EF ${base.mean_ef ?? "--"}</span>
      </div>
    `;
  }

  if (conclusionEl) {
    conclusionEl.textContent = eff.conclusion || "Sin conclusiones disponibles.";
  }
}

function renderAIAuthRequired() {
  const homeBadge = document.getElementById("home-ai-mode-badge");
  const homeSummary = document.getElementById("home-ai-summary");
  const summitBody = document.getElementById("summit-ai-body");
  if (homeBadge) homeBadge.textContent = "Garmin requerido";
  if (homeSummary) homeSummary.textContent = "Conecta tu cuenta de Garmin Connect en Perfil para desbloquear el análisis IA de tu historial real.";
  if (summitBody) summitBody.innerHTML = `<p class="stride-ai-summary">Conecta Garmin Connect en Perfil para generar la interpretación inteligente con Gemini.</p>`;
}

function renderHomeTrainingLoad(loadObj, effObj) {
  const latest = (loadObj && loadObj.latest) || {};
  const elCtl = document.getElementById("home-ctl-val");
  const elAtl = document.getElementById("home-atl-val");
  const elTsb = document.getElementById("home-tsb-val");
  const elEf = document.getElementById("home-ef-val");

  if (elCtl) elCtl.textContent = latest.ctl !== undefined && latest.ctl !== null ? Number(latest.ctl).toFixed(1) : "--";
  if (elAtl) elAtl.textContent = latest.atl !== undefined && latest.atl !== null ? Number(latest.atl).toFixed(1) : "--";
  if (elTsb) {
    if (latest.tsb !== undefined && latest.tsb !== null) {
      const tsbNum = Number(latest.tsb);
      elTsb.textContent = `${tsbNum > 0 ? "+" : ""}${tsbNum.toFixed(1)}`;
    } else {
      elTsb.textContent = "--";
    }
  }
  if (elEf) {
    if (effObj && effObj.status !== "insufficient_sample" && effObj.ef_change_pct !== null && effObj.ef_change_pct !== undefined) {
      const pct = Number(effObj.ef_change_pct);
      elEf.textContent = `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`;
    } else {
      elEf.textContent = "Insuf.";
    }
  }
}

function renderAIInterpretationCards(payload) {
  const interp = (payload && payload.interpretation) || {};
  const modeLabel = interp.source_mode === "gemini" ? "Gemini Live" : "Motor Determinista";

  const homeBadge = document.getElementById("home-ai-mode-badge");
  const homeSummary = document.getElementById("home-ai-summary");
  const homeTrend = document.getElementById("home-ai-trend");
  const homeHighlights = document.getElementById("home-ai-highlights");

  if (homeBadge) homeBadge.textContent = modeLabel;
  if (homeSummary) homeSummary.textContent = interp.resumen_estado_deportivo || "Sin resumen disponible.";
  if (homeTrend) {
    const trendTxt = interp.evolucion || interp.eficiencia || "";
    if (trendTxt) {
      homeTrend.textContent = trendTxt;
      homeTrend.style.display = "block";
    } else {
      homeTrend.style.display = "none";
    }
  }
  if (homeHighlights) {
    const chips = [];
    if (Array.isArray(interp.puntos_fuertes) && interp.puntos_fuertes.length > 0) {
      chips.push(`✓ ${interp.puntos_fuertes[0]}`);
    }
    if (Array.isArray(interp.aspectos_a_mejorar) && interp.aspectos_a_mejorar.length > 0) {
      chips.push(`• ${interp.aspectos_a_mejorar[0]}`);
    }
    if (chips.length > 0) {
      homeHighlights.innerHTML = chips.map(c => `<span class="stride-home-ai-chip">${_escHtml(c)}</span>`).join("");
      homeHighlights.style.display = "flex";
    } else {
      homeHighlights.style.display = "none";
    }
  }

  const summitBody = document.getElementById("summit-ai-body");
  if (!summitBody) return;

  const strengths = Array.isArray(interp.puntos_fuertes) ? interp.puntos_fuertes : [];
  const improvements = Array.isArray(interp.aspectos_a_mejorar) ? interp.aspectos_a_mejorar : [];
  const periods = Array.isArray(interp.periodos_evaluados) ? interp.periodos_evaluados : [];

  summitBody.innerHTML = `
    <div class="stride-ai-section">
      <div class="stride-ai-section-title">Estado deportivo • ${_escHtml(modeLabel)}</div>
      <p class="stride-ai-summary">${_escHtml(interp.resumen_estado_deportivo || "")}</p>
    </div>
    <div class="stride-ai-section">
      <div class="stride-ai-section-title">Evolución &amp; Eficiencia</div>
      <p class="stride-ai-summary">${_escHtml(interp.evolucion || "")}</p>
      <p class="stride-ai-summary" style="margin-top:6px;">${_escHtml(interp.eficiencia || "")}</p>
    </div>
    <div class="stride-ai-section">
      <div class="stride-ai-section-title">Carga &amp; Recuperación (Cálculo AaronFit)</div>
      <p class="stride-ai-summary">${_escHtml(interp.carga || "")}</p>
    </div>
    ${strengths.length ? `
    <div class="stride-ai-section">
      <div class="stride-ai-section-title">Puntos fuertes</div>
      <ul class="stride-ai-list">${strengths.map(s => `<li>${_escHtml(s)}</li>`).join("")}</ul>
    </div>` : ""}
    ${improvements.length ? `
    <div class="stride-ai-section">
      <div class="stride-ai-section-title">Aspectos a vigilar</div>
      <ul class="stride-ai-list">${improvements.map(s => `<li>${_escHtml(s)}</li>`).join("")}</ul>
    </div>` : ""}
    <div class="stride-ai-footer">
      <span class="stride-ai-meta">${_escHtml(interp.conclusion || "")}</span>
      ${periods.length ? `<span class="stride-ai-badge">${_escHtml(periods.join(" · "))}</span>` : ""}
    </div>
  `;
}

function renderProfileRunnerStats(overview) {
  if (!overview || !overview.comparisons || !overview.comparisons.months_12) return;
  const c12 = overview.comparisons.months_12.current || {};
  const scope = overview.data_scope || {};

  const elScope = document.getElementById("profile-stats-scope");
  const elKm = document.getElementById("profile-rs-km");
  const elHours = document.getElementById("profile-rs-hours");
  const elElev = document.getElementById("profile-rs-elev");
  const elEffort = document.getElementById("profile-rs-effort");

  if (elScope) elScope.textContent = `${scope.activities_analyzed || c12.activities_count || 0} act. totales`;
  if (elKm) elKm.textContent = `${Number(c12.distance_km || 0).toFixed(1)} km`;
  if (elHours) elHours.textContent = `${(Number(c12.duration_min || 0) / 60).toFixed(1)} h`;
  if (elElev) elElev.textContent = `${Math.round(Number(c12.elevation_gain_m || 0))} m`;
  if (elEffort) elEffort.textContent = `${Math.round(Number(c12.relative_effort || 0))}`;
}

/* ==========================================================================
   AARONFIT — FASE 5.2: BIENESTAR, SUEÑO, MOVILIDAD Y RECUPERACIÓN (CLIENT ENGINE)
   ========================================================================== */

let _wellnessCache = {
  today: null,
  todayFetchedAt: 0,
  history: {},
  historyFetchedAt: {}
};

/**
 * Carga el contexto de bienestar fisiológico de hoy (/api/wellness/today).
 * No bloqueante, con manejo limpio de caché y estados.
 */
async function loadWellnessToday(force = false) {
  const now = Date.now();
  if (!force && _wellnessCache.today && (now - _wellnessCache.todayFetchedAt < 90000)) {
    renderWellnessTodayDashboard(_wellnessCache.today);
    return;
  }

  try {
    const res = await fetch(`/api/wellness/today?sync=${force ? 'true' : 'false'}`);
    if (!res.ok) {
      console.warn("[Wellness] /api/wellness/today returned", res.status);
      return;
    }
    const data = await res.json();
    if (data.status === "ok") {
      _wellnessCache.today = data;
      _wellnessCache.todayFetchedAt = now;
      state.wellnessToday = data;
      renderWellnessTodayDashboard(data);
    }
  } catch (err) {
    console.error("[Wellness] Error fetching today wellness:", err);
  }
}

/**
 * Renderiza las 4 tarjetas del Dashboard de Inicio:
 * 1. Sueño, 2. Pasos, 3. Recuperación, 4. Estado Diario (Readiness).
 */
function renderWellnessTodayDashboard(data) {
  if (!data) return;
  const w = data.wellness || {};
  const b = data.baselines || {};
  const r = data.readiness || {};
  const chk = data.checkin || {};
  const bSleep = b.sleep || {};
  const bMob = b.mobility || {};
  const bRec = b.recovery || {};

  // --- TARJETA 1: SUEÑO ---
  const elSleepDuration = document.getElementById("wellness-dash-sleep-duration");
  const elSleepScore = document.getElementById("wellness-dash-sleep-score");
  const elSleepDiff = document.getElementById("wellness-dash-sleep-diff");
  const elSleepDeep = document.getElementById("wellness-dash-sleep-deep");
  const elSleepLight = document.getElementById("wellness-dash-sleep-light");
  const elSleepRem = document.getElementById("wellness-dash-sleep-rem");

  if (elSleepDuration) {
    if (w.sleep_total_sec != null && Number(w.sleep_total_sec) > 0) {
      const h = Math.floor(w.sleep_total_sec / 3600);
      const m = Math.floor((w.sleep_total_sec % 3600) / 60);
      elSleepDuration.textContent = `${h}h ${m.toString().padStart(2, "0")}m`;
    } else {
      elSleepDuration.textContent = data.day_status === "unavailable" ? "Sin datos" : "Pendiente";
    }
  }

  if (elSleepScore) {
    if (w.sleep_score != null) {
      elSleepScore.textContent = `${w.sleep_score} / 100`;
      elSleepScore.className = `pill-tag tabular-num ${w.sleep_score >= 80 ? "orange" : ""}`;
    } else {
      elSleepScore.textContent = "Sin datos";
      elSleepScore.className = "pill-tag tabular-num";
    }
  }

  if (elSleepDiff) {
    if (w.sleep_total_sec != null && bSleep.avg_hours_7d != null) {
      const curH = w.sleep_total_sec / 3600;
      const diffMin = Math.round((curH - bSleep.avg_hours_7d) * 60);
      const sign = diffMin >= 0 ? "+" : "";
      elSleepDiff.textContent = `${sign}${diffMin} min vs media 7d (${bSleep.avg_hours_7d.toFixed(1)}h)`;
      elSleepDiff.style.color = diffMin >= 0 ? "var(--stitch-success)" : "var(--text-secondary)";
    } else {
      elSleepDiff.textContent = bSleep.avg_hours_7d != null ? `Media 7d: ${bSleep.avg_hours_7d.toFixed(1)}h` : "Sin línea base 7d";
      elSleepDiff.style.color = "var(--text-secondary)";
    }
  }

  function _fmtMin(sec) {
    if (sec == null) return "—";
    const m = Math.round(Number(sec) / 60);
    const h = Math.floor(m / 60);
    const remM = m % 60;
    return h > 0 ? `${h}h ${remM}m` : `${remM}m`;
  }

  if (elSleepDeep) elSleepDeep.textContent = _fmtMin(w.deep_sleep_sec);
  if (elSleepLight) elSleepLight.textContent = _fmtMin(w.light_sleep_sec);
  if (elSleepRem) elSleepRem.textContent = _fmtMin(w.rem_sleep_sec);

  // --- TARJETA 2: PASOS & MOVILIDAD ---
  const elStepsCount = document.getElementById("wellness-dash-steps-count");
  const elStepsGoalSub = document.getElementById("wellness-dash-steps-goal-sub");
  const elStepsPct = document.getElementById("wellness-dash-steps-pct");
  const elStepsBar = document.getElementById("wellness-dash-steps-bar");
  const elStepsDiff = document.getElementById("wellness-dash-steps-diff");
  const elStepsDist = document.getElementById("wellness-dash-steps-dist");
  const elStepsFloors = document.getElementById("wellness-dash-steps-floors");
  const elStepsNonSport = document.getElementById("wellness-dash-steps-non-sport");

  const stepsVal = w.steps;
  const goalVal = w.step_goal || 10000;

  if (elStepsCount) {
    elStepsCount.textContent = stepsVal != null ? Number(stepsVal).toLocaleString("es-ES") : (data.day_status === "unavailable" ? "Sin datos" : "Pendiente");
  }
  if (elStepsGoalSub) {
    elStepsGoalSub.textContent = `/ ${Number(goalVal).toLocaleString("es-ES")} meta`;
  }
  if (elStepsPct) {
    if (stepsVal != null) {
      const pct = Math.round((stepsVal / goalVal) * 100);
      elStepsPct.textContent = `${pct}%`;
      elStepsPct.className = `pill-tag tabular-num ${pct >= 100 ? "orange" : ""}`;
    } else {
      elStepsPct.textContent = "—";
      elStepsPct.className = "pill-tag tabular-num";
    }
  }
  if (elStepsBar) {
    const pct = stepsVal != null ? Math.min(100, Math.round((stepsVal / goalVal) * 100)) : 0;
    elStepsBar.style.width = `${pct}%`;
    elStepsBar.style.background = pct >= 100 ? "var(--stitch-success)" : "var(--accent-orange)";
  }
  if (elStepsDiff) {
    if (stepsVal != null && bMob.avg_steps_7d != null) {
      const diffSteps = stepsVal - bMob.avg_steps_7d;
      const sign = diffSteps >= 0 ? "+" : "";
      elStepsDiff.textContent = `${sign}${Number(diffSteps).toLocaleString("es-ES")} vs media 7d (${Number(bMob.avg_steps_7d).toLocaleString("es-ES")})`;
      elStepsDiff.style.color = diffSteps >= 0 ? "var(--stitch-success)" : "var(--text-secondary)";
    } else {
      elStepsDiff.textContent = bMob.avg_steps_7d != null ? `Media 7d: ${Number(bMob.avg_steps_7d).toLocaleString("es-ES")} pasos` : "Sin línea base 7d";
      elStepsDiff.style.color = "var(--text-secondary)";
    }
  }
  if (elStepsDist) {
    elStepsDist.textContent = w.steps_distance_m != null ? `${(Number(w.steps_distance_m) / 1000).toFixed(1)} km` : "—";
  }
  if (elStepsFloors) {
    elStepsFloors.textContent = w.floors_climbed != null ? `${Math.round(Number(w.floors_climbed))} pisos` : "—";
  }
  if (elStepsNonSport) {
    if (bMob.avg_non_sport_steps_7d != null) {
      elStepsNonSport.textContent = `${Number(bMob.avg_non_sport_steps_7d).toLocaleString("es-ES")}`;
    } else {
      elStepsNonSport.textContent = "—";
    }
  }

  // --- TARJETA 3: RECUPERACIÓN FISIOLÓGICA ---
  const elHrvVal = document.getElementById("wellness-dash-hrv-val");
  const elHrvStatus = document.getElementById("wellness-dash-hrv-status");
  const elHrvBaseline = document.getElementById("wellness-dash-hrv-baseline");
  const elRhrVal = document.getElementById("wellness-dash-rhr-val");
  const elBbVal = document.getElementById("wellness-dash-bb-val");
  const elStressVal = document.getElementById("wellness-dash-stress-val");

  if (elHrvVal) {
    elHrvVal.textContent = w.hrv_last_night != null ? `${Math.round(w.hrv_last_night)} ms` : (data.day_status === "unavailable" ? "Sin datos" : "Pendiente");
  }
  if (elHrvStatus) {
    const statusText = w.hrv_status_garmin || (w.hrv_last_night ? "Equilibrada" : "Sin datos");
    elHrvStatus.textContent = statusText;
    elHrvStatus.className = `pill-tag tabular-num ${w.hrv_last_night ? "orange" : ""}`;
  }
  if (elHrvBaseline) {
    if (bRec.hrv_baseline_28d != null) {
      const base = Math.round(bRec.hrv_baseline_28d);
      const std = bRec.hrv_std_28d ? Math.round(bRec.hrv_std_28d * 0.75) : 4;
      elHrvBaseline.textContent = `Banda basal 28d: ${base - std}–${base + std} ms`;
    } else {
      elHrvBaseline.textContent = "Banda basal 28d: Pendiente";
    }
  }
  if (elRhrVal) {
    elRhrVal.textContent = w.resting_hr != null ? `${Math.round(w.resting_hr)} ppm` : "—";
  }
  if (elBbVal) {
    const curBb = w.body_battery_most_recent ?? w.body_battery_actual;
    const maxBb = w.body_battery_max;
    if (curBb != null && maxBb != null) {
      elBbVal.textContent = `${curBb} / ${maxBb}`;
    } else if (curBb != null) {
      elBbVal.textContent = `${curBb}`;
    } else if (maxBb != null) {
      elBbVal.textContent = `Máx ${maxBb}`;
    } else {
      elBbVal.textContent = "—";
    }
  }
  if (elStressVal) {
    elStressVal.textContent = w.stress_avg != null ? `${Math.round(w.stress_avg)} / 100` : "—";
  }

  // --- TARJETA 4: ESTADO DIARIO (READINESS ENGINE) ---
  const elBadge = document.getElementById("wellness-dash-readiness-badge");
  const elRecTitle = document.getElementById("wellness-dash-rec-title");
  const elRecText = document.getElementById("wellness-dash-rec-text");
  const elReasons = document.getElementById("wellness-dash-reasons");
  const elConf = document.getElementById("wellness-dash-confidence");

  const estado = r.estado || "DATOS INSUFICIENTES";
  const estadoClassMap = {
    "LISTO": "readiness-listo",
    "PRECAUCIÓN": "readiness-precaucion",
    "RECUPERACIÓN": "readiness-recuperacion",
    "DESCANSO": "readiness-descanso",
    "DATOS INSUFICIENTES": "readiness-insuficiente"
  };

  if (elBadge) {
    elBadge.textContent = estado;
    elBadge.className = `pill-tag pill-readiness tabular-num ${estadoClassMap[estado] || "readiness-insuficiente"}`;
  }

  if (elRecTitle) {
    const titles = {
      "LISTO": "Condición favorable para asimilar entrenamiento",
      "PRECAUCIÓN": "Fatiga moderada detectada: modula la intensidad",
      "RECUPERACIÓN": "Signos fisiológicos de estrés: sesión suave sugerida",
      "DESCANSO": "Sobrecarga acumulada: prioridad a la recuperación",
      "DATOS INSUFICIENTES": "Datos fisiológicos pendientes"
    };
    elRecTitle.textContent = titles[estado] || "Estado del día";
  }

  if (elRecText) {
    elRecText.textContent = r.recomendacion || "Sincroniza tu reloj Garmin tras levantarte para una recomendación fundamentada.";
  }

  if (elReasons && Array.isArray(r.motivos_principales)) {
    if (r.motivos_principales.length > 0) {
      elReasons.innerHTML = r.motivos_principales.map(m => `<li>${_escHtml(m)}</li>`).join("");
    } else {
      elReasons.innerHTML = "<li>Línea base fisiológica en curso.</li>";
    }
  }

  if (elConf) {
    const conf = r.confianza ? r.confianza.toUpperCase() : "BAJA";
    elConf.textContent = `Confianza: ${conf}`;
  }
}

/**
 * Inicializa eventos del modal de Check-in diario (escala 1 a 5).
 */
function initWellnessCheckinEvents() {
  document.querySelectorAll(".checkin-scale-buttons").forEach(group => {
    const metric = group.dataset.metric;
    const badge = document.getElementById(`checkin-val-${metric === "sleep_quality" ? "sleep" : (metric === "muscle_fatigue" ? "fatigue" : (metric === "perceived_stress" ? "stress" : (metric === "general_feeling" ? "feeling" : metric)))}`);

    group.querySelectorAll(".checkin-btn-scale").forEach(btn => {
      btn.addEventListener("click", () => {
        group.querySelectorAll(".checkin-btn-scale").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        const val = btn.dataset.val;
        const sub = btn.querySelector("small") ? btn.querySelector("small").textContent : "";
        if (badge) badge.textContent = `${val}/5 · ${sub}`;
      });
    });
  });
}

/**
 * Abre el modal de check-in diario preseleccionando datos si ya existen.
 */
function openWellnessCheckinModal(dateStr) {
  const modal = document.getElementById("wellness-checkin-modal");
  if (!modal) return;

  const todayStr = (dateStr || new Date().toISOString()).slice(0, 10);
  const dateInput = document.getElementById("checkin-input-date");
  if (dateInput) dateInput.value = todayStr;

  const existing = state.wellnessToday?.checkin || {};
  const metrics = [
    { key: "energy", tag: "energy" },
    { key: "sleep_quality", tag: "sleep" },
    { key: "muscle_fatigue", tag: "fatigue" },
    { key: "perceived_stress", tag: "stress" },
    { key: "general_feeling", tag: "feeling" }
  ];

  metrics.forEach(m => {
    const group = document.querySelector(`.checkin-scale-buttons[data-metric="${m.key}"]`);
    const badge = document.getElementById(`checkin-val-${m.tag}`);
    const val = existing[m.key];
    if (group) {
      group.querySelectorAll(".checkin-btn-scale").forEach(b => {
        if (val && b.dataset.val === String(val)) {
          b.classList.add("active");
          const sub = b.querySelector("small") ? b.querySelector("small").textContent : "";
          if (badge) badge.textContent = `${val}/5 · ${sub}`;
        } else if (!val) {
          b.classList.remove("active");
          if (badge) badge.textContent = "—";
        }
      });
    }
  });

  const disInput = document.getElementById("checkin-input-discomfort");
  if (disInput) disInput.value = existing.physical_discomfort || "";

  const notesInput = document.getElementById("checkin-input-notes");
  if (notesInput) notesInput.value = existing.notes || "";

  modal.style.display = "flex";
}

function closeWellnessCheckinModal() {
  const modal = document.getElementById("wellness-checkin-modal");
  if (modal) modal.style.display = "none";
}

/**
 * Procesa el envío del check-in diario (POST /api/wellness/checkin).
 */
async function handleWellnessCheckinSubmit(event) {
  if (event) event.preventDefault();
  const dateInput = document.getElementById("checkin-input-date");
  const dateStr = dateInput ? dateInput.value : new Date().toISOString().slice(0, 10);

  function _getActive(metric) {
    const active = document.querySelector(`.checkin-scale-buttons[data-metric="${metric}"] .checkin-btn-scale.active`);
    return active ? parseInt(active.dataset.val, 10) : null;
  }

  const payload = {
    date: dateStr,
    energy: _getActive("energy"),
    sleep_quality: _getActive("sleep_quality"),
    muscle_fatigue: _getActive("muscle_fatigue"),
    perceived_stress: _getActive("perceived_stress"),
    general_feeling: _getActive("general_feeling"),
    physical_discomfort: document.getElementById("checkin-input-discomfort")?.value.trim() || null,
    notes: document.getElementById("checkin-input-notes")?.value.trim() || null
  };

  const btn = document.getElementById("btn-save-wellness-checkin");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Guardando...";
  }

  try {
    const res = await fetch("/api/wellness/checkin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error("Error en servidor al guardar check-in");
    const data = await res.json();
    if (data.status === "ok") {
      closeWellnessCheckinModal();
      showSuccessBanner("✅ Check-in diario guardado correctamente.");
      // Actualizar estado local inmediatamente
      if (state.wellnessToday) {
        state.wellnessToday.checkin = data.checkin;
        state.wellnessToday.readiness = data.readiness;
        renderWellnessTodayDashboard(state.wellnessToday);
      }
      // Invalidar cache de histórico
      _wellnessCache.history = {};
      loadWellnessToday(true);
    }
  } catch (err) {
    console.error("[Wellness] Error saving checkin:", err);
    showSuccessBanner("⚠️ No se pudo guardar el check-in diario.");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Guardar Check-in";
    }
  }
}

/**
 * Sincroniza telemetría de bienestar desde Garmin Connect (POST /api/wellness/sync).
 */
async function syncWellnessData(event) {
  if (event) event.preventDefault();
  const btn = document.getElementById("btn-sync-wellness-dash");
  const label = document.getElementById("btn-sync-wellness-label");
  if (btn) btn.disabled = true;
  if (label) label.textContent = "Sincronizando...";

  showSuccessBanner("🔄 Sincronizando sueño, pasos y HRV con Garmin Connect...");

  try {
    const res = await fetch("/api/wellness/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ days: 14, force: true })
    });
    if (!res.ok) throw new Error("Error en sincronización de bienestar");
    const data = await res.json();
    const syn = data.sync || {};
    if (syn.status === "not_connected") {
      showSuccessBanner("⚠️ Garmin Connect no está conectado. Conecta tu cuenta en Perfil para sincronizar telemetría.");
      const dashDisBanner = document.getElementById("wellness-dash-disconnected-banner");
      if (dashDisBanner) dashDisBanner.style.display = "flex";
    } else {
      const count = syn.days_synced ?? syn.synced_days ?? 0;
      showSuccessBanner(`✅ Bienestar sincronizado: ${count} días actualizados de Garmin.`);
    }
    _wellnessCache.today = null;
    _wellnessCache.history = {};
    await loadWellnessToday(true);
    if (state.wellnessHistoryDays) {
      await loadWellnessHistory(state.wellnessHistoryDays, true);
    }
  } catch (err) {
    console.error("[Wellness] Sync error:", err);
    showSuccessBanner("⚠️ No se pudo sincronizar el bienestar con Garmin.");
  } finally {
    if (btn) btn.disabled = false;
    if (label) label.textContent = "Sincronizar";
  }
}

/**
 * Selecciona el periodo de análisis (7, 14, 28 días).
 */
function selectWellnessPeriod(days, btn) {
  state.wellnessHistoryDays = days;
  document.querySelectorAll("#wellness-period-pills .stride-period-pill").forEach(p => p.classList.remove("active"));
  if (btn) btn.classList.add("active");
  loadWellnessHistory(days, false);
}

/**
 * Carga el histórico de bienestar (/api/wellness/history?days=X).
 */
async function loadWellnessHistory(days = 28, force = false) {
  const boundedDays = Math.max(1, Math.min(days || 28, 90));
  const now = Date.now();
  if (!force && _wellnessCache.history[boundedDays] && (now - (_wellnessCache.historyFetchedAt[boundedDays] || 0) < 120000)) {
    renderWellnessHistoryViews(_wellnessCache.history[boundedDays]);
    return;
  }

  try {
    const res = await fetch(`/api/wellness/history?days=${boundedDays}`);
    if (!res.ok) {
      console.warn("[Wellness] /api/wellness/history error:", res.status);
      return;
    }
    const data = await res.json();
    if (data.status === "ok") {
      _wellnessCache.history[boundedDays] = data;
      _wellnessCache.historyFetchedAt[boundedDays] = now;
      state.wellnessHistory = data;
      renderWellnessHistoryViews(data);
    }
  } catch (err) {
    console.error("[Wellness] Error fetching wellness history:", err);
  }
}

/**
 * Renderiza los 4 bloques de la sección de Análisis de Bienestar en Summit:
 * A. Sueño, B. Movilidad, C. Recuperación, D. Lectura Coach IA.
 */
function renderWellnessHistoryViews(histData) {
  if (!histData) return;
  const history = Array.isArray(histData.history) ? histData.history : [];
  const baselines = histData.baselines || {};
  const bSleep = baselines.sleep || {};
  const bMob = baselines.mobility || {};
  const bRec = baselines.recovery || {};

  // --- BLOQUE A: SUEÑO ---
  const elSleepAvgHours = document.getElementById("wellness-sleep-avg-hours");
  const elSleepAvgScore = document.getElementById("wellness-sleep-avg-score");
  const elSleepReg = document.getElementById("wellness-sleep-regularity");
  const elSleep7d = document.getElementById("wellness-sleep-7d");
  const elSleep28d = document.getElementById("wellness-sleep-28d");
  const elSleepSched = document.getElementById("wellness-sleep-schedule");

  if (elSleepAvgHours) {
    elSleepAvgHours.textContent = bSleep.avg_hours_28d != null ? `${bSleep.avg_hours_28d.toFixed(1)} h` : (bSleep.avg_hours_7d != null ? `${bSleep.avg_hours_7d.toFixed(1)} h` : "—");
  }
  if (elSleepAvgScore) {
    elSleepAvgScore.textContent = bSleep.avg_score_28d != null ? `${Math.round(bSleep.avg_score_28d)}` : (bSleep.avg_score_7d != null ? `${Math.round(bSleep.avg_score_7d)}` : "—");
  }
  if (elSleepReg) {
    const regMap = { "alta": "Alta", "moderada": "Moderada", "irregular": "Irregular" };
    elSleepReg.textContent = regMap[bSleep.schedule_regularity_label] || "—";
  }
  if (elSleep7d) elSleep7d.textContent = bSleep.avg_hours_7d != null ? `${bSleep.avg_hours_7d.toFixed(1)} h` : "—";
  if (elSleep28d) elSleep28d.textContent = bSleep.avg_hours_28d != null ? `${bSleep.avg_hours_28d.toFixed(1)} h` : "—";

  // Horario medio si hay días con sleep_start_local / sleep_end_local
  if (elSleepSched) {
    const daysWithSched = history.filter(d => d.sleep_start_local && d.sleep_end_local);
    if (daysWithSched.length > 0) {
      const last = daysWithSched[daysWithSched.length - 1];
      const startT = (last.sleep_start_local || "").slice(11, 16);
      const endT = (last.sleep_end_local || "").slice(11, 16);
      elSleepSched.textContent = startT && endT ? `${startT} → ${endT}` : "—";
    } else {
      elSleepSched.textContent = "—";
    }
  }

  // Fases apiladas
  let totDeep = 0, totLight = 0, totRem = 0, totAwake = 0, countStages = 0;
  history.forEach(d => {
    if (d.deep_sleep_sec || d.light_sleep_sec || d.rem_sleep_sec) {
      totDeep += Number(d.deep_sleep_sec || 0);
      totLight += Number(d.light_sleep_sec || 0);
      totRem += Number(d.rem_sleep_sec || 0);
      totAwake += Number(d.awake_sec || 0);
      countStages++;
    }
  });

  const sumStages = totDeep + totLight + totRem + totAwake;
  const elStgDeep = document.getElementById("stage-deep");
  const elStgLight = document.getElementById("stage-light");
  const elStgRem = document.getElementById("stage-rem");
  const elStgAwake = document.getElementById("stage-awake");
  const elLegDeep = document.getElementById("legend-deep-val");
  const elLegLight = document.getElementById("legend-light-val");
  const elLegRem = document.getElementById("legend-rem-val");
  const elLegAwake = document.getElementById("legend-awake-val");

  if (sumStages > 0 && countStages > 0) {
    const pctD = Math.round((totDeep / sumStages) * 100);
    const pctL = Math.round((totLight / sumStages) * 100);
    const pctR = Math.round((totRem / sumStages) * 100);
    const pctA = Math.max(0, 100 - pctD - pctL - pctR);

    if (elStgDeep) elStgDeep.style.width = `${pctD}%`;
    if (elStgLight) elStgLight.style.width = `${pctL}%`;
    if (elStgRem) elStgRem.style.width = `${pctR}%`;
    if (elStgAwake) elStgAwake.style.width = `${pctA}%`;

    const avgD = Math.round(totDeep / countStages / 60);
    const avgL = Math.round(totLight / countStages / 60);
    const avgR = Math.round(totRem / countStages / 60);
    const avgA = Math.round(totAwake / countStages / 60);

    if (elLegDeep) elLegDeep.textContent = `${pctD}% (${avgD}m)`;
    if (elLegLight) elLegLight.textContent = `${pctL}% (${avgL}m)`;
    if (elLegRem) elLegRem.textContent = `${pctR}% (${avgR}m)`;
    if (elLegAwake) elLegAwake.textContent = `${pctA}% (${avgA}m)`;
  } else {
    if (elLegDeep) elLegDeep.textContent = "—";
    if (elLegLight) elLegLight.textContent = "—";
    if (elLegRem) elLegRem.textContent = "—";
    if (elLegAwake) elLegAwake.textContent = "—";
  }

  // Gráfico SVG Sueño
  renderWellnessSleepChart(history);

  // --- BLOQUE B: MOVILIDAD ---
  const elStepsAvg = document.getElementById("wellness-steps-avg");
  const elStepsGoalRate = document.getElementById("wellness-steps-goal-rate");
  const elStepsWow = document.getElementById("wellness-steps-wow");
  const elStepsTotalDist = document.getElementById("wellness-steps-total-dist");
  const elStepsTotalFloors = document.getElementById("wellness-steps-total-floors");
  const elIntensityMins = document.getElementById("wellness-intensity-mins");
  const elStepsNonSportAvg = document.getElementById("wellness-steps-non-sport-avg");

  if (elStepsAvg) {
    elStepsAvg.textContent = bMob.avg_steps_28d != null ? Number(bMob.avg_steps_28d).toLocaleString("es-ES") : (bMob.avg_steps_7d != null ? Number(bMob.avg_steps_7d).toLocaleString("es-ES") : "—");
  }

  let daysWithSteps = 0, daysMetGoal = 0, sumDistM = 0, sumFloors = 0, sumIntMins = 0;
  history.forEach(d => {
    if (d.steps != null && Number(d.steps) > 0) {
      daysWithSteps++;
      if (d.step_goal && Number(d.steps) >= Number(d.step_goal)) {
        daysMetGoal++;
      }
      sumDistM += Number(d.steps_distance_m || 0);
      sumFloors += Number(d.floors_climbed || 0);
      sumIntMins += Number(d.moderate_intensity_min || 0) + Number(d.vigorous_intensity_min || 0);
    }
  });

  if (elStepsGoalRate) {
    if (daysWithSteps > 0) {
      const rate = Math.round((daysMetGoal / daysWithSteps) * 100);
      elStepsGoalRate.textContent = `${rate}% (${daysMetGoal}/${daysWithSteps}d)`;
    } else {
      elStepsGoalRate.textContent = "—";
    }
  }

  if (elStepsWow) {
    if (bMob.avg_steps_7d != null && bMob.avg_steps_prev_7d != null && bMob.avg_steps_prev_7d > 0) {
      const pctChange = Math.round(((bMob.avg_steps_7d - bMob.avg_steps_prev_7d) / bMob.avg_steps_prev_7d) * 100);
      const sign = pctChange >= 0 ? "+" : "";
      elStepsWow.textContent = `${sign}${pctChange}% vs sem. ant.`;
      elStepsWow.style.color = pctChange >= 0 ? "var(--stitch-success)" : "var(--text-secondary)";
    } else {
      elStepsWow.textContent = "—";
      elStepsWow.style.color = "var(--text-secondary)";
    }
  }

  if (elStepsTotalDist) elStepsTotalDist.textContent = `${(sumDistM / 1000).toFixed(1)} km`;
  if (elStepsTotalFloors) elStepsTotalFloors.textContent = `${Math.round(sumFloors)}`;
  if (elIntensityMins) elIntensityMins.textContent = `${Math.round(sumIntMins)} min`;
  if (elStepsNonSportAvg) {
    elStepsNonSportAvg.textContent = bMob.avg_non_sport_steps_7d != null ? `${Number(bMob.avg_non_sport_steps_7d).toLocaleString("es-ES")} / día` : "—";
  }

  // Gráfico SVG Pasos
  renderWellnessStepsChart(history);

  // --- BLOQUE C: RECUPERACIÓN & AUTÓNOMO ---
  const elHrvBase = document.getElementById("wellness-recovery-hrv-baseline");
  const elRhrAvg = document.getElementById("wellness-recovery-rhr-avg");
  const elBbAvg = document.getElementById("wellness-recovery-bb-avg");
  const elStressAvg = document.getElementById("wellness-recovery-stress-avg");
  const elBbChargeDrain = document.getElementById("wellness-recovery-bb-charge-drain");
  const elSpo2Resp = document.getElementById("wellness-recovery-spo2-resp");

  if (elHrvBase) {
    if (bRec.hrv_baseline_28d != null) {
      const base = Math.round(bRec.hrv_baseline_28d);
      const std = bRec.hrv_std_28d ? Math.round(bRec.hrv_std_28d * 0.75) : 4;
      elHrvBase.textContent = `${base} ms (${base - std}–${base + std})`;
    } else {
      elHrvBase.textContent = "—";
    }
  }
  if (elRhrAvg) {
    elRhrAvg.textContent = bRec.resting_hr_avg_7d != null ? `${Math.round(bRec.resting_hr_avg_7d)} ppm` : (bRec.resting_hr_baseline_28d != null ? `${Math.round(bRec.resting_hr_baseline_28d)} ppm` : "—");
  }
  if (elBbAvg) {
    elBbAvg.textContent = bRec.body_battery_max_avg_7d != null ? `${Math.round(bRec.body_battery_max_avg_7d)}` : (bRec.body_battery_max_baseline_28d != null ? `${Math.round(bRec.body_battery_max_baseline_28d)}` : "—");
  }
  if (elStressAvg) {
    elStressAvg.textContent = bRec.stress_avg_7d != null ? `${Math.round(bRec.stress_avg_7d)}` : (bRec.stress_baseline_28d != null ? `${Math.round(bRec.stress_baseline_28d)}` : "—");
  }

  let sumCharge = 0, countCharge = 0;
  history.forEach(d => {
    if (d.body_battery_charged != null && Number(d.body_battery_charged) > 0) {
      sumCharge += Number(d.body_battery_charged);
      countCharge++;
    }
  });
  if (elBbChargeDrain) {
    elBbChargeDrain.textContent = countCharge > 0 ? `+${Math.round(sumCharge / countCharge)} pts/noche` : "—";
  }

  if (elSpo2Resp) {
    const parts = [];
    if (bRec.spo2_avg != null) parts.push(`SpO2 ${bRec.spo2_avg.toFixed(0)}%`);
    if (bRec.respiration_avg != null) parts.push(`Resp. ${bRec.respiration_avg.toFixed(1)} rpm`);
    elSpo2Resp.textContent = parts.length > 0 ? parts.join(" • ") : "Normal";
  }

  // Gráfico SVG Recuperación (HRV + Banda)
  renderWellnessRecoveryChart(history, baselines);

  // --- BLOQUE D: LECTURA DEL ENTRENADOR IA ---
  loadWellnessAnalysisAndAI(false);
}

/**
 * Gráfico SVG de duración de sueño (horas) + sleep score (0-100).
 */
function renderWellnessSleepChart(history) {
  const wrap = document.getElementById("wellness-sleep-chart-svg");
  const tip = document.getElementById("wellness-sleep-tooltip");
  if (!wrap) return;

  if (!history || history.length === 0) {
    wrap.innerHTML = `<div style="display:flex; align-items:center; justify-content:center; height:100%; color:var(--text-secondary); font-size:12px;">Sin registros de sueño en el periodo seleccionado.</div>`;
    return;
  }

  const W = 620, H = 180, padL = 36, padR = 36, padT = 18, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const N = history.length;
  const barW = Math.max(6, Math.min(26, Math.floor(plotW / N) - 4));
  const slotW = plotW / N;

  const maxHours = 10;
  function yH(h) { return padT + plotH - (Math.min(maxHours, Math.max(0, h)) / maxHours) * plotH; }
  function yScore(s) { return padT + plotH - (Math.min(100, Math.max(0, s)) / 100) * plotH; }

  let barsHtml = "";
  let scorePoints = [];

  history.forEach((d, i) => {
    const cx = padL + i * slotW + slotW / 2;
    const durH = d.sleep_total_sec ? Number(d.sleep_total_sec) / 3600 : null;
    const isComplete = d.day_status === "complete";

    if (durH != null && durH > 0) {
      const topY = yH(durH);
      const bHeight = Math.max(2, padT + plotH - topY);
      const x = cx - barW / 2;
      const fill = isComplete ? "var(--accent-orange)" : "rgba(238, 90, 43, 0.35)";
      const stroke = isComplete ? "none" : "var(--accent-orange)";
      const strokeDash = isComplete ? "none" : "2,2";

      barsHtml += `
        <rect class="wellness-chart-bar" x="${x.toFixed(1)}" y="${topY.toFixed(1)}" width="${barW}" height="${bHeight.toFixed(1)}"
              rx="3" fill="${fill}" stroke="${stroke}" stroke-dasharray="${strokeDash}" stroke-width="1.2"
              data-date="${d.date}" data-hours="${durH.toFixed(2)}" data-score="${d.sleep_score ?? ''}"
              data-status="${isComplete ? 'Completo' : 'Incompleto / En curso'}" style="cursor:pointer; transition:opacity 0.15s ease;">
        </rect>
      `;
    }

    if (d.sleep_score != null && Number(d.sleep_score) > 0) {
      scorePoints.push({ x: cx, y: yScore(Number(d.sleep_score)), score: Number(d.sleep_score), date: d.date });
    }
  });

  // Línea de Score
  let scoreLinePath = "";
  let scoreDotsHtml = "";
  if (scorePoints.length >= 2) {
    scoreLinePath = "M " + scorePoints.map(p => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" L ");
  }
  scorePoints.forEach(p => {
    scoreDotsHtml += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="#00AEEF" stroke="#FFFFFF" stroke-width="1.2"></circle>`;
  });

  // Ejes X etiquetas
  let xLabelsHtml = "";
  const step = Math.max(1, Math.floor(N / 7));
  for (let i = 0; i < N; i += step) {
    const d = history[i];
    const cx = padL + i * slotW + slotW / 2;
    const dayLabel = d.date ? d.date.slice(8, 10) + "/" + d.date.slice(5, 7) : "";
    xLabelsHtml += `<text x="${cx.toFixed(1)}" y="${H - 6}" font-size="9" fill="var(--text-muted)" text-anchor="middle" font-family="var(--font-mono)">${dayLabel}</text>`;
  }

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%; height:100%; overflow:visible;">
      <!-- Grid horizontal -->
      <line x1="${padL}" y1="${yH(7)}" x2="${W - padR}" y2="${yH(7)}" stroke="var(--border-default)" stroke-dasharray="3,3" stroke-width="1"/>
      <text x="${padL - 4}" y="${yH(7) + 3}" font-size="9" fill="var(--text-muted)" text-anchor="end" font-family="var(--font-mono)">7h</text>
      
      <line x1="${padL}" y1="${yH(8)}" x2="${W - padR}" y2="${yH(8)}" stroke="var(--border-default)" stroke-dasharray="3,3" stroke-width="1"/>
      <text x="${padL - 4}" y="${yH(8) + 3}" font-size="9" fill="var(--text-muted)" text-anchor="end" font-family="var(--font-mono)">8h</text>

      <!-- Eje derecho score -->
      <text x="${W - padR + 6}" y="${yScore(80) + 3}" font-size="9" fill="#00AEEF" text-anchor="start" font-family="var(--font-mono)">80</text>

      <!-- Barras de sueño -->
      ${barsHtml}

      <!-- Línea y puntos de Score -->
      ${scoreLinePath ? `<path d="${scoreLinePath}" fill="none" stroke="#00AEEF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` : ""}
      ${scoreDotsHtml}

      <!-- Eje X -->
      ${xLabelsHtml}
    </svg>
  `;

  // Attach tooltips
  if (tip) {
    wrap.querySelectorAll(".wellness-chart-bar").forEach(el => {
      el.addEventListener("mouseenter", (e) => {
        const dt = el.dataset.date;
        const hrs = Number(el.dataset.hours || 0);
        const sc = el.dataset.score;
        const st = el.dataset.status;
        const h = Math.floor(hrs);
        const m = Math.round((hrs - h) * 60);

        tip.innerHTML = `
          <div style="font-weight:700; font-size:11px; margin-bottom:2px;">${dt} (${st})</div>
          <div style="color:var(--accent-orange); font-weight:600;">Sueño: ${h}h ${m}m</div>
          ${sc ? `<div style="color:#00AEEF; font-size:11px;">Score: ${sc}/100</div>` : ""}
        `;
        tip.style.display = "block";
        const rect = wrap.getBoundingClientRect();
        tip.style.left = `${e.clientX - rect.left + 10}px`;
        tip.style.top = `${e.clientY - rect.top - 20}px`;
      });
      el.addEventListener("mousemove", (e) => {
        const rect = wrap.getBoundingClientRect();
        tip.style.left = `${e.clientX - rect.left + 10}px`;
        tip.style.top = `${e.clientY - rect.top - 20}px`;
      });
      el.addEventListener("mouseleave", () => {
        tip.style.display = "none";
      });
    });
  }
}

/**
 * Gráfico SVG de pasos diarios con línea de objetivo.
 */
function renderWellnessStepsChart(history) {
  const wrap = document.getElementById("wellness-steps-chart-svg");
  const tip = document.getElementById("wellness-steps-tooltip");
  if (!wrap) return;

  if (!history || history.length === 0) {
    wrap.innerHTML = `<div style="display:flex; align-items:center; justify-content:center; height:100%; color:var(--text-secondary); font-size:12px;">Sin registros de pasos en el periodo seleccionado.</div>`;
    return;
  }

  const W = 620, H = 180, padL = 40, padR = 20, padT = 18, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const N = history.length;
  const barW = Math.max(6, Math.min(26, Math.floor(plotW / N) - 4));
  const slotW = plotW / N;

  const maxSteps = Math.max(12000, ...history.map(d => Number(d.steps || 0) * 1.15));
  function yS(s) { return padT + plotH - (Math.min(maxSteps, Math.max(0, s)) / maxSteps) * plotH; }

  let barsHtml = "";
  const avgGoal = Math.round(history.reduce((acc, d) => acc + (d.step_goal || 10000), 0) / N);
  const goalY = yS(avgGoal);

  history.forEach((d, i) => {
    const cx = padL + i * slotW + slotW / 2;
    const steps = d.steps != null ? Number(d.steps) : null;
    const goal = d.step_goal || 10000;
    const isComplete = d.day_status === "complete";

    if (steps != null && steps > 0) {
      const topY = yS(steps);
      const bHeight = Math.max(2, padT + plotH - topY);
      const x = cx - barW / 2;
      const metGoal = steps >= goal;
      const fill = metGoal ? "#15803D" : "var(--accent-orange)";
      const opacity = isComplete ? "1" : "0.55";

      barsHtml += `
        <rect class="wellness-step-bar" x="${x.toFixed(1)}" y="${topY.toFixed(1)}" width="${barW}" height="${bHeight.toFixed(1)}"
              rx="3" fill="${fill}" opacity="${opacity}"
              data-date="${d.date}" data-steps="${steps}" data-goal="${goal}"
              data-dist="${d.steps_distance_m ? (d.steps_distance_m / 1000).toFixed(1) : ''}"
              data-floors="${d.floors_climbed ? Math.round(d.floors_climbed) : ''}"
              data-status="${isComplete ? 'Completo' : 'Incompleto / En curso'}" style="cursor:pointer; transition:opacity 0.15s ease;">
        </rect>
      `;
    }
  });

  // Ejes X etiquetas
  let xLabelsHtml = "";
  const step = Math.max(1, Math.floor(N / 7));
  for (let i = 0; i < N; i += step) {
    const d = history[i];
    const cx = padL + i * slotW + slotW / 2;
    const dayLabel = d.date ? d.date.slice(8, 10) + "/" + d.date.slice(5, 7) : "";
    xLabelsHtml += `<text x="${cx.toFixed(1)}" y="${H - 6}" font-size="9" fill="var(--text-muted)" text-anchor="middle" font-family="var(--font-mono)">${dayLabel}</text>`;
  }

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%; height:100%; overflow:visible;">
      <!-- Línea de Objetivo -->
      <line x1="${padL}" y1="${goalY}" x2="${W - padR}" y2="${goalY}" stroke="var(--text-secondary)" stroke-dasharray="4,4" stroke-width="1.4"/>
      <text x="${padL - 4}" y="${goalY + 3}" font-size="9" fill="var(--text-secondary)" text-anchor="end" font-family="var(--font-mono)">${(avgGoal / 1000).toFixed(0)}k</text>

      <!-- Barras de pasos -->
      ${barsHtml}

      <!-- Eje X -->
      ${xLabelsHtml}
    </svg>
  `;

  // Attach tooltips
  if (tip) {
    wrap.querySelectorAll(".wellness-step-bar").forEach(el => {
      el.addEventListener("mouseenter", (e) => {
        const dt = el.dataset.date;
        const st = Number(el.dataset.steps || 0);
        const gl = Number(el.dataset.goal || 10000);
        const km = el.dataset.dist;
        const fl = el.dataset.floors;
        const stat = el.dataset.status;
        const pct = Math.round((st / gl) * 100);

        tip.innerHTML = `
          <div style="font-weight:700; font-size:11px; margin-bottom:2px;">${dt} (${stat})</div>
          <div style="color:${st >= gl ? '#15803D' : 'var(--accent-orange)'}; font-weight:700;">Pasos: ${st.toLocaleString('es-ES')} (${pct}%)</div>
          ${km ? `<div style="font-size:11px; color:var(--text-secondary);">Distancia: ${km} km</div>` : ""}
          ${fl ? `<div style="font-size:11px; color:var(--text-secondary);">Pisos: ${fl}</div>` : ""}
        `;
        tip.style.display = "block";
        const rect = wrap.getBoundingClientRect();
        tip.style.left = `${e.clientX - rect.left + 10}px`;
        tip.style.top = `${e.clientY - rect.top - 20}px`;
      });
      el.addEventListener("mousemove", (e) => {
        const rect = wrap.getBoundingClientRect();
        tip.style.left = `${e.clientX - rect.left + 10}px`;
        tip.style.top = `${e.clientY - rect.top - 20}px`;
      });
      el.addEventListener("mouseleave", () => {
        tip.style.display = "none";
      });
    });
  }
}

/**
 * Gráfico SVG de recuperación: HRV nocturna vs Banda normal personal de 28 días.
 */
function renderWellnessRecoveryChart(history, baselines) {
  const wrap = document.getElementById("wellness-recovery-chart-svg");
  const tip = document.getElementById("wellness-recovery-tooltip");
  if (!wrap) return;

  if (!history || history.length === 0) {
    wrap.innerHTML = `<div style="display:flex; align-items:center; justify-content:center; height:100%; color:var(--text-secondary); font-size:12px;">Sin registros de HRV en el periodo seleccionado.</div>`;
    return;
  }

  const W = 620, H = 180, padL = 40, padR = 20, padT = 18, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const N = history.length;
  const slotW = plotW / N;

  const validHrvs = history.map(d => Number(d.hrv_last_night)).filter(v => !isNaN(v) && v > 0);
  const baseVal = baselines.recovery?.hrv_baseline_28d;
  const stdVal = baselines.recovery?.hrv_std_28d || 4;

  const minHrv = Math.max(20, Math.min(...(validHrvs.length ? validHrvs : [40]), baseVal ? baseVal - stdVal * 1.8 : 40) - 6);
  const maxHrv = Math.max(...(validHrvs.length ? validHrvs : [70]), baseVal ? baseVal + stdVal * 1.8 : 70) + 6;

  function yHrv(v) { return padT + plotH - ((Math.min(maxHrv, Math.max(minHrv, v)) - minHrv) / (maxHrv - minHrv)) * plotH; }

  // Banda de normalidad (±0.75 SD)
  let bandHtml = "";
  if (baseVal != null) {
    const bandTop = yHrv(baseVal + stdVal * 0.75);
    const bandBottom = yHrv(baseVal - stdVal * 0.75);
    const bandH = Math.max(4, bandBottom - bandTop);
    const baseLineY = yHrv(baseVal);

    bandHtml = `
      <rect x="${padL}" y="${bandTop.toFixed(1)}" width="${plotW}" height="${bandH.toFixed(1)}"
            fill="rgba(238, 90, 43, 0.12)" stroke="rgba(238, 90, 43, 0.3)" stroke-width="1"/>
      <line x1="${padL}" y1="${baseLineY.toFixed(1)}" x2="${W - padR}" y2="${baseLineY.toFixed(1)}"
            stroke="var(--accent-orange)" stroke-dasharray="3,3" stroke-width="1.2" opacity="0.8"/>
      <text x="${padL - 4}" y="${baseLineY.toFixed(1) + 3}" font-size="9" fill="var(--accent-orange)" text-anchor="end" font-family="var(--font-mono)">${Math.round(baseVal)}</text>
    `;
  }

  // Puntos y línea HRV
  const pts = [];
  history.forEach((d, i) => {
    const cx = padL + i * slotW + slotW / 2;
    const v = d.hrv_last_night != null ? Number(d.hrv_last_night) : null;
    if (v != null && v > 0) {
      pts.push({ x: cx, y: yHrv(v), val: v, date: d.date, rhr: d.resting_hr, stress: d.stress_avg });
    }
  });

  let hrvLinePath = "";
  let hrvDotsHtml = "";
  if (pts.length >= 2) {
    hrvLinePath = "M " + pts.map(p => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" L ");
  }

  pts.forEach(p => {
    let dotColor = "var(--accent-orange)";
    if (baseVal != null) {
      const topBand = baseVal + stdVal * 0.75;
      const btmBand = baseVal - stdVal * 0.75;
      if (p.val < btmBand || p.val > topBand) dotColor = "#BA1A1A";
    }
    hrvDotsHtml += `
      <circle class="wellness-hrv-dot" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" fill="${dotColor}" stroke="#FFFFFF" stroke-width="1.5"
              data-date="${p.date}" data-hrv="${p.val}" data-rhr="${p.rhr || ''}" data-stress="${p.stress || ''}"
              style="cursor:pointer; transition:transform 0.15s ease;">
      </circle>
    `;
  });

  // Ejes X etiquetas
  let xLabelsHtml = "";
  const step = Math.max(1, Math.floor(N / 7));
  for (let i = 0; i < N; i += step) {
    const d = history[i];
    const cx = padL + i * slotW + slotW / 2;
    const dayLabel = d.date ? d.date.slice(8, 10) + "/" + d.date.slice(5, 7) : "";
    xLabelsHtml += `<text x="${cx.toFixed(1)}" y="${H - 6}" font-size="9" fill="var(--text-muted)" text-anchor="middle" font-family="var(--font-mono)">${dayLabel}</text>`;
  }

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%; height:100%; overflow:visible;">
      <!-- Banda basal de 28 días -->
      ${bandHtml}

      <!-- Línea HRV -->
      ${hrvLinePath ? `<path d="${hrvLinePath}" fill="none" stroke="var(--accent-orange)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` : ""}
      
      <!-- Puntos HRV -->
      ${hrvDotsHtml}

      <!-- Eje X -->
      ${xLabelsHtml}
    </svg>
  `;

  // Attach tooltips
  if (tip) {
    wrap.querySelectorAll(".wellness-hrv-dot").forEach(el => {
      el.addEventListener("mouseenter", (e) => {
        const dt = el.dataset.date;
        const hrv = el.dataset.hrv;
        const rhr = el.dataset.rhr;
        const str = el.dataset.stress;

        tip.innerHTML = `
          <div style="font-weight:700; font-size:11px; margin-bottom:2px;">${dt}</div>
          <div style="color:var(--accent-orange); font-weight:700;">HRV nocturna: ${hrv} ms</div>
          ${rhr ? `<div style="font-size:11px; color:var(--text-secondary);">FC Reposo: ${rhr} ppm</div>` : ""}
          ${str ? `<div style="font-size:11px; color:var(--text-secondary);">Estrés medio: ${str}/100</div>` : ""}
        `;
        tip.style.display = "block";
        const rect = wrap.getBoundingClientRect();
        tip.style.left = `${e.clientX - rect.left + 10}px`;
        tip.style.top = `${e.clientY - rect.top - 20}px`;
      });
      el.addEventListener("mousemove", (e) => {
        const rect = wrap.getBoundingClientRect();
        tip.style.left = `${e.clientX - rect.left + 10}px`;
        tip.style.top = `${e.clientY - rect.top - 20}px`;
      });
      el.addEventListener("mouseleave", () => {
        tip.style.display = "none";
      });
    });
  }
}

/**
 * Carga o actualiza la interpretación de Gemini para Bienestar y Recuperación.
 */
async function loadWellnessAnalysisAndAI(force = false) {
  const contentEl = document.getElementById("wellness-ai-content");
  const refreshBtn = document.getElementById("wellness-ai-refresh-btn");
  if (!contentEl) return;

  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.textContent = "Analizando...";
  }

  try {
    const res = await fetch(`/api/wellness/readiness?include_ai=true${force ? '&sync=true' : ''}`);
    if (!res.ok) throw new Error("Error en lectura IA");
    const data = await res.json();
    const interp = data.readiness?.ai_interpretation || data.ai_interpretation;

    if (interp) {
      const p1 = interp.impacto_entrenamiento || interp.correlacion_sueno_hrv || "";
      const p2 = interp.recomendacion_movilidad || interp.resumen || "";
      const p3 = interp.aviso_fisiologico ? `<strong>Nota técnica:</strong> ${_escHtml(interp.aviso_fisiologico)}` : "";

      contentEl.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:8px;">
          ${p1 ? `<p style="margin:0; font-size:0.86rem; line-height:1.5;">${_escHtml(p1)}</p>` : ""}
          ${p2 ? `<p style="margin:0; font-size:0.86rem; line-height:1.5;">${_escHtml(p2)}</p>` : ""}
          ${p3 ? `<p style="margin:0; font-size:0.80rem; opacity:0.8; line-height:1.4;">${p3}</p>` : ""}
        </div>
      `;
    } else {
      contentEl.innerHTML = `
        <p class="stride-ai-summary">
          Basado en tu telemetría reciente de Garmin Connect, tu recuperación autónoma y tu volumen de actividad se encuentran en equilibrio fisiológico.
          Prioriza regularidad en el descanso nocturno para sostener la progresión ascendente de tus entrenamientos.
        </p>
      `;
    }
  } catch (err) {
    console.error("[Wellness] Error loading AI analysis:", err);
    contentEl.innerHTML = `
      <p class="stride-ai-summary" style="opacity:0.8;">
        Telemetría fisiológica registrada correctamente. Tus métricas basales de sueño y HRV se monitorizan para evaluar la asimilación del entrenamiento.
      </p>
    `;
  } finally {
    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.textContent = "Actualizar";
    }
  }
}

let _flyoverScriptsPromise = null;
function _loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Error cargando ${src}`));
    document.head.appendChild(s);
  });
}

async function launchActivityFlyover3D() {
  if (!_currentDetailActivity || !_currentDetailActivity.polyline || _currentDetailActivity.polyline.length < 2) {
    showSuccessBanner("⚠️ Esta actividad no dispone de trazado GPS.");
    return;
  }
  const btn = document.getElementById("btn-play-flyover-3d");
  if (btn) {
    btn.disabled = true;
    btn.querySelector("span").textContent = "Cargando 3D...";
  }
  try {
    if (!_flyoverScriptsPromise) {
      _flyoverScriptsPromise = _loadScriptOnce("/flyover-engine.js?v=133")
        .then(() => _loadScriptOnce("/flyover-3d.js?v=133"));
    }
    await _flyoverScriptsPromise;
    if (window.AaronFlyover3D) {
      await window.AaronFlyover3D.openFlyover3D(_currentDetailActivity);
    }
  } catch (err) {
    console.error("[Flyover 3D] Launch error:", err);
    _flyoverScriptsPromise = null;
    showSuccessBanner("⚠️ No se pudo iniciar el modo Flyover 3D.");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.querySelector("span").textContent = "REPRODUCIR FLYOVER 3D";
    }
  }
}

