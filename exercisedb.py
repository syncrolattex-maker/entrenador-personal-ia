import os
import re
import httpx
from typing import List, Dict, Any, Optional

# RapidAPI configuration
RAPIDAPI_KEY = os.getenv("RAPIDAPI_KEY", "")
RAPIDAPI_HOST = os.getenv("RAPIDAPI_HOST", "exercisedb.p.rapidapi.com")

# Local cache for API queries
_exercise_cache: Dict[str, Dict[str, Any]] = {}

# Rich Fallback Catalog in Spanish tailored to Verónica's equipment
FALLBACK_EXERCISES: List[Dict[str, Any]] = [
    {
        "id": "biceps_curl_dumbbell",
        "name": "Curl de Bíceps con Pesas de 5kg",
        "keywords": ["biceps", "curl", "pesas", "mancuernas", "brazos"],
        "equipment": "Pesas de 5kg",
        "equipment_code": "dumbbell",
        "target_muscle": "Bíceps braquial",
        "secondary_muscles": ["Antebrazo", "Braquial anterior"],
        "gif_url": "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Dumbbell_Bicep_Curl/0.jpg",
        "svg_icon": "biceps",
        "instructions": [
            "De pie, sostén una pesa de 5kg en cada mano con las palmas mirando hacia adelante.",
            "Mantén los codos pegados al torso sin balancear la espalda.",
            "Flexiona los codos levantando suavemente las pesas hacia los hombros.",
            "Contrae el bíceps en el punto máximo 1 segundo y baja de forma controlada en 2 segundos."
        ],
        "tips": "Evita mover los hombros o tomar impulso con la zona lumbar."
    },
    {
        "id": "shoulder_press_dumbbell",
        "name": "Press de Hombros con Pesas de 5kg",
        "keywords": ["press", "hombros", "hombro", "deltoides", "pesas"],
        "equipment": "Pesas de 5kg",
        "equipment_code": "dumbbell",
        "target_muscle": "Deltoides (Hombros)",
        "secondary_muscles": ["Tríceps", "Trapecio"],
        "gif_url": "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Dumbbell_Shoulder_Press/0.jpg",
        "svg_icon": "shoulders",
        "instructions": [
            "De pie o sentada con la espalda recta, eleva las pesas a la altura de las orejas con codos a 90°.",
            "Empuja las pesas hacia arriba sobre la cabeza sin llegar a bloquear los codos bruscamente.",
            "Desciende despacio hasta volver a la altura de las orejas."
        ],
        "tips": "Mantén el abdomen contraído para proteger la espalda baja."
    },
    {
        "id": "lateral_raises_dumbbell",
        "name": "Elevaciones Laterales de Hombro",
        "keywords": ["elevaciones", "laterales", "hombro", "deltoides"],
        "equipment": "Pesas de 5kg",
        "equipment_code": "dumbbell",
        "target_muscle": "Deltoides lateral",
        "secondary_muscles": ["Trapecio superior"],
        "gif_url": "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Seated_Side_Lateral_Raise/0.jpg",
        "svg_icon": "shoulders",
        "instructions": [
            "De pie, sujetando las pesas a los costados con ligera flexión de codos.",
            "Eleva los brazos hacia los lados hasta alinearlos con los hombros.",
            "Desciende con control resistiendo la gravedad."
        ],
        "tips": "Si los 5kg pesan demasiado para este ejercicio, realiza el movimiento con mayor control o menos rango de movimiento."
    },
    {
        "id": "goblet_squat_dumbbell",
        "name": "Sentadilla Goblet con Pesa de 5kg",
        "keywords": ["sentadilla", "squat", "goblet", "piernas", "cuadriceps", "gluteos"],
        "equipment": "Pesas de 5kg",
        "equipment_code": "dumbbell",
        "target_muscle": "Cuádriceps y Glúteos",
        "secondary_muscles": ["Isquiotibiales", "Core"],
        "gif_url": "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Goblet_Squat/0.jpg",
        "svg_icon": "legs",
        "instructions": [
            "Sostén una pesa de 5kg verticalmente frente al pecho pegada al cuerpo.",
            "Coloca los pies a la anchura de los hombros con las puntas ligeramente hacia afuera.",
            "Baja la cadera hacia atrás y abajo como si te sentaras en una silla, manteniendo el pecho erguido.",
            "Empuja con los talones para volver a la posición inicial."
        ],
        "tips": "Asegúrate de que las rodillas sigan la dirección de las puntas de los pies."
    },
    {
        "id": "dumbbell_row",
        "name": "Remo Unilateral con Pesa de 5kg",
        "keywords": ["remo", "espalda", "dorsal", "row"],
        "equipment": "Pesas de 5kg",
        "equipment_code": "dumbbell",
        "target_muscle": "Dorsal Ancho (Espalda)",
        "secondary_muscles": ["Bíceps", "Deltoides posterior"],
        "gif_url": "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Bent_Over_Two-Dumbbell_Row/0.jpg",
        "svg_icon": "back",
        "instructions": [
            "Apoya una mano y rodilla sobre una silla o banco firme, inclinando el torso paralelo al suelo.",
            "Con la otra mano, sostiene la pesa de 5kg apuntando hacia el suelo.",
            "Lleva el codo hacia atrás y arriba, acercando la pesa hacia la cadera.",
            "Baja suavemente manteniendo la espalda recta."
        ],
        "tips": "Tira desde el codo, no desde la mano, para activar correctamente la espalda."
    },
    {
        "id": "triceps_overhead_extension",
        "name": "Extensión de Tríceps Copita sobre Cabeza",
        "keywords": ["triceps", "copita", "extension", "brazos"],
        "equipment": "Pesas de 5kg",
        "equipment_code": "dumbbell",
        "target_muscle": "Tríceps braquial",
        "secondary_muscles": ["Core"],
        "gif_url": "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Standing_Dumbbell_Triceps_Extension/0.jpg",
        "svg_icon": "triceps",
        "instructions": [
            "Sostén una pesa de 5kg con ambas manos por detrás de la cabeza, codos apunto hacia arriba.",
            "Extiende los codos llevando la pesa hacia el techo sin mover los brazos de sitio.",
            "Flexiona despacio para volver a la posición detrás de la nuca."
        ],
        "tips": "Procura que los codos no se abran demasiado hacia los lados."
    },
    {
        "id": "band_row",
        "name": "Remo con Cinta Elástica de Resistencia",
        "keywords": ["remo", "cinta", "banda", "espalda", "band"],
        "equipment": "Cintas Elásticas",
        "equipment_code": "band",
        "target_muscle": "Espalda Alta y Dorsales",
        "secondary_muscles": ["Bíceps", "Romboide"],
        "gif_url": "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Band_Pull_Apart/0.jpg",
        "svg_icon": "back",
        "instructions": [
            "Sentada con las piernas extendidas, engancha la cinta elástica en la planta de los pies.",
            "Toma los extremos con ambas manos y mantén la espalda bien erguida.",
            "Jala de la cinta llevando los codos hacia atrás y juntando las escápulas.",
            "Regresa despacio resistiendo la tensión de la banda."
        ],
        "tips": "Mantén los hombros lejos de las orejas durante todo el recorrido."
    },
    {
        "id": "band_glute_walk",
        "name": "Pasos Laterales de Glúteo con Cinta",
        "keywords": ["gluteo", "cinta", "banda", "pasos", "cadera", "glutes"],
        "equipment": "Cintas Elásticas",
        "equipment_code": "band",
        "target_muscle": "Glúteo Medio y Cadera",
        "secondary_muscles": ["Cuádriceps"],
        "gif_url": "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Dumbbell_Lunges/0.jpg",
        "svg_icon": "legs",
        "instructions": [
            "Coloca la cinta elástica redonda justo por encima de las rodillas o en los tobillos.",
            "Adopta una media sentadilla con los pies al ancho de caderas.",
            "Da pasos laterales de forma fluida sin juntar del todo los pies para mantener tensión constante.",
            "Realiza pasos hacia la derecha y luego hacia la izquierda."
        ],
        "tips": "No dejes que las rodillas se colapsen hacia adentro al dar el paso."
    },
    {
        "id": "band_chest_fly",
        "name": "Aperturas Pectorales con Cinta",
        "keywords": ["pecho", "pectoral", "cinta", "banda", "aperturas"],
        "equipment": "Cintas Elásticas",
        "equipment_code": "band",
        "target_muscle": "Pectoral Mayor",
        "secondary_muscles": ["Deltoides anterior"],
        "gif_url": "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Band_Pull_Apart/0.jpg",
        "svg_icon": "chest",
        "instructions": [
            "Pasa la cinta por detrás de tu espalda sujetando los extremos con los brazos extendidos a los lados.",
            "Junta las manos al frente a la altura del pecho manteniendo una ligera flexión en los codos.",
            "Abre despacio sintiendo el estiramiento en el pecho."
        ],
        "tips": "Mantén la tensión en la banda durante todo el movimiento."
    },
    {
        "id": "pushups",
        "name": "Flexiones de Pecho (Push-Ups / Con Rodillas)",
        "keywords": ["flexiones", "pushup", "push-up", "pecho", "peso corporal"],
        "equipment": "Peso Corporal",
        "equipment_code": "body weight",
        "target_muscle": "Pectoral y Tríceps",
        "secondary_muscles": ["Core", "Deltoides anterior"],
        "gif_url": "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Pushups/0.jpg",
        "svg_icon": "chest",
        "instructions": [
            "Coloca las manos en el suelo ligeramente más anchas que los hombros (puedes apoyar rodillas).",
            "Mantén una línea recta desde la cabeza hasta las rodillas/talones contrayendo el abdomen.",
            "Baja el pecho hacia el suelo doblando los codos a 45°.",
            "Empuja firmemente el suelo para retornar arriba."
        ],
        "tips": "Evita que la cadera se caiga o que la zona lumbar se arquee."
    },
    {
        "id": "glute_bridge",
        "name": "Puente de Glúteos (Glute Bridge)",
        "keywords": ["puente", "gluteo", "bridge", "cadera", "peso corporal"],
        "equipment": "Peso Corporal",
        "equipment_code": "body weight",
        "target_muscle": "Glúteos y Zona Lumbar",
        "secondary_muscles": ["Isquiotibiales", "Core"],
        "gif_url": "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Barbell_Glute_Bridge/0.jpg",
        "svg_icon": "legs",
        "instructions": [
            "Tumbada boca arriba con rodillas flexionadas y pies bien apoyados en el suelo.",
            "Empuja con los talones alzando la cadera hasta alinear rodillas, cadera y hombros.",
            "Apreta los glúteos fuerte durante 1 segundo en la cima.",
            "Baja despacio rozando el suelo antes de repetir."
        ],
        "tips": "Puedes colocar una pesa de 5kg sobre la pelvis para añadir intensidad."
    },
    {
        "id": "plank",
        "name": "Plancha Abdominal Isométrica",
        "keywords": ["plancha", "plank", "core", "abdomen", "abdominales"],
        "equipment": "Peso Corporal",
        "equipment_code": "body weight",
        "target_muscle": "Core (Recto y Transverso abdominal)",
        "secondary_muscles": ["Hombros", "Glúteos"],
        "gif_url": "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Plank/0.jpg",
        "svg_icon": "core",
        "instructions": [
            "Apoya los antebrazos en el suelo alineando los codos con los hombros.",
            "Extiende las piernas hacia atrás apoyando las puntas de los pies.",
            "Mantén el cuerpo plano como una tabla, apretando fuerte abdomen y glúteos.",
            "Sostén la posición respirando suavemente de forma fluida."
        ],
        "tips": "No dejes caer la cadera ni te alces haciendo pirámide."
    },
    {
        "id": "mountain_climbers",
        "name": "Escaladores (Mountain Climbers)",
        "keywords": ["escaladores", "climbers", "cardio", "core", "abdomen"],
        "equipment": "Peso Corporal",
        "equipment_code": "body weight",
        "target_muscle": "Core y Cardio",
        "secondary_muscles": ["Hombros", "Cuádriceps"],
        "gif_url": "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Mountain_Climbers/0.jpg",
        "svg_icon": "core",
        "instructions": [
            "Empieza en posición de plancha alta sobre las palmas de las manos.",
            "Lleva una rodilla velozmente hacia el pecho sin tocar el suelo.",
            "Alterna dinámicamente de pierna como si estuvieras corriendo en el sitio."
        ],
        "tips": "Mantén los hombros justo encima de las muñecas."
    }
]


