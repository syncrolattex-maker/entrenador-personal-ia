# AaronFit — Reglas y Visión del Proyecto (Entrenador Personal IA + Garmin & Strava)

Este archivo define las reglas de comportamiento, la visión del producto y las especificaciones atléticas exclusivas de **AaronFit** para guiar futuras actualizaciones.

---

## 🎯 1. Visión del Producto

**AaronFit** es una plataforma ultra-personalizada de entrenamiento personal y diagnóstico fisiológico diseñada a medida para **Aarón**. Analiza en tiempo real su historial real de **Garmin Connect** y **Strava**, integra métricas de recuperación (HRV, Body Battery, sueño, FC en reposo y carga semanal) y ejecuta sesiones guiadas con el **sistema de fuerza estilo Strava** y **sistema de carrera estilo Runna**.

---

## 🏋️‍♂️ 2. Perfil del Atleta

* **Nombre**: Aarón.
* **Edad**: 43 años.
* **Estatura**: 1,83 m.
* **Peso**: 93 kg.
* **Equipamiento Disponible**: Mancuernas de 5 kg y cintas/bandas elásticas de resistencia.
* **Fuentes de Datos Reales**: Garmin Connect (`garminconnect` directo) y Strava.

---

## 🛡️ 3. Directrices Deportivas y Fisiológicas Obligatorias

1. **Toma de Decisiones Basada en Historial Real (Garmin & Strava)**:
   * Antes de prescribir la sesión del día, el motor y el Coach IA deben analizar los últimos entrenamientos reales registrados en Garmin Connect (tipo de sesión, duración, FC media/máx, ritmos, carga aeróbica y días de descanso).
   * Integrar métricas diarias de Garmin (*Body Battery, HRV, sueño, FC en reposo y Training Readiness*) para modular automáticamente la intensidad.

2. **Planificación de Fuerza (Sistema Strava Strength)**:
   * Sesiones Full Body o divididas según fatiga previa, de 40-55 minutos de duración.
   * Adaptadas al equipamiento real (**mancuernas de 5 kg y cintas elásticas**): énfasis en tiempo bajo tensión (tempo controlado), rango de 15 a 22 repeticiones, superseries y control estricto de descansos.
   * Ejecución mediante el **Logger de Series Strava**: registro real de peso (kg) y reps por serie, volumen total acumulado ($\text{kg} \times \text{reps}$), descansos ajustables (`±15s`) y mapa anatómico de activación muscular.

3. **Planificación de Carrera (Sistema Runna Running)**:
   * Prescripción inteligente basada en el historial reciente de ritmos y FC en Garmin.
   * **Prevención de Lesiones (93 kg / 43 años)**: Máximo 1-2 sesiones de calidad/intervalos a la semana; el resto rodajes aeróbicos controlados en Zona 2 para proteger articulaciones y construir base aeróbica.
   * Ejecución guiada estilo **Runna**: timeline de fases, medidor de zonas de ritmo objetivo, avatar dinámico de cadencia y audio-coach por voz.

4. **Yoga y Movilidad Regenerativa**:
   * Sesiones de 20-25 minutos cuando se detecta fatiga acumulada o esfuerzo previo *"Agotador"*, usando posturas de `alexcumplido/yoga-api`.

5. **Estado Fisiológico / Readiness Score (Dashboard)**:
   * Calcular dinámicamente el "Estado Óptimo" (20% a 100%) combinando adherencia semanal, recuperación/descanso, variedad de estímulos y telemetría de Garmin Connect.
