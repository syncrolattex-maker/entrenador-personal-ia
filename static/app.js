// Register Service Worker for PWA
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => console.log("[PWA] Service Worker registrado con éxito", reg.scope))
      .catch((err) => console.error("[PWA] Error registrando Service Worker", err));
  });
}

// State management
let state = {
  db: {
    dias_sin_entrenar: 0,
    ultimo_entreno: "Ninguno",
    siguiente_bloque: "Fuerza",
    historial_entrenamientos: []
  },
  currentWorkout: null
};

// DOM Elements
const elStatusUltimo = document.getElementById("status-ultimo");
const elStatusSiguiente = document.getElementById("status-siguiente");
const elStatusDias = document.getElementById("status-dias");
const elLoadingState = document.getElementById("loading-state");
const elWorkoutCard = document.getElementById("workout-card");
const elWorkoutBadge = document.getElementById("workout-badge");
const elWorkoutContent = document.getElementById("workout-content");
const elWorkoutNote = document.getElementById("workout-note");
const elWorkoutActions = document.getElementById("workout-actions");
const elBtnCompletar = document.getElementById("btn-completar");
const elBtnDescansar = document.getElementById("btn-descansar");
const elSuccessBanner = document.getElementById("success-banner");
const elSuccessText = document.getElementById("success-text");
const elOfflineNotification = document.getElementById("offline-notification");

// Feedback DOM Elements
const elFeedbackSection = document.getElementById("feedback-section");
const elFeedbackBtns = document.querySelectorAll(".feedback-btn");
const elBtnCancelarFeedback = document.getElementById("btn-cancelar-feedback");
const elBtnConfirmarFeedback = document.getElementById("btn-confirmar-feedback");
const elAdaptationBanner = document.getElementById("adaptation-banner");
const elAdaptationText = document.getElementById("adaptation-text");

let selectedFeedback = null;

// Initialize application
document.addEventListener("DOMContentLoaded", () => {
  initApp();
  
  // Setup event listeners for feedback flow
  elBtnCompletar.addEventListener("click", () => {
    elWorkoutActions.style.display = "none";
    elFeedbackSection.style.display = "flex";
  });
  
  elBtnCancelarFeedback.addEventListener("click", () => {
    elFeedbackSection.style.display = "none";
    elWorkoutActions.style.display = "flex";
    resetFeedback();
  });
  
  elFeedbackBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      elFeedbackBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      selectedFeedback = btn.getAttribute("data-value");
      elBtnConfirmarFeedback.removeAttribute("disabled");
    });
  });
  
  elBtnConfirmarFeedback.addEventListener("click", () => {
    handleAction(true, selectedFeedback);
    elFeedbackSection.style.display = "none";
    elWorkoutActions.style.display = "flex";
    resetFeedback();
  });
  
  elBtnDescansar.addEventListener("click", () => handleAction(false));
  
  // Offline/Online detection
  window.addEventListener("online", updateOnlineStatus);
  window.addEventListener("offline", updateOnlineStatus);
  updateOnlineStatus();
});

function updateOnlineStatus() {
  if (navigator.onLine) {
    elOfflineNotification.style.display = "none";
  } else {
    elOfflineNotification.style.display = "flex";
  }
}

function resetFeedback() {
  selectedFeedback = null;
  elFeedbackBtns.forEach((b) => b.classList.remove("active"));
  elBtnConfirmarFeedback.setAttribute("disabled", "true");
}

// Fetch database status and today's routine
async function initApp() {
  showLoading(true);
  hideSuccessBanner();
  
  try {
    // 1. Fetch DB state
    const dbResponse = await fetch("/estado-db");
    if (dbResponse.ok) {
      state.db = await dbResponse.json();
      updateStatsBanner();
    }
    
    // 2. Fetch Routine
    const routineResponse = await fetch("/rutina-hoy");
    if (routineResponse.ok) {
      state.currentWorkout = await routineResponse.json();
      renderWorkout(state.currentWorkout);
    } else {
      showError("No pudimos cargar la rutina de hoy. Inténtalo de nuevo.");
    }
  } catch (error) {
    console.error("Fetch Error:", error);
    showError("Error de conexión con el servidor local.");
  } finally {
    showLoading(false);
  }
}

