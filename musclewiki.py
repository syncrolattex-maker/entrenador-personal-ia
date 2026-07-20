import os
import httpx
from typing import List, Dict, Any, Optional

MUSCLEWIKI_API_KEY = os.getenv("MUSCLEWIKI_API_KEY", "")
MUSCLEWIKI_BASE_URL = "https://api.musclewiki.com"

# Local cache for MuscleWiki queries
_mw_cache: Dict[str, Any] = {}

# MuscleWiki Categories mapping for Verónica
MUSCLEWIKI_CATEGORIES = [
    {"id": "deltoids", "name": "Hombros", "icon": "🏋️‍♀️"},
    {"id": "biceps", "name": "Bíceps", "icon": "💪"},
    {"id": "triceps", "name": "Tríceps", "icon": "⚡"},
    {"id": "glutes", "name": "Glúteos", "icon": "🍑"},
    {"id": "quadriceps", "name": "Cuádriceps", "icon": "🦵"},
    {"id": "chest", "name": "Pectoral", "icon": "🛡️"},
    {"id": "lats", "name": "Espalda", "icon": "🦅"},
    {"id": "abs", "name": "Core", "icon": "🔥"}
]

# Rich MuscleWiki-Formatted Catalog tailored to Verónica's equipment
MUSCLEWIKI_EXERCISES: List[Dict[str, Any]] = [
    {
        "id": "mw_biceps_curl",
        "name": "Curl de Bíceps Alterno con Pesas de 5kg",
        "name_en": "Dumbbell Bicep Curl",
        "category": "biceps",
        "category_name": "Bíceps",
        "equipment": "Pesas de 5kg",
        "equipment_code": "dumbbell",
        "video_url": "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Dumbbell_Bicep_Curl/0.jpg",
        "gif_url": "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Dumbbell_Bicep_Curl/0.jpg",
        "instructions": [
            "De pie con torso neutro, sujeta una mancuerna de 5kg en cada mano.",
            "Mantén los codos pegados a los costados y gira la palma hacia arriba al subir.",
            "Flexiona el codo contrayendo el bíceps en el punto más alto.",
            "Desciende de forma suave en 3 segundos resistiendo el peso."
        ],
        "tips": "No balancees el torso ni eches los codos hacia atrás al iniciar la elevación."
    },
    {
        "id": "mw_shoulder_press",
        "name": "Press Militar de Hombros con Pesas de 5kg",
        "name_en": "Dumbbell Shoulder Press",
        "category": "deltoids",
        "category_name": "Hombros (Deltoides)",
        "equipment": "Pesas de 5kg",
        "equipment_code": "dumbbell",
        "video_url": "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Dumbbell_Shoulder_Press/0.jpg",
        "gif_url": "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Dumbbell_Shoulder_Press/0.jpg",
        "instructions": [
            "Sentada o de pie con abdomen apretado, coloca las pesas a la altura de las orejas.",
            "Empuja ambas pesas hacia arriba en vertical sin arquear la espalda.",
            "Desciende con control hasta volver a los 90° en los codos."
        ],
        "tips": "Mantén la mirada al frente y no juntes fuertemente las pesas arriba."
    },
    {
        "id": "mw_side_lateral_raise",
        "name": "Elevaciones Laterales de Deltoides",
        "name_en": "Side Lateral Raise",
        "category": "deltoids",
        "category_name": "Hombros (Deltoides)",
        "equipment": "Pesas de 5kg",
        "equipment_code": "dumbbell",
        "video_url": "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Seated_Side_Lateral_Raise/0.jpg",
        "gif_url": "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Seated_Side_Lateral_Raise/0.jpg",
        "instructions": [
            "Sujeta las pesas a los lados del cuerpo con rodillas ligeramente flexionadas.",
            "Eleva los brazos hacia los costados manteniendo una sutil flexión en los codos.",
            "Detente justo al llegar a la altura de los hombros y baja controlado."
        ],
        "tips": "Piensa en empujar las pesas hacia los lados exteriores, no solo hacia arriba."
    },
    {
        "id": "mw_goblet_squat",
        "name": "Sentadilla Goblet con Pesa de 5kg",
        "name_en": "Goblet Squat",
        "category": "quadriceps",
        "category_name": "Cuádriceps y Glúteos",
        "equipment": "Pesas de 5kg",
        "equipment_code": "dumbbell",
        "video_url": "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Goblet_Squat/0.jpg",
        "gif_url": "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Goblet_Squat/0.jpg",
        "instructions": [
            "Abraza una mancuerna de 5kg junto al esternón con los codos apuntando hacia abajo.",
            "Pies abiertos al ancho de hombros. Desciende la cadera como si te sentaras.",
            "Mantén la espalda erguida y empuja el suelo con los talones para subir."
        ],
        "tips": "Que tus rodillas no sobrepasen excesivamente la punta de los pies ni se metan hacia adentro."
    },
    {
        "id": "mw_dumbbell_row",
        "name": "Remo Unilateral de Espalda con 5kg",
        "name_en": "Dumbbell Row",
        "category": "lats",
        "category_name": "Espalda (Dorsales)",
        "equipment": "Pesas de 5kg",
        "equipment_code": "dumbbell",
        "video_url": "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Bent_Over_Two-Dumbbell_Row/0.jpg",
        "gif_url": "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Bent_Over_Two-Dumbbell_Row/0.jpg",
        "instructions": [
            "Inclinada sobre un punto de apoyo, sostiene la mancuerna apuntando al suelo.",
            "Dirige el codo hacia la cadera apretando las escápulas atrás.",
            "Regresa despacio sintiendo el estiramiento en la espalda."
        ],
        "tips": "Evita rotar excesivamente el torso durante el tirón."
    },
    {
        "id": "mw_triceps_extension",
        "name": "Copita de Tríceps sobre Cabeza con 5kg",
        "name_en": "Triceps Overhead Extension",
        "category": "triceps",
        "category_name": "Tríceps",
        "equipment": "Pesas de 5kg",
        "equipment_code": "dumbbell",
        "video_url": "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Standing_Dumbbell_Triceps_Extension/0.jpg",
        "gif_url": "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Standing_Dumbbell_Triceps_Extension/0.jpg",
        "instructions": [
            "Sujeta la pesa con ambas manos por detrás de la cabeza con codos mirando hacia arriba.",
            "Extiende los antebrazos hacia el techo apretando los tríceps en la cima.",
            "Flexiona con cuidado de vuelta detrás de la nuca."
        ],
        "tips": "Mantén los codos lo más cerrados posibles durante el movimiento."
    },
    {
        "id": "mw_glute_bridge",
        "name": "Puente de Glúteos Hip Thrust",
        "name_en": "Glute Bridge",
        "category": "glutes",
        "category_name": "Glúteos",
        "equipment": "Peso Corporal / Pesa 5kg",
        "equipment_code": "bodyweight",
        "video_url": "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Barbell_Glute_Bridge/0.jpg",
        "gif_url": "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Barbell_Glute_Bridge/0.jpg",
        "instructions": [
            "Boca arriba con rodillas dobladas y pies planos sobre la colchoneta.",
            "Eleva la pelvis contrayendo fuertemente los glúteos arriba durante 2 segundos.",
            "Baja rozando el suelo y repite el empuje."
        ],
        "tips": "Coloca la pesa de 5kg en la cadera para maximizar el estímulo hipertrófico."
    },
    {
        "id": "mw_pushups",
        "name": "Flexiones Pectorales en Suelo",
        "name_en": "Pushups",
        "category": "chest",
        "category_name": "Pectoral (Pecho)",
        "equipment": "Peso Corporal",
        "equipment_code": "bodyweight",
        "video_url": "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Pushups/0.jpg",
        "gif_url": "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Pushups/0.jpg",
        "instructions": [
            "Manos separadas más anchas que los hombros. (Apoya rodillas si es necesario).",
            "Flexiona codos a 45° bajando el pecho de forma alineada.",
            "Empuja fuerte contra el suelo activando pectoral y tríceps."
        ],
        "tips": "No dejes caer la zona lumbar ni arquees la cabeza."
    },
    {
        "id": "mw_plank",
        "name": "Plancha Abdominal de Core MuscleWiki",
        "name_en": "Plank",
        "category": "abs",
        "category_name": "Core (Abdomen)",
        "equipment": "Peso Corporal",
        "equipment_code": "bodyweight",
        "video_url": "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Plank/0.jpg",
        "gif_url": "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Plank/0.jpg",
        "instructions": [
            "Apoyo sobre antebrazos y puntas de pie formando un bloque recto.",
            "Mantén tensión isométrica apretando fuertemente el transverso abdominal.",
            "Respira de forma constante sin perder la neutralidad pélvica."
        ],
        "tips": "Aprieta también los glúteos para mayor estabilidad lumbar."
    },
    {
        "id": "mw_mountain_climber",
        "name": "Escaladores Dinámicos de Core",
        "name_en": "Mountain Climbers",
        "category": "abs",
        "category_name": "Core (Abdomen)",
        "equipment": "Peso Corporal",
        "equipment_code": "bodyweight",
        "video_url": "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Mountain_Climbers/0.jpg",
        "gif_url": "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Mountain_Climbers/0.jpg",
        "instructions": [
            "En plancha alta sobre palmas de mano, lleva alternativamente rodillas al pecho.",
            "Mantén la cadera baja y el ritmo fluido."
        ],
        "tips": "Mantén las manos firmemente plantadas debajo de los hombros."
    }
]