def find_fallback_exercise(query: str) -> Dict[str, Any]:
    """Find the best matching fallback exercise by name, target muscle, or keywords."""
    query_clean = query.lower().strip()
    
    # 1. Exact or partial match on name
    for ex in FALLBACK_EXERCISES:
        if query_clean in ex["name"].lower():
            return ex
            
    # 2. Match keywords
    for ex in FALLBACK_EXERCISES:
        for kw in ex["keywords"]:
            if kw in query_clean:
                return ex
                
    # 3. Match equipment / target muscle fallback
    if "pesa" in query_clean or "mancuerna" in query_clean:
        return FALLBACK_EXERCISES[0]  # Curl bíceps
    elif "cinta" in query_clean or "banda" in query_clean:
        return FALLBACK_EXERCISES[6]  # Remo cinta
    elif "sentadilla" in query_clean or "pierna" in query_clean or "gluteo" in query_clean:
        return FALLBACK_EXERCISES[3]  # Sentadilla
    elif "plancha" in query_clean or "core" in query_clean or "abs" in query_clean:
        return FALLBACK_EXERCISES[11] # Plancha
        
    # Default fallback
    return FALLBACK_EXERCISES[0]


async def fetch_exercise_from_rapidapi(name: str) -> Optional[Dict[str, Any]]:
    """Query RapidAPI ExerciseDB if key is available."""
    if not RAPIDAPI_KEY:
        return None
        
    cache_key = name.lower().strip()
    if cache_key in _exercise_cache:
        return _exercise_cache[cache_key]
        
    url = f"https://{RAPIDAPI_HOST}/exercises/name/{name.lower()}"
    headers = {
        "x-rapidapi-key": RAPIDAPI_KEY,
        "x-rapidapi-host": RAPIDAPI_HOST
    }
    
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            resp = await client.get(url, headers=headers)
            if resp.status_code == 200:
                data = resp.json()
                if isinstance(data, list) and len(data) > 0:
                    item = data[0]
                    res = {
                        "id": str(item.get("id", "")),
                        "name": item.get("name", "").title(),
                        "equipment": item.get("equipment", "Desconocido").capitalize(),
                        "target_muscle": item.get("target", "General").capitalize(),
                        "secondary_muscles": [m.capitalize() for m in item.get("secondaryMuscles", [])],
                        "gif_url": item.get("gifUrl", ""),
                        "instructions": item.get("instructions", []),
                        "tips": "Realizar con técnica limpia y controlada."
                    }
                    _exercise_cache[cache_key] = res
                    return res
    except Exception as err:
        print(f"ExerciseDB API request error for '{name}':", err)
        
    return None


async def get_enriched_exercise_details(exercise_name: str) -> Dict[str, Any]:
    """Retrieves exercise info combining RapidAPI with high-performance local fallback."""
    # 1. Try RapidAPI if key is present
    api_res = await fetch_exercise_from_rapidapi(exercise_name)
    if api_res:
        return api_res
        
    # 2. Return enriched local fallback matching the exercise name
    fb = find_fallback_exercise(exercise_name)
    return {
        "id": fb["id"],
        "name": fb["name"],
        "equipment": fb["equipment"],
        "target_muscle": fb["target_muscle"],
        "secondary_muscles": fb["secondary_muscles"],
        "gif_url": fb["gif_url"],
        "svg_icon": fb.get("svg_icon", "dumbbell"),
        "instructions": fb["instructions"],
        "tips": fb["tips"]
    }


def get_all_fallback_exercises() -> List[Dict[str, Any]]:
    """Return all available fallback exercises for catalog display."""
    return FALLBACK_EXERCISES
