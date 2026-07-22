# Verofit — Reglas y Visión del Proyecto (Estilo Garmin Connect)

Este archivo define las reglas de comportamiento, la visión del producto y las especificaciones atléticas exclusivas de **Verofit** para guiar futuras actualizaciones.

---

## 🎯 1. Visión del Producto

**Verofit** pretende ser una versión ultra-personalizada y exclusiva de **Garmin Connect** diseñada a medida de una única atleta. Combina diagnóstico fisiológico avanzado, planificación de volumen semanal inteligente, reproducción de entrenamientos asistidos y sincronización con Apple Watch.

---

## 👩‍🔬 2. Perfil de la Atleta

* **Nombre**: Verónica.
* **Edad**: 43 años.
* **Estatura**: 1,77 m.
* **Peso**: 59 kg.
* **Perfil Antropométrico**: Extremidades largas, excelente palanca, cuerpo atlético y tonificado.
* **Ubicación**: Alcàsser (Valencia) — Entrena en llanos agrícolas y pistas de tierra de la huerta.
* **Equipamiento Disponible**: Mancuernas de 5 kg y bandas/cintas elásticas de resistencia.

---

## 🛡️ 3. Directrices Deportivas y Fisiológicas Obligatorias

1. **Planificación de Fuerza (Cuerpo Completo - Full Body)**:
   * Las sesiones deben ser intensas, de 45-60 minutos de duración.
   * Deben combinar empujes, tracciones y tren inferior, con un rango de 15 a 22 repeticiones (dado el límite de 5 kg del equipamiento).
   * Se debe garantizar la **diversificación de rutinas** entre sesiones consecutivas para evitar monotonía.

2. **Planificación de Carrera (Variada y Controlada)**:
   * **Prevención de Lesiones**: Se permite **máximo una (1) sesión de calidad a la semana** (Fartlek, Series o Intervalos rápidos).
   * **Rodajes de Zona 2**: Las demás sesiones de carrera semanales deben ser obligatoriamente de rodaje aeróbico suave continuo (35-45 minutos) a ritmo conversacional.
   * **Adaptación Automática**: Si Verónica reporta cansancio *"Agotador"* o fatiga, las sesiones de calidad se reconvierten automáticamente en rodajes de recuperación suave.
   * **Variedad Estructurada**: Los entrenamientos deben ser variados e incluir Fartleks en pirámide, rodamientos progresivos, progresiones rápidas finales e intervalos de VO2 máx.

3. **Yoga y Flexibilidad**:
   * Sesiones guiadas de 20-30 minutos que utilicen únicamente posturas presentes en la base de datos `alexcumplido/yoga-api` para garantizar que sus dibujos vectoriales (SVG) carguen correctamente.
   * Mostrar los dibujos sobre un lienzo claro de alto contraste para que los trazos negros del SVG sean perfectamente legibles en el tema oscuro.

4. **Estado Fisiológico / Readiness Score (Dashboard)**:
   * Calcular dinámicamente el "Estado Óptimo" (de 20% a 100%) basándose en:
     * **Adherencia Semanal (40%)**: Ratio de sesiones completadas frente al objetivo de 4 sesiones semanales.
     * **Recuperación y Fatiga (40%)**: Ventana de días de reposo (1 día es óptimo) ajustado por fatiga subjetiva previa.
     * **Variedad de Estímulo (20%)**: Alternancia correcta de disciplinas (Fuerza, Carrera, Yoga).

5. **Sincronización Tecnológica**:
   * Sincronizar entrenamientos estructurados con Intervals.icu ➔ Watchletic en el Apple Watch.
