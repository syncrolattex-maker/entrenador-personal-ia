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
  if (!document.getElementById("selection-card")) {
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
let chatHistory = [];

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

// Coach Chat DOM
const elCoachChatCard     = document.getElementById("coach-chat-card");
const elChatMessages      = document.getElementById("chat-messages");
const elChatInput         = document.getElementById("chat-input");
const elBtnSendChat       = document.getElementById("btn-send-chat");

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

  // Selection events
  elBtnSelectFuerza.addEventListener("click", () => iniciarGeneracionEntrenamiento("Fuerza"));
  elBtnSelectCarrera.addEventListener("click", () => iniciarGeneracionEntrenamiento("Carrera"));
  elBtnSelectDescanso.addEventListener("click", registrarDescansoHoy);

  const elBtnDiaGris = document.getElementById("btnDiaGris");
  if (elBtnDiaGris) {
    elBtnDiaGris.addEventListener("click", () => iniciarGeneracionEntrenamiento("Fuerza", true));
  }


  // Chat events
  elBtnSendChat.addEventListener("click", enviarMensajeChat);
  elChatInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") enviarMensajeChat();
  });

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
async function initApp() {
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
    if (elRingArc) elRingArc.style.strokeDashoffset = 364; // empty ring while analyzing
    if (elBtnComenzarHoy) elBtnComenzarHoy.style.display = "none";
  }

  cargarPreferenciasGuardadas();

  try {
    // 1. Get database status
    const dbRes = await fetch("/estado-db");
    if (dbRes.ok) { state.db = await dbRes.json(); updateStatsBanner(); }

    // 2. Clear cache if version changed (cache buster)
    const APP_VERSION = "v62"; // Today's workout completed state & smart rest logic








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
  elStatusUltimo.textContent    = state.db.ultimo_entreno || "Ninguno";
  elStatusSiguiente.textContent = state.db.siguiente_bloque || "-";
  const dias = state.db.dias_sin_entrenar || 0;
  elStatusDias.textContent = dias === 0 ? "¡Al día!" : `${dias} ${dias === 1 ? "día" : "días"}`;
  dias > 0 ? elStatusDias.classList.add("highlight") : elStatusDias.classList.remove("highlight");
}

