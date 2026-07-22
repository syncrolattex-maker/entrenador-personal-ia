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

  // Selection events
  elBtnSelectFuerza.addEventListener("click", () => iniciarGeneracionEntrenamiento("Fuerza"));
  elBtnSelectCarrera.addEventListener("click", () => iniciarGeneracionEntrenamiento("Carrera"));
  if (elBtnSelectYoga) elBtnSelectYoga.addEventListener("click", () => iniciarGeneracionEntrenamiento("Yoga"));
  elBtnSelectDescanso.addEventListener("click", registrarDescansoHoy);


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
  
  if (elRecommendationBox) {
    elRecommendationBox.classList.add("loading-pulse");
    if (elRecTipoLabel) elRecTipoLabel.textContent = "...";
    if (elRecRazonText) elRecRazonText.textContent = "Analizando tu actividad con la Coach Verónica...";
  }

  try {
    // 1. Get database status
    const dbRes = await fetch("/estado-db");
    if (dbRes.ok) { state.db = await dbRes.json(); updateStatsBanner(); }

    // 2. Clear cache if version changed (cache buster)
    const APP_VERSION = "v44"; // Responsive centered ring typography & alignment




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
      console.log("[Cache] Serving today's recommendation from localStorage.");
      const recObj = JSON.parse(cachedRec);
      renderRecommendation(recObj);
      if (elRecommendationBox) elRecommendationBox.classList.remove("loading-pulse");
      return;
    }

    // 5. Fetch new recommendation from server
    const recRes = await fetch("/recomendacion-hoy");
    if (recRes.ok) {
      const recommendation = await recRes.json();
      if (recommendation.historial_real) {
        state.history = recommendation.historial_real;
      }
      
      if (recommendation.razon && !recommendation.razon.includes("Error conectando")) {
        localStorage.setItem("cached_recommendation", JSON.stringify(recommendation));
        localStorage.setItem("cached_recommendation_date", todayStr);
      }
      
      renderRecommendation(recommendation);
    } else {

      renderRecommendation({
        recomendacion: "Fuerza",
        razon: "No se pudo conectar con la IA de planificación. Te aconsejamos Fuerza hoy.",
        explicacion_semanal: "Verifica tu conexión."
      });
    }

  } catch (err) {
    console.error("Fetch recommendation error:", err);
    renderRecommendation({
      recomendacion: "Fuerza",
      razon: "¡Hola Verónica! Se ha detectado una interrupción temporal de red. Mientras reestablecemos la sincronización en vivo con tu reloj, te sugerimos una sesión de Fuerza Full-body.",
      explicacion_semanal: "Modo offline activo. Puedes continuar entrenando normalmente."
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

  // Update dynamic readiness score (Weekly Load Balance Score)
  const elPercent = document.getElementById("daily-goal-percent");
  const elRingArc = document.getElementById("daily-ring-arc");
  const score = rec.readiness_score || 85;
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
      parts: `¡Hola Verónica! He analizado tu historial de entrenamientos en tu reloj. Para hoy te recomiendo una sesión de **${rec.recomendacion}**.\n\n${rec.razon}\n\n¿Quieres que adaptemos algo de los ejercicios o estás lista para empezar?`
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
        <div style="background:#ECFDF5;border:1px solid #A7F3D0;color:#065F46;font-size:0.75rem;font-weight:700;padding:6px 12px;border-radius:8px;display:inline-flex;align-items:center;gap:6px;margin-bottom:12px;">
          <i data-lucide="check-circle" style="width:14px;height:14px;"></i>
          SINCRONIZADO CON APPLE WATCH (VÍA INTERVALS.ICU)
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
          <i data-lucide="watch" style="width:40px;height:40px;color:var(--accent-carrera);"></i>
        </div>
        <h3 class="carrera-title">Día de Carrera Estructurada</h3>
        ${watchBadge}
        <p class="carrera-instructions" style="margin-top:4px;">
          Tu entrenamiento de running está listo en tu <strong>Apple Watch</strong> vía Intervals.icu.<br>
          Pulsa <strong>"▶ Empezar sesión"</strong> para seguirlo también desde aquí con timer.
        </p>
        ${stepsHtml}
      </div>`;

    elWorkoutActions.innerHTML = `
      <button id="btn-sync-watch" class="btn btn-primary guided-action-btn carrera" style="background-color: #FC5200; margin-bottom: 8px;">
        <i data-lucide="watch" style="width: 20px; height: 20px;"></i>
        Sincronizar Apple Watch
      </button>
      <button id="btn-empezar-carrera" class="btn btn-primary guided-action-btn carrera" style="background-color: #FC5200;">
        <i data-lucide="play" style="width: 20px; height: 20px;"></i>
        Comenzar Carrera (Timer)
      </button>
      <button id="btn-volver" class="btn btn-secondary">
        Atrás
      </button>
    `;

    document.getElementById("btn-sync-watch").addEventListener("click", sincronizarAppleWatch);
    document.getElementById("btn-empezar-carrera").addEventListener("click", startGuidedSession);
    document.getElementById("btn-volver").addEventListener("click", mostrarPantallaSeleccion);
  }

  lucide.createIcons();
}

// ============================================================
// WORKOUT GENERATION AND ACTIONS
// ============================================================
async function iniciarGeneracionEntrenamiento(tipo) {
  showLoading(true, "La IA está diseñando tu entrenamiento...");
  try {
    const res = await fetch("/generar-entrenamiento", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tipo: tipo })
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
      showError("No pudimos generar el entrenamiento de la IA.");
    }

  } catch (err) {
    console.error("Generar entreno error:", err);
    showError("Error de conexión al generar entrenamiento.");
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
// GUIDED SESSION — START
// ============================================================
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

function closeGuided() {
  clearTimer();
  elGuidedOverlay.style.display = "none";
}

// ============================================================
// FUERZA — exercise display & progression
// ============================================================
function showFuerzaExercise() {
  const ex = guided.exercises[guided.exIndex];
  guided.phase = "working";

  updateProgress();
  setPhaseLabel("EJERCICIO", "working");

  // Update Assisted Video Demo & Tempo Cues
  updateGuidedVideo(ex.nombre, ex.descripcion);

  elGuidedExName.textContent = ex.nombre;
  elGuidedExName.style.animation = "none";
  requestAnimationFrame(() => elGuidedExName.style.animation = "");


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
      <button id="btn-start-work-fuerza" class="btn btn-primary guided-action-btn ${isYoga ? 'yoga' : ''}">
        <i data-lucide="play" style="width:22px;height:22px;"></i>
        ${isYoga ? 'Mantener Postura' : 'Iniciar Serie'} (${ex.repeticiones})
      </button>
      <button id="btn-skip-exercise" class="btn btn-secondary" style="font-size:0.9rem; padding:14px;">
        <i data-lucide="skip-forward" style="width:18px;height:18px;"></i>
        ${isYoga ? 'Saltar Postura' : 'Saltar ejercicio'}
      </button>
    `;
    lucide.createIcons();

    document.getElementById("btn-start-work-fuerza").addEventListener("click", () => {
      // Switch button to let user skip the working timer if needed
      elGuidedActionsFuerza.innerHTML = `
        <button id="btn-skip-work-timer" class="btn btn-primary guided-action-btn ${isYoga ? 'yoga' : ''}" style="${isYoga ? 'background: #A78BFA !important; box-shadow: 0 8px 30px rgba(167, 139, 250, 0.3) !important; color:#0e0e10 !important;' : 'background: var(--guided-accent-fuerza) !important; box-shadow: 0 8px 30px rgba(251, 113, 133, 0.3) !important;'}">
          <i data-lucide="skip-forward" style="width:22px;height:22px;"></i>
          ${isYoga ? 'Siguiente Asana' : 'Saltar e ir a Descanso'}
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
      <button id="btn-serie-done" class="btn btn-primary guided-action-btn ${isYoga ? 'yoga' : ''}">
        <i data-lucide="check" style="width:22px;height:22px;"></i>
        ${isYoga ? 'Postura completada' : 'Serie completada'}
      </button>
      <button id="btn-skip-exercise" class="btn btn-secondary" style="font-size:0.9rem; padding:14px;">
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
// REST TIMER
// ============================================================
function startRest() {
  guided.phase = "resting";
  const isYoga = guided.tipo === "Yoga";
  setPhaseLabel(isYoga ? "TRANSICIÓN" : "DESCANSO", "resting");
  updateProgress();

  hide(elGuidedSetCounter);
  hide(elGuidedReps);
  elGuidedExName.textContent = isYoga ? "Cambio de Postura" : "Descansa";

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
// CARRERA — phase display & progression
// ============================================================
function showCarreraPhase() {
  if (guided.exIndex >= guided.exercises.length) { showDone(); return; }

  const phase = guided.exercises[guided.exIndex];
  guided.phase = "running";
  guided.paused = false;

  updateProgress();

  const typeLabel = phase.type === "WARMUP" ? "CALENTAMIENTO"
    : phase.type === "COOLDOWN" ? "ENFRIAMIENTO"
    : "CARRERA";
  setPhaseLabel(typeLabel, "running");

  elGuidedExName.textContent = phase.name;
  elGuidedExName.style.animation = "none";
  requestAnimationFrame(() => elGuidedExName.style.animation = "");

  hide(elGuidedSetCounter);
  hide(elGuidedReps);
  show(elGuidedTimerWrap);
  elGuidedTimerArc.className = "guided-timer-arc carrera-arc";

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
  } else {
    resumeTimer();
    guided.paused = false;
    updatePauseBtn(false);
  }
}

function updatePauseBtn(isPaused) {
  elBtnPauseCarrera.innerHTML = isPaused
    ? `<i data-lucide="play" style="width:18px;height:18px;"></i> Continuar`
    : `<i data-lucide="pause" style="width:18px;height:18px;"></i> Pausar`;
  lucide.createIcons();
}

// ============================================================
// DONE SCREEN
// ============================================================
function showDone() {
  clearTimer();
  guided.phase = "done";
  playWorkoutCompleteSound();

  setPhaseLabel("¡COMPLETADO!", "done");
  updateProgress(true);

  const elapsed = Math.round((new Date() - guided.startTime) / 1000);
  const mins    = Math.floor(elapsed / 60);

  elGuidedExName.style.display = "none";
  hide(elGuidedSetCounter);
  hide(elGuidedReps);
  hide(elGuidedTimerWrap);

  // Build done content inside main
  const mainEl = document.querySelector(".guided-main");
  mainEl.innerHTML = `
    <div class="guided-done-emoji">💪</div>
    <div class="guided-done-title">¡Sesión completada!</div>
    <div class="guided-done-stats">
      <div class="guided-done-stat">
        <div class="guided-done-stat-value">${mins} min</div>
        <div class="guided-done-stat-label">Duración</div>
      </div>
      ${guided.tipo === "Fuerza" ? `
      <div class="guided-done-stat">
        <div class="guided-done-stat-value">${guided.totalSeries}</div>
        <div class="guided-done-stat-label">Series</div>
      </div>
      <div class="guided-done-stat">
        <div class="guided-done-stat-value">${guided.exercises.length}</div>
        <div class="guided-done-stat-label">Ejercicios</div>
      </div>` : `
      <div class="guided-done-stat">
        <div class="guided-done-stat-value">${guided.exercises.length}</div>
        <div class="guided-done-stat-label">Fases</div>
      </div>`}
    </div>`;

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
  // Restart from where we paused — we need to re-bind onDone
  // Re-call startCountdown is simplest; save the callback
  guided.timerRemaining = _pausedRemaining;
  updateTimerUI(_pausedRemaining, guided.timerTotal);
  guided.timerInterval = setInterval(() => {
    guided.timerRemaining--;
    updateTimerUI(guided.timerRemaining, guided.timerTotal);

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
// COACH CHAT LOGIC (VERÓNICA CHAT)
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
        showSuccessBanner("✨ Tu Coach Verónica ha adaptado tu entrenamiento de hoy.");
      }
    } else {
      chatHistory.push({ role: "model", parts: "Disculpa Verónica, he tenido un problema al procesar tu mensaje. ¿Puedes repetirlo?" });
      renderChatMessages();
      saveChat();
    }
  } catch (err) {
    console.error("Chat error:", err);
    const existingIndicator = document.getElementById("chat-typing-indicator");
    if (existingIndicator) existingIndicator.remove();
    
    chatHistory.push({ role: "model", parts: "Verónica, parece que hay un problema de conexión a internet. ¿Lo intentamos de nuevo?" });
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
  
  if (elMetricFuerzaCount) elMetricFuerzaCount.innerHTML = `${fuerzaCount}<small> / 3 ses</small>`;
  if (elMetricFuerzaBar) elMetricFuerzaBar.style.width = `${Math.min(100, Math.round((fuerzaCount / 3) * 100))}%`;
  if (elMetricCarreraCount) elMetricCarreraCount.innerHTML = `${carreraCount}<small> / 2 ses</small>`;
  if (elMetricCarreraBar) elMetricCarreraBar.style.width = `${Math.min(100, Math.round((carreraCount / 2) * 100))}%`;

  if (elMetricsHistoryList) {
    if (!history || history.length === 0) {
      elMetricsHistoryList.innerHTML = `<p class="body-sm-muted" style="text-align:center; padding: 20px 0;">No hay actividades registradas en Intervals.icu en los últimos 14 días.</p>`;
      return;
    }

    let html = "";
    history.forEach(act => {
      const isFuerza = act.tipo === "Fuerza";
      const borderClass = isFuerza ? "fuerza" : "carrera";
      const tagClass = isFuerza ? "lime" : "cyan";
      
      let statsPills = `<span class="stat-chip">⏱️ ${Math.round(act.duracion_minutos)} min</span>`;
      if (act.frecuencia_cardiaca_media) statsPills += `<span class="stat-chip">❤️ ${Math.round(act.frecuencia_cardiaca_media)} ppm</span>`;
      if (act.distancia_km) statsPills += `<span class="stat-chip">📏 ${act.distancia_km} km</span>`;
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
  
  // Update metrics bars target count with new goals
      if (state.history) {
    renderMetricsTab(state.history, state.lastCoachText || "");
  }

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
  const muscleEl = document.getElementById("modal-muscle-name");
  const tempoEl = document.getElementById("modal-video-tempo");
  const cuesEl = document.getElementById("modal-video-cues");

  if (!modal) return;

  if (titleEl) titleEl.textContent = name;

  const nameLower = (name || "").toLowerCase();
  let match = EXERCISE_MEDIA_MAP.find(item => item.keywords.some(k => nameLower.includes(k)));

  const gifUrl = exData?.gif_url || (match ? match.gif : "");
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


  if (gifUrl && imgEl) {
    imgEl.src = gifUrl;
    imgEl.style.display = "block";
    if (isYogaSession) {
      imgEl.style.background = "#f9f9fb";
      imgEl.style.padding = "14px";
      imgEl.style.objectFit = "contain";
    } else {
      imgEl.style.background = "#080808";
      imgEl.style.padding = "0";
      imgEl.style.objectFit = "contain";
    }
    imgEl.onload = () => {
      imgEl.style.display = "block";
    };
    imgEl.onerror = () => {
      imgEl.style.display = "none";
      if (!isYogaSession && canvasEl) canvasEl.style.display = "flex";
    };
  } else if (imgEl) {
    imgEl.style.display = "none";
    if (!isYogaSession && canvasEl) canvasEl.style.display = "flex";
  }


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

  modal.style.display = "flex";
  if (window.lucide) lucide.createIcons();
}

function closeExerciseVideoModal() {
  const modal = document.getElementById("exercise-video-modal");
  if (modal) modal.style.display = "none";
}










