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
  showLoading(true, "Consultando plan semanal con la IA...");
  hideSuccessBanner();
  mostrarPantallaSeleccion();

  try {
    // 1. Get database status
    const dbRes = await fetch("/estado-db");
    if (dbRes.ok) { state.db = await dbRes.json(); updateStatsBanner(); }

    // 2. Clear cache if version changed (cache buster)
    const APP_VERSION = "v7"; // Bumped version for Coach chat & Veronica profile
    const cachedVersion = localStorage.getItem("cached_version");
    if (cachedVersion !== APP_VERSION) {
      localStorage.removeItem("cached_recommendation");
      localStorage.removeItem("cached_recommendation_date");
      localStorage.removeItem("cached_workout");
      localStorage.removeItem("cached_workout_date");
      localStorage.setItem("cached_version", APP_VERSION);
    }

    // 3. Read cached recommendation for today
    const todayStr = new Date().toDateString();
    const cachedRec = localStorage.getItem("cached_recommendation");
    const cachedRecDate = localStorage.getItem("cached_recommendation_date");

    if (cachedRec && cachedRecDate === todayStr) {
      console.log("[Cache] Serving today's recommendation from localStorage.");
      renderRecommendation(JSON.parse(cachedRec));
      showLoading(false);
      return;
    }

    // 4. Fetch new recommendation from server
    const recRes = await fetch("/recomendacion-hoy");
    if (recRes.ok) {
      const recommendation = await recRes.json();
      
      localStorage.setItem("cached_recommendation", JSON.stringify(recommendation));
      localStorage.setItem("cached_recommendation_date", todayStr);
      
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
      razon: "Error de red. Te recomendamos Fuerza para mantener el balance semanal.",
      explicacion_semanal: "Modo de recuperación offline."
    });
  } finally {
    showLoading(false);
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

  // Show chat card
  if (elCoachChatCard) elCoachChatCard.style.display = "flex";

  // Initialize chat history with coach welcome message
  chatHistory = [
    {
      role: "model",
      parts: `¡Hola Verónica! He analizado tu historial de entrenamientos en tu reloj. Para hoy te recomiendo una sesión de **${rec.recomendacion}**.\n\n${rec.razon}\n\n¿Quieres que adaptemos algo de los ejercicios o estás lista para empezar?`
    }
  ];
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

  // Update "Empezar" button style
  elBtnEmpezar.className = `btn btn-primary guided-action-btn${isFuerza ? "" : " carrera"}`;

  if (isFuerza) {
    elWorkoutBadge.className = "badge fuerza";
    elWorkoutBadge.textContent = "Fuerza • Glúteos y Piernas";

    let html = '<div class="exercise-list">';
    workout.ejercicios.forEach(ex => {
      html += `
        <div class="exercise-item">
          <div class="exercise-info">
            <span class="exercise-name">${ex.nombre}</span>
            <span class="exercise-sets">${ex.series} series</span>
            ${ex.descripcion ? `<span class="exercise-desc">${ex.descripcion}</span>` : ""}
          </div>
          <span class="exercise-reps">${ex.repeticiones}</span>
        </div>`;
    });
    html += "</div>";
    elWorkoutContent.innerHTML = html;

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
  }

  lucide.createIcons();
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

    const res = await fetch("/webhook-iphone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tipo: state.db.siguiente_bloque, completado: false })
    });
    if (res.ok) {
      const data = await res.json();
      state.db = data.db;
      updateStatsBanner();
      showSuccessBanner(false);
      const r2 = await fetch("/rutina-hoy");
      if (r2.ok) {
        state.currentWorkout = await r2.json();
        // Save new mock/routine to cache
        localStorage.setItem("cached_workout", JSON.stringify(state.currentWorkout));
        localStorage.setItem("cached_workout_date", new Date().toDateString());
        renderWorkout(state.currentWorkout);
      }
    } else {
      showError("No pudimos actualizar tu estado.");
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
  guided.exercises  = workout.tipo_sesion === "Fuerza" ? workout.ejercicios : workout.phases;
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
  elGuidedProgressFill.className = guided.tipo === "Carrera"
    ? "guided-progress-fill carrera"
    : "guided-progress-fill";

  elGuidedOverlay.style.display = "flex";
  lucide.createIcons();

  if (guided.tipo === "Fuerza") {
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
  if (workSeconds) {
    // Time-based exercise (e.g. Plancha 45 seg)
    show(elGuidedTimerWrap);
    elGuidedTimerArc.className = "guided-timer-arc";
    updateTimerUI(workSeconds, workSeconds);

    elGuidedActionsFuerza.innerHTML = `
      <button id="btn-start-work-fuerza" class="btn btn-primary guided-action-btn">
        <i data-lucide="play" style="width:22px;height:22px;"></i>
        Iniciar Serie (${ex.repeticiones})
      </button>
      <button id="btn-skip-exercise" class="btn btn-secondary" style="font-size:0.9rem; padding:14px;">
        <i data-lucide="skip-forward" style="width:18px;height:18px;"></i>
        Saltar ejercicio
      </button>
    `;
    lucide.createIcons();

    document.getElementById("btn-start-work-fuerza").addEventListener("click", () => {
      // Switch button to let user skip the working timer if needed
      elGuidedActionsFuerza.innerHTML = `
        <button id="btn-skip-work-timer" class="btn btn-primary guided-action-btn" style="background: var(--guided-accent-fuerza) !important; box-shadow: 0 8px 30px rgba(251, 113, 133, 0.3) !important;">
          <i data-lucide="skip-forward" style="width:22px;height:22px;"></i>
          Saltar e ir a Descanso
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
    // Reps-based exercise (e.g. 12 reps)
    hide(elGuidedTimerWrap);
    elGuidedActionsFuerza.innerHTML = `
      <button id="btn-serie-done" class="btn btn-primary guided-action-btn">
        <i data-lucide="check" style="width:22px;height:22px;"></i>
        Serie completada
      </button>
      <button id="btn-skip-exercise" class="btn btn-secondary" style="font-size:0.9rem; padding:14px;">
        <i data-lucide="skip-forward" style="width:18px;height:18px;"></i>
        Saltar ejercicio
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
  setPhaseLabel("DESCANSO", "resting");
  updateProgress();

  hide(elGuidedSetCounter);
  hide(elGuidedReps);
  elGuidedExName.textContent = "Descansa";

  showActions("rest");
  show(elGuidedTimerWrap);
  elGuidedTimerArc.className = "guided-timer-arc";

  startCountdown(REST_DURATION, () => {
    // Auto-advance after rest
    showFuerzaExercise();
  });
}

function onSkipRest() {
  clearTimer();
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
    series_completadas:     guided.tipo === "Fuerza" ? guided.totalSeries : null,
    ejercicios_completados: guided.tipo === "Fuerza" ? guided.exercises.length : null,
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

      showLoading(true);
      const r = await fetch("/rutina-hoy");
      if (r.ok) {
        state.currentWorkout = await r.json();
        // Pre-cache tomorrow's or the next queued routine
        localStorage.setItem("cached_workout", JSON.stringify(state.currentWorkout));
        localStorage.setItem("cached_workout_date", new Date().toDateString());
        renderWorkout(state.currentWorkout);
      }
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
// HELPERS — audio synthesize & time parsing
// ============================================================
function playBeep(frequency = 800, duration = 0.1) {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    const audioCtx = new AudioContextClass();
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    
    // Low volume setting (0.05) to be warning but not piercing
    gainNode.gain.setValueAtTime(0.05, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    
    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    
    oscillator.start();
    oscillator.stop(audioCtx.currentTime + duration);
  } catch (e) {
    console.warn("Audio Context playback failed or blocked:", e);
  }
}

function getDurationFromReps(repsStr) {
  if (!repsStr) return null;
  const clean = repsStr.toLowerCase();
  // Match strings that contain seg, s, segundos, sec, seconds
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

async function enviarMensajeChat() {
  const text = elChatInput.value.trim();
  if (!text) return;
  
  elChatInput.value = "";
  
  // 1. Add user message to state and render
  chatHistory.push({ role: "user", parts: text });
  renderChatMessages();
  
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
    } else {
      chatHistory.push({ role: "model", parts: "Disculpa Verónica, he tenido un problema al procesar tu mensaje. ¿Puedes repetirlo?" });
      renderChatMessages();
    }
  } catch (err) {
    console.error("Chat error:", err);
    const existingIndicator = document.getElementById("chat-typing-indicator");
    if (existingIndicator) existingIndicator.remove();
    
    chatHistory.push({ role: "model", parts: "Verónica, parece que hay un problema de conexión a internet. ¿Lo intentamos de nuevo?" });
    renderChatMessages();
  }
}