function showLoading(on, text = "Cargando...") {
  elLoadingState.style.display = on ? "flex" : "none";
  elLoadingText.textContent = text;
  if (on) {
    elSelectionCard.style.display = "none";
    elWorkoutCard.style.display = "none";
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
  elSelectionCard.style.display = "flex";
  elWorkoutCard.style.display = "none";
  elLoadingState.style.display = "none";
  if (elCoachChatCard) elCoachChatCard.style.display = "flex";
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

  // Update dynamic readiness score (Weekly Load Balance Score)
  const elPercent = document.getElementById("daily-goal-percent");
  const elRingArc = document.getElementById("daily-ring-arc");
  const score = rec.readiness_score !== undefined ? rec.readiness_score : 80;
  if (elPercent) {
    elPercent.innerHTML = `${score}<small>%</small>`;
  }
  if (elRingArc) {
    const r = 58;
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

  // Show chat card
  if (elCoachChatCard) elCoachChatCard.style.display = "flex";


  // Persistent Chat History loading
  const savedChat = localStorage.getItem("coach_chat_history");
  if (savedChat) {
    try {
      chatHistory = JSON.parse(savedChat);
    } catch(e) {
      chatHistory = [];
    }
  }

  // Check if we should append a new daily recommendation or if history is empty
  const todayStr = new Date().toDateString();
  const lastRecDate = localStorage.getItem("last_rec_chat_date");

  if (lastRecDate !== todayStr || chatHistory.length === 0) {
    chatHistory.push({
      role: "model",
      parts: `¡Hola Aarón! He analizado tu historial de entrenamientos en tu reloj. Para hoy te recomiendo una sesión de **${rec.recomendacion}**.\n\n${rec.razon}\n\n¿Quieres que adaptemos algo de los ejercicios o estás listo para empezar?`
    });
    localStorage.setItem("last_rec_chat_date", todayStr);
    saveChat();
  }
  
  renderChatMessages();
}

// ============================================================
// RENDER WORKOUT CARD
// ============================================================
function renderWorkout(workout) {

  elSelectionCard.style.display = "none";
  elWorkoutCard.style.display = "flex";
  if (elCoachChatCard) elCoachChatCard.style.display = "none";

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

    let stepsHtml = "";
    if (workout.phases && workout.phases.length > 0) {
      stepsHtml = '<div class="watch-steps">';
      workout.phases.forEach(p => {
        const m = Math.floor(p.duration_seconds / 60);
        const s = p.duration_seconds % 60;
        stepsHtml += `
          <div class="watch-step">
            <span class="watch-step-name">${p.name}</span>
            <span class="watch-step-duration">${m}:${String(s).padStart(2,"0")}</span>
          </div>`;
      });
      stepsHtml += "</div>";
    }

    elWorkoutContent.innerHTML = `
      <div class="carrera-container">
        <div class="watch-icon-wrapper">
          <i data-lucide="watch" style="width:40px;height:40px;color:#00E676;"></i>
        </div>
        <h3 class="carrera-title">Carrera Guiada (Estilo Runna)</h3>
        <p class="carrera-instructions" style="margin-top:4px;">
          Bloques estructurados por ritmo y zonas para tu <strong>reloj Garmin</strong>.<br>
          Pulsa <strong>"▶ Comenzar Carrera (Runna)"</strong> para seguir los intervalos con audio-coach y medidor de ritmo.
        </p>
        ${stepsHtml}
      </div>`;

    elWorkoutActions.innerHTML = `
      <button id="btn-empezar-carrera" class="btn btn-primary guided-action-btn carrera" style="background: linear-gradient(135deg, #00E676 0%, #00B0FF 100%); color: #000; border: none;">
        <i data-lucide="play" style="width: 20px; height: 20px;"></i>
        Comenzar Carrera (Runna)
      </button>
      <button id="btn-send-garmin-carrera" class="btn btn-ghost" style="border: 1px solid rgba(0, 174, 239, 0.4); color: #00AEEF; font-weight: 700;" onclick="sendWorkoutToGarminWatch()">
        <i data-lucide="watch" style="width: 18px; height: 18px;"></i>
        ${workout.enviado_al_reloj ? '✅ Enviado a Garmin Connect' : '⌚ Enviar a Garmin Connect'}
      </button>
      <button id="btn-volver" class="btn btn-secondary">
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
        <div class="body-sm" style="color: #FFF; font-weight: 700; margin-top: 4px;">${workedMusclesList}</div>
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
// COACH CHAT LOGIC (AARÓN COACH CHAT)
// ============================================================
function renderChatMessages() {
  elChatMessages.innerHTML = "";
  
  chatHistory.forEach(msg => {
    const isCoach = msg.role === "model";
    const bubble = document.createElement("div");
    bubble.className = `chat-message-bubble ${isCoach ? "coach" : "user"}`;
    // Replace markdown double asterisks with bold and newlines with br
    let formattedText = msg.parts
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
    bubble.innerHTML = formattedText;
    elChatMessages.appendChild(bubble);
  });
  
  // Scroll to bottom
  elChatMessages.scrollTop = elChatMessages.scrollHeight;
}

function saveChat() {
  if (chatHistory.length > 25) {
    chatHistory = chatHistory.slice(-25);
  }
  localStorage.setItem("coach_chat_history", JSON.stringify(chatHistory));
}

async function enviarMensajeChat() {
  const text = elChatInput.value.trim();
  if (!text) return;
  
  elChatInput.value = "";
  
  // 1. Add user message to state, render and save
  chatHistory.push({ role: "user", parts: text });
  renderChatMessages();
  saveChat();
  
  // 2. Show typing indicator
  const indicator = document.createElement("div");
  indicator.className = "chat-typing-indicator";
  indicator.id = "chat-typing-indicator";
  indicator.innerHTML = `
    <span class="chat-typing-dot"></span>
    <span class="chat-typing-dot"></span>
    <span class="chat-typing-dot"></span>
  `;
  elChatMessages.appendChild(indicator);
  elChatMessages.scrollTop = elChatMessages.scrollHeight;
  
  try {
    const res = await fetch("/chat-coach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mensaje: text, historial: chatHistory.slice(0, -1) }) // send history without the last user message to avoid duplication
    });
    
    // Remove typing indicator
    const existingIndicator = document.getElementById("chat-typing-indicator");
    if (existingIndicator) existingIndicator.remove();
    
    if (res.ok) {
      const data = await res.json();
      chatHistory.push({ role: "model", parts: data.respuesta });
      renderChatMessages();
      saveChat();
      
      // Real-time workout reconfiguration from chat!
      if (data.rutina_actualizada) {
        state.currentWorkout = data.rutina_actualizada;
        localStorage.setItem("cached_workout", JSON.stringify(state.currentWorkout));
        localStorage.setItem("cached_workout_date", new Date().toDateString());
        
        renderWorkout(state.currentWorkout);
        showSuccessBanner("✨ Tu Coach IA ha adaptado tu entrenamiento de hoy.");
      }
    } else {
      chatHistory.push({ role: "model", parts: "Disculpa Aarón, he tenido un problema al procesar tu mensaje. ¿Puedes repetirlo?" });
      renderChatMessages();
      saveChat();
    }
  } catch (err) {
    console.error("Chat error:", err);
    const existingIndicator = document.getElementById("chat-typing-indicator");
    if (existingIndicator) existingIndicator.remove();
    
    chatHistory.push({ role: "model", parts: "Aarón, parece que hay un problema de conexión a internet. ¿Lo intentamos de nuevo?" });
    renderChatMessages();
    saveChat();
  }
}

function enviarTextoChat(texto) {
  const elChatInput = document.getElementById("chat-input");
  if (elChatInput) {
    elChatInput.value = texto;
    enviarMensajeChat();
  }
}

function switchTab(tabId) {
  const tabs = document.querySelectorAll(".tab-view");
  tabs.forEach(t => t.classList.remove("active"));
  
  const navBtns = document.querySelectorAll(".nav-tab-btn");
  navBtns.forEach(b => b.classList.remove("active"));
  
  const targetTab = document.getElementById(tabId);
  if (targetTab) targetTab.classList.add("active");
  
  const activeBtn = document.querySelector(`.nav-tab-btn[data-target="${tabId}"]`);
  if (activeBtn) activeBtn.classList.add("active");
  
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
    imgEl.style.background = "#0D1117";
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
      const accent = isCarrera ? "#00E676" : isFuerza ? "#FC5200" : "var(--text-muted)";
      const todayBorder = d.es_hoy ? `border: 1.5px solid ${accent}; background: rgba(255,255,255,0.04);` : "border: 1px solid var(--border-glass); background: var(--surface-dim);";
      const clickable = (isFuerza || isCarrera) ? `onclick="iniciarGeneracionEntrenamiento('${isFuerza ? 'Fuerza' : 'Carrera'}')" style="cursor:pointer; ${todayBorder} border-radius:12px; padding:10px 12px; display:flex; flex-direction:column; gap:4px;"` : `style="${todayBorder} border-radius:12px; padding:10px 12px; display:flex; flex-direction:column; gap:4px;"`;

      html += `
        <div ${clickable}>
          <div style="display:flex; justify-content:space-between; align-items:center; gap:6px;">
            <div style="display:flex; align-items:center; gap:6px;">
              <span class="label-caps" style="color:${accent}; font-size:0.72rem;">${d.dia}${d.es_hoy ? " • HOY" : ""}</span>
              ${d.opcional ? `<span class="label-caps" style="background:rgba(252,82,0,0.16); color:#FF8A50; padding:2px 6px; border-radius:4px; font-size:0.62rem;">OPCIONAL</span>` : ""}
            </div>
            ${d.completado ? `<span class="label-caps" style="color:#00AEEF; font-size:0.68rem;">✓ Garmin</span>` : (d.duracion_min > 0 ? `<span class="body-xs" style="color:var(--text-muted);">${d.duracion_min} min</span>` : "")}
          </div>
          <div style="font-weight:700; font-size:0.9rem; color:#F8FAFC;">${d.titulo}</div>
          <div style="font-size:0.76rem; color:var(--text-secondary);">${d.detalle}</div>
        </div>
      `;
    });
    listEl.innerHTML = html;
  }
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
  } catch (e) {
    console.warn("Summit analytics load failed:", e);
  }
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
      const color = mainSport === "Carrera" ? "#00E676" : mainSport === "Ciclismo" ? "#00AEEF" : mainSport === "Fuerza" ? "#FC5200" : "transparent";
      const size = totalMin > 0 ? Math.min(20, Math.max(7, Math.round(totalMin / 5))) : 0;

      html += `<div class="summit-bubble-cell" title="${item.date}: ${totalMin} min">
        ${size > 0 ? `<div class="summit-bubble-dot" style="width:${size}px; height:${size}px; background:${color}; box-shadow:0 0 8px ${color}55;"></div>` : ""}
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
      <line x1="${pad}" y1="${zeroY.toFixed(1)}" x2="${W - pad}" y2="${zeroY.toFixed(1)}" stroke="rgba(255,255,255,0.12)" stroke-dasharray="3 3"/>
      <path d="${toPath('atl')}" fill="none" stroke="#FC5200" stroke-width="1.8" opacity="0.85"/>
      <path d="${toPath('ctl')}" fill="none" stroke="#00AEEF" stroke-width="2.2"/>
      <path d="${toPath('tsb')}" fill="none" stroke="#00E676" stroke-width="1.6" stroke-dasharray="2 2"/>
    </svg>
  `;
  const legend = document.getElementById("fitness-legend");
  if (legend && last) {
    legend.innerHTML = `<span style="color:#00AEEF;">CTL ${last.ctl}</span> • <span style="color:#FC5200;">ATL ${last.atl}</span> • <span style="color:#00E676;">TSB ${last.tsb}</span>`;
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
      <span class="label-caps" style="color:#00AEEF; font-size:0.65rem;">🏆 ${pr.label}</span>
      <span class="p-stat-val" style="color:#FFF; font-size:1.05rem;">${pr.best_value}</span>
      <span class="body-xs" style="color:var(--text-muted);">${pr.achieved_date || ""}</span>
    </div>
  `).join("");
}

async function loadActivitiesFeed() {
  const listEl = document.getElementById("metrics-history-list");
  if (!listEl) return;
  // Clean skeleton loader
  listEl.innerHTML = `<div class="skeleton-shimmer" style="height:90px; margin-bottom:10px;"></div><div class="skeleton-shimmer" style="height:90px;"></div>`;

  try {
    const res = await fetch("/api/activities?limit=25");
    if (!res.ok) return;
    const data = await res.json();
    const acts = data.activities || [];
    if (acts.length === 0) return;

    let html = "";
    acts.forEach((a, idx) => {
      const isFuerza = a.sport_type === "Fuerza";
      const isBici = a.sport_type === "Ciclismo";
      const badgeColor = isFuerza ? "#FC5200" : isBici ? "#00AEEF" : "#00E676";
      const paceOrSpeed = isBici && a.duration_min > 0
        ? `${((a.distance_km || 0) / (a.duration_min / 60)).toFixed(1)} km/h`
        : (a.avg_pace_str || `${Math.round(a.duration_min || 0)} min`);
      const hasPoly = Array.isArray(a.polyline) && a.polyline.length > 2;

      html += `
        <div class="history-card-item" onclick="openActivityDetail('${a.external_id}')" style="cursor:pointer; border-left: 3px solid ${badgeColor};">
          <div class="history-card-header">
            <span class="label-caps">${a.start_date}</span>
            <span class="pill-tag" style="background:${badgeColor}22; color:${badgeColor};">${a.sport_type}</span>
          </div>
          <div class="history-title-row">
            <span class="headline-sm">${a.name}</span>
          </div>
          <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:6px; margin-top:6px;">
            <div><span class="body-xs" style="color:var(--text-muted); display:block;">DISTANCIA</span><strong>${a.distance_km ? a.distance_km + ' km' : Math.round(a.duration_min) + ' min'}</strong></div>
            <div><span class="body-xs" style="color:var(--text-muted); display:block;">${isBici ? 'VELOCIDAD' : 'RITMO'}</span><strong>${paceOrSpeed}</strong></div>
            <div><span class="body-xs" style="color:var(--text-muted); display:block;">DESNIVEL</span><strong>+${Math.round(a.elevation_gain || 0)} m</strong></div>
          </div>
          ${hasPoly ? `<div id="minimap-${idx}" class="activity-minimap"></div>` : ""}
        </div>
      `;
    });
    listEl.innerHTML = html;

    // Render interactive Leaflet minimaps for activities with GPS polylines
    if (window.L) {
      acts.forEach((a, idx) => {
        if (Array.isArray(a.polyline) && a.polyline.length > 2) {
          const mapEl = document.getElementById(`minimap-${idx}`);
          if (!mapEl) return;
          const m = L.map(mapEl, { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false });
          L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { maxZoom: 18 }).addTo(m);
          const color = a.sport_type === "Ciclismo" ? "#00AEEF" : "#FC5200";
          const line = L.polyline(a.polyline, { color, weight: 3 }).addTo(m);
          m.fitBounds(line.getBounds(), { padding: [8, 8] });
        }
      });
    }
  } catch (e) {
    console.warn("Activities feed load error:", e);
  }
}

