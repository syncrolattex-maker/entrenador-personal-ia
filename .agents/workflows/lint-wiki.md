---
name: lint-wiki
description: Valida la consistencia, enlaces rotos, formato y reglas deportivas de la LLM Wiki viva de Verofit
---

# Workflow: /lint-wiki

Este workflow audita la integridad estructural y fisiológica de toda la carpeta wiki/.

---

## Pasos de Ejecución

1. **Auditoría de Enlaces e Índice**:
   - Verificar que todos los archivos en wiki/profile/, wiki/training/, wiki/nutrition/ y wiki/log.md estén enlazados en wiki/index.md.
   - Comprobar que no existen enlaces rotos relativos.

2. **Consistencia de Límites Atléticos**:
   - Confirmar que ningún documento mencione pesos superiores a 5 kg o equipamiento no disponible.
   - Validar que las pautas de carrera no excedan 2 sesiones de calidad semanales.
   - Confirmar que el umbral de fatiga crítica esté documentado en 170 ppm y TSB < -15.

3. **Inmutabilidad de Registros**:
   - Asegurar que las fechas en wiki/log.md sigan orden cronológico y formato ISO (YYYY-MM-DD).

4. **Reporte de Diagnóstico**:
   - Emitir un resumen indicando estado: OK o lista de discrepancias corregidas.
