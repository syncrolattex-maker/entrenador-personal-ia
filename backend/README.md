# README del Backend de Verofit

Este directorio centraliza la documentación y módulos del servidor backend de **Verofit** (FastAPI, integraciones de telemetría y agentes).

---

## 📂 Módulos Principales (en la raíz operativa del proyecto)

* main.py: Servidor FastAPI principal, endpoints stateless (/estado-db, /generar-entrenamiento, /recomendacion-hoy, /sincronizar-carrera), cálculo dinámico WKO5 y telemetría de Intervals.icu.
* exercisedb.py: Integración con ExerciseDB (RapidAPI AscendAPI) para vídeos, animaciones y músculos trabajados.
* musclewiki.py: Integración y catálogo alternativo de biomecánica muscular.
* pi/index.py: Adaptador Serverless para despliegue en Vercel.

---

## 🚀 Ejecución Local

`ash
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
`