async function openActivityDetail(externalId) {
  const modal = document.getElementById("activity-detail-modal");
  if (!modal) return;
  modal.style.display = "flex";
  if (window.lucide) lucide.createIcons();

  try {
    const res = await fetch(`/api/activities/${externalId}`);
    if (!res.ok) return;
    const act = await res.json();

    document.getElementById("detail-modal-sport").textContent = (act.sport_type || "GARMIN").toUpperCase();
    document.getElementById("detail-modal-date").textContent = act.start_date || "";
    document.getElementById("detail-modal-title").textContent = act.name || "Actividad";
    document.getElementById("detail-stat-dist").textContent = act.distance_km ? `${act.distance_km} km` : `${Math.round(act.duration_min || 0)} min`;
    const isBici = act.sport_type === "Ciclismo";
    document.getElementById("detail-stat-pace").textContent = isBici && act.duration_min > 0
      ? `${((act.distance_km || 0) / (act.duration_min / 60)).toFixed(1)} km/h`
      : (act.avg_pace_str || "—");
    document.getElementById("detail-stat-elev").textContent = `+${Math.round(act.elevation_gain || 0)} m`;

    // Render full Leaflet map
    const mapCont = document.getElementById("detail-map-container");
    if (_detailMapInstance) { _detailMapInstance.remove(); _detailMapInstance = null; }
    if (window.L && act.polyline && act.polyline.length > 2) {
      mapCont.style.display = "block";
      setTimeout(() => {
        _detailMapInstance = L.map(mapCont);
        L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { maxZoom: 18 }).addTo(_detailMapInstance);
        const line = L.polyline(act.polyline, { color: "#FC5200", weight: 4 }).addTo(_detailMapInstance);
        _detailMapInstance.fitBounds(line.getBounds(), { padding: [16, 16] });
      }, 60);
    } else {
      mapCont.style.display = "none";
    }

    // Render Strava-style Splits Table
    const splitsCard = document.getElementById("detail-splits-card");
    const splitsList = document.getElementById("detail-splits-list");
    if (act.splits && act.splits.length > 0) {
      splitsCard.style.display = "flex";
      const minPace = Math.min(...act.splits.map(s => s.pace_sec));
      const maxPace = Math.max(...act.splits.map(s => s.pace_sec));
      splitsList.innerHTML = act.splits.map(s => {
        const ratio = maxPace > minPace ? 100 - ((s.pace_sec - minPace) / (maxPace - minPace)) * 45 : 85;
        return `
          <div class="split-row">
            <span style="color:var(--text-muted); font-weight:700;">KM ${s.km}</span>
            <span style="font-weight:800; color:#FFF;">${s.pace_str}</span>
            <div class="split-bar-track"><div class="split-bar-fill" style="width:${Math.round(ratio)}%;"></div></div>
            <span style="color:#FC5200; font-size:0.74rem; text-align:right;">${s.avg_hr ? s.avg_hr + ' ppm' : ''}</span>
          </div>
        `;
      }).join("");
    } else {
      splitsCard.style.display = "none";
    }

    // Render Synchronized Chart (Elevation + HR + Pace)
    const chartCard = document.getElementById("detail-chart-card");
    const chartSvg = document.getElementById("detail-chart-svg");
    const cs = act.chart_series || {};
    if (cs.dist_km && cs.dist_km.length > 5) {
      chartCard.style.display = "flex";
      const W = 360, H = 120, pad = 8;
      const elevs = (cs.elevation_m || []).filter(v => v !== null);
      const hrs = (cs.hr || []).filter(v => v !== null);
      const buildPath = (arr) => {
        const mn = Math.min(...arr), mx = Math.max(...arr), rng = (mx - mn) || 1;
        return arr.map((v, i) => {
          const x = pad + (i / (arr.length - 1)) * (W - pad * 2);
          const y = H - pad - ((v - mn) / rng) * (H - pad * 2);
          return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
        }).join(" ");
      };
      chartSvg.innerHTML = `
        <svg viewBox="0 0 ${W} ${H}" style="width:100%; height:100%;">
          ${elevs.length > 2 ? `<path d="${buildPath(elevs)}" fill="none" stroke="#64748B" stroke-width="2"/>` : ""}
          ${hrs.length > 2 ? `<path d="${buildPath(hrs)}" fill="none" stroke="#FC5200" stroke-width="2"/>` : ""}
        </svg>
      `;
    } else {
      chartCard.style.display = "none";
    }

    // Render HR Zones Z1-Z5
    const zonesCard = document.getElementById("detail-zones-card");
    const zonesList = document.getElementById("detail-zones-list");
    if (act.hr_zones && act.hr_zones.length > 0) {
      zonesCard.style.display = "flex";
      zonesList.innerHTML = act.hr_zones.map(z => `
        <div style="display:flex; flex-direction:column; gap:3px;">
          <div style="display:flex; justify-content:space-between; font-size:0.75rem;">
            <span style="color:#FFF; font-weight:700;">${z.zone} <small style="color:var(--text-muted);">(${z.range})</small></span>
            <span style="color:${z.color}; font-weight:800;">${z.pct}%</span>
          </div>
          <div class="split-bar-track"><div style="height:100%; width:${z.pct}%; background:${z.color}; border-radius:999px;"></div></div>
        </div>
      `).join("");
    } else {
      zonesCard.style.display = "none";
    }
  } catch (e) {
    console.warn("Detail modal error:", e);
  }
}

