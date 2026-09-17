---
name: query-wiki
description: Consulta de alta fidelidad sobre el historial fisiológico, adaptaciones y pautas de Verónica en la LLM Wiki viva
---

# Workflow: /query-wiki

Este workflow permite consultar de manera sintetizada y contextualizada el conocimiento de la atleta almacenado en wiki/.

---

## Pasos de Ejecución

1. **Analizar la Consulta**:
   - Clasificar si la pregunta concierne a:
     - Estado de fatiga o ciclo fisiológico (wiki/profile/).
     - Prescripción y volumen de fuerza/carrera/yoga (wiki/training/).
     - Estrategia de combustible y recuperación hipocalórica (wiki/nutrition/).
     - Histórico de adaptaciones pasadas (wiki/log.md).

2. **Lectura Focalizada**:
   - Consultar wiki/index.md para navegar al archivo más pertinente.
   - Extraer datos cuantitativos y directrices cualitativas sin alucinaciones.

3. **Formulación de Respuesta para el Entrenador**:
   - Presentar la conclusión fisiológica directa.
   - Citar el archivo de la wiki de donde proviene la regla o evidencia.
   - Proponer la acción de prescripción inmediata recomendada.