function updateStatsBanner() {
  elStatusUltimo.textContent = state.db.ultimo_entreno || "Ninguno";
  elStatusSiguiente.textContent = state.db.siguiente_bloque || "-";
  
  const dias = state.db.dias_sin_entrenar || 0;
  elStatusDias.textContent = dias === 0 ? "¡Al día!" : `${dias} ${dias === 1 ? "día" : "días"}`;
  
  if (dias > 0) {
    elStatusDias.classList.add("highlight");
  } else {
    elStatusDias.classList.remove("highlight");
  }
}

function showLoading(isLoading) {
  if (isLoading) {
    elLoadingState.style.display = "flex";
    elWorkoutCard.style.display = "none";
  } else {
    elLoadingState.style.display = "none";
    elWorkoutCard.style.display = "flex";
  }
}

function showError(message) {
  elWorkoutContent.innerHTML = `
    <div style="text-align: center; color: var(--text-secondary); padding: 20px 0;">
      <i data-lucide="alert-triangle" style="width: 48px; height: 48px; margin-bottom: 12px; opacity: 0.5;"></i>
      <p style="font-weight: 500;">${message}</p>
    </div>
  `;
  elWorkoutNote.textContent = "";
  elAdaptationBanner.style.display = "none";
  lucide.createIcons();
}

function renderWorkout(workout) {
  // Clear previous content
  elWorkoutContent.innerHTML = "";
  
  if (workout.mensaje) {
    elWorkoutNote.textContent = workout.mensaje;
  } else {
    elWorkoutNote.textContent = "";
  }
  
  // Render adaptation banner if Gemini modified the routine
  if (workout.mensaje_adaptacion) {
    elAdaptationText.textContent = workout.mensaje_adaptacion;
    elAdaptationBanner.style.display = "flex";
  } else {
    elAdaptationBanner.style.display = "none";
  }
  
  const isFuerza = workout.tipo_sesion === "Fuerza";
  
  if (isFuerza) {
    elWorkoutBadge.className = "badge fuerza";
    elWorkoutBadge.textContent = "Fuerza • Glúteos y Piernas";
    
    let html = '<div class="exercise-list">';
    workout.ejercicios.forEach((ex) => {
      html += `
        <div class="exercise-item">
          <div class="exercise-info">
            <span class="exercise-name">${ex.nombre}</span>
            <span class="exercise-sets">${ex.series} series</span>
          </div>
          <span class="exercise-reps">${ex.repeticiones}</span>
        </div>
      `;
    });
    html += "</div>";
    elWorkoutContent.innerHTML = html;
    
  } else {
    elWorkoutBadge.className = "badge carrera";
    elWorkoutBadge.textContent = "Carrera • Watch";
    
    let stepsHtml = "";
    if (workout.phases && workout.phases.length > 0) {
      stepsHtml = '<div class="watch-steps">';
      workout.phases.forEach((phase) => {
        const mins = Math.floor(phase.duration_seconds / 60);
        const secs = phase.duration_seconds % 60;
        const durationStr = `${mins}:${secs.toString().padStart(2, "0")}`;
        stepsHtml += `
          <div class="watch-step">
            <span class="watch-step-name">${phase.name}</span>
            <span class="watch-step-duration">${durationStr}</span>
          </div>
        `;
      });
      stepsHtml += "</div>";
    }
    
    let watchSyncBadge = "";
    if (workout.enviado_al_reloj) {
      watchSyncBadge = `
        <div style="background-color: #ECFDF5; border: 1px solid #A7F3D0; color: #065F46; font-size: 0.75rem; font-weight: 700; padding: 6px 12px; border-radius: 8px; display: inline-flex; align-items: center; gap: 6px; margin-bottom: 12px;">
          <i data-lucide="check-circle" style="width: 14px; height: 14px;"></i>
          SINCRONIZADO CON APPLE WATCH (VÍA INTERVALS.ICU)
        </div>
      `;
    }
    
    elWorkoutContent.innerHTML = `
      <div class="carrera-container">
        <div class="watch-icon-wrapper">
          <i data-lucide="watch" style="width: 40px; height: 40px; color: var(--accent-carrera);"></i>
        </div>
        <h3 class="carrera-title">Día de Carrera Estructurada</h3>
        ${watchSyncBadge}
        <p class="carrera-instructions" style="margin-top: 4px;">
          Tu entrenamiento de running ya está listo. Inicia la sesión estructurada directamente en tu <strong>Apple Watch</strong>.
        </p>
        ${stepsHtml}
      </div>
    `;
  }
  
  // Re-run Lucide parser to render new icons
  lucide.createIcons();
}