async def fetch_official_musclewiki(muscle: str = None) -> List[Dict[str, Any]]:
    """Query official MuscleWiki API if key is set."""
    if not MUSCLEWIKI_API_KEY:
        return []
        
    url = f"{MUSCLEWIKI_BASE_URL}/exercises"
    headers = {"X-API-Key": MUSCLEWIKI_API_KEY}
    params = {}
    if muscle:
        params["muscle"] = muscle
        
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            resp = await client.get(url, headers=headers, params=params)
            if resp.status_code == 200:
                data = resp.json()
                if isinstance(data, list):
                    return data
    except Exception as e:
        print("[MuscleWiki API] Exception:", e)
        
    return []


def get_musclewiki_exercises_by_category(category_id: str) -> List[Dict[str, Any]]:
    """Filter MuscleWiki catalog by muscle category ID (or return all if 'all')."""
    if not category_id or category_id == "all":
        return MUSCLEWIKI_EXERCISES
        
    cid = category_id.lower().strip()
    return [ex for ex in MUSCLEWIKI_EXERCISES if ex.get("category", "").lower() == cid]


def get_musclewiki_exercise_details(name_or_keyword: str) -> Dict[str, Any]:
    """Find matching MuscleWiki exercise by keyword."""
    clean = name_or_keyword.lower().strip()
    for ex in MUSCLEWIKI_EXERCISES:
        if clean in ex["name"].lower() or clean in ex["name_en"].lower():
            return ex
            
    # Category matches
    if "hombro" in clean or "press" in clean or "deltoid" in clean:
        return MUSCLEWIKI_EXERCISES[1]
    elif "biceps" in clean or "curl" in clean:
        return MUSCLEWIKI_EXERCISES[0]
    elif "gluteo" in clean or "sentadilla" in clean or "squat" in clean:
        return MUSCLEWIKI_EXERCISES[3]
    elif "pecho" in clean or "pushup" in clean:
        return MUSCLEWIKI_EXERCISES[7]
        
    return MUSCLEWIKI_EXERCISES[0]
