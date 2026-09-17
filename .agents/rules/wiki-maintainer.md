# Regla: Wiki Maintainer (LLM Wiki Viva de Verofit)

Esta regla define los estándares de integridad, límites y formato para el mantenimiento de la **LLM Wiki viva** de Verónica en Verofit.

---

## 🎯 Propósito
Garantizar que toda la información fisiológica, respuestas de estrés, pautas de nutrición y adaptaciones de entrenamiento de Verónica se mantengan documentadas de forma veraz, incremental, estructurada e hipervinculada.

---

## 📋 Principios del Maintainer

1. **Fuente de Verdad Dual**:
   - aw/: Entradas inmutables (telemetría Apple Watch, Intervals.icu, logs de sesión JSON, notas directas).
   - wiki/: Conocimiento destilado y sintetizado por el modelo. Nunca inventar datos que contradigan los logs de aw/.

2. **Inmutabilidad de Registros**:
   - wiki/log.md es un registro cronológico en modo *append-only*. Cada modificación relevante, ingesta o reajuste fisiológico debe añadirse con marca de tiempo ISO (YYYY-MM-DD).

3. **Mantenimiento del Catálogo (wiki/index.md)**:
   - Cada nuevo documento dentro de wiki/ debe estar catalogado y resumido en wiki/index.md.
   - Mantener enlaces relativos en formato markdown estándar ([Título](./seccion/archivo.md)).

4. **Estructura Modular del Conocimiento**:
   - wiki/profile/: Fisiología, ciclos de asimilación, perfiles cardíacos y respuestas al estrés.
   - wiki/training/: Biblioteca de ejercicios adaptados (5 kg / bandas / peso corporal) y adaptaciones de rescate (Día Gris).
   - wiki/nutrition/: Pautas nutricionales hipocalóricas, bajas en carne y orientadas a la recuperación proteica vegetal y asimilación.

5. **Límites de Seguridad y Consistencia Fisiológica**:
   - Verónica: 43 años, 1.77 m y 59 kg.
   - Nunca sugerir cargas superiores a su equipamiento (mancuernas de 5 kg y bandas de resistencia).
   - Respetar la política de carrera de máximo 2 sesiones de calidad por semana y forzar rodaje suave Zona 2 si TSB < -15 o FC > 170 ppm.