async function handleAction(completado, effortValue = null) {
  showLoading(true);
  hideSuccessBanner();
  
  const payload = {
    tipo: state.db.siguiente_bloque,
    completado: completado
  };
  
  // Inject simulated Apple Health metrics on completion to feed the AI feedback loop
  if (completado) {
    payload.esfuerzo_subjetivo = effortValue;
    if (state.db.siguiente_bloque === "Fuerza") {
      payload.duracion_minutos = 40 + Math.floor(Math.random() * 15); // 40-55 mins
      payload.calorias_activas = 220 + Math.floor(Math.random() * 80); // 220-300 kcal
      payload.frecuencia_cardiaca_media = effortValue === "agotador" ? 145 + Math.floor(Math.random() * 15) : 112 + Math.floor(Math.random() * 15);
    } else {
      payload.duracion_minutos = 25 + Math.floor(Math.random() * 10); // 25-35 mins
      payload.calorias_activas = 310 + Math.floor(Math.random() * 90); // 310-400 kcal
      payload.distancia_km = effortValue === "agotador" ? 3.5 + (Math.random() * 0.8) : 4.6 + (Math.random() * 1.5);
      payload.frecuencia_cardiaca_media = effortValue === "agotador" ? 168 + Math.floor(Math.random() * 8) : 142 + Math.floor(Math.random() * 16);
    }
  }
  
  try {
    const response = await fetch("/webhook-iphone", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    
    if (response.ok) {
      const data = await response.json();
      state.db = data.db;
      updateStatsBanner();
      
      // Show success / skip banner
      showSuccessBanner(completado);
      
      // Fetch next adapted routine
      const routineResponse = await fetch("/rutina-hoy");
      if (routineResponse.ok) {
        state.currentWorkout = await routineResponse.json();
        renderWorkout(state.currentWorkout);
      }
    } else {
      showError("No pudimos actualizar tu estado. Inténtalo más tarde.");
    }
  } catch (error) {
    console.error("Action Error:", error);
    showError("Error de conexión al enviar el registro.");
  } finally {
    showLoading(false);
  }
}

function showSuccessBanner(completado) {
  elSuccessBanner.style.display = "flex";
  if (completado) {
    elSuccessBanner.style.background = "var(--bg-card)";
    elSuccessBanner.style.color = "var(--text-primary)";
    elSuccessBanner.style.border = "1px solid rgba(24, 24, 27, 0.08)";
    elSuccessText.innerHTML = `✨ <strong>¡Gran trabajo completado!</strong> Tu siguiente rutina está lista en la cola.`;
  } else {
    elSuccessBanner.style.background = "var(--bg-card)";
    elSuccessBanner.style.color = "var(--text-secondary)";
    elSuccessBanner.style.border = "1px solid rgba(24, 24, 27, 0.08)";
    elSuccessText.innerHTML = `🧘 <strong>Día de descanso registrado.</strong> Sin culpas. Tu entrenamiento te estará esperando mañana.`;
  }
  
  window.scrollTo({
    top: document.body.scrollHeight,
    behavior: "smooth"
  });
  
  setTimeout(hideSuccessBanner, 5000);
}

function hideSuccessBanner() {
  elSuccessBanner.style.display = "none";
}