function closeActivityDetailModal() {
  const modal = document.getElementById("activity-detail-modal");
  if (modal) modal.style.display = "none";
  if (_detailMapInstance) { _detailMapInstance.remove(); _detailMapInstance = null; }
}

// ============================================================
// FASE 4: GEAR TRACKER (ZAPATILLAS & BICI)
// ============================================================
async function loadGearList() {
  const cont = document.getElementById("gear-list-container");
  if (!cont) return;
  try {
    const res = await fetch("/api/gear");
    if (!res.ok) return;
    const data = await res.json();
    const list = data.gear || [];
    cont.innerHTML = list.map(g => {
      const pct = Math.min(100, Math.round((g.total_km / (g.alert_km || 650)) * 100));
      const warn = g.total_km >= (g.alert_km || 650) * 0.9;
      return `
        <div style="background:var(--surface-dim); border:1px solid ${warn ? '#FC5200' : 'var(--border-glass)'}; border-radius:10px; padding:10px 12px;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <strong style="font-size:0.88rem; color:#FFF;">${g.gear_type === 'shoes' ? '👟' : '🚴'} ${g.name}</strong>
            <span class="label-caps" style="color:${warn ? '#FC5200' : '#00E676'}; font-size:0.75rem;">${g.total_km} / ${g.alert_km} km</span>
          </div>
          <div class="progress-bar-wrap" style="margin-top:6px;">
            <div class="progress-fill ${warn ? 'lime' : 'cyan'}" style="width:${pct}%; background:${warn ? '#FC5200' : '#00AEEF'};"></div>
          </div>
          ${warn ? `<span class="body-xs" style="color:#FC5200; margin-top:4px; display:block;">⚠️ Cerca del límite de desgaste recomendado</span>` : ""}
        </div>
      `;
    }).join("");
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










