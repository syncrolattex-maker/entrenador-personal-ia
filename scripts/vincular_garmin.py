#!/usr/bin/env python3
"""
Vincula tu cuenta de Garmin Connect desde tu Mac (IP residencial) y envía el token OAuth
a tu servidor AaronFit en Vercel para activar la programación automática en el calendario.
"""
import getpass
import sys
import requests
import garth

APP_URL = "https://entrenador-personal-ia-six.vercel.app"


def main():
    print("=== Vincular Garmin Connect -> AaronFit ===")
    email = input("Email de Garmin Connect: ").strip()
    password = getpass.getpass("Contraseña de Garmin Connect: ")
    if not email or not password:
        print("Error: introduce email y contraseña.")
        sys.exit(1)

    print("\nConectando con Garmin SSO desde tu Mac...")
    try:
        garth.login(email, password, prompt_mfa=lambda: input("Código 2FA / MFA de Garmin: ").strip())
    except Exception as e:
        print(f"Error en login Garmin: {e}")
        sys.exit(1)

    token_dump = garth.client.dumps()
    print("Token OAuth obtenido. Subiendo a AaronFit...")

    r = requests.post(
        f"{APP_URL}/api/garmin/import-tokens",
        json={"tokens": token_dump},
        timeout=20,
    )
    if r.status_code != 200 or r.json().get("status") != "connected":
        print(f"Error al guardar token en AaronFit: {r.status_code} {r.text}")
        sys.exit(1)

    print("Token guardado en PostgreSQL. Programando semana actual en Garmin Connect...")
    s = requests.post(f"{APP_URL}/api/training/sync-garmin-calendar", timeout=30)
    try:
        print("Resultado:", s.json().get("message", s.text))
    except Exception:
        print("Respuesta:", s.text)


if __name__ == "__main__":
    main()
