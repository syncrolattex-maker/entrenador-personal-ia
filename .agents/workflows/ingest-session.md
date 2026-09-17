---
name: ingest-session
description: Procesa y destila una sesión de entrenamiento (log JSON o telemetría) en la LLM Wiki viva de Verofit
---

# Workflow: /ingest-session

Este workflow ingesta un log de sesión crudo desde aw/sessions/ y actualiza la LLM Wiki viva con las adaptaciones fisiológicas correspondientes.

---

## Pasos de Ejecución

1. **Localizar el Archivo Raw**:
   - Identificar el archivo de sesión más reciente o especificado en aw/sessions/ (ej: aw/sessions/YYYY-MM-DD_session_log.json).

2. **Extraer Métricas Clave**:
   - Disciplina (Fuerza, Carrera, Yoga).
   - Duración (minutos), FC media / máxima, calorías activas, distancia (si aplica).
   - Esfuerzo subjetivo reportado (acil, optimo, gotador).
   - Métricas WKO5 asociadas si existen (ctl_fitness, tl_fatiga, 	sb_forma).

3. **Actualizar el Registro Cronológico**:
   - Añadir una nueva entrada en wiki/log.md con la fecha, tipo de sesión, resumen de telemetría y síntesis de asimilación.

4. **Reflejar Cambios en Perfil y Entrenamiento**:
   - Si hubo esfuerzo agotador o FC > 170 ppm: actualizar wiki/profile/respuestas_estres.md.
   - Si se utilizó una variación de ejercicios o modo rescate: actualizar wiki/training/biblioteca_ejercicios.md o wiki/training/adaptaciones_rescate.md.
   - Si se reportó gasto calórico específico: contrastar con wiki/nutrition/pautas_energia.md.

5. **Verificación de Enlaces**:
   - Asegurar que wiki/index.md mantiene todas las referencias actualizadas.
