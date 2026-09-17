---
description: Ingesta un log o feedback de entrenamiento y propaga los aprendizajes a la wiki.
---
1. Lee el feedback o archivo indicado por el usuario (en `/raw/sessions/`).
2. Lee `/wiki/index.md` para identificar qué páginas conceptuales pueden estar afectadas.
3. Lee las páginas relevantes (por ejemplo, `adaptaciones_rescate.md` si hubo baja energía, o `biblioteca_ejercicios.md` si hubo molestias).
4. Aplica las ediciones necesarias en dichas páginas Markdown reflejando el nuevo aprendizaje.
5. Actualiza `/wiki/index.md` si se crearon conceptos nuevos.
6. Añade la entrada correspondiente en `/wiki/log.md`.
7. Presenta un breve resumen (walkthrough) de las páginas actualizadas.
